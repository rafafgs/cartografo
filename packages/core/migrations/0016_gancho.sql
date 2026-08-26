-- 0016_gancho — the reaction the graph itself declares (t169).
--
-- `0008` gave the control plane the *push* transport for whoever REGISTERS a
-- subscription through the API. This one gives a reaction's other possible
-- owner: the graph document itself. The difference is not one of transport —
-- both make a signed POST with the same HMAC and the same backoff — it is one
-- of WHO decides, and that is what justifies a table instead of reusing
-- `webhook_delivery`:
--
-- - a hook has no registration step. It is born inside the graph version's
--   snapshot, and disappears when a new version removes it — versioned and
--   proposable like any other part of the graph (D2, D15);
-- - a hook has neither fan-out nor cursor. It fires ONCE, straight from the
--   fact that fired it, inside the same transaction that wrote the projection
--   and the event (FR18). There is no `subscription_id` to hang it on, and a
--   `NULL` in that column would be exactly the lie a table of its own avoids;
-- - the `url` and the `secret` are COPIED onto the delivery row instead of read
--   from the graph at attempt time. A new version of the graph may change both,
--   and a delivery in flight has to finish against the destination that held
--   when it was queued — not against the one that would hold today.
--
-- `UNIQUE (event_id, hook_id)` is belt and braces, not the idempotency key
-- `0008`'s fan-out needs: an event is written exactly once, forever, so queuing
-- twice would already be a bug of another order. The index exists so that it
-- never becomes duplicated data if it happens.
--
-- `node_id` is a column and not a derivation: the `job.hook_failed` event needs
-- to say WHICH node the reaction belonged to, and reopening the version's
-- snapshot at the moment of exhaustion would make recording an incident depend
-- on a read that can fail. The row carries everything the incident needs to
-- declare.
--
-- `status` has the same three values as `0008`, and for the same reason:
-- `pending` is the queue, `delivered` is the 2xx that arrived, `exhausted` is
-- giving up after the last step of the backoff. Nothing is erased (D15/D2) — "I
-- tried six times and gave up" is an audit fact, and here it becomes an event
-- as well.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE hook_delivery (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        INTEGER NOT NULL,
  execution_id      INTEGER,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  hook_id           TEXT NOT NULL,          -- id of the hook INSIDE the document
  node_id           TEXT NOT NULL,          -- node whose entry/block fired it
  graph_version_id  TEXT NOT NULL,          -- loose, like job.graph_version_id
  event_id          INTEGER NOT NULL REFERENCES event(id),
  url               TEXT NOT NULL,          -- copied from the graph at queue time
  secret            TEXT NOT NULL,          -- the HMAC key, likewise
  status            TEXT NOT NULL CHECK (status IN ('pending','delivered','exhausted')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  delivered_at      TEXT,
  last_error        TEXT,
  UNIQUE (event_id, hook_id)                -- defence in depth, not a cursor
);

-- The tick's hot question, mirroring idx_webhook_delivery_pending.
CREATE INDEX idx_hook_delivery_pending ON hook_delivery (status, next_attempt_at);
