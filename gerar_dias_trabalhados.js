/**
 * Script para buscar dias reais trabalhados do Secullum
 * e gerar dados_dias_trabalhados.js para o dashboard.
 *
 * Lógica:
 *  - Busca Funcionarios de cada banco (ALR + LARSIL) → mapeia Id → Projeto (Departamento)
 *  - Busca Batidas por mês
 *  - Conta dias elegíveis (exclui FERIAS, L.MATER, L.PATER, A. INSS)
 *  - Agrupa por PROJETO + MES → total dias reais
 *
 * Uso: node gerar_dias_trabalhados.js
 */

const fs = require('fs');
const https = require('https');

// === CONFIG ===
const SECULLUM_USER = 'ferreira.eduardo@larsil.com.br';
const SECULLUM_PASS = 'larsil123@';

const BANCOS = [
    { id: 73561, nome: 'ALR' },
    { id: 78833, nome: 'LARSIL' },
];

// Tipos que EXCLUEM (não contam como dia de refeição)
const TIPOS_EXCLUIDOS = ['FERIAS', 'L.MATER', 'L.PATER', 'A. INSS'];

// Meses que queremos processar (baseado nos dados de refeição existentes)
const MESES_PROCESSAR = [
    { label: 'AGOSTO/25', inicio: '2025-08-01', fim: '2025-08-31' },
    { label: 'OUTUBRO/25', inicio: '2025-10-01', fim: '2025-10-31' },
    { label: 'NOVEMBRO/25', inicio: '2025-11-01', fim: '2025-11-30' },
    { label: 'DEZEMBRO/25', inicio: '2025-12-01', fim: '2025-12-31' },
    { label: 'JANEIRO/26', inicio: '2026-01-01', fim: '2026-01-31' },
    { label: 'FEVEREIRO/26', inicio: '2026-02-01', fim: '2026-02-28' },
];

// === HELPERS ===
function httpsRequest(url, options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve(data); }
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getToken() {
    const body = `grant_type=password&username=${encodeURIComponent(SECULLUM_USER)}&password=${encodeURIComponent(SECULLUM_PASS)}&client_id=3`;
    const url = new URL('https://autenticador.secullum.com.br/Token');
    const result = await httpsRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }, body);
    return result.access_token;
}

async function getFuncionarios(token, bancoId) {
    const url = new URL('https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Funcionarios');
    return await httpsRequest(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'secullumidbancoselecionado': String(bancoId)
        }
    });
}

async function getBatidas(token, bancoId, dataInicio, dataFim) {
    const url = new URL(`https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Batidas?dataInicio=${dataInicio}&dataFim=${dataFim}`);
    return await httpsRequest(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'secullumidbancoselecionado': String(bancoId)
        }
    });
}

function normalizarProjeto(departamentoDesc) {
    if (!departamentoDesc) return null;
    // Extrair número do projeto (ex: "820 CASA VERDE" -> 820, "820-101" -> 820)
    const match = departamentoDesc.match(/^(\d+)/);
    if (match) return parseInt(match[1]);
    return null;
}

function isDiaElegivel(batida) {
    const entrada1 = batida.Entrada1 || '';
    // Se o tipo está na lista de exclusão, não conta
    if (TIPOS_EXCLUIDOS.includes(entrada1.trim())) return false;
    // Dia vazio (sem entrada e sem tipo) não conta
    if (!entrada1.trim()) return false;
    // Todo o resto conta (horário normal, DOM, FOLGA, FALTA, ATESTAD, DECL., H.P, FERIADO, FOLGABH, etc.)
    return true;
}

// === MAIN ===
async function main() {
    console.log('=== Gerando dados de dias trabalhados ===\n');

    const token = await getToken();
    console.log('Token obtido.\n');

    // Resultado final: { "PROJETO|MES": { projeto, mes, diasReais, totalFuncionarios } }
    const resultado = {};

    for (const banco of BANCOS) {
        console.log(`--- Banco: ${banco.nome} (${banco.id}) ---`);

        // 1. Buscar funcionários e mapear Id -> Projeto
        const funcionarios = await getFuncionarios(token, banco.id);
        const funcMap = {}; // FuncionarioId -> projeto (number)
        let ativosCount = 0;
        for (const f of funcionarios) {
            const demissao = f.Demissao;
            const depto = f.Departamento ? f.Departamento.Descricao : null;
            const projeto = normalizarProjeto(depto);
            // Mapear todos (ativos e inativos que podem ter batidas no período)
            if (projeto) {
                funcMap[f.Id] = projeto;
            }
            if (!demissao && projeto) ativosCount++;
        }
        console.log(`  ${Object.keys(funcMap).length} funcionarios mapeados (${ativosCount} ativos)\n`);

        await sleep(300);

        // 2. Para cada mês, buscar batidas
        for (const mes of MESES_PROCESSAR) {
            console.log(`  Buscando batidas ${mes.label}...`);

            let batidas;
            try {
                batidas = await getBatidas(token, banco.id, mes.inicio, mes.fim);
            } catch (err) {
                console.log(`    ERRO: ${err.message}`);
                await sleep(300);
                continue;
            }

            console.log(`    ${batidas.length} registros de batida`);

            // Contar dias elegíveis por projeto
            const diasPorProjeto = {}; // projeto -> { dias: Set de "funcId|data", funcs: Set de funcId }

            for (const b of batidas) {
                const funcId = b.FuncionarioId;
                const projeto = funcMap[funcId];
                if (!projeto) continue;

                if (!isDiaElegivel(b)) continue;

                if (!diasPorProjeto[projeto]) {
                    diasPorProjeto[projeto] = { dias: 0, funcsSet: new Set() };
                }
                diasPorProjeto[projeto].dias++;
                diasPorProjeto[projeto].funcsSet.add(funcId);
            }

            // Acumular no resultado
            for (const [proj, info] of Object.entries(diasPorProjeto)) {
                const key = `${proj}|${mes.label}`;
                if (!resultado[key]) {
                    resultado[key] = { projeto: parseInt(proj), mes: mes.label, diasReais: 0, funcionarios: 0 };
                }
                resultado[key].diasReais += info.dias;
                // Para funcionários, pegar o max (pode ter overlap entre bancos)
                resultado[key].funcionarios = Math.max(resultado[key].funcionarios, info.funcsSet.size);
            }

            await sleep(300);
        }
    }

    // Gerar output
    const dados = Object.values(resultado).sort((a, b) => {
        if (a.mes !== b.mes) return a.mes.localeCompare(b.mes);
        return a.projeto - b.projeto;
    });

    console.log('\n=== RESULTADO ===');
    console.log(`${dados.length} registros (projeto x mês)\n`);

    // Tabela resumo
    for (const d of dados) {
        const mediaPorFunc = d.funcionarios > 0 ? (d.diasReais / d.funcionarios).toFixed(1) : 'N/A';
        console.log(`  Proj ${String(d.projeto).padStart(4)} | ${d.mes.padEnd(14)} | ${String(d.diasReais).padStart(5)} dias | ${String(d.funcionarios).padStart(3)} funcs | média ${mediaPorFunc} dias/func`);
    }

    // Gerar arquivo JS
    const jsContent = `// DADOS DE DIAS TRABALHADOS - Gerado automaticamente via Secullum API
// Gerado em: ${new Date().toLocaleString('pt-BR')}
// Regra: exclui FERIAS, L.MATER, L.PATER, A. INSS - todo o resto conta como dia de refeição
const dadosDiasTrabalhados = ${JSON.stringify(dados, null, 4)};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { dadosDiasTrabalhados };
}
`;

    const outputPath = __dirname + '/dados_dias_trabalhados.js';
    fs.writeFileSync(outputPath, jsContent, 'utf8');
    console.log(`\nArquivo gerado: ${outputPath}`);
}

main().catch(err => {
    console.error('ERRO FATAL:', err);
    process.exit(1);
});
