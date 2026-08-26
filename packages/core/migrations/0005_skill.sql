-- 0005_skill — the capability registry (D4, D9).
--
-- Numbered 0005 provisionally: other wave-2 tickets run in parallel and
-- `src/db/migrate.ts` fails loudly on a repeated number, so renumbering at the
-- merge is mandatory, not cosmetic — the same precedent already recorded in
-- 0003's header.
--
-- "A skill with no contract does not enter the registry" (D9) becomes, here, a
-- table whose columns ARE the twelve mandatory fields of the manifest
-- (`specs/formats/skill-manifest.schema.json`), plus the stamp of when the
-- skill entered. No generic blob: what the synthesizer queries is
-- `description` and `role`, what the runner pins is `id`+`version`+`hash`, and
-- one column per field is what lets those three reads be a query rather than a
-- deserialization.
--
-- `id` is the PRIMARY KEY, and it is TEXT because the skill's identity is the
-- kebab-case of the manifest, not an autoincrement: that name is how the graph
-- pins the node (`skill_ref.id`). Registration is create-only in this ticket —
-- a second POST on the same id is a 409. Reimport, diff and skill version
-- history (the equivalent of the graph/graph_version pair) wait until two
-- consumers exist, by the rule of two consumers.
--
-- The structured fields (`input`, `output`, `preconditions`, `checks`,
-- `permissions`, `source`) live as JSON in TEXT, the same way
-- `graph_version.snapshot` and `input_request.options` do: they are documents
-- of the format, and slicing them into tables would pin down, in a database
-- schema, a specification that is still a versioned product (t97).
--
-- The `CHECK` on `role` is the only enum the database enforces: it is the field
-- that decides whether the node produces or checks, and a work skill
-- registered as a gate becomes a gate that checks nothing. The two values are
-- the graph document's `node_type` values (`work`, `gate`) — the glossary
-- reuses the name the format already publishes instead of inventing a second
-- one. The rest of the validation (hash agreeing with the content, at least one
-- check at import, unrestricted network refused, `resultado` on a gate's
-- output) lives in `src/repositories/skill.ts`: those are rules about the
-- content of the JSON, and SQLite is not where one explains why one of them
-- failed.
--
-- No migration opens a transaction of its own: what transacts is src/db/migrate.ts.

CREATE TABLE skill (
  id             TEXT PRIMARY KEY,
  version        TEXT NOT NULL,
  hash           TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('work', 'gate')),
  description    TEXT NOT NULL,
  input          TEXT NOT NULL,   -- JSON
  output         TEXT NOT NULL,   -- JSON
  preconditions  TEXT NOT NULL,   -- JSON array
  checks         TEXT NOT NULL,   -- JSON array
  permissions    TEXT NOT NULL,   -- JSON
  instructions   TEXT NOT NULL,
  source         TEXT NOT NULL,   -- JSON: {type, repo?, ref?, imported_by?, imported_at?, reviewed_by?}
  registered_at  TEXT NOT NULL
);
