# t282 closing note — the paths take English names, and a gate reads the whole tree

**Subject:** `grafos-de-fabrica/`, `especificacoes/`, `schema/exemplos/`,
`docs/formatos/`, `scripts/validar-grafo.mjs` and one test fixture. The
document/config half of D24 series 3 of 3, after Rafael split the original
ticket on 2026-08-25.
**Commits:** `cf6867e` (the three gates, red at 65 paths and one missing tree),
`70870bb` (the renames and every consumer of them), on `ticket-282`.
**Written:** 2026-08-25, during development, following t300's, t299's and t281's
precedent.

## What moved

| Before | After | Files |
|---|---|---|
| `grafos-de-fabrica/` | `factory-graphs/` | 16 |
| `especificacoes/{formatos,eventos}/` | `specs/{formats,events}/` | 34 |
| `.../exemplos/`, `schema/exemplos/` | `.../examples/` | (nested in the above + 11) |
| `docs/formatos/` | `docs/formats/` | 2 |
| `scripts/validar-grafo.mjs` | `scripts/validate-graph.mjs` | 1 |
| `tests/fixtures/tese-exemplo-bets-assimetricas.json` | `.../bets-asymmetric-thesis-example.json` | 1 |

`70870bb` is **222 files, +469 / −458**: 65 of them are the `git mv`s and the
other **157 are citation-only**, which is the whole shape of this ticket. By
tree: `packages/` 119, `specs/` 34, `docs/` 17, `factory-graphs/` 16,
`scripts/` 12, `schema/` 12, `tests/` 10, `notas/` 1, `README.md` 1.

`git log --follow` reads through every rename, checked on
`factory-graphs/desenvolvimento-de-software/grafo.json` (back through t299, t280,
t273), `scripts/validate-graph.mjs` (back through t256, t230, t169) and
`specs/events/taxonomy.md` (back through t300, t299).

## The silent-drop number Rafael asked for

**Before: `especificacoes/**/*.test.mjs` found 4 files and ran 171 tests.**
**After: `specs/**/*.test.mjs` finds 4 files and runs 171 tests.**

Both measured live, not assumed — the "before" on the tree as it stood before
the first commit, the "after" on the finished tree. The four are
`{events/tests/examples,events/tests/replay,events/tests/schemas,formats/skill-manifest}.test.mjs`.
The root group as a whole went 316 → 325 tests, the nine being this ticket's own.

The risk was real and is worth stating precisely, because it is not obvious:
`node --test` on a glob that matches nothing prints `tests 0` and **exits 0**.
Verified directly on this tree before the rename — `node --test 'specs/**/*.test.mjs'`
was a clean, green, empty run. There is no error, no warning and no red; the
group simply stops existing. That is why the check landed as a gate
(`scripts/run-all-tests.test.mjs`, AT4) rather than as a number in this note,
and why the gate reads the patterns off the real exported `GROUPS` and fails on
ANY root-group glob that finds zero files, not just the specs one.

## What the ticket did not know it was taking

Four things, all of them the same failure in different clothing: a path
reference the directory-prefix rewrite could not see.

### 1. `path.join('especificacoes', 'eventos', ...)` — 35 files

The single biggest surface, and invisible to a search for `especificacoes/`.
Thirty-five test files build a fixture path one segment per argument:

```js
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'exemplos');
```

Rewriting the directory prefix turns `'especificacoes'` into `'specs'` and
leaves `'eventos'`, `'formatos'` and `'exemplos'` sitting on their own lines,
pointing nowhere. Not one of these is a prefix match, and the ticket's FR8 named
the class without being able to enumerate it — correctly, since the enumeration
would have been stale.

Two of them were worse than a broken fixture, because they were the reading
apparatus of another gate: `packages/core/test/glossary-wire-docs.test.ts`'s
`SCHEMA_DIR = path.join('specs', 'eventos', 'schemas')` and
`markdownUnder(path.join('docs', 'formatos'))`. A gate whose input directory
does not exist reads nothing and reports nothing wrong.

### 2. Relative citations carry no prefix to match on either

`../exemplos/`, `./exemplos/` and `../formatos/`. Three were **live runtime
paths** inside the moved spec tree — `specs/events/tests/{examples,replay}.test.mjs`
and `specs/formats/skill-manifest.test.mjs` resolve their fixtures with
`new URL('../exemplos/…', import.meta.url)` — so the four spec test files would
have thrown on load, which at least is loud.

Six more were markdown hrefs under a display text the rename HAD already
updated: `docs/spec/graph.md:872` read
`` [`docs/formats/atlas-bundle.md`](../formatos/atlas-bundle.md) ``. That is
exactly the desync t302 built `tests/citation-link-text.test.mjs` for, produced
fresh by a mechanical rename — and that gate does not catch it, because it
compares the two halves by **basename** and the basenames agreed. The half that
broke was the directory.

### 3. Fixtures whose Portuguese spelling IS the test

`tests/no-portuguese-identifiers.test.mjs`'s "does NOT bite" list pins the rule
that a Portuguese word inside a string literal is data, not an identifier:

```js
"const EXAMPLES = path.join(REPO_ROOT, 'schema', 'exemplos');",
```

A blanket rewrite turns that into `'examples'` and the case stops testing
anything — an English path proves nothing about masking. Reverted to the retired
spellings with a comment saying why. Same trap, one level up: the blanket pass
also rewrote the retired-name table inside `tests/no-portuguese-path-segments.test.mjs`,
the gate this ticket added, whose entire content is the names D24 retired.

The general rule, which cost the most to learn: **a rename may not touch a file
whose subject is the old name.**

### 4. The wire glossary's "defined in" column is not uniformly frozen

t281's and t300's precedent says the retired-name table rows are data. That is
true of the "today" column and NOT automatically true of "defined in", which
every other row uses as a live pointer (`packages/core/src/domain/graph.ts:189`).
The cut that actually works is per-citation, not per-row:

- **Names a file that still exists → it moves.** Four sites: the prose at §2 and
  §5.3, and two rows whose "defined in" is `scripts/validar-grafo.mjs`.
- **Names a file t213/t227 already retired → it stays.** Thirteen sites, all
  pointing at `lease.concedida.schema.json`, `grafo_versao.registrada.schema.json`
  or `grafo-invalido-no-inalcancavel.json` — none of which resolve under any
  directory name. Half-renaming those produces a path that is neither the
  historical record nor a working link.

Verified by listing `specs/events/schemas/` and `schema/examples/` rather than
by reading the table.

## `notas/**` — historical, and one exception

Eleven statements across ten notes name these directories, and all eleven are
history: t280's subject *was* `grafos-de-fabrica/desenvolvimento-de-software`,
t300 *did* translate `especificacoes/**`. Rewriting them would make the notes
claim work that never happened, so they keep the names those directories had at
the time. The one thing fixed is the one thing a reader follows:
`notas/2026-08-17-first-bets-run.md:128`'s markdown link to `taxonomy.md`.

## The carve-out, collapsed

`ALLOWED_SEGMENTS` in `tests/no-portuguese-document-tree.test.mjs` went from five
entries to one. Four were placeholders for this ticket and are **deleted, not
rewritten**. `notas` stays and its reason now says it is a *standing exception*:
no ticket of this series ever proposed renaming the folder, and leaving a
shipped ticket's number on it would be a TODO nobody is coming back for.

`OWNER_TICKET` is gone with the assertion that used it. What replaced it is an
assertion that the surviving reason declares itself standing — the honest
successor to "every carve-out must name the ticket that removes it" once that
ticket is the one writing the line. Verified by putting `exemplos` back: the gate
reds twice, on the length-1 claim and on "not a path segment of this tree any more".

The teeth are no longer in this list at all, which is the real improvement.
`tests/no-portuguese-path-segments.test.mjs` reads the **whole tracked tree**
against the five stems D24 retired, and it bites without anyone maintaining an
allowlist. The two gates are complementary and neither subsumes the other: the
document-tree sweep asks two general signals of four trees and catches a
Portuguese word nobody predicted; this one asks five specific stems of
everything and catches them everywhere. `especificacoes` tripped neither general
signal, which is why it needed a hand-written carve-out in the first place.

## Definition of Done

- [x] Acceptance tests written first, confirmed red for the right reason — 65
      paths enumerated, `specs/` absent, and the pure bite-tests beside them
      green, which is what tells a missing implementation from a broken import.
- [x] `npm ci` clean, then `npm test` (both groups), `npm run lint`,
      `npm run typecheck`, `npm run build` — all green.
- [x] `git ls-files | grep -E "(^|/)[^/]*(fabrica|especificac|exemplo|formato|validar)[^/]*(/|$)"`
      outside migrations returns nothing. Was 65.
- [x] `ALLOWED_SEGMENTS` has exactly one entry, and reds if a removed one returns.
- [x] `git mv` throughout; `--follow` verified on three moved files.
- [x] `cartografo import factory-graphs/desenvolvimento-de-software` and
      `.../bets-assimetricas` against a live control plane: 5 and 7 skills
      registered, versions `sha256:9cacf03d…` and `sha256:7bef65c2…`.
- [x] `package-lock.json` untouched, as FR13 predicted. Confirmed, not assumed.
- [~] **The four spike scripts were NOT executed.** Each one opens real,
      billed agent sessions — `spike-graph-traversal.mjs`'s own header says
      "five real sessions against a real account… it costs real money" — and
      that is not a cost to spend without being asked. What was verified
      instead, deterministically: every path constant in all five spikes
      resolves on disk, and the startup reads they perform were executed for
      real (the three event schemas loaded into Ajv, the develop manifest's
      `instructions` read, the five factory skills enumerated, the two-engine
      fixture parsed). The paths are the only thing this ticket changed in
      them. A real run remains available on request.

## Gotchas

1. **`node --test` on a dead glob exits 0.** No error, no warning, `tests 0`.
   Any rename that touches a test-discovery pattern needs a gate on the count,
   not a careful reviewer.
2. **A rename must not touch a file whose subject is the old name.** Retired-name
   tables, "does NOT bite" fixtures, and closing notes are data written in dead
   names on purpose. Caught here in three separate files, including the gate this
   ticket was adding.
3. **`path.join('a', 'b', 'c')` is invisible to a path search.** Grep for the
   segment as a quoted literal too, and then check whether each hit is a path
   segment or frozen vocabulary — `{ bare: ['evento', 'eventos'] }` in five
   `no-portuguese-identifiers.test.ts` files is the latter and must not move.
4. **`tests/citation-link-text.test.mjs` does not catch a directory rename.** It
   compares display text and href by basename, deliberately (see its header).
   A citation whose directory half is stale passes it.
5. **The stale citation this ticket found and half-repaired:**
   `packages/runner/test/engine/permission-enforcement.codex.test.ts` cited
   `…/skills/derrubar-tese.json`, a file t280 renamed to `red-team-thesis.json`.
   It was already dead before this ticket; the mechanical pass would have left it
   dead under a new directory. Repointed at the real file, with the retired name
   kept in the comment because the test's own title still uses it. **That title
   is t280-era identifier debt and is still there** — one of several, alongside
   `validarGrafo` and `cliente-controle.ts`.
6. **`docs/o-que-e-o-cartografo.md` is still Portuguese-named** — t121 closed it,
   and the file is `docs/what-cartografo-is.md` — **and no gate read it as such**:
   it trips neither general signal (`o` and `e` are not in the
   stopword list) and none of the five stems. Out of scope here — it was never in
   any declared rename list — but it is the one Portuguese document name left in
   the tree, and whoever writes that ticket should add a stem for it.

## Recommended follow-ups

1. **`grafo.json` / `schema/grafo.schema.json` / `grafo-travessia.json`** — the
   refinement deferred these and the deferral held up: `grafo.json` is a live CLI
   convention hardcoded at `packages/core/src/cli/import.ts:351` and
   `export.ts:91`, and the schema's `$id` is a URN. Renaming them changes a
   contract. Their stems belong in `RETIRED_STEMS` on the day they move.
2. **`bets-assimetricas` and `desenvolvimento-de-software`** as directory names —
   deliberately untouched (FR1 moves the parent only), because each is also the
   registered `classe` key, proven live by the import above. Same shape as 1.
