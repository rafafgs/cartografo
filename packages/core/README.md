# cartografo — the control plane

The process that owns the state. It creates and migrates the embedded SQLite
database, serves the REST/JSON API every other part of the system speaks, and is
the **only writer** in the repository (D1). Nothing else here opens the database
file; nothing else here declares a SQLite driver.

This is the one package that is **published**. It has no `"private": true`, its
`files` list ships `bin/`, `migrations/` and `src/`, and `npx cartografo` is the
project's front door.

## The command

```
cartografo [subcommand] [options]
```

| Subcommand | What it does |
|---|---|
| `up` | starts the control plane. The default: `cartografo` with no argument does this |
| `import <path>` | registers a graph file or bundle directory as a new base lineage |
| `export <class>` | writes the current version of a class, in the format `import` accepts back |
| `status` | reports the server and the registered projects |
| `scan-skill <path>` | derives a draft manifest from a cloned skill's `SKILL.md` |
| `propose-skill <file>` | opens the human approval for a manifest, and blocks a job on it |
| `register-skill` | sends what the human approved to the registry, which verifies it again |

The last three are D4's skill-import gate, in the three steps it requires: an
imported skill is a prompt-injection vector, so it is scanned, approved by a
person, and only then stored.

Exit codes are the convention every command in this repository follows: `0` did
what it promised, `1` ran and the result was negative, `2` the command line is
wrong.

Configuration: `CARTOGRAFO_DB_PATH`, `CARTOGRAFO_PORT` (default `4317`),
`CARTOGRAFO_HOST` (default `127.0.0.1`).

## Startup is one command, and its order is fixed

Open or create the database → apply the pending migrations → bring HTTP up →
print one JSON readiness line on stdout. There is no manual migration step and
no second command, because "one-command start" and "automatic migrations" are
recorded quality non-negotiables
([`notes/2026-08-14-extension-and-quality.md`](../../notes/2026-08-14-extension-and-quality.md)).

The default host stays on loopback. It stopped being the *only* possible address
once every `/v1` route began demanding a credential — the token is printed the
first time the control plane starts — which is what makes exposing an external
interface a configuration decision instead of a hole.

## What it exposes

No `exports` map: what this package offers is a process and an HTTP surface, not
a module for siblings to import. Business routes live under the `/v1` prefix and
carry an OpenAPI document; `/health` sits outside it, because it is an
infrastructure probe rather than a domain route.

Inside `src/`, the layering is the boundary: `db/` is the only tract that touches
the driver, `repositories/` the only one that touches `db/`, `routes/` the HTTP
edge, `domain/` the pure logic (graph hashing, semantic diffs, hypotheses,
similarity), and `cli/` a plain HTTP client of the public API like anybody else —
`import`, `export` and `status` hold no privilege over the screen or the runner.

## How it relates to the others

Everything else in this monorepo is a **client** of this package over HTTP, never
an importer of it. The runner, the screen, the two surveyors and the shared test
plumbing all reach the state through `/v1` and a credential; none of them may
import `packages/core/src/db/**`, and `scripts/check-single-writer.mjs` is the
gate that holds that line.

Persistence is append-only and versioned inside the database rather than through
git: `graph` / `graph_version` / `proposal`, with rollback moving a pointer and
nothing ever deleted (D15, D2).
