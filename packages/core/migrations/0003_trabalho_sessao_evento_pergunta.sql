-- 0003 — job, session, event e input_request.
--
-- Numerada 0003, não 0002: t101 (graph/graph_version/proposal) aterrissou na
-- main primeiro e ocupou o 0002. `src/db/migrate.ts` falha alto em número
-- repetido, então a renumeração no merge é obrigatória, não cosmética.
--
-- `event` é a fonte de verdade (t98): append-only, sem update e sem delete.
-- As outras três tabelas são PROJEÇÃO — estado atual, sempre reconstruível a
-- partir do log por `especificacoes/eventos/reducers/reconstruir-estado.mjs`.
-- Quando as duas discordarem, quem está errado é a projeção.
--
-- Duas ausências de propósito:
--
-- - não existe tabela "execução". `execution_id` é um agrupador INTEGER opaco;
--   a taxonomia nunca listou execução como `entity.type` válido
--   (`especificacoes/eventos/schemas/envelope.schema.json:41`);
-- - `job.graph_version_id` não tem FK. A tabela `graph_version` é de t101,
--   que corre em paralelo, e o id dela é hash (string, D15) — travar a FK aqui
--   acoplaria a ordem de build das duas fichas sem ganhar nada.
--
-- Duas colunas de `job` nascem em português e continuam assim: `corpo` e
-- `criterios_de_aceite` (0006) não têm linha na §4.2 do glossário, e inventar
-- nome fora do glossário é o contrário do que o t213 existe para fazer.
-- Fechá-las é acrescentar as linhas lá e uma migração curta — ficha própria.
--
-- Nenhuma migração abre transação própria: quem transaciona é
-- `src/db/migrate.ts`, uma transação por migração.

CREATE TABLE event (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  project_id  INTEGER NOT NULL,
  execution_id INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job','session','input_request','lease','graph_version')),
  entity_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_ref   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL
);
CREATE INDEX idx_event_entity     ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution  ON event (execution_id);
CREATE INDEX idx_event_project    ON event (project_id);

CREATE TABLE job (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  execution_id      INTEGER,
  title             TEXT NOT NULL,
  entry_node_id     TEXT NOT NULL,
  current_node_id   TEXT NOT NULL,
  blocked           INTEGER NOT NULL DEFAULT 0,
  block_reason      TEXT,
  graph_version_id  TEXT, -- solto de propósito: graph_version é de t101, sem FK para não acoplar ordem de build
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_job_execution ON job (execution_id);
CREATE INDEX idx_job_project   ON job (project_id);

CREATE TABLE session (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id             INTEGER REFERENCES job(id),
  execution_id       INTEGER,
  node_id            TEXT,
  engine             TEXT NOT NULL,
  engine_session_ref TEXT,
  working_dir        TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  timeout_seconds    INTEGER,
  -- Sem CHECK: os valores terminais vêm de `session.finished`, cujo vocabulário
  -- é da taxonomia de eventos e não desta tabela. `open` é o único que nasce
  -- aqui, e é o mesmo inglês do evento `session.opened` (glossário §1.6).
  status             TEXT NOT NULL DEFAULT 'open',
  exit_code          INTEGER,
  usage              TEXT, -- JSON; NULL != gravar zeros
  opened_at          TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX idx_session_job        ON session (job_id);
CREATE INDEX idx_session_execution  ON session (execution_id);

CREATE TABLE input_request (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          INTEGER NOT NULL REFERENCES job(id),
  session_id      INTEGER REFERENCES session(id),
  execution_id    INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('question','approval')),
  question        TEXT NOT NULL,
  context         TEXT,
  options         TEXT, -- JSON array
  recommendation  TEXT,
  default_answer  TEXT,
  auto_approvable INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  answer          TEXT,
  answered_by     TEXT,
  source          TEXT CHECK (source IN ('user','auto')),
  created_at      TEXT NOT NULL,
  answered_at     TEXT
);
CREATE INDEX idx_input_request_job              ON input_request (job_id);
CREATE INDEX idx_input_request_execution_status ON input_request (execution_id, status);
