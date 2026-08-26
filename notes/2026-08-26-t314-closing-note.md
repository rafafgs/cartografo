# t314 — the gate that reads everything, and the 148 lines nobody was reading

**Date:** 2026-08-26 · **Branch:** `ticket-314` · **Subject:** one repo-wide
Portuguese sweep, two permanent exceptions, one proven red — and the discovery,
on the way, that the tree behind the gate was not clean.

Six commits: the three lines FR6 named (`0e32efc`), the five acceptance tests
before any gate existed (`14f0cd0`), the gate itself (`17e8ecc`), then the three
fixable classes the first green run uncovered — prose (`fa9aa55`), fixtures
(`33d4231`), byte-width fixtures (`f91a73f`) — and this note.

## The finding that changed the ticket

The body predicted the gate would be green today with exactly two exceptions and
three lines to fix. It was measured against the document tree, and the document
tree was clean: `docs/`, `notes/`, `schema/`, `specs/` and `factory-graphs/`
contributed **zero** hits between them, exactly as the Refinement Log predicted
the blanking would make them.

The measurement never reached `packages/**`. Running FR3's own strategy over the
whole of `git ls-files` found **148 hits in 65 files**, of which 124 were under
`packages/**`, 23 under root `tests/` and one in `.github/`. The body's own
arithmetic points at it: 578 raw hits, minus 94 in `package-lock.json`, minus
335 in the gate files, leaves 149 — and the body attributed that remainder to
backtick-quoted history under `notes/`, where the real count is nil.

The founder's ruling was to fix everything rather than open a third exception
list or ship a pin list. Four of the five classes were fixable and are fixed.

| class | what it was | how many | what happened |
|---|---|---|---|
| 5 | untranslated docblock prose in `src/` and `scripts/` | 19 | translated |
| 4 | Portuguese fixture strings, some pinned by a sibling gate | 14 | translated, with the gates that pinned them |
| 3 | fixtures whose point is a character's byte width | 5 | rewritten as Unicode escapes |
| 1 | language gates the four naming globs do not reach | 29 | exception #1, restated as its own rule |
| 2 | the frozen `expected_metric` vocabulary | 9 | **measured, not changed** — costed below |

## What FR6 got wrong, and why it matters

FR6 calls `package.json:5` and `packages/core/package.json:4` "real,
currently-uncaught bugs" that this gate catches, and AT6 says AT1 covers them
indirectly, so no separate test is needed.

**Neither line trips either signal.** Checked against the exact production
expressions before anything was changed:

```
package.json:5        diacritic= false  stopword= false
core/package.json:4   diacritic= false  stopword= false
```

`"Monorepo do cartografo: control plane (packages/core), runner
(packages/runner) e screen (packages/screen)."` carries no Portuguese diacritic,
and its only near-stopword is the `com` inside `control`, which the word
boundary in `/\b(...|com|...)\b/` refuses. Both lines are Portuguese and D24
moves them, so both were translated in `0e32efc` — but AT6 as written is a
criterion that cannot fail. It would have gone green over the two lines it was
put there to cover.

## The two exceptions

Exactly two, and AT5 asserts the count structurally.

**1 — the language gates.** The body wrote this as four filename globs. Those
globs are a proxy for the rule, and the rule is what is written down now: *a
file whose job is to enumerate what is forbidden*. Such a file is built out of
the vocabulary it refuses, and a sweep that read one would either disarm it or
never pass. The globs turned out to be too narrow by seven files —
`tests/t313-docs-specs-drift.test.mjs` asserts that a retired Portuguese
rendering is gone from a spec, which it can only do by spelling the rendering,
and it is no less a language gate for being named after a ticket rather than
after a rule. `LANGUAGE_GATES` enumerates the seven with a reason each, and AT2
refuses an entry that a glob already covers, so the rule cannot be stated twice.

The list is seven and not nine because escaping came first. Where the only
Portuguese was an isolated TOKEN rather than a phrase — a diacritic standing in
a character class, a single word used as a search needle —
`tests/t313-notes-quotation-inventory.test.mjs` and
`tests/t313-scripts-and-gitignore-prose.test.mjs` were rewritten with Unicode
escapes and dropped off the list instead of being listed on it. What is left is
seven files where the Portuguese is a phrase the file has to spell.

**2 — the frozen migration filenames**, path only, citing t279 in the code. Its
contents are read like any other file's.

**This exception is prospective, and the code says so.** None of the
twenty-four frozen migration names trips either signal: they are ASCII
`snake_case`, and `_` is a word character, so `\bcom\b` never matches inside
`0002_grafo_versao_proposta_com_condicao`. AT3 is written around a synthetic
name for that reason rather than around a real one — the same honesty
`no-portuguese-path-segments.test.mjs` already had to record for its own
`notes/` entry.

## The proven red (AC2, FR7)

One `STOPWORD` hit, in prose position, in an ordinary source file outside every
exception. Injected at `packages/core/src/domain/graph.ts:1`, verbatim:

```
// This note exists para the next reviewer, and for nobody else.
```

The real gate, against the real tree, verbatim:

```
✖ AT1 — no Portuguese survives anywhere in the tracked tree (514.92375ms)
  AssertionError [ERR_ASSERTION]: Portuguese survives in the tracked tree:
  packages/core/src/domain/graph.ts:1: stopword "para" — // This note exists para the next reviewer, and for nobody else.
  + actual - expected

  + [
  +   'packages/core/src/domain/graph.ts:1: stopword "para" — // This note exists para the next reviewer, and for nobody else.'
  + ]
```

Reverted with `git checkout --`; `git status --short` empty afterwards; AT1
green again on the next run.

A stopword and not a diacritic on purpose, and `para` specifically. `para` is
also a frozen wire key that the gate masks in key, quoted, property-access and
field-list positions — so this proof is simultaneously the proof that the mask
turns on POSITION and not on the word. AT4's second half pins the same pair
permanently, from both sides.

## AC4 — the independent re-scan

Re-run as a script after every fix landed, reading `git ls-files` itself and
applying the two production signals RAW, with no blanking of any kind, then
bucketing every hit by the reason the gate does not report it:

```
tracked paths read: 578
raw signal hits, no blanking: 571 lines in 116 files
    94  package-lock.json (generated)
   270  language gates (exception 1)
   207  masked as machine position

VIOLATIONS REPORTED BY THE GATE: 0
```

Zero violations outside the two exceptions. The 207 masked hits are hostnames,
`snake_case` keys, `kebab-case` ids, flags, backtick spans, fenced blocks,
glosses and the two frozen edge keys in machine position — every one of them a
cut that turns on position and applies to every file alike, which is what makes
it strategy rather than a third exception list.

## Class 2, costed: what removing `de` and `para` would take

Measured, not changed, on the founder's instruction. This is the one class that
is not a translation: it is a wire-format change and a reversal of a recorded
decision, and `docs/spec/glossary-wire.md` §5.6 states the freeze in so many
words — "The CONTENT of `metrica_esperada` stays `{nome, direcao, de, para}`".

**First, a correction to the ticket's framing.** The body and the refinement
both describe `de`/`para` as graph EDGE keys. They are not, and have not been
since t178: a real edge in `factory-graphs/software-development/graph.json`
reads `{"from": …, "to": …, "condition": …}`, and `schema/graph.schema.json`
contains the string `"de"` zero times. What is still Portuguese is one shape,
the hypothesis blob `expected_metric = {nome, direcao, de, para}` and its twin
`Verdict = {veredito, antes, depois, execucao_id, avaliado_em}`.

The surface, measured:

| where | count |
|---|---|
| code files that define or consume the shape | 48 (`packages/runner` 14, `packages/core` 14, `packages/cost-surveyor` 9, `packages/screen` 5, root `tests` 4, `packages/surveyor` 2) |
| validators that check the four keys by name | 7 |
| public API routes that carry it | 2 (`routes/proposals.ts`, `routes/graphs.ts`) |
| documents that spell it | 9 (6 specs, 3 notes) |
| schema files | 0 — it is an opaque `TEXT` blob, not a JSON-Schema shape |
| migrations that store it | 2 (`0002_grafo_versao_proposta.sql`, `0010_proposta_aprovada.sql`) |

**Could a document outside this repository carry it? Yes, and that is the
expensive part.** `expected_metric` is stored as a JSON blob in the `proposal`
table, so every proposal ever recorded in any existing database carries the
Portuguese keys inside a column the schema does not describe. It also travels in
the body of `POST /v1/proposals`, which is a public, versioned API (D11) whose
clients are by design not all in this repository — the screen is one, and
`packages/screen/src/public/graph-editor.js` composes the shape by hand.

**What the migration would look like**, in the order the constraints force:

1. A `DECISIONS.md` entry reversing the freeze — that is the founder's to
   record, and nothing below may start before it.
2. An API version bump, because the request body changes shape. The old keys
   have to be accepted for at least one version or every existing client breaks
   at once.
3. A data migration over the `proposal` table rewriting the JSON blob in place,
   for two columns across two historical migrations, with an inverse — the
   append-only rule (D15) means the old rows are evidence and cannot simply be
   dropped.
4. The 48 code files, the 7 validators and the 9 documents.
5. Two glossary rows retired, and `docs/spec/glossary-wire.md` §5.6's paragraph
   rewritten from "stays" to "moved".

Recommendation: worth doing, and worth doing as its own ticket with its own
decision behind it. It is not a language sweep.

## FR8 — what this gate overlaps with, and on what axis

Twenty-eight `no-portuguese-*` files plus `notes-redaction.test.mjs` were in the
tree before this one. None is deleted or merged here; the table is the
deliverable the ticket asked for instead.

| existing sweep | its axis | overlap with this gate |
|---|---|---|
| `tests/no-portuguese-document-tree.test.mjs` | four trees, general signals, path + content | **this gate is a strict superset.** Same two signals, same blanking, wider tree. The only thing it has that this one does not is `ALLOWED_SEGMENTS`, which is empty. |
| `tests/no-portuguese-reader-documents.test.mjs` | README, DECISIONS, `docs/**`, general signals, content | **strict subset**, and itself a subset of `document-tree`. Three gates now read these files. |
| `tests/no-portuguese-factory-bundles.test.mjs` | `factory-graphs/**`, general signals, raw lines | **near-subset.** It reads `.json` raw where this gate blanks whole-string hostnames, so it is marginally stricter on one shape and narrower on everything else. |
| `tests/no-portuguese-path-segments.test.mjs` | whole tree, twelve specific stems, path only | **neither subsumes the other.** Its stems catch `especificacoes`, which carries no diacritic and no stopword; this gate's general signals catch a name nobody predicted. Both are needed and both say so. |
| `tests/no-portuguese-migration-comments.test.mjs` | `packages/core/migrations/**` content | **overlapping and both wanted.** This gate reads migration contents too; that one is the reason they are clean and is the cited authority for exception #2's path-only scope. |
| `packages/core/test/no-portuguese-core-tests.test.ts`, `packages/runner/.../no-portuguese-runner-tests.test.ts` | one package's `test/**`, general signals **plus a wider stopword list**, with masks and line pins | **this gate is the weaker one, on purpose.** Their stopword lists carry content words this gate's seven do not — dropping twelve stale pins in `33d4231` uncovered `ref: 'migracao'`, which the core gate catches and these two signals never could. |
| `packages/*/test/no-portuguese-identifiers.test.ts`, `scripts/`, `tests/` identifier sweeps | identifier POSITIONS, literals deliberately masked | **complementary, no overlap.** They read exactly what this gate's prose reading is blind to, and vice versa. |
| `packages/*/test/no-portuguese-user-facing-strings.test.ts` | string and template literals of an explicit file list | **complementary.** It reads inside literals with message-level context; this gate reads whole files with none. |
| `packages/*/test/no-portuguese-wire.test.ts`, `no-portuguese-database.test.ts`, `no-portuguese-glossary-prose.test.ts` | wire vocabulary against the glossary; SQL; one document's prose | **no overlap.** Vocabulary and schema, not prose. |
| `tests/notes-redaction.test.mjs` | `notes/**`, secrets, RAW | **no overlap, and deliberately opposite.** It reads backtick spans because a quoted ticker leaks exactly as much as a bare one; this gate blanks them because a quoted name is a citation. |

**Recommendation: open a narrow consolidation ticket, not a wide one.** Three
gates — `document-tree`, `reader-documents`, `factory-bundles` — are now
subsets or near-subsets of this one and read files this gate already reads with
the same signals, which is duplicated work that will always be green. Folding
those three in is a contained change.

Everything else should stay. The per-package sweeps are stricter than this gate
on their own tract, the identifier and wire sweeps read a different dimension
entirely, and `path-segments` catches names these two signals cannot see. A
ticket that tried to merge all twenty-eight would be merging four different
scanning strategies and eight exemption shapes, which is the mistake t287
already documented once.

One thing that ticket should also do: three copies of the fence-and-backtick
blanking exist. FR3 extracted it into `scripts/no-portuguese-prose.mjs` as
`withoutSpans`/`proseOf` and this gate imports it, but
`no-portuguese-reader-documents` and `no-portuguese-document-tree` still carry
byte-identical local copies. Neither is in this ticket's declared file set, so
neither was touched.

## The two Out-of-Scope findings, restated

Both are named here so they are discoverable without re-reading the ticket.

**1 — stale pre-D20 field names inside fenced JSON examples.**
`docs/spec/graph.md:532` still prints an edge two format versions out of date —
`{"de": "testar", "para": "desenvolver", "condicao": "retrabalho"}` — where
a real edge reads `{"from", "to", "condition"}`. `docs/spec/human-escalation.md:47`
and `docs/spec/intake.md:52-53` have the same shape of problem. These sit inside
fenced blocks, which every prose gate in this family blanks, so no gate sees
them. `notes/2026-08-25-t306-closing-note.md` flagged the first one already.
Fixing this means auditing every fenced example in the document tree for
factual staleness against the current wire format, which is a correctness task
and not a language one.

**2 — consolidating the twenty-eight sweeps.** The table above is this ticket's
deliverable on that. The consolidation itself is a follow-up ticket's decision.

A third, not in the ticket but found on the way: **`docs/spec/intake.md` keeps
its Portuguese submitted-content example, and now on its own reason.** Until
this ticket, `tests/t313-docs-specs-drift.test.mjs` AT7 justified the spec's
Portuguese by asserting two core fixtures still submitted it, and twelve line
pins in `no-portuguese-core-tests.test.ts` justified those fixtures by pointing
back at AT7. Neither end had a reason of its own. The fixtures read English now,
the twelve pins are gone, and the spec keeps its example on the reason that was
always the real one: intake accepts an item in ANY language, and a submitted
item is user content rather than prose this project writes. The example itself
is untouched.

## The floor, and what it does not reach

Two signals is a floor, not a checklist, and this gate is honest about being the
weaker layer under the per-package sweeps rather than a replacement for them.
Two Portuguese lines were read during this work that neither signal can see, and
both are recorded in the code beside themselves rather than here alone:

- `packages/core/src/repositories/input-request.ts` writes the block reason
  `aguardando resposta da pergunta N`, which carries no diacritic and none of
  the seven stopwords. Every D24 sweep in this repository runs green over it.
  Its neighbour in `repositories/job.ts` was translated by this ticket, and the
  comment there names the asymmetry.
- `packages/core/src/cli/skill-import.ts` writes the placeholder `revisor
  humano escreve o JSON Schema aqui`, invisible for the same reason. The core
  package's wider stopword list does catch it, which is why a line pin still
  covers the assertion that reads it back.

Widening `STOPWORD` is a change to every gate in the family at once and belongs
to whoever measures the cost — `scripts/no-portuguese-prose.test.mjs` has
carried that same note about the missing `i` flag since t300.

## Gotchas

- **Line-number pins shift under a comment.** Adding six lines of explanation
  above `cli-skill-import-unit.test.ts:221` moved it to `:227` and broke a pin
  in `no-portuguese-core-tests.test.ts`. That is the design working — the pin
  broke loudly and was re-read rather than inherited — but a ticket that edits
  a heavily pinned test file should expect it.
- **Eight of the nine gate failures this ticket caused were stale exceptions
  reporting themselves.** Six `VERBATIM_QUOTATIONS` pins in the runner were
  preserving a Portuguese paraphrase of a sentence that had already been
  translated into English at the source; the list is empty now. A pin that
  asserts its own subject is still Portuguese is worth far more than one that
  only asserts a hash.
- **`AT10 — the three frozen scripts are byte-identical` is not a wall.** Its
  own failure message says to update the hash in the same commit when the change
  is deliberate. FR3's extraction was, so the hash moved in `fa9aa55`.
- **A closing note is scanned by this gate.** Every Portuguese phrase above is
  inside a fence or a backtick span, which is the same discipline t326's note
  recorded for its own retired name.

## Counts

| | before | after |
|---|---|---|
| root test group | 411 | 419 |
| `packages/core` | 707 | 707 |
| `packages/runner` | 700 | 700 |
| `packages/screen` | 145 | 145 |
| `packages/cost-surveyor` | 46 | 46 |
| `packages/surveyor` | 29 | 29 |

`npm test`, `npm run lint`, `npm run typecheck` and `npm run build` all green.
No suite lost a case.
