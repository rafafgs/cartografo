# t309 — the runner's prompts stop being the one place nobody reads

**Date:** 2026-08-25 · **Branch:** `ticket-309` · **Subject:** 679 Portuguese
diacritics across 30 files of `packages/runner`, and the t180 exemption that
had kept every one of them out of the guard's sight.

Four commits: the tests first and red (`d6a2cad`), `src/dispatch/`
(`d3bce63`), the three prompt builders (`61bb83e`), the nine operational
scripts (`3471a41`), and this note.

The measurement in the ticket held exactly: `grep -rloP` over
`packages/runner/src` and `packages/runner/scripts` returned 31 files and 679
diacritics on the day the work started, one of which (`run-graph-traversal.mjs`)
needed no change.

## FR7 — the allowlist was replaced by a walk

**Chosen: the full sweep.** `SCANNED_FILES` is gone; `scannedFiles()` walks
`src/`, `scripts/` and `bin/` for `.ts` and `.mjs`, excluding `test/`.

The ticket left this open and recommended the sweep, and the evidence agreed:
a probe run before the change confirmed that a full literal sweep fires only
inside this ticket's own surface, so replacing the list cost nothing in
collateral. The argument for the enumerated list — that it is the file's
existing convention, and that an exception should be written down one line at
a time — is real, and it is kept where it belongs: `OUT_OF_SCOPE` and the new
`VERBATIM_QUOTATIONS` are both still pinned **by line**, with a reason each,
and each has a meta-test that fails loudly when a pin stops landing on
Portuguese. What the list did badly is exactly what happened here: t180 named
the files that existed at t180, t144 and t254 each added the one file they
touched, and the 30 files written in between never joined. A directory cannot
forget to add itself.

**`bin/` was added to the sweep though the ticket said `src/` and `scripts/`.**
It is clean today, so it costs nothing, and it is the package's entry point —
leaving the one tree a user executes outside the guard would have rebuilt the
same hole at a smaller scale.

## FR6 — the protocol tokens, and a third one the sweep found

`resultado` and `` ```grafo-proposto `` **stay**, as the ticket decided. AT3 is
the proof: `test/dispatch/parse-node-result.test.ts` and
`test/synthesizer/parse-graph-proposal.test.ts` still pass **unmodified**.

The sweep turned up two more of the same kind, and they stay for the same
reason:

- **`sempre`** — the edge `condition` a single-exit node must emit, documented
  at `docs/spec/graph.md:547` and carried as an example in
  `schema/graph.schema.json`. `synthesizer/prompt.ts` teaches it; the import
  gate matches it.
- **`intake-proposto.json`** — the file `intake/prompt.ts` tells the session to
  write and `intake/generate.ts` reads back. That file already documented the
  decision ("the file NAME stays as it is: it is data the session is told to
  write, not a code identifier"), and t309 did not disturb it.

`no_com_contrato` (a soundness rule id) and `grafo_invalido` are quoted in the
same prompts and are wire for the same reason.

## FR5 — three verbatim quotations, not one

The ticket found one and predicted there might be others. There are three, all
now pinned in `VERBATIM_QUOTATIONS` with the line and the reason:

1. `scripts/measure-executions.mjs:10-11` — quotes
   `notes/2026-08-15-closed-learning-loop.md`. The ticket's `:10-11` was right;
   an initial third pin on line 12 was wrong and the meta-test caught it, since
   that line carries no diacritic to excuse.
2. `src/surveyor/spread.ts:10-11` — the **same** note, quoted by the module that
   exists to answer it. Not named in the ticket.
3. `scripts/spike-surveyor-flow.mjs:124-125` — quotes the `instructions` of
   `test/fixtures/skill-redigir-nota.json`, which this ticket leaves alone.
   This pin will fail the day the tests ticket translates that fixture, which is
   the correct behaviour: the quotation goes English exactly when its source
   does, and somebody re-reads it rather than inheriting it.

**`scripts/measure-executions.mjs` was not modified at all.** Outside the
protected quotation it was already entirely English, so the Code Changes row for
it is a no-op. `src/surveyor/spread.ts` likewise: it needed the pin, not a
translation.

## FR4 — three stale quotations, not two

Both the ticket named, plus one it did not:

- `dispatch/prompt.ts:12` quoted the engine-adapter spec's section as
  `"Fora de escopo (v0)"`; the heading reads `## Out of scope (v0)` today.
- `engine/codex-adapter.ts` and `engine/claude-code-adapter.ts` quoted invariant
  3 in Portuguese. Replaced with the spec's current wording, "`getStatus` only
  returns a terminal status after `onFinished` has run" — **and the line
  reference was stale too**: both cited
  `docs/formats/engine-adapter.md:778`, where the invariant now sits at `:844`.
- **New:** `synthesizer/prompt.ts` quoted README principle 3 as *"sem contrato o
  sintetizador compõe por alucinação"*. `README.md:304` has said "with no
  contract, the synthesizer composes by hallucination" since it was translated.

Both permission files (`engine/permission-policy.ts`,
`dispatch/parse-permission-denial.ts`) cited a section as `"Permissões da
sessão"`; it is `### The session's permissions` (`:318`) today.

## FR3 — nine rationale sites, and the claim that had already expired

The ticket predicted eight and said "any others the sweep turns up". There are
nine. Every one was rewritten in place, never deleted.

Eight justified the exemption by pointing at the registered skill manifests as
still-Portuguese. **That had stopped being true several tickets before this one
was written** — every example under `specs/formats/examples/` and every skill in
the factory bundles is English today, and nothing came back to the comments.
Each rewrite says so rather than quietly dropping the claim, because the
interesting fact is not that the sentence was wrong but that it was wrong in
eight files at once and nothing noticed: a rationale is the one kind of comment
no test reads.

The ninth — `src/dispatch/render-input-values.ts` — is **a file the ticket's
Code Changes table never named**, and the reason it was missed is worth
recording: it carries no diacritic, so neither AT1 nor AT2 can point at it, and
the grep that built the ticket's file list could not see it either. It renders
`### Valores de entrada` straight into the same prompt
`render-skill-instructions.ts` builds, so leaving it would have left that prompt
bilingual on its own. Its heading, its truncation notice and one now-stale
docstring reference to that heading were translated with it.

## FR8 — the header paragraph

Kept in place and reversed, not removed. The old argument is quoted back
("nobody reads it, a subprocess consumes it") and answered with D7: this
repository is published to be read, and to somebody opening
`src/synthesizer/prompt.ts` to learn how a synthesizer is prompted, that prompt
is not a subprocess's input but the most interesting file in the package — and
it was the one file the exemption guaranteed nobody would check.

## AT1 and AT2 — what actually went red, and one thing the ticket got wrong

Both were written and confirmed failing before any translation, with the
meta-tests green throughout.

**AT1's premise in the ticket is not accurate.** It expects the literal sweep to
enumerate "a Portuguese literal in every one of the 30 newly-scanned files".
It cannot: only **22** of them have a Portuguese *literal*. Eight carry
Portuguese only in comments (`parse-permission-denial.ts`,
`claude-code-adapter.ts`, `codex-adapter.ts`, `permission-policy.ts`,
`spread.ts`, `similarity.ts`, `synthesizer/cli.mjs`, `measure-executions.mjs`),
which is precisely why AT2 exists. AT2 went red on **29** files. The thirtieth,
`measure-executions.mjs`, is red in neither sweep — its only diacritics sit
inside the protected quotation — so its (empty) translation is verified by
reading, per the TDD-exceptions clause.

Two literals had no diacritic and were caught by the stopword list alone:
`"Siga com o caminho mais simples."` and a job title in the t106 spike. That
list earned its place.

`run-graph-traversal.mjs` **was not touched, and neither were its two
`OUT_OF_SCOPE` pins** (lines 210 and 404). Both still land on a Portuguese
literal, which the meta-test asserts. One design point: the whole-file sweep
honours `OUT_OF_SCOPE` as well as `VERBATIM_QUOTATIONS`, because a line excused
for what it *is* does not stop being that when a second sweep reads it as raw
text instead of as a literal.

## The suite: 24 failures in 8 files, all inherited

`npm test` at the root: the root group is **361/361 green**; `packages/core`,
`packages/screen` and `packages/cost-surveyor` are green. `packages/runner` is
**647 pass / 24 fail**, every failure an assertion on the Portuguese literal
this ticket was required to change, and every one out of scope per the ticket
("inherited by the tests ticket"). `npm run lint` and `npm run typecheck` are
green.

| file | failures |
|---|---|
| `test/dispatch/render-skill-instructions.test.ts` | 9 |
| `test/synthesizer/prompt.test.ts` | 5 |
| `test/dispatch/prompt.test.ts` | 3 |
| `test/dispatch/report.test.ts` | 2 |
| `test/intake/prompt.test.ts` | 2 |
| `test/controller/factory-graph-software.e2e.test.ts` | 1 |
| `test/dispatch/pre-session-failure.test.ts` | 1 |
| `test/dispatch/render-input-values.test.ts` | 1 |

**The ticket's predicted list was wrong in both directions, and the ticket said
to check it.** It named roughly 28 files gathered by grepping for diacritics;
only 8 actually go red. It also missed two: `test/dispatch/pre-session-failure.test.ts`
and `test/intake/prompt.test.ts`. Nothing in `test/engine/`, `test/cli/`,
`test/surveyor/` or `test/bin.e2e.test.ts` failed at all.

**One of the eight deserves reading before it alarms somebody.**
`factory-graph-software.e2e.test.ts`'s failure is not an equality assertion on a
message — it is `assert.ok(!dev.includes('{{input.'))`, which reads like a
placeholder-resolution regression and is not one. The cause is line 463:

```js
const bodyOf = (nodeId) => toldTo(nodeId).split('## O contrato do nó')[0];
```

It slices the prompt at the contract heading. That heading is now
`## The contract of node`, so the split finds nothing, `bodyOf` returns the
whole prompt including the rendered `contract.checks` — and those legitimately
contain `{{input.project.test_command}}`, unresolved, because the graph
document's checks are rendered raw. The product renders exactly what it rendered
before. The fix is the split marker, one string.

## Things the next ticket should know

- **A `*/` inside a JSDoc comment closes it.** Writing the glob
  `factory-graphs/*/skills/*.json` into a rationale paragraph silently
  terminated the block comment in two files and produced
  `TS2304: Cannot find name 'skills'`. Typecheck caught it; a reviewer reading
  the diff would not have.
- **Renaming a rendered heading can break a test that never mentions
  Portuguese.** Two of the eight red files (`factory-graph-software.e2e`, and
  the docstring inside `render-input-values.ts` itself) referenced headings
  rather than asserting them. Grep for the *heading text*, not just for
  diacritics, when translating rendered prose.
- **Where a spike names a file it later reads, the prompt, the fixture and the
  assertion have to move together.** `RESULTADO.md`, `PROVA-ESCRITA.md`,
  `PROVA-T104.md`, `PROVA-T119.md`, `PROVA-T106.md`, `LEIA.md`, `SEM-CONTEXTO`,
  `MARCADOR-*` and `soma.js` were each renamed on all sides in the same commit;
  `soma.js` also lives in a generated `Makefile`, which was the least obvious of
  them.
