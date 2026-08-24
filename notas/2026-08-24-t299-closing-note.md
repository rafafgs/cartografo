# t299 closing note — the documents a stranger reads, in English

**Subject:** `README.md`, the decision ledger (renamed to `DECISIONS.md`),
`docs/o-que-e-o-cartografo.md`, `docs/formatos/**` and every `docs/spec/**`
outside the wire glossary. The second of the three tickets t281 was split into
on 2026-08-24.
**Commits:** `58631f3` (tests, red at 5), `e6f6cdf` (the renames and every
citation of them), then nine translation commits ending at `5ddeae3`, on
`ticket-299`.
**Written:** 2026-08-24, during development, following t293's and t281's
precedent.

## Line counts

t281's closing note measured this scope at 20 files and 8,432 lines before a
word moved, and that measurement held. What came out:

| | Before | After |
|---|---|---|
| README + explainer | 517 | 527 |
| The ledger | 244 | 245 |
| `docs/formatos/**` | 1,537 | 1,545 |
| `docs/spec/**` (15 files) | 6,134 | 6,240 |
| **Total** | **8,432** | **8,557** |

Real edit volume across those 20 files: **+8,042 / −7,673**. That is a 95%
rewrite rate, against the 97% t281 predicted for prose translated whole — its
warning that "table inertia does NOT transfer" was right: the tables here are
prose in cells and moved like prose. The +125 net lines are almost entirely
rewrapping, plus one paragraph that came out of a fenced block (below).

The rename half landed separately and is measurable on its own: `e6f6cdf` is
**97 files, +204 / −204** — every one of them a single-token citation swap, with
nothing else in the diff.

## The FR8 consumer audit

Every file outside the translated set that quotes an entry of the ledger
verbatim, before and after the translation. The ticket knew about one; the grep
found nine.

| File | Outcome | Why |
|---|---|---|
| `packages/topografo-custo/test/no-portuguese-wire.test.ts` | edited (comment) | D20's `"flags de CLI"` → `"the CLI flags"` — the hit the ticket named |
| `packages/topografo-custo/src/cli.ts` | edited (comment) | The same D20 quote, in a second file the ticket did not list |
| `packages/core/test/domain-intake.test.ts` | edited (box comment) | D20's `"campos e parâmetros de query do JSON da API"` → `"the fields and query parameters of the API's JSON"`; the box's column alignment was rebuilt around it |
| `packages/core/test/no-portuguese-wire.test.ts` | edited (comment) | The same D20 quote |
| `packages/core/src/routes/skills.ts` | edited (comment) | D22's `"nunca resolve 'a mais recente'"` → `"never resolves 'the latest one'"` |
| `packages/core/test/skill-routes.test.ts` | edited (box comment) | D22's longer quote (`skill tem id estável e versões…`), rewrapped inside the box |
| `packages/runner/src/dispatch/render-skill-instructions.ts` | edited (comment) | The same D22 quote |
| `packages/runner/test/cli/run.e2e.test.ts` | edited (comment) | The same D22 quote |
| `packages/runner/src/surveyor/cli.mjs` | edited (comment) | D10's `"copiloto no MVP"` → `"a copilot in the MVP"` |
| `packages/core/migrations/0019_skill_versao.sql` | edited (comment) | D22's quote inside a Portuguese comment. The quote is English now and the sentence around it stays Portuguese: the comment quotes a source that is English today |
| `packages/core/migrations/0005_skill.sql` | edited (comment) | D4's contract rule, cited there as `(D9)`. Same treatment, same reason |

The migrations' own file names and their DDL are untouched — only the text of a
`--` comment moved, which is the treatment the ticket sanctioned for `0021`.

A second pass after the translation found **zero** remaining verbatim Portuguese
quotations of any entry outside the excluded territory (`notas/**`,
`especificacoes/**`, `schema/exemplos/**`, the wire glossary).

### Two quotations outside the ledger that were also stale

Found while translating, and fixed for the same reason:

| File | What it quoted | What it says now |
|---|---|---|
| `docs/spec/runner-and-controller.md` §t273 | `integrar-branch`'s manifest, in Portuguese | `integrate-branch@1.0.1`'s real English text — t280 translated that bundle, so the quotation named text that no longer exists |
| `packages/topografo-custo/test/policy.test.ts` | its own sweep's justification ("the prose word `descrição` is Portuguese the reader reads") | what the sweep is really about: the FIELD name, not the English word "description" |

## The parsers that had to move with the documents

This is the part the ticket did not anticipate, and it is the part worth reading
if you are translating the third sibling. **Six documents of this set are parsed
at run time**, and four of those parsers stood on a Portuguese literal. In every
case the assertion is unchanged and only the vocabulary moved — the t281
discipline, applied five more times.

| Parser | What it stood on | Why it would have gone quiet or red |
|---|---|---|
| `packages/tela/test/spec-routes.test.ts` | a spelled-out numeral in front of `rotas`, plus the phrase `<n> rotas novas do lado do core` | Both regexes matched nothing under the translation: AT2 would have failed on its own floor ("only 0 spelled-out counts") and AT3 outright |
| `packages/core/test/spec-intake-http-codes.test.ts` | the literal word `filtros` in the §6 cell | It parsed ZERO filters and passed vacuously on the floor assertion — the failure mode t281 named: the sweep goes quiet, not red |
| `scripts/check-engine-adapter-spec.sh` | four exact headings, six conformance-kit row labels, and the fragment `interativ` | Checks [2], [3] and [6] would all have failed about a document that lost nothing |
| `packages/runner/test/engine/spec-parity.test.ts` | `## Interface TypeScript` and `## Ajustes feitos na revisão` | `sectionBody` throws "section not found", so the parity gate reds without `types.ts` having drifted by a symbol |
| `packages/topografo-custo/test/{client,policy}.test.ts` | §5 and §3 **by section number** | Confirmed unaffected: number-based selection survives a translated title. Re-read, not assumed |
| `packages/tela/test/inbox-spec-routes.test.ts`, `packages/runner/test/surveyor/manual-proof-credentials.test.ts` | `## 2.` by number; a fenced `npm run surveyor` block | Confirmed unaffected, for the same reason |

Six more tests open one of these documents by PATH (`path.join(REPO_ROOT,
'docs', 'spec', …)`); the rename half updated all six in `e6f6cdf`.

## Phrases that resisted a literal translation

Five, recorded rather than quietly decided.

1. **`topografo`, kept untranslated.** The ticket directed it, and the reason is
   worth keeping: the profile convention itself writes "the evaluator
   ('topografo')", and `packages/topografo-custo` is still spelled that way. Only
   the qualifier moved — `topografo-custo.md` → `topografo-cost.md`,
   `topografo-fluxo.md` → `topografo-flow.md`.
2. **`tela` → `screen`, but only in prose.** The wire glossary's mapping
   (`glossario-wire.md` §5) settles the word, so the documents and their file
   names are `screen`. What did NOT move: `cartografo-tela`, the bin;
   `CARTOGRAFO_TELA_PORT` and `CARTOGRAFO_TELA_TOKEN`, the environment; the
   `packages/tela` path; and `respondido_por: "tela"`, a value the screen really
   writes. Those are t282's and D20's, in that order.
3. **The three-bucket vocabulary of the timeline** (`agente_trabalhando`,
   `esperando_humano`, `fila`) reads as prose in `screen.md` §2 and is not: those
   are the values of the `data-segmento` marker the acceptance tests assert on.
   Left as data, with the surrounding sentence in English.
4. **"Ausência tem nome"**, which appears five times in `graph.md` as the
   heading of an argument about defaults, came out as "Absence has a name". It is
   the one phrase in this set that carries more weight in Portuguese than the
   English keeps — the original is a small aphorism, the translation is a
   sentence. No `(literally "…")` gloss was used: the meaning survives whole and
   only the ring is lost.
5. **`origem não confiável`**, the screen's own 403 page, and the two `<label>`
   questions of the inbox's reason field. They are rendered strings pinned by
   tests, so they stay Portuguese inside code spans, with the sentence around
   them saying so.

**Inline `(literally "…")` glosses used: 0.** Same real zero t280 reported —
the convention exists and this scope did not need it.

## AC3: the ledger crossed the rename intact

23 entries, `## D1 (2026-08-14)` through `## D23 (2026-08-16)`, in order, with
the fixture dates (D1–D18 on 2026-08-14, D19 on 2026-08-15, D20–D23 on
2026-08-16). Nothing merged, nothing reordered, nothing clarified. The
authorship-rule paragraph is translated with its substance intact: preferably
Rafael, anybody else only with his explicit authorization, case by case or in
batches, and every entry recorded by somebody else says who authorized it.

**No `D24` entry was added** (AC4). The file still stops at D23, and the
decision that governs this very ticket is still unrecorded — recording it is the
founder's act.

Two things inside the entries were deliberately NOT repaired:

- **D20's historical wire examples** (`--classe`, `--teto-*`, `pendente`,
  `{erro, mensagem}`, `trabalho.transicao`, `adicionar_no`, `/quadro`) stay
  exactly as recorded on 2026-08-16, before t213 migrated them. They are the
  record of what changed.
- **D18's and D20's sentences saying the repository's documents stay in
  Portuguese** are still there, in English. That is what was decided then; D24 is
  what supersedes it, and a translation that quietly updated the decision it
  supersedes would be rewriting the ledger through the back door.

## FR9: `.flowpilot/profile.yml` was not touched, and could not be

The ticket asked for a best-effort local edit and flagged it as
non-durable. In this checkout it is stronger than that: **the file does not
exist here at all.** `.flowpilot/` is gitignored and lives only in the main
checkout (`~/cartografo/.flowpilot/profile.yml`), which this stage is forbidden
to touch — a worktree agent never reaches into another checkout of the same
repository.

So the residual risk is the full one: the profile still lists the ledger under
its old name in `canonical_docs` and in its two naming conventions, and it will
keep doing so until the flowpilot tooling regenerates it from a tree where the
file is called `DECISIONS.md` — which is the next refinement of any ticket in
this project. Nothing in the repository depends on it; it is a cache the
external tooling rebuilds.

## Gotchas

- **A link TARGET is prose to a line-based sweep.** The new AT1 reads whole
  lines minus code spans, so a markdown link whose URL contains a Portuguese
  function word trips it. `schema/exemplos/grafo-valido-com-ganchos.json` carries
  `-com-` in its own name: `transition-hooks.md` §2 now cites it in a code span
  instead of linking it, with the reason written beside it. That is the sweep
  telling the truth — there IS Portuguese in a reader-facing document, in a name
  this ticket cannot move.
- **`.com` is a Portuguese stopword.** `\bcom\b` matches the TLD of any bare
  URL, so `engine-adapter.md`'s three primary-source URLs are code spans rather
  than autolinks. Whoever writes a URL into a document in this set will meet the
  same thing.
- **A backtick span split across two lines defeats the sweep**, which t281
  already recorded and which bit twice more here: the README's
  `{tipo, no_id, campo, de, para, inversa}` and the inbox spec's two `<label>`
  questions had to be reflowed onto one line each. Any wrap that lands mid-span
  hides Portuguese from a gate that would otherwise catch it.
- **A translated document can make a parser pass vacuously.** The intake gate is
  the case to remember: it kept passing, on a floor assertion it satisfied
  because it parsed zero rows. Before translating a document, grep for a test
  that opens it — and when you find one, read what it MATCHES on, not only what
  it asserts.
- **The factory bundle is hash-pinned, and a citation inside a skill manifest
  cannot be repointed for free.** `alpha-test.json`'s `output` description cites
  `docs/spec/grafo.md`, which no longer exists. Fixing it moves `manifestHash()`,
  which demands a version bump, a new pin in `grafo.json` and — because
  `tests/factory-bundle-closing-note.test.mjs` holds t280's note against the live
  pin — a closing note with a full rename/bump/rehash table for all five skills.
  That gate says out loud that such a bump belongs to a bundle ticket, so the
  edit was reverted and the stale citation left. **It is the one dangling
  `docs/spec/grafo.md` reference in the tree**, and it belongs to whoever next
  bumps that skill.
- **Two stale facts were found and NOT repaired**, because a translation moves
  language and not facts. Both are worth a ticket:
  - `docs/formatos/atlas-bundle.md` §"Integrity" says the manifest hash covers
    `{instrucoes, entrada, saida, checks, permissoes}`.
    `especificacoes/formatos/manifesto-skill.md:80` and `manifestHash()` both say
    `{instructions, input, output, checks, permissions, budgets}`.
  - `docs/spec/webhooks-events.md` §5 publishes a closed HMAC test vector
    (`sha256=4d62c8b3801c05f74e912c122b02b34cf183e64ec81d1bb7dc38bb8f329b1bb2`)
    that does not reproduce. HMAC-SHA256 of `{"id":1,"type":"job.created"}` under
    the secret `segredo-de-exemplo` is
    `sha256=5c0af6262c58fcacaedb78aae0065cee84f8e774f6df778897c37311add509ed`.
    The document tells a reader that if their arithmetic disagrees, the problem
    is theirs.
- **`entities-versioning.md` had English prose inside a ```sql fence.** The
  `contracts_state` paragraph t283 added sat between two `CREATE TABLE`
  statements, inside the block. It is now a paragraph after the block, where a
  reader can see it and where the AT1 sweep can read it.
- **`scripts/check-engine-adapter-spec.test.mjs`'s AT1 is flaky under a parallel
  root run.** It failed once here with "no table row for 'timeout'" and passed
  immediately on its own, before any edit to the document. Not caused by this
  ticket; worth knowing before anybody bisects it.
- **The closing note cannot spell the ledger's old file name.** AT3 greps every
  tracked file for it, and this note is a tracked file. That is why it is
  referred to here by description rather than by name.
