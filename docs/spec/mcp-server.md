# Specification: the MCP server

**API version consumed:** `v1` · **Package:** [`packages/mcp`](../../packages/mcp)
**Command:** `cartografo-mcp` (`npx cartografo-mcp`, started by an MCP client over stdio) ·
**Catalogue:** [`packages/mcp/src/tools.ts`](../../packages/mcp/src/tools.ts)
**Founding decision:** [D26](../../DECISIONS.md) — "the CLI and the MCP server
are the complete operating surface; the screen retires once they reach parity"

The MCP server is the same map for a model instead of a person. It is one more
client of the public API (D11): it declares no SQLite driver, imports nothing
from `packages/core` and holds nothing but the control plane's address and
credential (`CARTOGRAFO_URL`, `CARTOGRAFO_TOKEN`), pinned by
[`packages/mcp/test/no-privileged-access.test.ts`](../../packages/mcp/test/no-privileged-access.test.ts).

Together with [`cli.md`](cli.md) it is the successor of the screen's four
specifications ([`screen.md`](screen.md),
[`screen-proposal-inbox.md`](screen-proposal-inbox.md),
[`screen-graph-editor.md`](screen-graph-editor.md),
[`screen-interview.md`](screen-interview.md)). It is deliberately the narrower
of the two: §2's three exclusions are the CLI's alone, so a screen requirement
that lands on one of them points at `cli.md` rather than at a tool here.

Every read tool takes `project_id` (default `1`) where its routes are
project-scoped; `cartografo_list_runners`' fleet and `cartografo_list_proposals`
read across every project, because their routes are not scoped.

---

## 1. The tool catalogue

One row per entry of `TOOLS`, the catalogue `tools/list` answers: fifteen reads
and nine writes. Pinned both ways by
[`packages/mcp/test/spec-catalogue.test.ts`](../../packages/mcp/test/spec-catalogue.test.ts).
"Narrowed by" names what shapes the answer before it travels (§3); "as read" is
a small wire body passed through whole.

| Tool | Reads or writes | Control-plane route(s) | Narrowed by |
|---|---|---|---|
| `cartografo_status` | Reads whether the control plane is up and what it holds: classes, runners, executions, job counts (total, blocked, completed), pending questions and pending proposals. | `GET /health`, `GET /v1/classes`, `GET /v1/runners`, `GET /v1/executions`, `GET /v1/jobs`, `GET /v1/input-requests?status=pending`, `GET /v1/proposals?status=pending` | a fixed projection in the tool itself |
| `cartografo_list_graphs` | Reads the registered classes and every lineage, base and variant. | `GET /v1/classes`, `GET /v1/graphs` | as read |
| `cartografo_describe_graph` | Reads one graph version — by `version_id`, `graph_id` or `class` — as nodes, edges, initial and final nodes and the contract gate's verdict. | `GET /v1/classes` or `GET /v1/graphs`, `GET /v1/graph-versions/:id` | `versionDigest` (nodes through `nodeDigest`) |
| `cartografo_list_skills` | Reads the skill registry, optionally one lineage, optionally with contracts. | `GET /v1/skills` | `skillDigest` |
| `cartografo_list_jobs` | Reads the board: every job with its node, blocked flag, reason and derived state. | `GET /v1/jobs` | `jobDigest` |
| `cartografo_get_job` | Reads one job: the job, its sessions, its questions and (by default) its event timeline. | `GET /v1/jobs/:id`, `GET /v1/sessions?job_id=`, `GET /v1/input-requests?job_id=`, `GET /v1/jobs/:id/events` | `clipStrings`, `sessionDigest`, `inputRequestDigest`, `eventDigest` |
| `cartografo_list_executions` | Reads the rounds with their job, blocked-job and pending-question counts. | `GET /v1/executions` | as read |
| `cartografo_list_sessions` | Reads sessions, optionally for one job or one round. | `GET /v1/sessions` | `sessionDigest` |
| `cartografo_read_transcript` | Reads a slice of one session's transcript, from the start or the end, declaring both the stored cut and its own. | `GET /v1/sessions/:id/transcript` | `TRANSCRIPT_DEFAULT_CHARS`/`TRANSCRIPT_MAX_CHARS` slice |
| `cartografo_list_input_requests` | Reads the escalation inbox, by status, job or round. | `GET /v1/input-requests` | `inputRequestDigest` |
| `cartografo_list_proposals` | Reads the surveyor's proposals with their lens, expected metric and operations summarised one line each. Reading only (§2). | `GET /v1/proposals` | `proposalDigest` |
| `cartografo_list_runners` | Reads the fleet the way the check page draws it: each runner's engine, credential, MCP-server and workspace verdicts, or the pairing command when none is paired. | `GET /v1/runners`, `GET /v1/settings` | `runnerLines`, `pairingCommand` |
| `cartografo_get_settings` | Reads the project's recorded defaults. | `GET /v1/settings` | as read |
| `cartografo_list_examples` | Reads the demonstrable bundles and whether each is registered. | `GET /v1/examples` | as read |
| `cartografo_get_interview` | Reads an interview through the conversation projection: closed turns, the pending question, whether a step is thinking and what it has written so far, the draft map, whether it is done. | `GET /v1/jobs/:id/conversation` | `conversationDigest` |
| `cartografo_create_job` | Writes a job on a class's version in force or an exact version. | `GET /v1/classes` or `GET /v1/graph-versions/:id`, `POST /v1/jobs` | `jobDigest` |
| `cartografo_answer_input_request` | Writes an answer to a pending question, which unblocks the job waiting on it. | `PATCH /v1/input-requests/:id/answer` | `inputRequestDigest` |
| `cartografo_block_job` | Writes a job's blocked flag, with a reason. | `POST /v1/jobs/:id/blocks` | `jobDigest` |
| `cartografo_unblock_job` | Lowers a job's blocked flag. | `POST /v1/jobs/:id/unblocks` | `jobDigest` |
| `cartografo_register_graph` | Writes a graph document as a new class through the registration gate; registers no skills. | `POST /v1/graphs` | `clipStrings` |
| `cartografo_request_runner_recheck` | Asks one runner to report about its machine again; starts nothing and waits for nothing. | `POST /v1/runners/:id/rechecks` | as read |
| `cartografo_update_settings` | Writes one or more of `workspace_root`, `worktrees_root`, `engine`, `allow_git_clone`. | `PATCH /v1/settings` | as read |
| `cartografo_run_example` | Registers a bundle if the project has never seen it, then opens its demo job. | `POST /v1/examples/:class/run` | `jobDigest` |
| `cartografo_start_interview` | Writes an interview: a job on `map-design`'s version in force, entered at `interview`. | `GET /v1/classes`, `GET /v1/graph-versions/:id`, `POST /v1/jobs` | `jobDigest` |

---

## 2. What this server cannot do, and who a write says it is

Verbatim from the catalogue's own header comment
([`tools.ts`](../../packages/mcp/src/tools.ts), lines 1–45), the three
exclusions:

- **Nothing decides a proposal.** `approve`, `apply`, `reject` and `revert` are
  absent, and their absence IS principle 5 (README): the surveyor's proposals
  wait for a human at the gate. A tool that let the same model that ran the
  surveyor approve the surveyor's own proposal would close the learning loop
  with no judge outside it, which is the one thing the loop is for. Reading a
  proposal is here; deciding it is the CLI's (`cartografo proposals
  approve/apply/reject/revert`, README.md).
- **Nothing transitions a job.** `POST /v1/jobs/:id/transitions` is the runner's
  traversal, written as it happens. Walking a job across the graph by hand from
  a chat window would leave the log saying that work happened at a node where
  none did — and the log is what the surveyor reads to propose the next version.
  `blocks`/`unblocks` ARE here, because stopping and resuming a job is an
  operator's fact about an operator's decision.
- Also absent, for a different reason: **anything that starts or stops a
  process.** The control plane, the runner and the surveyor are long-lived
  commands an operator brings up (D21), and a request/response tool is the wrong
  shape for them even where it would be safe.

The same boundary rules out editing a graph through a proposal: that is the
first exclusion seen from the editor's side, and it is `cartografo graph
propose` at the terminal ([`cli.md`](cli.md) §1).

**A write says who wrote it.** `DEFAULT_ACTOR` is `{type: "agent", ref: "mcp"}`
(`tools.ts`, line 68), and every write route this server reaches carries it.
`cartografo_answer_input_request`'s `answered_by` defaults to `"mcp"`
(`DEFAULT_ANSWERED_BY`) and names a person only when a person actually decided.
The event log distinguishes `user`, `agent` and `system`; recording a model as a
person would corrupt the one record that says whether the human was at the
gate. The CLI's side of the same rule is [`cli.md`](cli.md) §4.

---

## 3. Digest limits

What travels back to a model is a projection, never the wire body pasted back:

| Constant | Value | What it bounds |
|---|---|---|
| `CLIP_CHARS` | `600` | Any single string inside a digest, before the clip marker. |
| `TRANSCRIPT_DEFAULT_CHARS` | `4000` | The transcript slice `cartografo_read_transcript` returns when the call asks for no size. |
| `TRANSCRIPT_MAX_CHARS` | `200000` | The ceiling on that slice, whatever the call asks for. |

**A clip is always declared in the text, never silent.** `clipStrings` replaces
the tail of a long string with `…(+N chars)`, naming how much went.
`cartografo_read_transcript` reports two different cuts as two different
fields: `stored_truncated`/`stored_original_size` (the control plane's ceiling
on what it stored) and `total_chars`/`returned_chars`/`returned_from` (this
tool's slice of what was stored).

---

## 4. What moved from the screen

Every numbered section of the four screen specifications, and where its
requirements live now. The buckets are: a row of §1 above, a row of
[`cli.md`](cli.md) §1, §5 (dropped), or §6 (known gaps).

### [`screen.md`](screen.md)

| Section | Bucket | Where |
|---|---|---|
| §1 The twenty-four routes — `GET /` (the check) | §1 | `cartografo_list_runners`, `cartografo_get_settings` |
| §1 — `GET /board` | §1 | `cartografo_list_jobs` (the map-position line is §6) |
| §1 — `GET /examples`, `POST /examples/:id/run` | §1 | `cartografo_list_examples`, `cartografo_run_example` |
| §1 — `GET /executions`, `GET /executions/:id` | §1 | `cartografo_list_executions`, `cartografo_list_jobs`/`cartografo_list_sessions`/`cartografo_list_input_requests` with `execution_id` |
| §1 — `GET /input-requests`, `POST /input-requests/:id/answer` | §1 | `cartografo_list_input_requests`, `cartografo_answer_input_request` |
| §1 — `GET /runners`, `POST /runners/:id/rechecks` | §1 | `cartografo_list_runners`, `cartografo_request_runner_recheck` |
| §1 — `POST /jobs/:id/block`, `POST /jobs/:id/unblock` | §1 | `cartografo_block_job`, `cartografo_unblock_job` |
| §1 — `GET /jobs/:id` | §1 | `cartografo_get_job` |
| §1 — `GET /sessions/:id/log` | §1 | `cartografo_read_transcript` |
| §1 — `POST /settings` | §1 | `cartografo_update_settings` |
| §1 — `POST /project` | §5 | superseded by `project_id` |
| §1 — `GET /interview`, `POST /interview`, `GET /interview/:id`, `POST /interview/:id/answer` | §1 | `cartografo_start_interview`, `cartografo_get_interview`, `cartografo_answer_input_request` |
| §1 — `POST /interview/:id/register`, `POST /interview/:id/export` | `cli.md` §1 | `interview` (`register`, `export <dir>`) |
| §1 — `GET /interview/:id/fragment` | §5 | the page's poll |
| §1 — `GET /graphs/:id` | §1 | `cartografo_describe_graph` |
| §1 "The package has two halves, and one port" | §5 | the `/v1/*` proxy and the static half |
| §1 "What the proxy refuses" | §5 | fetch-metadata gate |
| §2 The rule of the three buckets | `cli.md` §1 | `job <id>` (`cartografo_get_job` returns the raw timeline, not the buckets) |
| §3 Answering is a real write (and "Blocking and unblocking") | §1 | `cartografo_answer_input_request`, `cartografo_block_job`, `cartografo_unblock_job`; the actor is §2 |
| §4 The six API gaps this layer closed | §1 | `cartografo_list_executions`, `cartografo_list_sessions`, `cartografo_list_input_requests`, `cartografo_list_examples`, `cartografo_run_example` (`POST /v1/graphs/validate`'s screen consumer is §6) |
| §5 Configuration | §1 | every tool (`CARTOGRAFO_URL`, `CARTOGRAFO_TOKEN`) |
| §6 No framework, no build (its design-system and `data-*` subsections) | §5 | HTML renderer |
| §7 What this screen does not do yet | §6 | carried over |

### [`screen-proposal-inbox.md`](screen-proposal-inbox.md)

| Section | Bucket | Where |
|---|---|---|
| §1 The same-origin pattern (and Configuration) | §5 | the `/v1/*` proxy |
| §2 The control plane contract this screen assumes | `cli.md` §1 | `proposals` (deciding is excluded here, §2) |
| §3 The two sections, and state → actions | `cli.md` §1 | `proposals list/approve/apply/reject/revert` (the per-row optimistic update is §5) |
| §4 The diff in prose | §1 | `cartografo_list_proposals` (one summary line per operation) |
| §5 What this screen does not do yet | §6 | carried over |

### [`screen-graph-editor.md`](screen-graph-editor.md)

| Section | Bucket | Where |
|---|---|---|
| §1 What this screen edits | `cli.md` §1 | `graph propose` (a proposal, excluded here, §2) |
| §2 The control plane contract this screen assumes | `cli.md` §1 | `graph propose` |
| §3 What cannot be changed on a node that already exists | `cli.md` §1 | `graph propose` |
| §4 Saving is three calls, and approval comes chained | `cli.md` §1 | `graph propose` |
| §5 The gate's refusal, in prose | `cli.md` §1 | `graph propose`, `--dry-run` |
| §6 No framework, no build — and no `innerHTML` | §5 | HTML renderer, in-browser editing |
| §7 What this screen does not do yet | §6 | carried over |

### [`screen-interview.md`](screen-interview.md)

| Section | Bucket | Where |
|---|---|---|
| §1 Starting one | §1 | `cartografo_start_interview` (the still-open list is `cartografo_list_jobs`' `entry_node`) |
| §2 The page itself | §1 | `cartografo_get_interview` (turns, pending, thinking, partial, draft, done) |
| §3 The poll, and what it may not break | §5 | per-page auto-refresh |
| §3.1 The progress panel | §6 | soundness report mid-interview |
| §4 Answering, registering, exporting | `cli.md` §1 | `interview` (answering alone is `cartografo_answer_input_request`) |
| §5 The read-only map | §1 | `cartografo_describe_graph` |
| §6 When the machine has no server for the step | §6 | MCP-server suggestions |
| §7 What this page does not do yet | §6 | carried over |

---

## 5. Dropped

Requirements with no equivalent here, because they are about a browser:

- **The fetch-metadata gate** (`Sec-Fetch-Site`, `Origin`, the browser
  `User-Agent` check — [`screen.md`](screen.md) §1 "What the proxy refuses"). It
  defends a page against another page in the same browser forging a write. An
  MCP client is a local process speaking stdio; there is no browser and no
  forged origin.
- **The `/v1/*` proxy and the static half** ([`screen.md`](screen.md) §1,
  [`screen-proposal-inbox.md`](screen-proposal-inbox.md) §1). They exist because
  a browser cannot reach the control plane without CORS; this server reaches it
  directly.
- **`POST /project`'s cookie switcher** ([`screen.md`](screen.md) §1). Superseded
  rather than lost: every scoped tool takes `project_id`.
- **The markup contract**: the `data-*` markers ([`screen.md`](screen.md) §6),
  "no framework, no build" and `innerHTML`/`textContent`
  ([`screen.md`](screen.md) §6, [`screen-proposal-inbox.md`](screen-proposal-inbox.md)
  §1, [`screen-graph-editor.md`](screen-graph-editor.md) §6), the visible
  `<label>` rules. Implementation details of an HTML renderer.
- **The design system's binding** ([`design-system.md`](design-system.md)). A
  visual language for rendered pages; a tool answers JSON.
- **The two per-page auto-refresh mechanisms** — `/board`'s 30-second
  `<meta refresh>` ([`screen.md`](screen.md) §1, §7) and `/interview/:id`'s
  three-second fragment poll ([`screen-interview.md`](screen-interview.md) §3).
  A tool call is a read on request; a model reads again when it needs to, and a
  person at a terminal has `cartografo watch`.
- **The graph editor's live in-browser editing and its declined canvas**
  ([`screen-graph-editor.md`](screen-graph-editor.md) §6, §7). The terminal form
  is `graph propose` over a file ([`cli.md`](cli.md) §1); this server edits no
  graph at all (§2).
- **The inbox's per-row update with no reload**
  ([`screen-proposal-inbox.md`](screen-proposal-inbox.md) §3). A tool call
  returns its answer; there is no page to leave stale.

---

## 6. Known gaps

Requirements that make sense outside a browser and have no tool yet. Each names
who it is left to.

- **MCP-server suggestions for a step** ([`screen-interview.md`](screen-interview.md)
  §6). When a turn writes `NEEDS_MCP_SERVER: <capability>`, the page offers up
  to three candidates from the public registry
  ([`mcp-catalog.ts`](../../packages/screen/src/mcp-catalog.ts)'s
  `officialRegistry()`/`cachedCatalog()`). `cartografo_get_interview` returns the
  pending question's context with the hint line in it, and
  `cartografo_start_interview` starts the interview, but neither offers "here
  are three servers you could add". Nothing in `packages/mcp/src` does yet. Left
  to a future ticket; t548 documents it and does not build it.
- **The progress panel mid-interview** ([`screen-interview.md`](screen-interview.md)
  §3.1). No tool asks `POST /v1/graphs/validate` about a draft. Left to a future
  ticket.
- **The board's map position** ([`screen.md`](screen.md) §1, t463).
  `cartografo_list_jobs` returns the raw node and the version id; resolving
  `step N/M · <role>` is left to the caller (`cartografo_describe_graph`) until
  a future ticket gives it a field.
- **The screen specs' own "not yet" lists** ([`screen.md`](screen.md) §7,
  [`screen-proposal-inbox.md`](screen-proposal-inbox.md) §5,
  [`screen-graph-editor.md`](screen-graph-editor.md) §7,
  [`screen-interview.md`](screen-interview.md) §7) carry over unchanged where
  they are not about a browser: per-node execution policies, editing a skill
  manifest's content, pagination, a runner liveness signal beyond leases, a
  second MCP catalogue. Each stays the declared scope of the ticket those lists
  already name.
