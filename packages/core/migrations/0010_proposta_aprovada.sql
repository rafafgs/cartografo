-- 0010_proposta_aprovada — o portão humano entra no vocabulário (t165).
--
-- A tela oferece Aprovar/Rejeitar desde a `t111`
-- (`packages/tela/src/public/actions.js`), e só oferece Aplicar em `approved`.
-- O banco não conhecia esse estado: o CHECK da `0002` só admitia
-- ('pending', 'applied', 'reverted', 'rejected'), e a rota de aplicar
-- exigia `pending`. O resultado era uma inbox inutilizável — o botão Aplicar
-- aparecia num estado inalcançável. Esta migração é a metade de banco de fechar
-- esse contrato:
--
--   pending ──aprovar──▶ approved ──aplicar──▶ applied ──reverter──▶ reverted
--      │
--      └──rejeitar──▶ rejected
--
-- Duas mudanças, e nada mais:
--
-- - `status` ganha `'approved'` no CHECK;
-- - `proposal` ganha `rejection_reason TEXT` (anulável), a justificativa escrita
--   por quem rejeitou. Ela NÃO mora em `result`: aquela coluna já carrega
--   duas histórias que nunca coexistem — o relatório do portão de soundness que
--   reprovou a proposta e o veredito da hipótese (`t112`) — e as três precisam
--   continuar distinguíveis por QUAL coluna conta a história.
--
-- Sem backfill, de propósito. As linhas `rejected` que já existem vieram do
-- portão de soundness, não de gente: `rejection_reason = NULL` nelas é a
-- verdade, e a história delas continua em `result`, onde sempre esteve.
--
-- ## Por que a tabela inteira é reconstruída, e por que em SEIS passos
--
-- O SQLite não tem `ALTER TABLE ... ALTER CONSTRAINT`: um CHECK só muda
-- reconstruindo a tabela (cria nova → copia → dropa velha → renomeia). É a
-- primeira vez que este repositório faz isso, e o caminho ingênuo NÃO funciona
-- aqui — foi preciso descobrir na marra:
--
-- `graph.origin_proposal_id` e `graph_version.proposal_id` referenciam
-- `proposal`. O control plane liga as chaves estrangeiras ANTES de migrar
-- (`applyPragmas` e depois `migrate`, em `src/index.ts`), então o `DROP TABLE`
-- faz um DELETE implícito que viola as duas referências. `PRAGMA foreign_keys`
-- não ajuda: é no-op dentro de transação, e quem transaciona é
-- `src/db/migrate.ts`. E `PRAGMA defer_foreign_keys = ON` — o remédio óbvio, e
-- o que esta migração tentou primeiro — TAMBÉM não resolve: o contador de
-- violações adiadas sobe no DELETE implícito e o `RENAME` não o abaixa (ele não
-- insere linha nenhuma), então a transação simplesmente morre no fecho em vez de
-- morrer no meio. Um banco com uma única proposta já aplicada não migrava.
--
-- Daí os dois passos extras: as referências filhas são guardadas em tabelas
-- temporárias e zeradas ANTES do drop, e restauradas depois do rename. Com
-- ninguém apontando para a tabela no instante do drop, não há violação para
-- adiar nem para resolver. As linhas de `graph`/`graph_version` terminam com
-- exatamente o valor que tinham (os ids são copiados, não regerados), o que
-- mantém o append-only da D15 honesto: nenhuma delas conta uma história
-- diferente no fim da migração.
--
-- O índice `proposal_by_graph` cai junto com a tabela e por isso é recriado.
-- O `AUTOINCREMENT` é preservado: com os ids copiados explicitamente, a
-- `sqlite_sequence` continua de onde parou, e uma proposta nova nunca reusa o id
-- de uma antiga — o que importa porque `graph_version.proposal_id` aponta para
-- eles.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

-- 1. guarda quem aponta para uma proposta, e solta os ponteiros
CREATE TEMP TABLE reference_graph_version AS
  SELECT id, proposal_id FROM graph_version WHERE proposal_id IS NOT NULL;
CREATE TEMP TABLE reference_graph AS
  SELECT id, origin_proposal_id FROM graph WHERE origin_proposal_id IS NOT NULL;

UPDATE graph_version SET proposal_id = NULL WHERE proposal_id IS NOT NULL;
UPDATE graph SET origin_proposal_id = NULL WHERE origin_proposal_id IS NOT NULL;

-- 2. a tabela nova, com o vocabulário novo e a coluna nova
CREATE TABLE proposal_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            TEXT NOT NULL REFERENCES graph(id),
  target_version      TEXT NOT NULL REFERENCES graph_version(id),
  operations          TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT REFERENCES graph_version(id),
  revert_reason       TEXT,
  rejection_reason    TEXT,            -- só o portão humano escreve aqui (t165)
  result              TEXT,            -- JSON; relatório do portão de soundness, ou veredito da hipótese
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- 3. a cópia, com os ids preservados
INSERT INTO proposal_new (id, graph_id, target_version, operations, evidence, expected_metric,
                          status, applied_version_id, revert_reason, rejection_reason,
                          result, created_at, updated_at)
SELECT id, graph_id, target_version, operations, evidence, expected_metric,
       status, applied_version_id, revert_reason, NULL,
       result, created_at, updated_at
  FROM proposal;

-- 4. a troca
DROP TABLE proposal;

ALTER TABLE proposal_new RENAME TO proposal;

CREATE INDEX proposal_by_graph ON proposal (graph_id);

-- 5. as referências voltam para exatamente onde estavam
UPDATE graph_version
   SET proposal_id = (SELECT proposal_id FROM reference_graph_version
                       WHERE reference_graph_version.id = graph_version.id)
 WHERE id IN (SELECT id FROM reference_graph_version);

UPDATE graph
   SET origin_proposal_id = (SELECT origin_proposal_id FROM reference_graph
                              WHERE reference_graph.id = graph.id)
 WHERE id IN (SELECT id FROM reference_graph);

-- 6. e as tabelas de apoio não sobrevivem à migração
DROP TABLE reference_graph_version;
DROP TABLE reference_graph;
