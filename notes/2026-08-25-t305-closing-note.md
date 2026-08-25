# t305 — `notas/` becomes `notes/`, and the `grafo.json` family becomes `graph.json`

**Date:** 2026-08-25 · **Branch:** `ticket-305` · **Subject:** the two D24
leftovers t282 refined and could not file, and t306 deferred by name.

Three commits: the gates first and red (`9c5008f`), the folder (`d0c4405`), the
graph-document family (`a5c4bc1`). 159 files, +851 / −369.

## What moved

| | Moved | Repointed | Occurrences rewritten |
|---|---|---|---|
| `notas/` → `notes/` | 27 notes, all `git mv` | 70 files | 139 |
| `grafo.json` family → `graph.json` | 4 files, all `git mv` | 75 files | 173 |

The family is `factory-graphs/asymmetric-bets/graph.json`,
`factory-graphs/software-development/graph.json`, `schema/graph.schema.json` and
`packages/runner/test/fixtures/graph-traversal.json`, plus the two hardcoded
runtime constants — `packages/core/src/cli/import.ts:351`'s bundle convention and
`packages/core/src/cli/export.ts:91`'s default output name — and the schema's
`$id`.

`git log --follow` crosses every rename: the bets `graph.json` reads back 12
commits to `0d1ac3a` (t116), the software `graph.json` 17 commits to `057c8df`
(t96), and `notes/2026-08-24-t293-closing-note.md` back through
t300, t299 and t293.

## The `grafo.json` decision, and its reason

t306's closing note deferred this ticket by name: "Renaming them changes a
contract... Their stems belong in `RETIRED_STEMS` on the day they move." The
decision this ticket had to make, and makes: **rename them.**

Every sibling artifact of the family was already English. The schema's own keys
moved at t178, its examples at t282, the two bundle directories and their
`problem_class` values at t306. What held the family back was never a reason to
keep the word — it was that no single ticket could move it: the name is a
directory convention a CLI hardcodes, a default output filename, and a token
inside a versioned URN, and moving any one of the three alone breaks the other
two. Moving all three at once is a whole ticket, and this is it.

`$id` goes from `urn:cartografo:schema:grafo:1.0.0` to
`urn:cartografo:schema:graph:1.0.0` and **stays at 1.0.0**. The document's shape
is untouched, so a bump would announce a format change that never happened.
No migration is written, for the reason t306 gave for `problem_class` and which
holds identically here: nothing persists either the URN or the filename — both
are read at import time and build time only, never stored — and per D7 the
repository is private and pre-launch with no shipped installation to carry
forward.

The old name is not a fallback. A bundle directory holding only `grafo.json` is
refused, naming the file it looked for:

```
$ cartografo import /tmp/legacy-bundle --url http://127.0.0.1:4319
cartografo: could not read "/tmp/legacy-bundle/graph.json"
cartografo: run `cartografo --help` for usage
$ echo $?
2
```

## The carve-out, and the two tests this ticket reopened

`ALLOWED_SEGMENTS` in `tests/no-portuguese-document-tree.test.mjs` is
`Object.freeze([])`. It held one entry, `notas`, described as a *standing
exception*.

**That entry was not wrong when it was written, and it is not being deleted
behind anybody's back.** t282's declared scope named four directories and did not
name this one, so it left the entry standing. t306 then landed while this ticket
sat in the backlog and hardened the framing — a matching `FROZEN_TREES` entry in
`tests/no-portuguese-path-segments.test.mjs`, and a test titled *"AT3 — the
carve-out is down to the one segment that is permanent (t282)"* asserting
`ALLOWED_SEGMENTS.length === 1` and `ALLOWED_SEGMENTS[0].segment === 'notas'`.
t306 had no way to know a ticket already existed to contest that label.

The founder's ruling on this ticket is that the label was his own mistake: D24's
allowed exceptions are the brand name `cartografo`, marked verbatim quotations
and the frozen migration file names, and a directory of working notes is none of
the three. So those two assertions "are not wrong, they are out of date", and
this ticket reopens them. Both the emptied list and the replacement test carry a
comment saying so, so that the next reader of the diff does not read it as a
permanent exception quietly dropped.

What replaced them is the stronger claim, and the one D24 actually makes about a
document tree: not "one segment is Portuguese forever" but "none is". The list
keeps its `standing exception` assertion for whoever adds the next entry.

`FROZEN_TREES` is kept and moved with the folder, to `['packages/core/migrations/',
'notes/']`. It is a different concern from the carve-out and always was: the
carve-out was about the DIRECTORY's name, and this is about the historical
FILENAMES under it — `2026-08-24-bets-assimetricas-closing-note.md` spelled
a retired name because that is what was true the day it was written. Separating
the two concerns is what let one move while the other stayed frozen. (t121 read
that one differently and renamed it to `notes/2026-08-24-t293-closing-note.md`:
the bundle it was named after no longer existed anywhere, which makes the name a
dangling reference rather than a record. The entry stays, prospectively.)

**`OWNER_TICKET` was already gone**, removed by t282 along with the assertion
that used it. Nobody needs to go looking for it.

## `cartografo import` against both renamed bundles (FR8)

Executed for real against a live control plane started from this checkout
(`node packages/core/bin/cartografo.mjs`, `migrationsApplied: 24`, fresh
`.cartografo/`, deleted again afterwards).

```
graph imported
  class             asymmetric-bets
  graph.id          asymmetric-bets
  graph_version.id  sha256:16b9397ea72400e0d1387cb3946f726b24953c6cef68cb0626c7b775425974fb
  skills            7 registered, 0 already in the registry

graph imported
  class             software-development
  graph.id          software-development
  graph_version.id  sha256:030c7fdd40ff061f8c292b75f2a384539ac74101ab58811a4b4eb339f47f5269
  skills            5 registered, 0 already in the registry
```

Both `graph_version.id`s are **byte-identical to the ones t306 recorded**, which
is the evidence that this rename reached the file's name and nothing inside it:
the snapshot hash is over the document, and the document did not move.
`GET /v1/classes` afterwards lists both and nothing else.

The export half of the round trip, with no `--out`:

```
graph exported
  class             software-development
  graph_version.id  sha256:030c7fdd40ff061f8c292b75f2a384539ac74101ab58811a4b4eb339f47f5269
  file              /tmp/…/software-development.graph.json
```

## The reintroduction reds (AC4's manual proof)

`notas/2026-08-18-action-plan.md` and
`factory-graphs/software-development/grafo.json` were reintroduced on scratch
paths, staged so `git ls-files` would see them, and reverted immediately after:

```
✖ AT1 — no tracked path carries a retired Portuguese stem
  AssertionError: a path in this repository is still named in Portuguese:
  factory-graphs/software-development/grafo.json: retired stem "grafo"
  notas/2026-08-18-action-plan.md: retired stem "notas"
```

The sibling gate reds on the same reintroduction, from the other direction:

```
✖ AT3a — the old folder is gone, and nothing was left behind in it
✖ AT3b — no tracked file outside notes/ still spells the folder by its old name
```

Both files removed, both gates green again, 13 passing.

## What the ticket did not know it was taking

### 1. The `grafo` stem reads straight through `cartografo`

The ticket's FR5 recorded a verification: "`grafo` does not match `graph`,
`paragraph`, or any tracked path". Two of those three hold. The third does not —
`grafo` is a substring of the brand name, and
`packages/core/bin/cartografo.mjs`, `packages/runner/bin/cartografo-runner.mjs`
and `docs/what-cartografo-is.md` are three real tracked paths. `AT1` of the
path gate went red on all three the first time the new stem ran.

The fix is not an exclusion list. The brand name is the FIRST of the three
exceptions D24 itself allows, so `offendersIn` now blanks it out of a path before
the stems read one — the same move the prose gates make with a gloss or a code
span. Blanked to a run of `#` of the same length rather than deleted, so two
neighbours can never be spliced into a match neither of them made, and narrow
enough that a hypothetical `cartografo-grafo.json` still trips `grafo` and
`packages/cartografo-tela/` still trips `tela`. `AT2` pins all three claims.

**This is the trap in adding any short stem to that gate**: the substring rule is
deliberate (it is what catches `especificacoes` from `especificac`), and the
project's own brand name is five letters of Portuguese that every future stem has
to be checked against.

### 2. t280's closing note names `grafo.json`, and the note is not editable

`tests/factory-bundle-closing-note.test.mjs` holds t280's note against the live
bundle, and the note names `grafo.json` in two of its tables — one row of `##
Line counts`, four rows of `## What resisted translation`. `AT1` compares the
note's file list to `bundleFiles()` as a set, so the rename broke it, and the
note is history that is not rewritten to match a later ticket.

`RENAMED_FILES` is where that goes, mapping `grafo.json` → `graph.json` with the
ticket that moved it — the same discipline `RETIRED_ROWS` already used for the
`desenvolvimento-de-software` row t306 retired. It translates names; it suppresses
nothing. Every row is still resolved and still checked, against the file the name
points at now, and a new `AT3` asserts the mapping names a pair the bundle really
has, so a stale entry reds instead of going blind.

The ticket's AC4 said "existing `AT2`/`AT3` continue to pass unmodified
otherwise" and did not anticipate `AT1`. It could not have: the interaction is
only visible once the bundle file actually moves.

### 3. A note citing `notas/x.md` as a style example is not a broken citation

`AT3c` of the new gate resolves every `notes/` citation against the disk. Its
first draft resolved link targets relative to the citing file, which turned
`notes/2026-08-25-t297-closing-note.md`'s illustration of the house citation
style — `` [`notas/x.md`](notas/x.md) `` — into `notes/notas/x.md` and reported
it as dead. The gate now requires a target to NAME `notes/`, not merely to land
inside it once resolved. That is what its docblock always claimed; the first
reading just did not implement the claim.

## What was deliberately not touched, and why

- **The notes' own prose.** It spells `notas/` in 46 places and keeps doing so.
  The founder split the redaction of sensitive content in eight of these notes
  into a follow-up sequenced strictly after this one, because a commit that both
  moves a file and rewrites it defeats git's rename detection — and the history
  of a repository about to be read by strangers is part of what they read. Rename
  first, redact second, and the diff of each stays legible. `AT3b` reads the tree
  OUTSIDE `notes/` for exactly this reason, and says so.
- **The historical filenames under `notes/`.** Not one was renamed. A note is
  named for what was true the day it was written.
- **`proposta-topografo.json`** (`packages/runner/src/surveyor/proposal.ts:82`) —
  a different Portuguese filename, explicitly out of scope, and the one the bulk
  sweep tried hardest to eat: `topografo.json` ends in `grafo.json`. The
  replacement carries a negative lookbehind for it. Worth knowing before the next
  mechanical pass over this word.
- **`sem-grafo.json` / `com-grafo.json`** in
  `packages/runner/test/dispatch/dispatch.test.ts` — a dispatch test's own
  Portuguese temp-file names, untracked and unrelated to the bundle convention.
- **The Portuguese literal at `packages/core/test/spec-database-citations.test.ts:492`**
  — a verbatim quotation of a spec line that no longer exists. Its subject IS the
  retired spelling.
- **`docs/o-que-e-o-cartografo.md`'s Portuguese filename** — out of scope since
  t282. Its `grafo.json` citation was repointed; the filename was not touched.
  (t121 closed it: the file is `docs/what-cartografo-is.md`.)
- **Recording D24 as a numbered `DECISIONS.md` entry.** Still unrecorded, still
  Rafael's or needing his explicit authorization. Every ticket in this series
  cites "D24" informally and `DECISIONS.md` still stops at D23.

## Two frozen artifacts this ticket did edit, on purpose

`packages/core/migrations/0009_sessao_transcricao.sql:4` and
`0023_schema_migrations_checksum.sql:2` cite `notas/` in their Portuguese
comments, and `0015_trabalho_campos_customizados.sql:14` cites
`schema/grafo.schema.json`. The migration convention freezes their NAMES — a
name is a migration's identity in `schema_migrations` — not their comments, and
t299 set the precedent when the ledger moved: its own gate's docblock lists "a
frozen migration's comment" among the nineteen files it repointed. Editing a
migration's body changes its checksum, which matters to a database that already
ran it; per D7 there is no such database outside a developer's own
`.cartografo/`, and this checkout's was created fresh and deleted.

The Portuguese in those comments is untouched. Only the path token moved.

## Gates

| Gate | Before | After |
|---|---|---|
| `cartografo` (core) | 685 | 686 |
| `@cartografo/cost-surveyor` | 46 | 46 |
| `@cartografo/runner` | 668 | 668 |
| `@cartografo/screen` | 126 | 126 |
| `@cartografo/surveyor` | 29 | 29 |
| root | 335 | 342 |

`npm ci` clean, then `npm test` (both groups), `npm run lint`, `npm run
typecheck`, `npm run build` — all green. No group lost a test.

The eight new root tests: five in `tests/notes-rename-integrity.test.mjs`, one
`AT3` for `RENAMED_FILES`, one `AT2` for the brand-name blanking, and t306's
`AT3` replaced one-for-one. The one new core test is the legacy-`grafo.json`
refusal.

`git ls-files | grep -E "(^|/)[^/]*(notas|grafo)[^/]*(/|$)"` returns four paths,
and all four are out of the sweep by name: `packages/core/migrations/0002_grafo_versao_proposta.sql`
(frozen), and `docs/what-cartografo-is.md`, `packages/core/bin/cartografo.mjs`,
`packages/runner/bin/cartografo-runner.mjs` (the brand name — which is why that
grep, like the gate, has to know about `cartografo`).

## What is still open

- **The redaction ticket.** Sensitive content — a security name, filing
  references, external filesystem paths — in `notes/2026-08-18-third-bets-run.md`,
  `notes/2026-08-18-n3-round.md`, `notes/execution-monitoring-prompt.md` and five
  other flagged files. Filed by Rafael as its own ticket, sequenced after this
  one. It will also be the natural moment to decide whether the notes' 46
  internal `notas/` citations move, since that ticket is already rewriting their
  contents.
- **The two staleness findings t306 logged and did not fix**: `docs/spec/graph.md`'s
  un-anglicised embedded JSON field names, and
  `packages/core/src/repositories/job.ts:430`'s stale `registrar-travessia`
  node-id comment. Neither is this ticket's, both are still there.
- **D24 as a numbered decision.** Rafael's.

## Which of t306's follow-ups this closed

Both of them. t306's closing note listed two recommended follow-ups this ticket
was the named owner of: the `notas/` → `notes/` rename with the carve-out that
went with it, and the `grafo.json` runtime-contract decision. Neither is open
any more, and `RETIRED_STEMS` carries `notas` and `grafo` so that neither can
come back quietly.
