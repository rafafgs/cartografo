-- 0021_proposta_dedupe_key — sinal repetido reforça a proposta pendente (t246, D21).
--
-- O `POST /v1/proposals` gravava uma linha `pending` nova a cada chamada, sem
-- perguntar nada. As duas lentes que existem rodam à mão e podem rodar mais de
-- uma vez sobre o mesmo sinal — a de custo dizia isso em voz alta no próprio
-- comentário (`packages/topografo-custo/src/cli.ts`): "não deduplica. Rodar duas
-- vezes sobre a mesma telemetria cria propostas repetidas". A D21
-- (`DECISIONS.md`) fecha essa lacuna no único lugar que consegue valer para todo
-- chamador de uma vez, que é o control plane.
--
-- - `dedupe_key` é o sha256 canonicalizado da tripla `[lens, target_version,
--   operations]` (`src/domain/hash.ts`, `proposalDedupeKey`). Quem calcula é
--   SEMPRE o servidor: a chave não é aceita no corpo, não é lida de lá e não
--   volta na resposta. `lens` sai de `evidence.lens`, que é onde a lente de
--   custo já a carrega desde a t255; quem não manda lente nenhuma cai no balde
--   `null`, que é a mesma regra de "não clone um repetido idêntico" valendo de
--   graça para ela também.
-- - **`graph_id` não entra na chave**, e não é esquecimento: `target_version` é o
--   hash de conteúdo de UMA versão de UM grafo, então ele já escopa a proposta
--   sozinho. Uma dimensão a mais só daria a impressão de escopo que já existe.
-- - **A ordem das operações conta**, e não é normalizada antes do hash: duas
--   listas com as mesmas operações em ordem diferente são duas propostas. A ordem
--   decide qual documento intermediário é válido no meio da aplicação, e colapsá-la
--   confundiria diffs que não são equivalentes.
--
-- O índice é PARCIAL, e é aí que mora a semântica da decisão: o que não pode
-- existir duas vezes é a mesma tripla PENDENTE. Uma tripla que já foi rejeitada,
-- aplicada ou revertida não bloqueia nada — repor o mesmo sinal depois disso abre
-- uma proposta nova, `201`, porque a decisão anterior é passado e o sinal é
-- presente. A alternativa (índice sobre a tabela inteira) tornaria uma rejeição
-- permanente e silenciosa, o que a D21 não pede em lugar nenhum.
--
-- Anulável e sem backfill, como `output` na 0020 e `rejection_reason` na 0010:
-- banco de desenvolvimento é recriado (D20), não existe dado de produção, e o
-- próprio SQLite trata NULO como sempre distinto num índice único — várias linhas
-- antigas com `dedupe_key` NULO nunca colidem entre si. Não há valor a inventar
-- para uma proposta escrita antes de alguém estar deduplicando, e inventar um
-- seria gravar no banco um fato que ninguém calculou.
--
-- A coluna é bookkeeping interno: ela não entra na interface `Proposal` de
-- `src/repositories/proposals.ts` nem sai por `toProposal()`.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

ALTER TABLE proposal ADD COLUMN dedupe_key TEXT;  -- NULO = escrita antes desta migração, ou sem lente na evidência

CREATE UNIQUE INDEX proposal_dedupe_key_pending_unique
  ON proposal (dedupe_key)
  WHERE status = 'pending';
