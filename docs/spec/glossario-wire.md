# The wire glossary: Portuguese → English

The single translation map of the **vocabulary that travels on the wire**: the
API's JSON keys, event type names and envelope keys, proposal operations,
database tables and columns, the screen's routes, CLI flags and the keys of the
validation report.

## What this document is (and what it is not)

This glossary was born **descriptive of the INTENT** — when t213 wrote it, none
of the names in the `becomes` column existed anywhere. It turns descriptive of
the CODE as the children land, and this is where you read how much of it has
turned already.

Who applies it are t213's six child tickets, in D20's own order (glossary →
API/errors → events → operations → database → routes/flags/report → docs and
gate). Each one filters the `surface` column down to the rows that are its own
and renames only those. The reason the glossary comes first is simple: without
it, the six invent five different Englishes for the same term, and the
repository opens (D7) with two vocabularies instead of one.

**Where each surface stands** (updated by the child that lands):

| section | tag | state | landed by |
|---|---|---|---|
| §1.1 to §1.5 | `api` | converged | t226 |
| §1.6, enum values | `api` | converged | t226 on the wire, t227 on the event, t235 in the database |
| §2 | `events` | converged | t227 |
| §3 | `proposal-ops` | converged | t228 |
| §4.1 and §4.2 | `database` | converged | t229 (names), t235 (values) |
| §5.1 to §5.4 | `routes-cli-report` | converged | t230 |
| §1.1 and §1.4 (intake), §1.7, §5.2 (cost), §5.5 | `api`, `routes-cli-report`, `cost-lens` | converged | t255 (the leftovers) |
| §5.6 | `flow-lens` | converged | t264 |
| all of them, in the specifications | — | converged | t231 (docs and gate) |

The third row from the bottom is t255's, which is not a child of t213: it is the
ticket the v2 review opened on finding six leftovers the gates did not catch,
all of them because they were not mapped here. Five became a new row (the intake
item, the screen proxy's codes, the signature header, the cost lens's command
line, the cost lens's candidate); the sixth was about shape and not about
language, and is accounted for in that package's `policy.ts`.

The second from the bottom is t264's, for the same reason one ticket later: t227
had left the FLOW lens's vocabulary in Portuguese on purpose, and that decision
held for as long as no lens had migrated. t255 migrated the sibling (§5.5), and
from there on "it is free JSON, nobody governs it" turned into two languages in
one column. §5.6 is that leftover, found by the first real crossing
(`notas/2026-08-17-first-bets-run.md`, hole 7).

The last row is the child that closes D20: every surface's CODE already had a
gate of its own when it started (one `no-portuguese-wire.test.ts` per package,
plus the event, operation and database gates), and what was missing was the
paper. `packages/core/test/glossario-wire-docs.test.ts` reads §2.1, §5.1 and
§5.2 of this file at run time and refuses any of those spellings inside a
backtick span or a fenced block in the specifications — the prose around them
stays Portuguese, which is what D18 decided.

Four columns of `job` and of `session` that §4.2 does not register are still in
Portuguese (`corpo`, `criterios_de_aceite`, `transcricao_truncada`,
`transcricao_tamanho_original`): closing the hole means adding rows here, and
that is a ticket of its own, not the database child's.

The database speaks English **from the very first migration**, not from a
renaming migration onward: D20 recreates the development databases, so t235
rewrote `0001`–`0018` in place instead of stacking a nineteenth one that would
rename what nobody had recorded yet.

Complement, not substitute, of D18's already existing gate
(`no-portuguese-identifiers.test.ts`): that one looks after code IDENTIFIERS,
and masks exactly what this document maps — the value on the wire.

## How to read the tables

- **`surface`** is the tag of the child ticket the row belongs to: `api`,
  `events`, `proposal-ops`, `database`, `routes-cli-report`. The sixth,
  `cost-lens`, arrived with t255 and is nobody's child: it is the vocabulary the
  cost lens puts on the wire (§5.5), and it exists separately because the gate
  that reads it is that package's and only that one. The seventh, `flow-lens`,
  is the same story for the flow lens (§5.6, t264) — a tag of its own for the
  same reason, with one more on top: the two lenses write into the SAME
  `proposal.evidence`, and a single tag over both would hide that each has its
  own set of keys. A surface may appear in more than one table (`api` is split
  by group, to fit in the head of whoever reads it); what counts is the row's
  tag, not the section's title.
- **`today`** is the Portuguese term as it is written in the code right now.
  **`becomes`** is the English name the rename will use. **`defined in`** is the
  file that defines the term — the child ticket's starting point.
- When a citation names a LINE (`static.ts:75,88`), the line is the one of THAT
  table row's name, not of the block around it: `erro` points at `error:` and
  `mensagem` points at the `message:` right below, even when the two sit in the
  same body. A comma separates independent lines; a hyphen is a block, and one
  line of it writing the name is enough. `glossario-wire.test.ts` resolves the
  citations of the files it lists (the ones t255 wrote, which were born wrong
  for having been copied out of the ticket's text instead of re-read in the
  tree); the other ~139 have no gate yet and have drifted — whoever follows one
  of them checks before trusting it.
- Two spellings of the SAME name (`criado_em` and `criada_em`, one column
  spelled by gender) go on one row, separated by ` / `: it is a single term,
  with a single translation.
- A cell never contains a `|` — sets of values are separated by commas.
- A term already in English gets no row (`id`, `status`, `url`, `hash`,
  `prompt`, `engine`, `working_dir`, `exit_code`, `timeout_seconds`,
  `runner_id`, `snapshot`, `checks`, `tier`, `soundness`). The exception is the
  handful of rows whose `today` equals its `becomes`, which exist to say
  *explicitly* that the name does not change.
- Where the code already exposes an English name for the same concept, the
  glossary reuses that name instead of inventing a second one. That is the case
  of `/v1/jobs` (`packages/core/src/server.ts`), which makes `trabalho` become
  `job` and not `task`; of `node_type: work, gate`
  (`schema/grafo.schema.json`), which makes `papel: fazer, portao` become
  `role: work, gate`; and of `aresta: from, to`
  (`packages/core/src/domain/operations.ts`), which makes `de`/`para` become
  `from`/`to`.

---

## 1. API

The routes are already English (`/v1/jobs`, `/v1/input-requests`,
`/v1/graph-versions`); it is the JSON inside them that is not.

### 1.1 Entity fields

The entity fields the API returns mirror the columns 1:1 — the complete table is
**4.2**, and the API ticket translates by it. What stays here are the ones
t213's inventory cites by name.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `projeto_id` | `project_id` | `packages/core/src/routes/leases.ts`, `packages/core/src/repositories/job.ts` |
| api | `execucao_id` | `execution_id` | `packages/core/src/routes/executions.ts`, `packages/core/src/repositories/job.ts` |
| api | `trabalho_id` | `job_id` | `packages/core/src/routes/leases.ts`, `packages/core/src/repositories/session.ts` |
| api | `grafo_id` | `graph_id` | `packages/core/src/routes/proposals.ts` |
| api | `no_atual` | `current_node_id` | `packages/core/src/repositories/job.ts` |
| api | `titulo` | `title` | `packages/core/src/repositories/job.ts`, `packages/core/src/domain/intake.ts` |
| api | `classe` | `class` | `packages/core/src/routes/graphs.ts`, `packages/core/src/routes/intake.ts` |
| api | `corpo` | `body` | `packages/core/src/domain/intake.ts` |
| api | `criterios_de_aceite` | `acceptance_criteria` | `packages/core/src/domain/intake.ts` |
| api | `campos` | `fields` | `packages/core/src/domain/intake.ts` |
| api | `depende_de` | `depends_on` | `packages/core/src/domain/intake.ts` |

The last four are the intake item's (`DraftItem`), which travels in the body of
`POST /v1/intake` and comes back in `GET /v1/intake/:id`. They arrived with
t255, not with the API child: t226 and t229 treated the item as a third party's
format ("the glossary maps none of them", said the comment), when D20's own text
already said "the API JSON's fields and query parameters". `ref` and `tier` get
no row because they are already English.

### 1.2 Query parameters

`status`, `projeto_id`, `execucao_id`, `trabalho_id` and `classe` are query
parameters too; they become the same names as the rows above and those of 1.6.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `limite` | `limit` | `packages/core/src/routes/input-requests.ts:160` |

### 1.3 Collection and response-envelope keys

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `trabalhos` | `jobs` | `packages/core/src/routes/jobs.ts` |
| api | `sessoes` | `sessions` | `packages/core/src/routes/sessions.ts` |
| api | `perguntas` | `input_requests` | `packages/core/src/routes/input-requests.ts` |
| api | `eventos` | `events` | `packages/core/src/routes/events.ts` |
| api | `grafo` | `graph` | `packages/core/src/routes/graphs.ts` |
| api | `grafos` | `graphs` | `packages/core/src/routes/graphs.ts` |
| api | `grafo_versao` | `graph_version` | `packages/core/src/routes/graphs.ts` |
| api | `versoes` | `versions` | `packages/core/src/routes/graphs.ts` |
| api | `proposta` | `proposal` | `packages/core/src/routes/proposals.ts` |
| api | `propostas` | `proposals` | `packages/core/src/routes/proposals.ts` |
| api | `rascunho` | `draft` | `packages/core/src/routes/intake.ts` |
| api | `rascunhos` | `drafts` | `packages/core/src/routes/intake.ts` |
| api | `motores` | `engines` | `packages/core/src/routes/engines.ts` |
| api | `segredos` | `secrets` | `packages/core/src/routes/hook-secrets.ts` |
| api | `revogadas` | `revoked` | `packages/core/src/routes/hook-secrets.ts` |
| api | `nome` | `name` | `packages/core/src/routes/runners.ts` |
| api | `pedido` | `request` | `packages/core/src/routes/intake.ts` |
| api | `itens` | `items` | `packages/core/src/routes/intake.ts` |
| api | `problemas` | `problems` | `packages/core/src/routes/intake.ts` |
| api | `trabalhos_criados` | `created_jobs` | `packages/core/src/routes/intake.ts` |
| api | `operacoes` | `operations` | `packages/core/src/routes/proposals.ts` |

### 1.4 Error envelope and `erro` codes

There are two envelopes today: `{erro, mensagem}` in the domain routes
(`routes/graphs.ts:72-87`) and `{error, details}` in `routes/common.ts`. D20
orders them to converge; which of the two shapes survives (whether `mensagem`
becomes `message` or folds into `details`) is the API child ticket's decision —
what this glossary settles is that `erro` is `error` and `mensagem` is
`message`, never another word.

The screen has an envelope of its own for the four answers it INVENTS (the
control plane down, a write from another origin, a body too large, and a static
file that does not exist). It is the same envelope — that is what the citation
of `proxy.ts` and of `static.ts` on the first two rows is — and the four codes
it carries arrived with t255, when the v2 review found the screen still
answering `{erro, mensagem}` four tickets after the core had converged.

`codigo`, `mensagem` and `alvo` are also the three keys of every problem in the
intake's item report (`domain/intake.ts`), which travels inside the `400` of
`POST /v1/intake` — the same shape as §5.3's graph report, and the same English.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `erro` | `error` | `packages/core/src/routes/graphs.ts:72-87`, `packages/screen/src/proxy.ts:225-352`, `packages/screen/src/static.ts:75,88` |
| api | `mensagem` | `message` | `packages/core/src/routes/graphs.ts:72-87`, `packages/screen/src/proxy.ts:225-352`, `packages/screen/src/static.ts:76,89` |
| api | `campo` | `field` | `packages/core/src/routes/leases.ts:148` |
| api | `codigo` | `code` | `packages/core/src/domain/intake.ts` |
| api | `alvo` | `target` | `packages/core/src/domain/intake.ts` |
| api | `arquivo_nao_encontrado` | `file_not_found` | `packages/screen/src/static.ts:75,88` |
| api | `base_invalida` | `invalid_base` | `packages/core/src/routes/graphs.ts` |
| api | `bifurcacao_sem_efeito` | `fork_without_effect` | `packages/core/src/routes/graphs.ts` |
| api | `campo_invalido` | `invalid_field` | `packages/core/src/routes/leases.ts`, `packages/core/src/routes/proposals.ts` |
| api | `campo_obrigatorio_ausente` | `missing_required_field` | `packages/core/src/routes/intake.ts` |
| api | `ciclo_de_dependencia` | `dependency_cycle` | `packages/core/src/domain/intake.ts` |
| api | `classe_ja_registrada` | `class_already_registered` | `packages/core/src/routes/graphs.ts` |
| api | `control_plane_indisponivel` | `control_plane_unavailable` | `packages/screen/src/proxy.ts:57` |
| api | `corpo_grande_demais` | `body_too_large` | `packages/screen/src/proxy.ts:63` |
| api | `corpo_invalido` | `invalid_body` | `packages/core/src/routes/leases.ts:148` |
| api | `credencial_ausente` | `missing_credential` | `packages/core/src/auth.ts:43` |
| api | `credencial_fora_de_escopo` | `out_of_scope_credential` | `packages/core/src/auth.ts:49` |
| api | `credencial_invalida` | `invalid_credential` | `packages/core/src/auth.ts:46` |
| api | `dependencia_de_si_mesmo` | `self_dependency` | `packages/core/src/domain/intake.ts` |
| api | `dependencia_desconhecida` | `unknown_dependency` | `packages/core/src/domain/intake.ts` |
| api | `diff_sem_efeito` | `diff_without_effect` | `packages/core/src/routes/proposals.ts` |
| api | `esperado` | `expected` | `packages/core/src/routes/leases.ts:288` |
| api | `execucao_sem_evidencia` | `execution_without_evidence` | `packages/core/src/routes/proposals.ts` |
| api | `filtro_invalido` | `invalid_filter` | `packages/core/src/routes/events.ts` |
| api | `grafo_desconhecido` | `unknown_graph` | `packages/core/src/routes/proposals.ts` |
| api | `grafo_invalido` | `invalid_graph` | `packages/core/src/routes/graphs.ts:138` |
| api | `grafo_sem_versao_corrente` | `graph_without_current_version` | `packages/core/src/routes/graphs.ts` |
| api | `grafo_versao_desconhecida` | `unknown_graph_version` | `packages/core/src/routes/proposals.ts` |
| api | `id_ja_registrado` | `id_already_registered` | `packages/core/src/routes/hook-secrets.ts` |
| api | `id_obrigatorio` | `id_required` | `packages/core/src/routes/hook-secrets.ts` |
| api | `item_invalido` | `invalid_item` | `packages/core/src/domain/intake.ts` |
| api | `itens_invalidos` | `invalid_items` | `packages/core/src/routes/intake.ts` |
| api | `lease_desconhecida` | `unknown_lease` | `packages/core/src/routes/leases.ts:181` |
| api | `lease_nao_ativa` | `lease_not_active` | `packages/core/src/routes/leases.ts` |
| api | `linhagem_nao_base` | `lineage_not_base` | `packages/core/src/routes/graphs.ts` |
| api | `lista_invalida` | `invalid_list` | `packages/core/src/domain/intake.ts` |
| api | `metrica_esperada_invalida` | `invalid_expected_metric` | `packages/core/src/routes/proposals.ts` |
| api | `modelo_invalido` | `invalid_model` | `packages/core/src/routes/engines.ts` |
| api | `modelos_obrigatorio` | `models_required` | `packages/core/src/routes/sessions.ts` |
| api | `motivo_obrigatorio` | `reason_required` | `packages/core/src/routes/proposals.ts:197` |
| api | `motor_invalido` | `invalid_engine` | `packages/core/src/routes/engines.ts` |
| api | `nome_invalido` | `invalid_name` | `packages/core/src/routes/runners.ts` |
| api | `operacao_inaplicavel` | `inapplicable_operation` | `packages/core/src/routes/proposals.ts` |
| api | `operacoes_invalidas` | `invalid_operations` | `packages/core/src/routes/proposals.ts` |
| api | `origem_invalida` | `invalid_source` | `packages/core/src/routes/engines.ts` |
| api | `origem_nao_confiavel` | `untrusted_origin` | `packages/screen/src/proxy.ts:60` |
| api | `origem_proposta_desconhecida` | `unknown_origin_proposal` | `packages/core/src/routes/graphs.ts` |
| api | `origem_proposta_id_invalido` | `invalid_origin_proposal_id` | `packages/core/src/routes/graphs.ts` |
| api | `proposta_desatualizada` | `stale_proposal` | `packages/core/src/routes/proposals.ts` |
| api | `proposta_desconhecida` | `unknown_proposal` | `packages/core/src/routes/proposals.ts` |
| api | `proposta_ja_avaliada` | `proposal_already_reviewed` | `packages/core/src/routes/proposals.ts` |
| api | `proposta_nao_aplicada` | `proposal_not_applied` | `packages/core/src/routes/proposals.ts` |
| api | `proposta_nao_aprovada` | `proposal_not_approved` | `packages/core/src/routes/proposals.ts` |
| api | `proposta_nao_pendente` | `proposal_not_pending` | `packages/core/src/routes/proposals.ts` |
| api | `rascunho_desconhecido` | `unknown_draft` | `packages/core/src/routes/intake.ts` |
| api | `rascunho_nao_pendente` | `draft_not_pending` | `packages/core/src/routes/intake.ts` |
| api | `ref_duplicado` | `duplicate_ref` | `packages/core/src/domain/intake.ts` |
| api | `runner_desconhecido` | `unknown_runner` | `packages/core/src/routes/leases.ts:174` |
| api | `variante_invalida` | `invalid_variant` | `packages/core/src/routes/graphs.ts` |
| api | `versao_alvo_desconhecida` | `unknown_target_version` | `packages/core/src/routes/proposals.ts` |
| api | `versao_sem_efeito` | `version_without_effect` | `packages/core/src/routes/graphs.ts` |

### 1.5 Lease: body fields and refusal

`teto_runner` and `teto_projeto` are a body field AND a value of `motivo` in the
refusal — the same term, one row only, one name only.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `teto_runner` | `runner_cap` | `packages/core/src/routes/leases.ts:148`, `packages/core/src/repositories/leases.ts:243` |
| api | `teto_projeto` | `project_cap` | `packages/core/src/routes/leases.ts:148`, `packages/core/src/repositories/leases.ts:248` |
| api | `ttl_segundos` | `ttl_seconds` | `packages/core/src/routes/leases.ts` |
| api | `motivo` | `reason` | `packages/core/src/repositories/leases.ts:85-86` |
| api | `trabalho_ja_leased` | `job_already_leased` | `packages/core/src/repositories/leases.ts:238` |
| api | `motivo_bloqueio` | `block_reason` | `packages/core/src/repositories/job.ts:87` |

### 1.6 Enum values

Every enum value lives here, once only, even when it also travels on the event
or in the migration's `CHECK` — it is the same vocabulary, and listing it twice
is how you start having two. The `proposta` value of `grafo_versao.origem` uses
1.3's `proposta` row; `manual`, `auto`, `base`, `cli`, `catalog`, `filesystem`,
`wall_clock` and `silence` are already English.

A value is qualified with the key that carries it only when the bare word
already means something else: `pergunta.tipo=pergunta` is the escalation KIND
(question or approval) and becomes `question`, while `pergunta` on its own is
the entity and becomes `input_request` (2.3, 4.1).

`sessao.status = 'aberta'` entered this table with the database child (t235): it
is the only status column with no `CHECK`, which is why nobody had registered it
here — the value is born in migration `0003` and is read back by the route that
closes the session. It becomes `open`, the same vocabulary as the
`session.opened` event and the same pattern as `ativa` → `active`.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `pendente` | `pending` | `packages/core/migrations/0010_proposta_aprovada.sql`, `packages/core/migrations/0006_intake.sql` |
| api | `aprovada` | `approved` | `packages/core/migrations/0010_proposta_aprovada.sql` |
| api | `aplicada` | `applied` | `packages/core/migrations/0010_proposta_aprovada.sql` |
| api | `revertida` | `reverted` | `packages/core/migrations/0010_proposta_aprovada.sql` |
| api | `rejeitada` | `rejected` | `packages/core/migrations/0010_proposta_aprovada.sql` |
| api | `respondida` | `answered` | `packages/core/src/repositories/input-request.ts` |
| api | `ativa` | `active` | `packages/core/migrations/0004_runner_lease.sql` |
| api | `liberada` | `released` | `packages/core/migrations/0004_runner_lease.sql` |
| api | `expirada` | `expired` | `packages/core/migrations/0004_runner_lease.sql` |
| api | `heartbeat_perdido` | `heartbeat_lost` | `packages/core/migrations/0004_runner_lease.sql` |
| api | `expirou` | `ttl_elapsed` | `packages/core/migrations/0004_runner_lease.sql` |
| api | `confirmado` | `confirmed` | `packages/core/migrations/0006_intake.sql` |
| api | `descartado` | `discarded` | `packages/core/migrations/0006_intake.sql` |
| api | `entregue` | `delivered` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| api | `esgotada` | `exhausted` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| api | `pergunta.tipo=pergunta` | `question` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| api | `aprovacao` | `approval` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| api | `usuario` | `user` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql`, `packages/core/migrations/0007_credential.sql` |
| api | `runner` | `runner` | `packages/core/migrations/0007_credential.sql` |
| api | `sintetizador` | `synthesizer` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| api | `variante` | `variant` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| api | `fazer` | `work` | `packages/core/migrations/0005_skill.sql` |
| api | `portao` | `gate` | `packages/core/migrations/0005_skill.sql` |
| api | `aberta` | `open` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql`, `packages/core/src/repositories/session.ts` |
| api | `concluida` | `completed` | `packages/core/src/db/event-validation.ts:246` |
| api | `falhou` | `failed` | `packages/core/src/db/event-validation.ts:246` |
| api | `travada` | `stuck` | `packages/core/src/db/event-validation.ts:246` |
| api | `tempo_esgotado` | `timed_out` | `packages/core/src/db/event-validation.ts:246` |
| api | `pausada_cota` | `quota_paused` | `packages/core/src/db/event-validation.ts:246` |
| api | `retomada_falhou` | `resume_failed` | `packages/core/src/db/event-validation.ts:246` |
| api | `rede` | `network` | `packages/core/src/db/event-validation.ts:268` |
| api | `recomendacao` | `recommendation` | `packages/core/src/db/event-validation.ts:290` |
| api | `resposta_padrao` | `default_answer` | `packages/core/src/db/event-validation.ts:290` |
| api | `precedente` | `precedent` | `packages/core/src/db/event-validation.ts:290` |

### 1.7 Signature header

Not a JSON key: it is the name of the HTTP header every webhook and hook
delivery carries, and the recipe published in `docs/spec/webhooks-events.md` §5
is about it. It fell outside the lists of every D20 child — none of them looked
at a header — and that is how it survived until t255. A header name is
case-insensitive: the specification writes `X-Cartografo-Signature`, the code
writes the same thing in lowercase.

| surface | today | becomes | defined in |
|---|---|---|---|
| api | `x-cartografo-assinatura` | `x-cartografo-signature` | `packages/core/src/webhooks/signature.ts:41` |

---

## 2. Events

The log is append-only and replayable: renaming an event type is rewriting the
history, and D20 settles that by recreating the development databases (there is
no production data). The events child ticket renames the schemas of
`specs/events/schemas/` and the taxonomy along with it.

### 2.1 Type names

| surface | today | becomes | defined in |
|---|---|---|---|
| events | `trabalho.criado` | `job.created` | `packages/core/src/db/event-validation.ts:160` |
| events | `trabalho.transicao` | `job.transitioned` | `packages/core/src/db/event-validation.ts:180` |
| events | `trabalho.bloqueado` | `job.blocked` | `packages/core/src/db/event-validation.ts:184` |
| events | `trabalho.desbloqueado` | `job.unblocked` | `packages/core/src/db/event-validation.ts:188` |
| events | `trabalho.emendado` | `job.amended` | `packages/core/src/db/event-validation.ts:192` |
| events | `trabalho.dependencia_declarada` | `job.dependency_declared` | `packages/core/src/db/event-validation.ts:198` |
| events | `trabalho.gancho_falhou` | `job.hook_failed` | `packages/core/src/db/event-validation.ts:209` |
| events | `sessao.aberta` | `session.opened` | `packages/core/src/db/event-validation.ts:218` |
| events | `sessao.finalizada` | `session.finished` | `packages/core/src/db/event-validation.ts:243` |
| events | `sessao.permissao_negada` | `session.permission_denied` | `packages/core/src/db/event-validation.ts:266` |
| events | `pergunta.criada` | `input_request.created` | `packages/core/src/db/event-validation.ts:273` |
| events | `pergunta.respondida` | `input_request.answered` | `packages/core/src/db/event-validation.ts:290` |
| events | `pergunta.auto_resolvida` | `input_request.auto_resolved` | `packages/core/src/db/event-validation.ts:297` |
| events | `lease.concedida` | `lease.granted` | `especificacoes/eventos/schemas/lease.concedida.schema.json` |
| events | `lease.expirada` | `lease.expired` | `especificacoes/eventos/schemas/lease.expirada.schema.json` |
| events | `grafo_versao.registrada` | `graph_version.registered` | `especificacoes/eventos/schemas/grafo_versao.registrada.schema.json` |
| events | `grafo_versao.aplicada` | `graph_version.applied` | `especificacoes/eventos/schemas/grafo_versao.aplicada.schema.json` |
| events | `grafo_versao.revertida` | `graph_version.reverted` | `especificacoes/eventos/schemas/grafo_versao.revertida.schema.json` |

### 2.2 Envelope keys

`entidade` carries `tipo` and `id`; `ator` carries `tipo` and `ref`. Both `tipo`
sub-keys use the `tipo` row below.

| surface | today | becomes | defined in |
|---|---|---|---|
| events | `tipo` | `type` | `packages/core/src/db/event-validation.ts:57` |
| events | `projeto_id` | `project_id` | `packages/core/src/db/event-validation.ts:58` |
| events | `execucao_id` | `execution_id` | `packages/core/src/db/event-validation.ts:59` |
| events | `entidade` | `entity` | `packages/core/src/db/event-validation.ts:60` |
| events | `ator` | `actor` | `packages/core/src/db/event-validation.ts:61` |
| events | `ocorrido_em` | `occurred_at` | `packages/core/src/db/event-validation.ts:62` |
| events | `dados` | `data` | `packages/core/src/db/event-validation.ts:63` |

### 2.3 Entity and actor types

| surface | today | becomes | defined in |
|---|---|---|---|
| events | `trabalho` | `job` | `packages/core/src/db/event-validation.ts:33` |
| events | `sessao` | `session` | `packages/core/src/db/event-validation.ts:33` |
| events | `pergunta` | `input_request` | `packages/core/src/db/event-validation.ts:33` |
| events | `lease` | `lease` | `packages/core/src/db/event-validation.ts:33` |
| events | `grafo_versao` | `graph_version` | `packages/core/src/db/event-validation.ts:33` |
| events | `usuario` | `user` | `packages/core/src/db/event-validation.ts:36` |
| events | `agente` | `agent` | `packages/core/src/db/event-validation.ts:36` |
| events | `sistema` | `system` | `packages/core/src/db/event-validation.ts:36` |

### 2.4 `dados` keys

Prefixed with `dados.` because a payload key and an envelope key with the same
name are different things (the envelope's `tipo` is the event's type;
`pergunta.criada`'s `dados.tipo` is question or approval). The VALUES of those
fields are in 1.6.

| surface | today | becomes | defined in |
|---|---|---|---|
| events | `dados.titulo` | `title` | `packages/core/src/db/event-validation.ts:163` |
| events | `dados.no_entrada_id` | `entry_node_id` | `packages/core/src/db/event-validation.ts:164` |
| events | `dados.corpo` | `body` | `packages/core/src/db/event-validation.ts:168` |
| events | `dados.criterios_de_aceite` | `acceptance_criteria` | `packages/core/src/db/event-validation.ts:169` |
| events | `dados.campos` | `fields` | `packages/core/src/db/event-validation.ts:174` |
| events | `dados.de_no_id` | `from_node_id` | `packages/core/src/db/event-validation.ts:182` |
| events | `dados.para_no_id` | `to_node_id` | `packages/core/src/db/event-validation.ts:182` |
| events | `dados.motivo` | `reason` | `packages/core/src/db/event-validation.ts:185` |
| events | `dados.campos_alterados` | `changed_fields` | `packages/core/src/db/event-validation.ts:194` |
| events | `dados.depende_de_trabalho_id` | `depends_on_job_id` | `packages/core/src/db/event-validation.ts:200` |
| events | `dados.gancho_id` | `hook_id` | `packages/core/src/db/event-validation.ts:211` |
| events | `dados.no_id` | `node_id` | `packages/core/src/db/event-validation.ts:212` |
| events | `dados.ultimo_erro` | `last_error` | `packages/core/src/db/event-validation.ts:214` |
| events | `dados.trabalho_id` | `job_id` | `packages/core/src/db/event-validation.ts:220` |
| events | `dados.sessao_id` | `session_id` | `packages/core/src/db/event-validation.ts:277` |
| events | `dados.uso` | `usage` | `packages/core/src/db/event-validation.ts:256` |
| events | `dados.modelos` | `models` | `packages/core/src/db/event-validation.ts:263` |
| events | `dados.recurso` | `resource` | `packages/core/src/db/event-validation.ts:268` |
| events | `dados.ferramenta` | `tool` | `packages/core/src/db/event-validation.ts:269` |
| events | `dados.tipo` | `kind` | `packages/core/src/db/event-validation.ts:282` |
| events | `dados.pergunta` | `question` | `packages/core/src/db/event-validation.ts:283` |
| events | `dados.contexto` | `context` | `packages/core/src/db/event-validation.ts:284` |
| events | `dados.opcoes` | `options` | `packages/core/src/db/event-validation.ts:285` |
| events | `dados.recomendacao` | `recommendation` | `packages/core/src/db/event-validation.ts:286` |
| events | `dados.resposta_padrao` | `default_answer` | `packages/core/src/db/event-validation.ts:287` |
| events | `dados.auto_aprovavel` | `auto_approvable` | `packages/core/src/db/event-validation.ts:288` |
| events | `dados.resposta` | `answer` | `packages/core/src/db/event-validation.ts:293` |
| events | `dados.respondido_por` | `answered_by` | `packages/core/src/db/event-validation.ts:294` |
| events | `dados.baseada_em` | `based_on` | `packages/core/src/db/event-validation.ts:300` |
| events | `dados.expira_em` | `expires_at` | `especificacoes/eventos/schemas/lease.concedida.schema.json` |
| events | `dados.grafo_id` | `graph_id` | `especificacoes/eventos/schemas/grafo_versao.registrada.schema.json` |
| events | `dados.versao_pai` | `parent_version` | `especificacoes/eventos/schemas/grafo_versao.registrada.schema.json` |
| events | `dados.origem` | `source` | `especificacoes/eventos/schemas/grafo_versao.registrada.schema.json` |
| events | `dados.proposta_id` | `proposal_id` | `especificacoes/eventos/schemas/grafo_versao.aplicada.schema.json` |
| events | `dados.versao_alvo` | `target_version` | `especificacoes/eventos/schemas/grafo_versao.revertida.schema.json` |

---

## 3. Proposal operations

What the operation CARRIES has been English since t178 (`no` is a node of the
document, and the document has `id`, `role`, `node_type`; `aresta` has `from`,
`to`, `condition`). What is still Portuguese is the operation itself: its type
name, its keys and the validation report. `de`/`para` become `from`/`to`
precisely because the document's edge already calls them that — two formats that
meet start speaking one language.

### 3.1 Operation names

| surface | today | becomes | defined in |
|---|---|---|---|
| proposal-ops | `adicionar_no` | `add_node` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `remover_no` | `remove_node` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `adicionar_aresta` | `add_edge` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `remover_aresta` | `remove_edge` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `alterar_campo_no` | `change_node_field` | `packages/core/src/domain/operations.ts:170` |

### 3.2 Operation keys

| surface | today | becomes | defined in |
|---|---|---|---|
| proposal-ops | `tipo` | `type` | `packages/core/src/domain/operations.ts:112` |
| proposal-ops | `no` | `node` | `packages/core/src/domain/operations.ts:113` |
| proposal-ops | `no_id` | `node_id` | `packages/core/src/domain/operations.ts:118` |
| proposal-ops | `aresta` | `edge` | `packages/core/src/domain/operations.ts:123` |
| proposal-ops | `campo` | `field` | `packages/core/src/domain/operations.ts:135` |
| proposal-ops | `de` | `from` | `packages/core/src/domain/operations.ts:136` |
| proposal-ops | `para` | `to` | `packages/core/src/domain/operations.ts:137` |
| proposal-ops | `inversa` | `inverse` | `packages/core/src/domain/operations.ts:143` |
| proposal-ops | `condicao` | `condition` | `packages/core/src/domain/operations.ts:530` |

### 3.3 Operation validation report and codes

| surface | today | becomes | defined in |
|---|---|---|---|
| proposal-ops | `valido` | `valid` | `packages/core/src/domain/operations.ts:196` |
| proposal-ops | `erros` | `errors` | `packages/core/src/domain/operations.ts:197` |
| proposal-ops | `codigo` | `code` | `packages/core/src/domain/operations.ts:191` |
| proposal-ops | `mensagem` | `message` | `packages/core/src/domain/operations.ts:192` |
| proposal-ops | `operacao_invalida` | `invalid_operation` | `packages/core/src/domain/operations.ts:222` |
| proposal-ops | `tipo_desconhecido` | `unknown_type` | `packages/core/src/domain/operations.ts:228` |
| proposal-ops | `inversa_ausente` | `missing_inverse` | `packages/core/src/domain/operations.ts:239` |
| proposal-ops | `inversa_invalida` | `invalid_inverse` | `packages/core/src/domain/operations.ts:243` |
| proposal-ops | `inversa_incompativel` | `incompatible_inverse` | `packages/core/src/domain/operations.ts:247` |
| proposal-ops | `campo_invalido` | `invalid_field` | `packages/core/src/domain/operations.ts:266` |
| proposal-ops | `campo_nao_alteravel` | `field_not_changeable` | `packages/core/src/domain/operations.ts:311` |
| proposal-ops | `campo_obrigatorio_ausente` | `missing_required_field` | `packages/core/src/domain/operations.ts:318` |
| proposal-ops | `no_duplicado` | `duplicate_node` | `packages/core/src/domain/operations.ts:492` |
| proposal-ops | `no_inexistente` | `unknown_node` | `packages/core/src/domain/operations.ts:503` |
| proposal-ops | `aresta_inexistente` | `unknown_edge` | `packages/core/src/domain/operations.ts:528` |

---

## 4. Database

A table name and a column name are the most expensive surface to rename and the
cheapest to decide: D20 already settled that the development databases are
recreated, and with no production data the migration is an ordinary migration.

### 4.1 Tables

| surface | today | becomes | defined in |
|---|---|---|---|
| database | `grafo` | `graph` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `grafo_versao` | `graph_version` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `proposta` | `proposal` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `evento` | `event` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `trabalho` | `job` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `sessao` | `session` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `pergunta` | `input_request` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `runner` | `runner` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `lease` | `lease` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `skill` | `skill` | `packages/core/migrations/0005_skill.sql` |
| database | `trabalho_dependencia` | `job_dependency` | `packages/core/migrations/0006_intake.sql` |
| database | `intake_rascunho` | `intake_draft` | `packages/core/migrations/0006_intake.sql` |
| database | `credencial` | `credential` | `packages/core/migrations/0007_credential.sql` |
| database | `assinatura_webhook` | `webhook_subscription` | `packages/core/migrations/0008_webhook.sql` |
| database | `entrega_webhook` | `webhook_delivery` | `packages/core/migrations/0008_webhook.sql` |
| database | `motor_modelo` | `engine_model` | `packages/core/migrations/0012_motor_modelo.sql` |
| database | `entrega_gancho` | `hook_delivery` | `packages/core/migrations/0016_gancho.sql` |
| database | `segredo_gancho` | `hook_secret` | `packages/core/migrations/0018_segredo_gancho.sql` |

### 4.2 Columns

One row per distinct column name, not per table-column pair: `projeto_id` is the
same name in the six tables it appears in, and one row per table would be six
opportunities to diverge. When the SAME name means different things in different
tables, then the row is qualified (`evento.tipo` is the event's type;
`pergunta.tipo` is question or approval; `credencial.tipo` is whose the
credential is). The indexes inherit the column's name.

| surface | today | becomes | defined in |
|---|---|---|---|
| database | `criado_em` / `criada_em` | `created_at` | `packages/core/migrations/0002_grafo_versao_proposta.sql`, `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `atualizado_em` | `updated_at` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `classe` | `class` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `linhagem_tipo` | `lineage_type` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `base_classe` | `base_class` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `origem_proposta_id` | `origin_proposal_id` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `versao_corrente_id` | `current_version_id` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `grafo_id` | `graph_id` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `versao_pai` | `parent_version` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `origem` | `source` | `packages/core/migrations/0002_grafo_versao_proposta.sql`, `packages/core/migrations/0005_skill.sql` |
| database | `proposta_id` | `proposal_id` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `versao_alvo` | `target_version` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `operacoes` | `operations` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `evidencia` | `evidence` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `metrica_esperada` | `expected_metric` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `versao_aplicada_id` | `applied_version_id` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `motivo_reversao` | `revert_reason` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `motivo_rejeicao` | `rejection_reason` | `packages/core/migrations/0010_proposta_aprovada.sql` |
| database | `resultado` | `result` | `packages/core/migrations/0002_grafo_versao_proposta.sql` |
| database | `evento.tipo` | `type` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `projeto_id` | `project_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `execucao_id` | `execution_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `entidade_tipo` | `entity_type` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `entidade_id` | `entity_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `ator_tipo` | `actor_type` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `ator_ref` | `actor_ref` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `ocorrido_em` | `occurred_at` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `dados` | `data` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `titulo` | `title` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `no_entrada_id` | `entry_node_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `no_atual` | `current_node_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `bloqueado` | `blocked` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `motivo_bloqueio` | `block_reason` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `grafo_versao_id` | `graph_version_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `campos` | `fields` | `packages/core/migrations/0015_trabalho_campos_customizados.sql` |
| database | `trabalho_id` | `job_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `no_id` | `node_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql`, `packages/core/migrations/0014_pergunta_no_id.sql` |
| database | `uso` | `usage` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `aberta_em` | `opened_at` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `finalizada_em` | `finished_at` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `transcricao` | `transcript` | `packages/core/migrations/0009_sessao_transcricao.sql` |
| database | `modelos` | `models` | `packages/core/migrations/0013_sessao_modelos.sql` |
| database | `sessao_id` | `session_id` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `pergunta.tipo` | `kind` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `pergunta.pergunta` | `question` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `contexto` | `context` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `opcoes` | `options` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `recomendacao` | `recommendation` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `resposta_padrao` | `default_answer` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `auto_aprovavel` | `auto_approvable` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `resposta` | `answer` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `respondido_por` | `answered_by` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `respondida_em` | `answered_at` | `packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql` |
| database | `nome` | `name` | `packages/core/migrations/0004_runner_lease.sql`, `packages/core/migrations/0018_segredo_gancho.sql` |
| database | `registrado_em` | `registered_at` | `packages/core/migrations/0004_runner_lease.sql`, `packages/core/migrations/0005_skill.sql` |
| database | `ttl_segundos` | `ttl_seconds` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `concedida_em` | `granted_at` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `heartbeat_em` | `heartbeat_at` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `expira_em` | `expires_at` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `liberada_em` | `released_at` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `motivo_expiracao` | `expiration_reason` | `packages/core/migrations/0004_runner_lease.sql` |
| database | `versao` | `version` | `packages/core/migrations/0005_skill.sql` |
| database | `papel` | `role` | `packages/core/migrations/0005_skill.sql` |
| database | `descricao` | `description` | `packages/core/migrations/0005_skill.sql` |
| database | `entrada` | `input` | `packages/core/migrations/0005_skill.sql` |
| database | `saida` | `output` | `packages/core/migrations/0005_skill.sql` |
| database | `pre_condicoes` | `preconditions` | `packages/core/migrations/0005_skill.sql` |
| database | `permissoes` | `permissions` | `packages/core/migrations/0005_skill.sql` |
| database | `instrucoes` | `instructions` | `packages/core/migrations/0005_skill.sql` |
| database | `depende_de_trabalho_id` | `depends_on_job_id` | `packages/core/migrations/0006_intake.sql` |
| database | `pedido` | `request` | `packages/core/migrations/0006_intake.sql` |
| database | `itens` | `items` | `packages/core/migrations/0006_intake.sql` |
| database | `trabalhos_criados` | `created_jobs` | `packages/core/migrations/0006_intake.sql` |
| database | `credencial.tipo` | `owner_type` | `packages/core/migrations/0007_credential.sql` |
| database | `revogada_em` | `revoked_at` | `packages/core/migrations/0007_credential.sql`, `packages/core/migrations/0018_segredo_gancho.sql` |
| database | `segredo` | `secret` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `tipos_filtro` | `filter_types` | `packages/core/migrations/0008_webhook.sql` |
| database | `evento_inicial_id` | `initial_event_id` | `packages/core/migrations/0008_webhook.sql` |
| database | `desativada_em` | `deactivated_at` | `packages/core/migrations/0008_webhook.sql` |
| database | `assinatura_id` | `subscription_id` | `packages/core/migrations/0008_webhook.sql` |
| database | `evento_id` | `event_id` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `tentativas` | `attempts` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `proxima_tentativa_em` | `next_attempt_at` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `entregue_em` | `delivered_at` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `ultimo_erro` | `last_error` | `packages/core/migrations/0008_webhook.sql`, `packages/core/migrations/0016_gancho.sql` |
| database | `motor` | `engine` | `packages/core/migrations/0012_motor_modelo.sql` |
| database | `modelo_id` | `model_id` | `packages/core/migrations/0012_motor_modelo.sql` |
| database | `rotulo` | `label` | `packages/core/migrations/0012_motor_modelo.sql` |
| database | `gancho_id` | `hook_id` | `packages/core/migrations/0016_gancho.sql` |
| database | `valor` | `value` | `packages/core/migrations/0018_segredo_gancho.sql` |

---

## 5. Screen routes, CLI flags and report

### 5.1 Screen routes

The screen is a client of the API like any other (D11), so the screen's route
uses the entity name the API already publishes: `/perguntas` becomes
`/input-requests` and not `/questions`, because the API's route is
`/v1/input-requests`.

| surface | today | becomes | defined in |
|---|---|---|---|
| routes-cli-report | `/quadro` | `/board` | `packages/screen/src/router.ts:350` |
| routes-cli-report | `/execucoes` | `/executions` | `packages/screen/src/router.ts:351` |
| routes-cli-report | `/execucoes/:id` | `/executions/:id` | `packages/screen/src/router.ts:355` |
| routes-cli-report | `/perguntas` | `/input-requests` | `packages/screen/src/router.ts:352` |
| routes-cli-report | `/perguntas/:id/resposta` | `/input-requests/:id/answer` | `packages/screen/src/router.ts:373` |
| routes-cli-report | `/trabalhos/:id` | `/jobs/:id` | `packages/screen/src/router.ts:363` |
| routes-cli-report | `/runners` | `/runners` | `packages/screen/src/router.ts:353` |

### 5.2 Command line: subcommands and flags

What a person TYPES, and not only what starts with `--`: a subcommand is as
typed as a flag, and `avaliar` sat one row outside the gate that would have
caught it, because t230's reading filtered by `--`.

`cost-surveyor`'s six rows arrived with t255. Three of them (`--execucao`,
`--teto-tokens`, `--teto-segundos`) t230 had already renamed in the code, but
left in a local array of that package's test instead of here, and the other
three it declared outside its own scope. Neither of those was a decision: D20
says "CLI flags" with no exception. The spelling comes from the rows already
applied for the same words — `execucao_id` → `execution_id` (§1.1),
`teto_runner` → `runner_cap` (§1.5) — and was not invented here.

| surface | today | becomes | defined in |
|---|---|---|---|
| routes-cli-report | `--classe` | `--class` | `packages/runner/src/synthesizer/synthesize.ts:139`, `packages/runner/src/intake/command-line.ts:49` |
| routes-cli-report | `--saida` | `--out` | `packages/runner/src/synthesizer/synthesize.ts:149` |
| routes-cli-report | `avaliar` | `evaluate` | `packages/cost-surveyor/src/cli.ts` |
| routes-cli-report | `--execucao` | `--execution` | `packages/cost-surveyor/src/cli.ts` |
| routes-cli-report | `--teto-tokens` | `--token-cap` | `packages/cost-surveyor/src/cli.ts` |
| routes-cli-report | `--teto-segundos` | `--second-cap` | `packages/cost-surveyor/src/cli.ts` |
| routes-cli-report | `--tier-fator` | `--tier-factor` | `packages/cost-surveyor/src/cli.ts` |
| routes-cli-report | `--tier-minimo-nos` | `--tier-min-nodes` | `packages/cost-surveyor/src/cli.ts` |

### 5.3 Graph validation report keys

The report has two implementations that have to stay identical — the control
plane's (`packages/core/src/domain/graph.ts`) and the reference one
(`scripts/validate-graph.mjs`), compared line by line by
`packages/core/test/domain-graph.test.ts`. The child ticket renames both in the
same delivery, or the parity test falls.

| surface | today | becomes | defined in |
|---|---|---|---|
| routes-cli-report | `estrutura` | `structure` | `packages/core/src/domain/graph.ts:189` |
| routes-cli-report | `soundness` | `soundness` | `packages/core/src/domain/graph.ts:190` |
| routes-cli-report | `valido` | `valid` | `packages/core/src/domain/graph.ts:178` |
| routes-cli-report | `erros` | `errors` | `packages/core/src/domain/graph.ts:178` |
| routes-cli-report | `violacoes` | `violations` | `packages/core/src/domain/graph.ts:183` |
| routes-cli-report | `codigo` | `code` | `packages/core/src/domain/graph.ts:165` |
| routes-cli-report | `mensagem` | `message` | `packages/core/src/domain/graph.ts:166` |
| routes-cli-report | `alvo` | `target` | `packages/core/src/domain/graph.ts:167` |
| routes-cli-report | `regra` | `rule` | `packages/core/src/domain/graph.ts:172` |

### 5.4 Soundness rules and structure codes

`no_inalcancavel` is not the name of a rule in the code — the rule is called
`alcançável` and the violation is annotated with that name. The term appears as
the name of the example that exercises it
(`schema/exemplos/grafo-invalido-no-inalcancavel.json`) and is here because
t213's inventory cites it: the example file is renamed along with it.

| surface | today | becomes | defined in |
|---|---|---|---|
| routes-cli-report | `alcançável` | `reachable` | `packages/core/src/domain/graph.ts:40` |
| routes-cli-report | `termina` | `terminates` | `packages/core/src/domain/graph.ts:41` |
| routes-cli-report | `aresta_com_condicao` | `edge_with_condition` | `packages/core/src/domain/graph.ts:42` |
| routes-cli-report | `no_com_contrato` | `node_with_contract` | `packages/core/src/domain/graph.ts:43` |
| routes-cli-report | `no_inalcancavel` | `unreachable_node` | `schema/exemplos/grafo-invalido-no-inalcancavel.json` |
| routes-cli-report | `documento_invalido` | `invalid_document` | `packages/core/src/domain/graph.ts:232` |
| routes-cli-report | `no_invalido` | `invalid_node` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `id_no_duplicado` | `duplicate_node_id` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `id_invalido` | `invalid_id` | `packages/core/src/domain/graph.ts:424` |
| routes-cli-report | `aresta_invalida` | `invalid_edge` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `aresta_no_inexistente` | `edge_unknown_node` | `scripts/validate-graph.mjs` |
| routes-cli-report | `no_inicial_inexistente` | `unknown_initial_node` | `scripts/validate-graph.mjs` |
| routes-cli-report | `no_final_inexistente` | `unknown_final_node` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `campo_invalido` | `invalid_field` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `campo_obrigatorio_ausente` | `missing_required_field` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `gancho_invalido` | `invalid_hook` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `id_gancho_duplicado` | `duplicate_hook_id` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `gancho_no_inexistente` | `hook_unknown_node` | `packages/core/src/domain/graph.ts:437` |

### 5.5 Cost lens candidate and evidence

What `cost-surveyor` PUTS on the wire: the keys of the candidate and of the
evidence that travel inside `POST /v1/proposals`. A tag of its own (`cost-lens`)
because it is not a screen route, not a flag and not the graph report — it is
one lens's vocabulary, and that package's gate is the only one that needs to
read it.

Two things are NOT here, and for different reasons. `tokens_total` is already
English. And the CONTENT of `metrica_esperada` stays
`{nome, direcao, de, para}`: it is `domain/hypothesis.ts`'s hypothesis format,
frozen, and it is exactly what t255 started emitting — the key travels in
English, what it carries does not travel at all.

`IdentifiedCostRow` (`cost.ts`) is not here either: it is the layer `policy.ts`
READS from, never serialized, and masking a read of a lower layer is the same
convention as the core's gate.

| surface | today | becomes | defined in |
|---|---|---|---|
| cost-lens | `lente` | `lens` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `custo` | `cost` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `no_id` | `node_id` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `grafo_versao_id` | `graph_version_id` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `tempo_total_segundos` | `total_seconds` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `sessoes_com_uso` | `sessions_with_usage` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `sessoes_sem_uso` | `sessions_without_usage` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `teto_excedido` | `ceiling_exceeded` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `tipo` | `type` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `teto` | `ceiling` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `tempo` | `time` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `operacoes` | `operations` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `evidencia` | `evidence` | `packages/cost-surveyor/src/policy.ts` |
| cost-lens | `metrica_esperada` | `expected_metric` | `packages/cost-surveyor/src/policy.ts` |

### 5.6 Flow lens evidence and measures

What the FLOW surveyor puts on the wire: the keys of `evidence` and the measure
names `expected_metric.nome` carries, both inside `POST /v1/proposals`. A tag of
its own (`flow-lens`) for §5.5's reason — it is one lens's vocabulary, read by
one package's gate alone — and because the two lenses write into the same field
with different key sets.

t227 left these in Portuguese **on purpose**, and wrote so in `metrics.ts`'s
header: they were free JSON (D15), no glossary row governed them, and no sibling
lens had migrated. t255 migrated the sibling, and from there on the choice
stopped being "not yet" and became "two languages in one column". t264 is what
closes it, and the first real crossing is what found it
(`notas/2026-08-17-first-bets-run.md`, hole 7).

Three things are NOT here, each for a reason of its own:

- **`total_ms` and `lens` are already English.** Nothing to map.
- **`fonte` stays.** [`surveyor-flow.md` §4](surveyor-flow.md) already
  records that it is the provenance the module declares, distinct from the
  `lens` the server reads to deduplicate. Renaming it would be reverting a
  recorded decision, not leaving one unrecorded.
- **The CONTENT of `metrica_esperada` stays `{nome, direcao, de, para}`** —
  `domain/hypothesis.ts`'s frozen hypothesis format, exactly as §5.5 says. What
  §5.6 changes is the VALUE of `nome`, which is `"<measure>:<node_id>"`: the
  measures below are the spellings it goes on to compose.

`gargalo`, `evidencia`, `metrica_esperada` and `proposta` as keys of
`SurveyorResult` are not here either: that is the runner's internal return
value, read by `cli.mjs` and by `packages/surveyor`, never serialized — the
same convention that leaves `IdentifiedCostRow` out of §5.5.

`evidencia.eventos` appears qualified because `eventos` is already `events` in
§1.1, and here the list is not of events: it is of their ids. The same rule that
separates `evento.tipo` from `pergunta.tipo` in §4.2.

| surface | today | becomes | defined in |
|---|---|---|---|
| flow-lens | `no_id` | `node_id` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `execucao_id` | `execution_id` | `packages/runner/src/surveyor/proposal.ts` |
| flow-lens | `grafo_versao_id` | `graph_version_id` | `packages/runner/src/surveyor/proposal.ts` |
| flow-lens | `tempo_agente_ms` | `agent_ms` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `tempo_espera_ms` | `blocked_ms` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `tempo_fila_ms` | `queue_ms` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `perguntas` | `input_requests` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `evidencia.eventos` | `event_ids` | `packages/runner/src/surveyor/metrics.ts` |
| flow-lens | `por_no` | `by_node` | `packages/runner/src/surveyor/metrics.ts` |

---

## What this glossary does not decide

- **How to migrate.** Recreating a development database is D20's decision; the
  step by step (migration, order, what to do with an already exported factory
  bundle) belongs to the database child ticket.
- **The error envelope's final shape.** See 1.4.
- **Whether `no-portuguese-wire.test.ts` exists.** Extending D18's gates to
  cover the value on the wire is the last child ticket (docs and gate), once
  there is an English wire to check.
- **The brand and the frozen data.** `cartografo` is still `cartografo`. This
  document is written in English from D24 on, and the only Portuguese left in it
  is that brand name, the `today`/`becomes` pairs of every table — a map of
  retired names is written in retired names — and any path it cites that is
  itself still Portuguese, waiting on its own renaming ticket (t282 for the
  folders, D24's sibling tickets for the other documents).
