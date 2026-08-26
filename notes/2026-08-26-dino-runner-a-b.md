# A game through the software graph, four times — and the first A/B: a proposal became version B and was measured

Date: 2026-08-26, 17:45–20:50 UTC. Operator: Claude (Fable 5), on Rafael's
instructions, with Rafael at the screen the whole time. Written in English by
rule. Previous game rounds: `notes/2026-08-17-t109-game-feature.md` (round 1),
`notes/2026-08-18-game-feature-2.md` (round 2).

The mandate, in Rafael's words: bring the service up from the README, follow
the execution every 15 minutes, and put a simple browser game — the Chrome
T-Rex runner — through it, "a ideia é passar pelo grafo para testar e ter uma
execução real funcionando". Three tickets were agreed for the game, and a
fourth was added at the end to measure a graph mutation.

**What this note claims, in one sentence:** the learning loop closed end to
end for the first time — four real traversals, two surveyor lenses proposing
from the log, one proposal approved and applied at the human gate, a version
B born from it and measured node by node against version A — and the
measurement says the mutation made one node cheaper and cost about what it
saved. Whether a proposal makes the next round *better* is still open; it now
has a number attached.

## Provenance

- **cartografo** `main` @ `60581b3` (t330 included), run from `~/cartografo`
  itself — not from a separate clone, against the lesson of 2026-08-18. It
  did not bite this time because the target repository was a different one
  (below) and nothing integrated into `~/cartografo` during the run; it
  remains the wrong habit.
- **Fresh database.** The old `.cartografo/` (2026-08-18, pre-t311) was set
  aside, `npm ci` run, the control plane started from a reduced shell
  (`env -i` with `HOME`, `PATH`, `USER`, `SHELL`, `LANG`, `TMPDIR`), as the
  README's first warning asks. 24 migrations. Screen on :4318. Three stray
  processes from earlier work (another control plane on :4317 from
  `cartografo-flowpilot-test-bench`, a board capture from
  `cartografo-story`) were stopped first, on Rafael's say-so.
- **Target repository:** `dino-runner` — a directory beside the cartografo
  checkout; directory names in this note are spelled without the operator's
  home path, by the rule of t330 — a skeleton the operator wrote by
  hand before any job — a page with a canvas and a 60 Hz loop, a pure rules
  module (`src/game.js`: `createGame(seed)`, `step(state, intent)`) with a dino
  that stands on a scrolling ground and does nothing else, a renderer, a
  headless player (`npm run play`), deterministic randomness in the state
  (`rand(state)`), and three gates with no dependencies at all: `npm test`
  (node:test, 4 green tests), `npm run lint` (every script parses; the rules
  never name `window`, `document`, timers or `Math.random`), `npm run build`
  (copies to `dist/`, checks every import resolves). Commit `6c09bd2`. It is
  the ground the graph needs — existing code, tests, gates, a
  `docs/TICKETS.md` with the rules — and not part of what the graph is
  measured on.
- **Graph:** the factory bundle `factory-graphs/software-development`
  unchanged — the same five nodes, five edges and five pinned skill hashes —
  with only the top-level `project` replaced (that repository, `npm test`,
  `["npm test", "npm run lint", "npm run build"]`, the conventions of
  `docs/TICKETS.md`, `application.running: false` with an `absence_reason`
  pointing the test gate at `npm run play` and its own `node` probes).
  Registered as a **new class** `dino-runner`, version A =
  `sha256:303eb81d…`, because two doors are shut: `POST /v1/graphs` answers
  409 for a class already registered, and `POST /v1/graphs/:id/fork` copies
  the base's snapshot verbatim, `project` included. The variant document is
  [`2026-08-26-dino-runner/graph-a.json`](2026-08-26-dino-runner/graph-a.json).
  `import` printed `skills 0 registered, 5 already in the registry`.
- **Runner:** one process, engine `claude-code` (CLI 2.1.246), `--working-dir`
  and `--test-bench-path` both `dino-runner`, worktrees in
  `dino-runner-worktrees`, `--bench-install-command "npm ci"`,
  `--reference-mode ponta_do_principal`, `--interval-ms 3000`, also from a
  reduced shell. The nested-session guard of the engine (`CLAUDECODE` in the
  environment) is one more reason for `env -i`.
- **Jobs:** one per traversal, one execution each, created by `POST /v1/jobs`
  with a title and a body (context, scope, acceptance criteria, out of scope,
  references) written by the operator, `graph_version_id` set explicitly,
  `execution_id` 1–4 (executions are an aggregation over jobs; there is no
  `POST /executions`). Created **one after the other**, each after the previous
  completed: the tickets depend on each other (obstacles need the jump; the
  score needs both), and a runner picks whatever is released without knowing
  that. The four bodies are in
  [`2026-08-26-dino-runner/`](2026-08-26-dino-runner/).
- **What was done by hand, and what was not.** By the operator: the skeleton,
  the `project` block, the four ticket texts, creating each job, starting and
  stopping the runner, a static server on :5182 to play what is on `main`,
  and the run log (below). By the graph: everything between a job's creation
  and its completion. One human gate was opened in four jobs, and Rafael
  answered it at the screen. No session, worktree or report was touched by a
  person.

## Version A: three traversals, no operator, one human gate

| Exec | Job | Path | Sessions | Wall clock | Output tokens | Human gate |
|---|---|---|---|---|---|---|
| 1 | t1 Jump | refine → develop → integrate → test → deploy | 5 | 18:02 → 18:16Z (14 min) | 73,776 | none |
| 2 | t2 Obstacles, collision, game over, restart | same | 5 | 18:21 → 18:44Z (24 min) | 125,486 | none |
| 3 | t3 Score, best, speed ramp | same, `develop` paused and resumed | 6 | 18:54 → 19:44Z (50 min) | 205,143 | **one** |

Every report was accepted at the first attempt; the `test → develop` rework
edge was never walked. Node by node (agent time / output tokens):

| Node | exec 1 | exec 2 | exec 3 |
|---|---|---|---|
| refine | 323 s / 30.6k · spec 14.9k chars, 7 criteria | 525 s / 48.4k · 23k chars | 725 s / 60.1k · 23.4k chars, 14 criteria |
| develop | 160 s / 13.2k · tests `dcc0754`, feat `b9c7eaa`, 6/6 gates | 544 s / 48.1k · 3 commits, 6/6 | 1054 s / 91.5k · **two sessions** (paused on a question), 3 commits |
| integrate | 58 s / 4.2k · fast-forward | 93 s / 6.6k · **a real merge** (`cc7e03d`, see holes) | 82 s / 6.0k · fast-forward |
| test | 285 s / 24.5k · pass, 9/9, 0 bugs | 231 s / 21.1k · pass, 15/15 | 564 s / 45.9k · pass, 14 + 1 `not_exercised` |
| deploy | 24 s / 1.2k · published | 24 s / 1.3k · published | 26 s / 1.7k · published |

The executor did what t273 asks after every `integrate`: fast-forwarded the
bench's `main` to the merge commit and ran `npm ci`, before letting the job
off the node; `deploy` then found the merge commit an ancestor of the live tip.
The game was playable on :5182 after each job, by reloading.

### The human gate (execution 3)

The `develop` session of t3 stopped at 19:16Z with one `input-request`. The
refinement had fixed a speed ramp (`pointsPerStep 200, speedStep 1, speedMax
10`) under which the headless policy dies on every seed before tick 3000 (from
speed 8 a 35-tick jump covers 280 px, more than the minimum gap of 240), and a
t2 test (`A3`) looped 3000 ticks on seed 7 assuming the run never ends — an
assumption that only held without a ramp. After game over the state freezes
(`A7` pins that), so `A3` failed on a cactus that "moved from 51 to 51". The
session had the implementation ready and uncommitted, `lint` and `build`
green, `npm test` 39/40, and asked: guard `A3` with `&& !state.over` (one line
in a t2 test the spec had put out of scope) or lower `speedMax` to 7
(overriding the refinement's gameplay decision)? It recommended the first and
measured both. Rafael answered at the screen at 19:24:52Z — the guard — and
the session resumed from where it had stopped, committed
`8f14c72 test(t3): stop A3 at game over` before the feature, and finished.
Blocked time: 508 s. The paused session's resume re-read the whole projection
(2.1 M cache-read tokens on the node), which is the cost of a pause.

## The surveyors: nine proposals from the log

Run after execution 3, by the operator, over executions 1–3.

**Cost lens** (`cost-surveyor evaluate --token-cap 1000000 --second-cap 600`,
deterministic, no agent): six pending proposals, every one a reversible
annotation on a node's `description` with the finding and an
`expected_metric`. `tokens_total` there is the sum of the four usage keys, so
cache reads dominate it; the ceilings were the operator's choice, the tier
policy needs none. Findings: `develop` is the outlier in all three executions
(652k, 1.08 M, 2.43 M `tokens_total`; 6.8× the version median in execution 3 —
"candidate for a cheaper model tier, or for a split into smaller nodes");
`refine` exceeded the 600 s ceiling in execution 3 (725 s). Output in
[`2026-08-26-dino-runner/cost-surveyor.log`](2026-08-26-dino-runner/cost-surveyor.log).

**Flow lens** (one agent session per execution, ~45 s and a few thousand
tokens each): three pending proposals, each a real semantic diff. Output in
[`2026-08-26-dino-runner/flow-surveyor.log`](2026-08-26-dino-runner/flow-surveyor.log).

| # | Over | Bottleneck | Proposes | Expected |
|---|---|---|---|---|
| 7 | exec 3 | `develop` (1054 s agent + 508 s blocked) | `refine` resolves every open question with the requester and carries a "decisions and assumptions" section; `develop` never blocks on people — takes the conservative reading, records the assumption, leaves confirmation to `test` | `develop` 1054 → 844 s |
| 8 | exec 1 | `refine` (323 s) | a lean specification: no file listing, no tree tour; a new `contract` (≤ 7 requirements, ≤ 10 criteria, negative scope) | `refine` 323 → 259 s |
| 9 | exec 2 | `develop` (544 s) | **a topology change**: a new `write_tests` node (role tester) between `refine` and `develop`; `develop` only makes the tests pass | `develop` 544 → 435 s |

Two readings before touching any of them. Proposals 7 and 8 change the node's
`description` in the graph — and what a session reads is the pinned skill's
`instructions`, not that description; applying either alone would move nothing
a session sees, and an honest A/B would need the skill bumped through the D4
gate too (8 also contradicts `refine-ticket`'s eleven required sections). And
proposal 9's `add_node` carries no `skill_ref` and no `contract`: `POST
/proposals/:id/apply` validates the resulting document and rejects the
proposal on failure, so 9 as written would have died at the gate. That is a
finding about the flow lens: it proposes a node it cannot pin.

## Proposal 10 → version B

Rafael asked for exactly that node, with a skill. The operator wrote it and
put it through the doors the system has:

- **`write-tests` 1.0.0** ([manifest](2026-08-26-dino-runner/skill-write-tests-1.0.0.json)),
  `role: work`: turns the acceptance criteria into failing tests, one per
  criterion, only test files, one `test(tN)` commit, and stops. Four checks —
  `tests-only-and-committed` (deterministic: ≥ 1 commit past the main branch
  and the diff against it touches only test paths), `red-suite`
  (deterministic: `! {{input.project.test_command}}`), `clean-tree`, and the
  agentic `red-for-the-right-reason` (every new test fails for a missing
  implementation, not a typo; every criterion has a test or a reason in
  `not_testable`). Output: `branch`, `commits`, `tests[]` (criterion → test →
  file), `not_testable[]`, `red_run`. Same escalation block as the other five.
  Contract bucket `produces: "tests"`.
- **`develop-ticket` 1.0.2** ([manifest](2026-08-26-dino-runner/skill-develop-ticket-1.0.2.json)):
  one new section, "When the tests are already on the branch" — read them, run
  the command to see the red, do not rewrite them, add a test only for a
  criterion listed as `not_testable`, disagreement goes in the note. `input`
  gains an optional `tests` object. The `tdd-order` check is unchanged and
  still holds: the tests commit precedes the implementation commit in the
  history, it just has a different author.
- Both registered with `POST /v1/skills` (201 each; the registry now holds
  `develop-ticket` 1.0.1 and 1.0.2 side by side, D22). The bundle with the six
  manifests and the resulting graph
  ([`graph-b.json`](2026-08-26-dino-runner/graph-b.json)) passed
  `scripts/validate-factory-bundle.mjs` — sound graph, 6 manifests, 6 pins
  closed — and both manifests validate against `skill-manifest.schema.json`,
  **before** anything was proposed, because a rejected apply is a spent
  proposal.
- **Proposal 10** (`evidence.lens: "operator"`, over version A, citing
  proposal 9, cost proposals 1/3/6 and the human gate; the same
  `expected_metric` as 9), six reversible operations
  ([list](2026-08-26-dino-runner/proposal-10-operations.json)): `add_node
  write_tests` with the real pin and contract, `remove_edge refine→develop`,
  `add_edge refine→write_tests`, `add_edge write_tests→develop`,
  `change_node_field develop.description`, `change_node_field
  develop.skill_ref → 1.0.2`. Resulting topology:

```
refine ──always──▶ write_tests ──always──▶ develop ──always──▶ integrate ──always──▶ test
                                              ▲                                        │
                                              └────────────── rework ──────────────────┘
                                                                                       │
                                                                       deploy ◀── approved
```

- **Rafael approved and applied it at the screen** at 20:15:12Z. Version B =
  `sha256:dc5f693e…`, `parent_version` = A, `source: proposal`, `proposal_id:
  10`, contracts `checked`, pointer moved. The lineage says where B came from.

## Version B: execution 4, and the A/B

Ticket 4, written for the measurement and independent of the rules: the T-Rex
sprite — the dino and the cacti as pixel-art bitmaps (data in
`src/sprites.js`, no assets, no dependencies) mapped inside their collision
boxes, four poses (stand, run on two frames, jump, dead), a small and a tall
cactus, `spriteFor(state)` and `cactusFor(obstacle)` pure, `src/game.js` and
`src/rng.js` byte-identical, `npm run play` output identical before and after.

| Node | B · exec 4 | vs A (exec 1 / 2 / 3) |
|---|---|---|
| refine | 571 s / 53.6k · spec 24.9k chars, 15 criteria | 323 / 525 / 725 s |
| **write_tests** | **527 s / 48.3k** · P1–P14 in `tests/sprites.test.mjs`, one commit `46fb565`, red at load (`ERR_MODULE_NOT_FOUND src/sprites.js`); the four checks passed at the first attempt | — |
| develop (1.0.2) | **353 s / 28.0k** · saw the red, implemented on top (`8424fa7`), did not touch the tests, 8/8 gates | 160 / 544 / 1054 s · 13k / 48k / 91k |
| integrate | 71 s / 4.9k · fast-forward | 58 / 93 / 82 s |
| test | 383 s / 34.9k · pass, 14/14, 0 bugs | 285 / 231 / 564 s |
| deploy | 26 s / 1.5k · published | 24 / 24 / 26 s |
| **total** | **1930 s / 171k** | 850 / 1417 / 2451 s · 74k / 125k / 205k |

Six nodes by agent, six reports accepted at the first attempt, no question,
no operator action, 20:16 → 20:49Z (33 min). The numbers are the control
plane's own, per version, from `GET /v1/executions/:id/metrics-by-version`.

**The honest reading.** The hypothesis the proposal carried — `develop` falls
from 544 s toward 435 s — held on the node it named: 353 s and 28k output
tokens, below executions 2 and 3 of A on both counts. The node that was added
to make that happen cost 527 s and 48k of its own. Summed, B spent 880 s on
`write_tests + develop` where A spent 160 / 544 / 1054 s on `develop` alone:
more than every A run except the one with the human gate. What B bought was
not time. It was an artifact with a contract of its own — a red suite verified
by four checks before implementation begins — and an implementer that did not
write its own tests. One job on B against three on A, with tickets of
different sizes: this is n = 1 against n = 3, the first A/B this repository
has, not a verdict. What would settle it is the same ticket class on both
versions, several times, and the outcome surveyor (`close-outcome`) writing
the measured metric back onto proposal 10 — which was not run.

## Cost

22 sessions, 22 completed, 0 failed: 575,628 output tokens, 1.30 M cache
written, 8.06 M cache read. At the ratio of the 2026-08-18 round (~US$ 12 per
~60k output tokens) that is roughly **US$ 115** for the four traversals, plus
three short flow-lens sessions. The operator had set a cap of 220k output
tokens (≈ US$ 45) and then 320k; at 308k with the last job's `develop` paused
on the human gate, Rafael removed it ("deixa rolar"). For comparison, the
operator writing the same game directly in this chat would have taken about
ten minutes and a dollar — see the conclusion.

## The run log, and a lesson about it

Rafael asked for the session's events to be recorded in the game repository.
The operator built a small tool ([`runlog.mjs`](2026-08-26-dino-runner/runlog.mjs))
that renders the control plane's event log (`GET /v1/executions/:id/events`)
into `docs/runs/2026-08-26-dino-runner-through-cartografo.md` with the control
plane's timestamps and one tag per line — `[cartografo]`, `[operator]`,
`[human gate]` — so that what the system did alone is separable from what a
person did. A copy is at [`run-log.md`](2026-08-26-dino-runner/run-log.md).

The lesson cost a merge. The game repository is also the test bench the
executor fast-forwards after `integrate`, and the operator's first four log
commits landed on its `main` between jobs. They did not break anything — the
tool refused to commit while a job stood on `develop` or `integrate` — but
they moved `main` under job 2, so its `integrate` had to do a real merge
(`cc7e03d "Merge branch 'main' into ticket-2"`) instead of a fast-forward, and
job 1's `deploy` recorded the operator's docs commit as the reference it
checked against. Rafael noticed the commits ("VC QUE ESTÁ COMITANDO?") and the
rule became: **the operator's log is one commit at the end of a round, with an
author of its own** ("cartografo operator (Claude)"), never interleaved with
the graph's work on the bench. All commits by the graph's sessions carry the
machine's git identity (Rafael's); the author field does not tell them apart,
the message prefix does.

## Holes found today

1. **A variant cannot carry its own `project`.** `fork` copies the base's
   snapshot; `POST /graphs` refuses the class. The bundle README's promise —
   "a variant of this class overrides that whole object, and that is how the
   same map serves another repository" — has no door yet. Today's answer was a
   new class per repository, which loses the lineage between them.
2. **The flow lens proposes nodes it cannot pin** (proposal 9: `add_node` with
   no `skill_ref`, no `contract`). Applying it would have been rejected. Either
   the lens learns to say "this needs a skill" and stop there, or the apply
   route should refuse before spending the proposal.
3. **`cartografo-surveyor watch` cannot read the past.** It subscribes from
   the current event id (by design, FR4) and there is no flag to replay; the
   flow lens over a finished execution ran through the runner's one-shot
   `npm run surveyor -- <execution_id>` instead, which is documented nowhere
   near the README.
4. **A `description` proposal moves nothing a session reads.** Proposals 7 and
   8 are the kind the flow lens writes; the behaviour lives in the manifest's
   `instructions`. A proposal that means to change behaviour has to bump the
   skill (as 10 did) or it is a label.
5. **`deploy` is still a session for two commands**: 24–26 s and ~1.5k tokens
   per job, four times today. Divergence 1 of the bundle, unchanged.
6. **The paused session pays twice.** Resuming `develop` after the human gate
   re-read 2.1 M cache tokens; execution 3's `develop` is 2.43 M
   `tokens_total` mostly for that reason, and it is what the cost lens flagged
   as the outlier.
7. **`refine` grows with the repository**: 323 → 525 → 725 → 571 s, specs of
   15k → 23k → 23k → 25k chars. Proposal 8 (a lean spec) is aimed at this; it
   would need the skill bumped.
8. **`GET /v1/sessions/:id` is not a route** (`route not found`); only the list
   exists. And `GET /v1/events` does not exist either — the log is read per
   job or per execution, or streamed.
9. **The operator's process, not the system's:** the run was operated from
   `~/cartografo` rather than a pinned clone (bad habit, no consequence this
   time), and the cost cap was the operator's loop, not anything the control
   plane knows — a `budgets` on the graph, or a cap per execution, would make
   "stop at US$ X" a fact of the system rather than of whoever is watching.

## What this proves, and what it does not

Proves: the software graph takes small, well-specified tickets end to end
without an operator (4 of 4 today, 6 of 6 counting the two rounds of
2026-08-18); the human gate is a real pause-and-resume, with the answer
recorded; both surveyors produce proposals from a real log with evidence and
an expected metric; a proposal goes through the human gate into a version
with lineage; a version born that way runs a real job; and the two versions
are comparable node by node from the control plane's own telemetry.

Does not prove: that any proposal makes the next round better. The one
measured moved cost from one node to another. n = 1 on B.

## Conclusion, including the question that had to be asked

Rafael asked it at the end: why not have the model write the game directly —
is that not better than all this? For this game, yes, and not by a little:
about ten minutes and a dollar against two hours forty and roughly US$ 115,
for the same game. Anyone who wants the game should not use the graph.

The graph is not competing with "the model writes it while a person watches";
it is competing with "the model writes it with nobody checking, at a scale no
conversation holds". What it buys, and what today showed it buying: evidence
that is not the author's word (the test gate re-derived every criterion with
its own probes; on B, whoever wrote the tests never saw the implementation),
a pause with a recorded answer instead of a silent guess (the t3 gate is
exactly the case a single author would have quietly edited past), and a
process that is itself an artifact — versioned, proposed against, measured.
Each of those costs a session, and that is why a traversal costs US$ 20–50.
The cost lens has already said where that goes next: `develop` and `refine`
are out of line, and `deploy` should not be a session at all.

## Where things are

- `dino-runner`: the game, 18 commits (skeleton, 12 by the graph over four
  tickets, 2 operator log commits, one of them the round's single final
  commit `0044dd0`). No remote. Served at :5182 by `npm run serve`.
- `~/cartografo/.cartografo/`: the database of this run — 2 graph versions,
  4 jobs, 22 sessions, 10 proposals (1–9 pending, 10 applied), 1 input
  request. The control plane, the screen and the game server were still up
  when this note was written; the runner was stopped.
- `dino-runner-worktrees` and the `ticket-1..4` branches: for
  `cartografo-runner prune`.
- This directory: [`2026-08-26-dino-runner/`](2026-08-26-dino-runner/) — the
  two graph documents, the two manifests, the proposal's operations, the four
  ticket bodies, the two surveyor logs, the run log and the operator's tool.
