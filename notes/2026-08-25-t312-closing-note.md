# t312 — the tests stop asserting a language the product no longer speaks

**Date:** 2026-08-25 · **Branch:** `ticket-312` · **Subject:** the 24 failures
t309 left behind, the four fixture renames, and the 28 files a diacritic grep
could not see.

Five commits: the two sweeps first and red (`f415524`), the fixtures and their
readers (`4096a5d`), the 24 inherited failures (`62995be`), the mid-size suites
(`60c7067`), the two big ones (`470d8dd`), and this note.

## The count, against the floor the ticket gave

The ticket said to treat the diacritic grep as a floor and not a checklist. It
was right by almost exactly its own size.

| | files |
|---|---|
| flagged by the diacritic grep on day one | 39 |
| edited in the end | **66** |
| of those, carrying **zero** diacritics to start with | **28** |

Twenty-eight files — `intake/prompt.test.ts` and
`dispatch/pre-session-failure.test.ts` among them, exactly as t309 predicted,
plus twenty-six nobody had named. What put most of them over the line was one
word: **`ficha`**, 147 occurrences across 39 files. It has no diacritic, and no
stopword list in this repository had it, which is why it survived t309's own
sweep of `src/` — and still does, in about twenty files there. The final gate
ticket will see them the moment its scan reads comments.

`packages/runner/test/**` now holds **36 diacritics in 5 files**, and every one
is on a line pinned by hand in the new sweep, with its reason.

## The suite

`packages/runner`: **677 pass / 0 fail**, against the 647 pass / 24 fail baseline
recorded in `notes/2026-08-25-t309-closing-note.md`. The arithmetic is exact —
671 tests existed, all 671 still exist, and the six the new sweep adds make 677.
No test case was lost to a rename or an over-eager edit.

Every workspace is green: `packages/core` 691, `packages/runner` 677,
`packages/screen` 126, `packages/cost-surveyor` 46, `packages/surveyor` 29.
`npm run lint` and `npm run typecheck` are green at the root.

**The root group is 360/361, and the one failure is the one the ticket said
would still be there.** `tests/no-portuguese-document-tree.test.mjs`'s AT2 flags
three lines of `notes/2026-08-25-t309-closing-note.md` — t309's own note,
quoting the Portuguese it replaced outside a backtick span. It is the 25th of
main's 25 red tests, and the founder filed the remainder ticket for it. Nothing
in this ticket touches it, and nothing in this ticket can: a note that quotes is
what tripped it.

## The split marker was a bug, and it was fixed as one

`factory-graph-software.e2e.test.ts:463` is the one of the 24 that is not a
translation, and it is worth reading before it alarms somebody again.

```js
const bodyOf = (nodeId) => toldTo(nodeId).split('## O contrato do no')[0];
```

The heading that marker names was renamed in source by t309. A split marker that
matches nothing **does not fail** — it returns the whole prompt, the rendered
`contract.checks` included, and those legitimately carry
`{{input.project.test_command}}` unresolved because a graph document's checks
are rendered raw. So the failure surfaced as
`assert.ok(!dev.includes('{{input.'))`, which reads like a
placeholder-resolution regression and is not one. The marker is corrected to the
heading the renderer emits today, and a comment above it now says why the
failure looked like something else.

Two more of the same family, neither of them a stale literal:

- `render-skill-instructions.test.ts` anchors its `### What you have to produce`
  ordering assertion on a newline now. The contract section forward-references
  that heading in prose, and in English the whole reference fits on one rendered
  line — in Portuguese the same sentence wrapped mid-heading, so a bare
  `indexOf` used to find the heading itself. The assertion is unchanged in what
  it claims; only its anchor is.
- `similarity.test.ts` needed a fixture rebuilt rather than translated. Its
  disjoint pair scored 0 because the two Portuguese sentences shared no token,
  and the literal translation shared the word "the".

## The four renames, and the pins that had to move with them

`skill-redigir-nota` → `skill-draft-note` (`draft-note`), `skill-revisar-nota` →
`skill-review-note` (`review-note`), `skill-travessia-fazer` →
`skill-do-crossing` (`do-crossing`), `skill-travessia-conferir` →
`skill-check-crossing` (`check-crossing`). The ticket's default names were kept:
they follow `record-crossing` (t280/t293) rather than inventing a convention for
four files, and nothing better surfaced.

**A manifest is content-addressed, and the ticket did not say so.**
`manifestHash` covers `instructions`, `input`, `output`, `checks`, `permissions`
and `budgets` (`packages/core/src/domain/manifest.ts:90`), so translating the
instructions moved all four pins. Every one was recomputed and rewritten,
including the two copies `test/fixtures/graph-traversal.json` carries in
`skill_ref`. This was not optional and it would not have failed quietly: the
registry recomputes the pin from the content and refuses a manifest that
disagrees with it (D4), so a stale hash fails at `POST /v1/skills`, in four e2e
suites at once.

The readers all resolved: `dispatch.test.ts`,
`controller/graph-traversal.e2e.test.ts`, `cli/run.e2e.test.ts`, and the two
operator scripts — which read id and hash off the API response, so they needed
only their filename lines.

## The gate was not weakened

`test/no-portuguese-user-facing-strings.test.ts` has exactly one change in it:
the old fixture filename quoted inside a `VERBATIM_QUOTATIONS` entry's `reason`
string. That is a path reference catching up with a rename. The gate's
forbidden-word list, its detector, its two pin lists and its own
Portuguese-by-construction content are untouched, and its five tests pass
unmodified.

**One thing the next ticket has to pick up, and it is this ticket's doing.**
That pin exists because `scripts/spike-surveyor-flow.mjs:124-125` quotes the
`instructions` of the fixture now called `skill-draft-note.json` — and this
ticket translated those instructions while the ticket's Code Changes table
forbade touching anything in that script beyond its fixture-path line. So the
quotation is now a citation of a sentence that no longer exists. t309's note
predicted this exact moment ("it goes English when the fixture does, and this
pin says so"), and the ticket's Out of Scope overrode it deliberately, so the
resolution belongs to whoever owns `scripts/`: translate those two lines to
match the new instruction and DROP both pins, which will then be landing on
English and will fail their own meta-test.

## What stayed Portuguese, and why

The six the ticket named are all still there, untranslated, and the two files
that prove it (`dispatch/parse-node-result.test.ts`,
`synthesizer/parse-graph-proposal.test.ts`) still pass: `resultado` with
`aprovado`/`retrabalho`, `` `grafo-proposto` ``, `sempre`, `no_com_contrato`,
`grafo_invalido`, `intake-proposto.json`.

**Those two files are not byte-for-byte unmodified, and the ticket's Acceptance
Tests said they would be.** They could not be: both carry Portuguese *prose*
around the tokens — nine diacritics in one, two in the other — and FR1 and AT1
both reach it. The prose was translated; not one assertion on a kept token was
touched. This is the one place where the ticket's AT list and its FR list
disagreed, and FR1 won.

Three more tokens joined the kept list, each measured rather than assumed:

- **`sessao`** — `src/dispatch/report.ts:589` signs an event actor with it when
  the job stands on no node. t309 translated that file around the literal.
- **`depois`** — a key of the frozen hypothesis input
  (`entrada: { execucao_id, depois }`), pinned in `no-portuguese-wire.test.ts`.
- **`banco_de_testes.caminho`** — the executor-environment projection, which
  `src/dispatch/resolve-executor-environment.ts:53` says out loud is Portuguese
  on purpose.

And one category stayed by judgement, which is worth disagreeing with in the
open: **the illustrative ids this repository reuses everywhere.**
`implementar`, `conferir`, `publicar`, `redigir`, `revisar`, `fazer`,
`nota-curta`, `cartografo/redigir-nota`, `artigo-revisado`,
`travessia-automatica`, and the artifact names `nota.md`, `parecer.md`,
`saida.md`. The ticket's Out of Scope makes the argument for the ones outside
`packages/runner` — they are the same illustrative convention in
`schema/examples/`, `docs/spec/graph.md`, `packages/core/test/`,
`packages/screen/test/` and `packages/test-support/` — and the argument does not
stop at a package boundary. Renaming the runner's half of a repo-wide
convention is worse than the convention. Three of them are also read by
`scripts/spike-real-session.mjs`, `spike-real-session-codex.mjs` and
`spike-t106-human-escalation.mjs`, none of which this ticket may touch, so
renaming would have broken proofs no test runs.

Only `fazer` needed saying in code: it is the only one of them that is also a
Portuguese verb, so it is the only one the stopword sweep can see. It is masked,
by name, with the reason.

## The two sweeps

`test/no-portuguese-runner-tests.test.ts`, modelled on the package guard rather
than on a new method. AT1 is a whole-file diacritic pass; AT2 is the same closed
stopword list applied to the whole file instead of to its literals, with the
wire tokens removed from the text before the pass rather than argued about at
every call site.

Both were written and confirmed failing — 535 flagged lines across 66 files —
before a single translation landed. Four meta-tests ride with them: the walk
reads the whole tree, every pin still lands on something that needs excusing,
AT2 bites on the plain-ASCII Portuguese that is its whole reason for existing,
and AT2 does not bite on the kept wire tokens.

Nine lines are pinned out, and three of them are the interesting kind:

- `fixtures/codex-input-request.jsonl:4` — a RECORDED frame of a real
  credentialed codex run. **The `ficha` → `ticket` pass rewrote it**, which
  falsified a recording, and it is restored byte-for-byte. A fixture whose test
  name says "of a real credentialed session" is evidence, not authored text, and
  a bulk rename does not know the difference.
- `surveyor/close-outcome.e2e.test.ts:38` — an English sentence that LISTS the
  frozen wire keys and names the decision freezing each.
- `surveyor/spread.test.ts:196` — a Portuguese DETECTOR, the same shape the
  package guard is built from.

The other six are two-byte-character fixtures that measure an argv limit and a
truncation offset. They are about bytes, not about language.

## Things the next ticket should know

- **A bulk word replacement will happily edit a recording.** The `ficha` pass
  hit `test/fixtures/codex-input-request.jsonl`, a captured transcript. Before
  running one over `test/`, exclude `.jsonl` fixtures — or read the diff of
  every data file it touched, which is how this one was caught.
- **`no-portuguese-identifiers.test.ts` DOES scan `test/`.** Only the
  user-facing-strings guard excludes it. A regex LITERAL is code to that gate,
  so a Portuguese wire token written as `/\b(?:sessao)\b/` is an identifier and
  fails; the same token inside a string is masked. Build such regexes from a
  string array.
- **Renaming a skill fixture renames its hash.** See the manifest section above.
  Nothing warns you; four e2e suites fail at `POST /v1/skills` instead.
- **Two comments were stale rather than Portuguese, and only reading them
  found it.** `dispatch.test.ts:4333` claimed `sessoes` was a wire key and that
  binding it locally would break the identifier guard; `GET /v1/sessions`
  answers `sessions` since the document tree was renamed.
  `session-cleanup.claude-code.test.ts` quoted invariant 3 of the FROZEN
  engine-adapter contract in Portuguese and cited `:778`, where the invariant
  now sits at `:844` — the same stale line reference t309 found in two adapters
  and did not find here. A translation pass is the only time anybody reads these
  lines; budget for correcting them, not only for translating them.
- **`factory-graphs/asymmetric-bets/skills/escalate-decision.json` still carries
  a Portuguese placeholder**, `{{input.perguntas_respondidas}}`. It is outside
  every ticket in this series so far. The runner tests around it are English
  now, which makes it the only Portuguese left on that path.
