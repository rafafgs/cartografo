-- 0022_execucao_finalizada — the execution becomes the subject of an event (D21, t245).
--
-- Born 0021 provisionally and renumbered to 0022 at the merge, for exactly the
-- reason the provisional header anticipated: t246 reached main first with
-- `0021_proposta_dedupe_key.sql` and `src/db/migrate.ts` fails loudly on a
-- repeated number — the same precedent recorded in the headers of 0003, 0005,
-- 0017 and 0019. No dependency order between the two: that one adds a column
-- and an index on `proposal`, this one only touches `event`'s CHECK, so running
-- afterwards changes nothing about what it does.
--
-- ## What changes, and what does not
--
-- One thing only: `event.entity_type` starts admitting `'execution'`, alongside
-- the five 0003 wrote (and that t235 rewrote into the envelope's English). No
-- column is born, no column leaves, no value is rewritten in the copy.
--
-- What deliberately does NOT happen here is the `execution` table. 0003 said,
-- in its own header, that "there is no 'execution' table... the taxonomy never
-- listed execution as a valid `entity.type`", and the half of that sentence D21
-- amends is only the second: the round gains a FACT that only the control plane
-- asserts (D1) — `execution.finished` — and a fact needs a subject. There is
-- still no row to read: `execution_id` remains an opaque INTEGER grouper, and
-- the `finished_at` the API publishes is derived from this event at read time
-- (`src/repositories/job.ts`), never a column.
--
-- ## Why the whole table is rebuilt
--
-- SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`: a CHECK only changes by
-- recreating the table (create the new one → copy → drop the old → rename), the
-- path 0010 opened and 0019 repeated. Here it is the short one, as in 0019 and
-- for the same concrete reason: nobody references `event`. There is no foreign
-- key pointing at it — the log is the source, and whoever crosses it with the
-- rest of the database does so by `entity_type`/`entity_id`, which are loose
-- TEXT on purpose (one log for six entities, and one of them has a hash for an
-- id) — so there is no step of saving and restoring child references, the one
-- 0010 had to find out the hard way.
--
-- The three indexes fall with the table and are therefore recreated identical.
-- The `AUTOINCREMENT` is preserved and the ids are copied explicitly, which
-- matters more here than in any other migration of this repository: an event's
-- `id` IS the order of the log and the only total ordering that exists
-- (`specs/events/taxonomy.md`), and a replay after this migration has to
-- rebuild exactly the same state as before it. Copying is honest append-only:
-- no row tells a different story at the end.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE event_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  project_id  INTEGER NOT NULL,
  execution_id INTEGER,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('job','session','input_request','lease','graph_version','execution')),
  entity_id   TEXT NOT NULL,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_ref   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL
);

INSERT INTO event_new (id, type, project_id, execution_id, entity_type, entity_id,
                       actor_type, actor_ref, occurred_at, data)
SELECT id, type, project_id, execution_id, entity_type, entity_id,
       actor_type, actor_ref, occurred_at, data
  FROM event;

DROP TABLE event;

ALTER TABLE event_new RENAME TO event;

CREATE INDEX idx_event_entity     ON event (entity_type, entity_id);
CREATE INDEX idx_event_execution  ON event (execution_id);
CREATE INDEX idx_event_project    ON event (project_id);
