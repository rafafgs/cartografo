-- 0010_proposta_aprovada — o portão humano entra no vocabulário (t165).
--
-- A tela oferece Aprovar/Rejeitar desde a `t111`
-- (`packages/tela/src/public/actions.js`), e só oferece Aplicar em `aprovada`.
-- O banco não conhecia esse estado: o CHECK da `0002` só admitia
-- ('pendente', 'aplicada', 'revertida', 'rejeitada'), e a rota de aplicar
-- exigia `pendente`. O resultado era uma inbox inutilizável — o botão Aplicar
-- aparecia num estado inalcançável. Esta migração é a metade de banco de fechar
-- esse contrato:
--
--   pendente ──aprovar──▶ aprovada ──aplicar──▶ aplicada ──reverter──▶ revertida
--      │
--      └──rejeitar──▶ rejeitada
--
-- Duas mudanças, e nada mais:
--
-- - `status` ganha `'aprovada'` no CHECK;
-- - `proposta` ganha `motivo_rejeicao TEXT` (anulável), a justificativa escrita
--   por quem rejeitou. Ela NÃO mora em `resultado`: aquela coluna já carrega
--   duas histórias que nunca coexistem — o relatório do portão de soundness que
--   reprovou a proposta e o veredito da hipótese (`t112`) — e as três precisam
--   continuar distinguíveis por QUAL coluna conta a história.
--
-- Sem backfill, de propósito. As linhas `rejeitada` que já existem vieram do
-- portão de soundness, não de gente: `motivo_rejeicao = NULL` nelas é a verdade,
-- e a história delas continua em `resultado`, onde sempre esteve.
--
-- ## Por que a tabela inteira é reconstruída, e por que em SEIS passos
--
-- O SQLite não tem `ALTER TABLE ... ALTER CONSTRAINT`: um CHECK só muda
-- reconstruindo a tabela (cria nova → copia → dropa velha → renomeia). É a
-- primeira vez que este repositório faz isso, e o caminho ingênuo NÃO funciona
-- aqui — foi preciso descobrir na marra:
--
-- `grafo.origem_proposta_id` e `grafo_versao.proposta_id` referenciam
-- `proposta`. O control plane liga as chaves estrangeiras ANTES de migrar
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
-- adiar nem para resolver. As linhas de `grafo`/`grafo_versao` terminam com
-- exatamente o valor que tinham (os ids são copiados, não regerados), o que
-- mantém o append-only da D15 honesto: nenhuma delas conta uma história
-- diferente no fim da migração.
--
-- O índice `proposta_por_grafo` cai junto com a tabela e por isso é recriado.
-- O `AUTOINCREMENT` é preservado: com os ids copiados explicitamente, a
-- `sqlite_sequence` continua de onde parou, e uma proposta nova nunca reusa o id
-- de uma antiga — o que importa porque `grafo_versao.proposta_id` aponta para
-- eles.
--
-- Nomes de coluna seguem em português, como o resto de `proposta` (D18 escopa a
-- regra de inglês a identificadores de código).
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

-- 1. guarda quem aponta para uma proposta, e solta os ponteiros
CREATE TEMP TABLE referencia_grafo_versao AS
  SELECT id, proposta_id FROM grafo_versao WHERE proposta_id IS NOT NULL;
CREATE TEMP TABLE referencia_grafo AS
  SELECT id, origem_proposta_id FROM grafo WHERE origem_proposta_id IS NOT NULL;

UPDATE grafo_versao SET proposta_id = NULL WHERE proposta_id IS NOT NULL;
UPDATE grafo SET origem_proposta_id = NULL WHERE origem_proposta_id IS NOT NULL;

-- 2. a tabela nova, com o vocabulário novo e a coluna nova
CREATE TABLE proposta_novo (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  grafo_id            TEXT NOT NULL REFERENCES grafo(id),
  versao_alvo         TEXT NOT NULL REFERENCES grafo_versao(id),
  operacoes           TEXT NOT NULL,   -- JSON: Operation[] (src/domain/operations.ts)
  evidencia           TEXT NOT NULL,   -- JSON
  metrica_esperada    TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente', 'aprovada', 'aplicada', 'revertida', 'rejeitada')),
  versao_aplicada_id  TEXT REFERENCES grafo_versao(id),
  motivo_reversao     TEXT,
  motivo_rejeicao     TEXT,            -- só o portão humano escreve aqui (t165)
  resultado           TEXT,            -- JSON; relatório do portão de soundness, ou veredito da hipótese
  criado_em           TEXT NOT NULL,
  atualizado_em       TEXT NOT NULL
);

-- 3. a cópia, com os ids preservados
INSERT INTO proposta_novo (id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                           status, versao_aplicada_id, motivo_reversao, motivo_rejeicao,
                           resultado, criado_em, atualizado_em)
SELECT id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
       status, versao_aplicada_id, motivo_reversao, NULL,
       resultado, criado_em, atualizado_em
  FROM proposta;

-- 4. a troca
DROP TABLE proposta;

ALTER TABLE proposta_novo RENAME TO proposta;

CREATE INDEX proposta_por_grafo ON proposta (grafo_id);

-- 5. as referências voltam para exatamente onde estavam
UPDATE grafo_versao
   SET proposta_id = (SELECT proposta_id FROM referencia_grafo_versao
                       WHERE referencia_grafo_versao.id = grafo_versao.id)
 WHERE id IN (SELECT id FROM referencia_grafo_versao);

UPDATE grafo
   SET origem_proposta_id = (SELECT origem_proposta_id FROM referencia_grafo
                              WHERE referencia_grafo.id = grafo.id)
 WHERE id IN (SELECT id FROM referencia_grafo);

-- 6. e as tabelas de apoio não sobrevivem à migração
DROP TABLE referencia_grafo_versao;
DROP TABLE referencia_grafo;
