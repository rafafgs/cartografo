# Changelog

All notable changes to `cartografo` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

`cartografo@0.0.1` (2026-09-05) was a name-reserving placeholder published by
hand from a throwaway manifest, outside this file's scope — not a tracked
release.

## [Unreleased]

### Added

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
