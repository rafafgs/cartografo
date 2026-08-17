-- 0018_segredo_gancho — a chave que o gancho REFERENCIA, fora do documento (t194).
--
-- A `0016` deixou o `secret` do gancho dentro do snapshot da versão de grafo.
-- O snapshot é endereçado por conteúdo (D15), servido inteiro por
-- `GET /v1/graph-versions/:id`, escrito em disco pelo `cartografo export` e
-- copiado byte a byte para o atlas que a D7 manda publicar — ou seja, todo
-- leitor do documento era leitor do segredo, e rotacionar uma chave vazada
-- virava uma versão nova com a chave velha e a nova lado a lado no diff.
--
-- Esta tabela é a outra metade do conserto: o documento passa a carregar um
-- `destination.secret_ref` (um NOME), e o valor mora aqui — no banco de que só
-- o control plane escreve (D1), como a `credential` da `0007` e o
-- `webhook_subscription.secret` da `0008`. Nenhum dos dois jamais foi conteúdo
-- versionado, e o gancho passa a seguir a mesma regra.
--
-- `value` fica em texto claro, e isso é deliberado: a assinatura é HMAC, então
-- a chave precisa ser REUSADA a cada entrega — ela não pode virar digest como o
-- token da `0007`. É exatamente a postura do `webhook_subscription.secret`, e
-- nada aqui a muda: o que muda é ONDE a chave mora, não como.
--
-- `revoked_at` em vez de `DELETE`, e uma linha nova em vez de `UPDATE value`:
-- "quando esta chave parou de valer" é pergunta de auditoria que linha apagada
-- não responde, e rotacionar é um fato novo, não a correção de um fato antigo
-- (D15/D2). É o mesmo par que a `webhook_subscription` já faz com
-- `deactivated_at` — sem PATCH, re-registra.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE hook_secret (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,   -- o nome que destination.secret_ref referencia
  value       TEXT NOT NULL,   -- a chave crua do HMAC; reusada a cada entrega, como webhook_subscription.secret
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- No máximo um segredo VIVO por nome; rotacionar é revogar o antigo e inserir
-- um novo, nunca sobrescrever (D15/D2).
CREATE UNIQUE INDEX idx_hook_secret_name_alive
  ON hook_secret (name) WHERE revoked_at IS NULL;
