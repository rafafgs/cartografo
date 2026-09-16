# Specification: the command line

**API version consumed:** `v1` · **Package:** [`packages/core`](../../packages/core)
**Command:** `cartografo` (`npx cartografo`) · **Router:** [`packages/core/src/cli/index.ts`](../../packages/core/src/cli/index.ts)
**Founding decisions:** [D23](../../DECISIONS.md) — "one command brings the
product up" · [D26](../../DECISIONS.md) — "the CLI and the MCP server are the
complete operating surface; the screen retires once they reach parity"

The CLI is the operator's surface. Everything the screen used to be the only way
to do — read the board, answer a question, stop a job, decide a proposal, edit a
graph, hold an interview — is a subcommand here, and the screen's four
specifications ([`screen.md`](screen.md),
[`screen-proposal-inbox.md`](screen-proposal-inbox.md),
[`screen-graph-editor.md`](screen-graph-editor.md),
[`screen-interview.md`](screen-interview.md)) point at this document and at
[`mcp-server.md`](mcp-server.md) as their successors. Where a screen requirement
did not survive the move, §6 says why; where it has no terminal form yet, §7
says so.

The boundary is D11's, unchanged: **every subcommand except `up` is an HTTP
client of the public API.** None of them opens the database or imports
`src/db/**`; what they know about the control plane fits in
[`cli/url.ts`](../../packages/core/src/cli/url.ts) (`--url`/`CARTOGRAFO_URL`,
`--token`/`CARTOGRAFO_TOKEN`). `up` is the one that starts processes.

`--project <id|name>` scopes every subcommand whose routes are project-scoped
(default `1`; a name is resolved against `GET /v1/projects`). It is accepted but
inert on `answer`, `block`, `unblock` and `runners recheck`, none of whose routes
are scoped.

---

## 1. The subcommands

One row per subcommand the router dispatches — `API_SUBCOMMANDS` in
[`index.ts`](../../packages/core/src/cli/index.ts), plus `up`. A subcommand with
verbs (`job create`, `proposals approve`) is one row that names them all. Pinned
both ways by
[`packages/core/test/cli-spec-routes.test.ts`](../../packages/core/test/cli-spec-routes.test.ts).

| Subcommand | What it does | Control-plane route(s) | `--json` |
|---|---|---|---|
| `up [--no-browser] [--no-runner] [--no-screen]` | Brings the product up: the control plane (database, migrations, HTTP), the screen and one local runner, and opens the browser on the screen. The default when no subcommand is given. `--no-screen --no-browser` is the whole product with no browser at all. | None — it starts the control plane itself. | no |
| `import <path>` | Registers a graph file, or a bundle directory with `graph.json` and `skills/`, as a new base lineage; manifests first, the graph only after every one was accepted. | `POST /v1/skills`, `POST /v1/graphs` | no |
| `export <class>` | Writes the current version of a class to a file `import` accepts back. | `GET /v1/graphs/:id`, `GET /v1/graph-versions/:id` | no |
| `export-history --job <id> \| --execution <id>` | Writes a job's or a round's whole history as JSON Lines: a header with the map version, then every event in id order. | `GET /v1/jobs/:id` or `GET /v1/executions/:id` and `GET /v1/jobs?execution_id=`, `GET /v1/sessions`, `GET /v1/input-requests`, `GET /v1/graph-versions/:id`, `GET /v1/graphs/:id`, `GET /v1/projects` | no |
| `status` | The server, the registered classes, the projects, and the counts of jobs and pending questions. | `GET /health`, `GET /v1/classes`, `GET /v1/projects`, `GET /v1/jobs`, `GET /v1/input-requests?status=pending` | yes |
| `jobs [--state <state>] [--execution <id>]` | The board: every job with its derived state; `--state` filters client-side on the six words (`awaiting_you`, `blocked_unasked`, `running`, `unowned`, `completed`, `queued`). | `GET /v1/jobs` | yes |
| `job <id>` · `job create --graph <version-id> --input <file> [--execution <id>]` | `job <id>`: one job's timeline in the three buckets (queue, agent working, human being asked) with its totals, artifacts and sessions. `job create`: opens a job on a graph version from a JSON file of its fields. | `job <id>`: `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events`, `GET /v1/sessions?job_id=`, `GET /v1/input-requests?job_id=`, `GET /v1/jobs/:id/artifacts`. `job create`: `POST /v1/jobs` | yes |
| `executions` | The rounds: jobs, blocked jobs and pending questions per round. | `GET /v1/executions` | yes |
| `execution <id>` | One round's jobs, sessions and pending questions. Never a 404 — an execution is not an entity. | `GET /v1/jobs?execution_id=`, `GET /v1/sessions?execution_id=`, `GET /v1/input-requests?execution_id=&status=pending` | yes |
| `sessions [--job <id>] [--execution <id>]` | Lists sessions, optionally for one job or one round. | `GET /v1/sessions` | yes |
| `transcript <session-id> [--tail N]` | A session's decoded transcript, its failed line (a non-zero exit code) marked with `>>> `, and a cut declared when the stored transcript overflowed. | `GET /v1/sessions/:id/log` | yes |
| `input-requests [--status <status>]` | The escalation inbox, every question whole; `--status` defaults to `pending`. | `GET /v1/input-requests` | yes |
| `watch [--job <id>] [--execution <id>] [--since <id> \| --from-start] [--until-done]` | Tails the event stream, reconnecting forever past the first connection; `--until-done` exits `0` the moment the named job or round finishes. | `GET /v1/events/stream`, `GET /v1/jobs/:id` | yes (JSON Lines) |
| `examples` | The bundles this control plane can demonstrate, and whether this project already registered each one. | `GET /v1/examples` | yes |
| `example run <class>` | Registers the bundle if the project has never seen the class, then opens its demo job in a fresh round. | `POST /v1/examples/:class/run` | yes |
| `runners` · `runners recheck <runner-id>` | `runners`: the fleet, and whether each runner is ready to pick work up — the check page's four lines (engine, credential, MCP server, workspace), per runner. `runners recheck`: asks one runner to report about its machine again. | `runners`: `GET /v1/runners`, `GET /v1/settings`. `runners recheck`: `POST /v1/runners/:id/rechecks` | yes |
| `answer <request-id> (<text> \| --file <path>) [--by <name>]` | Answers a pending question; the control plane unblocks the job in the same transaction. | `PATCH /v1/input-requests/:id/answer` | yes |
| `block <job-id> --reason <text> [--by <name>]` | Raises a job's blocked flag. | `POST /v1/jobs/:id/blocks` | yes |
| `unblock <job-id> [--note <text>] [--by <name>]` | Lowers a job's blocked flag. | `POST /v1/jobs/:id/unblocks` | yes |
| `settings [get]` · `settings set <key> <value>` | Reads, or writes one of, the project's recorded defaults; the key is checked locally before any request. | `GET /v1/settings`, `PATCH /v1/settings` | yes |
| `interview [--resume <id>] [--answers <file>] [--by <name>]` | Draws a map by conversation in the terminal: a title and a description, then every question as it arrives (a number or text for a decision, one prompt per field for a form), printing the map and its step progress as it grows. When it is finished: `register`, `export <dir>`, or Enter to leave it as a draft. | `GET /v1/graphs/map-design`, `POST /v1/jobs`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/conversation`, `GET /v1/jobs/:id/events`, `GET /v1/events/stream`, `PATCH /v1/input-requests/:id/answer`, `POST /v1/skills`, `POST /v1/graphs` | no |
| `proposals list\|show\|approve\|apply\|reject\|revert` | The proposal inbox: `list` groups into PENDING/HISTORY unless `--status` is given; `show` prints the semantic diff one line per operation; `approve`/`apply` take no reason; `reject`/`revert` require `--reason`, checked before any request. | `GET /v1/proposals`, `GET /v1/proposals/:id`, `POST /v1/proposals/:id/{approve,apply,reject,revert}` | yes |
| `graph propose\|versions\|show` | The graph editor, with the graph as a file: `propose` diffs a file against the lineage's current version and creates, approves and applies the proposal (`--dry-run` runs the soundness gate locally and sends nothing; `--no-apply` leaves it pending); a refusal is printed one line per structure error and per soundness rule with its target. `versions` lists the chain; `show` prints a version. | `GET /v1/graphs/:id`, `GET /v1/graph-versions/:id`, `GET /v1/graphs/:id/versions`, `POST /v1/proposals`, `POST /v1/proposals/:id/approve`, `POST /v1/proposals/:id/apply` | yes |
| `scan-skill <path>` | Derives a draft manifest from the `SKILL.md` of a local checkout (step 1 of the D4 import gate). | `GET /v1/skills` | no |
| `propose-skill <file>` | Opens the human approval for a completed manifest and blocks a job on it (step 2). | `POST /v1/jobs`, `POST /v1/input-requests` | no |
| `register-skill --job <id>` | Sends what the human approved to the registry, which verifies it again (step 3). | `GET /v1/input-requests?job_id=`, `POST /v1/skills` | no |

---

## 2. Exit codes

One convention for every subcommand, verbatim from the router's own header
comment:

- `0` — the command did what it promised;
- `1` — the command ran and the result was negative (server down, graph
  refused, unknown class);
- `2` — the command line is wrong (nonexistent subcommand, missing argument).

A refusal the CLI can see coming — a missing `--reason`, a key `settings set`
does not know, `--dry-run` combined with `--no-apply` — is a `2` before any
request leaves.

---

## 3. The `--json` contract

The subcommands marked **yes** in §1 print machine-readable JSON instead of the
human table or card. The shape is the API's, never a second format invented
here: a subcommand that makes one call prints that route's own body untouched;
a subcommand that aggregates several calls into one report (`job <id>`,
`execution <id>`) prints a declared object whose keys are those untouched
bodies, since there is no single route for the aggregate to mirror (t542, t544).
`watch --json` prints JSON Lines, one whole event envelope per line.

The subcommands marked **no** either write a file (`export`, `export-history`),
hold a conversation (`interview`), start processes (`up`) or belong to the D4
import gate, whose output is a human's to read.

---

## 4. The actor rule

Every write says who made it, and that is never left to the control plane to
guess. An absent `actor` becomes the API's own identity — "the control plane",
not a person — so the CLI always sends one:

- `answer`, `block`, `unblock` and `interview` record `--by`, else the OS user,
  else the literal `"operator"`;
- `proposals approve/apply/reject/revert` and `graph propose` record `--by`, else
  the OS user (`USER`/`USERNAME` as a fallback), and refuse with a usage error
  when no name can be resolved at all — a proposal decision is the human gate,
  and it is not recorded against a placeholder;
- the actor is always `{type: "user", ref: <name>}`. A model acting through the
  MCP server is recorded as `agent` instead ([`mcp-server.md`](mcp-server.md)
  §2), which is the one distinction the event log keeps about whether a person
  was at the gate.

This is the terminal's mirror of the screen's fallbacks (`respondido_por` and
`actor_ref` falling back to `"tela"`, [`screen.md`](screen.md) §3): the screen
recorded the door the write came in through because it carried one service
credential and asked the browser for no name; a terminal has a user, so the CLI
records that user.

---

## 5. What moved from the screen

Every numbered section of the four screen specifications, and where its
requirements live now. The buckets are: a row of §1 above, a tool of
[`mcp-server.md`](mcp-server.md) §1, §6 (dropped), or §7 (known gaps).

### [`screen.md`](screen.md)

| Section | Bucket | Where |
|---|---|---|
| §1 The twenty-four routes — `GET /` (the check) | §1 | `runners` |
| §1 — `GET /board` | §1 | `jobs` (the map-position line is §7) |
| §1 — `GET /examples`, `POST /examples/:id/run` | §1 | `examples`, `example run` |
| §1 — `GET /executions`, `GET /executions/:id` | §1 | `executions`, `execution` |
| §1 — `GET /input-requests`, `POST /input-requests/:id/answer` | §1 | `input-requests`, `answer` |
| §1 — `GET /runners`, `POST /runners/:id/rechecks` | §1 | `runners`, `runners recheck` |
| §1 — `POST /jobs/:id/block`, `POST /jobs/:id/unblock` | §1 | `block`, `unblock` |
| §1 — `GET /jobs/:id` | §1 | `job <id>` |
| §1 — `GET /sessions/:id/log` | §1 | `transcript` |
| §1 — `POST /settings` | §1 | `settings set` |
| §1 — `POST /project` | §6 | superseded by `--project` |
| §1 — `GET /interview`, `POST /interview`, `GET /interview/:id`, `POST /interview/:id/answer`, `/register`, `/export` | §1 | `interview` (the still-open list is §7) |
| §1 — `GET /interview/:id/fragment` | §6 | the page's poll |
| §1 — `GET /graphs/:id` | §1 | `graph show` |
| §1 "The package has two halves, and one port" | §6 | the `/v1/*` proxy and the static half |
| §1 "What the proxy refuses" | §6 | fetch-metadata gate |
| §2 The rule of the three buckets | §1 | `job <id>` |
| §3 Answering is a real write (and "Blocking and unblocking") | §1 | `answer`, `block`, `unblock`; the actor fallbacks are §4 |
| §4 The six API gaps this layer closed | §1 | `executions`, `sessions --job`, `input-requests`, `examples`, `example run` (`POST /v1/graphs/validate`'s screen consumer is §7) |
| §5 Configuration | §1 | every row (`--url`, `--token`), `up` |
| §6 No framework, no build (its design-system and `data-*` subsections) | §6 | HTML renderer |
| §7 What this screen does not do yet | §7 | carried over |

### [`screen-proposal-inbox.md`](screen-proposal-inbox.md)

| Section | Bucket | Where |
|---|---|---|
| §1 The same-origin pattern (and Configuration) | §6 | the `/v1/*` proxy |
| §2 The control plane contract this screen assumes | §1 | `proposals` |
| §3 The two sections, and state → actions | §1 | `proposals list` (PENDING/HISTORY), `proposals approve/apply/reject/revert` (the per-row optimistic update is §6) |
| §4 The diff in prose | §1 | `proposals show` |
| §5 What this screen does not do yet | §7 | carried over |

### [`screen-graph-editor.md`](screen-graph-editor.md)

| Section | Bucket | Where |
|---|---|---|
| §1 What this screen edits | §1 | `graph propose` |
| §2 The control plane contract this screen assumes | §1 | `graph propose` (evidence defaults to `--evidence`'s text) |
| §3 What cannot be changed on a node that already exists | §1 | `graph propose` (refused locally) |
| §4 Saving is three calls, and approval comes chained | §1 | `graph propose` (`--no-apply` stops after the first) |
| §5 The gate's refusal, in prose | §1 | `graph propose`, `--dry-run` |
| §6 No framework, no build — and no `innerHTML` | §6 | HTML renderer, in-browser editing |
| §7 What this screen does not do yet | §7 | carried over |

### [`screen-interview.md`](screen-interview.md)

| Section | Bucket | Where |
|---|---|---|
| §1 Starting one | §1 | `interview` (the still-open list is §7) |
| §2 The page itself | §1 | `interview` (the text being written mid-turn is §7) |
| §3 The poll, and what it may not break | §6 | per-page auto-refresh |
| §3.1 The progress panel | §7 | soundness report mid-interview |
| §4 Answering, registering, exporting | §1 | `interview` |
| §5 The read-only map | §1 | `graph show` |
| §6 When the machine has no server for the step | §7 | MCP-server suggestions |
| §7 What this page does not do yet | §7 | carried over |

---

## 6. Dropped

Requirements with no terminal equivalent, because they are about a browser:

- **The fetch-metadata gate** (`Sec-Fetch-Site`, `Origin`, the browser
  `User-Agent` check — [`screen.md`](screen.md) §1 "What the proxy refuses"). It
  defends a page against another page open in the same browser forging a write
  with the screen's credential. A terminal has no browser and no forged origin;
  the boundary for a local process was always D11's loopback port.
- **The `/v1/*` proxy and the static half** ([`screen.md`](screen.md) §1 "The
  package has two halves", [`screen-proposal-inbox.md`](screen-proposal-inbox.md)
  §1). They exist because a browser cannot talk to the control plane without
  CORS. The CLI talks to it directly.
- **`POST /project`'s cookie switcher** ([`screen.md`](screen.md) §1). Superseded
  rather than lost: every subcommand takes `--project <id|name>` directly.
- **The markup contract**: the `data-*` markers ([`screen.md`](screen.md) §6),
  "no framework, no build" and `innerHTML`/`textContent`
  ([`screen.md`](screen.md) §6, [`screen-proposal-inbox.md`](screen-proposal-inbox.md)
  §1, [`screen-graph-editor.md`](screen-graph-editor.md) §6), the visible
  `<label>` rules. Implementation details of an HTML renderer; there is nothing
  to carry. What survives is the injection concern itself: `interview` strips
  control characters from agent-written text before printing it.
- **The design system's binding** ([`design-system.md`](design-system.md)). It is
  a visual language for rendered pages and does not apply outside one.
- **The two per-page auto-refresh mechanisms** — `/board`'s 30-second
  `<meta refresh>` ([`screen.md`](screen.md) §1, §7) and `/interview/:id`'s
  three-second fragment poll ([`screen-interview.md`](screen-interview.md) §3,
  and `GET /interview/:id/fragment` with it). Superseded, not ported: `watch`
  (and `watch --until-done`) is the generic "tell me when it moves", and
  `interview` waits on the event stream between turns.
- **The graph editor's live in-browser editing** — the card-per-node form, the
  contract kept as text until `Save`, and the draggable canvas it declined
  ([`screen-graph-editor.md`](screen-graph-editor.md) §6, §7). `graph propose`
  treats the graph as a file in the operator's own editor, which is the terminal
  form of "no canvas".
- **The inbox's per-row update with no reload**
  ([`screen-proposal-inbox.md`](screen-proposal-inbox.md) §3). A command finishes
  and exits; there is no page to leave stale.

---

## 7. Known gaps

Requirements that make sense outside a browser and have no CLI form yet. Each
names who it is left to.

- **MCP-server suggestions for a step** ([`screen-interview.md`](screen-interview.md)
  §6). When a turn writes `NEEDS_MCP_SERVER: <capability>`, the page offers up
  to three candidates from the public registry
  ([`mcp-catalog.ts`](../../packages/screen/src/mcp-catalog.ts)'s
  `officialRegistry()`/`cachedCatalog()`), each with its add command.
  `interview` prints the question's context, hint line included, and offers no
  candidates. A terminal could print the same suggestions; nothing in
  `packages/core/src/cli` does yet. Left to a future ticket; t548 documents it
  and does not build it.
- **The progress panel mid-interview** ([`screen-interview.md`](screen-interview.md)
  §3.1). The page asks `POST /v1/graphs/validate` what registering the draft
  would still fail on; `interview` prints the map and a step count
  (`step N of M · K still to define`) but not the gate's report. The refusal
  still reaches the operator at `register`. Left to a future ticket.
- **The text a step is writing mid-turn** ([`screen-interview.md`](screen-interview.md)
  §2, `conversation.partial`). `interview` waits silently between questions.
  Left to a future ticket.
- **The list of interviews still open** ([`screen-interview.md`](screen-interview.md)
  §1). `jobs` lists every job, and `interview --resume <id>` picks one up, but
  nothing filters to the jobs whose `entry_node_id` is `interview`. Left to a
  future ticket.
- **The board's map position** ([`screen.md`](screen.md) §1, t463's
  `step N/M · <role>` line). `jobs` and `job <id>` show the raw current node.
  Left to a future ticket.
- **The screen specs' own "not yet" lists** ([`screen.md`](screen.md) §7,
  [`screen-proposal-inbox.md`](screen-proposal-inbox.md) §5,
  [`screen-graph-editor.md`](screen-graph-editor.md) §7,
  [`screen-interview.md`](screen-interview.md) §7) carry over unchanged where
  they are not about a browser: per-node execution policies, editing a skill
  manifest's content, variant lineages in the editor (`graph propose --graph
  <variant-id>` does reach them), editing `initial_node`/`final_nodes`/`metadata`,
  pagination, a runner liveness signal beyond leases, a second MCP catalogue.
  Each stays the declared scope of the ticket those lists already name.
