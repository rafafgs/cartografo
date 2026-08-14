-- 0005_intake — o intake de duas fases: rascunho, confirmação, dependência.
--
-- A D3 separa dois atos do meta-processo: sintetizar topologia produz NÓS (uma
-- vez por classe) e quebrar trabalho produz TICKETS (a cada execução). Esta
-- migração é a segunda metade: um rascunho de quebra que existe antes de
-- qualquer `trabalho`, e que só vira trabalho depois de confirmação humana
-- (README, princípio 5, aplicado à quebra de trabalho — nunca ao grafo).
--
-- Três mudanças, e o motivo de cada uma:
--
-- - `trabalho.corpo` e `trabalho.criterios_de_aceite`. A taxonomia de eventos
--   já antecipava um trabalho com conteúdo (o exemplo de `trabalho.emendado`
--   cita campos que a 0003 nunca criou). Os critérios que o intake grava são
--   PRELIMINARES: quem os produz de verdade é o nó `refinar` do grafo de
--   fábrica 1, a partir do pedido bruto. NULL e [] são coisas diferentes —
--   "ninguém escreveu critério ainda" não é "declarei que não há critério".
-- - `trabalho_dependencia`. Aresta entre dois trabalhos do mesmo lote,
--   declarada na confirmação. Só REGISTRO: nada aqui bloqueia o trabalho
--   dependente enquanto a dependência está aberta (t122, FR14). O CHECK
--   impede a auto-referência que o validador de domínio já rejeita antes —
--   duas linhas de defesa para o mesmo absurdo.
-- - `intake_rascunho`. Armazenamento de trabalho em curso, não fato de
--   auditoria: nenhum evento é emitido na criação, edição ou descarte do
--   rascunho. O log só ganha linha quando os `trabalho` de fato nascem.
--
-- `itens` e `trabalhos_criados` são JSON em coluna TEXT, como `sessao.uso` e
-- `pergunta.opcoes` já fazem: o formato do item ainda não congelou (regra dos
-- dois consumidores) e normalizar em tabela agora custaria uma migração a cada
-- campo novo do rascunho.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

ALTER TABLE trabalho ADD COLUMN corpo TEXT;
ALTER TABLE trabalho ADD COLUMN criterios_de_aceite TEXT; -- JSON: string[]; NULL != []

CREATE TABLE trabalho_dependencia (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  trabalho_id            INTEGER NOT NULL REFERENCES trabalho(id),
  depende_de_trabalho_id INTEGER NOT NULL REFERENCES trabalho(id),
  criado_em              TEXT NOT NULL,
  CHECK (trabalho_id != depende_de_trabalho_id)
);
CREATE UNIQUE INDEX idx_trabalho_dependencia_par ON trabalho_dependencia (trabalho_id, depende_de_trabalho_id);
CREATE INDEX idx_trabalho_dependencia_trabalho ON trabalho_dependencia (trabalho_id);

CREATE TABLE intake_rascunho (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  projeto_id        INTEGER NOT NULL,
  execucao_id       INTEGER,
  classe            TEXT NOT NULL,
  pedido            TEXT NOT NULL,
  itens             TEXT NOT NULL, -- JSON: {ref, titulo, corpo?, criterios_de_aceite?, depende_de?}[]
  status            TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'confirmado', 'descartado')),
  trabalhos_criados TEXT,          -- JSON: {[ref]: trabalho_id}, só depois de confirmado
  criado_em         TEXT NOT NULL,
  atualizado_em     TEXT NOT NULL
);
CREATE INDEX idx_intake_rascunho_status  ON intake_rascunho (status);
CREATE INDEX idx_intake_rascunho_projeto ON intake_rascunho (projeto_id);
