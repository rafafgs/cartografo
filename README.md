# cartografo

> Draw, execute and evolve a work graph per problem class. You declare the
> problem; the system draws the map.

cartografo is a self-hosted orchestrator for agent work. A problem class — a
kind of job you do over and over — becomes a **graph**: work nodes that produce
something, gate nodes that check it, edges that route on the outcome. Jobs
travel that graph, agent sessions do the work at each node, and everything the
traversal did is recorded. Between rounds an evaluator reads that record and
**proposes changes to the graph itself**, which a human approves or rejects.

The unit of reuse is the process, not the prompt.

## The idea

Two ways of doing graph engineering are common today: drawing the topology by
hand for each case (LangGraph and the like), or fixing one graph per domain and
living with it. The middle is missing — a system that **generates and evolves**
a graph per problem class while keeping the governance a fixed graph gives you.

That middle is what this is. A person declares the problem. The system queries a
registry of capabilities — skills that each declare a contract — synthesizes a
graph of steps, validates that graph at a gate, and executes it with the path
**frozen**: the only decisions in flight are the gates' (passed, failed, escalate
to a human). Afterwards an evaluator reads the log — where a queue formed, where
a human was pulled in, where work went round in circles — and proposes a new
version of the graph. The human works the exceptions and decides the mutations.

## How it works

**The graph is data, not code.** One JSON document declares the nodes, the edges,
the entry and the exits, and every node's contract: what it takes, what it
produces, and how what it produced is verified.
([`docs/spec/graph.md`](docs/spec/graph.md))

**Frozen during a traversal, versioned between them.** A node does not pick its
own path at run time — that is a loop with decorations, with neither
reproducibility nor an audit trail. Synthesize, freeze, traverse, learn from the
log, mutate the next version. Each version is identified by the canonical hash
of its document, so the same graph imported into two control planes gets the
same id.

**A contract per capability, not a prompt.** Every skill declares its input, its
output and the checks that verify what it produced — deterministic (a command
that must exit clean) or agentic (a judgement with required evidence). With no
contract a synthesizer composes by hallucination; with one, composing a graph is
matching contracts.

**Explicit state, never a shared window.** What is shared is the board and the
event log. Each node receives a projection of the state, not a conversation
history. A common context window recreates the degradation of a long session.

**Proposals are a human gate.** The evaluators — one reading flow, one reading
cost — deposit proposals. Nothing applies itself. A model approving the proposal
its own evaluator wrote would close the learning loop with no judge outside it,
which is the one thing the loop is for.

The pieces that follow from that: a **capability registry** (skills with
contracts), a **synthesizer** (declared problem to proposed graph), a **graph
validation gate**, an **executor** (traversal, queues, escalation), an
**evaluator**, and **process memory** (graphs versioned per problem class).

**An honest limit.** This adapts to any problem where each step's contract can be
written down. Where no intermediate verification is possible there is no gate,
and with no gate the graph is decorative. The ceiling is verification density,
not intelligence.

## How to run it

Two things to know before the first command. Both follow from what this is — a
local orchestrator that hands a model a terminal — and not from a defect in it.

**The agent inherits your whole shell environment.** `buildEnvironment`
([`packages/runner/src/engine/command.ts`](packages/runner/src/engine/command.ts))
puts the session's own overrides on top of the environment the server was started
from and hands the result to the engine process. Every variable in that shell
goes with it, including credentials for services that have nothing to do with
this one. Start the server from a shell scoped to what the work needs, the way
you would for anything you are about to give a terminal to.

**Session transcripts are stored as the agent printed them.** The `transcript`
column ([`packages/core/src/repositories/session.ts`](packages/core/src/repositories/session.ts))
keeps the output whole, under a byte ceiling, and nothing redacts, scrubs or
masks it on the way in: if a command echoed a credential, that credential is at
rest in `.cartografo/cartografo.db`. Treat that file the way you treat a shell
history or a CI log.

Neither is closed by a list of allowed tool names.
[`packages/runner/src/engine/permission-policy.ts`](packages/runner/src/engine/permission-policy.ts)
says in its own header where its enforcement stops, and
[`docs/formats/engine-adapter.md`](docs/formats/engine-adapter.md) writes the
residual gap down under "The session's permissions". Both are worth reading
before you decide what to point this at.

What *is* closed: the control plane listens on `127.0.0.1` by default and opening
the port is a decision you take; every `/v1/*` route sits behind one credential
gate; and the database keeps only the hash of that credential, never the
credential.

### Quick start

From a clean checkout to a registered graph, in three commands:

```bash
npm install                                                   # 1
npx cartografo                                                # 2 (leave it running)
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cartografo import factory-graphs/software-development   # 3 (another terminal)
```

Step 2 is the whole control plane: it creates `.cartografo/cartografo.db`,
applies the migrations, serves HTTP on `127.0.0.1:4317` and prints
`cartografo.ready`. On the **first** start against a new database that line also
carries a `bootstrapToken` — the operator credential, shown once and never
again, since only its hash is stored. Lost it? Delete `.cartografo/` and start
again for a fresh one.

Step 3 registers the bundled graph, checking each pinned skill hash first, and
prints the recorded `graph_version.id`. `GET /v1/classes` then lists
`software-development`.

And a fourth command puts a runner behind it:

```bash
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cartografo-runner --project 1 \
    --working-dir ~/proj --worktrees-root ~/proj-worktrees    # 4 (another terminal)
```

For the slower way round — the same commands, plus putting real work on the graph
and reading the system when that work stops moving —
[`docs/getting-started.md`](docs/getting-started.md) walks it one step at a time.

## The commands

**`cartografo`** — the control plane, plus `status` and `export`.

```bash
npx cartografo status                          # server and registered projects
npx cartografo status --json                   # the same, for a script
npx cartografo export software-development     # writes ./software-development.graph.json
```

What `export` writes is what `import` takes back: importing it elsewhere
produces the same `graph_version.id`.

**`cartografo-runner`** — pairs with the control plane, then asks for released
work, takes the lease and dispatches an agent session per job, one per tick
(`--interval-ms`, default 2000). One engine per process
(`--engine claude-code|codex`); it is that engine's CLI, installed and
authenticated on the machine, that actually runs.

Every session works in a `git worktree` of its own on a `ticket-<id>` branch.
`--working-dir` is the repository the worktree is cut from; `--worktrees-root`
is where it lands. The second is **mandatory and has no default** — where a
session may write is the operator's decision, never the code's guess — and it
must be a *sibling* of the first, never inside it.

A session that ends clean loses its worktree. One that fails, times out, is
cancelled, or ends with uncommitted work keeps it, because that tree is the only
place its work still exists. Those pile up, and `prune` collects them:

```bash
npx cartografo-runner prune --working-dir ~/proj \
  --worktrees-root ~/proj-worktrees --dry-run   # lists what it would collect
```

It only collects what the control plane calls finished, and removes branches with
`git branch -d`, never `-D`: finished means the traversal reached a final node,
which says nothing about the commits having been merged.

**`cartografo-surveyor`** — watches the event stream and, when the control plane
declares an execution finished, runs both evaluator lenses over it: flow (an
agent session, a semantic diff) and cost (a deterministic aggregation).

```bash
npx cartografo-surveyor watch --url http://127.0.0.1:4317 --token <token>
```

Every proposal is born `pending` and waits for a human. Running twice over one
execution does not duplicate: the control plane deduplicates by lens, target
version and operations. It also does not switch itself on — no service, no cron.

**`cost-surveyor`** — the cost lens on its own, over one execution.

```bash
npx cost-surveyor evaluate --url http://127.0.0.1:4317 \
  --execution 7 --token-cap 200000
```

**`cartografo-screen`** — the two halves of the operator's screen.

```bash
npx cartografo-screen                          # http://127.0.0.1:4318
```

At `/`, the **proposal inbox**: the semantic diff, the evidence, the decision
([`docs/spec/screen-proposal-inbox.md`](docs/spec/screen-proposal-inbox.md)). At
`/board`, **observability**: jobs grouped by node, executions, sessions, the
queue of pending questions with an inline answer, and any job's timeline split
into queueing, working and waiting on a human
([`docs/spec/screen.md`](docs/spec/screen.md)).

**`cartografo-mcp`** — the same map for a model instead of a browser, over MCP.

```bash
npx cartografo-mcp                             # started BY an MCP client
```

Eleven read tools and five write ones
([`packages/mcp/README.md`](packages/mcp/README.md)). It deliberately publishes
no tool that decides a proposal and none that moves a job across the graph: a
transition is the runner writing down what it did, and an invented one would
corrupt the record the evaluator reads. `.mcp.json` at the root declares the
command with the credential left out — that file is versioned, and a token
written there is a token published.

All of the screen, the surveyors and the MCP server are ordinary clients of the
public API, with no privilege over the control plane and no access to the
database.

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `CARTOGRAFO_HOST` | `127.0.0.1` | Listening address. Opening the port to the network is your decision, not the command's. |
| `CARTOGRAFO_PORT` | `4317` | Control-plane port. |
| `CARTOGRAFO_DB_PATH` | `.cartografo/` | Where the embedded database lives. |
| `CARTOGRAFO_LOG_LEVEL` | `info` | `trace`…`silent`. Tick failures and unexpected 500s come out here; a client only ever sees `{error, message, request_id}`, and `request_id` is the `reqId` of the matching log line. |
| `CARTOGRAFO_URL` | `http://127.0.0.1:4317` | Points the subcommands, the runner and the screen at a control plane elsewhere (or `--url`). |
| `CARTOGRAFO_TOKEN` | — | The credential the subcommands and the runner present (or `--token`). |
| `CARTOGRAFO_LEASE_CAP_RUNNER` | `50` | Cap on simultaneous leases per runner. The runner declares what it wants and the **smaller** of the two wins: concurrency is the control plane's call. |
| `CARTOGRAFO_LEASE_CAP_PROJECT` | `50` | The same, per project. |
| `CARTOGRAFO_SCREEN_PORT` | `4318` | The screen's port. |
| `CARTOGRAFO_SCREEN_TOKEN` | `CARTOGRAFO_TOKEN` | A credential of the screen's own. It presents this to the control plane and asks the browser for none, which is why it listens on loopback. |
| `CARTOGRAFO_MCP_TOKEN` | `CARTOGRAFO_TOKEN` | The same for the MCP server. There is deliberately no `--token` flag on that command. |

## The factory graphs

Two bundles ship ready to import, as worked examples of the format in two very
different domains.

**[`factory-graphs/software-development`](factory-graphs/software-development)** —
`refine → develop → integrate → test → deploy`, where `test` is a gate with two
exits: approved carries on to deployment, rework goes back to development.

**[`factory-graphs/asymmetric-bets`](factory-graphs/asymmetric-bets)** —
`triage → collect-fundamentals → analyze-asymmetry → red-team → size-risk →
decide → record-monitoring`, with a red team whose job is to kill the thesis and
a mandatory human gate at the decision. It models an analysis workflow as an
example of graph structure, and is not investment advice.

## Take the patterns

The licence grants the right to copy; this paragraph is the invitation, which is
a different thing. What is worth lifting here is the design rather than the
binary — a graph frozen during execution and versioned between rounds, a contract
per capability instead of a prompt, a gate that verifies with its own evidence, a
mutation that stays a proposal until a human decides. Copying any of it into a
tool of your own, under any architecture, is the use this repository was written
for.

## Reference

- [`docs/getting-started.md`](docs/getting-started.md) — the cold-start walkthrough.
- [`docs/what-cartografo-is.md`](docs/what-cartografo-is.md) — the concept at length.
- [`docs/spec/`](docs/spec) — the formats and the components, specified.
- [`DECISIONS.md`](DECISIONS.md) — every decision on record, with its date and its reason.

Related work worth knowing: ADAS (automated search of agentic designs), DSPy
(pipeline optimization from metrics), process mining (van der Aalst), LangGraph
(an authored topology per use case). What sets this apart is the persistent graph
per problem class that evolves between rounds — a team's retrospective turning
into code.

`cartografo` is the one who draws a map per territory: one graph per problem
class, redrawn as the territory is explored.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
