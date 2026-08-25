-- 0002_grafo_versao_proposta — o versionamento git-like da D15 em três tabelas.
--
-- graph é a LINHAGEM (classe, tipo de linhagem, ponteiro para a versão
-- corrente); graph_version é o snapshot imutável, endereçado pelo hash do
-- próprio conteúdo; proposal é a hipótese: operações semânticas tipadas com
-- inversa, evidência e métrica que se espera mover.
--
-- Append-only por construção: nenhum caminho de código apaga ou sobrescreve
-- linha de graph_version. Reverter move o ponteiro de graph.current_version_id;
-- a versão abandonada continua aqui, que é o que deixa o histórico íntegro e
-- o join versão x telemetria possível depois (D15).
--
-- Os nomes de coluna (graph_id, parent_version, source, proposal_id, reason)
-- copiam literalmente os schemas de evento já especificados em
-- specs/events/schemas/, para que a emissão de telemetria (t102) seja
-- mapeamento direto, não tradução. Esta migração NÃO cria a tabela de eventos:
-- ela é do t102.
--
-- O NOME do arquivo continua em português e o CONTEÚDO fala inglês: a t235
-- reescreveu as dezoito migrações no lugar (D20 recria banco de
-- desenvolvimento, não migra) e deixou os nomes de arquivo onde estavam,
-- porque uma dúzia de testes e o `test/support.ts` citam a migração pelo nome
-- e renomear não aproxima o schema de nada.
--
-- As referências entre as três tabelas são circulares (graph -> graph_version ->
-- proposal -> graph). O SQLite não exige que a tabela referenciada já exista no
-- CREATE TABLE, então a ordem abaixo é documental. Nenhuma migração abre
-- transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE graph (
  id                  TEXT PRIMARY KEY,          -- classe, para a linhagem base (D8)
  class               TEXT NOT NULL,
  lineage_type        TEXT NOT NULL CHECK (lineage_type IN ('base', 'variant')),
  base_class          TEXT,                       -- só variante (D13, t118 — não exercido nesta ticket)
  origin_proposal_id  INTEGER REFERENCES proposal(id),
  current_version_id  TEXT REFERENCES graph_version(id),
  created_at          TEXT NOT NULL,
  CHECK (
    (lineage_type = 'base' AND base_class IS NULL)
    OR (lineage_type = 'variant' AND base_class IS NOT NULL)
  )
);

-- Uma classe tem no máximo UM grafo base; variantes da mesma classe (t118)
-- ficam de fora do índice de propósito.
CREATE UNIQUE INDEX graph_class_base_unique ON graph (class) WHERE lineage_type = 'base';

CREATE TABLE graph_version (
  id              TEXT PRIMARY KEY,       -- sha256:<64 hex> do snapshot canônico
  graph_id        TEXT NOT NULL REFERENCES graph(id),
  parent_version  TEXT REFERENCES graph_version(id),
  snapshot        TEXT NOT NULL,          -- documento de grafo completo, canonicalizado
  source          TEXT NOT NULL CHECK (source IN ('manual', 'synthesizer', 'proposal')),
  proposal_id     INTEGER REFERENCES proposal(id),
  created_at      TEXT NOT NULL
);

CREATE INDEX graph_version_by_graph ON graph_version (graph_id);

CREATE TABLE proposal (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            TEXT NOT NULL REFERENCES graph(id),
  target_version      TEXT NOT NULL REFERENCES graph_version(id),
  operations          TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT REFERENCES graph_version(id),
  revert_reason       TEXT,
  result              TEXT,            -- JSON; relatório de rejeição aqui, resultado de hipótese no t112
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX proposal_by_graph ON proposal (graph_id);
