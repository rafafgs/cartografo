-- 0037_runner_liveness — a runner is present while it says so, and one
-- installation is one row (t491, FR3/FR5).
--
-- Number provisional and kept, the way 0028's header records: another ticket
-- landing `0037` first is the conflict git does not report, and
-- `src/db/migrate.ts` fails loudly on a repeated number. Renumber at the merge.
--
-- **What was wrong.** `select * from runner` showed six rows for one physical
-- machine, all `obj-rafaelgomesmac-<pid>`, because the runner's default identity
-- was `${hostname()}-${process.pid}` — a fresh value every process start — and
-- nothing ever removed a row once it existed. Pairing was idempotent by exact
-- id, which an id that changes every restart never gets the chance to be
-- against. The founder read the board as "several machines" because that is
-- exactly what the data said.
--
-- **Two columns and no third table.** `status` says whether the machine
-- deregistered; `last_seen_at` says when it last spoke. Presence is the
-- conjunction of the two, computed in the `WHERE` clause of the two listings
-- (`repositories/runners.ts`) — there is no background sweep, no cron and no
-- timer, so nothing has to be started or stopped for a fleet to be honest.
--
-- **No CHECK on `status`.** `0035_input_request_origin.sql` states the reasoning
-- directly ("an enum in SQL is an enum that costs a table rebuild per new
-- word"), and `job.blocked` and `input_request.origin` both ship unconstrained
-- for the same reason. The repository layer is what knows the two words.
--
-- **`last_seen_at` is backfilled from `registered_at`**, never left at the
-- default: presence compares strings lexicographically (the same posture
-- `leases.ts` has for `expires_at`), and an empty string would make every row
-- that predates this migration permanently absent — including the one row per
-- host this migration is trying to keep.
--
-- **Nothing is deleted, and that is a constraint and not a preference.**
-- `credential.runner_id` and `lease.runner_id` reference `runner(id)` under
-- `PRAGMA foreign_keys = ON` (`src/db/connection.ts`), so removing a row a
-- credential still points at would either throw or force a cross-table cleanup
-- that is explicitly out of this ticket's scope. The reconciliation is a status
-- flip, in place.
--
-- English top to bottom (2026-08-18 language mandate).
--
-- No migration opens a transaction of its own: src/db/migrate.ts is what transacts.

ALTER TABLE runner ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE runner ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';

UPDATE runner SET last_seen_at = registered_at WHERE last_seen_at = '';

-- Collapse the legacy PID-suffixed duplicates of one host. The old default id
-- was `${hostname()}-${pid}`, so an id ending in "-<all digits>" is that shape,
-- and stripping the suffix recovers the hostname it was born from. Anything
-- that does NOT end that way — an explicit `--runner-id`, or the new hash-based
-- default, whose eight hex characters are not reliably numeric — is left alone
-- as its own group of one and stays 'active'.
--
-- The window function, and not `MAX(registered_at)` with bare columns: SQLite
-- would answer that too, but the tie-break between two rows registered in the
-- same millisecond would be its choice and not this file's — the same reasoning
-- `listRunnersWithHealth` already writes down for the lease it calls the last
-- expired one.
UPDATE runner
   SET status = 'retired'
 WHERE id NOT IN (
   SELECT id FROM (
     SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY rtrim(rtrim(id, '0123456789'), '-')
              ORDER BY registered_at DESC, id DESC
            ) AS recency
       FROM runner
   )
   WHERE recency = 1
 );
