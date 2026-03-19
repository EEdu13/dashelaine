const express = require('express');
const sql = require('mssql');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));

// === CONFIGS ===
const sqlConfig = {
  server: 'alrflorestal.database.windows.net',
  database: 'Tabela_teste',
  user: 'sqladmin',
  password: 'SenhaForte123!',
  port: 1433,
  options: { encrypt: true, trustServerCertificate: false },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

const SECULLUM_AUTH_URL = 'https://autenticador.secullum.com.br/Token';
const SECULLUM_API_URL = 'https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna';
const SECULLUM_USER = 'ferreira.eduardo@larsil.com.br';
const SECULLUM_PASS = 'larsil123@';
const BANCOS_ATIVOS = [73561, 78833, 80600, 83576];

const NOMES_MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
  'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

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

// === CACHE ===
let cache = {
  colaboradores: null,
  lastUpdate: null,
  updating: false
};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

// === SECULLUM HELPERS ===
let secullumToken = null;
let tokenExpiry = 0;

async function getSecullumToken() {
  if (secullumToken && Date.now() < tokenExpiry) return secullumToken;

  const res = await fetch(SECULLUM_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=password&username=${SECULLUM_USER}&password=${encodeURIComponent(SECULLUM_PASS)}&client_id=3`
  });
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
  const meses = {
    'JANEIRO': 0, 'FEVEREIRO': 1, 'MARÇO': 2, 'ABRIL': 3,
    'MAIO': 4, 'JUNHO': 5, 'JULHO': 6, 'AGOSTO': 7,
    'SETEMBRO': 8, 'OUTUBRO': 9, 'NOVEMBRO': 10, 'DEZEMBRO': 11
  };
  const [mes, ano] = mesAno.split('/');
  return new Date(2000 + parseInt(ano), meses[mes], 1);
}

function normCpf(cpf) {
  return (cpf || '').replace(/[\.\-\/\s]/g, '');
}

function normProjeto(proj) {
  if (!proj) return null;
  const s = String(proj).trim();
  if (!s || s === 'ABANDONO') return null;
  const match = s.match(/^(\d+)/);
  if (match) return Number(match[1]);
  return null;
}

// Extrair descrição do departamento (pode ser string ou objeto)
function getDepartamentoDesc(dept) {
  if (!dept) return null;
  if (typeof dept === 'string') return dept;
  if (typeof dept === 'object' && dept.Descricao) return dept.Descricao;
  return null;
}

async function carregarDadosBase() {
  console.log('[Colaboradores] Carregando dados base...');
  const startTime = Date.now();

  // 1. Azure
  const pool = await sql.connect(sqlConfig);
  const azureResult = await pool.request().query('SELECT * FROM COLABORADORES');
  const colaboradoresAzure = azureResult.recordset;
  console.log(`[Azure] ${colaboradoresAzure.length} registros na tabela COLABORADORES`);

  // 2. Secullum (todos os bancos)
  const todosFuncionarios = [];
  for (const bancoId of BANCOS_ATIVOS) {
    const funcs = await secullumGet('/Funcionarios', bancoId);
    const ativos = funcs.filter(f => !f.Demissao).length;
    const demitidos = funcs.length - ativos;
    console.log(`[Secullum] Banco ${bancoId}: ${funcs.length} funcionários (${ativos} ativos, ${demitidos} demitidos)`);
    funcs.forEach(f => { f._bancoId = bancoId; });
    todosFuncionarios.push(...funcs);
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(`[Secullum] Total bruto: ${todosFuncionarios.length} funcionários de ${BANCOS_ATIVOS.length} bancos`);

  // Manter TODOS os registros por CPF (mesmo CPF pode ter múltiplas passagens em projetos/bancos)
  // Agrupar por CPF para poder fazer dedup por mês depois
  const funcsPorCpf = {};
  todosFuncionarios.forEach(f => {
    const cpf = normCpf(f.Cpf);
    if (!cpf) return;
    if (!funcsPorCpf[cpf]) funcsPorCpf[cpf] = [];
    funcsPorCpf[cpf].push(f);
  });
  // funcsUnicos = todos os registros (para compatibilidade com azureSemSecullum)
  const funcsUnicos = todosFuncionarios.filter(f => normCpf(f.Cpf));
  console.log(`[Secullum] ${Object.keys(funcsPorCpf).length} CPFs únicos, ${funcsUnicos.length} registros totais`);

  // Indexar Azure por CPF
  const azurePorCpf = {};
  colaboradoresAzure.forEach(c => {
    const cpf = normCpf(c.CPF);
    if (cpf) azurePorCpf[cpf] = c;
  });

  // Mapeamento projeto → coordenador (SEMPRE usando PROJETO_RH)
  const projetoCoordenador = {};
  colaboradoresAzure.forEach(c => {
    const coord = (c.COORDENADOR || '').trim();
    if (!coord) return;
    const proj = normProjeto(c.PROJETO_RH);
    if (proj && !projetoCoordenador[proj]) {
      projetoCoordenador[proj] = coord;
    }
  });
  console.log(`[Mapeamento] Projeto→Coordenador:`, JSON.stringify(projetoCoordenador));

  // Identificar funcionários Azure SEM registro Secullum
  const azureSemSecullum = colaboradoresAzure.filter(c => {
    const cpf = normCpf(c.CPF);
    return cpf && !funcsPorCpf[cpf];
  });
  console.log(`[Azure] ${azureSemSecullum.length} funcionários SOMENTE no Azure (sem Secullum)`);

  // Diagnóstico: contar CPFs únicos sem projeto válido
  let semProjeto = 0;
  Object.entries(funcsPorCpf).forEach(([cpf, registros]) => {
    const azure = azurePorCpf[cpf];
    const temProjeto = registros.some(func => {
      const projAzure = azure ? normProjeto(azure.PROJETO_RH) : null;
      const projSec = normProjeto(getDepartamentoDesc(func.Departamento));
      return projAzure || projSec;
    });
    if (!temProjeto) semProjeto++;
  });
  console.log(`[Diagnóstico] ${semProjeto} CPFs sem projeto válido (serão ignorados)`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Colaboradores] Carregamento concluído em ${elapsed}s`);
  return { funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum };
}

function calcularColaboradoresPorMes(funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum, mesesList) {
  const dadosColaboradores = [];

  // Agrupar todos os registros Secullum por CPF (inclui ativos e demitidos)
  const todosRegistrosPorCpf = {};
  funcsUnicos.forEach(func => {
    const cpf = normCpf(func.Cpf);
    if (!cpf) return;
    if (!todosRegistrosPorCpf[cpf]) todosRegistrosPorCpf[cpf] = [];
    todosRegistrosPorCpf[cpf].push(func);
  });

  mesesList.forEach(mesAno => {
    const dataMes = mesAnoToDate(mesAno);
    const primeiroDia = new Date(dataMes.getFullYear(), dataMes.getMonth(), 1);
    const ultimoDia = new Date(dataMes.getFullYear(), dataMes.getMonth() + 1, 0);

    const contagemProjeto = {};
    const cpfContado = new Set(); // evitar contar mesmo CPF 2x no mesmo mês

    function incrementar(projeto, coordenador) {
      if (!contagemProjeto[projeto]) {
        contagemProjeto[projeto] = { quantidade: 0, coordenador: null };
      }
      contagemProjeto[projeto].quantidade++;
      if (coordenador && !contagemProjeto[projeto].coordenador) {
        contagemProjeto[projeto].coordenador = coordenador;
      }
    }

    // 1. Para cada CPF, verificar TODOS os registros Secullum
    // Usar o registro que estava ativo naquele mês específico
    Object.entries(todosRegistrosPorCpf).forEach(([cpf, registros]) => {
      // Filtrar registros ativos neste mês
      const ativosNoMes = registros.filter(func => {
        const admissao = func.Admissao ? new Date(func.Admissao) : null;
        const demissao = func.Demissao ? new Date(func.Demissao) : null;
        if (!admissao || admissao > ultimoDia) return false;
        if (demissao && demissao < primeiroDia) return false;
        return true;
      });

      if (ativosNoMes.length === 0) return;
      if (cpfContado.has(cpf)) return;
      cpfContado.add(cpf);

      // Escolher o melhor registro para este mês:
      // Prioridade 1: registro demitido NESTE mês (tem o projeto histórico correto)
      // Prioridade 2: registro ativo (sem demissão)
      // Prioridade 3: qualquer registro ativo no período
      let funcEscolhido = ativosNoMes.find(f => {
        if (!f.Demissao) return false;
        const dem = new Date(f.Demissao);
        return dem >= primeiroDia && dem <= ultimoDia;
      }) || ativosNoMes.find(f => !f.Demissao) || ativosNoMes[0];

      // Para projeto: usar departamento Secullum do registro escolhido (dado histórico)
      // Depois fallback para Azure PROJETO_RH (dado atual)
      let projeto = null;
      let coordenador = null;

      // Departamento Secullum = projeto real naquele período
      const deptDesc = getDepartamentoDesc(funcEscolhido.Departamento);
      const projSecullum = normProjeto(deptDesc);

      const azure = azurePorCpf[cpf];
      const projAzure = azure ? normProjeto(azure.PROJETO_RH) : null;

      // Para demitidos: sempre usar departamento Secullum (o Azure pode já ter sido atualizado)
      if (funcEscolhido.Demissao) {
        projeto = projSecullum || projAzure;
      } else {
        // Para ativos: usar Azure PROJETO_RH (mais confiável para projeto atual)
        projeto = projAzure || projSecullum;
      }

      if (azure) {
        coordenador = (azure.COORDENADOR || '').trim() || null;
      }
      if (!coordenador && projeto) {
        coordenador = projetoCoordenador[projeto] || null;
      }

      if (!projeto) return;
      incrementar(projeto, coordenador);
    });

    // 2. Funcionários SOMENTE no Azure (sem Secullum)
    azureSemSecullum.forEach(azure => {
      const cpf = normCpf(azure.CPF);
      if (cpfContado.has(cpf)) return;

      const admissao = azure.DATA_ADMISSAO ? new Date(azure.DATA_ADMISSAO) : null;
      if (!admissao || admissao > ultimoDia) return;

      const projeto = normProjeto(azure.PROJETO_RH);
      if (!projeto) return;

      cpfContado.add(cpf);
      const coordenador = (azure.COORDENADOR || '').trim() || null;
      incrementar(projeto, coordenador);
    });

    // Gerar saída
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
  });

  return dadosColaboradores;
}

// === ENDPOINTS ===

// /api/colaboradores?inicio=2025-01&fim=2026-03
app.get('/api/colaboradores', async (req, res) => {
  try {
    // Carregar dados base (com cache)
    if (!cache.colaboradores || !cache.lastUpdate || (Date.now() - cache.lastUpdate >= CACHE_TTL)) {
      if (cache.updating) {
        if (cache.colaboradores) {
          // Retornar cache antigo enquanto atualiza
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
        const dadosBase = await carregarDadosBase();
        cache.colaboradores = dadosBase;
        cache.lastUpdate = Date.now();
      } finally {
        cache.updating = false;
      }
    }

    const { funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum } = cache.colaboradores;

    // Determinar período
    const agora = new Date();
    let inicio, fim;

    if (req.query.inicio) {
      const [anoI, mesI] = req.query.inicio.split('-').map(Number);
      inicio = new Date(anoI, mesI - 1, 1);
    } else {
      inicio = new Date(agora.getFullYear(), agora.getMonth() - 5, 1);
    }

    if (req.query.fim) {
      const [anoF, mesF] = req.query.fim.split('-').map(Number);
      fim = new Date(anoF, mesF - 1, 1);
    } else {
      fim = new Date(agora.getFullYear(), agora.getMonth(), 1);
    }

    const mesesList = gerarMeses(inicio, fim);
    const dados = calcularColaboradoresPorMes(funcsUnicos, azurePorCpf, projetoCoordenador, azureSemSecullum, mesesList);

    // Log totais por mês
    const totaisPorMes = {};
    dados.forEach(d => {
      if (!totaisPorMes[d.DATA]) totaisPorMes[d.DATA] = 0;
      totaisPorMes[d.DATA] += d.QUANTIDADE;
    });
    console.log(`[Colaboradores] Totais por mês:`, JSON.stringify(totaisPorMes));

    res.json({ meses: mesesList, dados });
  } catch (err) {
    cache.updating = false;
    console.error('[Colaboradores] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dados de imóveis (Azure SQL - CUSTOS_IMOVEIS em tempo real)
app.get('/api/imoveis', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
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
    console.log(`[Imóveis] ${dados.length} registros de CUSTOS_IMOVEIS`);
    res.json(dados);
  } catch (err) {
    console.error('[Imóveis] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Dados de refeição (Azure SQL - PAG_REFEICAO em tempo real)
app.get('/api/refeicao', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
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
    console.log(`[Refeição] ${dados.length} registros de PAG_REFEICAO`);
    res.json(dados);
  } catch (err) {
    console.error('[Refeição] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === DIAS TRABALHADOS (Secullum Batidas) ===
// Tipos excluídos (NÃO contam como dia de refeição)
// Tipos que NÃO contam como dia de refeição:
// FOLGABH = folga campo (saiu do alojamento), FERIAS, licenças, INSS
const TIPOS_EXCLUIDOS_BATIDA = ['FERIAS', 'L.MATER', 'L.PATER', 'A. INSS', 'FOLGABH'];

// Cache para dias trabalhados
let cacheDiasTrab = { dados: null, lastUpdate: null };
const CACHE_DIAS_TTL = 30 * 60 * 1000; // 30 minutos

async function calcularDiasTrabalhados() {
  console.log('[DiasTrab] Calculando dias trabalhados via Secullum Batidas...');
  const startTime = Date.now();

  // Meses para processar (todos que têm dados de refeição)
  const mesesProcessar = [
    { label: 'AGOSTO/25', inicio: '2025-08-01', fim: '2025-08-31' },
    { label: 'SETEMBRO/25', inicio: '2025-09-01', fim: '2025-09-30' },
    { label: 'OUTUBRO/25', inicio: '2025-10-01', fim: '2025-10-31' },
    { label: 'NOVEMBRO/25', inicio: '2025-11-01', fim: '2025-11-30' },
    { label: 'DEZEMBRO/25', inicio: '2025-12-01', fim: '2025-12-31' },
    { label: 'JANEIRO/26', inicio: '2026-01-01', fim: '2026-01-31' },
    { label: 'FEVEREIRO/26', inicio: '2026-02-01', fim: '2026-02-28' },
    { label: 'MARÇO/26', inicio: '2026-03-01', fim: '2026-03-31' },
  ];

  const resultado = {};

  // Buscar funcionários de cada banco para mapear Id -> Projeto
  for (const bancoId of BANCOS_ATIVOS) {
    let funcionarios;
    try {
      funcionarios = await secullumGet('/Funcionarios', bancoId);
    } catch (err) {
      console.warn(`[DiasTrab] Erro ao buscar funcionários banco ${bancoId}:`, err.message);
      continue;
    }
    if (!funcionarios || funcionarios.length === 0) {
      console.warn(`[DiasTrab] Banco ${bancoId}: sem funcionários (expirado ou vazio), pulando`);
      continue;
    }
    const funcMap = {};
    for (const f of funcionarios) {
      const depto = getDepartamentoDesc(f.Departamento);
      const projeto = normProjeto(depto);
      if (projeto) funcMap[f.Id] = projeto;
    }
    console.log(`[DiasTrab] Banco ${bancoId}: ${Object.keys(funcMap).length} funcionários mapeados`);

    await new Promise(r => setTimeout(r, 300));

    // Para cada mês, buscar batidas
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
        const funcId = b.FuncionarioId;
        const projeto = funcMap[funcId];
        if (!projeto) continue;

        const entrada1 = (b.Entrada1 || '').trim();
        if (!entrada1) continue;
        if (TIPOS_EXCLUIDOS_BATIDA.includes(entrada1)) continue;

        const key = `${projeto}|${mes.label}`;
        if (!resultado[key]) {
          resultado[key] = { projeto, mes: mes.label, diasReais: 0, funcsSet: new Set() };
        }
        resultado[key].diasReais++;
        resultado[key].funcsSet.add(funcId);
      }

      await new Promise(r => setTimeout(r, 300));
    }
  }

  // Converter para array final
  const dados = Object.values(resultado).map(d => ({
    PROJETO: d.projeto,
    MES: d.mes,
    DIAS_REAIS: d.diasReais,
    FUNCIONARIOS: d.funcsSet.size,
    MEDIA_DIAS_FUNC: d.funcsSet.size > 0 ? Math.round((d.diasReais / d.funcsSet.size) * 10) / 10 : 0
  })).sort((a, b) => a.MES.localeCompare(b.MES) || a.PROJETO - b.PROJETO);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[DiasTrab] ${dados.length} registros gerados em ${elapsed}s`);
  return dados;
}

app.get('/api/dias-trabalhados', async (req, res) => {
  try {
    if (cacheDiasTrab.dados && cacheDiasTrab.lastUpdate && (Date.now() - cacheDiasTrab.lastUpdate < CACHE_DIAS_TTL)) {
      console.log('[DiasTrab] Retornando do cache');
      return res.json(cacheDiasTrab.dados);
    }
    const dados = await calcularDiasTrabalhados();
    cacheDiasTrab = { dados, lastUpdate: Date.now() };
    res.json(dados);
  } catch (err) {
    console.error('[DiasTrab] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Alojados aproximados por projeto (cargos operacionais do Azure COLABORADORES)
app.get('/api/alojados-aprox', async (req, res) => {
  try {
    const pool = await sql.connect(sqlConfig);
    const result = await pool.request().query(`
      SELECT PROJETO_RH as PROJETO, COUNT(*) as ALOJADOS_APROX
      FROM COLABORADORES
      WHERE SITUACAO = '1'
        AND FUNCAO_EXECUTANTE IN ('TRABALHADOR','OPERADOR','MOTORISTA','MECANICO','LIDER')
      GROUP BY PROJETO_RH
      ORDER BY PROJETO_RH
    `);
    const dados = {};
    result.recordset.forEach(r => {
      const proj = Number(r.PROJETO);
      if (proj) dados[proj] = r.ALOJADOS_APROX;
    });
    console.log(`[AlojadosAprox] ${Object.keys(dados).length} projetos`);
    res.json(dados);
  } catch (err) {
    console.error('[AlojadosAprox] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    bancos: BANCOS_ATIVOS,
    cache: {
      loaded: !!cache.colaboradores,
      lastUpdate: cache.lastUpdate ? new Date(cache.lastUpdate).toISOString() : null,
      age: cache.lastUpdate ? `${((Date.now() - cache.lastUpdate) / 1000).toFixed(0)}s` : null
    }
  });
});

// === INICIAR ===
app.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  GET /api/colaboradores?inicio=2025-01&fim=2026-03');
  console.log('  GET /api/dias-trabalhados');
  console.log('  GET /api/health');
});
