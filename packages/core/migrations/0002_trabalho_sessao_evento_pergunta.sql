-- 0002 — trabalho, sessão, evento e pergunta.
--
-- `evento` é a fonte de verdade (t98): append-only, sem update e sem delete.
-- As outras três tabelas são PROJEÇÃO — estado atual, sempre reconstruível a
-- partir do log por `especificacoes/eventos/reducers/reconstruir-estado.mjs`.
-- Quando as duas discordarem, quem está errado é a projeção.
--
-- Duas ausências de propósito:
--
-- - não existe tabela "execução". `execucao_id` é um agrupador INTEGER opaco;
--   a taxonomia nunca listou execução como `entidade.tipo` válido
--   (`especificacoes/eventos/schemas/envelope.schema.json:41`);
-- - `trabalho.grafo_versao_id` não tem FK. A tabela `grafo_versao` é de t101,
--   que corre em paralelo, e o id dela é hash (string, D15) — travar a FK aqui
--   acoplaria a ordem de build das duas fichas sem ganhar nada.
--
-- Nenhuma migração abre transação própria: quem transaciona é
-- `src/db/migrate.ts`, uma transação por migração.

CREATE TABLE evento (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo          TEXT NOT NULL,
  projeto_id    INTEGER NOT NULL,
  execucao_id   INTEGER,
  entidade_tipo TEXT NOT NULL CHECK (entidade_tipo IN ('trabalho','sessao','pergunta','lease','grafo_versao')),
  entidade_id   TEXT NOT NULL,
  ator_tipo     TEXT NOT NULL CHECK (ator_tipo IN ('usuario','agente','sistema')),
  ator_ref      TEXT NOT NULL,
  ocorrido_em   TEXT NOT NULL,
  dados         TEXT NOT NULL
);
CREATE INDEX idx_evento_entidade  ON evento (entidade_tipo, entidade_id);
CREATE INDEX idx_evento_execucao  ON evento (execucao_id);
CREATE INDEX idx_evento_projeto   ON evento (projeto_id);

CREATE TABLE trabalho (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id      INTEGER NOT NULL,
  execucao_id     INTEGER,
  titulo          TEXT NOT NULL,
  no_entrada_id   TEXT NOT NULL,
  no_atual        TEXT NOT NULL,
  bloqueado       INTEGER NOT NULL DEFAULT 0,
  motivo_bloqueio TEXT,
  grafo_versao_id TEXT, -- solto de propósito: grafo_versao é de t101, sem FK para não acoplar ordem de build
  criado_em       TEXT NOT NULL,
  atualizado_em   TEXT NOT NULL
);
CREATE INDEX idx_trabalho_execucao ON trabalho (execucao_id);
CREATE INDEX idx_trabalho_projeto  ON trabalho (projeto_id);

CREATE TABLE sessao (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  trabalho_id        INTEGER REFERENCES trabalho(id),
  execucao_id        INTEGER,
  no_id              TEXT,
  engine             TEXT NOT NULL,
  engine_session_ref TEXT,
  working_dir        TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  timeout_seconds    INTEGER,
  status             TEXT NOT NULL DEFAULT 'aberta',
  exit_code          INTEGER,
  uso                TEXT, -- JSON; NULL != gravar zeros
  aberta_em          TEXT NOT NULL,
  finalizada_em      TEXT
);
CREATE INDEX idx_sessao_trabalho  ON sessao (trabalho_id);
CREATE INDEX idx_sessao_execucao  ON sessao (execucao_id);

CREATE TABLE pergunta (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trabalho_id     INTEGER NOT NULL REFERENCES trabalho(id),
  sessao_id       INTEGER REFERENCES sessao(id),
  execucao_id     INTEGER,
  tipo            TEXT NOT NULL CHECK (tipo IN ('pergunta','aprovacao')),
  pergunta        TEXT NOT NULL,
  contexto        TEXT,
  opcoes          TEXT, -- JSON array
  recomendacao    TEXT,
  resposta_padrao TEXT,
  auto_aprovavel  INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pendente',
  resposta        TEXT,
  respondido_por  TEXT,
  origem          TEXT CHECK (origem IN ('usuario','auto')),
  criada_em       TEXT NOT NULL,
  respondida_em   TEXT
);
CREATE INDEX idx_pergunta_trabalho          ON pergunta (trabalho_id);
CREATE INDEX idx_pergunta_execucao_status   ON pergunta (execucao_id, status);
