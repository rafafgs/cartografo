# cartografo

> A framework that draws, executes and evolves work graphs per problem class.
> You declare the problem; the system draws the map.

**State: it runs; what it has not yet shown is that it learns.** What is in this
repository today is a control plane, a runner, a screen and the two factory
graphs D14 asks for — and on 2026-08-18 both of those graphs closed a real
traversal on their own.

The software graph took a game feature through
`refinar → desenvolver → integrar → testar → implantar`: five nodes by agent,
five reports accepted at the first attempt, no human gate opened, no operator,
15 minutes and around US$ 12
([`notes/2026-08-18-game-feature-2.md`](notes/2026-08-18-game-feature-2.md)). The
same day, the asymmetric-bets graph took a tender thesis through
`triagem → coleta-fundamentos → analise-assimetria → red-team`, and its red team
killed the thesis: 8 objections, 2 of them high, verdict `morta`, the `decisao`
gate never reached, again with no operator
([`notes/2026-08-18-third-bets-run.md`](notes/2026-08-18-third-bets-run.md)).

What has NOT been shown is the other half, the one the whole meta-layer rests
on. **The learning loop stands at n=1**: one complete traversal on version A of
one bundle, no version B, the human gate at the proposal never exercised, and
**no A/B measurement of any proposal exists**. The round that was to produce it
was stopped after the account's own quota killed the same node twice
([`notes/2026-08-18-n3-round.md`](notes/2026-08-18-n3-round.md)). The evaluator
proposes and a human decides, as principle 5 says; whether what it proposes
makes the next round better is an open question in this repository, not a
settled one.

Origin: a conversation of 2026-08-14 about graph engineering, during the
production of article O001 of the newsletter (repository `substack-agentes`).
Rafael's idea; refined in the discussion.

## The idea in one paragraph

A person declares the problem they want to solve. The system queries a registry
of capabilities (skills with a contract), synthesizes a graph of steps for that
problem class, validates that graph at a gate, and executes the work with the
path frozen: the only decisions in flight are the gates' (passed, failed,
escalate to a human). After the execution, an evaluator reads the log (where a
queue formed, where the human was pulled in, where the work went round in
circles) and proposes changes to the graph for the next round. The system
improves itself between executions, with the human working on the exceptions.

## How to run it

From a clean checkout to the first registered graph, in three commands:

```bash
npm install                                                            # 1
npx cartografo                                                         # 2 (leave it running)
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cartografo import factory-graphs/software-development            # 3 (another terminal)
```

Step 1 is `npm install` because a working checkout is where the lockfile moves.
A **reproducible** install — CI, or any machine that needs the same
`node_modules` again — asks for `npm ci`: it installs exactly what
`package-lock.json` says and **fails** when the lockfile and `package.json`
disagree, instead of silently accommodating the difference. It was an old
`node_modules`, older than a freshly added dependency, that knocked out 314 tests
and the `typecheck` in one checkout with nobody understanding why.

Step 2 is the whole control plane in one command: it creates
`.cartografo/cartografo.db`, applies the pending migrations, brings up the HTTP
server and prints the line `cartografo.ready`. On the FIRST start against a new
database that line also carries a `bootstrapToken`: it is the operator
credential, and it is the only time it ever appears — the database keeps only its
hash. Every `/v1/*` route demands that credential; `/health` demands none,
because it is an infrastructure probe. Lost the token? Delete `.cartografo/` and
start again, and another one is issued. A second `npx cartografo` against the
same database exits 1 with a single line, naming the pid of the one already
running and the `<database>.lock` file it holds — only the server writes to the
database (D1), and that holds between processes, not only inside one.

> **Coming up from a version older than t235? Delete `.cartografo/`.** D20 took
> to English the vocabulary of the event log (`job.created` in place of
> `trabalho.criado`, `data.title` in place of `dados.titulo`), that of the
> proposal operations (`add_node` in place of `adicionar_no`,
> `{type, node_id, field, from, to, inverse}` in place of
> `{tipo, no_id, campo, de, para, inversa}`) and that of the database itself —
> the table and column names (`job`, `graph_version`, `created_at`) and also the
> VALUES they hold (`status = 'pending'` in place of `'pendente'`,
> `entity_type = 'job'` in place of `'trabalho'`, `role = 'work'` in place of
> `'fazer'`). All of that is recorded data, and recorded data is not rewritten —
> the log is append-only, a stored proposal is the record of what somebody
> proposed, and an old row does not pass the new `CHECK`. Since there is no
> production data, the decision's own answer is to **recreate** the development
> database rather than migrate it — `rm -rf .cartografo/` and `npx cartografo`
> again. There is no rename migration to run: the nineteen migrations are born
> in English, and an old database is not brought up to date by them.
>
> **What t279 adds is protection for the next time, not a repair for this one.**
> Since `0023`, `schema_migrations` keeps the `checksum` of the content of every
> applied migration, and every start checks it: a migration already applied that
> was edited in place — or that vanished from disk, because somebody renamed it —
> makes `npx cartografo` stop right there, naming it, instead of starting clean
> and dying later in the middle of a request with a `no such column`. That does
> not reach the databases D20 already broke: their rows were written before the
> checksum existed, so there is nothing to compare against, and the runner only
> records what it finds today (warning on stderr). For those, the answer is still
> exactly the one above — `rm -rf .cartografo/`.

Step 3 registers factory graph 1 (D14) as a base lineage — checking the bundle's
skill hash pins locally first (D4) — and prints the `graph_version.id` that was
recorded. At the end, `GET /v1/classes` lists `software-development`.

The bundle's skills go into the registry before the graph, and the registry keeps
one version per row (D22): reimporting the same bundle rewrites nothing, and
reimporting it after bumping a skill's `version` registers only that version —
the line `skills  1 registered, 4 already in the registry` is what the command
prints. Editing a skill's content WITHOUT bumping the `version` is the case
`import` refuses, before it sends the graph: one version cannot name two
contents.

And from the registered graph to work in motion, a fourth command:

```bash
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cartografo-runner --project 1 \
    --working-dir ~/proj --worktrees-root ~/proj-worktrees              # 4 (another terminal)
```

Step 4 brings up a runner: it pairs with the control plane, prints the line
`cartografo.runner.ready` and, from there, asks for released work, takes the
lease and dispatches an agent session for every job it picks up — one tick every
`--interval-ms` (default 2000), until a SIGINT or SIGTERM, which waits for the
session in flight to finish before leaving. One engine per process
(`--engine claude-code|codex`, default `claude-code`), and it is that engine's
CLI, already installed and authenticated on the machine, that actually runs.

Every session works in a `git worktree` of its own, on a `ticket-<id>` branch:
`--working-dir` is the repository that worktree is cut from (default: the current
directory) and `--worktrees-root` is where it is created. The second is
**mandatory and has no default** — where a session may write is the operator's
decision, never the code's guess — and it has to be a **sibling** of the first,
never a directory inside it: a worktree created inside the repository it came
from shows up as untracked content in that repository's `git status`. Without the
flag, or with the two overlapping, the command exits 2 with one line, before it
talks to the control plane. `npx cartografo-runner --help` lists the rest.

A session that ends clean has its worktree removed; a session that fails, runs
out of clock or is cancelled has its own **retained**, because it is the only
place what it did still exists — and since t207 a session that ends well but
leaves **uncommitted** work also retains the tree and **blocks the job** with its
path in the reason, instead of deleting in silence. That piles up directories and
branches, and what collects them is `prune`:

```bash
npx cartografo-runner prune --working-dir ~/proj \
  --worktrees-root ~/proj-worktrees --dry-run     # lists what it would collect
npx cartografo-runner prune --working-dir ~/proj \
  --worktrees-root ~/proj-worktrees               # collects for real
```

It sweeps two sources — the `ticket-<id>-<hex>` directories under
`--worktrees-root` that `git worktree list` recognizes, and the repository's
`ticket-<id>` branches — and asks the control plane, job by job, whether it is
**finished**. Only what is finished is collected: `bloqueado` is not a terminal
state (an unblocked job carries on from the same node, with a fresh tree). The
branch goes with `git branch -d`, **never `-D`** — finished means the traversal
reached a final node of the graph, which says nothing about the commits having
been merged; an unmerged branch is refused, reported, and does not change the
exit code. `--older-than <days>` narrows the collection to what has been sitting
still for that long, and any directory the command does not recognize is reported
and never touched. `npx cartografo-runner prune --help` lists the rest.

The other two subcommands of `cartografo`, for checking and for taking the graph
away:

```bash
npx cartografo status                                   # server and registered projects
npx cartografo status --json                            # the same, for a script
npx cartografo export software-development              # writes ./software-development.grafo.json
```

The file `export` writes is the same document `import` takes back: importing it
into another control plane produces the same `graph_version.id`, because the id
of a version is the canonical hash of the document. `npx cartografo --help` lists
everything.

After a round, for the cost lens to read its telemetry:

```bash
CARTOGRAFO_TOKEN=<the token from step 2> \
  npx cost-surveyor evaluate --url http://127.0.0.1:4317 \
    --execution 7 --token-cap 200000
```

`cost-surveyor` is a surveyor: it reads that execution's sessions and jobs
through the public API, aggregates cost per `(graph version, node)` and
**deposits a pending proposal** per candidate — it never applies any, because
applying is a human decision at the gate (principle 5). Without `--token-cap` or
`--second-cap` the cap policy does not run: there is nothing to exceed.
`npx cost-surveyor --help` lists the rest.

And, so that nobody has to type the id of every round, an observer that does it
on its own:

```bash
npx cartografo-surveyor watch --url http://127.0.0.1:4317 --token <the token from step 2>
```

It subscribes to the event stream, waits for the control plane to declare an
execution finished and runs **both** lenses over it — the flow one (a real agent
session, a semantic diff) and the cost one (a deterministic aggregation) —,
writing one JSON line per outcome: `posted`, `deduped`, `nothing` or `error`.
`--lens flow|cost` runs only one of them; `--dry-run` says what it would run and
spends nothing. Running twice over the same execution does not duplicate a
proposal: the one that deduplicates is the control plane, by `(lens, target
version, operations)`.

What it does **not** do: apply. Everything is still born `pending` and still
waits for you at the gate (principle 5) — what became automatic is proposing, not
deciding. It also does not switch itself on: there is no service, cron or startup
step that brings it up, and switching it on is the operator's decision
([D21](DECISIONS.md)).

And, to see what is going on:

```bash
npx cartografo-screen                                     # http://127.0.0.1:4318
```

One command, the two halves of the screen D11 asks for. At `/`, the **proposal
inbox**: the semantic diff, the evidence and the four decisions
([`docs/spec/screen-proposal-inbox.md`](docs/spec/screen-proposal-inbox.md)). At
`/board`, the **minimal observability**: the job board grouped by node, the
executions, the sessions, the queue of pending questions — with an inline answer
that really writes through the API — and the timeline of any job, split into
queueing, agent working and waiting on a human
([`docs/spec/screen.md`](docs/spec/screen.md)).

Both are ordinary clients of the public API, with no privilege at all over the
control plane: another process, another port, no access to the database.

Configuration: `CARTOGRAFO_PORT`, `CARTOGRAFO_DB_PATH` and `CARTOGRAFO_HOST` at
startup — the last one decides the listening address, and the default is still
`127.0.0.1`, because opening the port to the network is the operator's decision,
not the command's; `CARTOGRAFO_LOG_LEVEL` (default `info`, values `trace`,
`debug`, `info`, `warn`, `error`, `fatal`, `silent`) for the level of the control
plane's JSON log — it is through it that the dispatchers' tick failures and the
unexpected 500s come out, whose answer to the client says no more than `{error,
message, request_id}`: `request_id` is the `reqId` of the matching log line, and
it is what ties a support report to what actually broke; there is no per-request
log, on purpose; `CARTOGRAFO_LEASE_CAP_RUNNER` and `CARTOGRAFO_LEASE_CAP_PROJECT`
(default 50 each) for the cap on simultaneous leases the server imposes — the
runner declares the cap it wants in `--declared-runner-cap` and the SMALLER of
the two wins, because the one that decides concurrency is the control plane, not
the request (D1); that declared number does not change what one runner process
does, which is to dispatch **one session per tick**, whatever the value: more
throughput is more runner processes under the same project; `CARTOGRAFO_URL` (or
`--url`) to point the other subcommands — and the screen, and the runner — at a
control plane that is not at the default `http://127.0.0.1:4317`;
`CARTOGRAFO_TOKEN` (or `--token`) for the credential the subcommands and the
runner present; `CARTOGRAFO_SCREEN_PORT` to change the screen's port and
`CARTOGRAFO_SCREEN_TOKEN` to give the screen a credential of its own — without it,
the screen uses the one in `CARTOGRAFO_TOKEN`. The screen presents that
credential to the control plane on every call and asks the browser for none: it
is an unprivileged client of the API (D11), and that is why it listens on
loopback.

## The hole it fills

Today there are two modes of graph engineering: drawing the topology by hand,
case by case (LangGraph and the like), or fixing a single graph per domain
(flowpilot, for software delivery). The middle layer is missing: a system that
**generates and evolves** graphs per problem class, with the same governance the
fixed graph offers.

## Principles (recorded from the founding conversation)

1. **Fixed meta-process, dynamic object-graph.** The topology generator is an
   agent, which is to say a worker that makes mistakes. If the graph that governs
   the work were produced by an ungoverned worker, the meta-layer would
   reintroduce the very problem the graph solves. That is why the pipeline
   declare → query capabilities → synthesize → **validate the graph** → execute →
   evaluate → propose mutation is fixed; what varies is what it produces per
   problem class. The analogy: a compiler. The problem declaration compiles to a
   topology; the compiler does not change with every program.
2. **Dynamic between executions, frozen during them.** A node does not freely
   pick a path at run time (that would be a loop with decorations, with neither
   reproducibility nor an audit trail). Synthesize → freeze → traverse → learn
   from the log → mutate the next version. A versioned graph, with a diff between
   rounds.
3. **The contract is the load-bearing piece.** Every capability declares its
   input, its output, its preconditions and how what it produces is verified.
   With no contract, the synthesizer composes by hallucination; with a contract,
   composing a graph becomes matching contracts. (MCP is already halfway there: a
   tool with a schema.)
4. **Shared context = explicit state, never a common window.** What is shared is
   the board and the event log; every node receives a projection of the state. A
   common context window recreates the degradation of a long session.
5. **Evolution with a safety ladder.** At first the evaluator only suggests; the
   change goes through a human gate; with accumulated history, low-risk mutations
   auto-apply with rollback. The human is on the execution's exceptions and at
   the mutation gate, to begin with.
6. **An honest limit: verification density.** The framework adapts to any problem
   where the contract of each step can be written down. Where no intermediate
   verification is possible, there is no gate; with no gate, the graph is
   decorative. The ceiling is verification density, not intelligence.

## Pieces

- **Capability registry** — skills with a contract (input, output,
  preconditions, verification method).
- **Topology synthesizer** — from the declared problem to the proposed graph.
- **Graph validation gate** — the graph is an artifact with a contract; somebody
  checks it before it runs.
- **Executor** — traversal with gates, queues, escalation to a human.
- **Evaluator (surveyor)** — process mining over the log; mutation proposals.
- **Process memory** — graphs versioned per problem class.

## Lineage and neighbours

ADAS (automated search of agentic designs), DSPy (pipeline optimization from
metrics), process mining (van der Aalst), LangGraph (authored topology per use
case), flowpilot (a fixed graph per domain — the first instance). What sets this
idea apart: **a persistent graph per problem class that evolves between rounds** —
a team's retrospective turning into code.

## Starting condition (the ceiling rule)

Do not build the meta-layer a priori. Generalization is extracted from instances:
start with fixed graphs working in different domains. Decided (D14): two
instances — software development (the ported flowpilot graph) and asymmetric bets
(an investment thesis) — delivered as factory graphs, ready to use.

## Cheap prototype

Claude Code's primitives are already half the framework: skills with a
description = a capability registry; workflow scripts = frozen graphs; session
logs = an event log. The synthesizer would be an agent that writes workflow
scripts. Testable in a weekend, before deciding whether it becomes a product, an
article or both.

## The name

`cartografo`: the one who draws a map per territory — one graph per problem
class, redrawn as the territory is explored. Also considered: `topografo` (kept
for the evaluator, which measures the ground), `graphsmith` (EN).

## The plan

Make it work → validate it on D14's two instances (software and asymmetric bets)
→ publish an article in the newsletter with the repository public (only once it
is ready), as a lever for subscribers. The public README will carry the
invitation to follow agentsmaestro.dev. Decisions in
[DECISIONS.md](./DECISIONS.md); notes in `notes/`.
