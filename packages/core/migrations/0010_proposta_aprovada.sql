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
-- ## Por que a tabela inteira é reconstruída
--
-- O SQLite não tem `ALTER TABLE ... ALTER CONSTRAINT`: um CHECK só muda
-- reconstruindo a tabela. É o procedimento documentado (create novo → copia →
-- drop → rename), e é a primeira vez que este repositório o faz.
--
-- `PRAGMA defer_foreign_keys = ON` na primeira linha é o que torna o
-- procedimento seguro aqui, e é a parte que não é óbvia: `grafo.origem_proposta_id`
-- e `grafo_versao.proposta_id` referenciam `proposta`, e com as chaves
-- estrangeiras ligadas (`applyPragmas`) o `DROP TABLE` faz um DELETE implícito
-- que viola essas referências na hora. Adiar a checagem para o fecho da
-- transação resolve: lá a tabela `proposta` existe de novo, com os mesmos ids,
-- e toda referência volta a fechar. `PRAGMA foreign_keys` NÃO serviria — ele é
-- no-op dentro de uma transação, e quem transaciona aqui é `src/db/migrate.ts`.
-- O `defer_foreign_keys` se apaga sozinho no fim da transação.
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

PRAGMA defer_foreign_keys = ON;

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

INSERT INTO proposta_novo (id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                           status, versao_aplicada_id, motivo_reversao, motivo_rejeicao,
                           resultado, criado_em, atualizado_em)
SELECT id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
       status, versao_aplicada_id, motivo_reversao, NULL,
       resultado, criado_em, atualizado_em
  FROM proposta;

DROP TABLE proposta;

ALTER TABLE proposta_novo RENAME TO proposta;

CREATE INDEX proposta_por_grafo ON proposta (grafo_id);
