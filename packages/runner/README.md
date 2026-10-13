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

Next to the worktrees the runner keeps `<worktrees-root>/.input-files`, where a
shell skill's `{{input_file.<path>}}` documents are written as
`job-<id>/<16 hex>/<path>.json`: one directory per dispatch, created once the
worktree exists and removed on every way the dispatch ends — never inside a
worktree, and never reused. A runner that crashes leaves at most that one
directory behind; `prune` lists it as unknown and does not touch it. Without a
`--worktrees-root` of its own (a dispatch wired by hand) the root is
`<os.tmpdir()>/cartografo-input-files`.

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
shared test a third adapter has to pass. `copilot-adapter` (GitHub Copilot CLI,
`--engine copilot`) is that third one, and it passed with no change to the
interface.

All three engines are proven by hand against the real CLI: `npm run spike` (Claude
Code), `npm run spike:codex` and `npm run spike:copilot`, each needing that
engine's credential. Copilot can also be proven **without a subscription**:
`npm run spike:copilot:stub` runs the real `copilot` binary against
`scripts/stub-openai-provider.mjs`, a scripted local provider, and checks the
lifecycle, the decoded text, an escalation and the taxonomy events. The
`spike:copilot` run against a real account is still pending
(`docs/formats/engine-adapter.md`, "The credential-free proof, and the open gap").

## Windows

The Copilot engine runs on native Windows (t684). Four behaviours differ there:

- **The whole process tree is stopped.** A cancel or a timeout runs
  `taskkill /PID <pid> /T /F`, since a POSIX process group does not exist. The
  session is recorded with a `null` exit code. The shell adapter does the same.
- **The command line stays under the ceiling.** Past 12 KiB (instructions plus
  prompt, in bytes) the composition goes to stdin instead of the argv.
- **The worker is isolated.** `CARTOGRAFO_TOKEN` is removed from its
  environment, and the CLI runs with `--no-custom-instructions` and
  `--no-ask-user`, so it neither loads `AGENTS.md` nor waits for an answer.
- **An input-only node runs tool-free.** `permissoes.filesystem.escrita: []`
  becomes `--available-tools=none`: the node reasons only over its rendered
  input and cannot read the working directory either.

The spike scripts use no `NAME=value` prefix, so they run from PowerShell.

An existing Windows checkout made before `.gitattributes` (t687) still holds CRLF
files, so `npm install` leaves it dirty. After pulling the change, commit or save
your local changes first, because `git reset --hard` discards them, then run
`git rm -r --cached . ; git reset --hard` to rewrite the working tree with LF.

Proof on real Windows is owed by the external operator. With a logged-in
Copilot CLI (`copilot login`, or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` /
`GITHUB_TOKEN`), from a PowerShell prompt:

1. `cd packages\runner; npm run spike:copilot` must complete, with the real model
   creating the requested file, and `npm run spike:copilot:stub` must also run.
2. Run one job through `--engine copilot` whose node skill declares
   `permissoes.filesystem.escrita: []`. It must finish `completed` with no
   `permission policy unsupported` error and no tool call in the transcript, and
   cancelling a live session (for example by letting `timeoutSeconds` expire)
   must leave no `copilot` or `node` child process in Task Manager, with the
   session recorded with a `null` exit code.

## What is inside

`src/dispatch/` is the bulk of it, and it is the session protocol rather than
plumbing: rendering the node's skill instructions into a prompt, parsing the
fenced JSON a session answers with, recognizing an input request and escalating
it to a human, reading a permission denial, retrying around an exhausted quota,
and reporting the outcome back. Node instructions come from the database through
the API — there is no dependency on a `CLAUDE.md` or on resident markdown in the
target repository.

`src/engine/` holds one adapter per engine. The three that run an agent CLI
(Claude Code, Codex, Copilot) share one process lifecycle,
`src/engine/process-lifecycle.ts`: spawn, line pump, wall clock and inactivity
watchdog, SIGTERM→SIGKILL escalation and the single `onFinished`. Each adapter
keeps only what its engine does differently.

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
