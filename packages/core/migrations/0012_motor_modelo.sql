-- 0012_motor_modelo — the catalogue of models each engine offers (t166).
--
-- An engine is the runner's business: the control plane has never heard of one,
-- and still does not know what a `claude-code` is. What this table keeps is a
-- REPORT — a runner came up, asked its adapter which models exist, and said so.
-- It is the same posture as `POST /v1/runners`: whoever knows what is true on
-- that machine is the machine, and the server records what it said.
--
-- - `engine` is the name the adapter gives itself (`EngineAdapter.engineName`),
--   and it has no FK: there is no engine table, because an engine is not an
--   entity of the control plane. An engine starts existing here when somebody
--   reports one.
-- - `model_id` is the identifier that goes after `--model`/`-m`. Free text,
--   like `no.model` in the graph schema, and for the same reason: a closed enum
--   would force a migration per new model, and what refuses an unknown id is
--   the CLI, when the session opens.
-- - `label` is the readable name, when the adapter has one. NULL is normal.
-- - `source` says where the row came from: `cli` (the adapter asked the binary)
--   or `catalog` (the adapter's static list). It is `CHECK`ed because a third
--   value here is not new data, it is a mistake by whoever wrote it — and that
--   is what separates "the engine confirmed" from "the adapter believes".
--   Today both adapters always answer `catalog`: neither `claude --help` nor
--   `codex --help` exposes a query path, and that gap is written down in the
--   doc rather than painted over.
-- - `updated_at` is when the report arrived. Without it there is no telling
--   whether a catalogue is from now or from a runner that died last week.
--
-- **A report replaces, it never adds.** The unique index `(engine, model_id)`
-- is what makes the upsert possible, and the route deletes the engine's rows
-- before writing the new ones: merging would keep a model the engine stopped
-- offering alive forever, and the operator would read a menu that no longer
-- exists.
--
-- Both VALUES of `source` were born in English, being vocabulary of the
-- EngineAdapter interface, which is English throughout and is what produces
-- them — the same reasoning 0011 wrote down for `timeout_reason`'s `wall_clock`
-- and `silence`.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE engine_model (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  engine      TEXT NOT NULL,             -- the name the adapter gives itself
  model_id    TEXT NOT NULL,             -- what goes after --model / -m
  label       TEXT,                      -- NULL = the adapter gave no readable name
  source      TEXT NOT NULL
                CHECK (source IN ('cli', 'catalog')),
  updated_at  TEXT NOT NULL
);

-- An engine does not offer the same model twice. It is also what gives the
-- report a stable key to overwrite by.
CREATE UNIQUE INDEX idx_engine_model_unique ON engine_model (engine, model_id);
