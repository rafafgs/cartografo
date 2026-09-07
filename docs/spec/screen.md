# Specification: the minimal observability screen

**Version of the API consumed:** `v1` · **Package:** [`packages/screen`](../../packages/screen)
**Command:** `npx cartografo-screen` · **Default port:** `4318`
**Founding decision:** [D11](../../DECISIONS.md) — "observability and the inbox
first; the screen is a client of the public API, with no privileges" · the PoC
criterion of [D16](../../DECISIONS.md)

The screen answers three questions and no others: **where each job is**, **who is
waiting on a decision of mine**, and **where a job's time went**. Everything it
shows came out of a documented public route; everything it writes was a `PATCH`
against the same API any other client uses.

The corollary, which is the whole of D11: **the screen has no privilege at all**.
It does not open the database, imports nothing from `packages/core`, declares no
SQLite driver and does not know the file's path. It comes up on another port, in
another process, and it can die without the control plane noticing. If it needs
something the API does not give, the bug is the API's — that is how this layer
was born with five new routes on the core's side, and not with five shortcuts
on its own (§4).

The rule is checked statically by
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), which
runs in `npm run lint`, and locked down by
[`packages/screen/test/no-privileged-access.test.ts`](../../packages/screen/test/no-privileged-access.test.ts).

---

## 1. The sixteen routes

| Route | What it shows | What it reads from the API |
|---|---|---|
| `GET /` | The check: whether this machine is ready to run anything, per paired runner — engine, model credential, the `cartografo` MCP server, workspace — or the single "everything is ready" panel with a way into the board. | `GET /v1/runners` (probe embedded), `GET /v1/settings` |
| `GET /board` | The board: every job, banded into the six states t415 derives, in attention order (`awaiting_you`, `blocked_unasked`, `running`, `unowned`, `completed`, `queued`), each band sorted by how long the job has been in it — oldest wait first — and grouped by `no_atual` inside the band while the board holds 12 jobs or fewer; past that it collapses to one flat, time-sorted table per band. Every job still shows the blocking reason where there is one. This is the one page that auto-refreshes every 30 seconds (§7). | `GET /v1/jobs` |
| `GET /examples` | The bundles the control plane can demonstrate: one card each, with the demo's title, whether the class is already registered, and a form that runs it. | `GET /v1/examples` |
| `GET /executions` | One line per execution, with jobs, blocked jobs and pending questions. | `GET /v1/executions` |
| `GET /executions/:id` | One round's slice: the board, the sessions and the pending questions on the same page. | `GET /v1/jobs?execucao_id=`, `GET /v1/sessions?execucao_id=`, `GET /v1/input-requests?status=pendente&execucao_id=` |
| `GET /input-requests` | The escalation queue, every question whole and with an inline form. | `GET /v1/input-requests?status=pendente` |
| `GET /runners` | The fleet: one runner per line, with active leases, the last heartbeat and the last lease it lost to the TTL. | `GET /v1/runners` |
| `POST /examples/:id/run` | Nothing: it runs the example and redirects (303) to `/executions/<the round it allocated>`. The `:id` here is the example's problem class, not an integer. | `POST /v1/examples/:class/run` |
| `POST /input-requests/:id/answer` | Nothing: it writes and redirects (303) to `/input-requests`. | `PATCH /v1/input-requests/:id/answer` |
| `POST /jobs/:id/unblock` | Nothing: it lowers the job's blocked flag, with the stated reason and the operator as the actor, and redirects (303) to `/board`. | `POST /v1/jobs/:id/unblocks` |
| `POST /jobs/:id/block` | Nothing: it raises the job's blocked flag, with the stated reason and the operator as the actor, and redirects (303) to `/jobs/:id`. | `POST /v1/jobs/:id/blocks` |
| `GET /jobs/:id` | The job's timeline, in three buckets, plus the totals; and, since t368 (RF-39), what the traversal produced (one row per artifact, with a link to open it) and the job's own sessions (one row each, reaching the decoded log below). | `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events`, `GET /v1/sessions?trabalho_id=`, `GET /v1/input-requests?trabalho_id=`, `GET /v1/jobs/:id/artifacts` |
| `GET /sessions/:id/log` | One session's decoded log (t368, RF-39/RF-40): the id, node and exit code, the text turned back from frames into what the model said, the line the session actually failed on marked (a non-zero `exit_code`, on the last non-blank line), and the cut declared — never hidden — when the stored transcript overflowed the cap. | `GET /v1/sessions/:id/log` |
| `POST /project` | Nothing: it sets the `cartografo_project` cookie and redirects (302) back to the referrer. | Nothing — the choice is this browser's, and it never leaves it (t354). |
| `POST /runners/:id/rechecks` | Nothing: it asks one runner to report about its machine again and redirects (303) to `/`. The runner serves the request on its next loop tick; reloading is what shows the new probe. | `POST /v1/runners/:id/rechecks` |
| `POST /settings` | Nothing: it writes `workspace_root`/`worktrees_root` for the project in the cookie and redirects (303) to `/`. A field left blank is not sent. | `PATCH /v1/settings` |

Every view renders **on the request**. There is no polling, no websocket and no
auto-refresh: reloading the page is the update, and the screen's state is always
the state the API has just reported. **`/board` alone is the exception** (t416):
it carries `<meta http-equiv="refresh" content="30">`, so it is never more than
30 seconds stale without anyone reloading it — which is also what makes the
relative durations it shows honest (§7).

**Which project a view shows** comes from the `cartografo_project` cookie, and
from nowhere else (D25, t354). Every GET above reads it — defaulting to project
`1` when it is absent or is not a number — and passes `project_id` on every call
it makes to the API; every page draws the switcher in its navigation, out of one
`GET /v1/projects`. `POST /project` is the switcher's own route, and it is the
one write of this screen that never touches the control plane: what a browser is
looking at is that browser's business, and sending it upstream would be the
screen keeping state on somebody else's server (D11).

`GET /runners` is the one view that does not scope its read, and deliberately: a
runner is not scoped to a project — "pairing is identity alone"
([`runner-and-controller.md`](runner-and-controller.md) §1) — so the fleet reads
the same from every project.

**An execution is not an entity.** `execucao_id` is an opaque grouper (there is
no `execucao` table in v1), so `/executions/99` with nothing inside answers
**200 with an empty page**, never 404 — the same reading the control plane
already does in `GET /v1/executions/:id/metrics-by-version`. A job, on the other
hand, is an entity: `/jobs/424242` answers **404**.

### The package has two halves, and one port

D11 asks two things of the screen: observability and the inbox. They arrived in
different slices — this one and the inbox — and they share the same package, the
same process and the same port. A single handler
([`packages/screen/src/servidor.ts`](../../packages/screen/src/server.ts)) decides
between them, in this order:

| Path | Who answers |
|---|---|
| `/v1/*` | A **verbatim** proxy to the control plane, so the inbox can speak same-origin (§1 of [`screen-proposal-inbox.md`](screen-proposal-inbox.md)). |
| A file from `src/public/` — `/inbox`, `/inbox.js`, `/style.css`, … | The proposal inbox: a static page and native ES modules. |
| Anything else | The sixteen routes of this specification, rendered on the server. |

The order is the contract. The static half comes before the render because
`resolveStaticFile` only returns a path for a known extension, and it is
precisely its `null` that hands `/executions` and `/jobs/7` to the views instead
of 404-ing them as a missing file.

**What the root is, and why it is not the board.** For a long time `/` was the
inbox's `index.html`, because that half arrived first; the board stayed at
`/board` and the two reached each other through the navigation. That was layout
and not a boundary, and t402 changed our minds, at the cost of one line on each
side: the root is now the **check**, and the inbox moved to `/inbox`.

The reason is RNF-01 — nothing is asked that the system can discover. The first
page a person opens should not be a list they cannot yet read, nor a form asking
them for facts a paired runner already reported about its own machine. So `/`
either says everything this machine needs is ready, with a way into the board,
or names exactly what is missing with exactly one way to fix each. It reads
`GET /v1/runners` (unscoped, with t401's embedded probe) and `GET /v1/settings`
(scoped, t403) in parallel, opens no route of its own on the core's side, and
gains no privilege doing it (D11).

**The check is per runner, never per fleet.** One group per paired runner, each
with the same four lines, so a fleet of more than one never hides a broken
machine behind a working one. A runner with `probe: null` — paired, but it has
never reported — gets four lines reading "waiting for this runner's first
report" and no diagnosis at all: with nothing known there is nothing to react
to, and an install command drawn against a machine that may well be fine is the
page inventing a failure. The only action offered there is `POST
/runners/:id/rechecks`.

Two of the four lines are deliberately narrower than they look:

- **the MCP line asks whether the `cartografo` server is registered**, not
  whether the engine supports MCP at all — the second is not something a command
  fixes, and the first is what gets the model driving the browser onto the same
  map as the person reading it. `mcp: {supported:false}` (an adapter with no
  discovery, t400) reads as "can't be checked automatically" and never as a
  failure: an adapter that never implemented discovery is not an engine with
  zero MCP servers;
- **the credential line names the environment variables each adapter actually
  checks** (`CREDENTIAL_VARIABLES`, `CODEX_CREDENTIAL_VARIABLES`) and the
  credential file each preflight reads (`~/.claude.json`'s `oauthAccount`,
  `$CODEX_HOME/auth.json`), rather than a login subcommand. No such subcommand
  is evidenced anywhere in this repository, and asserting one on the page whose
  premise is "nothing is asked that the system can't discover" would ship an
  unverified command with the same authority as the measured ones.

The same rule is why `claude-code`'s engine line has no install command and says
so: no npm package name for that CLI is recorded here, and `codex`'s line cites
`npx --yes @openai/codex@latest` only because that is how this repository's own
codex evidence was gathered.

**Nothing redirects the old root.** D20's precedent stands: nothing here is
public yet, so `/` did not move, it is simply somewhere else now.

### What the proxy refuses

Everything the proxy forwards leaves here with the operator's credential stamped
on it, and the control plane's write routes are happy with an empty
body. A `fetch(url, {method:'POST', mode:'no-cors'})` is a "simple" request — it
fires no preflight —, so, with no gate, **any page open in the same browser**
would apply a proposal on port 4318 using the token of whoever opened the screen.
The gate closes exactly that hole.

It reads **fetch metadata**, and nothing else: `Sec-Fetch-Site` and `Origin` are
written by the browser's network stack and forbidden to the page's script — not
even in `no-cors` can a hostile page forge them. Writes are refused (`/v1/*` with
a method other than `GET`/`HEAD`, and every `POST` of this specification —
`/input-requests/:id/answer`, `/jobs/:id/unblock`, `/jobs/:id/block`,
`/project`, `/examples/:class/run`, `/runners/:id/rechecks` and `/settings`)
when:

1. **`Sec-Fetch-Site` came and is neither `same-origin` nor `none`** — the
   browser itself is saying the request was born somewhere else;
2. **`Origin` came and is not exactly the request's `http://<Host>`** — the usual
   Origin-versus-Host check, with no configuration to keep up to date (the screen
   serves plain HTTP; nothing in this stack terminates TLS);
3. **neither of the two came, but the `User-Agent` looks like a browser**
   (`Mozilla/`, `Chrome/`, `Safari/`, `Firefox/`, `Edg/`) — a browser older than
   fetch metadata is still a browser.

The proxy's refusal is a `403` with the same `{error, message}` envelope as the
`502`, and with `message` in English for the same reason (API plumbing,
not rendered text):

```json
{"error": "untrusted_origin", "message": "this proxy only forwards writes that started on the screen's own page — …"}
```

The form's refusal is the screen's ordinary `403` error page, in English like all
the others. Its title is `untrusted origin`, and under it:
`This form only accepts submissions that started on this page. Reload and try again.`

What is left — no `Sec-Fetch-Site`, no `Origin` and no browser signature — is
`curl`, a script or Node's own `fetch`, and it passes **on purpose**: the
boundary for a local process is D11's loopback port, not this gate. A malicious
process on the same machine forges any header, and closing that would demand a
credential the browser presents — a decision that has not been taken.

**`GET`/`HEAD` are left out on purpose.** The body of a `no-cors` response is
opaque to the page that asked for it, so there is no way to exfiltrate through
the read side: barring reads would be more complexity with no less risk.

---

## 2. The rule of the three buckets

The timeline is flowpilot's "generic time"
([`notes/2026-08-14-learning.md`](../../notes/2026-08-14-learning.md)): a
job's total time says nothing; what says something is how it splits.

| Bucket | Interval | Source |
|---|---|---|
| `agente_trabalhando` | `[aberta_em, finalizada_em]` | a session |
| `esperando_humano` | `[criada_em, respondida_em]` | a question |
| `fila` | the **complement**: every interval with no session open and no question pending | the transitions |

Four rules close the definition:

1. **A transition cuts the queue in two**, even with nothing happening in
   between. "Two days stuck in refinement and one hour in implementation" and
   "two days and one hour stuck" are different diagnoses, and the first is the
   useful one. Blocking and unblocking do **not** cut: they are a flag, not
   movement — the job does not leave the node, and the wait is still the same
   wait.
2. **What has not ended stays open** (`fim: null`) and does **not** enter the
   totals. Closing a segment with the clock of whoever opened the page would
   invent a fact the log does not have.
3. **A finished job is the server's `concluido`**, plus what only the screen
   knows. The field comes from `GET /v1/jobs/:id` and answers a question the
   screen would have no way of answering on its own: the job's current node is
   among the `nos_finais` of its graph version (and it is not blocked). It is the
   only terminal signal this system has — there is no `job.completed` event in
   the taxonomy, and `nos_finais` lives in the graph's snapshot, far from any
   response the screen reads. On top of that field the reconstruction still
   demands **nothing open and nothing blocked**: an open session or a pending
   question hold the job however terminal the node is. It is that composite
   criterion — and only it — that closes the last queue segment.

   The rule was once only "nothing open and no block", because there was
   no terminal field. It called every freshly created job **finished**: with a
   single `job.created` in the log, nothing is open because nothing began. A job
   sitting between two sessions fell into the same trap — precisely the wait this
   timeline exists to make visible. A blocked and stalled job, on the other hand,
   goes on accumulating queue, open-ended; it is exactly the time nobody wants to
   see growing without an explanation.
4. **The reconstruction is a pure function** and does not look at the clock
   ([`timeline.ts`](../../packages/screen/src/timeline.ts)): the same inputs — the
   three responses and rule 3's `concluido` — produce the same timeline today and
   a month from now. It is what makes it testable without real time.

### Why three sources, and not one

Because `GET /v1/jobs/:id/events` **deliberately excludes** `session.finished`,
`input_request.answered` and `input_request.auto_resolved`: those events'
payloads do not carry `job_id` — the link was declared at the opening, and
repeating it would be duplicated data in the log
([`packages/core/src/db/events.ts`](../../packages/core/src/db/events.ts)).
"Whoever wants the session's end asks the session", says the comment over there.
This screen is the first consumer to ask that question, and that is why it is
this ticket that opened where to ask it (§4).

The page's header comes from a fourth read, `GET /v1/jobs/:id`, and not from the
log: `job.amended` records only the **name** of the changed field, so
reconstructing the title from the events would give the old title.

---

## 3. Answering is a real write

`POST /input-requests/:id/answer` calls `PATCH /v1/input-requests/:id/answer` on
the real control plane and returns **303** to `/input-requests` — 303 and not 302
because after a POST the way back is a GET, and that is what stops the browser
from resending the answer on a reload. The question disappears from the queue
because the queue is reread from the API, **not** because the form hid it
locally. The acceptance test demands that difference with an independent read
against the control plane after the submit.

Two boundary choices:

- **A blank answer is refused by the screen** (400), before the network. The
  `input_request.answered` schema accepts an empty string; writing a fact with no
  content would pollute the audit with a decision that decides nothing.
- **`respondido_por` falls back to `"tela"`** when the field comes in empty.
  The API is authenticated, but the screen carries ONE service credential and
  asks the browser for none: a token proves possession, not a person. Honestly
  recording the door the answer came in through is still everything the system
  actually knows; inventing a user would be worse, because
  `input_request.answered` is an audit event.

The answer field has a visible `<label>` tied to the `<textarea>` by `for`/`id`,
and not only a placeholder — a placeholder is a hint, it disappears on the first
character typed and it is not a reliable accessible name, and this is the page's
only required field. The id comes from the question's id, which is already the
card's unique key. It is the same rule the proposal inbox follows on its reason
field ([`screen-proposal-inbox.md`](screen-proposal-inbox.md) §3); pinned in
[`packages/screen/test/questions-answer-field.test.ts`](../../packages/screen/test/questions-answer-field.test.ts),
which resolves the name the way a screen reader would.

**The one that unblocks the job is not the screen.** The question → block →
answer → unblock → session resume wiring belongs to escalation, and it lives in the control
plane: creating the question blocks the job in the same transaction, and
answering unblocks it with the actor of whoever answered
([`packages/core/src/repositories/input-request.ts`](../../packages/core/src/repositories/input-request.ts),
the contract in [`human-escalation.md`](human-escalation.md)). The screen writes
the fact and nothing else; the cycle happens on the other side of the HTTP. It
was written before that wiring existed and did not change a line when it arrived —
which was exactly the bet.

### Blocking and unblocking are real writes too

The board used to show a held job and its reason and offer no way out of it: the
flag could only come down from a terminal. Two new writes close that, and they
are the same act seen from either side — a reason, a person, and one call to a
route the control plane already published:

| The screen's route | What it calls | Where it lands |
|---|---|---|
| `POST /jobs/:id/unblock` | `POST /v1/jobs/:id/unblocks` | **303** to `/board` |
| `POST /jobs/:id/block` | `POST /v1/jobs/:id/blocks` | **303** to `/jobs/:id` |

**One surface per action, and never both on one page.** Unblock is offered on
`/board`'s held jobs — on the card in card mode and in the note column of the
row in row mode (§1), because a board past a dozen jobs is exactly the one whose
held column most needs walking — since releasing is done to a QUEUE: the
standing consumer files every rule promotion as a job born blocked, and the
human gate is walking the held column. Block is offered on `/jobs/:id`, because stopping a healthy job
is deliberate and one at a time, and a form on every card of the grid would cost
more than it buys. Each form is mutually exclusive with the state it changes: a
blocked card offers unblock and nothing else, a healthy job page offers block and
nothing else. Offering an action the API would refuse is the failure the inbox's
own state table exists to prevent
([`screen-proposal-inbox.md`](screen-proposal-inbox.md) §3).

Two boundary choices, the same pair §3 draws for the answer form:

- **A blank reason is refused by the screen** (400), before the network.
  `job.blocked` already requires one, so the control plane would refuse that
  half anyway — but `job.unblocked.reason` is deliberately **optional**
  ([`specs/events/taxonomy.md`](../../specs/events/taxonomy.md)), because the
  control plane's own unblock-on-answer has no reason to state. Optional
  upstream and mandatory at this door is the whole point: a person who clicks
  says why, and the automatic path is not made to invent a sentence.
- **The actor is always sent, and never defaulted.** `resolveActor` in the
  control plane turns an absent `actor` into the API's own identity — "the
  control plane", not a person. A board action that left it out would record the
  system as having released what a human released, which is exactly the
  distinction
  [`packages/core/src/repositories/input-request.ts`](../../packages/core/src/repositories/input-request.ts)
  keeps for the answer-driven unblock. `actor_ref` falls back to `"tela"` when
  the field comes in empty, for the same honesty reason `respondido_por` does:
  the screen holds one service credential and asks the browser for none.

**`/board`'s 30-second refresh reloads the unblock form with it** (§1). That is
the one place on this screen where the no-auto-refresh-where-there-is-a-form
rule and a write share a page, and it is recorded here rather than hidden: a
half-typed reason can be discarded by a reload nobody asked for. It is judged
affordable because the field is one sentence and the act is deliberate — but if
it stops being affordable, the fix is a narrower refresh scope on `/board`, not
a quieter form.

---

## 4. The five API gaps this layer closed

D11 orders "the screen needs something the API does not give" to be treated as a
bug in the API. All three are additive and symmetric to filters that already
existed:

| Route | What was missing |
|---|---|
| `GET /v1/executions` | There was no way to **discover** which executions exist: only `GET /v1/executions/:id/metrics-by-version` existed, which demands already knowing the id. It returns `{execucoes: [...]}` with `execucao_id`, `trabalhos`, `trabalhos_bloqueados` and `perguntas_pendentes`, in ascending order and with the `null` group last (the same convention as `metricsByVersion`). |
| `GET /v1/sessions?trabalho_id=` | There was only a filter by execution; without this one, "this job's sessions" cannot be asked for — and without them there is no session end on the timeline. |
| `GET /v1/input-requests?trabalho_id=` | Symmetric to the previous one, for the same reason: the end of the waits. |
| `GET /v1/examples` | There was no way to **discover** which bundles are ready to be demonstrated. The screen opens no directory and knows no path (D11), so listing `factory-graphs/` on this side would have been the very shortcut this layer exists without. It scans an examples root — `CARTOGRAFO_EXAMPLES_ROOT`, `factory-graphs/` by default — for every subdirectory carrying a `demo/job.json`, and answers `{examples: [{class, bundle, demo_title, registered}]}` (t408). |
| `POST /v1/examples/:class/run` | And no way to **act** on one: registering a bundle was `cartografo import` at a terminal, and creating its job needed an execution id the caller had to invent. The route registers the bundle when the project has never seen the class, allocates an unused round, and answers `201 {job, execution_id, registered}` (t408). Since t409 a bundle may also ship a `demo/repo/`, and when it does the route copies it into the project's `workspace_root` as a git repository BEFORE anything is written — the demo of `software-development` needs a real checkout to cut worktrees from. That step adds two refusals to the `409` this row already answered, both of which write nothing at all: `workspace_root_unset` (the setting points nowhere) and `workspace_not_empty` (the workspace already holds work, including the work a previous demo run put there). Neither is signalled ahead of the click: they reach the operator through the same generic failure page as any other write this route refuses. |

The filters add up as an **AND** with the ones that already existed, and an
invalid filter is a **400**, never a filter ignored in silence.

---

## 5. Configuration

| Variable | Default | What it is |
|---|---|---|
| `CARTOGRAFO_SCREEN_PORT` | `4318` | The port the screen listens on. |
| `CARTOGRAFO_URL` (or `--url`) | `http://127.0.0.1:4317` | The control plane it reads. |
| `CARTOGRAFO_PORT` | `4317` | The control plane's port in the default above. |

The address's precedence: `--url` > `CARTOGRAFO_URL` >
`http://127.0.0.1:CARTOGRAFO_PORT` > default — the core CLI's own
([`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts)), so that
bringing the control plane up on another port does not demand configuring two
things in two vocabularies. What resolves it is
[`resolveControlPlaneUrl`](../../packages/screen/src/proxy.ts), one for the whole
package: there was once a second resolver in `router.ts`, with
no `CARTOGRAFO_PORT`, and it was the one `bin/screen.mjs` reached. The screen
listens on **loopback**, like the control plane and for the same reason: there is
no authentication at this stage.

On start-up it prints a JSON readiness line on stdout — the same contract as the
control plane's start:

```json
{"event":"cartografo.tela.ready","url":"http://127.0.0.1:4318","controlPlane":"http://127.0.0.1:4317"}
```

**When the control plane is down**, every page answers **502** with the command
that fixes it (`npx cartografo`), never a 200 with an empty board. A 404 from the
API becomes a 404 on the screen; any other error from the control plane becomes a
502 — the one that failed was the server behind, and the browser needs to know it
was not this one.

---

## 6. No framework, no build

A plain `node:http` server, HTML assembled on the request, **zero runtime
dependencies**. The only JavaScript that reaches the browser is the eight lines
that copy a clicked option into the answer field; without them, typing the answer
still works.

It is a choice of scale, not of taste: the screen is a reading HTTP client with
a few forms, and a front-end pipeline would cost more maintenance than the whole
thing it would serve. It is also reversible — the boundary D11 freezes is the
HTTP contract between the screen and the core, not what the screen uses inside.

### The `data-*` markers are contract

They exist so that the acceptance tests can assert about **structure** — what is
inside which group, in what order — without freezing the whole markup. Changing
one of them is changing the contract; changing a CSS class is not.

| Marker | Where | Value |
|---|---|---|
| `data-no-atual` | a board group | the node's id |
| `data-trabalho` | a job card | the job's id |
| `data-state` | a state band on `/board` | one of `awaiting_you`, `blocked_unasked`, `running`, `unowned`, `completed`, `queued` (t416) |
| `data-execucao` | a line of the execution list | the id, or empty in the `null` group |
| `data-campo` | a count cell, a derived-field cell, or a line of the check | `trabalhos`, `trabalhos_bloqueados`, `perguntas_pendentes`, `nome`, `leases_ativas`, `ultimo_heartbeat`, `ultima_expiracao`, and on `/`: `runner`, `engine`, `credential`, `mcp`, `workspace` |
| `data-estado` | a line of the check, beside its `data-campo` | `met` or `unmet` |
| `data-pronto` | the "everything is ready" panel on `/` | how many paired runners were checked |
| `data-runner` | a line of the runner table, or a group of the check | the runner's id |
| `data-sessao` | a line of the session table | the session's id |
| `data-transcricao` | the link in the transcript cell, in the session table | the session's id (the `href` is `/v1/sessions/:id/transcript`) |
| `data-artifact` | a row of the job page's artifact table (t368) | the artifact's id |
| `data-log-line` | a line of a session's decoded log, on `/sessions/:id/log` (t368) | the line's 1-based number |
| `data-pergunta` | a question card | the question's id |
| `data-segmento` | a timeline item | `fila`, `agente_trabalhando`, `esperando_humano` (with `data-inicio` and `data-fim`; an empty `data-fim` = open) |

The transcript cell is a raw link to the API's route, and not a rendered view:
whoever clicks lands on the control plane's JSON response, served by the
**verbatim** `/v1/*` proxy (§1). That is on purpose — the screen gains no new
route and no privilege at all (D11). Decoding `stream-json` on the screen was
deferred to "another ticket" when this sentence was first written; t368 is that
ticket, and `/sessions/:id/log` is the decoded view. The raw link stays exactly
where it was — beside the decoded view, on the job page's session row — as a
deliberate companion and not a stand-in: the whole point of RF-40's cut notice
is that the decoded view is a TAIL when the transcript overflowed, and the raw
route is still how the complete original is fetched.

Every piece of data that goes into HTML passes through `escapar`. A job's title,
a question's text and a blocking reason come from outside, through an API that
still authenticates nobody.

---

## 7. What this screen does not do yet

Every item is another ticket's declared scope, not an oversight:

- **Graph editing beyond the topology.** D11 fixed the order — observability
  first, editing afterwards — and the topology slice exists:
  `/graph-editor.html` adds, removes and edits a base graph's nodes and edges,
  saving through the same proposal calls any API client would make
  ([`screen-graph-editor.md`](screen-graph-editor.md)). Left for tickets of their
  own are the **per-node execution policies** (model, pause, timeout, escalation)
  and **editing the skill registry**, each waiting on a backend surface that does
  not exist yet; and left out, by decision and not by oversight, are the
  draggable canvas (the graph document has no coordinate field) and the variant
  lineages (D13).
- **The proposal approval inbox** (the `proposta` entity, distinct from
  `pergunta`) — it is the package's other half, served at
  `/inbox` ([`screen-proposal-inbox.md`](screen-proposal-inbox.md)).
- **Logging in from the browser** — the API is authenticated and the
  screen a service credential (`CARTOGRAFO_SCREEN_TOKEN`, with `CARTOGRAFO_TOKEN`
  as a fallback), which it presents on every call to the control plane. The
  browser still reaches the screen with no credential at all, the screen is still
  on loopback and `respondido_por` still falls back to `"tela"`: by D11 the
  screen is an unprivileged client of the API, not a second identity boundary.
- **A real session resume on answering** — that is the control plane's, through
  escalation cycle (§3); the screen only writes the fact.
- **A node label with the `papel`/`descricao` of the graph's snapshot** — the
  board shows the raw `no_atual`; fetching the graph to label it is additive.
- **"step NN/MM" beside a job's node** (RF-30 Part 2 component 4) — no route of
  the API exposes a node's ordinal position inside its graph version, and
  inventing that surface is not `/board`'s ticket to do (t416).
- **Pagination** — no route of the API paginates today, and it is not this ticket
  that invents what the API does not have.
- **Live updates by any mechanism other than `/board`'s own refresh** (polling,
  websocket, SSE) — every other view renders on the request alone.
- **Relative time** ("3 minutes ago") on `/runners` or on any other date: the
  screen shows the raw instant the API recorded. A relative label computed at
  render time, on a page with no auto-refresh, starts lying the next second.
  **`/board` is the one narrow exception** (t416): it pairs the relative
  duration with the raw instant it was computed against (`for … as of …`), and
  it may only do so because the 30-second auto-refresh above is what keeps
  that instant from going stale unnoticed.
- **Knowing whether an idle runner is alive.** `/runners` shows what the control
  plane actually records, and what it records is leases: `ultimo_heartbeat` and
  `ultima_expiracao` are derived from the `lease` table
  ([`runner-and-controller.md`](runner-and-controller.md) §5). A paired runner
  that never picked up work appears with all three fields empty, just like one
  that is down. Inventing a liveness signal here that the API does not have would
  be exactly the shortcut D11 forbids. The check at `/` inherits the same limit
  and says the same thing in its own words: a runner with `probe: null` is
  "waiting for this runner's first report", which covers both the machine that
  is starting up and the machine that will never answer.
