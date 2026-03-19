# Secullum Ponto Web - API IntegracaoExterna

Documentação completa dos endpoints disponíveis na API de Integração Externa do Secullum Ponto Web, mapeados e testados em março/2026.

---

## Autenticação

**URL:** `https://autenticador.secullum.com.br/Token`  
**Método:** `POST`  
**Content-Type:** `application/x-www-form-urlencoded`

**Body:**
```
grant_type=password&username=ferreira.eduardo@larsil.com.br&password=larsil123@&client_id=3
```

**Resposta (200):**
```json
{
  "access_token": "eyJhbGci...",
  "token_type": "bearer",
  "expires_in": 86399
}
```

**Uso:** Incluir em todas as requests como header:
```
Authorization: Bearer {access_token}
```

> Token expira em 24h. Renovar com nova chamada ao /Token.

---

## Base URL

```
https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna
```

---

## Bancos (Empresas/Filiais)

O `bancoId` identifica a empresa/filial. Usado como query param na maioria dos GETs.

| Empresa | bancoId |
|---------|---------|
| ALR FLORESTAL EMPREENDIMENTOS LTDA | 73561 |

---

## Endpoints de Leitura (GET)

### Funcionários
```
GET /Funcionarios?bancoId={bancoId}
```
Retorna array de todos os funcionários vinculados ao banco.

**Campos principais:**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| Id | int | ID interno do funcionário |
| Nome | string | Nome completo |
| NumeroFolha | int | Número da folha |
| Cpf | string | CPF com pontos e traço (ex: "074.072.081-31") |
| Admissao | string | Data admissão (ISO) |
| Demissao | string/null | Data demissão (ISO) ou null |
| DepartamentoId | int | ID do departamento |
| Departamento | string | Nome do departamento |
| FuncaoId | int | ID da função |
| Funcao | string | Nome da função/cargo |
| HorarioId | int | ID do horário |
| Horario | string | Descrição do horário |
| EmpresaId | int | ID da empresa |
| Empresa | string | Nome da empresa |
| EstruturaId | int/null | ID da estrutura |
| Estrutura | string/null | Nome da estrutura |
| Email | string | Email |
| Celular | string | Celular |
| Masculino | bool | Sexo masculino |
| PeriodoEncerrado | string | Data do último período encerrado |
| PossuiFoto | bool | Se tem foto cadastrada |

> Total de campos: ~70. Veja `NumeroIdentificador`, `NumeroPis`, `Carteira`, `Rg`, `Mae`, `Pai`, `Nascimento`, `Nacionalidade`, `Naturalidade`, etc.

---

### Batidas (Cartão Ponto - Leitura)
```
GET /Batidas?bancoId={bancoId}&dataInicio={YYYY-MM-DD}&dataFim={YYYY-MM-DD}
```

**Parâmetros:**
| Param | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| bancoId | int | Sim | ID do banco/empresa |
| dataInicio | string | Sim | Data início (YYYY-MM-DD) |
| dataFim | string | Sim | Data fim (YYYY-MM-DD) |

**Resposta:** Array de objetos batida, um por funcionário/dia.

**Campos principais:**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| FuncionarioId | int | ID do funcionário |
| Data | string | Data (ISO) |
| Entrada1 | string/null | Horário entrada 1 (ex: "06:00") |
| Saida1 | string/null | Horário saída 1 |
| Entrada2 | string/null | Horário entrada 2 |
| Saida2 | string/null | Horário saída 2 |
| Entrada3..Entrada5 | string/null | Entradas extras |
| Saida3..Saida5 | string/null | Saídas extras |
| FonteDadosEntrada1 | object/null | Metadados da batida |
| FonteDadosSaida1 | object/null | Metadados da batida |
| ... (FonteDados para cada slot) | | |
| BSaldo | string | Banco de saldo |
| BAnterior | string | Banco anterior |
| Extra100 | string | Horas extras 100% |
| Falta | string | Horas falta |
| HorasNoturnasRealizadas | string | Horas noturnas |
| Observacao | string | Observação do dia |
| TipoDeRegistro | string | Tipo do registro do dia |

**Objeto FonteDados (ex: FonteDadosEntrada1):**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| DataInclusao | string | Quando a batida foi registrada (ISO) |
| Origem | int | 1=Equipamento, 11=Inclusão manual online, etc. |
| EquipamentoId | int/null | ID do equipamento que registrou |
| EquipamentoDescricao | string/null | Nome do equipamento |
| NSR | int/null | Número Sequencial de Registro |
| Observacao | string | Observação |

> **Origens conhecidas:** 1=Equipamento físico (REP), 11=Inclusão manual online

---

### Equipamentos
```
GET /Equipamentos?bancoId={bancoId}
```
Lista todos os equipamentos (relógios de ponto) vinculados.

**Campos:**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| Id | int | ID do equipamento |
| Descricao | string | Descrição/nome do equipamento |
| EnderecoIP | string/null | IP da rede (null para offline) |

---

### Horários
```
GET /Horarios?bancoId={bancoId}
```
Lista todos os horários de trabalho configurados.

**Campos:**
| Campo | Tipo | Descrição |
|-------|------|-----------|
| Id | int | ID do horário |
| Numero | int | Número do horário |
| Descricao | string | Ex: "seg-sex 8hrs sab 4 hrs" |
| Desativar | bool | Se está desativado |
| Opcoes | object | Configurações detalhadas (tolerância, colunas, etc.) |

---

### Departamentos
```
GET /Departamentos?bancoId={bancoId}
```
**Campos:** `Id`, `Descricao`, `Nfolha`

---

### Empresas
```
GET /Empresas
```
Lista todas as empresas/filiais. **Não precisa de bancoId.**

**Campos:** `Id`, `Nome`, `Uf`, `Cep`, `Bairro`, `Telefone`, etc.

---

### Funções (Cargos)
```
GET /Funcoes?bancoId={bancoId}
```
**Campos:** `Id`, `Descricao`

---

### Estruturas
```
GET /Estruturas?bancoId={bancoId}
```
Retorna array de strings (nomes das estruturas).

**Exemplo:** `["820-ADM", "AFASTADOS INSS"]`

---

## Endpoints de Escrita

### Deletar Batida
```
DELETE /CartaoPonto
```
Remove uma batida (slot) específica de um dia.

**Body (JSON):**
```json
{
  "Cpf": "07407208131",
  "Data": "2026-02-16",
  "Coluna": "Saida1",
  "Motivo": "Correcao de horario"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| Cpf | string | Sim* | CPF sem pontos/traço (somente dígitos) |
| NumeroFolha | int | Sim* | Número da folha (alternativa ao CPF) |
| Data | string | Sim | Data (YYYY-MM-DD) |
| Coluna | string | Sim | Slot: Entrada1, Saida1, Entrada2, Saida2, ..., Entrada5, Saida5 |
| Motivo | string | Sim | Motivo da exclusão |

> *Usar `Cpf` OU `NumeroFolha` — ambos funcionam para identificar o funcionário.

**Resposta:** `200` (vazio) = sucesso

---

### Inserir Batida Manual
```
POST /CartaoPonto/Manual
```
Insere uma batida manual (com asterisco *) em um slot.

**Body (JSON):**
```json
{
  "Cpf": "07407208131",
  "Data": "2026-02-16",
  "Coluna": "Saida1",
  "Hora": "12:34",
  "Motivo": "Alteracao devido a divergencia do sistema"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| Cpf | string | Sim* | CPF sem pontos/traço |
| NumeroFolha | int | Sim* | Número da folha (alternativa) |
| Data | string | Sim | Data (YYYY-MM-DD) |
| Coluna | string | Sim | Slot: Entrada1, Saida1, Entrada2, Saida2, etc. |
| Hora | string | Sim | Horário (HH:MM) |
| Motivo | string | Sim | Motivo da inclusão |

> Batidas inseridas por este endpoint ficam com **Origem=11** (manual online) e marcadas com asterisco (*) no cartão ponto.

**Resposta:** `200` (vazio) = sucesso

---

### Justificativa em Grupo
```
POST /CartaoPonto/Justificativa
```
Aplica justificativa a um grupo de dias.

**Body (JSON):**
```json
{
  "Cpf": "07407208131",
  "Data": "2026-02-16",
  "Grupo": "ATESTADO",
  "Justificativa": "Atestado médico"
}
```

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| Cpf | string | Sim* | CPF sem pontos/traço |
| NumeroFolha | int | Sim* | Número da folha |
| Data | string | Sim | Data (YYYY-MM-DD) |
| Grupo | string | Sim | Nome do grupo de justificativa |
| Justificativa | string | Sim | Texto da justificativa |

---

### Cadastrar Afastamento
```
POST /Afastamentos
```

**Campos obrigatórios:** `Inicio`, `Fim`, `DataInclusao` (todos em formato data ISO)

> Estrutura completa não mapeada — precisa testar com dados reais.

---

### Cadastrar Feriado
```
POST /Feriados
```

**Campo obrigatório:** `Data` (YYYY-MM-DD)

> Estrutura completa não mapeada.

---

### Configuração de Equipamento
```
POST /ConfiguracaoEquipamento
```

**Campo obrigatório:** `EquipamentoDescricao` (deve corresponder a um equipamento existente)

> Funciona com a descrição exata de um equipamento já cadastrado. Uso ainda não totalmente mapeado.

---

## Slots (Colunas) Válidos

As colunas usadas em DELETE e POST Manual:

| Coluna | Descrição |
|--------|-----------|
| Entrada1 | 1ª entrada do dia |
| Saida1 | 1ª saída do dia |
| Entrada2 | 2ª entrada (retorno almoço) |
| Saida2 | 2ª saída do dia |
| Entrada3 | 3ª entrada |
| Saida3 | 3ª saída |
| Entrada4 | 4ª entrada |
| Saida4 | 4ª saída |
| Entrada5 | 5ª entrada |
| Saida5 | 5ª saída |

---

## Códigos de Erro Comuns

| Status | Mensagem | Causa |
|--------|----------|-------|
| 400 | "Funcionário não encontrado." | CPF ou NumeroFolha não existe no banco |
| 400 | "O campo Nº Folha é obrigatório." | Nem Cpf nem NumeroFolha foi enviado |
| 400 | "Preencha o campo Data corretamente." | Data em formato inválido |
| 400 | "Preencha o campo Inicio corretamente." | Campo obrigatório faltando |
| 405 | (vazio) | Método HTTP errado para esse endpoint |
| 404 | (vazio) | Endpoint não existe |
| 500 | NullReferenceException | Body inválido/vazio enviado para DELETE |

---

## Exemplo Completo: Corrigir uma Batida

### Passo 1: Autenticar
```javascript
const authBody = 'grant_type=password&username=ferreira.eduardo@larsil.com.br&password=larsil123@&client_id=3';
const authRes = await fetch('https://autenticador.secullum.com.br/Token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: authBody
});
const { access_token } = await authRes.json();
```

### Passo 2: Consultar batida atual
```javascript
const batidas = await fetch(
  'https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Batidas?bancoId=73561&dataInicio=2026-02-16&dataFim=2026-02-16',
  { headers: { Authorization: `Bearer ${access_token}` } }
).then(r => r.json());
```

### Passo 3: Deletar batida errada
```javascript
await fetch('https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/CartaoPonto', {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    Cpf: '07407208131',
    Data: '2026-02-16',
    Coluna: 'Saida1',
    Motivo: 'Correcao de horario'
  })
});
```

### Passo 4: Inserir batida correta
```javascript
await fetch('https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/CartaoPonto/Manual', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${access_token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    Cpf: '07407208131',
    Data: '2026-02-16',
    Coluna: 'Saida1',
    Hora: '12:34',
    Motivo: 'Alteracao devido a divergencia do sistema'
  })
});
```

---

## Notas Importantes

1. **CPF sem formatação**: Sempre enviar somente dígitos (ex: `07407208131`, não `074.072.081-31`)
2. **Datas em YYYY-MM-DD**: Formato ISO nos query params e no body
3. **Horário em HH:MM**: Formato 24h
4. **Período encerrado**: Batidas em períodos já fechados podem ser alteradas via API
5. **Batida manual (*)**: Tudo inserido via `/CartaoPonto/Manual` fica com asterisco — é Origem=11
6. **Rate limiting**: Não documentado pela Secullum, mas recomendável delay de 200-300ms entre chamadas
7. **Token 24h**: O access_token dura 24 horas. Armazene e reutilize.
8. **BancoId obrigatório**: Maioria dos GETs precisa do `bancoId` como query param
9. **DELETE retorna 200 vazio**: Sucesso no DELETE não retorna body
10. **POST Manual retorna 200 vazio**: Sucesso na inserção não retorna body

---

## Endpoints Inexistentes (testados, retornam 404)

Estes endpoints **não existem** na API IntegracaoExterna:
- `/ReconhecimentoFacial` — facial é feito pelo app Secullum, não via API
- `/DispositivosAutorizados` — gerenciado pelo painel web
- `/Registros`, `/PontosRegistrados` — não há endpoint de leitura de registros brutos
- `/PontosOnline`, `/RegistrosPonto` — não existe
- `/Perimetros`, `/Localizacoes` — configurados no painel web
- `/Swagger`, `/Help` — sem documentação auto-gerada

---

*Última atualização: 10/03/2026*
*Mapeado por exploração direta dos endpoints com token autenticado.*
