# t304 — the control plane client stops being the one file in Portuguese

**Date:** 2026-08-25 · **Branch:** `ticket-304` · **Subject:** the follow-up
t127 promised: `cliente-controle.ts` becomes `control-plane-client.ts`, in
English, and the exclusion it sat behind is retired rather than repointed.

Three commits so far: the gate first and red (`d2a908a`), the rename with every
call site (`0c73c47`), the three gates and the three spec links (`e13bb13`).

## What the ticket asked for, and what it turned out to be

The ticket framed this as an identifier rename. It is that, but the identifiers
gate is the reason it could not stop there. `no-portuguese-identifiers.test.ts`
masks string literals and backticked spans inside comments — and nothing else.
The English prose AROUND a backtick is scanned like code. So the moment the
whole-file exclusion came off, the file's ~200 lines of Portuguese DOC COMMENTS
became sixty-odd findings of their own, none of them an identifier.

That is not scope creep, it is what AC2 means: "both gates green with the file
included" is unreachable while the header still says
`os NOMES DE CAMPO desta arquivo são o fio`. Both files were therefore
translated whole — header, JSDoc, inline comments, test titles and assertion
messages — with every assertion's subject, expected value and count left
untouched. The renamed test still runs 15 cases and still pins the same five
calls, the same denial, the same two deadlines and the same 201/200 pair.

## The one thing that did not move

`execucao_id` and `depois` in `closeProposalOutcome`'s input are spelled in
Portuguese and stay that way. They are not identifiers: they are the frozen
hypothesis-outcome body sent verbatim as the JSON body of
`POST /v1/proposals/:id/outcome` (`docs/spec/entities-versioning.md` §5). The
wire gate confirms it from the other side — neither `PROPOSAL_FIELDS` nor
`DERIVED_FIELDS` lists them, which is what keeps that gate green on this exact
code, and its `t230` test asserts by hand that the file still CONTAINS
`execucao_id`. Only the method name, the parameter and the prose around them
moved. Same reasoning `DEFAULT_ANSWERED_BY` got on t286: a recorded value, not
a name.

A second non-obvious rename went the other way. The injected `fetch` option was
called `buscar`, and `buscar` is a glossary verb. In an option key it was masked
by the gate's key-position rule and could have survived — but the private field
behind it, `#buscar`, sits in no key position and fires. Both became
`fetchImpl`, which is what `controller/http-client.ts` already calls the same
thing. It is the only member of a public options object this ticket renamed.

## AC1–AC5, demonstrated

**AC1 / the red.** The gate edit landed alone, before any rename, and went red
three ways at once: the content sweep on the file's own Portuguese and on every
call site that spelled its exports, the filename check on `cliente-controle.ts`
itself, and the fixtures that existed only to prove the retired allowlist.

**AC2 / the manual red-green.** With everything green, `job` was reverted to
`trabalho` in `listReleasedJobs`'s filter and the runner suite rerun:

```
✖ AC1 — no Portuguese identifier survives in packages/runner/{src,test,scripts}
  AssertionError: Portuguese identifiers still present (D18):
  src/controller/control-plane-client.ts:385 — trabalho
ℹ tests 668 · pass 667 · fail 1
```

Restored, same command: `tests 668 · pass 668 · fail 0`. The file is really in
the scan, and the scan really bites on it.

**AC3 / the filename.** `AC1 — no file or directory name … is in Portuguese`
listed both old paths while they existed and is green on the new ones. A
content-only fix would not have passed this ticket.

**AC4 / the wire gate.** After the rename and before its edit, it failed exactly
as the ticket predicted — first on the stale path
(`artifact does not exist: src/controller/cliente-controle.ts`), then, with the
path repointed, on the housekeeping — `control-plane-client.ts no longer has
.corpo; drop the exception`, which is the gate's own self-check firing on stale
housekeeping rather than on a real Portuguese word. All three `.corpo` entries
were dropped.

**AC5 / the count.** Below.

## The consumer count, live

FR2 predicted 10 src + 7 scripts + 14 other test files = 31 consumers. Two
numbers moved.

The declaration's own test list holds 16 consumers, not 14 — FR2 undercounts the
list it points at. And the live fan-out is larger than the declaration in both
directions of the package boundary:

| Group | Declared | Touched | The difference |
|---|---|---|---|
| `packages/runner/src/**` | 10 | 14 | 4 comment-only citations of the old path |
| `packages/runner/scripts/*.mjs` | 7 | 7 | — |
| `packages/runner/test/**` consumers | 16 | 21 | 4 real call sites + 1 comment |
| gate files | 3 | 3 | — |
| `docs/spec/*.md` | 3 | 3 | — |
| other packages | 0 | 1 | `packages/surveyor/src/watch.ts` |

53 paths in the diff, of which 4 are the two renames. **Five of the twelve
undeclared files were not optional**, and any one of them left alone would have
been a red gate or a failed typecheck:

- `packages/surveyor/src/watch.ts` builds a client across the package boundary,
  through the re-export `src/surveyor/proposal.ts` publishes for exactly that
  purpose. The ticket's Out of Scope excuses six cross-package COMMENTS; this is
  not one of them, it is code.
- `test/dispatch/manual-proof-graph-traversal.test.ts` and
  `test/surveyor/manual-proof-credentials.test.ts` assert over the SOURCE TEXT
  of the spike scripts, matching `new ClienteControle` as a literal.
- `test/intake/command-line.test.ts` and `test/surveyor/command-line.test.ts`
  call two renamed methods and failed the typecheck, not the sweep.

The other five are comment-only citations of the old path inside
`packages/runner` (`controller/http-client.ts`, `dispatch/options.ts`,
`dispatch/resolve-session-plan.ts`, `synthesizer/control-plane-client.ts`,
`test/cli/run.e2e.test.ts`). The Out of Scope leaves six CROSS-package ones
stale on purpose, to keep three unrelated packages out of the conflict surface;
that argument does not apply inside the package the ticket already owns whole,
so these five were corrected. `packages/cost-surveyor/src/client.ts` names
`ErroDoControlPlane` in a comment and is a seventh cross-package citation the
Out of Scope list does not enumerate — left stale with the six, on the same
reasoning.

## The three spec documents, and what FR7 undercounted

FR7 asks for "the one markdown link each". Each of the three also names a symbol
this ticket renamed, in the prose immediately around that link — `ClienteControle`
in `surveyor-flow.md`, `metricasPorVersao` in `surveyor-cost.md`, and
`criarIntake` plus the three absent methods (`confirmarIntake`, `emendarIntake`,
`descartarIntake`) and `aplicar` in `intake-generation.md`. Repointing the href
and leaving the sentence above it naming a symbol that no longer exists is the
exact failure `tests/citation-link-text.test.mjs` was opened on, one level down
from a filename. All of them moved with their links.

## The counts, before and after

| Group | Before | After |
|---|---|---|
| `cartografo` (core) | 686 | 686 |
| `@cartografo/cost-surveyor` | 46 | 46 |
| `@cartografo/runner` | 668 | 668 |
| `@cartografo/screen` | 126 | 126 |
| `@cartografo/surveyor` | 29 | 29 |
| root | 351 | 352 |

No group lost a test. The root group gains one: the fixture that pins AT6's
narrowed rule, below. `npm run lint` and `npm run typecheck` are green.

## The gate this ticket had to clear on the way (t307's AT6)

`tests/notes-redaction.test.mjs` is outside t304's declared surface. The founder
authorised the change after the question was put to him, and the reason belongs
here: AT6 was red for every branch and vacuously green on `main`, so it blocked
the queue, and the ticket that trips such a gate first is the one that has to
clear it. Leaving it for a follow-up would have meant t304 could not land.

**What it asserted before.** Every path in
`git diff --name-only $(git merge-base main HEAD)` — plus every untracked file —
had to be in `TOUCHABLE`, t307's list of the sixteen files t307 declared.

**Why that could not hold.** It is a claim about one ticket's diff: *t307 touched
only what t307 declared*. That is a fact about a commit that is now history, and
history does not need a standing test. Where it ran it proved nothing — t307 is
merged, so on `main` the diff is empty — and where it fired it was wrong, because
on any later branch it compared that branch's work against another ticket's file
list. t305, t306 and t307 never ran against it; t304 is simply the first ticket
behind it. The scope check it stood for had already been done, by the review
t307 came out of.

**What it asserts now.** A path is an undeclared edit when it is BOTH governed
and undeclared: governed means it already existed under `notes/` when the
redaction ran, or is one of the five `NON_NOTE_FILES`; undeclared means it is
absent from `TOUCHABLE`. Untracked paths are no longer read at all — an untracked
file cannot be an EDIT of a file that existed, which is the only thing the gate
now judges.

**Why this is a gate and not a weakened tripwire.** The standing property worth
protecting is *nobody edits a redacted note without saying so*, not *nobody adds
a note* — adding one is routine, t305 and t307 each did, and this note is a
third. Both halves are pinned by a fixture test beside it
(`AT6 — the rule reads governance, not the size of the branch`), and the teeth
were confirmed by hand: appending one blank line to
`notes/2026-08-18-action-plan.md` — a note that existed at the redaction and
that `TOUCHABLE` does not name — turns AT6 red, and reverting it turns it green.
AT1-AT5 are untouched, and they are the guarantee the founder actually asked
for: no security identity, no machine path, and the n=1 / no-A/B / cost record
still literally present. AT6 was never carrying that; it was carrying a scope
claim.

Three things deliberately not done, because they would each have been worse than
asking: `TOUCHABLE` was not widened with t304's 53 paths — that list is t307's
declaration of what t307 touched, and adding to it would make the sentence it
asserts false and put the same obligation on every ticket afterwards; the test
was not quietly deleted or rewritten before the founder ruled; and AT1-AT5 were
not renumbered or moved.
