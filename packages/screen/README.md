# @cartografo/screen — the only part a person looks at

A small HTTP server that serves the operator's pages. Two halves share it: the
views rendered on the server — the board, the executions, the paired runners, one
execution, one job's timeline, and the questions waiting on a human — and the
proposal inbox, which is a static page with a same-origin proxy behind it. It
runs in its own process, on its own port, and it can die without the control
plane noticing.

**Workspace-internal** (`"private": true`). It ships as a separate package
because D11 says the official screen holds no privilege the API does not give
every other client — and a separate package, a separate port and a separate
binary are what that promise looks like from the outside.

## The command

```
cartografo-screen [--url http://127.0.0.1:4317]
```

Configuration: `CARTOGRAFO_SCREEN_PORT` (default `4318` — the control plane's
`4317`, plus one) and `CARTOGRAFO_URL`. Startup mirrors the core's: resolve the
configuration, listen, print one JSON readiness line, so a person with two
terminals open can tell the screen is up, on which port, and against which
control plane.

Loopback, and staying there: the screen holds the operator's credential, which
is a different risk from the control plane's.

## What it exposes

No `exports` map — this package is a process, not a library. What it serves,
`src/router.ts` decides in a fixed order, and the order is the contract:

| Path | Who answers |
|---|---|
| `/v1/*` | forwarded verbatim to the control plane (`proxy.ts`) |
| a file from `src/public/` | `static.ts` |
| anything else | the server-rendered views (`pages.ts`) |

The proxy comes first because `/v1` belongs to the API and not to the screen;
static comes before rendering because `resolveStaticFile` returns a path only for
a known extension, and it is exactly its `null` that hands `/executions` and
`/jobs/7` to the views instead of 404-ing them as a missing file.

## No framework, no bundler, no build step

Each page is assembled on the request out of what `client.ts` just read from the
public API. That is a choice of scale rather than taste: the screen is a
read-only HTTP client with one form, and a front-end pipeline would cost more
maintenance than the thing it serves. The only JavaScript that reaches the
browser is the handful of lines that copy an option into the answer field —
without it, the form still works by typing.

The `data-*` attributes in the rendered markup are a **contract**, not styling
hooks: the acceptance tests assert on structure through them, and they are
documented in [`docs/spec/screen.md`](../../docs/spec/screen.md). They keep their
original spelling for that reason. What a person reads does not: every title,
nav link, table header and status word is English.

## Why the proxy exists at all

A browser cannot call the control plane directly — the core ships no CORS plugin,
and installing one would widen who may call the only writer in the system. So the
screen serves its own page and forwards `/v1/*` from the same origin.

Three replies this package invents rather than forwards, and each is a decision:
`502 control_plane_unavailable`, so a socket error does not reach the browser as
a blank page; `403 untrusted_origin`, because a forwarded write carries the
operator's credential and a page on another site must not get to spend it; and
`413 body_too_large`, because the proxy buffers whole bodies and an unbounded one
would let a local page choose how much memory the screen spends.

## How it relates to the others

HTTP to `packages/core`, and nothing else. No import from the core, no database
driver in the manifest, no file path. `test/no-privileged-access.test.ts` and
`scripts/check-single-writer.mjs` keep it that way.
