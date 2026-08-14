# Especificação: runner, lease e controller de despacho

**Versão da API:** `v1` · **Migração:** [`packages/core/migrations/0004_runner_lease.sql`](../../packages/core/migrations/0004_runner_lease.sql)
**Decisão de origem:** [D5](../../DECISOES.md) — "trabalho despachado carrega lease; runner morto expira e o trabalho volta à fila. Registros idempotentes na API"

Um trabalho só pode ter um dono por vez, e o dono pode morrer sem avisar. Essas
duas frases são o problema inteiro desta camada, e a lease é a resposta: um
direito **temporário** sobre um trabalho, que precisa ser renovado para
continuar valendo. Quem para de renovar perde — não por decisão de ninguém, mas
por vencimento de prazo.

O corolário importante é onde o estado mora. O teto de sessões simultâneas e o
prazo das leases vivem no control plane, nunca no runner: só o servidor escreve
no banco ([D1](../../DECISOES.md)), e é isso que faz "no máximo N sessões neste
projeto" valer para o projeto — somando todos os runners — e não para cada
processo isoladamente. O runner é cliente HTTP puro, exatamente como a tela
(D11): ele declara os limites, e obedece à resposta.

---

## 1. As duas entidades

| Entidade | O que é | Muda? |
|---|---|---|
| `runner` | A **identidade** de um processo que executa trabalho. | Só o nome. |
| `lease` | O **direito temporário** de um runner sobre um trabalho, com prazo próprio. | Status, prazo e carimbos de heartbeat/fim. |

```sql
CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  nome          TEXT,
  registrado_em TEXT NOT NULL
);

CREATE TABLE lease (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id        TEXT NOT NULL REFERENCES runner(id),
  trabalho_id      INTEGER NOT NULL, -- solto de propósito (§6)
  projeto_id       INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'ativa'
                     CHECK (status IN ('ativa', 'liberada', 'expirada')),
  ttl_segundos     INTEGER NOT NULL,
  concedida_em     TEXT NOT NULL,
  heartbeat_em     TEXT NOT NULL,
  expira_em        TEXT NOT NULL,
  liberada_em      TEXT,
  motivo_expiracao TEXT CHECK (motivo_expiracao IN ('heartbeat_perdido', 'expirou'))
);

CREATE INDEX idx_lease_runner_status   ON lease (runner_id, status);
CREATE INDEX idx_lease_projeto_status  ON lease (projeto_id, status);
CREATE INDEX idx_lease_trabalho_status ON lease (trabalho_id, status);
```

Os três índices são os três caminhos de leitura do despacho, na ordem em que
ele os percorre: o trabalho já tem dono? o runner ainda tem vaga? o projeto
ainda tem vaga?

**O runner não é escopado a um projeto.** O pareamento é só identidade;
`projeto_id` é declarado a cada pedido de lease. Um runner físico pode servir
projetos diferentes ao longo do tempo, e nada nos critérios de aceite pede o
contrário.

Nada é apagado, nem lease morta: ela vira `expirada` com o motivo gravado e
continua na tabela. É o mesmo append-only da [D15](../../DECISOES.md) — e é o
que vai permitir, quando a telemetria do `t102` entrar, cruzar "runner × leases
perdidas" sem ter que reconstruir nada.

---

## 2. Ciclo de vida da lease

```
                      liberar (o dono terminou, bem ou mal)
   ativa ──────────────────────────────────────────────────▶ liberada
     │
     │ expira_em vence sem heartbeat, e alguém pede trabalho
     ▼
  expirada  (motivo_expiracao: expirou | heartbeat_perdido)
```

Uma lease nasce `ativa`, com `heartbeat_em = concedida_em` e
`expira_em = concedida_em + ttl_segundos`. Cada heartbeat empurra `expira_em`
para frente e carimba `heartbeat_em`.

Só há duas saídas, e nenhuma delas volta:

- **`liberada`** — o dono avisou que terminou. A capacidade volta na hora: o
  próximo pedido do mesmo runner/projeto já não conta esta lease no teto.
- **`expirada`** — o prazo venceu e ninguém renovou.

### O vocabulário de `motivo_expiracao`

Os dois motivos descrevem óbitos diferentes, e a diferença é operacionalmente
útil — um aponta para trabalho que não começou, o outro para trabalho
interrompido no meio:

| Motivo | Quando | O que significa |
|---|---|---|
| `expirou` | `heartbeat_em == concedida_em` | A lease **nunca** foi renovada. O runner pode nem ter começado. |
| `heartbeat_perdido` | `heartbeat_em > concedida_em` | Foi renovada ao menos uma vez e então calou. Runner morreu no meio do trabalho. |

Os dois nomes são exatamente os de `dados.motivo` em
[`lease.expirada.schema.json`](../../especificacoes/eventos/schemas/lease.expirada.schema.json):
quando o `t102` ligar a emissão de eventos, a projeção desta tabela e o evento
falam a mesma língua, sem tradução.

### `motivo` de recusa ≠ `motivo_expiracao`

São dois vocabulários distintos e vale não confundi-los. `motivo_expiracao` é
uma coluna: por que uma lease morreu. `motivo` é campo de resposta de
`POST /v1/leases`: por que um pedido **não virou** lease
(`trabalho_ja_leased`, `teto_runner`, `teto_projeto`).

---

## 3. Conceder é um passo só

`POST /v1/leases` faz cinco coisas, e faz todas dentro de **uma** transação
síncrona, sem nenhum `await` no meio:

```
reivindicar toda lease ativa cujo prazo venceu   ← trabalho de runner morto volta à fila
        ↓
o trabalho já tem dono ativo?     → 200 {lease: null, motivo: "trabalho_ja_leased"}
        ↓
o runner já bateu teto_runner?    → 200 {lease: null, motivo: "teto_runner"}
        ↓
o projeto já bateu teto_projeto?  → 200 {lease: null, motivo: "teto_projeto"}
        ↓
gravar a lease                    → 201 {lease}
```

**Por que uma transação só.** Entre contar as leases ativas e gravar a nova há
uma janela; se ela existir, N pedidos simultâneos contam todos o mesmo número,
todos se acham dentro do teto, e todos gravam. O teto de concorrência viraria
uma sugestão. A garantia é a mesma — e no mesmo formato, `db.transaction()`
síncrona — que `aplicarProposta` usa no `t101`.

**Por que reivindicar é o primeiro passo, e não uma rotina à parte.** Quem pede
trabalho é exatamente quem tem interesse em descobrir que uma lease morreu. Na
mesma transação, o pedido que encontra a lease vencida é o pedido que a
substitui — não existe instante em que o trabalho está livre e ninguém
percebeu. É por isso que não há rota de varredura: um gatilho que rode sem
ninguém pedir trabalho só é útil quando houver consumidor concreto (a tela do
`t107`, ou um projeto com todos os runners ociosos), e aí é aditivo.

**Recusa não é erro.** Teto batido e trabalho com dono devolvem `200` com
`{lease: null, motivo}`, não `409`. Do ponto de vista do runner isso é "agora
não, tenta o próximo candidato" — o caso comum de um pool saudável, não a
exceção.

---

## 4. O controller, do lado do runner

Um `tick()` é uma passada completa do loop de despacho:

```
GET /v1/trabalhos  → filtra bloqueado === false
        ↓
para cada candidato, em ordem: POST /v1/leases
        ↓ (recusado: tenta o próximo)
lease concedida
        ↓
arma o heartbeat periódico  ─────────────┐
        ↓                                │ POST /v1/leases/:id/heartbeats
   despachar(trabalhoId)                 │ a cada ttl/3
        ↓ (resolve OU rejeita)  ◀────────┘
para o heartbeat + POST /v1/leases/:id/liberacoes
```

Três decisões de projeto sustentam esse desenho:

**A lease é sempre devolvida.** A liberação está em `finally`, não no caminho
feliz: um despacho que estoura devolve a lease exatamente como um que termina
bem, e só então o erro sobe para quem chamou. Lease presa por trabalho que
falhou é capacidade ocupada por ninguém até o TTL vencer — pior que os dois
casos que ela pretendia cobrir.

**Heartbeat que falha não derruba o despacho.** Uma falha isolada de rede é
passageira; a consequência de várias seguidas já é a correta e automática — a
lease expira no server e o trabalho volta à fila. Abortar a sessão na primeira
falha trocaria um soluço de rede por trabalho perdido. O erro fica visível em
`ultimoErroDeHeartbeat`.

**O intervalo default é `ttl/3`**, ou seja, folga para duas batidas perdidas
antes de o servidor dar o runner por morto. Quem passa `intervaloHeartbeatMs`
explícito assume a conta: um intervalo maior que o TTL deixa a própria lease
expirar debaixo do despacho.

`despachar` é um **callback injetado** e é a única costura com o
[`EngineAdapter`](../formatos/engine-adapter.md) (`t104`): esta camada não abre
sessão nenhuma. Quem fechar o ciclo com sessão de verdade (`t106`/`t109`) passa
o adapter por aqui sem tocar no controller.

### Zero acesso ao banco

Nada em `packages/runner` importa driver de SQLite ou qualquer módulo de
`packages/core/src/db`. A regra é verificada estaticamente por
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), que
roda no lint sobre o repositório inteiro, e é exercida no teste fim a fim: o
control plane sobe como **processo separado**, e a única superfície entre os
dois é a porta HTTP.

---

## 5. Endpoints

Todos sob `/v1`. Nenhum exige autenticação (`t124`) e nenhum emite evento de
telemetria (`t102`).

| Método | Rota | O que faz |
|---|---|---|
| `POST` | `/v1/runners` | Pareia um runner. `201` na primeira vez, `200` (idempotente) se o `id` já existe. |
| `POST` | `/v1/leases` | Reivindica expiradas e tenta conceder. `201` com a lease, ou `200` com `{lease: null, motivo}`. |
| `POST` | `/v1/leases/:id/heartbeats` | Renova o prazo. Corpo opcional `{ttl_segundos}`; sem ele, mantém o TTL da lease. |
| `POST` | `/v1/leases/:id/liberacoes` | Encerra a lease e devolve a vaga na hora. |
| `GET` | `/v1/leases` | Lista, com filtros `projeto_id`, `runner_id` e `status`. Sem paginação nesta fase. |

Corpo de `POST /v1/leases`:

```json
{
  "runner_id": "runner-a",
  "projeto_id": 3,
  "trabalho_id": 42,
  "teto_runner": 2,
  "teto_projeto": 4,
  "ttl_segundos": 30
}
```

Os dois tetos chegam **como parâmetro em cada pedido**, não como configuração
persistida: nenhuma ficha do board cria ainda uma tabela de configuração de
projeto, e inventar uma aqui seria escopo não pedido. O dia em que existir, o
default passa a vir dela e o parâmetro vira sobreposição.

Códigos de erro:

| Situação | Código | `erro` |
|---|---|---|
| `id` de runner ausente ou vazio | `400` | `id_obrigatorio` |
| Campo de pedido ausente ou de tipo errado | `400` | `corpo_invalido` (com `campo`) |
| Filtro de listagem inválido | `400` | `filtro_invalido` (com `campo`) |
| `runner_id` não pareado | `404` | `runner_desconhecido` |
| Lease inexistente | `404` | `lease_desconhecida` |
| Heartbeat ou liberação sobre lease não `ativa` | `409` | `lease_nao_ativa` (com `status`) |

Recusa por teto ou por trabalho já leased **não** aparece nesta tabela: é `200`
com `motivo`, pelas razões do §3.

Implementação: [`routes/runners.ts`](../../packages/core/src/routes/runners.ts),
[`routes/leases.ts`](../../packages/core/src/routes/leases.ts),
[`repositorios/runners.ts`](../../packages/core/src/repositorios/runners.ts),
[`repositorios/leases.ts`](../../packages/core/src/repositorios/leases.ts),
[`controller/`](../../packages/runner/src/controller). Só `src/db/` toca o driver
do SQLite (D1); repositórios e rotas recebem o banco já aberto.

---

## 6. `trabalho_id` é um inteiro opaco

`POST /v1/leases` **não lê a tabela `trabalho`** e não tem FK para ela. A razão
original foi ordem de build (a tabela é entrega do `t102`, hoje já mergeada na
migração `0003`), mas o corte permanece pelo motivo de desenho — a mesma escolha
que o `t102` já fez para `grafo_versao_id`. Apertar a FK depois é aditivo, e cabe
à ficha que ligar os dois lados.

A divisão de responsabilidade que isso produz é, aliás, a correta:

- **elegibilidade** (o trabalho está bloqueado? em que nó está?) é decidida por
  `GET /v1/trabalhos`, consultada pelo controller **antes** de pedir a lease;
- **exclusividade e capacidade** são decididas por `POST /v1/leases`.

---

## 7. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ticket, não esquecimento:

- **Emissão dos eventos** [`lease.concedida`](../../especificacoes/eventos/schemas/lease.concedida.schema.json)
  e [`lease.expirada`](../../especificacoes/eventos/schemas/lease.expirada.schema.json) —
  dependem da tabela `evento` (`t102`). As colunas já carregam tudo que os dois
  eventos pedem (`runner_id`, `trabalho_id`, `expira_em`, `motivo_expiracao`);
  ligar a emissão é mapeamento direto. **Atenção de quem for ligar:** a
  taxonomia do `t98` tem `lease.concedida` e `lease.expirada`, e nenhum evento
  para a liberação — o reducer de referência
  ([`reconstruir-estado.mjs`](../../especificacoes/eventos/reducers/reconstruir-estado.mjs))
  projeta `leases` só com `ativa`/`expirada`. A tabela tem três estados, então
  ou a taxonomia ganha um `lease.liberada`, ou a projeção por eventos fica
  cega para o encerramento normal — que é o caso mais comum de todos. A
  decisão é de quem ligar a emissão; esta ficha não mexe na taxonomia.
- **Abrir sessão de verdade** pelo `EngineAdapter` — `despachar` é callback
  injetado (`t106`/`t109`).
- **Modo local** (avaliar um diretório sem control plane): não tem schema nem
  critério de aceite escrito em lugar nenhum do repo. Revisitar quando houver
  caso de uso concreto.
- **Tabela de configuração de teto** por runner ou por projeto (§5).
- **Varredura de expiradas dissociada do despacho** (§3).
- **WIP limit por estágio do grafo** — aqui só existe o teto bruto de sessões
  concorrentes.
- **Autenticação** no pareamento de runner (`t124`).
