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

## The counts, before and after

| Group | Before | After |
|---|---|---|
| `cartografo` (core) | 686 | 686 |
| `@cartografo/cost-surveyor` | 46 | 46 |
| `@cartografo/runner` | 668 | 668 |
| `@cartografo/screen` | 126 | 126 |
| `@cartografo/surveyor` | 29 | 29 |
| root | 351 | 351 |

No group lost a test. `npm run lint` and `npm run typecheck` are green.

## What is left open

`tests/notes-redaction.test.mjs`'s AT6 is red, and nothing in this ticket's
surface can honestly turn it green. It reads
`git diff --name-only $(git merge-base main HEAD)` and asserts every path is in
t307's `TOUCHABLE` list. t307 is merged, so on `main` that diff is empty and the
assertion is vacuous; on ANY branch it is the current ticket's whole diff
against a list of another ticket's files. This ticket is the first to hit it,
and every ticket after it will. AT1–AT5 — the founder's actual guarantee, that
no identity and no machine path survives and that the unflattering record does —
are untouched and green.
