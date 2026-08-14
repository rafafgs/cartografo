-- 0002_grafo_versao_proposta — o versionamento git-like da D15 em três tabelas.
--
-- grafo é a LINHAGEM (classe, tipo de linhagem, ponteiro para a versão
-- corrente); grafo_versao é o snapshot imutável, endereçado pelo hash do
-- próprio conteúdo; proposta é a hipótese: operações semânticas tipadas com
-- inversa, evidência e métrica que se espera mover.
--
-- Append-only por construção: nenhum caminho de código apaga ou sobrescreve
-- linha de grafo_versao. Reverter move o ponteiro de grafo.versao_corrente_id;
-- a versão abandonada continua aqui, que é o que deixa o histórico íntegro e
-- o join versão x telemetria possível depois (D15).
--
-- Os nomes de coluna (grafo_id, versao_pai, origem, proposta_id, motivo) copiam
-- literalmente os schemas de evento já especificados em
-- especificacoes/eventos/schemas/grafo_versao.*.schema.json, para que a emissão
-- de telemetria (t102) seja mapeamento direto, não tradução. Esta migração NÃO
-- cria a tabela de eventos: ela é do t102.
--
-- As referências entre as três tabelas são circulares (grafo -> grafo_versao ->
-- proposta -> grafo). O SQLite não exige que a tabela referenciada já exista no
-- CREATE TABLE, então a ordem abaixo é documental. Nenhuma migração abre
-- transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE grafo (
  id                  TEXT PRIMARY KEY,          -- classe, para a linhagem base (D8)
  classe              TEXT NOT NULL,
  linhagem_tipo       TEXT NOT NULL CHECK (linhagem_tipo IN ('base', 'variante')),
  base_classe         TEXT,                       -- só variante (D13, t118 — não exercido nesta ticket)
  origem_proposta_id  INTEGER REFERENCES proposta(id),
  versao_corrente_id  TEXT REFERENCES grafo_versao(id),
  criado_em           TEXT NOT NULL,
  CHECK (
    (linhagem_tipo = 'base' AND base_classe IS NULL)
    OR (linhagem_tipo = 'variante' AND base_classe IS NOT NULL)
  )
);

-- Uma classe tem no máximo UM grafo base; variantes da mesma classe (t118)
-- ficam de fora do índice de propósito.
CREATE UNIQUE INDEX grafo_classe_base_unico ON grafo (classe) WHERE linhagem_tipo = 'base';

CREATE TABLE grafo_versao (
  id          TEXT PRIMARY KEY,        -- sha256:<64 hex> do snapshot canônico
  grafo_id    TEXT NOT NULL REFERENCES grafo(id),
  versao_pai  TEXT REFERENCES grafo_versao(id),
  snapshot    TEXT NOT NULL,           -- documento de grafo completo, canonicalizado
  origem      TEXT NOT NULL CHECK (origem IN ('manual', 'sintetizador', 'proposta')),
  proposta_id INTEGER REFERENCES proposta(id),
  criado_em   TEXT NOT NULL
);

CREATE INDEX grafo_versao_por_grafo ON grafo_versao (grafo_id);

CREATE TABLE proposta (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  grafo_id            TEXT NOT NULL REFERENCES grafo(id),
  versao_alvo         TEXT NOT NULL REFERENCES grafo_versao(id),
  operacoes           TEXT NOT NULL,   -- JSON: Operacao[] (src/dominio/operacoes.ts)
  evidencia           TEXT NOT NULL,   -- JSON
  metrica_esperada    TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'aplicada', 'revertida', 'rejeitada')),
  versao_aplicada_id  TEXT REFERENCES grafo_versao(id),
  motivo_reversao     TEXT,
  resultado           TEXT,            -- JSON; relatório de rejeição aqui, resultado de hipótese no t112
  criado_em           TEXT NOT NULL,
  atualizado_em       TEXT NOT NULL
);

CREATE INDEX proposta_por_grafo ON proposta (grafo_id);
