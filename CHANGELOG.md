# Changelog

All notable changes to `cartografo` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

`cartografo@0.0.1` (2026-09-05) was a name-reserving placeholder published by
hand from a throwaway manifest, outside this file's scope — not a tracked
release.

## [Unreleased]

### Added

- A neutral `capability` (`general` or `advanced`) on a graph and on a node: the
  graph says how capable a model it needs and names no engine, model or effort.
  The runner resolves it per engine from its own environment:
  `<PREFIX>_MODEL_<LEVEL>` (`CLAUDE_`, `CODEX_`, `COPILOT_`; `GENERAL`,
  `ADVANCED`) and, for claude-code (`--effort`) and codex
  (`-c model_reasoning_effort=...`), an optional `<PREFIX>_EFFORT_<LEVEL>`.
  Precedence is `model`, then `capability`, then the job's tier; there is no
  default model, so a level the installation has not mapped is refused before the
  session opens (`capability unmapped: <engine> <level>`) and blocks the job on
  the first occurrence. Refused on `shell` and `subgraph` nodes. The session
  records the capability it was asked for (`session.capability`, new migration
  `0039`); a graph that declares none runs exactly as before. The Claude Code
  catalogue also lists `claude-sonnet-5-5` and `claude-opus-5-5`.
- `cartografo-runner --projects <id,...>` and `--all-projects`: one runner
  process serves several projects, round-robin by project id, each session in
  its own project's repository and worktrees root, on its own project's engine,
  all read from that project's settings. `--all-projects` re-lists the projects
  before each pass, so a project created later is served with no restart. A
  project whose settings cannot be used is skipped with one line and re-read
  every 30 seconds. Both flags refuse `--project` and the four path flags; still
  one session at a time, one probe per runner (the lowest served project's
  workspace).
- `cartografo-runner prune --project <id>`: reads each job inside that project,
  so a project other than the default one can be pruned. Without it the read is
  unchanged.
- `cartografo graph propose <bundle dir>`: checks the bundle, registers its skill
  manifests (idempotently) and then proposes the new graph version, so one
  command upgrades an installed bundle. It prints a `skills` line, and an
  unchanged graph still registers a missing manifest. `--dry-run` registers
  nothing. `import` on a class that already exists now names this command.
- `{{input_file.<path>}}` in a shell skill's `command.argv` and `instructions`:
  it resolves to the absolute path of a file holding the value, so a whole JSON
  document no longer has to travel as one argument. The files live in
  `<worktrees-root>/.input-files/job-<id>/<16 hex>/`, outside the worktree, and
  are removed on every exit of the dispatch. `{{input.<path>}}` renders as before.
- A shell skill whose command line the platform cannot spawn — more than 32,000
  UTF-16 units in all on Windows, or an argument over 131,072 bytes elsewhere —
  is now refused before a worktree is cut or a process is started, and the job
  is blocked with a reason naming the `argv` element and the placeholder to
  switch to `{{input_file.<path>}}`.

### Removed

- The screen: the `cartografo-screen` command and the `@cartografo/screen`
  package (D27).
- The `--no-screen` and `--no-browser` flags of `cartografo up`, which now
  starts the control plane and a local runner; `--no-runner` is its one flag
  (D27).
- The screen's container — the `screen` service in `compose.yml` and port
  `4318` in the `Dockerfile` — and its three environment variables,
  `CARTOGRAFO_SCREEN_HOST`, `CARTOGRAFO_SCREEN_PORT` and
  `CARTOGRAFO_SCREEN_TOKEN` (D27).
- `docs/spec/design-system.md` and the four screen specifications
  (`docs/spec/screen.md`, `screen-proposal-inbox.md`, `screen-graph-editor.md`,
  `screen-interview.md`), superseded by `docs/spec/cli.md` and
  `docs/spec/mcp-server.md` (D27).

### Fixed

- A proposal in project 2 or later can now be applied, reverted and closed.
  `POST /v1/proposals/:id/apply`, `/revert` and `/outcome` read the graph, its
  versions, the skill registry and the execution metrics in the proposal's own
  project instead of project 1, so they no longer answer `stale_proposal` or
  `unknown_graph` for a graph that is current in its project, and a version
  that exists only in another project no longer counts as `version_without_effect`.
  `cartografo graph propose ... --by` and `cartografo proposals
  approve|apply|reject|revert` now send `--project` with the decision as well as
  with the creation, so `pipefactory update` can upgrade the graphs of every
  project. Closes #5.
- A `git` that could not start while reading the test bench (low memory, a
  signal kill, a Windows exit 0xC0000142 with no output) is now retried like any
  transient pre-session failure instead of blocking the job as a bench
  misconfiguration. The block reason for a bench `git` that ran and refused now
  quotes the exit code or errno. Fixes #4.
- On Windows, the claude-code and Codex adapters now take content off the
  command line past 12 KiB (64 KiB elsewhere), so a session whose composition is
  roughly 30 to 64 KiB no longer fails to start with `ENAMETOOLONG`.
