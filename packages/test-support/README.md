# @cartografo/test-support — test plumbing, not a product surface

**This package is not part of the system.** It ships no command, serves no
request and is imported by no `src/` anywhere. It is the shared setup the
acceptance suites need before they can test anything, in one place instead of
twelve.

**Workspace-internal** (`"private": true`), and the only workspace here with no
`bin` and no test script of its own — there is nothing to run, only a `typecheck`.

## Why it exists

Twelve acceptance suites across three packages needed the same four moves before
their first assertion: spawn `packages/core/bin/cartografo.mjs`, capture both
streams, wait for the JSON line that announces readiness, and take the process
down when the test ends. Each of them carried its own copy, and the copies had
started to drift — `urlBase` here, `url` there, `env` overridable in one and
fixed in the next. Eleven of the twelve would have gone on being right by
accident; the twelfth is where a readiness race gets fixed once and stays broken.

So this package owns the plumbing and the suites own their assertions.

## What it exposes

A single `.` entry, deliberately split in three, because the suites do not all
want the same thing:

| Export | For whom |
|---|---|
| `spawnWatched` | **any** command, with its streams captured and its teardown registered — `packages/runner/test/bin.e2e.test.ts` uses it for the runner's own process, which is not a control plane at all |
| `awaitReadiness` | **any** readiness event, which is what lets that same file wait for the runner's line through the same code path as the core's |
| `bootCore` | what the other eleven wanted: the two above, plus a throwaway database and the credential check |

Alongside them: `resolvePins`, and a re-export of `glossary.ts` — the one parser
of [`docs/spec/glossary-wire.md`](../../docs/spec/glossary-wire.md)'s tables.
Five per-package wire gates ask that document the same question, and before this
module each answered it with a parser of its own; five readers of one spec is
five ways to break the day its shape changes, and the five had already drifted.
`scripts/no-anti-portuguese-duplication.test.mjs` keeps this the only copy.

## What it is not allowed to touch

Nothing here imports `packages/core/src/**`, and least of all
`packages/core/src/db/**`. This is a test-side HTTP and process client — the same
kind of unprivileged consumer the runner and the screen are (D1, D11) — and
`scripts/check-single-writer.mjs` is what holds that line.

The readiness event name is spelled out in `src/index.ts` rather than imported
from the core for the same reason: importing it would pull Fastify and the whole
server graph into every test process that only wants to read one line of stdout.

## How it relates to the others

Five packages carry it as a `devDependency` — `core`, `runner`, `screen`,
`cost-surveyor` and `surveyor` — and it depends on none of them. It reaches the
control plane the way an operator would: by running its published binary and
talking to it over HTTP.
