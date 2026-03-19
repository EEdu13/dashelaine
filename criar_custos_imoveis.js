const sql = require('mssql');
const xlsx = require('xlsx');

const config = {
    server: 'alrflorestal.database.windows.net',
    database: 'Tabela_teste',
    user: 'sqladmin',
    password: 'SenhaForte123!',
    options: { encrypt: true, trustServerCertificate: false }
};

async function main() {
    const pool = await sql.connect(config);
    console.log('Conectado ao Azure SQL');

    // 1. Dropar tabela se existir e criar nova
    await pool.request().query(`
        IF OBJECT_ID('CUSTOS_IMOVEIS', 'U') IS NOT NULL DROP TABLE CUSTOS_IMOVEIS;
        CREATE TABLE CUSTOS_IMOVEIS (
            ID INT IDENTITY(1,1) PRIMARY KEY,
            MES NVARCHAR(20) NOT NULL,
            MES_ANO VARCHAR(10) NOT NULL,
            PROJETO INT NOT NULL,
            COORDENADOR NVARCHAR(100),
            IMOVEL NVARCHAR(20),
            ENDERECO NVARCHAR(255),
            TIPO_IMOVEL NVARCHAR(50),
            DESTINACAO NVARCHAR(255),
            ALUGUEL DECIMAL(12,2) DEFAULT 0,
            ENERGIA DECIMAL(12,2) DEFAULT 0,
            AGUA DECIMAL(12,2) DEFAULT 0,
            INTERNET DECIMAL(12,2) DEFAULT 0,
            IPTU DECIMAL(12,2) DEFAULT 0,
            MANUTENCAO DECIMAL(12,2) DEFAULT 0,
            ALOJADOS INT DEFAULT 0,
            CAPACIDADE_ALOJADOS INT DEFAULT 0
        );
    `);
    console.log('Tabela CUSTOS_IMOVEIS criada');

    // 2. Ler Excel
    const wb = xlsx.readFile('IMOVEIS_PIVOTADO (1).xlsx');
    const data = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    console.log(`Lidos ${data.length} registros do Excel`);

    // 3. Inserir em lotes de 50
    const batchSize = 50;
    let inserted = 0;
    for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const values = batch.map((r, idx) => {
            const base = i + idx;
            return `(@mes${base}, @mesano${base}, @proj${base}, @coord${base}, @imovel${base}, @end${base}, @tipo${base}, @dest${base}, @alug${base}, @ener${base}, @agua${base}, @inter${base}, @iptu${base}, @manut${base}, @aloj${base}, @cap${base})`;
        }).join(',\n');

        const req = pool.request();
        batch.forEach((r, idx) => {
            const base = i + idx;
            req.input(`mes${base}`, sql.NVarChar, r.MES || '');
            req.input(`mesano${base}`, sql.VarChar, r.MES_ANO || '');
            req.input(`proj${base}`, sql.Int, r.PROJETO || 0);
            req.input(`coord${base}`, sql.NVarChar, r.COORDENADOR || null);
            req.input(`imovel${base}`, sql.NVarChar, String(r.IMOVEL || '0'));
            req.input(`end${base}`, sql.NVarChar, r['ENDEREÇO'] || '');
            req.input(`tipo${base}`, sql.NVarChar, r.TIPO_IMOVEL || null);
            req.input(`dest${base}`, sql.NVarChar, r['DESTINAÇÃO'] || '');
            req.input(`alug${base}`, sql.Decimal(12,2), r.ALUGUEL || 0);
            req.input(`ener${base}`, sql.Decimal(12,2), r.ENERGIA || 0);
            req.input(`agua${base}`, sql.Decimal(12,2), r.AGUA || 0);
            req.input(`inter${base}`, sql.Decimal(12,2), r.INTERNET || 0);
            req.input(`iptu${base}`, sql.Decimal(12,2), r.IPTU || 0);
            req.input(`manut${base}`, sql.Decimal(12,2), r.MANUTENCAO || 0);
            req.input(`aloj${base}`, sql.Int, r.ALOJADOS || 0);
            req.input(`cap${base}`, sql.Int, r['CAPACIDADE DE ALOJADOS'] || 0);
        });

        await req.query(`INSERT INTO CUSTOS_IMOVEIS (MES, MES_ANO, PROJETO, COORDENADOR, IMOVEL, ENDERECO, TIPO_IMOVEL, DESTINACAO, ALUGUEL, ENERGIA, AGUA, INTERNET, IPTU, MANUTENCAO, ALOJADOS, CAPACIDADE_ALOJADOS) VALUES ${values}`);
        inserted += batch.length;
        process.stdout.write(`\rInseridos: ${inserted}/${data.length}`);
    }

    console.log('\n\nVerificando...');
    const result = await pool.request().query('SELECT COUNT(*) as total FROM CUSTOS_IMOVEIS');
    console.log('Total registros na tabela:', result.recordset[0].total);

    const sample = await pool.request().query("SELECT TOP 5 * FROM CUSTOS_IMOVEIS WHERE TIPO_IMOVEL IS NOT NULL");
    console.log('Amostra (com TIPO_IMOVEL):');
    sample.recordset.forEach(r => console.log(r.PROJETO, r.TIPO_IMOVEL, 'Alojados:', r.ALOJADOS, 'Cap:', r.CAPACIDADE_ALOJADOS, r.ENDERECO));

    const tipos = await pool.request().query("SELECT TIPO_IMOVEL, COUNT(*) as qtd FROM CUSTOS_IMOVEIS GROUP BY TIPO_IMOVEL");
    console.log('\nTipos de imovel:');
    tipos.recordset.forEach(r => console.log(' ', r.TIPO_IMOVEL || '(null)', '-', r.qtd, 'registros'));

    await pool.close();
    console.log('Concluido!');
}

main().catch(err => { console.error(err); process.exit(1); });
