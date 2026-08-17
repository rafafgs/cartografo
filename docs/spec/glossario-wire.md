# Glossário do fio: português → inglês

Mapa único de tradução do **vocabulário que viaja no fio**: chaves de JSON da
API, nomes de tipo e chaves de evento, operações de proposta, tabelas e colunas
do banco, rotas da tela, flags de CLI e as chaves do relatório de validação.

## O que este documento é (e o que não é)

Este glossário nasceu **descritivo da INTENÇÃO** — quando o t213 o escreveu,
nenhum dos nomes da coluna "vira" existia em lugar nenhum. Ele vai virando
descritivo do CÓDIGO à medida que os filhos aterrissam, e é aqui que se lê
quanto já virou.

Quem aplica são os seis tickets filhos do t213, na ordem da D20 (glossário →
API/erros → eventos → operações → banco → rotas/flags/relatório → docs e
portão). Cada um filtra a coluna `superfície` pelas linhas que lhe cabem e
renomeia só aquilo. A razão de o glossário vir primeiro é simples: sem ele, os
seis inventam cinco inglêses diferentes para o mesmo termo, e o repositório
abre (D7) com dois vocabulários em vez de um.

**Onde cada superfície está** (atualizado pelo filho que aterrissa):

| seção | etiqueta | estado | quem levou |
|---|---|---|---|
| §1.1 a §1.5 | `api` | convergida | t226 |
| §1.6, valores de enum | `api` | convergida | t226 no fio, t227 no evento, t235 no banco |
| §2 | `events` | convergida | t227 |
| §3 | `proposal-ops` | convergida | t228 |
| §4.1 e §4.2 | `database` | convergida | t229 (nomes), t235 (valores) |
| §5 | `routes-cli-report` | pendente | t230 |

Quatro colunas de `job` e de `session` que a §4.2 não registra continuam em
português (`corpo`, `criterios_de_aceite`, `transcricao_truncada`,
`transcricao_tamanho_original`): fechar o buraco é acrescentar linha aqui, e é
trabalho de ficha própria, não do filho do banco.

O banco fala inglês **desde a primeira migração**, e não a partir de uma
migração de renomeação: a D20 recria os bancos de desenvolvimento, então o
t235 reescreveu `0001`–`0018` no lugar em vez de empilhar uma dezenove-ésima
que renomeasse o que ninguém tinha gravado ainda.

Complemento, não substituto, do portão da D18 já existente
(`no-portuguese-identifiers.test.ts`): aquele cuida de IDENTIFICADORES de
código, e mascara exatamente o que este documento mapeia — o valor no fio.

## Como ler as tabelas

- **`superfície`** é a etiqueta do ticket filho a que a linha pertence: `api`,
  `events`, `proposal-ops`, `database`, `routes-cli-report`. Uma superfície pode
  aparecer em mais de uma tabela (a `api` está dividida por grupo, para caber na
  cabeça de quem lê); o que vale é a etiqueta da linha, não o título da seção.
- **`hoje`** é o termo em português como ele está escrito no código agora.
  **`vira`** é o nome em inglês que a renomeação vai usar. **`onde está hoje`**
  é o arquivo que define o termo — o ponto de partida do ticket filho.
- Duas grafias do MESMO nome (`criado_em` e `criada_em`, uma coluna escrita por
  gênero) vão na mesma linha, separadas por ` / `: é um termo só, com uma
  tradução só.
- Uma célula nunca contém `|` — conjuntos de valores são separados por vírgula.
- Termo que já está em inglês não vira linha (`id`, `status`, `url`, `hash`,
  `prompt`, `engine`, `working_dir`, `exit_code`, `timeout_seconds`,
  `runner_id`, `snapshot`, `checks`, `tier`, `soundness`). A exceção é o punhado
  de linhas com `hoje` igual a `vira`, que existem para dizer *explicitamente*
  que aquele nome não muda.
- Onde o código já expõe um nome em inglês para o mesmo conceito, o glossário
  reusa esse nome em vez de inventar um segundo. É o caso de `/v1/jobs`
  (`packages/core/src/server.ts`), que faz `trabalho` virar `job` e não `task`;
  de `node_type: work, gate` (`schema/grafo.schema.json`), que faz `papel: fazer,
  portao` virar `role: work, gate`; e de `aresta: from, to`
  (`packages/core/src/domain/operations.ts`), que faz `de`/`para` virarem
  `from`/`to`.

---

## 1. API

Rotas já são inglês (`/v1/jobs`, `/v1/input-requests`, `/v1/graph-versions`); o
JSON dentro delas é que não é.

### 1.1 Campos de entidade

Os campos de entidade que a API devolve espelham 1:1 as colunas — a tabela
completa é a **4.2**, e o ticket da API traduz por ela. Ficam aqui os que o
inventário do t213 cita por nome.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| api | `projeto_id` | `project_id` | `packages/core/src/routes/leases.ts`, `packages/core/src/repositories/job.ts` |
| api | `execucao_id` | `execution_id` | `packages/core/src/routes/executions.ts`, `packages/core/src/repositories/job.ts` |
| api | `trabalho_id` | `job_id` | `packages/core/src/routes/leases.ts`, `packages/core/src/repositories/session.ts` |
| api | `grafo_id` | `graph_id` | `packages/core/src/routes/proposals.ts` |
| api | `no_atual` | `current_node_id` | `packages/core/src/repositories/job.ts` |
| api | `titulo` | `title` | `packages/core/src/repositories/job.ts` |
| api | `classe` | `class` | `packages/core/src/routes/graphs.ts`, `packages/core/src/routes/intake.ts` |

### 1.2 Parâmetros de consulta

`status`, `projeto_id`, `execucao_id`, `trabalho_id` e `classe` também são
parâmetros de consulta; viram o mesmo nome das linhas acima e da 1.6.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| api | `limite` | `limit` | `packages/core/src/routes/input-requests.ts:160` |

### 1.3 Chaves de coleção e de envelope de resposta

| superfície | hoje | vira | onde está hoje |
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

### 1.4 Envelope de erro e códigos de `erro`

Há dois envelopes hoje: `{erro, mensagem}` nas rotas de domínio
(`routes/graphs.ts:72-87`) e `{error, details}` em `routes/common.ts`. A D20
manda convergirem; qual das duas formas sobrevive (se `mensagem` vira `message`
ou se dobra em `details`) é decisão do ticket filho da API — o que este
glossário fixa é que `erro` é `error` e `mensagem` é `message`, nunca outra
palavra.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| api | `erro` | `error` | `packages/core/src/routes/graphs.ts:72-87` |
| api | `mensagem` | `message` | `packages/core/src/routes/graphs.ts:72-87` |
| api | `campo` | `field` | `packages/core/src/routes/leases.ts:148` |
| api | `base_invalida` | `invalid_base` | `packages/core/src/routes/graphs.ts` |
| api | `bifurcacao_sem_efeito` | `fork_without_effect` | `packages/core/src/routes/graphs.ts` |
| api | `campo_invalido` | `invalid_field` | `packages/core/src/routes/leases.ts`, `packages/core/src/routes/proposals.ts` |
| api | `campo_obrigatorio_ausente` | `missing_required_field` | `packages/core/src/routes/intake.ts` |
| api | `classe_ja_registrada` | `class_already_registered` | `packages/core/src/routes/graphs.ts` |
| api | `corpo_invalido` | `invalid_body` | `packages/core/src/routes/leases.ts:148` |
| api | `credencial_ausente` | `missing_credential` | `packages/core/src/auth.ts:43` |
| api | `credencial_fora_de_escopo` | `out_of_scope_credential` | `packages/core/src/auth.ts:49` |
| api | `credencial_invalida` | `invalid_credential` | `packages/core/src/auth.ts:46` |
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
| api | `itens_invalidos` | `invalid_items` | `packages/core/src/routes/intake.ts` |
| api | `lease_desconhecida` | `unknown_lease` | `packages/core/src/routes/leases.ts:181` |
| api | `lease_nao_ativa` | `lease_not_active` | `packages/core/src/routes/leases.ts` |
| api | `linhagem_nao_base` | `lineage_not_base` | `packages/core/src/routes/graphs.ts` |
| api | `metrica_esperada_invalida` | `invalid_expected_metric` | `packages/core/src/routes/proposals.ts` |
| api | `modelo_invalido` | `invalid_model` | `packages/core/src/routes/engines.ts` |
| api | `modelos_obrigatorio` | `models_required` | `packages/core/src/routes/sessions.ts` |
| api | `motivo_obrigatorio` | `reason_required` | `packages/core/src/routes/proposals.ts:197` |
| api | `motor_invalido` | `invalid_engine` | `packages/core/src/routes/engines.ts` |
| api | `nome_invalido` | `invalid_name` | `packages/core/src/routes/runners.ts` |
| api | `operacao_inaplicavel` | `inapplicable_operation` | `packages/core/src/routes/proposals.ts` |
| api | `operacoes_invalidas` | `invalid_operations` | `packages/core/src/routes/proposals.ts` |
| api | `origem_invalida` | `invalid_source` | `packages/core/src/routes/engines.ts` |
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
| api | `runner_desconhecido` | `unknown_runner` | `packages/core/src/routes/leases.ts:174` |
| api | `variante_invalida` | `invalid_variant` | `packages/core/src/routes/graphs.ts` |
| api | `versao_alvo_desconhecida` | `unknown_target_version` | `packages/core/src/routes/proposals.ts` |
| api | `versao_sem_efeito` | `version_without_effect` | `packages/core/src/routes/graphs.ts` |

### 1.5 Lease: campos do corpo e recusa

`teto_runner` e `teto_projeto` são campo do corpo E valor de `motivo` na
recusa — mesmo termo, uma linha só, um nome só.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| api | `teto_runner` | `runner_cap` | `packages/core/src/routes/leases.ts:148`, `packages/core/src/repositories/leases.ts:243` |
| api | `teto_projeto` | `project_cap` | `packages/core/src/routes/leases.ts:148`, `packages/core/src/repositories/leases.ts:248` |
| api | `ttl_segundos` | `ttl_seconds` | `packages/core/src/routes/leases.ts` |
| api | `motivo` | `reason` | `packages/core/src/repositories/leases.ts:85-86` |
| api | `trabalho_ja_leased` | `job_already_leased` | `packages/core/src/repositories/leases.ts:238` |
| api | `motivo_bloqueio` | `block_reason` | `packages/core/src/repositories/job.ts:87` |

### 1.6 Valores de enum

Todo valor de enum mora aqui, uma vez só, mesmo quando viaja também no evento ou
no `CHECK` da migração — é o mesmo vocabulário, e listá-lo duas vezes é como se
começa a ter dois. O valor `proposta` de `grafo_versao.origem` usa a linha
`proposta` da 1.3; `manual`, `auto`, `base`, `cli`, `catalog`, `filesystem`,
`wall_clock` e `silence` já estão em inglês.

Um valor só é qualificado com a chave que o carrega quando a palavra solta já
significa outra coisa: `pergunta.tipo=pergunta` é o TIPO de escalação (pergunta
ou aprovação) e vira `question`, enquanto `pergunta` sozinho é a entidade e vira
`input_request` (2.3, 4.1).

`sessao.status = 'aberta'` entrou nesta tabela com o filho do banco (t235): ela
é a única coluna de status sem `CHECK`, e por isso ninguém a tinha registrado
aqui — o valor nasce na migração `0003` e é lido de volta pela rota que fecha a
sessão. Vira `open`, o mesmo vocabulário do evento `session.opened` e o mesmo
padrão de `ativa` → `active`.

| superfície | hoje | vira | onde está hoje |
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

---

## 2. Eventos

O log é append-only e replayável: renomear tipo de evento é reescrever o
histórico, e a D20 resolve isso recriando os bancos de desenvolvimento (não há
dado de produção). O ticket filho dos eventos renomeia junto os schemas de
`especificacoes/eventos/schemas/` e a taxonomia.

### 2.1 Nomes de tipo

| superfície | hoje | vira | onde está hoje |
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

### 2.2 Chaves do envelope

`entidade` carrega `tipo` e `id`; `ator` carrega `tipo` e `ref`. As duas
sub-chaves `tipo` usam a linha `tipo` abaixo.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| events | `tipo` | `type` | `packages/core/src/db/event-validation.ts:57` |
| events | `projeto_id` | `project_id` | `packages/core/src/db/event-validation.ts:58` |
| events | `execucao_id` | `execution_id` | `packages/core/src/db/event-validation.ts:59` |
| events | `entidade` | `entity` | `packages/core/src/db/event-validation.ts:60` |
| events | `ator` | `actor` | `packages/core/src/db/event-validation.ts:61` |
| events | `ocorrido_em` | `occurred_at` | `packages/core/src/db/event-validation.ts:62` |
| events | `dados` | `data` | `packages/core/src/db/event-validation.ts:63` |

### 2.3 Tipos de entidade e de ator

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| events | `trabalho` | `job` | `packages/core/src/db/event-validation.ts:33` |
| events | `sessao` | `session` | `packages/core/src/db/event-validation.ts:33` |
| events | `pergunta` | `input_request` | `packages/core/src/db/event-validation.ts:33` |
| events | `lease` | `lease` | `packages/core/src/db/event-validation.ts:33` |
| events | `grafo_versao` | `graph_version` | `packages/core/src/db/event-validation.ts:33` |
| events | `usuario` | `user` | `packages/core/src/db/event-validation.ts:36` |
| events | `agente` | `agent` | `packages/core/src/db/event-validation.ts:36` |
| events | `sistema` | `system` | `packages/core/src/db/event-validation.ts:36` |

### 2.4 Chaves de `dados`

Prefixadas com `dados.` porque uma chave de payload e uma chave de envelope com
o mesmo nome são coisas diferentes (`tipo` do envelope é o tipo do evento;
`dados.tipo` de `pergunta.criada` é pergunta ou aprovação). Os VALORES desses
campos estão na 1.6.

| superfície | hoje | vira | onde está hoje |
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

## 3. Operações de proposta

O que a operação CARREGA já é inglês desde a t178 (`no` é um nó do documento, e
o documento tem `id`, `role`, `node_type`; `aresta` tem `from`, `to`,
`condition`). O que continua em português é a operação em si: o nome do tipo,
as chaves dela e o relatório de validação. `de`/`para` viram `from`/`to`
justamente porque a aresta do documento já os chama assim — dois formatos que se
encontram passam a falar a mesma língua.

### 3.1 Nomes de operação

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| proposal-ops | `adicionar_no` | `add_node` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `remover_no` | `remove_node` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `adicionar_aresta` | `add_edge` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `remover_aresta` | `remove_edge` | `packages/core/src/domain/operations.ts:170` |
| proposal-ops | `alterar_campo_no` | `change_node_field` | `packages/core/src/domain/operations.ts:170` |

### 3.2 Chaves da operação

| superfície | hoje | vira | onde está hoje |
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

### 3.3 Relatório e códigos de validação de operação

| superfície | hoje | vira | onde está hoje |
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

## 4. Banco

Nome de tabela e de coluna é a superfície mais cara de renomear e a mais barata
de decidir: a D20 já resolveu que os bancos de desenvolvimento são recriados, e
sem dado de produção a migração é uma migração normal.

### 4.1 Tabelas

| superfície | hoje | vira | onde está hoje |
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

### 4.2 Colunas

Uma linha por nome distinto de coluna, não por par tabela-coluna: `projeto_id` é
o mesmo nome nas seis tabelas em que aparece, e uma linha por tabela seria seis
oportunidades de divergir. Quando o MESMO nome quer dizer coisas diferentes em
tabelas diferentes, aí sim a linha é qualificada (`evento.tipo` é o tipo do
evento; `pergunta.tipo` é pergunta ou aprovação; `credencial.tipo` é de quem é a
credencial). Os índices herdam o nome da coluna.

| superfície | hoje | vira | onde está hoje |
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

## 5. Rotas da tela, flags de CLI e relatório

### 5.1 Rotas da tela

A tela é cliente da API como qualquer outro (D11), então a rota da tela usa o
nome de entidade que a API já publica: `/perguntas` vira `/input-requests` e não
`/questions`, porque a rota da API é `/v1/input-requests`.

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| routes-cli-report | `/quadro` | `/board` | `packages/tela/src/router.ts:350` |
| routes-cli-report | `/execucoes` | `/executions` | `packages/tela/src/router.ts:351` |
| routes-cli-report | `/execucoes/:id` | `/executions/:id` | `packages/tela/src/router.ts:355` |
| routes-cli-report | `/perguntas` | `/input-requests` | `packages/tela/src/router.ts:352` |
| routes-cli-report | `/perguntas/:id/resposta` | `/input-requests/:id/answer` | `packages/tela/src/router.ts:373` |
| routes-cli-report | `/trabalhos/:id` | `/jobs/:id` | `packages/tela/src/router.ts:363` |
| routes-cli-report | `/runners` | `/runners` | `packages/tela/src/router.ts:353` |

### 5.2 Flags de CLI

| superfície | hoje | vira | onde está hoje |
|---|---|---|---|
| routes-cli-report | `--classe` | `--class` | `packages/runner/src/synthesizer/synthesize.ts:139`, `packages/runner/src/intake/command-line.ts:49` |
| routes-cli-report | `--saida` | `--out` | `packages/runner/src/synthesizer/synthesize.ts:149` |

### 5.3 Chaves do relatório de validação de grafo

O relatório tem duas implementações que precisam continuar idênticas — a do
control plane (`packages/core/src/domain/graph.ts`) e a de referência
(`scripts/validar-grafo.mjs`), comparadas linha a linha por
`packages/core/test/domain-graph.test.ts`. O ticket filho renomeia as duas na
mesma entrega, ou o teste de paridade cai.

| superfície | hoje | vira | onde está hoje |
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

### 5.4 Regras de soundness e códigos de estrutura

`no_inalcancavel` não é o nome de uma regra no código — a regra chama-se
`alcançável` e a violação é anotada com esse nome. O termo aparece como nome do
exemplo que a exercita (`schema/exemplos/grafo-invalido-no-inalcancavel.json`) e
está aqui porque o inventário do t213 o cita: o arquivo de exemplo é renomeado
junto.

| superfície | hoje | vira | onde está hoje |
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
| routes-cli-report | `aresta_no_inexistente` | `edge_unknown_node` | `scripts/validar-grafo.mjs` |
| routes-cli-report | `no_inicial_inexistente` | `unknown_initial_node` | `scripts/validar-grafo.mjs` |
| routes-cli-report | `no_final_inexistente` | `unknown_final_node` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `campo_invalido` | `invalid_field` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `campo_obrigatorio_ausente` | `missing_required_field` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `gancho_invalido` | `invalid_hook` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `id_gancho_duplicado` | `duplicate_hook_id` | `packages/core/src/domain/graph.ts` |
| routes-cli-report | `gancho_no_inexistente` | `hook_unknown_node` | `packages/core/src/domain/graph.ts:437` |

---

## O que este glossário não decide

- **Como migrar.** Recriar banco de desenvolvimento é decisão da D20; o passo a
  passo (migração, ordem, o que fazer com bundle de fábrica já exportado) é do
  ticket filho do banco.
- **O formato final do envelope de erro.** Ver 1.4.
- **Se o `no-portuguese-wire.test.ts` existe.** Estender os portões da D18 para
  cobrir valor no fio é o último ticket filho (docs e portão), quando já houver
  um fio em inglês para conferir.
- **A marca e os documentos internos.** `cartografo` continua `cartografo`;
  `DECISOES.md`, `notas/`, `docs/` e este arquivo continuam em português (D18).
