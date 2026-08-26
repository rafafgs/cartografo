-- 0007_credential — the credential the API demands on every business route.
--
-- Closes the hole the repository has carried since D1/D11: the routes were born
-- without authentication on purpose (that was this ticket's decision, not
-- theirs), and the control plane is the system's only writer. From here on,
-- `/v1/*` without a valid credential is denied; `/health` stays open, because
-- whoever queries it is a supervisor that needs to know whether the process is
-- alive BEFORE any credential exists.
--
-- What the table keeps — and what it deliberately does NOT keep:
--
-- - `hash` is the SHA-256 digest of the raw token, in hex, and it is the only
--   form of it that touches the disk. The raw value is returned once, at the
--   moment it is issued, and after that it exists nowhere: whoever walks off
--   with the database file walks off with nothing that authenticates. There is
--   no slow KDF here (bcrypt/scrypt) because the token is a secret generated
--   with 32 bytes of entropy, not a password chosen by a person — brute force
--   over it is not the risk.
-- - `owner_type` already accepts `runner` even though nothing in this ticket
--   issues a runner credential. Declaring the value now costs one line;
--   finding out later that it is missing costs a second migration on this same
--   table. Runner pairing (and revocation) is the next ticket, which depends on
--   this one.
-- - `runner_id` is nullable and only makes sense when `owner_type = 'runner'`:
--   an operator credential belongs to no machine.
-- - `revoked_at` is a date, not a flag: "when it stopped being valid" answers
--   an audit question a boolean erases. Nothing is deleted (D15/D2), and it is
--   `revoked_at IS NULL` that separates a live credential from a dead one.
--
-- `owner_type` and not `type`: it is one of the three QUALIFIED rows of §4.2 of
-- the glossary, because `tipo` meant three things in three tables and here it
-- means whose the credential is.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE credential (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('user', 'runner')),
  runner_id   TEXT REFERENCES runner(id), -- only for owner_type = 'runner'
  hash        TEXT NOT NULL UNIQUE,       -- SHA-256 hex of the raw token, never the token
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- There is exactly one hot read path, and it runs per request: find the live
-- credential from the hash presented. `hash`'s UNIQUE already indexes that; the
-- one below serves the other question, the startup's — "does an operator
-- credential exist already?".
CREATE INDEX idx_credential_type ON credential (owner_type, revoked_at);
