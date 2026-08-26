# t326 — the last Portuguese path, and the two gates that must keep spelling it

**Date:** 2026-08-26 · **Branch:** `ticket-326` · **Subject:** one document and
its two parser suites renamed, 144 citations re-pointed across 85 files, and
three of the five predicted reds that turned out to be impossible.

Three commits: the gates first and red (`6a12147`), then the three renames as a
pure `git mv` with a zero-byte diff (`1201ba9`), then the citation sweep
(`5d75473`), and this note.

**This note cannot spell the document's retired name.** AT2 of the new gate
greps every tracked file for the bare Portuguese stem, and a closing note is a
tracked file — the same discipline t299's note recorded for the ledger one
rename earlier. So the old name is written here as "the retired name", and the
two places it is still spelled on purpose are named below.

## The count

| | files | occurrences |
|---|---|---|
| Before, whole tree, case-insensitive | 89 | 152 |
| After | 2 | 18 |

The two that remain are the two gates that cannot retire a name without writing
it, and both are excluded from AT2 by path with the reason in the header:

- `tests/glossary-wire-rename-integrity.test.mjs` — AT2 cannot hunt a substring
  its own assertion has to spell, and `RENAMES` names each old path beside its
  new one. `decisions-rename-integrity.test.mjs` skips itself for the same
  reason and says so out loud.
- `tests/no-portuguese-path-segments.test.mjs` — the stem is the twelfth entry
  of `RETIRED_STEMS`, and its docblock table, its narrative paragraph and its
  three bite fixtures all have to write it. A list of retired words is written
  in retired words, permanently.

The second exclusion is not left to cover nothing: AT2 has a companion test that
asserts `RETIRED_STEMS` really does carry the stem, so dropping it from that list
reds this gate instead of quietly widening its blind spot.

## What moved, file by file

**Three renames (`git mv`, 100% similarity, zero content change).** The document,
`packages/core/test/glossary-wire.test.ts` and
`packages/core/test/glossary-wire-docs.test.ts`. Committed on their own before a
single citation moved, which is the whole point: t305's closing note recorded
that combining a rename with a content rewrite destroys git's rename detection,
and the separate commit makes the diff a pure move that nothing has to infer.

**Twelve logic edits — a constant, an array or a list, each re-read rather than
assumed:**

| File | What changed |
|---|---|
| `packages/test-support/src/glossary.ts` | `GLOSSARY`; this one line repoints all five packages' `no-portuguese-wire.test.ts` gates, which resolve the path through `glossaryTerms()` and never spell it |
| `packages/core/test/glossary-terms.ts` | `GLOSSARY`, the database dimension's own parser |
| `packages/core/test/spec-database-citations.test.ts` | its second, separate local `GLOSSARY` |
| `packages/core/test/no-portuguese-glossary-prose.test.ts` | `GLOSSARY` |
| `packages/core/test/glossary-wire-docs.test.ts` | its own `GLOSSARY`, plus a docblock self-citation and a failure string |
| `scripts/no-anti-portuguese-duplication.test.mjs` | `GLOSSARY_FILE` |
| `tests/no-portuguese-document-tree.test.mjs` | `CONTENT_NOT_SWEPT` |
| `tests/no-portuguese-reader-documents.test.mjs` | `NOT_SWEPT` |
| `tests/decisions-rename-integrity.test.mjs` | `SPEC_DOCUMENTS` and two docblock paragraphs |
| `tests/no-portuguese-path-segments.test.mjs` | the twelfth stem, the docblock table and narrative, three bite fixtures and five spare fixtures |
| `tests/notes-redaction.test.mjs` | `TOUCHABLE` — the one file outside the declared surface, see below |
| `tests/glossary-wire-rename-integrity.test.mjs` | new: the regression gate |

**Seventy-four literal swaps.** Comments, docblocks, table cells and prose across
`DECISIONS.md`, six specifications, eight notes, and the runtime and test files
of all six packages. No logic in any of them.

**Untouched on purpose:**

- **The document's contents.** 838 lines before, 838 after; AT3 pins the number.
  This is what let every line citation into it survive without re-checking.
- **`RETIRED_SPEC_DOCUMENTS`** in `decisions-rename-integrity.test.mjs`. It is
  the frozen record of t299's own rename table, and t299's table never named
  this document — so it does not grow, the same rule that already keeps
  `topografo-cost.md` out of it.
- **The `:791` numbers** in `notes/2026-08-24-t281-closing-note.md`. Filename
  moved, number did not. See below.
- **D20's frozen wire spellings** in `DECISIONS.md` (`--classe`, `pendente`,
  `/quadro`, `estrutura.erros`, …). The one line that changed is the path
  citation; the diff on that file is exactly one line.
- **`.flowpilot/profile.yml`**, gitignored and absent from a worktree checkout.
  If it names the document, that is a residual external-tooling risk this ticket
  cannot reach — the same one t299's FR9 recorded.

## The two anchors, read live off the renamed file

Both verified against the file after the rename, not merely re-pointed, and both
are now a durable assertion (AT4) rather than a read somebody did once:

- **`:796`** is `- **The CONTENT of \`metrica_esperada\` stays \`{nome, direcao, de, para}\`** —`,
  which is exactly the frozen hypothesis format its three citations claim
  (`packages/runner/test/no-portuguese-wire.test.ts` twice,
  `packages/runner/scripts/close-surveyor-outcome.mjs` once).
- **`:791`** is `- **\`total_ms\` and \`lens\` are already English.** Nothing to map.`
  — the sentence the t281 note cites three times.

The t281 note's `:791` was **not** "repaired" to `:796`. That note's own text
dates its claim to what was true while t281 ran, before the translation grew the
document and pushed the same sentence down five lines. Fixing the number would
misrepresent exactly the history the note was written to preserve.

## Three of the five predicted reds could not happen

The ticket asked for five existing fixtures to be updated first and confirmed
red against the pre-rename tree. Two were:

- `tests/decisions-rename-integrity.test.mjs` AT4 — red, `docs/spec/` was not
  the declared set.
- `tests/no-portuguese-path-segments.test.mjs` AT1 — red on all three real
  paths, which is a stronger proof than the scratch-reintroduction the ticket
  proposed, so that technique was not needed.

The other three could not go red, and the reason matters more than the miss:

- **`scripts/no-anti-portuguese-duplication.test.mjs`.** `GLOSSARY_FILE` is
  never used to open the document. Its four "derived strings" (lines 104,
  256-257, 302-305) are a regex and three synthetic source fixtures, every one
  of them an interpolation of the constant rather than a literal — so the file
  is self-consistent under any value the constant takes. Re-verifying them by
  hand, which the ticket asked for, is what established this: there is nothing
  there a literal sed could have got wrong, and nothing there that can go red.
- **`tests/no-portuguese-document-tree.test.mjs`** and
  **`tests/no-portuguese-reader-documents.test.mjs`.** The ticket expected a
  diacritic false-positive once `CONTENT_NOT_SWEPT` / `NOT_SWEPT` stopped
  exempting the right file. There is none, because t281 translated the
  document's prose to English and its Portuguese table rows sit in backtick
  spans, which both sweeps blank before reading. Probed directly: running the
  document-tree sweep over the document's full contents under a non-exempt path
  returns **zero** offenders. Both carve-outs are prospective today — they
  protect the rows against a future widening of the matcher, not against
  anything either sweep can currently see.

So the constants were still worth re-reading one by one, but only two of the
five carried teeth. The citation correctness itself is held by AT2 of the new
gate, which is the assertion that actually covers the 74 prose swaps.

## One file outside the declared surface

`tests/notes-redaction.test.mjs`. Its AT6 governs every file that existed under
`notes/` when t307's redaction ran and fails any edit of one that is not listed
in `TOUCHABLE`. Five of the eight notes this ticket re-pointed are governed and
were not listed, so the full suite went red after the sweep.

Declaring them is the gate's own mechanism, not a loosening of it: the header
says in as many words that a ticket which edits a governed note without
declaring it still fails, and t121 already added five notes to that list for
this identical mechanical reason — a citation of a renamed file that had to move
with it. AT1-AT5 still sweep all five on every run, so nothing redacted can come
back through this door.

Every other file on the branch was in the ticket's declared set, and every file
in the declared set was touched: 92 changed, 91 declared, one surprise.

## Things worth keeping

- **A closing note for a rename cannot spell what the rename retired**, if the
  regression gate greps the bare stem rather than the full filename. Hunting the
  stem is the stricter choice and it is the right one here, but it costs the
  note its vocabulary and it costs the path-segment gate a second by-path
  exclusion. Pair each exclusion with a positive assertion that its subject is
  still there, or the sweep quietly narrows itself.
- **A path constant is not evidence of a red.** Three of the five gates here
  assert their exemption against a fixture built from the constant under test.
  That is a fine design — it documents the rule — but it means changing the
  constant proves nothing, and a ticket that predicts a red from one is
  predicting something the code cannot do.
- **`notes/` has a gate the file tables do not mention.** Any ticket that edits
  a note written before 2026-08-25 will trip AT6 of `tests/notes-redaction.test.mjs`
  and has to declare the file. Worth knowing before the suite goes red, not
  after.
- **A fresh worktree has no `node_modules`.** `npm ci` before the baseline, or
  every workspace suite fails at the loader and reads like a broken main.
