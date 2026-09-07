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
history or a CI log. The same goes for a file a session uploads: an artifact is
stored exactly as it was received, under no redaction of any kind
([`docs/spec/artifacts.md`](docs/spec/artifacts.md)), and nothing ever deletes
one.

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

Step 2 is the product, not just the server. It creates
`.cartografo/cartografo.db`, applies the migrations, serves HTTP on
`127.0.0.1:4317` and prints `cartografo.ready` — and then starts the screen on
`127.0.0.1:4318` and one local runner, both as child processes of its own, and
opens your browser on the screen. It asks nothing and blocks on nothing;
`Ctrl-C` takes all three down together. On the **first** start against a new
database the readiness line also carries a `bootstrapToken` — the operator
credential, shown once and never again, since only its hash is stored. Lost it?
Delete `.cartografo/` and start again for a fresh one.

That local runner works in `~/.cartografo/workspace`, which step 2 creates as an
empty git repository the first time, cutting each session's worktree into
`~/.cartografo/worktrees`. Both paths are settings, not constants: `PATCH
/v1/settings` points them anywhere you like, and a `workspace_root` you changed
is never written to. Want fewer than all three processes? `--no-browser`,
`--no-runner` and `--no-screen` each subtract exactly their own part, and all
three together is the control plane on its own.

Step 3 registers the bundled graph, checking each pinned skill hash first, and
prints the recorded `graph_version.id`. `GET /v1/classes` then lists
`software-development`.

**The checkout in step 1 is not optional yet.** `cartografo` is a single
publishable package carrying all six commands (D23), so
`npm install -g cartografo` really does put every one of them on `PATH` — which
is also how step 2 finds the screen and the runner it starts — and step 2 works
from any empty directory. Step 3 does not: `factory-graphs/` is a directory of
this repository and is not shipped inside the package, so `import` has nothing
to point at without a clone. Making the whole sequence work from a bare install
— deciding whether the example graphs ship, are fetched, or are generated — is
its own ticket.

A runner configured differently — another repository, another engine, another
project — is still its own command, started by hand beside a `cartografo` that
was told not to start one:

```bash
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cartografo-runner --project 1 \
    --working-dir ~/proj --worktrees-root ~/proj-worktrees    # with `npx cartografo --no-runner`
```

For the slower way round — the same commands, plus putting real work on the graph
and reading the system when that work stops moving —
[`docs/getting-started.md`](docs/getting-started.md) walks it one step at a time.

## The commands

**`cartografo`** — the one command that brings the product up, plus `status`,
`export` and `export-history`.

```bash
npx cartografo                                 # control plane + screen + runner, browser opens
npx cartografo --no-browser --no-runner --no-screen  # the control plane on its own
npx cartografo status                          # server and registered projects
npx cartografo status --json                   # the same, for a script
npx cartografo export software-development     # writes ./software-development.graph.json
npx cartografo export-history --job 41         # writes ./job-41.history.jsonl
```

With no subcommand it is `up`, and the three `--no-*` options belong to it
whether the word is typed or not. The screen and the runner it starts are
ordinary processes with no privilege of their own — the same two binaries you
would have run in two more terminals, resolved off `PATH` by name and handed a
credential of that startup's own, which is revoked when they stop. A `SIGINT`
or `SIGTERM` goes to both children first and waits for them; a second one stops
waiting.

What `export` writes is what `import` takes back: importing it elsewhere
produces the same `graph_version.id`.

`export-history` writes a job's — or a whole round's, with `--execution` — story
as JSON Lines: a header with the map version, then every event, session and
question in `id` order, one complete object per line, so a file cut in the
middle still reads to its last line ([the
format](docs/spec/history-export.md)). It goes only one way: there is no
importing a history back, and the file carries the record unredacted.

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

At `/`, the **check**: per paired runner, whether its engine CLI is there, whether
it has a model credential, whether the `cartografo` MCP server is registered with
it and whether its workspace can be worked in — either all four met, with a way
into the board, or exactly what is missing and one command to fix each. It asks
for nothing it can read off a runner's own report. At `/inbox`, the **proposal
inbox**: the semantic diff, the evidence, the decision
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
| `CARTOGRAFO_SCREEN_HOST` | `127.0.0.1` | The screen's listening address. Same rule as `CARTOGRAFO_HOST`: opening it is your decision. `compose.yml` is the one place that takes it, because a container's loopback is not yours. |
| `CARTOGRAFO_SCREEN_PORT` | `4318` | The screen's port. `npx cartografo` reads it too, so the screen it starts and the browser it opens land on the same one. |
| `CARTOGRAFO_SCREEN_TOKEN` | `CARTOGRAFO_TOKEN` | A credential of the screen's own. It presents this to the control plane and asks the browser for none, which is why it listens on loopback. |
| `CARTOGRAFO_MCP_TOKEN` | `CARTOGRAFO_TOKEN` | The same for the MCP server. There is deliberately no `--token` flag on that command. |

## Running in a container

`Dockerfile` and `compose.yml` at the root build one image and run two
containers from it: the control plane and the screen. Both are the single
`cartografo` package installed the way anyone else installs it, so the commands
inside the container are the commands in the table above.

**The runner does not go in the container**, and that is a decision rather than
an omission (D23): it needs the engine CLI already authenticated and the target
repository on the same machine, and an image that carried both would be an image
carrying your credentials. It runs on the host, beside the two containers, and
is the last of the three commands below.

Bring the control plane up first, because the screen needs a credential that
only exists once it has started:

```bash
docker compose up control-plane                               # 1 (leave it running)
```

On the **first** start against a new volume, its `cartografo.ready` line carries
a `bootstrapToken` — the same field, printed the same once-and-never-again way,
as `npx cartografo` in the Quick Start. Read it off that line, and then, in
another terminal:

```bash
export CARTOGRAFO_TOKEN=<the token from step 1>
docker compose up screen                                      # 2 → http://127.0.0.1:4318
CARTOGRAFO_URL=http://127.0.0.1:4317 npx cartografo-runner    # 3 (on the host, not in a container)
```

Once you have the token, `docker compose up` with no service name starts both
containers together: nothing mints a second token, so a later start needs
nothing new pasted into it.

Three things worth knowing before you point anything real at this:

- **The database is on a named volume**, `cartografo-db`, mounted at `/data` on
  the control plane alone. `docker compose down` leaves it; `docker compose down
  --volumes` is what deletes it, along with the operator credential inside it.
- **The image binds loopback, the compose file opens it.** There is no
  `CARTOGRAFO_HOST` in the `Dockerfile` on purpose — an image should not decide
  for its operator that a port is open. `compose.yml` sets `0.0.0.0` for both
  services and publishes `4317` and `4318`, which puts the same two ports on your
  host that the Quick Start would. The control plane's is behind the credential
  gate; the screen's is not, and it is holding a credential of its own, so treat
  `4318` the way the Quick Start's loopback default already treats it.
- **The screen's service has its healthcheck turned off.** The image's baked
  `HEALTHCHECK` probes the control plane's `/health` on port `4317`, which the
  screen never listens on; there is no equivalent route for the screen yet.

## The factory graphs

Three bundles ship ready to import, as worked examples of the format in three
very different domains.

**[`factory-graphs/software-development`](factory-graphs/software-development)** —
`refine → develop → integrate → test → deploy`, where `test` is a gate with two
exits: approved carries on to deployment, rework goes back to development.

**[`factory-graphs/asymmetric-bets`](factory-graphs/asymmetric-bets)** —
`triage → collect-fundamentals → analyze-asymmetry → red-team → size-risk →
decide → record-monitoring`, with a red team whose job is to kill the thesis and
a mandatory human gate at the decision. It models an analysis workflow as an
example of graph structure, and is not investment advice.

**[`factory-graphs/b3-flow-radar`](factory-graphs/b3-flow-radar)** —
`check-intake → triage → contextualize → hypothesize → red-team → compose-brief
→ scorecard`, over three real B3 trading days that ship inside the bundle as
fixtures, so it runs with no network and no configuration. Its first node is a
command rather than a session, and its red team attacks with the day's own
records because no node here is allowed to research. It models a market-data
workflow as an example of graph structure, and is not a trading signal.

Two of the three ship a `demo/job.json`, which is what makes them runnable
without writing anything: the screen's **examples** page
(`http://127.0.0.1:4318/examples`) lists them, and one click registers the
bundle and opens its demo job on a round of its own. Same effect as `cartografo
import` followed by a `POST /v1/jobs`, minus both.

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
