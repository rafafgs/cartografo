# Getting started

Cartografo is a local server that runs work along a **graph**: a map of steps,
each one carrying a contract for what it takes in and what it must produce, with
a gate between them that verifies the passage. A graph is versioned like code
and frozen while a piece of work crosses it, so the only decisions taken in
flight are the gates' — passed, failed, or escalate to a human. You import or
draw one graph per problem class, put work on it, and CLI agents carry out the
steps while you handle the exceptions the gates hand back.

This page is the long way round. [`README.md`](../README.md)'s "How to run it"
is the fast path, and every command below is the same command it publishes; what
this page adds is the two steps the quickstart stops short of — **putting a real
piece of work on the graph**, and **reading the system when that work stops
moving**. If you want the shortest route to a registered graph, read that
section instead and come back here at step 5.

For what the product is meant to be, rather than how to run it, read
[`docs/what-cartografo-is.md`](what-cartografo-is.md).

Before the first command below, read the block that opens
[`README.md`'s "How to run it"](../README.md#how-to-run-it): it states what you
are handing to the agent when you start the server, and this page does not repeat
it.

---

## 1. Install

```bash
npm install
```

Node 20.11 or newer; `.nvmrc` pins the version this repository develops on.

Use `npm ci` instead whenever you need the same `node_modules` twice — CI, a
second machine, a checkout you will come back to. [`README.md`](../README.md)
explains the difference under step 1 of "How to run it", and it is worth reading
once before you debug a red suite you did not break.

## 2. Start the control plane and the screen

Two processes, in two terminals. Neither is a build step: there is nothing to
compile and nothing to configure first.

```bash
npx cartografo                                  # terminal 1 — leave it running
```

It creates `.cartografo/cartografo.db`, applies the pending migrations, brings
up the HTTP server and prints one line:

```json
{"event":"cartografo.ready","database":"/your/checkout/.cartografo/cartografo.db","migrationsApplied":24,"url":"http://127.0.0.1:4317","bootstrapToken":"<64 hex characters>"}
```

**Copy the `bootstrapToken` now.** It appears only on the first start against a
new database — the database keeps only its hash — and every `/v1/*` route
demands it. Export it, because everything after this point presents it:

```bash
export CARTOGRAFO_TOKEN=<the token from the line above>
export CARTOGRAFO_URL=http://127.0.0.1:4317
```

Lost it? Delete `.cartografo/` and start again; a new one is issued.

Then the screen, in a second terminal:

```bash
npx cartografo-screen                           # terminal 2 — http://127.0.0.1:4318
```

It is an ordinary client of the same public API, on another port and in another
process, with no access to the database and no privilege over the control plane
(D11). It reads `CARTOGRAFO_TOKEN` and `CARTOGRAFO_URL` from the environment,
which the two exports above have already set.

## 3. Import a factory graph

An empty control plane knows no problem classes. Two come in the box; start with
the software one:

```bash
npx cartografo import factory-graphs/software-development
```

It checks the bundle's skill hash pins locally, registers the five skills, then
registers the graph as a base lineage and prints what was recorded:

```
graph imported
  class             software-development
  graph.id          software-development
  graph_version.id  sha256:030c7fdd…
  skills            5 registered, 0 already in the registry
```

`npx cartografo status --json` now lists the class with that version id, and so
does `GET /v1/classes`. The graph is five nodes — `refine`, `develop`,
`integrate`, `test`, `deploy` — and it begins at `refine`. That is the one fact
from this step you need for the next one.

## 4. Put a piece of work on it

A **job** is one piece of work crossing one graph. Creating one is a `POST`, and
the two fields that matter are what it is called and which node it starts on:

```bash
curl -sS -X POST "$CARTOGRAFO_URL/v1/jobs" \
  -H "Authorization: Bearer $CARTOGRAFO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title": "Add a /health check to the API", "entry_node_id": "refine"}'
```

`201` comes back with the whole job, not just its id:

```json
{"id":1,"project_id":1,"execution_id":null,"title":"Add a /health check to the API","fields":null,"tier":null,"entry_node_id":"refine","current_node_id":"refine","blocked":false,"block_reason":null,"graph_version_id":null,"created_at":"…","updated_at":"…","body":null,"acceptance_criteria":null,"completed":false}
```

Read `current_node_id`: the job is standing on `refine`, the node the graph
begins at, and it will stay there until something moves it. `blocked` is
`false` and `block_reason` is `null` — remember both, because step 6 is about
the run where they are not.

A job takes more than these two fields — `body`, `acceptance_criteria`, a
`fields` map whose shape the graph's own class decides — and every one of them
is optional here. Two are the minimum, and the minimum is the right place to
start.

## 5. Watch it run

Two views, and they answer different questions.

**Where is everything?** The board, at `http://127.0.0.1:4318/board`, groups
every job by the node it is standing on and shows the blocking reason where
there is one. Its sibling views are the proposal inbox at `/`, the escalation
queue at `/input-requests` and one job's timeline at `/jobs/<id>`
([`docs/spec/screen.md`](spec/screen.md) documents all seven routes). Each view
renders on the request: reloading the page is the refresh.

**What happened to this one job?** Its event timeline, which is the log rather
than a summary of it:

```bash
curl -sS -H "Authorization: Bearer $CARTOGRAFO_TOKEN" "$CARTOGRAFO_URL/v1/jobs/1/events"
```

A job just created has one event, `job.created`, carrying the data it was born
with. Everything that happens to it afterwards — a transition, a block, a
session opening, a question escalated — arrives as another append-only entry
here, which is what makes a round replayable rather than merely logged.

**Nothing is moving yet, and that is correct.** A job sits on its entry node
until a **runner** picks it up, and a runner is a separate process that
dispatches a real CLI agent session per node. Starting one needs an engine CLI
already installed and authenticated on your machine, so it is step 4 of
[`README.md`](../README.md)'s "How to run it" rather than a step here: that
section carries the `--working-dir` / `--worktrees-root` rules a session's
sandbox depends on, and they are not rules to meet halfway.

## 6. When it is stuck: where to look

In order, because each of the three is cheaper than the one after it.

**Is the job blocked, and what does it say?** A blocked job carries its own
reason; nothing has to be inferred from a log.

```bash
curl -sS -H "Authorization: Bearer $CARTOGRAFO_TOKEN" "$CARTOGRAFO_URL/v1/jobs/1"
```

`"blocked": true` with a `block_reason` is a job waiting on something named —
including, since a session that finished but left uncommitted work blocks rather
than deleting in silence, the path of a worktree still holding it.

**Is something waiting on you?** An escalation to a human is a first-class
entity here, not an error path. The queue of what is still unanswered:

```bash
curl -sS -H "Authorization: Bearer $CARTOGRAFO_TOKEN" "$CARTOGRAFO_URL/v1/input-requests?status=pending"
```

`{"input_requests":[]}` means nobody is waiting on you, which is a different
answer from an error and reads as one. Anything in that list can be answered
inline on the screen, at `/input-requests`, which writes through the same public
API you just read.

**Is the control plane itself unhappy?** Turn its log up. The server writes one
JSON log stream, and a `500` answers the client with no more than
`{error, message, request_id}` on purpose:

```bash
CARTOGRAFO_LOG_LEVEL=debug npx cartografo
```

`request_id` is the `reqId` of the matching log line — it is what ties "this
call broke" to "here is what broke". [`README.md`](../README.md) lists the rest
of the environment switches at the end of "How to run it".

---

## Where to go next

- [`docs/what-cartografo-is.md`](what-cartografo-is.md) — the product in plain
  language, and what is still under construction.
- [`README.md`](../README.md) — the runner, the surveyors, `export`, `prune`,
  and every configuration switch.
- [`factory-graphs/software-development/README.md`](../factory-graphs/software-development/README.md)
  — the graph you just imported, node by node.
- [`docs/spec/graph.md`](spec/graph.md) — the graph document format, if you want
  to write one of your own.
