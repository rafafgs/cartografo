-- 0019_wire_database_rename — o schema passa a falar o inglês da §4 do glossário (t229).
--
-- Quarto dos seis filhos da D20 (`DECISOES.md:182`), na ordem que ela fixou:
-- glossário → API/erros → eventos → operações → BANCO → rotas/flags/relatório →
-- docs e portão. O vocabulário desta migração não foi inventado aqui: cada nome
-- sai literalmente da coluna "vira" de `docs/spec/glossario-wire.md` §4.1
-- (tabelas) e §4.2 (colunas), que é justamente o que impede os seis filhos de
-- inventarem cinco inglêses para o mesmo termo.
--
-- **Bancos de desenvolvimento são RECRIADOS, não migrados** (D20): não há dado
-- de produção, e o README já manda apagar `.cartografo/` quando o schema muda.
-- Esta migração existe para que um banco que já esteja em `0018` continue
-- abrindo — e porque a alternativa (reescrever as dezoito migrações
-- históricas) apagaria o histórico que é o próprio ponto do diretório.
--
-- **Só identificador.** Decisão do fundador de 2026-08-17, respondendo à
-- pergunta de escopo desta ficha: o que muda é NOME de tabela, de coluna e de
-- índice. Os VALORES presos por `CHECK` continuam em português
-- (`proposta.status = 'pendente'`, `evento.entidade_tipo = 'trabalho'`,
-- `skill.papel = 'fazer'`, …), e os mapas de tradução linha↔fio que os filhos
-- 1–3 construíram continuam exatamente onde estão. Por isso nenhum `CHECK`,
-- nenhum `DEFAULT` e nenhuma linha é editada à mão aqui: o SQLite reescreve
-- sozinho o corpo do `CHECK`, do `DEFAULT`, da FK e do índice quando a coluna
-- é renomeada (>= 3.26; este repositório roda 3.53.4).
--
-- **O que o SQLite NÃO faz sozinho é renomear o NOME do índice.** Ele mantém as
-- colunas que o índice referencia válidas e nada mais — então os 24 índices que
-- carregam uma palavra aposentada no próprio nome são derrubados e recriados à
-- mão, com as mesmas colunas e o mesmo predicado da migração que os criou. Os
-- índices implícitos (`sqlite_autoindex_*` de um `UNIQUE` de tabela) seguem a
-- tabela sozinhos e não aparecem aqui.
--
-- `runner`, `lease` e `skill` NÃO são renomeadas: a §4.1 as registra com o mesmo
-- nome dos dois lados, porque já estavam em inglês. Só as colunas delas se
-- movem. `schema_migrations` (`0001`) não é da §4 e não é tocada.
--
-- Quatro colunas em português SOBREVIVEM de propósito, e a razão é que a §4.2
-- não as registra: `job.corpo`, `job.criterios_de_aceite`,
-- `session.transcricao_truncada` e `session.transcricao_tamanho_original`.
-- Renomeá-las aqui seria inventar vocabulário fora do glossário, que é o
-- contrário do que o t213 existe para fazer. Fechar o buraco é acrescentar as
-- linhas na §4.2 e uma migração curta depois — trabalho do sexto filho (docs e
-- portão) ou de ficha própria.
--
-- A ordem é: renomeia a tabela, depois as colunas DELA (já pelo nome novo),
-- depois os índices dela. `pergunta` é o caso que obriga a essa ordem — a
-- tabela e uma das colunas têm o mesmo nome.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

-- 0002 — grafo, grafo_versao, proposta ---------------------------------------

ALTER TABLE grafo RENAME TO graph;

ALTER TABLE graph RENAME COLUMN classe TO class;
ALTER TABLE graph RENAME COLUMN linhagem_tipo TO lineage_type;
ALTER TABLE graph RENAME COLUMN base_classe TO base_class;
ALTER TABLE graph RENAME COLUMN origem_proposta_id TO origin_proposal_id;
ALTER TABLE graph RENAME COLUMN versao_corrente_id TO current_version_id;
ALTER TABLE graph RENAME COLUMN criado_em TO created_at;

DROP INDEX grafo_classe_base_unico;
CREATE UNIQUE INDEX graph_class_base_unique ON graph (class) WHERE lineage_type = 'base';

ALTER TABLE grafo_versao RENAME TO graph_version;

ALTER TABLE graph_version RENAME COLUMN grafo_id TO graph_id;
ALTER TABLE graph_version RENAME COLUMN versao_pai TO parent_version;
ALTER TABLE graph_version RENAME COLUMN origem TO source;
ALTER TABLE graph_version RENAME COLUMN proposta_id TO proposal_id;
ALTER TABLE graph_version RENAME COLUMN criado_em TO created_at;

DROP INDEX grafo_versao_por_grafo;
CREATE INDEX graph_version_by_graph ON graph_version (graph_id);

ALTER TABLE proposta RENAME TO proposal;

ALTER TABLE proposal RENAME COLUMN grafo_id TO graph_id;
ALTER TABLE proposal RENAME COLUMN versao_alvo TO target_version;
ALTER TABLE proposal RENAME COLUMN operacoes TO operations;
ALTER TABLE proposal RENAME COLUMN evidencia TO evidence;
ALTER TABLE proposal RENAME COLUMN metrica_esperada TO expected_metric;
ALTER TABLE proposal RENAME COLUMN versao_aplicada_id TO applied_version_id;
ALTER TABLE proposal RENAME COLUMN motivo_reversao TO revert_reason;
ALTER TABLE proposal RENAME COLUMN motivo_rejeicao TO rejection_reason;
ALTER TABLE proposal RENAME COLUMN resultado TO result;
ALTER TABLE proposal RENAME COLUMN criado_em TO created_at;
ALTER TABLE proposal RENAME COLUMN atualizado_em TO updated_at;

DROP INDEX proposta_por_grafo;
CREATE INDEX proposal_by_graph ON proposal (graph_id);

-- 0003 — evento, trabalho, sessao, pergunta -----------------------------------

ALTER TABLE evento RENAME TO event;

ALTER TABLE event RENAME COLUMN tipo TO type;
ALTER TABLE event RENAME COLUMN projeto_id TO project_id;
ALTER TABLE event RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE event RENAME COLUMN entidade_tipo TO entity_type;
ALTER TABLE event RENAME COLUMN entidade_id TO entity_id;
ALTER TABLE event RENAME COLUMN ator_tipo TO actor_type;
ALTER TABLE event RENAME COLUMN ator_ref TO actor_ref;
ALTER TABLE event RENAME COLUMN ocorrido_em TO occurred_at;
ALTER TABLE event RENAME COLUMN dados TO data;

DROP INDEX idx_evento_entidade;
DROP INDEX idx_evento_execucao;
DROP INDEX idx_evento_projeto;
CREATE INDEX idx_event_entity    ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution ON event (execution_id);
CREATE INDEX idx_event_project   ON event (project_id);

ALTER TABLE trabalho RENAME TO job;

ALTER TABLE job RENAME COLUMN projeto_id TO project_id;
ALTER TABLE job RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE job RENAME COLUMN titulo TO title;
ALTER TABLE job RENAME COLUMN no_entrada_id TO entry_node_id;
ALTER TABLE job RENAME COLUMN no_atual TO current_node_id;
ALTER TABLE job RENAME COLUMN bloqueado TO blocked;
ALTER TABLE job RENAME COLUMN motivo_bloqueio TO block_reason;
ALTER TABLE job RENAME COLUMN grafo_versao_id TO graph_version_id;
ALTER TABLE job RENAME COLUMN campos TO fields;                 -- 0015
ALTER TABLE job RENAME COLUMN criado_em TO created_at;
ALTER TABLE job RENAME COLUMN atualizado_em TO updated_at;

DROP INDEX idx_trabalho_execucao;
DROP INDEX idx_trabalho_projeto;
CREATE INDEX idx_job_execution ON job (execution_id);
CREATE INDEX idx_job_project   ON job (project_id);

ALTER TABLE sessao RENAME TO session;

ALTER TABLE session RENAME COLUMN trabalho_id TO job_id;
ALTER TABLE session RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE session RENAME COLUMN no_id TO node_id;
ALTER TABLE session RENAME COLUMN uso TO usage;
ALTER TABLE session RENAME COLUMN transcricao TO transcript;     -- 0009
ALTER TABLE session RENAME COLUMN modelos TO models;             -- 0013
ALTER TABLE session RENAME COLUMN aberta_em TO opened_at;
ALTER TABLE session RENAME COLUMN finalizada_em TO finished_at;

DROP INDEX idx_sessao_trabalho;
DROP INDEX idx_sessao_execucao;
CREATE INDEX idx_session_job       ON session (job_id);
CREATE INDEX idx_session_execution ON session (execution_id);

-- A tabela vem antes das colunas dela em toda esta migração; aqui a ordem é o
-- que impede a ambiguidade, porque `pergunta` é o nome da tabela E de uma
-- coluna dela.
ALTER TABLE pergunta RENAME TO input_request;

ALTER TABLE input_request RENAME COLUMN trabalho_id TO job_id;
ALTER TABLE input_request RENAME COLUMN sessao_id TO session_id;
ALTER TABLE input_request RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE input_request RENAME COLUMN no_id TO node_id;        -- 0014
ALTER TABLE input_request RENAME COLUMN tipo TO kind;
ALTER TABLE input_request RENAME COLUMN pergunta TO question;
ALTER TABLE input_request RENAME COLUMN contexto TO context;
ALTER TABLE input_request RENAME COLUMN opcoes TO options;
ALTER TABLE input_request RENAME COLUMN recomendacao TO recommendation;
ALTER TABLE input_request RENAME COLUMN resposta_padrao TO default_answer;
ALTER TABLE input_request RENAME COLUMN auto_aprovavel TO auto_approvable;
ALTER TABLE input_request RENAME COLUMN resposta TO answer;
ALTER TABLE input_request RENAME COLUMN respondido_por TO answered_by;
ALTER TABLE input_request RENAME COLUMN origem TO source;
ALTER TABLE input_request RENAME COLUMN criada_em TO created_at;
ALTER TABLE input_request RENAME COLUMN respondida_em TO answered_at;

DROP INDEX idx_pergunta_trabalho;
DROP INDEX idx_pergunta_execucao_status;
CREATE INDEX idx_input_request_job              ON input_request (job_id);
CREATE INDEX idx_input_request_execution_status ON input_request (execution_id, status);

-- 0004 — runner e lease (as tabelas já estão em inglês; só as colunas se movem)

ALTER TABLE runner RENAME COLUMN nome TO name;
ALTER TABLE runner RENAME COLUMN registrado_em TO registered_at;

ALTER TABLE lease RENAME COLUMN trabalho_id TO job_id;
ALTER TABLE lease RENAME COLUMN projeto_id TO project_id;
ALTER TABLE lease RENAME COLUMN ttl_segundos TO ttl_seconds;
ALTER TABLE lease RENAME COLUMN concedida_em TO granted_at;
ALTER TABLE lease RENAME COLUMN heartbeat_em TO heartbeat_at;
ALTER TABLE lease RENAME COLUMN expira_em TO expires_at;
ALTER TABLE lease RENAME COLUMN liberada_em TO released_at;
ALTER TABLE lease RENAME COLUMN motivo_expiracao TO expiration_reason;

-- `idx_lease_runner_status` não tem palavra em português no nome e fica.
DROP INDEX idx_lease_projeto_status;
DROP INDEX idx_lease_trabalho_status;
CREATE INDEX idx_lease_project_status ON lease (project_id, status);
CREATE INDEX idx_lease_job_status     ON lease (job_id, status);

-- 0005 — skill (a tabela já está em inglês) ------------------------------------

ALTER TABLE skill RENAME COLUMN versao TO version;
ALTER TABLE skill RENAME COLUMN papel TO role;
ALTER TABLE skill RENAME COLUMN descricao TO description;
ALTER TABLE skill RENAME COLUMN entrada TO input;
ALTER TABLE skill RENAME COLUMN saida TO output;
ALTER TABLE skill RENAME COLUMN pre_condicoes TO preconditions;
ALTER TABLE skill RENAME COLUMN permissoes TO permissions;
ALTER TABLE skill RENAME COLUMN instrucoes TO instructions;
ALTER TABLE skill RENAME COLUMN origem TO source;
ALTER TABLE skill RENAME COLUMN registrado_em TO registered_at;

-- 0006 — trabalho_dependencia e intake_rascunho --------------------------------

ALTER TABLE trabalho_dependencia RENAME TO job_dependency;

ALTER TABLE job_dependency RENAME COLUMN trabalho_id TO job_id;
ALTER TABLE job_dependency RENAME COLUMN depende_de_trabalho_id TO depends_on_job_id;
ALTER TABLE job_dependency RENAME COLUMN criado_em TO created_at;

DROP INDEX idx_trabalho_dependencia_par;
DROP INDEX idx_trabalho_dependencia_trabalho;
CREATE UNIQUE INDEX idx_job_dependency_pair ON job_dependency (job_id, depends_on_job_id);
CREATE INDEX idx_job_dependency_job         ON job_dependency (job_id);

ALTER TABLE intake_rascunho RENAME TO intake_draft;

ALTER TABLE intake_draft RENAME COLUMN projeto_id TO project_id;
ALTER TABLE intake_draft RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE intake_draft RENAME COLUMN classe TO class;
ALTER TABLE intake_draft RENAME COLUMN pedido TO request;
ALTER TABLE intake_draft RENAME COLUMN itens TO items;
ALTER TABLE intake_draft RENAME COLUMN trabalhos_criados TO created_jobs;
ALTER TABLE intake_draft RENAME COLUMN criado_em TO created_at;
ALTER TABLE intake_draft RENAME COLUMN atualizado_em TO updated_at;

DROP INDEX idx_intake_rascunho_status;
DROP INDEX idx_intake_rascunho_projeto;
CREATE INDEX idx_intake_draft_status  ON intake_draft (status);
CREATE INDEX idx_intake_draft_project ON intake_draft (project_id);

-- 0007 — credencial ------------------------------------------------------------

ALTER TABLE credencial RENAME TO credential;

-- `credencial.tipo` é uma das três linhas QUALIFICADAS da §4.2: o mesmo
-- português quer dizer coisas diferentes por tabela, e aqui quer dizer de quem
-- é a credencial.
ALTER TABLE credential RENAME COLUMN tipo TO owner_type;
ALTER TABLE credential RENAME COLUMN criada_em TO created_at;
ALTER TABLE credential RENAME COLUMN revogada_em TO revoked_at;

DROP INDEX idx_credencial_tipo;
CREATE INDEX idx_credential_type ON credential (owner_type, revoked_at);

-- 0008 — assinatura_webhook e entrega_webhook ----------------------------------

ALTER TABLE assinatura_webhook RENAME TO webhook_subscription;

ALTER TABLE webhook_subscription RENAME COLUMN projeto_id TO project_id;
ALTER TABLE webhook_subscription RENAME COLUMN segredo TO secret;
ALTER TABLE webhook_subscription RENAME COLUMN tipos_filtro TO filter_types;
ALTER TABLE webhook_subscription RENAME COLUMN evento_inicial_id TO initial_event_id;
ALTER TABLE webhook_subscription RENAME COLUMN criada_em TO created_at;
ALTER TABLE webhook_subscription RENAME COLUMN desativada_em TO deactivated_at;

DROP INDEX idx_assinatura_webhook_ativa;
CREATE INDEX idx_webhook_subscription_active
  ON webhook_subscription (deactivated_at, project_id);

ALTER TABLE entrega_webhook RENAME TO webhook_delivery;

ALTER TABLE webhook_delivery RENAME COLUMN assinatura_id TO subscription_id;
ALTER TABLE webhook_delivery RENAME COLUMN evento_id TO event_id;
ALTER TABLE webhook_delivery RENAME COLUMN tentativas TO attempts;
ALTER TABLE webhook_delivery RENAME COLUMN proxima_tentativa_em TO next_attempt_at;
ALTER TABLE webhook_delivery RENAME COLUMN criada_em TO created_at;
ALTER TABLE webhook_delivery RENAME COLUMN entregue_em TO delivered_at;
ALTER TABLE webhook_delivery RENAME COLUMN ultimo_erro TO last_error;

DROP INDEX idx_entrega_webhook_pendente;
CREATE INDEX idx_webhook_delivery_pending ON webhook_delivery (status, next_attempt_at);

-- 0012 — motor_modelo ----------------------------------------------------------

ALTER TABLE motor_modelo RENAME TO engine_model;

ALTER TABLE engine_model RENAME COLUMN motor TO engine;
ALTER TABLE engine_model RENAME COLUMN modelo_id TO model_id;
ALTER TABLE engine_model RENAME COLUMN rotulo TO label;
ALTER TABLE engine_model RENAME COLUMN origem TO source;
ALTER TABLE engine_model RENAME COLUMN atualizado_em TO updated_at;

DROP INDEX idx_motor_modelo_unico;
CREATE UNIQUE INDEX idx_engine_model_unique ON engine_model (engine, model_id);

-- 0016 — entrega_gancho --------------------------------------------------------

ALTER TABLE entrega_gancho RENAME TO hook_delivery;

ALTER TABLE hook_delivery RENAME COLUMN projeto_id TO project_id;
ALTER TABLE hook_delivery RENAME COLUMN execucao_id TO execution_id;
ALTER TABLE hook_delivery RENAME COLUMN trabalho_id TO job_id;
ALTER TABLE hook_delivery RENAME COLUMN gancho_id TO hook_id;
ALTER TABLE hook_delivery RENAME COLUMN no_id TO node_id;
ALTER TABLE hook_delivery RENAME COLUMN grafo_versao_id TO graph_version_id;
ALTER TABLE hook_delivery RENAME COLUMN evento_id TO event_id;
ALTER TABLE hook_delivery RENAME COLUMN segredo TO secret;
ALTER TABLE hook_delivery RENAME COLUMN tentativas TO attempts;
ALTER TABLE hook_delivery RENAME COLUMN proxima_tentativa_em TO next_attempt_at;
ALTER TABLE hook_delivery RENAME COLUMN criada_em TO created_at;
ALTER TABLE hook_delivery RENAME COLUMN entregue_em TO delivered_at;
ALTER TABLE hook_delivery RENAME COLUMN ultimo_erro TO last_error;

DROP INDEX idx_entrega_gancho_pendente;
CREATE INDEX idx_hook_delivery_pending ON hook_delivery (status, next_attempt_at);

-- 0018 — segredo_gancho --------------------------------------------------------

ALTER TABLE segredo_gancho RENAME TO hook_secret;

ALTER TABLE hook_secret RENAME COLUMN nome TO name;
ALTER TABLE hook_secret RENAME COLUMN valor TO value;
ALTER TABLE hook_secret RENAME COLUMN criada_em TO created_at;
ALTER TABLE hook_secret RENAME COLUMN revogada_em TO revoked_at;

DROP INDEX idx_segredo_gancho_nome_vivo;
CREATE UNIQUE INDEX idx_hook_secret_name_alive
  ON hook_secret (name) WHERE revoked_at IS NULL;
