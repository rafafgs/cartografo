-- 0016_gancho — a reação que o próprio grafo declara (t169).
--
-- A `0008` deu ao control plane o transporte *push* para quem REGISTRA uma
-- assinatura pela API. Esta dá o outro dono possível de uma reação: o próprio
-- documento de grafo. A diferença não é de transporte — os dois fazem POST
-- assinado com o mesmo HMAC e o mesmo backoff — é de QUEM decide, e é ela que
-- justifica uma tabela em vez de reuso de `webhook_delivery`:
--
-- - um gancho não tem etapa de registro. Ele nasce dentro do snapshot da versão
--   de grafo, e some quando uma versão nova o remove — versionado e proponível
--   como qualquer outra parte do grafo (D2, D15);
-- - um gancho não tem fan-out nem cursor. Ele dispara UMA vez, direto do fato
--   que o disparou, dentro da mesma transação que gravou a projeção e o evento
--   (FR18). Não existe `subscription_id` em que pendurá-lo, e um `NULL` nessa
--   coluna seria exatamente a mentira que uma tabela própria evita;
-- - a `url` e o `secret` são COPIADOS para a linha de entrega em vez de lidos
--   do grafo na hora da tentativa. Uma versão nova do grafo pode trocar os dois,
--   e uma entrega em voo precisa terminar contra o destino que valia quando ela
--   foi enfileirada — não contra o que valeria hoje.
--
-- `UNIQUE (event_id, hook_id)` é cinto e suspensório, não a chave de
-- idempotência que o fan-out da `0008` precisa: um evento é gravado exatamente
-- uma vez, para sempre, então enfileirar duas vezes já seria bug de outra
-- ordem. O índice existe para que ele nunca vire dado duplicado se acontecer.
--
-- `node_id` é coluna e não derivação: o evento `job.hook_failed` precisa
-- dizer de QUAL nó a reação era, e reabrir o snapshot da versão no instante do
-- esgotamento seria fazer o registro de um incidente depender de uma leitura
-- que pode falhar. A linha carrega tudo que o incidente precisa declarar.
--
-- `status` tem os mesmos três valores da `0008`, e pela mesma razão: `pending`
-- é a fila, `delivered` é o 2xx que chegou, `exhausted` é a desistência depois do
-- último degrau do backoff. Nada é apagado (D15/D2) — "tentei seis vezes e
-- desisti" é fato de auditoria, e aqui ele também vira evento.
--
-- Nenhuma migração abre transação própria: quem transaciona é src/db/migrate.ts.

CREATE TABLE hook_delivery (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  execution_id      INTEGER,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  hook_id           TEXT NOT NULL,          -- id do gancho DENTRO do documento
  node_id           TEXT NOT NULL,          -- nó cuja entrada/bloqueio disparou
  graph_version_id  TEXT NOT NULL,          -- solto como job.graph_version_id
  event_id          INTEGER NOT NULL REFERENCES event(id),
  url               TEXT NOT NULL,          -- copiada do grafo no enfileiramento
  secret            TEXT NOT NULL,          -- chave do HMAC, idem
  status            TEXT NOT NULL CHECK (status IN ('pending','delivered','exhausted')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  last_error        TEXT,
  UNIQUE (event_id, hook_id)                -- defesa em profundidade, não cursor
);

-- A pergunta quente do tick, espelhando idx_webhook_delivery_pending.
CREATE INDEX idx_hook_delivery_pending ON hook_delivery (status, next_attempt_at);
