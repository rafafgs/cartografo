# The first real execution — tic-tac-toe (2026-08-15, small hours)

A record of the first dogfood: the freshly built cartografo (47 tickets in ~10h
of a flowpilot wave) crossed the whole of factory graph 1 with real `claude`
sessions and produced a playable tic-tac-toe in a scratch repository outside
this one (operator: the wave's planner, as the founder's proxy; the full journal
and the recording are at `github.com/rafafgs/cartografo-story`).

**Numbers**: 5 nodes crossed (refinar → desenvolver → integrar → testar →
implantar), 7 sessions (2 retries, 1 re-dispatch after an answer), 1 human
question answered through the API, 6 commits in the target repository, 12/12
criteria `passou`, ~20 min of session work. Job #1, execution #1, telemetry
intact in `.cartografo/cartografo.db` (exported to `cartografo-story/game-run/`).

## What worked first time

1. **One-command startup + a bootstrap token (t100/t124)** — `cartografo.ready`
   with the single credential; the whole round authenticated.
2. **Import with hash pins (t108/t135/D4)** — the factory graph registered, 5
   skills in the registry, a version by canonical hash.
3. **Lease/tick (t103, D5)** — 7 dispatches, zero races, the lease returned on
   every failure.
4. **Human escalation end to end (t106, D9)** — the tester emitted the
   `input-request` block, the job blocked on its own, `PATCH /answer` unblocked
   it, and the re-dispatch with the question+answer in the prompt changed the
   session's behaviour. First real round, zero adjustment.
5. **Retry-with-context** — refinar's second leg found the orphaned SPEC.md from
   the first leg and finished, with no special instruction.
6. **The skill's manifest as a prompt was enough for the process to emerge** —
   the desenvolver node did red→green→doc off the back of the contract (a failing
   test committed before the implementation), without the brief asking for TDD.
7. **A tester with evidence of its own (D9)** — it walked the 12 criteria with a
   harness of its own in /tmp, and escalated ONLY the proof it could not produce
   (a second browser, the TCC), with a risk assessment attached.

## Gaps and bugs found (in order of pain)

1. **The automatic traversal was t109 (cancelled)** — the graph lives as data,
   but dispatch v0 uses a fixed instruction and pulls neither the skill from the
   `grafo_versao` nor advances a node. The round was hand-cranked by the operator
   (one job per node, the manifest injected by hand, `POST /transitions` between
   nodes). It is the product's number-one gap.
2. **Dispatch with no Authorization** — a 401 against t124's authenticated plane;
   found at 01:4x, ticket t147 in flowpilot, **fixed by the flow itself during
   the night** (surfing a quota pause). The round's workaround was the `doFetch`
   seam.
3. **A session's transcript is not persisted** — refinar's first leg died with
   exit 1 and the job nearly done, and there is no way to diagnose it: the prompt
   is recorded, the output is not. The topografo is going to need the session's
   log.
4. **The default port collides with the test bench** — 4317 was occupied by the
   control plane flowpilot's bench keeps alive. `CARTOGRAFO_PORT` solved it; a
   randomisable default (port 0 in the ready line) would have avoided it.
5. **The runner-as-a-library demands `--import tsx` from the consumer** —
   *parameter properties* break Node's strip-only mode; a packaged bin (like the
   core's) would solve it.
6. **No worktree per session** — the session works in the shared checkout; the
   OPERATOR themselves became a concurrent writer (a verification `git checkout`
   under a live session — harmless by luck). flowpilot's law
   (worktree-per-session, docs/process.md #1-3) holds here.
7. Small contract details: the actor accepts `usuario|agente|sistema` ("humano" =
   422, correct but surprising); `POST /v1/executions` does not exist (an
   execution is a projection; the id on the job is free); the
   `sessao.finalizada` event does not appear in the job's projection (it stays on
   the session entity).

## What the next round should have

Skill rendering + automatic node advance (t109 for real), a persisted
transcript, a worktree per session, the runner's bin. With those the same round
runs with no operator — and the topografo has something to read.
