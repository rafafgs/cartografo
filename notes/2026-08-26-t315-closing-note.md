# t315 — the last of the three-way split, and the only one with nothing red behind it

**Date:** 2026-08-26 · **Branch:** `ticket-315` · **Subject:** the 35-file floor
the ticket gave, the 51 files it turned out to be, and the two rounds it took to
find them.

Five commits: the two sweeps first and red (`862a93c`), the four biggest suites
(`f930b47`), the intake/proposal/CLI fixtures (`664be7d`), the glossary and spec
gates (`f7b5f8a`), the tail (`6d5dbbc`), and this note.

## The count, against the floor the ticket gave

The ticket's own number was exact and was still a floor. Re-measured on the
first day of work: **35 files, 428 diacritics** — to the file and to the
character.

| | files |
|---|---|
| flagged by the diacritic grep (AT1) on day one | 35 |
| flagged by the stopword pass (AT2) on day one | 47 |
| edited in the end | **51** |

AT1's 35 turned out to be a strict subset of AT2's 47. The ticket predicted "at
least 17 more files" with zero diacritics; the measured number with the runner
gate's own word list was **12**, and every one the ticket named by hand was
among them: `ficha` as a loanword for "ticket", in 13 files; the corrupt-database
fixture at `health.test.ts:101`; the type-refusal fixture at
`domain-graph.test.ts:511/534`; and the two invalid-URL fixtures at
`webhooks-routes.test.ts:106-107`.

**Then both sweeps went green, and the count moved again.** A re-measure of the
whole tree against a wider Portuguese vocabulary — after the gate was passing —
found **144 more lines in 24 files**: prompts (`trabalhe`, `Redija a nota.`),
scratch directories (`espelho`, `primeiro`, `dados`), a runner name (`laptop do
fundador`), refusal fixtures (`nem objeto`, `nem sequer um objeto`), a hook
consumer (`consumidor quebrado`), an unknown-id fixture (`inexistente`) and a
synthetic migration (`0003_terceira.sql`).

That is the lesson t312 wrote down, arriving a second time in the same ticket: a
closed list is a floor, and a green sweep proves the list is exhausted, never
that the file is. The 52 words that found the tail are a third `STOPWORDS`
group, so the floor stays where it was moved to.

`packages/core/test/**` now holds **20 diacritics in 5 files**, and every one is
on a line pinned by hand in the new sweep, with its reason.

## The suite

`packages/core`: **700 pass / 0 fail**, against the 691 pass / 0 fail baseline
this ticket started from. The arithmetic is exact — 691 tests existed, all 691
still exist, and the nine the new sweep adds make 700. No test case was lost to
a rename or an over-eager edit.

Every workspace is green: `packages/core` 700, `packages/runner` 707,
`packages/screen` 145, `packages/cost-surveyor` 46, `packages/surveyor` 29. The
root group is **391/391**. `npm run lint` and `npm run typecheck` are green at
the root.

## The `outcome`/`evidencia` case (FR3), as it was actually resolved

The ticket named one instance and asked for it to be resolved against the
source. It was, and the same rule found four more.

**`outcome: 'passou'` → `'pass'`**, at `executions.test.ts:563`,
`leases.test.ts:1059` and `replay-consistency.test.ts:357`.
`src/repositories/skill.ts:185` declares `GATE_OUTCOMES = ['pass', 'fail',
'escalate_human']` and refuses a manifest whose gate enum is anything else;
`'passou'` was never one of the three. `domain-context.test.ts:196` already read
`'pass'`, which is what made the disagreement visible.

**`evidencia` → `evidence`.** The field name is read by NOTHING under
`packages/core/src` — the grep is empty. The only declaration anywhere is
`packages/runner/src/surveyor/proposal.ts:168` (`FlowEvidence.evidencia`), which
is the surveyor's proposal payload and not something any fixture here builds.
Every `evidencia` in this package sat inside a skill-manifest `output` schema
the fixture itself defines, so renaming it is a fixture-local rename with no
wire on the other end. Nine lines across five files.

Three more of the same shape, found by translating the assertion rather than the
prose around it:

- **`node_type: 'trabalho'` → `'work'`** and **`'portao'` → `'gate'`**, in four
  files. `schema/graph.schema.json:191` has declared `"enum": ["work", "gate"]`
  since t178, `src/repositories/skill.ts:197` calls those "the manifest's own two
  words", and nothing in `src/` branches on the Portuguese.
- **the `trabalho` TABLE**, named in three docstrings. It is `job`
  (`src/repositories/session.ts:361`), and has been since D20.
- **`usuario` as a credential type**, at `credentials.test.ts:112`.
  `src/repositories/credentials.ts:34` declares `'user' | 'runner'`.

## Wire tokens found beyond `resultado` and `sempre`

FR4 named two. The sweep found eight more that are live wire, and they are
masked by POSITION rather than pinned by line, because each recurs across many
files:

| token | what really writes it |
|---|---|
| `antes`, `depois` | `src/repositories/proposals.ts:548-549`; `src/routes/proposals.ts:750-751` reads `execucao_id`/`depois` off the body, and that file's header calls the vocabulary frozen |
| `fonte`, `observacao` | `packages/runner/src/surveyor/proposal.ts:131` declares `FlowEvidence.fonte`; `docs/spec/screen-graph-editor.md:74` documents `{"fonte": …, "observacao": …}` as what the graph screen sends |
| `pergunta`, `resposta` | the two keys of every entry of `input.perguntas_respondidas`, built by `src/domain/context.ts:266-267` and `src/routes/jobs.ts:127-128` |
| `projeto` | a field of `LeaseCeilings`, `src/routes/leases.ts:132`, read at line 217 |

The mask blanks these only where they head a property. As a VALUE the same word
is prose and still goes red — which is what caught `merge_commit: 'depois'` in
`domain-context.test.ts`, a fixture meaning "after" and not naming a field.

`grafo-proposto` and `intake-proposto.json` were spot-checked, as FR4 allowed:
neither appears anywhere in this package. Nothing was found to keep under t309.

## Two `packages/core/src` files still emit Portuguese

Out of Scope says to record these rather than fix them, so: **there is a ticket
here.**

- `src/repositories/input-request.ts:265` writes the block reason
  `aguardando resposta da pergunta ${id}`. Four assertions spell it that way
  because the control plane does.
- `src/cli/skill-import.ts:95` writes the draft placeholder
  `{$comment: 'revisor humano escreve o JSON Schema aqui'}`, and line 434 parses
  the refusal prefix `rejeitar:`. Three assertions read them back.

Both are pinned here, each citing the source line.

## The one reversal, and why it is not this ticket's call

`tests/t313-docs-specs-drift.test.mjs` AT7 went red halfway through, and it was
right to. t313 kept a Portuguese example in `docs/spec/intake.md` §2 **on
purpose** — intake accepts an item in any language, and the example is
user-SUBMITTED content, not project prose — and gated that exception on
`domain-intake.test.ts` and `intake-routes.test.ts` still submitting it. This
ticket had translated it.

`Migração 0005`, `Colunas novas em trabalho e as duas tabelas do intake.` and
`a migração roda do zero` are restored in all twelve lines and pinned, citing
t313. Reversing a decision another ticket recorded and gated is not something a
translation sweep gets to do quietly; if the founder wants that example in
English, it is one edit to `intake.md` plus AT7, and it belongs to whoever owns
the D24 series.

Those twelve lines are 14 of the 20 diacritics left in the package.

## FR5's pin turned out to be unnecessary, and the file needed a one-word edit

FR5 says `no-leaked-row-keys.test.ts` "needs a pin in the new sweep, not an
edit". Measured, it is the other way round:

- The four D20-frozen column names in that file (`corpo`,
  `criterios_de_aceite`, `transcricao_truncada`,
  `transcricao_tamanho_original`) never fire. They are backticked or
  `snake_case`, and both shapes are masked before either sweep reads the line.
  The file needs no pin at all.
- The one line that DID fire is `:16`, `is a ficha of its own` — a Portuguese
  loanword sitting in English prose, which is neither a wire token nor a D20
  column name. Pinning it would have written an exception that AC2 forbids in
  the same breath, so it reads `ticket` now. Nothing else in the file moved.

## What the gate does not report, and why

Three masks and a pin list, and the split between them is whether the excuse
belongs to a WORD or to a LINE.

- **`WIRE_KEYS`** — the eight-token table above, by key position.
- **`RETIRED_NAMES`** — the pre-D20 vocabulary, blanked only where it is
  delimited (backticked, quoted, or a path segment). The glossary gates are a
  map of retired names and a map of retired names is written in them.
  Undelimited, the same word is prose and goes red. **Right after a `key:` it is
  a stale VALUE and also goes red** — that exception is what surfaced
  `node_type: 'trabalho'`, and it is worth keeping the next time somebody
  widens the mask.
- **`PROTOCOL_TOKENS` / `ILLUSTRATIVE_IDS`** — what t269, `docs/spec/graph.md:547`
  and FR6 decided to keep. `triagem` is the only FR6 id that needed naming: it
  is the bets graph's entry node in `schema/graph.schema.json:95`,
  `docs/spec/graph.md:97-99` and `factory-graphs/asymmetric-bets/`, and it is
  also a word the runner's stopword list has.
- **`OUT_OF_SCOPE`** — 33 lines, each excused for a reason no regular expression
  encodes.

## Three traps for whoever reads this next

**A translation can change what a test proves.** `input-requests.test.ts` AT5
asserts that a question with NO token in common is a precedent of nothing. The
English pair shared the word `the`, and `MINIMUM_TOKEN_LENGTH = 3`
(`src/domain/similarity.ts`) counts it, so the assertion started failing on a
pure rename. The dissimilar question was reworded to keep the intersection
empty. Any file that asserts on `similarity` has this hazard.

**Some fixtures are about bytes, not language.** `kebabCase` folds combining
marks, and an all-ASCII sample proves nothing; `sessions.test.ts:737` needs a
multi-byte character to prove a byte count is not a character count, and
`:768` needs the opposite. The first is pinned; the second and third read in
English and keep the property (`…`, and ASCII).

**Retired names asserted to be DEAD cannot be translated.** `/v1/sessoes`,
`/v1/perguntas/:id/resposta`, `entity: {type: 'trabalho'}`, the `uso`/`recurso`/
`ferramenta`/`motivo` payload keys and the `travada`/`concluida`/`cota` statuses
are all asserted to be refused or 404. Translating any of them would prove that
a name which never existed is gone.
