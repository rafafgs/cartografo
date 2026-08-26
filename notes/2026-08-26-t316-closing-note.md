# t316 — the tail of the split, and the failure it was written to fix

**Date:** 2026-08-26 · **Branch:** `ticket-316` · **Subject:** six files, three
diacritics left, and a premise that had already expired before the work started.

Two commits: the acceptance suite first and red (`4ac5e40`), then the four
translations (`7a0262e`), and this note.

## The failure this ticket was scoped around does not exist

The original body named `AT2 — no Portuguese survives in the contents of the
document tree` (`tests/no-portuguese-document-tree.test.mjs`) as "the last
failure keeping main red", and made this ticket the one that closes it.

Recounted live, twice, on a clean checkout of `ticket-316`:

- Before a single edit, `npm test` was **fully green** — five workspaces plus
  the root group, 391/391 in the root group, `AT2` among them. Two tests carry
  that name and both pass; the second is the reader-facing sweep's.
- The fix belongs to **t313** (`adc549e`, on top of `41b35b6` and `44b3c49`).
  t312's own closing note had already attributed the failure to a document under
  `notes/`, which is t313's declared surface and never was this ticket's: none
  of the six files here can reach it.

So FR7 is discharged by recording it rather than re-fixing it, exactly as the
ticket asked, and nothing in this branch touches that gate.

**One trap on the way in, and it is the reason the first baseline lied.** A
fresh worktree has no `node_modules`, and every workspace suite then fails at
the `tsx` loader: 5 workspaces, 186 tests, 0 passing, plus one root failure in
`specs/formats/skill-manifest.test.mjs`. It reads exactly like a broken main.
`npm ci` first, then baseline.

## The count

The ticket predicted 16 diacritics across 6 files and it was exact, to the
character and to the file: `cli.test.ts` 1, `client.test.ts` 1, `policy.test.ts`
6, `watch.e2e.test.ts` 2, `factory-graph-1.test.mjs` 4, `factory-graph-2.test.mjs`
2.

**Three survive, not four.** The Definition of Done asked for a precise recount
because the arithmetic is easy to get wrong in this direction, and it is:

| line | characters |
|---|---|
| `packages/cost-surveyor/test/client.test.ts:115` | 1 — the `ó` of `nó` |
| `tests/factory-graph-1.test.mjs:334` | 1 — the `ó` of `só` |
| `tests/factory-graph-1.test.mjs:335` | 1 — the `ç` of `endereço` |

Measured with the full class `[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]`, which is wider
than the one the D24 gates hunt by. The estimate of four came from reading
`factory-graph-1.test.mjs`'s pre-ticket 4 as "2 on the quotation, 2 elsewhere";
the citation line carried 2 of them on its own, because `Identificação` has both
a `ç` and an `ã`.

Both surviving sites are deliberate, and both are now pinned by
`tests/small-suites-english-fixtures.test.mjs` as content that must NOT move:

- **`client.test.ts:115`** — `expected_metric`'s `{nome, direcao, de, para}` is
  t255's frozen hypothesis shape (`docs/spec/surveyor-cost.md` §5.5,
  `docs/spec/glossario-wire.md`). The candidate's own keys read English; what
  the field carries is wire. AT2 asserts the four fragments are still there AND
  that this is the file's only Portuguese line, so neither a translation nor a
  new leak passes.
- **`factory-graph-1.test.mjs:334-335`** — a verbatim quotation, inside a
  comment, of the sentence the AT10 assertion below it refuses. AT5 rejoins the
  two comment lines and demands the quotation still reads
  `aberta só para o endereço de loopback`.

## What moved, and what was corrected rather than translated

Four files, ten lines.

`cli.test.ts:115` posts `trabalhar o nó ${nodeId}` as the prompt of a seeded
session. Grepped at all six call sites (`:161`, `:162`, `:239`, `:293`, `:505`):
nothing ever reads it back. Opaque fixture input, plain translation.

`policy.test.ts` had three `description` fixtures, and two of them are one
fixture: `:147` asserts the operation's `from` against the string `:131` built,
with `graphVersionId` fixed to `sha256:v1`. Translating one and not the other is
a red suite, which is why AT3 pins both spellings and the third fixture at
`:248` together.

`watch.e2e.test.ts`'s `VALID_OPERATIONS` is a `change_node_field` over the
`revisar` node, submitted once to a real control plane and compared against
nothing. Both directions moved, `inverse` included — AT4 asserts each sentence
appears exactly twice, which is what catches a half-done edit that leaves the
inverse describing a change that no longer exists.

**The two root suites are the interesting case, and they are not a translation
at all.** Both cited the `"Identificação"` section of
`specs/formats/skill-manifest.md`. That heading has read
`### Identification: id, version, hash` since earlier work: the comment was a
stale citation of a name the source no longer emits, so it is corrected to what
the source says today rather than restored to Portuguese or invented. This sits
two lines above the quotation that must NOT move, in the same docblock family
and in the same file — the ticket warned the two jobs would look identical, and
they do.

## The default taken on AT7

AT7 asks that no suite lose a test case, "run each suite and diff its
`tests`/`pass` count against the pre-ticket baseline". The automated form counts
each file's test declarations against the pre-ticket measurement instead of
spawning the six suites, because `npm test` already RUNS all six — four in the
workspaces group, two in the root group — so what a green run lacks is the
comparison against the earlier number, not the execution. Spawning them again
inside the root group would re-run an 8-second e2e that starts a control plane
and a watcher child process, twice per `npm test`, to learn what the first run
already knows.

The counts were confirmed equal, file by file, to the `tests` line
`node --test` prints, and the diff the AT describes was also done by hand,
before and after:

| suite | before | after |
|---|---|---|
| `packages/cost-surveyor/test/cli.test.ts` | 8 pass / 0 fail | 8 pass / 0 fail |
| `packages/cost-surveyor/test/client.test.ts` | 9 / 0 | 9 / 0 |
| `packages/cost-surveyor/test/policy.test.ts` | 8 / 0 | 8 / 0 |
| `packages/surveyor/test/watch.e2e.test.ts` | 1 / 0 | 1 / 0 |
| `tests/factory-graph-1.test.mjs` | 31 / 0 | 31 / 0 |
| `tests/factory-graph-2.test.mjs` | 23 / 0 | 23 / 0 |

The new file is named without the `no-portuguese-` prefix on purpose. t314 made
the language gates a permanent exception and this ticket may not edit or extend
one; a seventh file wearing their prefix is how it gets edited by mistake next
time.

## The suite

Every workspace green and unchanged from the pre-ticket baseline:
`packages/core` **700**, `packages/runner` **707**, `packages/screen` **145**,
`packages/cost-surveyor` **46**, `packages/surveyor` **29**. The root group is
**398/398**, against 391/391 before — the seven added are this ticket's
acceptance tests, and no existing root test was lost.

`npm run lint` and `npm run typecheck` are green at the root.

## Two things worth keeping

**A `perl -i` sweep over accented fixtures needs the right encoding mode, and
gets it wrong silently.** With `-CSD` the file is decoded to characters while
the pattern's accented bytes are not, and every accented pattern misses — the
run reports success and changes nothing. Without it, byte-for-byte, they match.
The second half is worse: `${nodeId}` in the REPLACEMENT is a perl variable, so
the first pass wrote `` `work node ` `` and `` `description of  at ` ``, which
is a green-looking diff that quietly drops the interpolation. Both were caught
by reading the diff, not by a test. Escape the replacement (`\$\{nodeId\}`), and
read what a sweep actually wrote.

**A closed set of six files still has to be recounted.** Two of the sixteen
diacritics were not this ticket's to touch, and one of the four "real" sites was
not a translation but a stale citation. The ticket said so, and it was right —
but that judgment was made per line, against the source the comment cites, not
by the count.
