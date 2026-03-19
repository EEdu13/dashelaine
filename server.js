require('dotenv').config();
const express = require('express');
const compression = require('compression');
const sql = require('mssql');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// === SEGURANÇA & PERFORMANCE ===
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Headers de segurança
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Rate limiting simples por IP (100 req/min por IP)
const rateLimitMap = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxReqs = 100;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return next();
  }
  const entry = rateLimitMap.get(ip);
  if (now - entry.start > windowMs) {
    entry.count = 1;
    entry.start = now;
    return next();
  }
  entry.count++;
  if (entry.count > maxReqs) {
    return res.status(429).json({ error: 'Muitas requisições. Tente novamente em 1 minuto.' });
  }
  next();
});

// Limpar rate limit map a cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.start > 60000) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// Servir arquivos estáticos com cache
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true
}));

// === CONFIGS (via env vars) ===
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

// Validar variáveis obrigatórias
const requiredEnvVars = ['AZURE_SQL_SERVER', 'AZURE_SQL_DATABASE', 'AZURE_SQL_USER', 'AZURE_SQL_PASSWORD',
  'SECULLUM_AUTH_URL', 'SECULLUM_API_URL', 'SECULLUM_USER', 'SECULLUM_PASS', 'SECULLUM_BANCOS'];
const missing = requiredEnvVars.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.error(`[ERRO] Variáveis de ambiente faltando: ${missing.join(', ')}`);
  process.exit(1);
}

const NOMES_MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

const MESES_INDEX = {};
NOMES_MESES.forEach((m, i) => { MESES_INDEX[m] = i; });

function gerarMeses(inicio, fim) {
  const meses = [];
  let atual = new Date(inicio.getFullYear(), inicio.getMonth(), 1);
  const limite = new Date(fim.getFullYear(), fim.getMonth(), 1);
  while (atual <= limite) {
    const ano = String(atual.getFullYear()).slice(-2);
    meses.push(`${NOMES_MESES[atual.getMonth()]}/${ano}`);
    atual.setMonth(atual.getMonth() + 1);
  }
  return meses;
}

// === POOL SQL COMPARTILHADO ===
let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(sqlConfig).catch(err => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

// === CACHE ===
let cache = { colaboradores: null, lastUpdate: null, updating: false };
const CACHE_TTL = 10 * 60 * 1000;

// Cache para imóveis e refeição (dados mudam pouco)
let cacheImoveis = { dados: null, lastUpdate: null };
let cacheRefeicao = { dados: null, lastUpdate: null };
const CACHE_SQL_TTL = 15 * 60 * 1000;

// === SECULLUM HELPERS ===
let secullumToken = null;
let tokenExpiry = 0;

async function getSecullumToken() {
  if (secullumToken && Date.now() < tokenExpiry) return secullumToken;

  const res = await fetch(SECULLUM_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=password&username=${encodeURIComponent(SECULLUM_USER)}&password=${encodeURIComponent(SECULLUM_PASS)}&client_id=3`
  });
  if (!res.ok) throw new Error(`Secullum auth failed: ${res.status}`);
  const data = await res.json();
  secullumToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return secullumToken;
}

async function secullumGet(endpoint, bancoId) {
  const token = await getSecullumToken();
  const res = await fetch(`${SECULLUM_API_URL}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      secullumidbancoselecionado: String(bancoId)
    }
  });
  if (!res.ok) {
    console.warn(`[Secullum] Erro ${res.status} em ${endpoint} banco ${bancoId}`);
    return [];
  }
  return res.json();
}

// === LÓGICA DE COLABORADORES ===
function mesAnoToDate(mesAno) {
  const [mes, ano] = mesAno.split('/');
  return new Date(2000 + parseInt(ano), MESES_INDEX[mes], 1);
}

function normCpf(cpf) {
  return (cpf || '').replace(/[\.\-\/\s]/g, '');
}

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

async function carregarDadosBase() {
  console.log('[Colaboradores] Carregando dados base...');
  const startTime = Date.now();

  const pool = await getPool();
  const azureResult = await pool.request().query('SELECT * FROM COLABORADORES');
  const colaboradoresAzure = azureResult.recordset;
  console.log(`[Azure] ${colaboradoresAzure.length} registros`);

  const todosFuncionarios = [];
  for (const bancoId of BANCOS_ATIVOS) {
    const funcs = await secullumGet('/Funcionarios', bancoId);
    const ativos = funcs.filter(f => !f.Demissao).length;
    console.log(`[Secullum] Banco ${bancoId}: ${funcs.length} func (${ativos} ativos)`);
    funcs.forEach(f => { f._bancoId = bancoId; });
    todosFuncionarios.push(...funcs);
    await new Promise(r => setTimeout(r, 250));
  }

  const funcPorCpf = {};
  for (const f of todosFuncionarios) {
    const cpf = normCpf(f.Cpf);
    if (!cpf) continue;
    if (!funcPorCpf[cpf] || (funcPorCpf[cpf].Demissao && !f.Demissao)) {
      funcPorCpf[cpf] = f;
    }
  }
  const funcsUnicos = Object.values(funcPorCpf);
  console.log(`[Secullum] ${funcsUnicos.length} únicos após dedup`);

  const azurePorCpf = {};
  for (const c of colaboradoresAzure) {
    const cpf = normCpf(c.CPF);
    if (cpf) azurePorCpf[cpf] = c;
  }

  const projetoCoordenador = {};
  for (const c of colaboradoresAzure) {
    const coord = (c.COORDENADOR || '').trim();
    if (!coord) continue;
    const proj = normProjeto(c.PROJETO_RH);
    if (proj && !projetoCoordenador[proj]) projetoCoordenador[proj] = coord;
  }

  const azureSemSecullum = colaboradoresAzure.filter(c => {
    const cpf = normCpf(c.CPF);
    return cpf && !funcPorCpf[cpf];
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Colaboradores] Concluído em ${elapsed}s`);
  return { funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum };
}

function calcularColaboradoresPorMes(funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum, mesesList) {
  const dadosColaboradores = [];

  for (const mesAno of mesesList) {
    const dataMes = mesAnoToDate(mesAno);
    const primeiroDia = new Date(dataMes.getFullYear(), dataMes.getMonth(), 1);
    const ultimoDia = new Date(dataMes.getFullYear(), dataMes.getMonth() + 1, 0);
    const contagemProjeto = {};

    function incrementar(projeto, coordenador) {
      if (!contagemProjeto[projeto]) {
        contagemProjeto[projeto] = { quantidade: 0, coordenador: null };
      }
      contagemProjeto[projeto].quantidade++;
      if (coordenador && !contagemProjeto[projeto].coordenador) {
        contagemProjeto[projeto].coordenador = coordenador;
      }
    }

    for (const func of funcsUnicos) {
      const cpf = normCpf(func.Cpf);
      const admissao = func.Admissao ? new Date(func.Admissao) : null;
      const demissao = func.Demissao ? new Date(func.Demissao) : null;

      if (!admissao || admissao > ultimoDia) continue;
      if (demissao && demissao < primeiroDia) continue;

      let projeto = null;
      let coordenador = null;
      const azure = azurePorCpf[cpf];

      if (azure) {
        projeto = normProjeto(azure.PROJETO_RH);
        coordenador = (azure.COORDENADOR || '').trim() || null;
      }

      if (!projeto) {
        const deptDesc = getDepartamentoDesc(func.Departamento);
        projeto = normProjeto(deptDesc);
        if (projeto && !coordenador) coordenador = projetoCoordenador[projeto] || null;
      }

      if (!projeto) continue;
      incrementar(projeto, coordenador);
    }

    for (const azure of azureSemSecullum) {
      const admissao = azure.DATA_ADMISSAO ? new Date(azure.DATA_ADMISSAO) : null;
      if (!admissao || admissao > ultimoDia) continue;

      const projeto = normProjeto(azure.PROJETO_RH);
      if (!projeto) continue;

      const coordenador = (azure.COORDENADOR || '').trim() || null;
      incrementar(projeto, coordenador);
    }

    Object.entries(contagemProjeto)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .forEach(([projeto, info]) => {
        const projNum = Number(projeto);
        dadosColaboradores.push({
          DATA: mesAno,
          PROJETO: projNum,
          QUANTIDADE: info.quantidade,
          COORDENADOR: info.coordenador || projetoCoordenador[projNum] || null
        });
      });
  }

  return dadosColaboradores;
}

// === ENDPOINTS ===

app.get('/api/colaboradores', async (req, res) => {
  try {
    if (!cache.colaboradores || !cache.lastUpdate || (Date.now() - cache.lastUpdate >= CACHE_TTL)) {
      if (cache.updating) {
        if (cache.colaboradores) {
          const { funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum } = cache.colaboradores;
          const agora = new Date();
          const mesesList = gerarMeses(new Date(agora.getFullYear(), agora.getMonth() - 5, 1), agora);
          const dados = calcularColaboradoresPorMes(funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum, mesesList);
          return res.json({ meses: mesesList, dados });
        }
        return res.status(503).json({ error: 'Dados sendo atualizados, tente novamente em instantes' });
      }
      cache.updating = true;
      try {
        cache.colaboradores = await carregarDadosBase();
        cache.lastUpdate = Date.now();
      } finally {
        cache.updating = false;
      }
    }

    const { funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum } = cache.colaboradores;
    const agora = new Date();

    const inicio = req.query.inicio
      ? new Date(...req.query.inicio.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)))
      : new Date(agora.getFullYear(), agora.getMonth() - 5, 1);
    const fim = req.query.fim
      ? new Date(...req.query.fim.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v)))
      : new Date(agora.getFullYear(), agora.getMonth(), 1);

    const mesesList = gerarMeses(inicio, fim);
    const dados = calcularColaboradoresPorMes(funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum, mesesList);

    res.json({ meses: mesesList, dados });
  } catch (err) {
    cache.updating = false;
    console.error('[Colaboradores] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/imoveis', async (req, res) => {
  try {
    if (cacheImoveis.dados && cacheImoveis.lastUpdate && (Date.now() - cacheImoveis.lastUpdate < CACHE_SQL_TTL)) {
      return res.json(cacheImoveis.dados);
    }

    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT ID, MES, MES_ANO, PROJETO, COORDENADOR, IMOVEL, ENDERECO, TIPO_IMOVEL, DESTINACAO,
             ALUGUEL, ENERGIA, AGUA, INTERNET, IPTU, MANUTENCAO, ALOJADOS, CAPACIDADE_ALOJADOS
      FROM CUSTOS_IMOVEIS
      ORDER BY MES_ANO, PROJETO, ENDERECO
    `);
    const dados = result.recordset.map(r => {
      const anoCurto = r.MES_ANO ? r.MES_ANO.split('/')[1].slice(-2) : '';
      return {
        PROJETO: r.PROJETO,
        COORDENADOR: r.COORDENADOR,
        IMOVEL: r.IMOVEL,
        ENDERECO: r.ENDERECO,
        TIPO_IMOVEL: r.TIPO_IMOVEL || null,
        DESTINACAO: r.DESTINACAO,
        MES: `${r.MES}/${anoCurto}`,
        MES_ANO: r.MES_ANO,
        ALUGUEL: Number(r.ALUGUEL) || 0,
        ENERGIA: Number(r.ENERGIA) || 0,
        AGUA: Number(r.AGUA) || 0,
        INTERNET: Number(r.INTERNET) || 0,
        IPTU: Number(r.IPTU) || 0,
        MANUTENCAO: Number(r.MANUTENCAO) || 0,
        ALOJADOS: r.ALOJADOS || 0,
        CAPACIDADE_ALOJADOS: r.CAPACIDADE_ALOJADOS || 0
      };
    });
    cacheImoveis = { dados, lastUpdate: Date.now() };
    console.log(`[Imóveis] ${dados.length} registros`);
    res.json(dados);
  } catch (err) {
    console.error('[Imóveis] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/refeicao', async (req, res) => {
  try {
    if (cacheRefeicao.dados && cacheRefeicao.lastUpdate && (Date.now() - cacheRefeicao.lastUpdate < CACHE_SQL_TTL)) {
      return res.json(cacheRefeicao.dados);
    }

    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT PROJETO, COORDENADOR, CIDADE, FORNECEDOR,
             TIPO_REFEICAO, VALOR_UNITARIO, QUANTIDADE, VALOR_TOTAL,
             MES_NOME, QUINZENA, NUMERO_QUINZENA, CLIENTE
      FROM PAG_REFEICAO
      ORDER BY MES_REF, PROJETO, FORNECEDOR, TIPO_REFEICAO
    `);
    const dados = result.recordset.map(r => ({
      PROJETO: r.PROJETO,
      COORDENADOR: r.COORDENADOR,
      CIDADE: r.CIDADE,
      FORNECEDOR: r.FORNECEDOR,
      TIPO_REFEICAO: r.TIPO_REFEICAO,
      VALOR_UNITARIO: Number(r.VALOR_UNITARIO) || 0,
      QUANTIDADE: r.QUANTIDADE,
      VALOR: Number(r.VALOR_TOTAL) || 0,
      MES: r.MES_NOME,
      QUINZENA: r.QUINZENA,
      CLIENTE: r.CLIENTE
    }));
    cacheRefeicao = { dados, lastUpdate: Date.now() };
    console.log(`[Refeição] ${dados.length} registros`);
    res.json(dados);
  } catch (err) {
    console.error('[Refeição] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// === DIAS TRABALHADOS ===
const TIPOS_EXCLUIDOS_BATIDA = new Set(['FERIAS', 'L.MATER', 'L.PATER', 'A. INSS', 'FOLGABH']);

let cacheDiasTrab = { dados: null, lastUpdate: null };
const CACHE_DIAS_TTL = 30 * 60 * 1000;

function gerarMesesProcessar() {
  const meses = [];
  const agora = new Date();
  let atual = new Date(2025, 7, 1); // AGOSTO/2025
  while (atual <= agora) {
    const y = atual.getFullYear();
    const m = atual.getMonth();
    const lastDay = new Date(y, m + 1, 0).getDate();
    const ano2 = String(y).slice(-2);
    meses.push({
      label: `${NOMES_MESES[m]}/${ano2}`,
      inicio: `${y}-${String(m + 1).padStart(2, '0')}-01`,
      fim: `${y}-${String(m + 1).padStart(2, '0')}-${lastDay}`
    });
    atual.setMonth(m + 1);
  }
  return meses;
}

async function calcularDiasTrabalhados() {
  console.log('[DiasTrab] Calculando...');
  const startTime = Date.now();
  const mesesProcessar = gerarMesesProcessar();
  const resultado = {};

  for (const bancoId of BANCOS_ATIVOS) {
    let funcionarios;
    try {
      funcionarios = await secullumGet('/Funcionarios', bancoId);
    } catch (err) {
      console.warn(`[DiasTrab] Erro func banco ${bancoId}:`, err.message);
      continue;
    }
    if (!funcionarios || funcionarios.length === 0) continue;

    const funcMap = {};
    for (const f of funcionarios) {
      const projeto = normProjeto(getDepartamentoDesc(f.Departamento));
      if (projeto) funcMap[f.Id] = projeto;
    }

    await new Promise(r => setTimeout(r, 300));

    for (const mes of mesesProcessar) {
      let batidas;
      try {
        batidas = await secullumGet(`/Batidas?dataInicio=${mes.inicio}&dataFim=${mes.fim}`, bancoId);
      } catch (err) {
        console.warn(`[DiasTrab] Erro batidas ${mes.label} banco ${bancoId}:`, err.message);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      for (const b of batidas) {
        const projeto = funcMap[b.FuncionarioId];
        if (!projeto) continue;

        const entrada1 = (b.Entrada1 || '').trim();
        if (!entrada1 || TIPOS_EXCLUIDOS_BATIDA.has(entrada1)) continue;

        const key = `${projeto}|${mes.label}`;
        if (!resultado[key]) {
          resultado[key] = { projeto, mes: mes.label, diasReais: 0, funcsSet: new Set() };
        }
        resultado[key].diasReais++;
        resultado[key].funcsSet.add(b.FuncionarioId);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  const dados = Object.values(resultado).map(d => ({
    PROJETO: d.projeto,
    MES: d.mes,
    DIAS_REAIS: d.diasReais,
    FUNCIONARIOS: d.funcsSet.size,
    MEDIA_DIAS_FUNC: d.funcsSet.size > 0 ? Math.round((d.diasReais / d.funcsSet.size) * 10) / 10 : 0
  })).sort((a, b) => a.MES.localeCompare(b.MES) || a.PROJETO - b.PROJETO);

  console.log(`[DiasTrab] ${dados.length} registros em ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  return dados;
}

app.get('/api/dias-trabalhados', async (req, res) => {
  try {
    if (cacheDiasTrab.dados && cacheDiasTrab.lastUpdate && (Date.now() - cacheDiasTrab.lastUpdate < CACHE_DIAS_TTL)) {
      return res.json(cacheDiasTrab.dados);
    }
    const dados = await calcularDiasTrabalhados();
    cacheDiasTrab = { dados, lastUpdate: Date.now() };
    res.json(dados);
  } catch (err) {
    console.error('[DiasTrab] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/alojados-aprox', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT PROJETO_RH as PROJETO, COUNT(*) as ALOJADOS_APROX
      FROM COLABORADORES
      WHERE SITUACAO = '1'
        AND FUNCAO_EXECUTANTE IN ('TRABALHADOR','OPERADOR','MOTORISTA','MECANICO','LIDER')
      GROUP BY PROJETO_RH
      ORDER BY PROJETO_RH
    `);
    const dados = {};
    for (const r of result.recordset) {
      const proj = Number(r.PROJETO);
      if (proj) dados[proj] = r.ALOJADOS_APROX;
    }
    res.json(dados);
  } catch (err) {
    console.error('[AlojadosAprox] Erro:', err.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    cache: {
      colaboradores: !!cache.colaboradores,
      imoveis: !!cacheImoveis.dados,
      refeicao: !!cacheRefeicao.dados,
      diasTrab: !!cacheDiasTrab.dados
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM recebido, encerrando...');
  try { await sql.close(); } catch (e) { /* ignore */ }
  process.exit(0);
});

// === INICIAR ===
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
});
