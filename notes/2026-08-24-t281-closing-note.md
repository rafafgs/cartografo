# t281 closing note — the wire glossary in English

**Subject:** `docs/spec/glossario-wire.md` and the files that parse it, the
first and narrowest of D24's series 2/3, split from the original t281 on
2026-08-24.
**Commits:** `3735fc6` (tests, red at 3), `fb284e6` (translation and
co-changes), on `ticket-281`.
**Written:** 2026-08-24, during development, following t293's precedent.

This document was isolated from its two siblings because it is not prose like
the rest of the tree: it is a map of RETIRED names, parsed at run time by four
independent readers, three of which stood on one of its column names as a string
literal. Translating it means moving those literals in the same breath, or the
sweeps that read it go quiet rather than red.

## Line counts

| | Before | After |
|---|---|---|
| Total lines | 829 | 838 |
| Table lines | 460 | 460 |
| Blank lines | 104 | 104 |
| Prose lines | 265 | 274 |

+9 lines, all of them prose. The table half did not move by a single line, which
is the ticket's central claim made arithmetically: the 405 mapping rows are
frozen data, and the only table lines that changed are the 22 header rows and
the 10 lines of the status table.

### Real edit volume

| Kind | Lines changed |
|---|---|
| Prose | +266 / -257 |
| Table (22 headers + status table) | +32 / -32 |
| Blank | +16 / -16 |
| **Total** | **+314 / -305** |

97% of the prose lines were rewritten, against 7% of the table lines. Every one
of the 405 data rows came out byte-identical — verified by diffing the two
versions with the header and status rows filtered out, not by inspection.

### What this means for the sibling tickets

The reader-facing sibling (`README.md`, `DECISIONS.md`,
`docs/o-que-e-o-cartografo.md`, `docs/formatos/**`, the rest of `docs/spec/**`)
is **20 files, 8,432 lines, of which 6,304 are prose** and only 629 are table.

The two ratios this ticket measured do not carry over, and the second one is the
trap:

- **Prose rewrite rate transfers.** 97% here; expect the same on any document
  translated whole. Budget roughly +6,300/-6,100 across that scope.
- **Table inertia does NOT transfer.** 460 of this document's 838 lines are
  frozen identifier pairs, so its 37% overall rewrite rate is an artefact of
  what it is. The sibling's tables are ordinary prose in cells and will move like
  prose. A plan that scales this ticket's line-level rate to the sibling
  underestimates it by roughly a third.

The internal-record sibling (`especificacoes/**`, `notas/**`,
`schema/exemplos/**`) is a further ~7,997 lines, a large share of it JSON that
is structurally inert under a translation — the observation t280 and t293 both
made about the factory bundles applies there too.

## The FR8 consumer audit

Every file that reads this document at run time, or that quotes its wording in a
comment. "Confirmed unaffected" means read in full and found to make no claim
the translation falsified.

| File | Outcome | Why |
|---|---|---|
| `packages/test-support/src/glossary.ts` | edited | `HEADER_CELL` `'hoje'` → `'today'`, the literal section mode uses to drop the table's own header row; four doc comments quoting `superfície`, `hoje`, the `### 5.2` heading and the ` / ` convention sentence |
| `packages/core/test/glossario-wire.test.ts` | edited | `TABLE_MARKER` `'superficie'` → `'surface'`, three header-row fixtures, two doc comments |
| `packages/core/test/glossary-terms.ts` | edited (comments only) | Parsing re-read, not assumed: it selects rows by surface tag and by section number, so a header row never reaches `termOf` and no code change was needed. Three doc comments moved |
| `packages/core/test/glossario-wire-docs.test.ts` | edited (comment only) | One doc comment quoting the `### 2.1 Nomes de tipo` heading. Its selection is by surface AND section, so header rows never matched; its exclusion of this document from its own citation sweep is still correct and untouched |
| `packages/core/test/no-portuguese-wire.test.ts` | edited (comments only) | Quoted the closing section's Portuguese title, `superfície = …` twice, and a `hoje`/`vira` pair in an allow-list comment |
| `packages/runner/test/no-portuguese-wire.test.ts` | edited (comments only) | `superfície = …` twice, plus two `glossario-wire.md:791` citations (see below) |
| `packages/tela/test/no-portuguese-wire.test.ts` | edited (comment only) | One `superfície = routes-cli-report` |
| `packages/topografo/test/no-portuguese-wire.test.ts` | edited (comment only) | One `"hoje → vira"` |
| `packages/topografo-custo/test/no-portuguese-wire.test.ts` | confirmed unaffected | Reads §5.2 and §5.5 by section number, never by column name, and quotes nothing of this document's prose. Its `"flags de CLI"` quote is of **D20** in `DECISIONS.md`, which is still Portuguese and belongs to a sibling ticket |
| `packages/core/test/no-portuguese-database.test.ts`, `packages/core/test/migrate.test.ts` | confirmed unaffected | The two callers of `glossary-terms.ts`. Neither touches the document; both stayed green with zero change to their assertions, which is the regression AT |

### Two consumers the ticket did not list

| File | Outcome | Why |
|---|---|---|
| `packages/core/test/spec-database-citations.test.ts` | edited (comments only) | A third independent reader of the document, missing from the ticket's list. Its parser filters `cells[0] === 'events'`, so header rows never reached it, but three doc comments described the `hoje`/`vira` cells by name |
| `packages/runner/scripts/close-surveyor-outcome.mjs` | edited (comment only) | Cited `docs/spec/glossario-wire.md:791` — a production script, not a test, and the only non-test file in the audit |

## The `:791` citations, and why they were re-pointed and not deleted

Three sites cited `glossario-wire.md:791`: the two runner files above and a
second site inside `packages/runner/test/no-portuguese-wire.test.ts`. FR9 says
to check whether a citation is true before rewriting it, and this one was: line
791 was the §5.6 bullet freezing `{nome, direcao, de, para}` as
`domain/hypothesis.ts`'s hypothesis format. The translation moved it to 796, so
all three were re-pointed there.

Worth knowing for whoever renames this file next: the number moved **twice**
during this ticket. It landed at 795 after the translation, then at 796 when a
missing blank line before the status table was restored. Any line citation into
this document has to be re-read after the last edit to it, not after the first.

## Phrases that resisted a literal translation

Four, all recorded rather than quietly decided:

1. **The four column names.** `superfície`/`hoje`/`vira`/`onde está hoje` →
   `surface`/`today`/`becomes`/`defined in`. `surface` was chosen because it is
   already the word the whole codebase uses for these tags; the other three are
   literal. `defined in` is the one that is not a word-for-word rendering of
   `onde está hoje` ("where it is today") — the cell's content is a file that
   DEFINES the term, the shorter phrase says so, and "where it is today" next to
   a column literally called `today` would have read as the same claim twice.
2. **The status table's fourth column.** `quem levou` → `landed by`, matching the
   document's own "updated by the child that lands" one line above it. The
   ticket ids in the cells were kept as-is; only the connecting words moved
   (`t226 no fio` → `t226 on the wire`).
3. **Two quotations of Portuguese sources.** §1.1 quotes a code comment
   (`o glossário não mapeia nenhuma delas`) and D20's own text
   (`campos e parâmetros de query do JSON da API`); §5.2 quotes D20 again
   (`flags de CLI`). All three
   were rendered in English rather than kept verbatim. The convention permits a
   verbatim Portuguese quotation, but leaving them would have put Portuguese
   back into the prose the new sweep exists to keep out, and `DECISIONS.md` is
   being translated by a sibling ticket anyway. **This is the one place a
   reviewer might reasonably want the opposite call.**
4. **The D18 sentence that was left standing.** The paragraph about
   `glossario-wire-docs.test.ts` ends "the prose around them stays Portuguese,
   which is what D18 decided". That was checked against the tree before it was
   rewritten, per FR9, and it is still literally true: every specification that
   gate sweeps is still Portuguese today. It was translated word for word and
   not repaired. It becomes false when the reader-facing sibling lands, and that
   sibling should fix it there — repairing it here would have been claiming a
   state that does not exist yet.

## One test was narrowed before implementation, on purpose

AT4 asks that the closing section "cites D24 instead of restating the retired
D18 carve-out". The first draft of that check forbade `D18` anywhere in the
section — which would have forced the deletion of a DIFFERENT and true D18
citation two bullets up (the one about extending D18's identifier gates to the
wire). That is exactly the failure mode FR9 warns about, so the check was
narrowed, before any implementation existed, to the one bullet that settles this
document's language: the bullet naming the brand must cite D24 and must not cite
D18. Verified to bite on the pre-translation text and to pass on the new one.

## Gotchas

- **`TABLE_MARKER` is not one check among six — it is the switch for all of
  them.** `glossario-wire.test.ts` recognizes a glossary table by its first
  header cell. Under a mismatched marker the file parses ZERO tables and every
  structural assertion passes vacuously. That is why the D24 test asserts the
  marker before it asserts anything about the document, and why the co-change
  had to land in the same commit as the translation.
- **The `HEADER_CELL` guard is section-mode only.** In surface mode the header
  row is dropped implicitly, because `superfície` never equals `api`. Section
  mode has no such filter, which is the only reason `'hoje'` was ever a literal
  in `packages/test-support`.
- **A backtick span split across two lines defeats a per-line sweep.** The
  pre-translation document had one (`papel: fazer,` / `portao`), and §5.5's
  `{nome, direcao, de, para}` nearly became another — its `para` would have
  landed outside a closed span and tripped the stopword rule. Both were reflowed
  so every code span opens and closes on one line. Whoever edits this document
  next should keep that.
- **A regular expression is an identifier position for the D18 sweep.**
  `packages/core/test/no-portuguese-identifiers.test.ts` masks string literals
  but reads regex literals, so `assert.match(x, /cada linha vira uma coluna/)`
  in the new gate's own fixture failed it on `linha` and `coluna`. The fixture
  asserts by string prefix instead.
- **The status table is one edit away from being parsed as a glossary table.**
  Its first column holds section numbers (`§1.1 to §1.5`), which is what keeps
  every reader off it. If someone ever puts a bare surface tag in that first
  cell, three parsers start counting those rows as mappings.
