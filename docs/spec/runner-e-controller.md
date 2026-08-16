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
que permite cruzar "runner × leases perdidas" sem ter que reconstruir nada,
agora que a telemetria do `t102` está no lugar (tabela `evento`, migração
`0003`); falta só ligar a emissão, e a §7 diz de quem é.

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
quando alguém ligar a emissão de eventos, a projeção desta tabela e o evento
falam a mesma língua, sem tradução — a tabela `evento` que eles precisam já
existe desde o `t102`.

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

**Provado com dois runners de verdade.** Até a `t164` todo teste de teto
chamava o repositório ou a rota **em processo**, um chamador de cada vez: a
garantia acima era propriedade do código que ninguém tinha visto acontecer.
[`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
põe dois `Controller` independentes, com credencial cada um, disputando a mesma
fila pelo endereço IPv4 real da máquina — e cobra as três consequências: nenhum
trabalho despachado duas vezes, nenhum dos dois runners deixado de fora, e o
teto de projeto sem nunca somar acima do configurado, mesmo sob pedidos
concorrentes de clientes distintos. O teto é do **projeto**, não do runner: a
contagem de `teto_projeto` não filtra por `runner_id`, e é por isso que ela
segura a frota inteira e não cada máquina em separado.

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

### Toda chamada tem prazo (`t193`)

O control plane fora do ar responde, e cada método do cliente já sabe o que
fazer com a resposta. O caso que faltava é outro: um control plane que **aceita
a conexão e não escreve nada** — um processo travado, um proxy que segurou a
requisição. Sem prazo, a chamada espera para sempre, e com ela o `tick()` que a
fez, o loop que espera o tick e o desligamento que espera o loop.

Desde a `t193` existe um único mecanismo HTTP para todo cliente do runner
([`http-client.ts`](../../packages/runner/src/controller/http-client.ts)), e ele
faz três coisas: põe um prazo em toda requisição, lê o **status antes** de
decodificar o corpo (a disciplina da `t156`, agora num dono só — quem responde
um erro nem sempre é o control plane, e um 502 em HTML não pode virar
`SyntaxError` cru) e devolve o erro que **quem chamou** construiu.

| Prazo | Default | Quem configura |
|---|---|---|
| Qualquer chamada ao control plane | 30 s | `--request-timeout-ms` |
| Batida de heartbeat | o próprio intervalo do heartbeat (`ttl/3`) | derivado, não configurável |

O heartbeat tem prazo mais curto porque tem uma janela natural: quem o arma sabe
de quanto em quanto tempo a próxima batida vence, e uma batida ainda no ar
quando a seguinte vence já não renova nada. Pela mesma razão, **uma batida que
não voltou é pulada, nunca sobreposta** — senão um control plane travado
acumularia uma requisição aberta por intervalo, a sessão inteira. Pular custa
uma batida, e o TTL já tolera duas.

Chamada que estoura o prazo rejeita com o `TimeoutError` do
`AbortSignal.timeout`, sem tipo novo para ninguém capturar. Nada é retentado
aqui: o tick falho é registrado e o loop pergunta de novo no próximo intervalo,
que é o mecanismo de retentativa que já existia.

### Parar sempre termina, e não deixa sessão órfã (`t193`)

Parar um runner é um pedido, e ele tem três estágios:

1. **Primeiro SIGINT/SIGTERM.** O loop para de **agendar**: nenhum tick novo
   nasce. O despacho em voo continua — matar uma sessão viva de fora deixaria um
   processo escrevendo na worktree sem ninguém para relatar o que ele fez.
2. **A carência.** `--shutdown-grace-seconds` (default **120 s**) é quanto esse
   despacho tem para terminar sozinho. Esgotada, a sessão viva é cancelada.
3. **Segundo SIGINT/SIGTERM.** Não espera nada: cancela na hora.

Cancelar reusa o caminho que o despacho já tinha para um fim conduzido pelo
adapter — `cancelled` vira `travada` na taxonomia, a **worktree é preservada**
(sessão cancelada não concluiu), a lease volta pelo `finally` do controller e o
erro final é o `DispatchError` que o loop já registra. Nada novo é escrito sobre
"como uma sessão cancelada é encerrada": só passou a existir mais um chamador do
que já existia.

Abaixo disso, cada adapter registra um `process.on('exit')` enquanto tem sessão
viva e sinaliza SIGTERM ao grupo do processo na saída. É a rede de segurança
para as saídas que os três estágios acima não cobrem — uma exceção não capturada
em outro lugar, um `process.exit()` seco. É SIGTERM e só: `'exit'` é o último
turno síncrono do processo, não sobra event loop para escalar para SIGKILL cinco
segundos depois.

**O limite honesto continua limite:** um `SIGKILL` no próprio runner não roda
JavaScript nenhum, o `'exit'` não dispara, e nada dentro deste processo impede
esse órfão. O que existe contra ele é a lease vencendo no server e o trabalho
voltando para a fila (D5).

### Zero acesso ao banco

Nada em `packages/runner` importa driver de SQLite ou qualquer módulo de
`packages/core/src/db`. A regra é verificada estaticamente por
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), que
roda no lint sobre o repositório inteiro, e é exercida no teste fim a fim: o
control plane sobe como **processo separado**, e a única superfície entre os
dois é a porta HTTP.

E, desde a `t143`, em outra **máquina**: [`cross-machine-dispatch.e2e.test.ts`](../../packages/runner/test/controller/cross-machine-dispatch.e2e.test.ts)
sobe o binário com `CARTOGRAFO_HOST=0.0.0.0`, alcança-o pelo endereço IPv4 real
da interface (não `127.0.0.1`) e roda o ciclo inteiro — concessão, heartbeat,
liberação — apresentando **só** a credencial que o pareamento emitiu. É o que
transforma o `CARTOGRAFO_HOST` configurável da `t124` em caminho provado, e não
em opção que ninguém nunca exercitou. Onde a máquina não tem interface IPv4
externa, o teste pula em vez de falhar: o que ele reportaria ali é a ausência de
rede, não uma regressão.

---

## 5. Endpoints

Todos sob `/v1` e, desde a `t124`, todos exigem `Authorization: Bearer <token>`
— o runner apresenta uma credencial em toda chamada, como qualquer outro cliente
da API. **Nenhum emite evento de telemetria**, e isso não é mais espera por
ficha nenhuma: o log append-only existe desde o `t102`, e ligar a emissão é o
item aberto da §7.

Desde a `t143` a credencial do runner é **dele**, emitida no pareamento, e a
coluna "quem chama" abaixo é contrato, não convenção: quem pareia, revoga e
enxerga a frota inteira é o operador (credencial `usuario`), e o runner só
alcança as quatro rotas do próprio despacho mais `GET /v1/jobs`. A lista de
rotas do runner é literal ([`auth.ts`](../../packages/core/src/auth.ts)): rota
nova nasce fora dela, e é assim que `GET /v1/runners` é do operador sem que
nada tenha sido escrito para recusá-la — pela mesma porta por onde
`GET /v1/executions` e `GET /v1/sessions` já ficam de fora.

| Método | Rota | Quem chama | O que faz |
|---|---|---|---|
| `POST` | `/v1/runners` | operador | Pareia um runner. `201` na primeira vez — com `token`, a credencial do runner, devolvida uma única vez —, `200` (idempotente) com `token: null` se o `id` já existe. |
| `GET` | `/v1/runners` | operador | Lista a frota com a saúde de cada runner: `leases_ativas`, `ultimo_heartbeat` (o maior `heartbeat_em` de **qualquer** lease que ele já teve) e `ultima_expiracao` (`{trabalho_id, expira_em, motivo_expiracao}` da última que venceu, ou `null`). Tudo derivado da tabela `lease`; não existe ping de runner. |
| `POST` | `/v1/runners/:id/revocations` | operador | Revoga toda credencial viva daquele runner. `200 {revogadas: <quantas>}`, inclusive `0`: chamar de novo não é erro. |
| `POST` | `/v1/leases` | runner ou operador | Reivindica expiradas e tenta conceder. `201` com a lease, ou `200` com `{lease: null, motivo}`. |
| `POST` | `/v1/leases/:id/heartbeats` | runner ou operador | Renova o prazo. Corpo opcional `{ttl_segundos}`; sem ele, mantém o TTL da lease. |
| `POST` | `/v1/leases/:id/releases` | runner ou operador | Encerra a lease e devolve a vaga na hora. |
| `GET` | `/v1/leases` | runner ou operador | Lista, com filtros `projeto_id`, `runner_id` e `status`. Sem paginação nesta fase. |

### O escopo da credencial de runner

A credencial nasce em `POST /v1/runners` (`201`), no formato do token de
bootstrap: 32 bytes aleatórios em hex, devolvidos uma vez, guardados só como
digest SHA-256. Ela é recusada com `403 credencial_fora_de_escopo` em duas
situações, e a diferença entre elas importa:

- **Fora da lista de rotas** — a lista é literal, em
  [`auth.ts`](../../packages/core/src/auth.ts), e vale para todo o resto da
  `/v1`: propostas, importação de skill, mutação de grafo, o stream de eventos.
  Rota nova não entra por prefixo; entra porque alguém a escreveu ali.
- **Fora da própria identidade** — dentro daquelas rotas, a credencial vale por
  **um** `runner_id`. Pedir lease para outro runner, bater heartbeat ou liberar
  a lease de outro, ou listar as leases de outro, são `403`. `GET /v1/leases`
  sem filtro é preenchido em silêncio com o runner da credencial; com o filtro
  apontando para outro, é recusado.

Revogar (`POST /v1/runners/:id/revocations`) carimba `revogada_em` e nada mais:
o token morto cai no `401 credencial_invalida` já na requisição seguinte, junto
com os tokens que nunca existiram. Não há reemissão sob o mesmo `id` — recuperar
o acesso de um runner revogado é pareá-lo com um `id` novo.

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
| `runner_id` não pareado (pedido de lease ou revogação) | `404` | `runner_desconhecido` |
| Lease inexistente | `404` | `lease_desconhecida` |
| Credencial de runner fora das rotas dela, ou agindo por outro runner | `403` | `credencial_fora_de_escopo` |
| Heartbeat ou liberação sobre lease não `ativa` | `409` | `lease_nao_ativa` (com `status`) |

Recusa por teto ou por trabalho já leased **não** aparece nesta tabela: é `200`
com `motivo`, pelas razões do §3.

Implementação: [`routes/runners.ts`](../../packages/core/src/routes/runners.ts),
[`routes/leases.ts`](../../packages/core/src/routes/leases.ts),
[`auth.ts`](../../packages/core/src/auth.ts),
[`repositories/runners.ts`](../../packages/core/src/repositories/runners.ts),
[`repositories/leases.ts`](../../packages/core/src/repositories/leases.ts),
[`repositories/credentials.ts`](../../packages/core/src/repositories/credentials.ts),
[`controller/`](../../packages/runner/src/controller). Só `src/db/` toca o driver
do SQLite (D1); repositórios e rotas recebem o banco já aberto.

---

## 6. `trabalho_id` é um inteiro opaco

`POST /v1/leases` **não lê a tabela `trabalho`** e não tem FK para ela. A razão
original foi ordem de build (a tabela era entrega do `t102`, que já aterrissou
na migração `0003`), mas o corte permanece pelo motivo de desenho — a mesma
escolha que o `t102` fez para `grafo_versao_id`. Apertar a FK depois é aditivo, e
cabe à ficha que ligar os dois lados.

A divisão de responsabilidade que isso produz é, aliás, a correta:

- **elegibilidade** (o trabalho está bloqueado? em que nó está?) é decidida por
  `GET /v1/trabalhos`, consultada pelo controller **antes** de pedir a lease;
- **exclusividade e capacidade** são decididas por `POST /v1/leases`.

---

## 7. O que esta camada ainda não faz

Cada item aqui é escopo declarado de outra ticket, não esquecimento:

- **Emissão dos eventos** [`lease.concedida`](../../especificacoes/eventos/schemas/lease.concedida.schema.json)
  e [`lease.expirada`](../../especificacoes/eventos/schemas/lease.expirada.schema.json) —
  a tabela `evento` de que dependem já existe (`t102`, migração `0003`) e nada
  aqui escreve nela. As colunas já carregam tudo que os dois eventos pedem (`runner_id`, `trabalho_id`, `expira_em`, `motivo_expiracao`);
  ligar a emissão é mapeamento direto. **Atenção de quem for ligar:** a
  taxonomia do `t98` tem `lease.concedida` e `lease.expirada`, e nenhum evento
  para a liberação — o reducer de referência
  ([`reconstruir-estado.mjs`](../../especificacoes/eventos/reducers/reconstruir-estado.mjs))
  projeta `leases` só com `ativa`/`expirada`. A tabela tem três estados, então
  ou a taxonomia ganha um `lease.liberada`, ou a projeção por eventos fica
  cega para o encerramento normal — que é o caso mais comum de todos. A
  decisão é de quem ligar a emissão; esta ficha não mexe na taxonomia.
- **Abrir sessão de verdade** pelo `EngineAdapter` — `despachar` é callback
  injetado (`t106`/`t109`). **Construído pela `t106`:**
  [`createClaudeCodeDispatch`](../../packages/runner/src/dispatch/dispatch-claude-code.ts)
  é uma implementação desse callback — abre a sessão, grava `sessao.aberta` e
  `sessao.finalizada`, e transforma um pedido de escalação em pergunta pela
  API ([escalacao-humana.md](escalacao-humana.md)). O controller continua sem
  saber que engine existe: nada neste arquivo mudou para isso acontecer, que
  era o ponto da costura. **Fechado pela `t161`:** a instrução do nó vem do
  grafo registrado, não mais de um literal —
  [`resolve-node.ts`](../../packages/runner/src/dispatch/resolve-node.ts) lê o
  snapshot uma vez por despacho e
  [`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)
  busca a skill pinada, confere o hash (pin que não bate não despacha, D4) e
  renderiza instruções, contrato do nó, checks e permissões para dentro da
  sessão. As **permissões** declaradas pelo manifesto passaram a valer no
  mesmo movimento. O que segue pendente pelo mesmo buraco é o **orçamento
  declarado pela skill**: a `t163` deu à sessão dois cães de guarda (relógio de
  parede e silêncio), com o manifesto declarando `orcamentos` e o runner
  resolvendo pelo menor dos dois
  ([`resolveBudget`](../../packages/runner/src/engine/resolve-budget.ts)), mas
  quem despacha ainda usa o teto do runner — o campo existe no manifesto e
  ninguém o lê para dentro do despacho. É uma linha na mesma costura que a
  `t161` abriu, e cabe à ficha que sentir a dor.
- **Avanço de nó e fim de travessia** — também fechados pela `t161`, e citados
  aqui porque os dois eram lacunas desta camada. Uma sessão que termina limpa e
  não escala faz o próprio POST de transição pela aresta que o grafo manda:
  saída única segue direto, portão com duas ou mais saídas lê o bloco cercado
  `resultado` que a sessão emitiu, e um resultado que não casa com aresta
  nenhuma vira pergunta para gente (`ator.tipo: "sistema"`) em vez de falha. E `listarTrabalhosLiberados` passou a filtrar por `concluido` além de
  `bloqueado`: o campo sai de `GET /v1/jobs` desde a `t152`, derivado do
  `no_atual` contra os `nos_finais` da versão, e sem lê-lo um trabalho que
  pousava no nó final continuava candidato para sempre — o controller o
  redespachava para o mesmo nó a cada tick.
- **Modo local** (avaliar um diretório sem control plane): não tem schema nem
  critério de aceite escrito em lugar nenhum do repo. Revisitar quando houver
  caso de uso concreto.
- **Tabela de configuração de teto** por runner ou por projeto (§5).
- **Varredura de expiradas dissociada do despacho** (§3). O que a `t164` fechou
  aqui não é o gatilho e sim a **visibilidade**: `GET /v1/runners` (§5) e a
  página `/runners` da tela mostram, por runner, quantas leases ele segura,
  quando foi ouvido pela última vez e qual trabalho perdeu para o TTL — e
  [`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
  cobra o ciclo inteiro com um runner que para de bater. Uma rotina que varra
  sem ninguém pedir trabalho continua sendo escopo de outra ficha.
- **Sinal de vida independente da lease.** `ultimo_heartbeat` e
  `ultima_expiracao` saem só da tabela `lease`: um runner pareado que nunca
  pegou trabalho é, para este control plane, indistinguível de um que está
  fora do ar. Um ping de runner é aditivo, e cabe à ficha que sentir a dor.
- **WIP limit por estágio do grafo** — aqui só existe o teto bruto de sessões
  concorrentes.
- **Reemissão de credencial para um `id` já pareado.** A `t143` fechou a
  emissão no pareamento e a revogação (§5), mas só o caminho do `201` emite:
  runner revogado ou que perdeu o token volta pareando um `id` novo. Uma rota de
  rotação é aditiva, e cabe à ficha que sentir a dor na prática.
- **Escopo por projeto ou por nó do grafo.** O escopo da credencial de runner
  para em "esta família de rotas, como este runner". Um runner pareado continua
  podendo disputar trabalho de qualquer `projeto_id` que ele declare.
- **Limite de tentativas** (rate limiting, bloqueio depois de N credenciais
  inválidas ou fora de escopo). Nada nesta camada conta tentativas.
