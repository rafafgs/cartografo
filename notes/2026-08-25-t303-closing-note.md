# t303 closing note — the three package identities take English names

**Subject:** `packages/tela`, `packages/topografo` and `packages/topografo-custo`
become `packages/screen`, `packages/surveyor` and `packages/cost-surveyor`,
with their bins, their env vars, two specification documents and every consumer.
The package half of D24 series 3 of 3, after Rafael split the original ticket on
2026-08-25; t282 was the document/config half and landed first.
**Commits:** `c6020e8` (the acceptance tests, six red), `f1420bb` (the renames
and every consumer of them), on `ticket-303`.
**Written:** 2026-08-25, during development, following t282's and t299's
precedent.

## What moved

| Before | After |
|---|---|
| `packages/tela/` | `packages/screen/` |
| `packages/topografo/` | `packages/surveyor/` |
| `packages/topografo-custo/` | `packages/cost-surveyor/` |
| `@cartografo/tela`, `@cartografo/topografo`, `@cartografo/topografo-custo` | `@cartografo/screen`, `@cartografo/surveyor`, `@cartografo/cost-surveyor` |
| `cartografo-tela`, `cartografo-topografo`, `topografo-custo` (bins) | `cartografo-screen`, `cartografo-surveyor`, `cost-surveyor` |
| `bin/tela.mjs`, `bin/topografo.mjs`, `bin/topografo-custo.mjs` | `bin/screen.mjs`, `bin/surveyor.mjs`, `bin/cost-surveyor.mjs` |
| `CARTOGRAFO_TELA_PORT`, `CARTOGRAFO_TELA_TOKEN` | `CARTOGRAFO_SCREEN_PORT`, `CARTOGRAFO_SCREEN_TOKEN` |
| `docs/spec/topografo-cost.md`, `topografo-flow.md` | `docs/spec/surveyor-cost.md`, `surveyor-flow.md` |

`f1420bb` is **118 files, +394 / −366**: **77 are `git mv`s** and the other
**41 are citation-only**, which is the shape this series keeps producing. By
tree: `packages/` 99, `docs/` 9, `scripts/` 4, `tests/` 3, plus `README.md`,
`package.json` and `package-lock.json`.

The cost bin stays **unprefixed**. That is the convention it already had, D23
never gave it a `cartografo-` prefix, and adding one would be a naming decision
under cover of a rename — the ticket put it Out of Scope and it stays there.

`git log --follow` reads through every rename, checked on one file per package:
`packages/screen/bin/screen.mjs` (4 commits, back to t107),
`packages/surveyor/bin/surveyor.mjs` (back to t247),
`packages/cost-surveyor/bin/cost-surveyor.mjs` (back to t199) and
`docs/spec/surveyor-flow.md` (15 commits, back to t110).

## How AC2 was executed

The ticket's own criterion: `packages/surveyor/src/watch.ts:45` imports
`@cartografo/cost-surveyor/cli` **by exports subpath**, and no build step is
guaranteed to catch a miss. So the check is not a new test — it is a deliberate
half-rename, run against the real bin.

With everything else already renamed, that one import line was put back to
`@cartografo/topografo-custo/cli` and `watch.e2e.test.ts` — which spawns the
real `cartografo-surveyor watch` as a child process — was run:

```
✖ t247 AT7 — a finished round makes at most one proposal per lens, and a restart makes none
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@cartografo/topografo-custo'
  imported from .../packages/surveyor/src/watch.ts
    code: 'ERR_MODULE_NOT_FOUND'
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

A module-resolution error at Node's own resolver, exactly as the ticket
predicted. The import was then restored and the same test rerun:

```
✔ t247 AT7 — a finished round makes at most one proposal per lens, and a restart makes none (3098ms)
ℹ tests 1  ℹ pass 1  ℹ fail 0
```

**One thing worth recording that the ticket did not predict.** `tsc --noEmit`
*does* see this — but what it says first is not what a reader would act on:

```
src/watch.ts(45,51): error TS2307: Cannot find module '@cartografo/topografo-custo/cli' …
src/watch.ts(168,28): error TS7006: Parameter 'candidate' implicitly has an 'any' type.
```

The TS2307 is the real diagnosis; the TS7006 is noise the missing module caused
downstream, and it points at a line that is perfectly fine. Typecheck is a
weaker signal here than the ticket assumed it would be, not a stronger one — a
reader chasing the implicit-`any` first would be repairing the wrong file. The
executed check is what says the thing plainly.

## Test counts, before and after

Measured live on this tree, `npm ci` clean, before the ticket and after it.

| Group | Before | After |
|---|---|---|
| root | 325 | 325 |
| `core` | 682 | 682 |
| `runner` | 645 | 645 |
| `tela` → `screen` | 126 | 126 |
| `topografo` → `surveyor` | 29 | 29 |
| `topografo-custo` → `cost-surveyor` | 46 | 46 |
| **total** | **1853** | **1853** |

Not one test lost or gained, which is what a rename should look like: no test
was deleted to make a path resolve, and no test was added that the acceptance
criteria did not ask for. The six that went red in `c6020e8` are the same six
that went green in `f1420bb`.

`npm run lint`, `npm run typecheck` and `npm run build` are all green.

`git ls-files | grep -iE "tela|topografo"` returns **nothing at all** — not
"nothing outside `notas/**`", nothing. Neither word survives in any tracked path
in this repository.

## The two things that deliberately did NOT change

Both because rewriting an argued decision in the middle of a rename is the same
mistake as repairing an inconsistency in the middle of a translation (t280,
t293). Stated here so they read as decisions rather than as misses.

**1. `DEFAULT_ANSWERED_BY = 'tela'` (`packages/screen/src/pages.ts:55`).** It is
not a package name. It is a value written into the `input_request.answered`
event log, which is append-only by D15. Changing it makes new rows disagree with
old ones about who answered, and the code's own comment already argues the
current choice deliberately ("recording `tela` is saying the answer came through
this door, which is all the system actually knows"). If it should change, that
is its own ticket with its own reasoning about the log. Verified: the
rename-detected diff of `pages.ts` is **one line**, and it is a path citation in
an unrelated comment — the constant and its two consumers are untouched.

**2. `DECISIONS.md`, D23 included.** `DECISIONS.md:236` literally names
`cartografo-tela` among the shipped commands. That is a dated, numbered decision
record — reversible only by another recorded decision, not by a rename ticket —
and who writes there is preferably Rafael. `git diff` shows **no hunk** in the
file. D24 itself is still not recorded there either; adding it is the founder's
act, not this ticket's.

## What the ticket did not know it was taking

Three files outside the declared conflict surface had to move with the rename.
Each is a gate that would otherwise have gone red **for the rename rather than
for a defect**, which is the failure mode worth naming: a gate that reds on
correct work teaches the next person to stop believing it.

### 1. `tests/decisions-rename-integrity.test.mjs` — `SPEC_DOCUMENTS`

t299's gate asserts `readdirSync('docs/spec')` **exactly equals** a hardcoded
list, and that list contained `topografo-cost.md` and `topografo-flow.md`.
Renaming those two documents (which FR9's new `topografo` stem forces) breaks
`AT4` outright.

The two names are now listed as `surveyor-cost.md` / `surveyor-flow.md`, because
that assertion is a claim about **what is on disk today**.
`RETIRED_SPEC_DOCUMENTS` — the record of what t299's own rename table retired —
is untouched, and the two new names were deliberately *not* added to it: that
list is t299's history, not a running blacklist, and the exact-set assertion
plus this ticket's `topografo` stem already make a return impossible twice over.

### 2. `tests/citation-link-text.test.mjs` — `REPAIRED_DOCUMENT`

t302's gate opens `docs/spec/topografo-flow.md` **by path** with `readFileSync`
to check two specific citations inside it. After the rename that is an ENOENT,
not an assertion failure — the gate would have died rather than reported.

### 3. `package-lock.json` — npm does not prune a renamed workspace

This is the one that would have shipped silently. `npm install` after the rename
writes the three **new** workspace entries and **leaves the three old ones
behind**, marked `"extraneous": true`:

```
"packages/tela":           { "name": "@cartografo/tela",           "extraneous": true, … }
"packages/topografo":      { "name": "@cartografo/topografo",      "extraneous": true, … }
"packages/topografo-custo":{ "name": "@cartografo/topografo-custo","extraneous": true, … }
```

`npm install --package-lock-only` does not prune them either. Nothing fails —
every test, lint, typecheck and build stayed green with the lockfile still
describing three packages that are not on disk, and still spelling
`cartografo-tela` and `bin/topografo.mjs` in a tracked file.

They were removed by hand, safely: the edit **proves a byte-identical JSON
round-trip of the file first**, refuses to write if the formatting does not
match npm's own, then deletes exactly those three keys after asserting each
carries `extraneous: true`. `node_modules` was then deleted and `npm ci` run
from the edited lockfile, and the whole suite rerun from that clean install.

## `notas/**`, `DECISIONS.md` and the migrations — historical, and untouched

Same treatment t282 gave them. Three tracts still spell the retired names, all
three on purpose:

- **`notas/**`** — eight notes name the old commands and paths as history,
  including t299's own closing note recording that it renamed
  `topografo-custo.md` → `topografo-cost.md`. A note is a dated record of what
  was true when it was written.
- **`DECISIONS.md:236`** — D23's shipped-command list. See above.
- **`packages/core/migrations/`** — `0017_trabalho_tier.sql:12` cites
  `docs/spec/topografo-cost.md` and `0021_proposta_dedupe_key.sql:6` cites
  `packages/topografo-custo/src/cli.ts`, both inside Portuguese comments. The
  language convention freezes these file names outright, and
  `no-portuguese-path-segments` already excludes the tree by name. A migration
  is a historical artefact whose identity is its name in `schema_migrations`;
  editing one to fix a comment is the wrong trade. **They are now stale
  citations** — that is the cost of the exclusion, and it is recorded here
  rather than quietly absorbed.

The two gates whose fixtures ARE the old names — `no-portuguese-path-segments`
(the "bites" list) and `decisions-rename-integrity` (`RETIRED_SPEC_DOCUMENTS`) —
also still spell them, necessarily. A gate against a name has to write it down.

## Gotchas

1. **`npm install` does not prune a renamed workspace from the lockfile, and
   nothing goes red.** Full detail above. Any future package rename in this
   monorepo hits this. Check `git grep <old-name> -- package-lock.json` before
   calling a rename done; the quality gates will not do it for you.

2. **`tsc` reports a missing module and then a spurious downstream error, in
   that order.** A missing exports-subpath import produced TS2307 on the import
   line **and** TS7006 on a parameter 190 lines away that is not wrong. Read the
   first error, not the last.

3. **Segment-built paths again — and one lived outside a test fixture's data.**
   t282's Gotcha #1 was `path.join('especificacoes', 'eventos', …)`. Here it was
   `scripts/check-single-writer.test.mjs:173,176`:
   `script.check(path.join(root, 'packages', 'tela'))`, invisible to any search
   for `packages/tela`. The ticket predicted three such sites and there were
   four. The sweep that finds them is
   `git grep -nE "'(packages|docs|spec|bin)',[^)]*'"`, and it is worth running
   on every rename until somebody writes it into a gate.

4. **The gate's stems are substrings, so one stem covered two packages — but
   only because the retired names shared a prefix.** `topografo` catches
   `topografo-custo` for free. A `custo` stem was deliberately NOT added: it is
   a substring of the English word `custom` and would have gone red on
   `packages/core/src/domain/custom-fields.ts` and the frozen
   `0015_trabalho_campos_customizados.sql`. Both are real paths in this tree —
   the false positive is not hypothetical.

5. **`cartografo.tela.ready` survives, deliberately, and is the one live
   Portuguese identity string left.** `packages/screen/src/router.ts:143` emits
   it on stdout as the readiness event, and `docs/spec/screen.md:269` and
   `screen-proposal-inbox.md:93` document it. It is not a package name, a bin,
   or an env var — the three things FR1–FR5 enumerate — and it does not match
   FR7's confirmation search (`cartografo-tela`, with a hyphen, not a dot). So
   it was left alone rather than renamed on an unstated assumption. It is a
   one-line change plus two document lines if the founder wants it; see
   Recommended follow-ups.

6. **Three code comments justified a rule by naming a Portuguese package.**
   `no-portuguese-identifiers` in the surveyor said `topografo` was absent from
   its word list "because it is this package's own brand"; both wire gates said
   their left word-boundary existed because `custo` fired on `topografo-custo`.
   After the rename all three sentences were false while every test still
   passed — a comment cannot go red. They were rewritten to say what is true
   now. The surveyor's is the interesting one: `topografo` is still absent from
   that list, but the real reason is now `proposta-topografo.json`, the file the
   flow lens's session writes, which is an artefact name agreed with the engine
   at run time and not an identifier D18 moves.

## Recommended follow-ups

- **Rename the readiness event** `cartografo.tela.ready` →
  `cartografo.screen.ready` (`router.ts:143`, plus the two specification
  samples). One line of code, two of documentation. Deliberately not taken here;
  see Gotcha #5.
- **Translate the running prose** of `docs/spec/surveyor-cost.md` and
  `surveyor-flow.md`, which still use "topografo" as a concept 9–16 times each
  outside the renamed titles, and `README.md:317`'s naming-rationale paragraph.
  Explicitly Out of Scope here — judgement-heavy translation, the same class
  this series has repeatedly split off (t282's `docs/what-cartografo-is.md`
  follow-up is the precedent).
- **`CARTOGRAFO_WEBHOOK_SEGREDO`** — a Portuguese word in an unrelated env var,
  flagged by the ticket's own refinement and untouched here.
- **`packages/runner/src/controller/cliente-controle.ts`** and its test — their
  own ticket, already filed. Their comments citing `packages/tela/src/index.ts`
  are now stale, deliberately: the blanket pass did touch them and the change
  was reverted, because the ticket says that file's Portuguese stays whole until
  its own ticket takes it.
- **`proposta-topografo.json`** (`packages/runner/src/surveyor/proposal.ts:82`)
  and the `fonte: 'topografo/fluxo'` provenance label beside it. Both are wire
  artefacts, not package identities, and both are outside this ticket — but they
  are now the last places the word appears in live runtime code.
