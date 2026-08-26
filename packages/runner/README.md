# @cartografo/runner — the process that opens agent sessions

The stateless half of the system. It pairs with the control plane, asks for
released work, takes a lease on it, and dispatches a CLI agent session to do it —
each session in a git worktree of its own — one tick at a time until somebody
sends `SIGINT` or `SIGTERM`.

**Workspace-internal** (`"private": true`). It is not published; it runs from
this checkout.

## The command

```
cartografo-runner --url <url> --token <token> --worktrees-root <path>
```

Its own binary rather than a subcommand of `cartografo`, and that is the D11/D1
boundary made visible from the outside: the runner is another process, on
another machine as often as not, holding no privilege over the control plane.
A second subcommand, `prune`, cleans up the worktrees left behind.

`--worktrees-root` is required and must be a **sibling** of `--working-dir`,
never inside it. Other options worth knowing before the first run:
`--engine` (one engine per process), `--project`, `--runner-id`,
`--test-bench-path` (the integrated checkout the gate nodes observe),
`--reference-mode`, `--declared-runner-cap` and `--interval-ms`.
Address precedence is the core's: `--url` > `CARTOGRAFO_URL` >
`http://127.0.0.1:4317`; the credential likewise comes from `--token` or
`CARTOGRAFO_TOKEN`. Exit codes follow the same `0`/`1`/`2` convention.

## What it exposes

Three subpaths, and they exist because two siblings needed exactly these:

| Export | What it is |
|---|---|
| `./engine/types` | the **EngineAdapter** interface, a literal transcription of `docs/formats/engine-adapter.md`, frozen at v1 |
| `./engine/claude-code-adapter` | the first adapter — the one that drives Claude Code |
| `./surveyor/proposal` | the flow lens: evidence computed here from the log, operations chosen by one session, nothing applied |

`EngineAdapter` is the extension point this package was shaped around, and it was
frozen only once the rule of two consumers was satisfied: `claude-code-adapter`
and `codex-adapter` both live in `src/engine/`, with `conformance-kit.ts` as the
shared test a third adapter would have to pass.

## What is inside

`src/dispatch/` is the bulk of it, and it is the session protocol rather than
plumbing: rendering the node's skill instructions into a prompt, parsing the
fenced JSON a session answers with, recognizing an input request and escalating
it to a human, reading a permission denial, retrying around an exhausted quota,
and reporting the outcome back. Node instructions come from the database through
the API — there is no dependency on a `CLAUDE.md` or on resident markdown in the
target repository.

`src/controller/control-plane-client.ts` is the **only door** between this
package and the state of the system.

## How it relates to the others

Over HTTP to `packages/core`, and no other way. This package opens no database,
imports nothing from `packages/core/src/db`, and declares no SQLite driver — even
the default control-plane URL is redeclared here rather than imported, so the
boundary holds while nobody is looking. `scripts/check-single-writer.mjs` and
`test/no-privileged-access.test.ts` are what keep it true.

`@cartografo/surveyor` imports two of the three exports above; that is the only
direction in which another package depends on this one.

Leases carry a heartbeat and every API write is idempotent, so work from a runner
that dies returns to the queue (D5).
