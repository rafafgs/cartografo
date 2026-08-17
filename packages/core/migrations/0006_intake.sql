-- 0006_intake — o intake de duas fases: rascunho, confirmação, dependência.
--
-- Renumerada de 0005 para 0006 no merge: a 0005_skill (t117/t135) chegou antes
-- na main, e `src/db/migrate.ts` falha alto em número repetido. Nenhuma ordem
-- de dependência entre as duas — esta só mexe em `job` e cria tabelas
-- próprias.
--
-- A D3 separa dois atos do meta-processo: sintetizar topologia produz NÓS (uma
-- vez por classe) e quebrar trabalho produz TICKETS (a cada execução). Esta
-- migração é a segunda metade: um rascunho de quebra que existe antes de
-- qualquer `job`, e que só vira trabalho depois de confirmação humana
-- (README, princípio 5, aplicado à quebra de trabalho — nunca ao grafo).
--
-- Três mudanças, e o motivo de cada uma:
--
-- - `job.corpo` e `job.criterios_de_aceite`. A taxonomia de eventos já
--   antecipava um trabalho com conteúdo (o exemplo de `job.amended` cita
--   campos que a 0003 nunca criou). Os critérios que o intake grava são
--   PRELIMINARES: quem os produz de verdade é o nó `refinar` do grafo de
--   fábrica 1, a partir do pedido bruto. NULL e [] são coisas diferentes —
--   "ninguém escreveu critério ainda" não é "declarei que não há critério".
--   Os dois nomes seguem em português porque a §4.2 do glossário não os
--   registra, e a t235 não inventa vocabulário fora do glossário.
-- - `job_dependency`. Aresta entre dois trabalhos do mesmo lote,
--   declarada na confirmação. Só REGISTRO: nada aqui bloqueia o trabalho
--   dependente enquanto a dependência está aberta (t122, FR14). O CHECK
--   impede a auto-referência que o validador de domínio já rejeita antes —
--   duas linhas de defesa para o mesmo absurdo.
-- - `intake_draft`. Armazenamento de trabalho em curso, não fato de
--   auditoria: nenhum evento é emitido na criação, edição ou descarte do
--   rascunho. O log só ganha linha quando os `job` de fato nascem.
--
-- `items` e `created_jobs` são JSON em coluna TEXT, como `session.usage` e
-- `input_request.options` já fazem: o formato do item ainda não congelou (regra
-- dos dois consumidores) e normalizar em tabela custaria uma migração a cada
-- campo novo do rascunho.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

ALTER TABLE job ADD COLUMN corpo TEXT;
ALTER TABLE job ADD COLUMN criterios_de_aceite TEXT; -- JSON: string[]; NULL != []

CREATE TABLE job_dependency (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  depends_on_job_id INTEGER NOT NULL REFERENCES job(id),
  created_at        TEXT NOT NULL,
  CHECK (job_id != depends_on_job_id)
);
CREATE UNIQUE INDEX idx_job_dependency_pair ON job_dependency (job_id, depends_on_job_id);
CREATE INDEX idx_job_dependency_job ON job_dependency (job_id);

CREATE TABLE intake_draft (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL,
  execution_id  INTEGER,
  class         TEXT NOT NULL,
  request       TEXT NOT NULL,
  items         TEXT NOT NULL, -- JSON: {ref, titulo, corpo?, criterios_de_aceite?, depende_de?}[]
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded')),
  created_jobs  TEXT,          -- JSON: {[ref]: job_id}, só depois de confirmado
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_intake_draft_status  ON intake_draft (status);
CREATE INDEX idx_intake_draft_project ON intake_draft (project_id);
