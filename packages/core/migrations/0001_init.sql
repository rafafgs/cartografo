-- 0001_init — tabela de controle do próprio runner de migração.
--
-- É a única tabela deste scaffold: o schema de domínio (graph, graph_version,
-- proposal, event, session, input_request) entra nas tickets seguintes, na
-- ordem da D6.
--
-- Nenhuma migração abre transação própria: quem transaciona é
-- `src/db/migrate.ts`, uma transação por migração.

CREATE TABLE schema_migrations (
  id         TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
