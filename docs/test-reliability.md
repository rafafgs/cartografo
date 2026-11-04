# Test reliability

Why `npm test` used to go red on a busy machine, what each red turned out to be,
and what changed (t960). A red in `npm test` is meant to mean something is wrong.
Use `node scripts/test-under-load.mjs` (see `CONTRIBUTING.md`) to check a test
that depends on timing.

## How to read these numbers

`--multiple` is the load this script adds, not the load the machine had. Other
worktrees' suites and agents were running throughout, so the load average is the
figure to compare, and it is recorded with every run. The machine has 8 cores,
and the load average reached 260 during these measurements.

## Full suite, before and after

Before is `main` at `63173d2`, after is this branch at `da68ec3`. "Multiple 0" is a plain `npm test` with no burners. The load average is the 1-minute figure when the run started. Runs of one tree at one multiple ran in sequence, in the order shown. The first before run at multiple 2 also shared the machine with this ticket's own development.

| Tree | Multiple | Run | Load at start | Tests failed | Duration |
|---|---|---|---|---|---|
| before | 0 | 1 | 261.4 | 2 | 5m 38s |
| before | 0 | 2 | 101.5 | 4 | 4m 54s |
| before | 0 | 3 | 76.7 | 0 | 3m 56s |
| before | 1 | 1 | 52.2 | 0 | 4m 39s |
| before | 1 | 2 | 86.0 | 2 | 4m 46s |
| before | 1 | 3 | 80.0 | 3 | 7m 17s |
| before | 2 | 1 | 23.4 | 23 | 22m 18s |
| before | 2 | 2 | 132.0 | 15 | 15m 11s |
| before | 2 | 3 | 123.1 | 6 | 11m 54s |
| before | 4 | 1 | 66.5 | 13 | 13m 01s |
| before | 4 | 2 | 128.7 | 12 | 10m 52s |
| before | 4 | 3 | 145.6 | 3 | 7m 42s |
| after | 0 | 1 | 103.6 | 0 | 7m 43s |
| after | 0 | 2 | 48.9 | 0 | 4m 59s |
| after | 0 | 3 | 112.0 | 0 | 5m 09s |
| after | 1 | 1 | 111.8 | 0 | 4m 25s |
| after | 1 | 2 | 90.7 | 0 | 6m 34s |
| after | 1 | 3 | 82.1 | 0 | 6m 10s |
| after | 2 | 1 | 102.0 | 0 | 9m 14s |
| after | 2 | 2 | 114.1 | 0 | 6m 40s |
| after | 2 | 3 | 97.3 | 0 | 8m 07s |
| after | 4 | 1 | 87.3 | 0 | 10m 18s |
| after | 4 | 2 | 136.5 | 0 | 10m 22s |
| after | 4 | 3 | 136.8 | 0 | 10m 36s |

| Multiple | Before: runs, red runs, tests failed | After: runs, red runs, tests failed | Mean duration before | Mean duration after |
|---|---|---|---|---|
| 0 | 3, 2, 6 | 3, 0, 0 | 4m 49s | 5m 57s |
| 1 | 3, 2, 5 | 3, 0, 0 | 5m 34s | 5m 43s |
| 2 | 3, 3, 44 | 3, 0, 0 | 16m 28s | 8m 00s |
| 4 | 3, 3, 28 | 3, 0, 0 | 10m 32s | 10m 25s |

Runs in which each test was red, across every multiple:

| Test | Before | After |
|---|---|---|
| `cli-watch.test.ts` AT1 | 7 | 0 |
| `cli-watch.test.ts` AT2 | 6 | 0 |
| `cli-watch.test.ts` AT3a | 6 | 0 |
| `cli-watch.test.ts` AT5 | 6 | 0 |
| `conformance-kit.ts` C3 | 3 | 0 |
| `conformance-kit.ts` C9 | 5 | 0 |
| `discover-mcp-servers.claude-code.test.ts` t400 | 5 | 0 |
| `dispatch.test.ts` AT6 | 1 | 0 |
| `dispatch.test.ts` AT7 | 1 | 0 |
| `dispatch.test.ts` AT8 | 1 | 0 |
| `job-relations.test.ts` t636 AT16 | 2 | 0 |
| `job-subgraph-node-state.test.ts` t638 AT8 | 2 | 0 |
| `process-lifecycle.test.ts` t678 AT3/AT4 inactivity watchdog | 8 | 0 |
| `process-lifecycle.test.ts` t678 AT3/AT4 wall clock | 5 | 0 |
| `process-lifecycle.test.ts` t678 AT8 finish-detail keys travel beside timeoutReason; an empty result is no detail | 6 | 0 |
| `session-cleanup.copilot.test.ts` t675 AT ending by inactivity | 1 | 0 |
| `session-cleanup.copilot.test.ts` t675 AT ending by wall-clock | 1 | 0 |

## Each named file alone, before

Tests failed in each of the runs, on `main` at `63173d2`. "alone" means no other file of this suite; other worktrees were still running.

| File | Multiple | Failed per run | Duration per run |
|---|---|---|---|
| `process-lifecycle` | 0 | 0, 0, 0 | 0m 05s, 0m 05s, 0m 05s |
| `process-lifecycle` | 1 | 0, 1, 0 | 0m 08s, 0m 17s, 0m 09s |
| `process-lifecycle` | 2 | 0, 0, 0 | 0m 06s, 0m 06s, 0m 06s |
| `process-lifecycle` | 4 | 3, 3, 2 | 0m 32s, 0m 33s, 0m 32s |
| `discover-mcp-servers.claude-code` | 0 | 0, 0, 0 | 0m 01s, 0m 01s, 0m 01s |
| `discover-mcp-servers.claude-code` | 1 | 0, 1, 0 | 0m 02s, 0m 02s, 0m 03s |
| `discover-mcp-servers.claude-code` | 2 | 0, 0, 0 | 0m 02s, 0m 02s, 0m 02s |
| `discover-mcp-servers.claude-code` | 4 | 0, 0, 0 | 0m 04s, 0m 03s, 0m 03s |
| `conformance.claude-code` | 0 | 0, 0, 0 | 0m 11s, 0m 12s, 0m 11s |
| `conformance.claude-code` | 1 | 0, 0, 0 | 0m 15s, 0m 15s, 0m 12s |
| `conformance.claude-code` | 2 | 0, 0, 0 | 0m 13s, 0m 13s, 0m 13s |
| `conformance.claude-code` | 4 | 0, 0, 0 | 0m 15s, 0m 16s, 0m 16s |
| `conformance.codex` | 0 | 0, 0, 0 | 0m 10s, 0m 11s, 0m 11s |
| `conformance.codex` | 1 | 0, 0, 0 | 0m 11s, 0m 11s, 0m 11s |
| `conformance.codex` | 2 | 0, 0, 0 | 0m 11s, 0m 12s, 0m 11s |
| `conformance.codex` | 4 | 0, 0, 0 | 0m 13s, 0m 13s, 0m 14s |
| `conformance.copilot` | 0 | 0, 0, 0 | 0m 15s, 0m 20s, 0m 20s |
| `conformance.copilot` | 1 | 0, 0, 0 | 0m 14s, 0m 15s, 0m 15s |
| `conformance.copilot` | 2 | 0, 0, 0 | 0m 14s, 0m 14s, 0m 14s |
| `conformance.copilot` | 4 | 0, 0, 0 | 0m 19s, 0m 18s, 0m 19s |
| `conformance.shell` | 0 | 0, 0, 0 | 0m 14s, 0m 16s, 0m 17s |
| `conformance.shell` | 1 | 0, 0, 0 | 0m 13s, 0m 15s, 0m 13s |
| `conformance.shell` | 2 | 0, 0, 0 | 0m 11s, 0m 13s, 0m 14s |
| `conformance.shell` | 4 | 0, 0, 0 | 0m 14s, 0m 14s, 0m 13s |
| `dispatch` | 0 | not measured | not measured |
| `dispatch` | 1 | 0, 0, 0 | 2m 12s, 2m 10s, 1m 20s |
| `dispatch` | 2 | 0, 0, 0 | 2m 23s, 1m 51s, 1m 06s |
| `dispatch` | 4 | 2, 0, 0 | 7m 14s, 1m 59s, 1m 56s |
| `cli-watch` | 0 | 0, 1, 2 | 0m 47s, 1m 57s, 1m 46s |
| `cli-watch` | 1 | 0, 0, 1 | 0m 40s, 0m 42s, 1m 51s |
| `cli-watch` | 2 | 0, 2, 1 | 0m 44s, 2m 23s, 2m 00s |
| `cli-watch` | 4 | 0, 0, 0 | 0m 56s, 0m 55s, 0m 56s |

A watchdog killed 8 leaked MCP servers older than 4 minutes during these runs, because each one would otherwise have held a run open forever. All of them were from runs on `main`, in t371 cases at8, at6, at7.


## Mechanism

Most reds share one mechanism: a timer starts when a child is spawned, and the
test needs that child to do something before the timer fires. A freshly spawned
`node` needs CPU before it can read stdin, write a sidecar or print a line.

The spawn-to-sidecar samples spawn `fake-engine.mjs` with `FAKE_ENGINE_RECORD` set
and poll for the file every 2 ms.

| Measurement | Result |
|---|---|
| Spawn to sidecar, `fake-engine.mjs`, one at a time, during a suite at 2x (6 batches of 150, load 115-163) | p50 749-1126 ms, p90 1094-1441 ms, max 1785 ms |
| Spawn to sidecar, 30 samples, load 47-87 | 1x: max 910 ms. 2x: max 1048 ms. 4x: max 1328 ms |
| What the old windows left for that boot | t678 AT3/AT4: 300-400 ms. t400: 250 ms. C9: 500 ms. t371: 700 ms. C3: 1000 ms |

**D (`SLOW_BOOT_DELAY_MS`) is 3000 ms.** The largest spawn-to-sidecar time seen at
2x was 1785 ms, which rounds up to 2000 ms. D is 3000 ms because those samples
were taken one at a time, while the suite's own spawns land together.

**The allowance (`START_UP_ALLOWANCE_MS`) is 6000 ms**: D plus the same again as
a margin, so a slow-boot case still passes when the machine is loaded as well.

## Classification

Causes: (a) test deadline shorter than the real work under load; (b) shared state
between tests or files; (c) concurrency of the suite itself; (d) a real defect in
the code under test.

| Test | Cause | Evidence | Fix |
|---|---|---|---|
| `t371 AT6` | (a) | `write-external-outputs.ts` gives the handshake the call's deadline, so 700 ms had to cover a `node` server's boot. Red under load with `[]` against `["hang"]`; the delayed-server case in `dispatch.test.ts` fails at 700 ms and passes at the allowance. | Window is the allowance. |
| `t371 AT7` | (a) | Same 700 ms deadline, red in the same runs as AT6. Added: t491 recorded t371's cases together. | Window is the allowance. |
| `t371 AT8` | (a) | Same 700 ms deadline, red in the same runs as AT6. Added for the same reason. | Window is the allowance. |
| `C9` | (a) | 1 s window from spawn with the first line at 500 ms left 500 ms to boot; measured boot p50 is above that. `FAKE_ENGINE_BOOT_DELAY_MS` reproduces `0 of 4` on a quiet machine. | Window and heartbeat scale together, same ratio. |
| `C3` | (a) | 1 s window from spawn. The boot delay reproduces the missing sidecar on a quiet machine. | Window is the allowance. |
| `t400` | (a) | 250 ms deadline against a child that must boot to write its pid. A child delayed by D reproduces `ENOENT ... pid` on a quiet machine. | Deadline is the allowance. |
| `t678 AT3/AT4` | (a) | 300-400 ms windows from spawn. The boot delay reproduces `the fake engine never wrote record.json` on a quiet machine. | Windows are the allowance. |
| `t678 AT8` | (a) | The finish-detail case has a 400 ms wall clock and needs a line printed first; red in the same runs as AT3/AT4. | Window is the allowance. |
| `cli-watch AT1` | (a) | A fixed 2 s sleep stands for the SSE connection opening, and a first-time consumer's cursor is set at connect, so a later connect loses the event. Failure at about 37 s: 2 s sleep, 30 s wait, start-up. | `--from-start`, no sleep. |
| `cli-watch AT2` | (a) | Same sleep, red in the same runs as AT1. Added: it was not in the original table, and it is in this file. | `--from-start`, no sleep. |
| `cli-watch AT3a` | (a) | Same sleep. | `--from-start`, no sleep. |
| `cli-watch AT5` | (a) | Same sleep. | `--from-start`, no sleep. |
| `dispatch.test.ts` | (d) | When the handshake timed out, `connect()` left the MCP server running, and its pipes held the test file open forever. Seen with `ps`: the test process idle for over 8 minutes with `deliver-hangs-once` still alive, its scratch directory already gone. Measured alone at multiple 4: one run took 7m 14s against about 2m for its two siblings, ending only when the watchdog killed the server. The late-server case fails on the old code with `the MCP server <pid> outlived the dispatch`. | `connect()` closes the client it could not hand back. |
| `t636 AT16` | (b) | The statement counter shares its handle with the webhook and hook dispatchers. An idle control plane prepares exactly 3 statements per 1 s tick, and the red is exactly 3 over: `16 !== 13`. Named in t636's learnings. | The counter ignores the dispatchers' statements. |
| `t638 AT8` | (b) | Same counter, same `16 !== 13`. Not in the original table; seen at 2x. | Same. |
| `t415 AT17` | (b) | Same counter, named in t636's learnings. Not seen red in these runs. | Same. |
| `session-cleanup.copilot t675` | (a) | 1 s windows from spawn, then a sidecar read. Red at 2x with `the fake engine never wrote its sidecar`, and a boot delay of D reproduces that on an unloaded run. Added on the founder's decision. | Windows are the allowance. |

## Same cause, outside this ticket's files

Listed, not edited (requirement 11). None of these went red in these runs.

| Test | Why it matches |
|---|---|
| `discover-mcp-servers.copilot.test.ts` t676 | 200 ms probe deadline. It reads no pid file, so it cannot fail on the boot, but it is the same shape. |
| `core/test/docker-image.e2e.test.ts` t250 | Fixed container name, so two worktrees collide (recorded by t547). Shared state, not a boot race. |

Checked and not affected: `conformance.claude-code.test.ts` t172 (`silenceSeconds:
1`) asserts only the status and the reason, which a kill before boot still
produces. `oversized-content.claude-code.test.ts` t203 (`timeoutSeconds: 1`) reads
no sidecar.

## Gaps

The measurement was stopped on the founder's decision because its load was slowing
another project's work. These are gaps, not results.

- **The concurrency sweep did not run: 0 of 8 runs.** Cause (c) is not established
  for any test, and it is not ruled out either. No test is classified (c), and no
  `--test-concurrency` was set, because nothing measured here supports one.
- **`dispatch.test.ts` alone is short by 3 runs: 9 of 12.** Multiple 0 has no
  result. The first of those runs stopped partway with no result recorded, for a
  reason nobody determined, and the other two never started.
- **No run was on a truly quiet machine.** Multiple 0 means no burners were added,
  while other agents kept running: the load average at its start was between 48.9
  and 261.4. So multiple 0 does not meet the quiet-machine criterion, and the
  durations in its rows are not quiet-machine durations.
- **The fix to `session-cleanup.copilot` t675 is not in the 12 after runs**, which
  ran at `da68ec3`. That file was run alone 3 times after the fix, with no burners,
  and passed; its slow-boot cases failed before the fix. The full suite was not run
  again after it.
- **The nominal multiples are not the load the machine had**, so a comparison
  between multiples is weak. The before and after columns ran at overlapping load
  averages, which is what makes them comparable.
