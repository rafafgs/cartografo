-- 0018_segredo_gancho — the key the hook REFERENCES, outside the document (t194).
--
-- `0016` left the hook's `secret` inside the graph version's snapshot. The
-- snapshot is content-addressed (D15), served whole by
-- `GET /v1/graph-versions/:id`, written to disk by `cartografo export` and
-- copied byte for byte into the atlas D7 orders published — which is to say,
-- every reader of the document was a reader of the secret, and rotating a
-- leaked key turned into a new version with the old key and the new one side by
-- side in the diff.
--
-- This table is the other half of the repair: the document now carries a
-- `destination.secret_ref` (a NAME), and the value lives here — in the database
-- only the control plane writes to (D1), like `0007`'s `credential` and
-- `0008`'s `webhook_subscription.secret`. Neither of those was ever versioned
-- content, and the hook now follows the same rule.
--
-- `value` stays in plain text, and that is deliberate: the signature is an
-- HMAC, so the key has to be REUSED on every delivery — it cannot become a
-- digest the way `0007`'s token does. It is exactly
-- `webhook_subscription.secret`'s posture, and nothing here changes it: what
-- changes is WHERE the key lives, not how.
--
-- `revoked_at` instead of `DELETE`, and a new row instead of `UPDATE value`:
-- "when this key stopped being valid" is an audit question a deleted row does
-- not answer, and rotating is a new fact, not the correction of an old one
-- (D15/D2). It is the same pair `webhook_subscription` already makes with
-- `deactivated_at` — no PATCH, re-register.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE hook_secret (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,   -- the name destination.secret_ref references
  value       TEXT NOT NULL,   -- the raw HMAC key; reused on every delivery, like webhook_subscription.secret
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- At most one LIVE secret per name; rotating is revoking the old one and
-- inserting a new one, never overwriting (D15/D2).
CREATE UNIQUE INDEX idx_hook_secret_name_alive
  ON hook_secret (name) WHERE revoked_at IS NULL;
