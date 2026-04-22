require('dotenv').config();
const express = require('express');
const compression = require('compression');
const sql = require('mssql');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === VALIDAR ENV VARS ===
const requiredEnvVars = ['AZURE_SQL_SERVER', 'AZURE_SQL_DATABASE', 'AZURE_SQL_USER', 'AZURE_SQL_PASSWORD',
  'SECULLUM_AUTH_URL', 'SECULLUM_API_URL', 'SECULLUM_USER', 'SECULLUM_PASS', 'SECULLUM_BANCOS',
  'JWT_SECRET', 'LOGIN_USER', 'LOGIN_PASS'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`[ERRO] Variáveis de ambiente faltando: ${missing.join(', ')}`);
  process.exit(1);
}

// === CONFIGS ===
const JWT_SECRET = process.env.JWT_SECRET;
const LOGIN_USER = process.env.LOGIN_USER;
const LOGIN_PASS = process.env.LOGIN_PASS;

const sqlConfig = {
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  port: parseInt(process.env.AZURE_SQL_PORT || '1433'),
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

const SECULLUM_AUTH_URL = process.env.SECULLUM_AUTH_URL;
const SECULLUM_API_URL = process.env.SECULLUM_API_URL;
const SECULLUM_USER = process.env.SECULLUM_USER;
const SECULLUM_PASS = process.env.SECULLUM_PASS;
const BANCOS_ATIVOS = (process.env.SECULLUM_BANCOS || '').split(',').map(Number).filter(Boolean);

const NOMES_MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
const MESES_INDEX = {};
NOMES_MESES.forEach((m, i) => { MESES_INDEX[m] = i; });

// === MIDDLEWARE ===
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Headers de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Rate limiting por IP (100 req/min)
const rateLimitMap = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, start: now }); return next(); }
  const entry = rateLimitMap.get(ip);
  if (now - entry.start > 60000) { entry.count = 1; entry.start = now; return next(); }
  if (++entry.count > 100) return res.status(429).json({ error: 'Muitas requisições' });
  next();
});
setInterval(() => { const now = Date.now(); for (const [ip, e] of rateLimitMap) { if (now - e.start > 60000) rateLimitMap.delete(ip); } }, 300000);

// ============================================================
// === AUTENTICAÇÃO (LOGIN + JWT) ===
// ============================================================

// Brute-force protection (5 tentativas por IP, bloqueio 15min)
const loginAttempts = new Map();
function checkBruteForce(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (Date.now() - entry.first > 15 * 60 * 1000) { loginAttempts.delete(ip); return true; }
  return entry.count < 5;
}
function recordFailedLogin(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) { loginAttempts.set(ip, { count: 1, first: Date.now() }); return; }
  entry.count++;
}
function clearLoginAttempts(ip) { loginAttempts.delete(ip); }

// Login endpoint
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!checkBruteForce(ip)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
  }

  const { usuario, senha } = req.body;
  if (!usuario || !senha) return res.status(400).json({ error: 'Usuário e senha obrigatórios' });

  // Comparação segura contra timing attacks
  const userMatch = crypto.timingSafeEqual(
    Buffer.from(String(usuario).toUpperCase().padEnd(64)),
    Buffer.from(LOGIN_USER.toUpperCase().padEnd(64))
  );
  const passMatch = crypto.timingSafeEqual(
    Buffer.from(String(senha).padEnd(64)),
    Buffer.from(LOGIN_PASS.padEnd(64))
  );

  if (!userMatch || !passMatch) {
    recordFailedLogin(ip);
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }

  clearLoginAttempts(ip);
  const token = jwt.sign({ user: LOGIN_USER }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/check-auth', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch {
    res.json({ authenticated: false });
  }
});

// Rotas públicas (antes do authMiddleware)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), warmup: warmupDone,
    cache: { colaboradores: !!cache.colaboradores, imoveis: !!cacheImoveis.dados, refeicao: !!cacheRefeicao.dados, diasTrab: !!cacheDiasTrab.dados }
  });
});

app.get('/api/cache-status', (req, res) => {
  res.json({
    ready: warmupDone,
    progress: warmupProgress,
    cache: { imoveis: !!cacheImoveis.dados, refeicao: !!cacheRefeicao.dados, colaboradores: !!cache.colaboradores, diasTrab: !!cacheDiasTrab.dados }
  });
});

// Auth middleware - protege todas as rotas /api/ exceto login/logout/check-auth
function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    return res.status(401).json({ error: 'Sessão expirada' });
  }
}
app.use('/api/', authMiddleware);

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));

// ============================================================
// === POOL SQL COMPARTILHADO ===
// ============================================================
let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(sqlConfig).catch(err => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

// ============================================================
// === CACHE SYSTEM ===
// ============================================================
let cache = { colaboradores: null, lastUpdate: null, updating: false };
let cacheImoveis = { dados: null, lastUpdate: null };
let cacheRefeicao = { dados: null, lastUpdate: null };
let cacheDiasTrab = { dados: null, lastUpdate: null };
let cacheAlojados = { dados: null, lastUpdate: null };
const CACHE_TTL = 10 * 60 * 1000;
const CACHE_SQL_TTL = 15 * 60 * 1000;
const CACHE_DIAS_TTL = 30 * 60 * 1000;

let warmupDone = false;
let warmupProgress = { status: 'starting', step: '', pct: 0 };

// ============================================================
// === SECULLUM HELPERS ===
// ============================================================
let secullumToken = null;
let tokenExpiry = 0;
let tokenPromise = null; // Serializar auth - evitar chamadas simultâneas

async function getSecullumToken() {
  if (secullumToken && Date.now() < tokenExpiry) return secullumToken;
  // Se já tem uma autenticação em andamento, esperar ela
  if (tokenPromise) return tokenPromise;
  tokenPromise = _fetchSecullumToken();
  try { return await tokenPromise; } finally { tokenPromise = null; }
}

async function _fetchSecullumToken() {
  // Retry com backoff (3 tentativas)
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await fetch(SECULLUM_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=password&username=${encodeURIComponent(SECULLUM_USER)}&password=${encodeURIComponent(SECULLUM_PASS)}&client_id=3`,
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        if (tentativa < 3) {
          console.warn(`[Secullum] Auth tentativa ${tentativa} falhou (${res.status}), retry em ${tentativa * 2}s...`);
          await new Promise(r => setTimeout(r, tentativa * 2000));
          continue;
        }
        throw new Error(`Secullum auth failed: ${res.status}`);
      }
      const data = await res.json();
      secullumToken = data.access_token;
      tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      return secullumToken;
    } catch (err) {
      if (tentativa >= 3) throw err;
      console.warn(`[Secullum] Auth tentativa ${tentativa} erro: ${err.message}, retry em ${tentativa * 2}s...`);
      await new Promise(r => setTimeout(r, tentativa * 2000));
    }
  }
}

async function secullumGet(endpoint, bancoId) {
  // Retry para requests GET também (2 tentativas)
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const token = await getSecullumToken();
      const res = await fetch(`${SECULLUM_API_URL}${endpoint}`, {
        headers: { Authorization: `Bearer ${token}`, secullumidbancoselecionado: String(bancoId) },
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) {
        if (res.status === 401 && tentativa < 2) {
          // Token expirou, forçar renovação
          secullumToken = null; tokenExpiry = 0;
          continue;
        }
        console.warn(`[Secullum] Erro ${res.status} em ${endpoint} banco ${bancoId}`);
        return [];
      }
      return await res.json();
    } catch (err) {
      if (tentativa < 2) {
        console.warn(`[Secullum] Retry ${endpoint} banco ${bancoId}: ${err.message}`);
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      console.warn(`[Secullum] Falha ${endpoint} banco ${bancoId}: ${err.message}`);
      return [];
    }
  }
  return [];
}

// ============================================================
// === HELPERS ===
// ============================================================
function gerarMeses(inicio, fim) {
  const meses = [];
  let atual = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
  const limite = new Date(fim.getFullYear(), fim.getMonth(), 1);
  while (atual <= limite) {
    meses.push(`${NOMES_MESES[atual.getMonth()]}/${String(atual.getFullYear()).slice(-2)}`);
    atual.setMonth(atual.getMonth() + 1);
  }
  return meses;
}

function mesAnoToDate(mesAno) {
  const [mes, ano] = mesAno.split('/');
  return new Date(2000 + parseInt(ano), MESES_INDEX[mes], 1);
}

function normCpf(cpf) { return (cpf || '').replace(/[\.\-\/\s]/g, ''); }

function normMesLabel(mes) { return (mes || '').replace(/\bMARCO\b/g, 'MARÇO'); }

function normProjeto(proj) {
  if (!proj) return null;
  const s = String(proj).trim();
  if (!s || s === 'ABANDONO') return null;
  const match = s.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function getDepartamentoDesc(dept) {
  if (!dept) return null;
  if (typeof dept === 'string') return dept;
  if (typeof dept === 'object' && dept.Descricao) return dept.Descricao;
  return null;
}

// ============================================================
// === DATA LOADING ===
// ============================================================

async function carregarColaboradoresHistorico() {
  console.log('[Colaboradores] Carregando do histórico SQL...');
  const t = Date.now();
  const pool = await getPool();

  // azurePorCpf ainda é necessário como fallback para dias trabalhados
  const azureResult = await pool.request().query('SELECT CPF, PROJETO, PROJETO_RH, COORDENADOR, DATA_ADMISSAO FROM COLABORADORES');
  const azurePorCpf = {};
  for (const c of azureResult.recordset) {
    const cpf = normCpf(c.CPF);
    if (cpf) azurePorCpf[cpf] = c;
  }

  // Média diária de CPFs únicos por projeto/mês
  const histResult = await pool.request().query(`
    WITH daily_counts AS (
      SELECT
        COALESCE(NULLIF(PROJETO_RH, ''), PROJETO) AS PROJETO,
        MAX(COORDENADOR) AS COORDENADOR,
        ATUALIZADO_EM,
        COUNT(DISTINCT CPF) AS qtd_dia
      FROM COLABORADORES_HISTORICO
      WHERE (PROJETO_RH IS NOT NULL OR PROJETO IS NOT NULL)
      GROUP BY COALESCE(NULLIF(PROJETO_RH, ''), PROJETO), ATUALIZADO_EM
    )
    SELECT
      PROJETO,
      MAX(COORDENADOR) AS COORDENADOR,
      YEAR(ATUALIZADO_EM) AS ano,
      MONTH(ATUALIZADO_EM) AS mes_num,
      ROUND(AVG(CAST(qtd_dia AS float)), 0) AS QUANTIDADE
    FROM daily_counts
    WHERE PROJETO IS NOT NULL AND PROJETO != '' AND PROJETO != 'ABANDONO'
    GROUP BY PROJETO, YEAR(ATUALIZADO_EM), MONTH(ATUALIZADO_EM)
    ORDER BY ano, mes_num, PROJETO
  `);

  const dados = histResult.recordset.map(r => {
    const proj = normProjeto(r.PROJETO);
    if (!proj) return null;
    const mesLabel = `${NOMES_MESES[r.mes_num - 1]}/${String(r.ano).slice(-2)}`;
    return { DATA: mesLabel, PROJETO: proj, QUANTIDADE: Math.round(r.QUANTIDADE), COORDENADOR: r.COORDENADOR || null };
  }).filter(Boolean);

  console.log(`[Colaboradores] ${dados.length} registros em ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return { dados, azurePorCpf };
}

// Dias trabalhados - com paralelismo por banco
const TIPOS_EXCLUIDOS_BATIDA = new Set(['FERIAS', 'L.MATER', 'L.PATER', 'A. INSS', 'FOLGABH']);

function gerarMesesProcessar() {
  const meses = [];
  const agora = new Date();
  let atual = new Date(2025, 7, 1);
  while (atual <= agora) {
    const y = atual.getFullYear(), m = atual.getMonth();
    const last = new Date(y, m + 1, 0).getDate();
    meses.push({ label: `${NOMES_MESES[m]}/${String(y).slice(-2)}`, inicio: `${y}-${String(m+1).padStart(2,'0')}-01`, fim: `${y}-${String(m+1).padStart(2,'0')}-${last}` });
    atual.setMonth(m + 1);
  }
  return meses;
}

async function processarBancoDiasTrab(bancoId, mesesProcessar, azurePorCpf) {
  const resultado = {};
  let funcionarios;
  try { funcionarios = await secullumGet('/Funcionarios', bancoId); } catch (e) { return resultado; }
  if (!funcionarios || funcionarios.length === 0) return resultado;

  const funcMap = {};
  for (const f of funcionarios) {
    // Prioridade: departamento Secullum, fallback: Azure PROJETO_RH (via CPF)
    let p = normProjeto(getDepartamentoDesc(f.Departamento));
    if (!p && azurePorCpf) {
      const cpf = normCpf(f.Cpf);
      const az = cpf ? azurePorCpf[cpf] : null;
      if (az) p = normProjeto(az.PROJETO_RH);
    }
    if (p) funcMap[f.Id] = p;
  }

  // Buscar batidas de todos os meses em paralelo (2 por vez para não sobrecarregar)
  for (let i = 0; i < mesesProcessar.length; i += 2) {
    const batch = mesesProcessar.slice(i, i + 2);
    const results = await Promise.all(batch.map(mes =>
      secullumGet(`/Batidas?dataInicio=${mes.inicio}&dataFim=${mes.fim}`, bancoId)
        .catch(e => { console.warn(`[DiasTrab] Erro ${mes.label} banco ${bancoId}`); return []; })
    ));
    batch.forEach((mes, j) => {
      for (const b of results[j]) {
        const proj = funcMap[b.FuncionarioId];
        if (!proj) continue;
        const e1 = (b.Entrada1 || '').trim();
        if (!e1 || TIPOS_EXCLUIDOS_BATIDA.has(e1)) continue;
        const key = `${proj}|${mes.label}`;
        if (!resultado[key]) resultado[key] = { projeto: proj, mes: mes.label, diasReais: 0, funcsSet: new Set() };
        resultado[key].diasReais++;
        resultado[key].funcsSet.add(b.FuncionarioId);
      }
    });
    if (i + 2 < mesesProcessar.length) await new Promise(r => setTimeout(r, 200));
  }
  return resultado;
}

async function calcularDiasTrabalhados(azurePorCpf) {
  console.log('[DiasTrab] Calculando (sequencial por banco)...');
  const t = Date.now();
  const mesesProcessar = gerarMesesProcessar();

  // Garantir token antes
  await getSecullumToken();

  // Bancos SEQUENCIAL (evitar 500 na API Secullum)
  const bancosResults = [];
  for (const id of BANCOS_ATIVOS) {
    const r = await processarBancoDiasTrab(id, mesesProcessar, azurePorCpf);
    bancosResults.push(r);
    await new Promise(r => setTimeout(r, 300));
  }

  // Merge resultados
  const merged = {};
  for (const r of bancosResults) {
    for (const [key, val] of Object.entries(r)) {
      if (!merged[key]) { merged[key] = { ...val, funcsSet: new Set(val.funcsSet) }; }
      else { merged[key].diasReais += val.diasReais; val.funcsSet.forEach(id => merged[key].funcsSet.add(id)); }
    }
  }

  const dados = Object.values(merged).map(d => ({
    PROJETO: d.projeto, MES: d.mes, DIAS_REAIS: d.diasReais,
    FUNCIONARIOS: d.funcsSet.size,
    MEDIA_DIAS_FUNC: d.funcsSet.size > 0 ? Math.round((d.diasReais / d.funcsSet.size) * 10) / 10 : 0
  })).sort((a, b) => a.MES.localeCompare(b.MES) || a.PROJETO - b.PROJETO);

  console.log(`[DiasTrab] ${dados.length} registros em ${((Date.now() - t) / 1000).toFixed(1)}s`);
  return dados;
}

// ============================================================
// === PRE-WARM: carregar TUDO ao iniciar ===
// ============================================================
async function preWarm() {
  console.log('[PreWarm] Iniciando pré-carregamento de todos os dados...');
  const t = Date.now();

  try {
    // Fase 1: SQL (rápido, ~2s)
    warmupProgress = { status: 'loading', step: 'Conectando ao banco de dados...', pct: 5 };
    const pool = await getPool();

    warmupProgress = { status: 'loading', step: 'Carregando imóveis e refeições...', pct: 10 };
    const [imoveisResult, refeicaoResult, alojadosResult] = await Promise.all([
      pool.request().query(`SELECT ID, REPLACE(MES, 'MARCO', N'MARÇO') as MES, MES_ANO, PROJETO, COORDENADOR, IMOVEL, ENDERECO, TIPO_IMOVEL, DESTINACAO, ALUGUEL, ENERGIA, AGUA, INTERNET, IPTU, MANUTENCAO, ALOJADOS, CAPACIDADE_ALOJADOS FROM CUSTOS_IMOVEIS ORDER BY MES_ANO, PROJETO, ENDERECO`),
      pool.request().query(`SELECT PROJETO, COORDENADOR, CIDADE, FORNECEDOR, TIPO_REFEICAO, VALOR_UNITARIO, QUANTIDADE, VALOR_TOTAL, REPLACE(MES_NOME, 'MARCO', N'MARÇO') as MES_NOME, QUINZENA, NUMERO_QUINZENA, CLIENTE FROM PAG_REFEICAO ORDER BY MES_REF, PROJETO, FORNECEDOR, TIPO_REFEICAO`),
      pool.request().query(`SELECT PROJETO_RH as PROJETO, COUNT(*) as ALOJADOS_APROX FROM COLABORADORES WHERE SITUACAO = '1' AND FUNCAO_EXECUTANTE IN ('TRABALHADOR','OPERADOR','MOTORISTA','MECANICO','LIDER') GROUP BY PROJETO_RH ORDER BY PROJETO_RH`)
    ]);

    cacheImoveis.dados = imoveisResult.recordset.map(r => {
      const anoCurto = r.MES_ANO ? r.MES_ANO.split('/')[1].slice(-2) : '';
      return { PROJETO: r.PROJETO, COORDENADOR: r.COORDENADOR, IMOVEL: r.IMOVEL, ENDERECO: r.ENDERECO, TIPO_IMOVEL: r.TIPO_IMOVEL || null, DESTINACAO: r.DESTINACAO, MES: normMesLabel(`${r.MES}/${anoCurto}`), MES_ANO: r.MES_ANO, ALUGUEL: Number(r.ALUGUEL)||0, ENERGIA: Number(r.ENERGIA)||0, AGUA: Number(r.AGUA)||0, INTERNET: Number(r.INTERNET)||0, IPTU: Number(r.IPTU)||0, MANUTENCAO: Number(r.MANUTENCAO)||0, ALOJADOS: r.ALOJADOS||0, CAPACIDADE_ALOJADOS: r.CAPACIDADE_ALOJADOS||0 };
    });
    cacheImoveis.lastUpdate = Date.now();

    cacheRefeicao.dados = refeicaoResult.recordset.map(r => ({
      PROJETO: r.PROJETO, COORDENADOR: r.COORDENADOR, CIDADE: r.CIDADE, FORNECEDOR: r.FORNECEDOR, TIPO_REFEICAO: r.TIPO_REFEICAO, VALOR_UNITARIO: Number(r.VALOR_UNITARIO)||0, QUANTIDADE: r.QUANTIDADE, VALOR: Number(r.VALOR_TOTAL)||0, MES: normMesLabel(r.MES_NOME), QUINZENA: r.QUINZENA, CLIENTE: r.CLIENTE
    }));
    cacheRefeicao.lastUpdate = Date.now();

    cacheAlojados.dados = {};
    for (const r of alojadosResult.recordset) { const p = Number(r.PROJETO); if (p) cacheAlojados.dados[p] = r.ALOJADOS_APROX; }
    cacheAlojados.lastUpdate = Date.now();

    console.log(`[PreWarm] SQL OK: ${cacheImoveis.dados.length} imóveis, ${cacheRefeicao.dados.length} refeições`);

    // Fase 2: Colaboradores do histórico SQL (~1-2s)
    warmupProgress = { status: 'loading', step: 'Carregando colaboradores (histórico)...', pct: 30 };
    cache.colaboradores = await carregarColaboradoresHistorico();
    cache.lastUpdate = Date.now();

    // Fase 3: Dias trabalhados (paralelo, ~30-60s)
    warmupProgress = { status: 'loading', step: 'Calculando dias trabalhados...', pct: 60 };
    cacheDiasTrab.dados = await calcularDiasTrabalhados(cache.colaboradores.azurePorCpf);
    cacheDiasTrab.lastUpdate = Date.now();

    warmupDone = true;
    warmupProgress = { status: 'ready', step: 'Pronto!', pct: 100 };
    console.log(`[PreWarm] COMPLETO em ${((Date.now() - t) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error('[PreWarm] Erro:', err.message);
    warmupDone = true; // permitir acesso mesmo com erro
    warmupProgress = { status: 'ready', step: 'Pronto (com erros)', pct: 100 };
  }
}

// ============================================================
// === ENDPOINTS ===
// ============================================================

app.get('/api/colaboradores', async (req, res) => {
  try {
    if (!cache.colaboradores || !cache.lastUpdate || (Date.now() - cache.lastUpdate >= CACHE_TTL)) {
      if (cache.updating) {
        if (cache.colaboradores) return res.json({ dados: cache.colaboradores.dados });
        return res.status(503).json({ error: 'Dados sendo atualizados' });
      }
      cache.updating = true;
      try { cache.colaboradores = await carregarColaboradoresHistorico(); cache.lastUpdate = Date.now(); } finally { cache.updating = false; }
    }
    res.json({ dados: cache.colaboradores.dados });
  } catch (err) {
    cache.updating = false;
    console.error('[Colaboradores] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/imoveis', async (req, res) => {
  try {
    if (cacheImoveis.dados && cacheImoveis.lastUpdate && (Date.now() - cacheImoveis.lastUpdate < CACHE_SQL_TTL)) return res.json(cacheImoveis.dados);
    const pool = await getPool();
    const result = await pool.request().query(`SELECT ID, REPLACE(MES, 'MARCO', N'MARÇO') as MES, MES_ANO, PROJETO, COORDENADOR, IMOVEL, ENDERECO, TIPO_IMOVEL, DESTINACAO, ALUGUEL, ENERGIA, AGUA, INTERNET, IPTU, MANUTENCAO, ALOJADOS, CAPACIDADE_ALOJADOS FROM CUSTOS_IMOVEIS ORDER BY MES_ANO, PROJETO, ENDERECO`);
    cacheImoveis.dados = result.recordset.map(r => { const a = r.MES_ANO ? r.MES_ANO.split('/')[1].slice(-2) : ''; return { PROJETO: r.PROJETO, COORDENADOR: r.COORDENADOR, IMOVEL: r.IMOVEL, ENDERECO: r.ENDERECO, TIPO_IMOVEL: r.TIPO_IMOVEL||null, DESTINACAO: r.DESTINACAO, MES: `${r.MES}/${a}`, MES_ANO: r.MES_ANO, ALUGUEL: Number(r.ALUGUEL)||0, ENERGIA: Number(r.ENERGIA)||0, AGUA: Number(r.AGUA)||0, INTERNET: Number(r.INTERNET)||0, IPTU: Number(r.IPTU)||0, MANUTENCAO: Number(r.MANUTENCAO)||0, ALOJADOS: r.ALOJADOS||0, CAPACIDADE_ALOJADOS: r.CAPACIDADE_ALOJADOS||0 }; });
    cacheImoveis.lastUpdate = Date.now();
    res.json(cacheImoveis.dados);
  } catch (err) { console.error('[Imóveis] Erro:', err.message); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/refeicao', async (req, res) => {
  try {
    if (cacheRefeicao.dados && cacheRefeicao.lastUpdate && (Date.now() - cacheRefeicao.lastUpdate < CACHE_SQL_TTL)) return res.json(cacheRefeicao.dados);
    const pool = await getPool();
    const result = await pool.request().query(`SELECT PROJETO, COORDENADOR, CIDADE, FORNECEDOR, TIPO_REFEICAO, VALOR_UNITARIO, QUANTIDADE, VALOR_TOTAL, REPLACE(MES_NOME, 'MARCO', N'MARÇO') as MES_NOME, QUINZENA, NUMERO_QUINZENA, CLIENTE FROM PAG_REFEICAO ORDER BY MES_REF, PROJETO, FORNECEDOR, TIPO_REFEICAO`);
    cacheRefeicao.dados = result.recordset.map(r => ({ PROJETO: r.PROJETO, COORDENADOR: r.COORDENADOR, CIDADE: r.CIDADE, FORNECEDOR: r.FORNECEDOR, TIPO_REFEICAO: r.TIPO_REFEICAO, VALOR_UNITARIO: Number(r.VALOR_UNITARIO)||0, QUANTIDADE: r.QUANTIDADE, VALOR: Number(r.VALOR_TOTAL)||0, MES: r.MES_NOME, QUINZENA: r.QUINZENA, CLIENTE: r.CLIENTE }));
    cacheRefeicao.lastUpdate = Date.now();
    res.json(cacheRefeicao.dados);
  } catch (err) { console.error('[Refeição] Erro:', err.message); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/dias-trabalhados', async (req, res) => {
  try {
    if (cacheDiasTrab.dados && cacheDiasTrab.lastUpdate && (Date.now() - cacheDiasTrab.lastUpdate < CACHE_DIAS_TTL)) return res.json(cacheDiasTrab.dados);
    // PreWarm ainda calculando — retorna vazio para não bloquear o browser
    if (!warmupDone) return res.json([]);
    const azPorCpf = cache.colaboradores ? cache.colaboradores.azurePorCpf : null;
    const dados = await calcularDiasTrabalhados(azPorCpf);
    cacheDiasTrab = { dados, lastUpdate: Date.now() };
    res.json(dados);
  } catch (err) { console.error('[DiasTrab] Erro:', err.message); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/alojados-aprox', async (req, res) => {
  try {
    if (cacheAlojados.dados && cacheAlojados.lastUpdate && (Date.now() - cacheAlojados.lastUpdate < CACHE_SQL_TTL)) return res.json(cacheAlojados.dados);
    const pool = await getPool();
    const result = await pool.request().query(`SELECT PROJETO_RH as PROJETO, COUNT(*) as ALOJADOS_APROX FROM COLABORADORES WHERE SITUACAO = '1' AND FUNCAO_EXECUTANTE IN ('TRABALHADOR','OPERADOR','MOTORISTA','MECANICO','LIDER') GROUP BY PROJETO_RH ORDER BY PROJETO_RH`);
    cacheAlojados.dados = {};
    for (const r of result.recordset) { const p = Number(r.PROJETO); if (p) cacheAlojados.dados[p] = r.ALOJADOS_APROX; }
    cacheAlojados.lastUpdate = Date.now();
    res.json(cacheAlojados.dados);
  } catch (err) { console.error('[Alojados] Erro:', err.message); res.status(500).json({ error: 'Erro interno' }); }
});

// Graceful shutdown
process.on('SIGTERM', async () => { console.log('[Server] SIGTERM'); try { await sql.close(); } catch {} process.exit(0); });

// === INICIAR ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Pre-warm em background após servidor iniciar
  preWarm();
});
