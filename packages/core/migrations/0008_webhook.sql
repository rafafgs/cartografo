-- 0008_webhook — o transporte *push* dos eventos para fora (t142).
--
-- Fecha o ponto de extensão nº 5: a `t123` entregou a metade *pull* (o stream
-- SSE, que exige conexão aberta) e esta entrega a metade *push*, para quem
-- prefere receber um POST assinado. As duas leem o MESMO log pela MESMA função
-- (`listEvents`), e nenhuma das duas encosta no caminho de escrita: o
-- `recordEvent` não sabe que este arquivo existe, e é isso que faz um assinante
-- lento ou morto ser problema só dele.
--
-- Duas tabelas, e a divisão entre elas é a de sempre: o que foi CONTRATADO e o
-- que ACONTECEU.
--
-- `webhook_subscription` é o contrato:
--
-- - `secret` é dado pelo chamador, não gerado pelo servidor. Não há fluxo de
--   revelação única para construir (a `0007` tem o dela, para credencial), e
--   quem assina normalmente já tem um segredo do lado dele. Ele entra em texto
--   claro porque a assinatura é HMAC: diferente da credencial da `0007`, que só
--   precisa ser COMPARADA (e por isso vira digest), esta chave precisa ser
--   REUSADA a cada entrega. Nenhuma rota lê esta coluna de volta.
-- - `filter_types` é JSON e é anulável, e os dois estados são diferentes: NULO
--   é "todo tipo", `[]` nunca é gravado. A API valida os tipos contra o mesmo
--   catálogo do stream (`KNOWN_TYPES`) antes de gravar, então o que está aqui
--   já passou pela taxonomia.
-- - `initial_event_id` é o `MAX(event.id)` no instante da criação, e é o que
--   impede replay histórico por acidente: assinatura nova recebe o que for
--   gravado DAQUI para frente, exatamente como o stream sem `Last-Event-ID`.
--   Zero quando o log está vazio.
-- - `deactivated_at` é data, não flag — mesma razão do `revoked_at` da `0007`:
--   "quando deixou de valer" responde a uma pergunta de auditoria que um
--   booleano apaga. Nada é deletado (D15/D2), e é `deactivated_at IS NULL` que
--   separa assinatura viva de assinatura morta.
--
-- `webhook_delivery` é o que aconteceu, uma linha por (assinatura, evento):
--
-- - o `UNIQUE (subscription_id, event_id)` é o que torna o fan-out idempotente:
--   ele roda com `INSERT OR IGNORE`, então reprocessar a mesma janela — depois
--   de uma queda, de um restart, de um tick que morreu no meio — não duplica
--   entrega nenhuma. O mesmo índice serve à pergunta do cursor
--   ("`MAX(event_id)` desta assinatura"), que é de onde o fan-out retoma.
-- - o cursor NÃO é uma coluna mutável da assinatura: ele é derivado das
--   entregas já gravadas. Uma coluna a menos é um estado a menos para
--   discordar do que de fato foi enfileirado.
-- - `status` tem três valores e dois deles são terminais. `pending` é a fila,
--   `delivered` é o 2xx que chegou, `exhausted` é a desistência — seja por ter
--   passado do último degrau do backoff, seja porque a assinatura foi
--   desativada com a entrega ainda em voo. A linha não é apagada em nenhum dos
--   casos: "tentei seis vezes e desisti" é fato de auditoria.
-- - `next_attempt_at` é o relógio da fila, e nasce igual ao `created_at`:
--   entrega recém-enfileirada está vencida agora. Cada falha empurra essa data
--   pelo degrau correspondente do backoff (10s, 1min, 5min, 30min, 2h).
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE webhook_subscription (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  url               TEXT NOT NULL,
  secret            TEXT NOT NULL,          -- chave do HMAC, dada por quem assina
  filter_types      TEXT,                   -- JSON com tipos da taxonomia; NULO = todo tipo
  initial_event_id  INTEGER NOT NULL,       -- MAX(event.id) na criação (0 se o log está vazio)
  created_at        TEXT NOT NULL,
  deactivated_at    TEXT                    -- NULO = ativa, espelha credential.revoked_at (0007)
);

-- O fan-out varre as assinaturas vivas a cada tick, e é por projeto que ele
-- pergunta.
CREATE INDEX idx_webhook_subscription_active ON webhook_subscription (deactivated_at, project_id);

CREATE TABLE webhook_delivery (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id  INTEGER NOT NULL REFERENCES webhook_subscription(id),
  event_id         INTEGER NOT NULL REFERENCES event(id),
  status           TEXT NOT NULL CHECK (status IN ('pending','delivered','exhausted')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  delivered_at     TEXT,
  last_error       TEXT,
  UNIQUE (subscription_id, event_id)        -- fan-out idempotente e índice do cursor
);

-- A pergunta quente do tick: "o que está vencido agora?".
CREATE INDEX idx_webhook_delivery_pending ON webhook_delivery (status, next_attempt_at);
