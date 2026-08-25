# t308 — the thesis fixture goes, the crossing it proved stays

**Date:** 2026-08-25 · **Branch:** `ticket-308` · **Subject:** the last large
concentration of Portuguese in the repository, and the acceptance test that was
standing on top of it.

Three commits: the tests first and red (`b92d3ac`), the fixture and its four
readers (`da63777`), and this note.

The deleted file — `tests/fixtures/bets-asymmetric-…-example.json`, elided
here on purpose, for the reason the grep section below gives — was 684 lines
carrying 759 Portuguese diacritics: an invented investment thesis, complete
with a ticker, figures in R$ and Portuguese prose. Its replacement,
`tests/fixtures/asymmetric-bets-crossing.fixture.json`, is 364 lines and zero
diacritics.

## The AT11 decision, and why it was not a deletion

The obvious reading of "delete it" is `git rm` and delete the two tests that
read it. **That was rejected, and the reason is a coverage claim that has to be
checked rather than assumed.**

`tests/factory-graph-2.test.mjs`'s `t278` test looks like it already covers
AT11: it walks the graph and proves every required input of every node has a
producer on every path into it. But that is a *static* proof, over schemas — it
says a field with the right name will be produced somewhere upstream. AT11
proves something a schema walk cannot: that an actual conforming payload
survives the whole chain, validated twice at every node (against the graph
document's `contract.input_schema`/`output_schema`, which the executor reads,
and against the manifest's `input`/`output`, which the runner validates), with
the shared fields carried across unchanged; that a gate's routing is a declared
edge; that `escalate-decision`'s `output` structurally refuses a result with no
`human_decision`; and that when the answer *is* there it is transcribed word for
word.

None of that survives deleting AT11. So the fixture was rebuilt rather than
removed, and the tests kept every assertion they had — the diff on them is a
rename of frame keys and a path, nothing else.

## What the replacement is, and what it deliberately is not

The smallest payload set that still validates. `criterion-1`, `assumption-1`,
`scenario-1`, `source-1`, `trigger-1`; one figure, one assumption, one
objection, the two scenarios the contract's `minItems` demands and no third.
The asset is `ASSET-1`. There is no company, no currency figure, no claim about
any market, and nothing a reader could mistake for a position.

That is the point. The fixture's subject is the shape six contracts agree on,
so any content beyond the minimum was decoration that also happened to be the
liability.

## The frame keys, which the ticket did not literally ask for

The ticket's FR2 specified them, and it is worth recording why they were in
scope at all. `travessia`, `no`, `entrada`, `saida`, `pergunta_de_alocacao`,
`aresta_esperada`, `decisao_sem_resposta_humana`, `saida_tentada` were invented
by the fixture, for the fixture. They are not contract vocabulary, and
`tests/factory-graph-2.test.mjs`'s own doc comment listed them among the things
"no bundle edit could have changed" — true only because no bundle edit had ever
reached the fixture. This one does, so under D24 they move:
`crossing` / `node` / `input` / `output` / `allocation_question` /
`expected_edge` / `decision_without_human_answer` / `attempted_output`. That doc
comment is corrected in the same commit; leaving it would have left the file
claiming an exception it no longer takes.

What did **not** move, and is out of scope by name: `perguntas_respondidas`,
`pergunta` and `resposta` are `escalate-decision.json`'s own schema property
names and the control plane's projection vocabulary
(`packages/core/src/domain/context.ts`), and `resultado` is the reserved routing
key (`packages/runner/src/dispatch/parse-node-result.ts`). Renaming any of them
is a manifest change owned by another spec. Their *values* in the fixture are
English.

## The one surviving hit, which is not a leak

Grepping the tree for the deleted file's stem returns exactly one line, and it
is line 21 of `notes/2026-08-25-t282-closing-note.md` — a row in a dated table
recording the rename t282 itself performed, old name on the left, new name on
the right. It is a record of a commit that happened, not a pointer to a file
anybody should open: the same category
`tests/no-portuguese-path-segments.test.mjs` already carves out for `notes/` in
`FROZEN_TREES`, and the same call t121 made. It was left exactly as written,
deliberately. **A future reader auditing "no reference to the deleted fixture"
should expect that one hit and stop there.**

Which is also why this note never spells the old filename in one piece. The
ticket's own acceptance criterion is that the grep returns *one* line, and a
closing note that pasted the search term four times would have made its own
criterion read as broken. Anywhere the name is needed for sense, it is elided.

## What the ticket did not know it was taking: two readers in `packages/runner/`

The ticket's declared shared-file surface named four readers. There are six.
`git grep` over the whole tree finds two more, both in the workspaces test
group, which is why a root-group-only check would have missed them:

| File | What it does with the fixture |
|---|---|
| `packages/runner/test/dispatch/render-skill-instructions.test.ts:781` | AT18 renders all six manifests against the fixture's per-node inputs and asserts no `{{input.` token survives, counting 26 resolved placeholders |
| `packages/runner/test/dispatch/dispatch.test.ts:4542` | t204's AT19 resolves `collect-fundamentals`'s manifest against the fixture's input for that node and asserts the rendered title reaches the session's argv |

Both read the fixture by its Portuguese frame keys (`travessia`, `no`,
`entrada`), so both were rewritten with the same rename. AT19 additionally
pinned the old fixture's invented company name as a literal constant,
`THESIS_TITLE` — one of the only places that name lived outside the fixture
itself, and a reminder that a fixture's content leaks into whatever asserts on
it. It is now `CROSSING_TITLE = "ASSET-1 sample crossing"`.

**This is the constraint that shaped the fixture, and the trap for anyone who
edits it next.** AT18 does not merely validate the inputs against a schema: it
*renders* each manifest's `instructions` and requires every `{{input.<path>}}`
placeholder to resolve. That is strictly stronger than schema validation — a
schema-optional field that a manifest names in its body is still mandatory here.
So each step's input has to carry, on top of its `required` fields:

- `triage`: `job.title`, `job.body`, `asset`, `intended_size`,
  `project.triage_criteria`, `project.circle_of_competence`,
  `project.portfolio` (8 occurrences)
- `collect-fundamentals`: `triaged_thesis.{title,asset,hypothesis,research_scope}` (4)
- `analyze-asymmetry` and `red-team`: `triaged_thesis.{title,asset,hypothesis}` (3 each)
- `size-risk`: `triaged_thesis.{title,asset}` (2)
- `decide`: `triaged_thesis.{title,asset}`, `sizing.{position_size_pct,
  max_accepted_loss_pct,exit_trigger}`, `perguntas_respondidas` (6)

26 in total, and AT18 asserts that number literally. Trim a field out of this
fixture for being schema-optional and the runner group goes red, not the root
group.

## A closing note cannot quote what the ticket deleted

Worth knowing before the next translation ticket writes its own note.
`tests/no-portuguese-path-segments.test.mjs` freezes `notes/` — but that gate
reads path *segments*. Note **contents** are read by
`tests/no-portuguese-document-tree.test.mjs`'s `AT2`, which sweeps the whole
document tree for diacritics and carves out nothing. The first draft of this
note quoted the deleted fixture's invented company name to show what
`THESIS_TITLE` used to hold, and the root group went red on the one `í` in it.

The right fix was the prose, not the gate: describe what the constant held
instead of reproducing it. The two rules point the same way anyway — a note
about removing Portuguese content is a strange place to reintroduce a line of it.

## Gates

| Gate | Result |
|---|---|
| `npm test` — `workspaces` group | pass |
| `npm test` — `root` group | pass, 361 tests |
| `npm run lint` | pass |
| `npm run typecheck` | pass |

The root group's count is unchanged at 361, which is the ticket's own AC3: AT11
and `t276` were edited, never dropped. `npm ci` was run clean before the
baseline was measured.

The red was real and read for its reason before anything was built: AT11 and
`t276` stopped at `artifact does not exist yet:
tests/fixtures/asymmetric-bets-crossing.fixture.json`, and `FR10 — every path
the README points at exists` reported the two dead README links to the deleted
file. Not one import error, not one broken fixture — the three failures were
exactly the three the ticket predicted.

## What is still open

- **Every other Portuguese artifact in the repository.** This ticket's surface
  was one fixture and its readers, and the working notes under `notes/` remain
  outside every sweep by design.
- **A live execution of the bets graph** (`t109`). AT11 proves the crossing by
  contract, not by dispatch; the bundle README says so at `:246-260` and still
  does. When `t109` lands, a real run through the runner is the stronger test
  and this fixture is what it should be seeded from.
