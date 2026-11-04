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

<!-- tables:start -->

Measurements in progress: see the tables below once they are filled in.

<!-- tables:end -->

## Mechanism

Most reds share one mechanism: a timer starts when a child is spawned, and the
test needs that child to do something before the timer fires. A freshly spawned
`node` needs CPU before it can read stdin, write a sidecar or print a line.

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
| `dispatch.test.ts` | (d) | When the handshake timed out, `connect()` left the MCP server running, and its pipes held the test file open forever. Seen with `ps`: the test process idle for over 8 minutes with `deliver-hangs-once` still alive, its scratch directory already gone. The late-server case fails on the old code with `the MCP server <pid> outlived the dispatch`. | `connect()` closes the client it could not hand back. |
| `t636 AT16` | (b) | The statement counter shares its handle with the webhook and hook dispatchers. An idle control plane prepares exactly 3 statements per 1 s tick, and the red is exactly 3 over: `16 !== 13`. Named in t636's learnings. | The counter ignores the dispatchers' statements. |
| `t638 AT8` | (b) | Same counter, same `16 !== 13`. Not in the original table; seen at 2x. | Same. |
| `t415 AT17` | (b) | Same counter, named in t636's learnings. | Same. |

## Same cause, outside this ticket's files

Listed, not edited (requirement 11).

| Test | Why it matches |
|---|---|
| `session-cleanup.copilot.test.ts` t675, wall clock and inactivity | 1 s windows from spawn, then a sidecar read. Red at 2x with `the fake engine never wrote its sidecar`. |
| `discover-mcp-servers.copilot.test.ts` t676 | 200 ms probe deadline. It reads no pid file, so it cannot fail on the boot, but it is the same shape. |
| `core/test/docker-image.e2e.test.ts` t250 | Fixed container name, so two worktrees collide (recorded by t547). Not seen in these runs. Shared state, not a boot race. |

Checked and not affected: `conformance.claude-code.test.ts` t172 (`silenceSeconds:
1`) asserts only the status and the reason, which a kill before boot still
produces. `oversized-content.claude-code.test.ts` t203 (`timeoutSeconds: 1`) reads
no sidecar.
