# Specification: the runner, the lease and the dispatch controller

**API version:** `v1` · **Migration:** [`packages/core/migrations/0004_runner_lease.sql`](../../packages/core/migrations/0004_runner_lease.sql)
**Founding decision:** [D5](../../DECISIONS.md) — "dispatched work carries a lease; a dead runner's lease expires and the work goes back to the queue. Writes to the API are idempotent"

A job can only have one owner at a time, and the owner can die without warning.
Those two sentences are this layer's whole problem, and the lease is the answer:
a **temporary** right over a job, which has to be renewed in order to keep
holding. Whoever stops renewing loses it — not by anybody's decision, but by a
deadline running out.

The important corollary is where the state lives. The cap on simultaneous
sessions and the leases' deadline live in the control plane, never in the runner:
only the server writes to the database ([D1](../../DECISIONS.md)), and that is
what makes "at most N sessions in this project" hold for the project — summing
every runner — and not for each process in isolation. The runner is a pure HTTP
client, exactly like the screen (D11): it declares the limits, and obeys the
answer.

---

## 1. The two entities

| Entity | What it is | Does it change? |
|---|---|---|
| `runner` | The **identity** of a process that executes work. | Only the name. |
| `lease` | A runner's **temporary right** over a job, with a deadline of its own. | The status, the deadline and the heartbeat/end stamps. |

```sql
CREATE TABLE runner (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  registered_at TEXT NOT NULL
);

CREATE TABLE lease (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  runner_id         TEXT NOT NULL REFERENCES runner(id),
  job_id            INTEGER NOT NULL, -- loose on purpose (§6)
  project_id        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'released', 'expired')),
  ttl_seconds       INTEGER NOT NULL,
  granted_at        TEXT NOT NULL,
  heartbeat_at      TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT,
  expiration_reason TEXT CHECK (expiration_reason IN ('heartbeat_lost', 'ttl_elapsed'))
);

CREATE INDEX idx_lease_runner_status  ON lease (runner_id, status);
CREATE INDEX idx_lease_project_status ON lease (project_id, status);
CREATE INDEX idx_lease_job_status     ON lease (job_id, status);
```

The three indexes are the dispatch's three read paths, in the order it walks
them: does the job already have an owner? does the runner still have room? does
the project still have room?

**The runner is not scoped to a project.** Pairing is identity alone;
`projeto_id` is declared on every lease request. One physical runner can serve
different projects over time, and nothing in the acceptance criteria asks for the
opposite.

Nothing is deleted, not even a dead lease: it becomes `expirada` with the reason
recorded and stays in the table. It is the same append-only as
[D15](../../DECISIONS.md) — and it is what makes it possible to cross "runner ×
lost leases" without reconstructing anything, now that `t102`'s telemetry is in
place (the `event` table, migration `0003`) and `t196` switched the emission on:
every lease's death is in the table **and** in the log.

---

## 2. The lease's life cycle

```
                      release (the owner finished, well or badly)
   ativa ──────────────────────────────────────────────────▶ liberada
     │
     │ expires_at runs out with no heartbeat, and somebody asks for work
     ▼
  expirada  (expiration_reason: ttl_elapsed | heartbeat_lost)
```

A lease is born `ativa`, with `heartbeat_at = granted_at` and
`expires_at = granted_at + ttl_seconds`. Every heartbeat pushes `expires_at`
forward and stamps `heartbeat_at`.

There are only two exits, and neither of them comes back:

- **`liberada`** — the owner said it had finished. The capacity returns
  immediately: the next request from the same runner/project no longer counts
  this lease against the cap.
- **`expirada`** — the deadline ran out and nobody renewed.

### The vocabulary of `expiration_reason`

The two reasons describe different deaths, and the difference is operationally
useful — one points at work that never started, the other at work interrupted
half way:

| Reason | When | What it means |
|---|---|---|
| `ttl_elapsed` | `heartbeat_at == granted_at` | The lease was **never** renewed. The runner may not even have started. |
| `heartbeat_lost` | `heartbeat_at > granted_at` | It was renewed at least once and then went quiet. The runner died in the middle of the work. |

The two names are exactly those of `data.reason` in
[`lease.expired.schema.json`](../../specs/events/schemas/lease.expired.schema.json):
since `t196` every lease that dies records the event with the same reason the
column keeps, with no translation — one event per lease, even when the sweep
kills several at once.

### A refusal's `reason` ≠ `expiration_reason`

They are two distinct vocabularies and it is worth not confusing them.
`expiration_reason` is a wire name **and**, since D20's fourth child (`t229`,
which renamed `motivo_expiracao`), the column's: why a lease died. `reason` is a
response field of `POST /v1/leases`: why a request **did not become** a lease
(`job_already_leased`, `runner_cap`, `project_cap`).

---

## 3. Granting is a single step

`POST /v1/leases` does five things, and does all of them inside **one**
synchronous transaction, with no `await` in the middle:

```
claim every active lease whose deadline ran out   ← a dead runner's work returns to the queue
        ↓
does the job already have an active owner?  → 200 {lease: null, reason: "job_already_leased"}
        ↓
has the runner already hit runner_cap?      → 200 {lease: null, reason: "runner_cap"}
        ↓
has the project already hit project_cap?    → 200 {lease: null, reason: "project_cap"}
        ↓
write the lease                             → 201 {lease}
```

**Why a single transaction.** Between counting the active leases and writing the
new one there is a window; if it exists, N simultaneous requests all count the
same number, all consider themselves inside the cap, and all write. The
concurrency cap would become a suggestion. The guarantee is the same — and in the
same form, a synchronous `db.transaction()` — that `aplicarProposta` uses in
`t101`.

**Proved with two real runners.** Until `t164` every cap test called the
repository or the route **in process**, one caller at a time: the guarantee above
was a property of code nobody had seen happen.
[`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
puts two independent `Controller`s, each with a credential of its own, competing
for the same queue over the machine's real IPv4 address — and demands all three
consequences: no job dispatched twice, neither of the two runners left out, and
the project cap never summing above what was configured, even under concurrent
requests from distinct clients. The cap is the **project's**, not the runner's:
`teto_projeto`'s count does not filter by `runner_id`, and that is why it holds
the whole fleet and not each machine separately.

**Why claiming is the first step, and not a routine of its own.** Whoever asks
for work is exactly who has an interest in discovering that a lease died. In the
same transaction, the request that finds the expired lease is the request that
replaces it — there is no instant in which the job is free and nobody noticed.
That is why there is no sweep route: a trigger that ran with nobody asking for
work is only useful once there is a concrete consumer (`t107`'s screen, or a
project with every runner idle), and then it is additive.

**A refusal is not an error.** A cap that was hit and a job that has an owner
return `200` with `{lease: null, motivo}`, not `409`. From the runner's point of
view that is "not now, try the next candidate" — the common case of a healthy
pool, not the exception.

---

## 4. The controller, on the runner's side

A `tick()` is one complete pass of the dispatch loop:

```
GET /v1/jobs → filters bloqueado === false
        ↓
for each candidate, in order: POST /v1/leases
        ↓ (refused with trabalho_ja_leased: try the next one)
        ↓ (refused with teto_runner or teto_projeto: end the tick)
lease granted
        ↓
arms the periodic heartbeat  ─────────────┐
        ↓                                 │ POST /v1/leases/:id/heartbeats
   despachar(trabalhoId)                  │ every ttl/3
        ↓ (resolves OR rejects)  ◀────────┘
stop the heartbeat + POST /v1/leases/:id/liberacoes
        ↓ (resolved blocked: try the next candidate, in the SAME pass)
```

Four design decisions hold that up:

**Not every refusal means the same thing (`t208`).** The refusal's `motivo` is
what decides whether the loop carries on. `trabalho_ja_leased` is about the
ownership of **that** job — another runner got there first —, it says nothing
about the next candidate, and it is the common answer of a healthy pool: try the
next. `teto_runner` and `teto_projeto` are about **capacity**, and the capacity
belongs to this runner or this project, not to this job: every remaining
candidate of the same pass would come back with an identical answer. The tick
ends there. Before `t208` it went on asking, and a full project cost one
`POST /v1/leases` per candidate to hear again what the first had already said.
Ending early is not giving up — the loop asks again at the next interval, and by
then some lease may have been released or expired.

**The lease is always given back.** The release is in a `finally`, not on the
happy path: a dispatch that blows up gives the lease back exactly like one that
ends well, and only then does the error go up to the caller. A lease stuck on a
job that failed is capacity occupied by nobody until the TTL runs out — worse
than both of the cases it meant to cover.

**A heartbeat that fails does not bring the dispatch down.** An isolated network
failure is transient; the consequence of several in a row is already the right
one and automatic — the lease expires on the server and the job goes back to the
queue. Aborting the session on the first failure would trade a network hiccup for
lost work. The error stays visible in `ultimoErroDeHeartbeat`.

**The default interval is `ttl/3`**, that is, room for two missed beats before
the server gives the runner up for dead. Whoever passes an explicit
`intervaloHeartbeatMs` takes on the arithmetic: an interval longer than the TTL
lets the lease itself expire underneath the dispatch.

`despachar` is an **injected callback** and is the only seam with the
[`EngineAdapter`](../formats/engine-adapter.md) (`t104`): this layer opens no
session at all. Whoever closes the cycle with a real session (`t106`/`t109`)
passes the adapter through here without touching the controller.

**One process, one session at a time — and the flag says so (`t208`).** The
`tick()` asks for **one** lease per pass and waits for the whole dispatch before
the next pass exists: a runner process never holds more than one active lease.
`--declared-runner-cap` (`teto_runner` in the request, `runnerCap` in the
options) is the cap this runner **declares** to the control plane for its own
`runner_id`, and not the concurrency inside the process — the server takes the
SMALLER of it and the configured cap (`CARTOGRAFO_LEASE_CAP_RUNNER`) and is the
one that imposes the result (D1). Until `t208` the flag was called `--runner-cap`
and the `--help` promised "simultaneous sessions of this runner", which was never
true. Scaling is still **horizontal**: more runner processes under the same
project, competing for the project cap through the server's transaction — the
path
[`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
already proves (§3). Running N sessions inside one process was refused by the
founder in `t208`, and it is still reversible by another decision if the need
turns up concrete.

### A failure before the session blocks, it does not retry forever (`t252`, `t270`, `t272`)

A dispatch makes five reads **before** taking a worktree and opening a session:
the job, the graph version, the engine's route, the executor environment and the
skill the node pinned. **Seven** failures on the path to the session reproduce
**identically** on every retry:

| Cause | Where it comes from |
|---|---|
| a dangling `graph_version_id` | `GET /v1/graph-versions/:id` answers 404 |
| an engine with no route on this runner | the dispatch's `engines` table does not have the name |
| a skill outside the registry | `GET /v1/skills/:id?version=` answers 404 |
| a pin that stopped matching | the registered hash ≠ the hash the node declares (D4) |
| a placeholder that does not resolve | `{{input.<path>}}` with no value in the node's input |
| an unreadable test bench (`t270`) | `git` refused at the configured path |
| a permission policy the engine cannot apply (`t272`) | `startSession` throws `SessionStartError` with the prefix `permission policy unsupported: `, before the spawn |

The sixth arrived with `t270`, along with the read that produces it — the
executor environment of the section just below.

The seventh is the only one that happens **after** the worktree, inside
`startSession` — and it is the one the `t109` run caught live: the
`testar-alpha` node declared `rede` by domain, the `claude-code` adapter has no
way of expressing that, and the dispatch blew through **38 leases in two
minutes** without opening a single session
([note](../../notas/2026-08-17-t109-game-feature.md), gap 2). Deterministic in
the strong sense: the same skill, at the same hash, asks for the same policy and
gets the same refusal on every tick. The blocking reason cites the adapter's
message **literally**, because the field to fix is the one
`engine/permission-policy.ts` names.

The other three causes of `SessionStartError` are **not** on that list: the two
shapes of spawn failure carry nothing that tells a binary that does not exist
from a momentary `EMFILE`, and codex's resume refusal is unreachable today. They
fall under the ceiling of the subsection below, which is a strictly weaker
statement — and a safer one.

Until `t252` the first five **blew up**; the seventh, until `t272`. The error
went up from the dispatch, up from the `tick()`, and the `cartografo-runner run`
loop did the only thing it knows how to do with a failed tick: it wrote a line to
stderr and asked again at the next interval (`--interval-ms`, two seconds by
default). Since nothing had marked the job, `GET /v1/jobs` returned the **same**
job at the head of the queue, the lease was granted again, and the dispatch fell
into the same error — forever, with no row in `pergunta`, no `bloqueado`, and
nothing in anybody's inbox. And, because the `tick()` ends at the pass's first
lease, no other job of the project was attempted while that one was in front.

Now those seven **block the job** with a reason that names the cause —
`POST /v1/jobs/:id/blocks`, actor `sistema/runner`, the same mechanism as the two
blocks the dispatch already did on its own account. Nothing new is invented:
since `GET /v1/jobs` filters `bloqueado === false`, a blocked job simply stops
being a candidate, and it is that filter — with no extra write — that turns
"forever" into "once". Whoever unblocks it is a person, through the usual
`POST /v1/jobs/:id/unblocks`, after fixing what the reason points at.

Three limits that are part of the decision:

**Only those seven.** Any other error of the same window — a 500, a 502, a 503, a
network timeout, the 404 of reading the **job itself** — still blows up, and is
still retried at the next interval (with a ceiling, since `t272`: see the
subsection below). A control plane that is down passes on its own; blocking a job
over it the first time would be asking a person to undo a hiccup by hand. That is
why the classification is a pure, closed module
(`packages/runner/src/dispatch/pre-session-failure.ts`): the boundary is the
file's contents, and a new cause is another ticket's decision — which is exactly
how the sixth came in (`t270`): a new pre-session read appeared, its refusal
reproduces on every retry, and a cause nobody classifies is a loop nobody sees.

**The `tick()` carries on in the same pass.** A block is neither refused capacity
nor work done: the lease has already come back through the usual `finally`, and
the next candidate is attempted immediately, without waiting for the next
interval. If every candidate blocks, the pass returns `null`, exactly like a pass
that won no lease at all.

**Nothing opens.** The block of the first six happens before
`worktrees.acquire`, so there is no tree to give back, no `POST /v1/sessions`, no
engine process and no token spent. The seventh happens with the tree already in
hand: it is given back (retained, as on every error exit) before the block is
posted, and even so no session exists for the control plane. A failure **after**
the session came up is another matter — the next section's, which `t265` closed.

#### And what nobody knows how to classify has a ceiling (`t272`)

The limit above is honest and, on its own, insufficient: everything the
classifier answers `null` for went on retrying **forever**. A stubborn 5xx, a
`git worktree add` that fails because the disk filled up, a `SessionStartError`
from a spawn — none of them proves itself permanent, and none of them had an end.

Now the three windows that can fail before a session exists go through a single
decision (`packages/runner/src/dispatch/pre-session-retry.ts`): the pre-worktree
read, the `worktrees.acquire` — which until this ticket was under no `catch` at
all — and `startSession`'s `SessionStartError`. The rule is the same in all
three:

1. classified (the seven above)? block on the **first**, as ever;
2. not classified and the sequence is **below** the ceiling? throw, and the next
   tick tries again — behaviour identical to before;
3. not classified and it **reached** the ceiling? block with a reason that names
   the node, the count and the error's message, which is the only evidence there
   is.

The ceiling is `maxConsecutivePreSessionFailures` in the dispatch's options,
**5** by default; a value that is not a positive integer falls back to the
default, the same posture as the time budgets. A session that opened
(`POST /v1/sessions` answered) zeroes the job's count: reaching a session is the
signal that it came unstuck.

**The count belongs to the runner's process, and that is a decision with a
cost.** It lives in an in-memory `Map`, inside the closure
`createClaudeCodeDispatch` returns, and it is **not** the same fact as
`job.blocked`'s `consecutive_failures`: that one counts `failed` **sessions** of
the `(job, node)` pair and lives in the control plane precisely because it
crosses leases and processes (`t265`, the section above). A pre-session failure
creates no row in `sessao` at all — there is nothing for that query to see —, and
inventing one would make the table lie about what ran. Building a parallel
counter in the core would cost a new column, a new event and a new route for a
fact the reported incident does not need: the measured loop happened inside
**one** runner process, in two minutes.

What is given up is written down, not swept under the carpet: the sequence
**does not survive a restart** of the runner, and two runners each count their
own. Both err on the same side — the job retries *more* than the ceiling, never
less —, which is the safe direction to err in.

### The executor environment: what only the machine knows (`t270`)

A dispatch assembles the node's input from **two** sources, and the split between
them is this section's whole subject: who answers for each key.

| Key | Who supplies it | Why |
|---|---|---|
| `input.job`, `input.project`, the `produces` buckets, `input.perguntas_respondidas`, `input.traversal` | the **control plane**, through `GET /v1/jobs/:id/context` | All of it is a projection of tables only the single writer writes (D1). |
| `input.project.aplicacao`, `input.project.arquivos_de_registro` | the graph's **`project`** | The class's **static** configuration: versioned with the document, proposable and reversible like any other part of it ([graph.md](graph.md)). |
| `input.banco_de_testes.*`, `input.referencia.*` | the **runner**, through [`resolve-executor-environment.ts`](../../packages/runner/src/dispatch/resolve-executor-environment.ts) | A file-system path and a live commit. Neither of the two is graph data, and neither survives being stored. |

The third row is the one `t270` opened. `banco_de_testes.caminho` names a
directory on **one** machine — written into a graph version, it would be wrong
for every runner but one — and `referencia.commit` is a live pointer, stale the
instant anything keeps it. So both come from the process that is about to open
the session, through a seam beside `resolveInput`
(`ClaudeCodeDispatchOptions.executorEnvironment`), and they are merged into the
resolved input just before the manifest renders:

```
input = { ...projetado_pelo_control_plane, ...ambiente_do_executor }
```

**The executor wins the collision**, and that is not a tie-break of convenience:
it is local truth about a file system and a `HEAD` the projection does not have,
and a projection carrying the same key would be carrying a stale copy of it.
Absent, it contributes `{}` and changes nothing — which is the common case: a
bets runner has no test bench, and neither has any deployment that has not built
one yet.

The two modes of `referencia.modo` are the manifest's vocabulary
(`implantar-release.json`), not the runner's invention, and each is read
differently:

- **`instalacao_em_uso`** — `git rev-parse HEAD`, **once**, memoized for the
  life of the process. It is a statement about THIS process, and rereading later
  would state something about a process that no longer exists. `lido_em` is
  memoized with it: the field says when the reference was read, and re-stamping
  it would claim a freshness the value does not have.
- **`ponta_do_principal`** (the default) — `git rev-parse <--main-branch>`, **on
  every call**. It is a fact about the repository, and it moves with every
  integration.

Four flags configure all of that, none of them mandatory: `--test-bench-path`
(default: the same `--working-dir`), `--reference-mode` (default
`ponta_do_principal`), `--reference-repo` (default: the bench) and
`--main-branch` (default `main`).

**Reading, and only reading — from this layer.** Nothing in
`resolve-executor-environment.ts` writes to the test bench, advances a branch or
prepares a checkout: `git rev-parse` and nothing else. It assumes a path and a
commit that already exist and merely reads them. A `git` that refuses here blocks
the job with a reason (the sixth cause of the table above) instead of resolving a
plausible value: a session that checked containment against a commit nobody chose
is worse than one that did not open. Whoever keeps that bench **true** — whoever
advances the main line into it and whoever prepares it — is `t273`, in the
section just below: until it, that read watched a directory nobody ever moved.

### Advancing the main line into the bench (`t273`)

`integrate-branch`'s manifest has always promised this — "you never perform the
final merge; ... it is IT that advances the main line onto the result" — and
until `t273` nobody kept the promise. The t109 game run is the evidence: the session reported
`merge_commit ae41796` with every gate green, the bench's `main` stayed on the
commit before it, and a person typed `git merge --ff-only ticket-1` by hand
before `testar` could open
([note](../../notas/2026-08-17-t109-game-feature.md), gap 3).

**What triggers it is the shape of the report, never a node id.** Any node whose
ACCEPTED report carries a non-empty `merge_commit` advances the bench — the field
is the contract (D9), so a second graph whose integration node declares the same
output is covered with no runner change at all. The gate is the same one the
transition already runs under: a resolved node, a session that completed, no
question pending, no retained worktree, and a report the control plane took.

**The bench moves before the work does**, and the two live in one function
([`report.ts`](../../packages/runner/src/dispatch/report.ts)'s `advance`) so that
the order is structural rather than remembered: there is no way to transition a
job whose bench did not move. The step itself is
[`advance-main-line.ts`](../../packages/runner/src/dispatch/advance-main-line.ts),
and it is exactly three commands, in this order:

| # | Command | When |
|---|---|---|
| 1 | `git -C <banco> rev-parse --abbrev-ref HEAD` | always — it has to be on the main branch, and a detached `HEAD` is refused by the same comparison |
| 2 | `git -C <banco> fetch <--working-dir> <merge_commit>` | only when the bench is not the working directory itself: the commit lives in the object store of the repository the session's worktree was cut from |
| 3 | `git -C <banco> merge --ff-only <merge_commit>` | always |

Then, and only then, one optional shell command in the advanced bench —
`--bench-install-command`. Absent it contributes nothing, the same posture
`comandos_de_dados` already has; the class declares its own spelling of it in the
graph's `project.comando_instalacao` (`npm ci` for this repository), and the flag
is where an operator points the runner at it. It comes from the command line and
never from a graph document: it runs with the runner's own privileges.

**Fast-forward or nothing.** A bench on another branch, a history that diverged
and an install command that exits non-zero all fail closed, and none of them is
worked around: no rebase, no `--force`, no picking a side, and — a project-wide
rule that applies doubly to a directory every integration touches — never a
`git stash`. Reconciling two histories is `integrar`'s job, in a worktree of its
own, with a session behind it.

**A refusal stops the work; it does not throw.** Same reading `t252` and `t265`
wrote down: a `git` that refuses here refuses identically on every retry, so a
throw would buy the same answer every couple of seconds forever with nothing in
anybody's inbox. The runner posts `POST /v1/jobs/:id/blocks` with the command and
what it printed (`blockForMainLineAdvanceFailure`, the sixth block of
[`blocks.ts`](../../packages/runner/src/dispatch/blocks.ts)), the job stays on
its node, and the dispatch resolves `{blocked: true, reason}`.

### A failure after the session came up also stops (`t265`)

`t198` took a real thesis to the bets graph's `triagem` node and collected **four
refused sessions in a row** before the fifth worked: `stop_reason: "refusal"`,
`stop_details.category: "reasoning_extraction"`, exit 1, zero output tokens and
~23k cache tokens burned on each one
([note](../../notas/2026-08-17-first-bets-run.md)). Nothing in the system
counted anything: the job went back to the queue, got a lease again and opened
the next session. What stopped the loop was the operator watching the log.

There are **two** holes, and they close from different sides of the API.

**The refusal is recognized, and it stops on the first.** The adapter started
reading `stop_reason`/`stop_details.category` from the terminal `result` frame
and reporting `failureKind: 'engine_refusal'` + `refusalCategory` in the
`SessionFinishDetail` — fields beside the status, and not a seventh
`SessionStatus`: the interface is frozen at v1 and the shape already existed
(`timed_out` + `timeout_reason`). The dispatch, seeing that `failureKind`, calls
`blockForEngineRefusal` (`packages/runner/src/dispatch/blocks.ts`) and returns
`{blocked: true, reason}` instead of throwing a `DispatchError`. It is the
**runner's** decision, taken with no read at all, because `onFinished` already
delivered the fact — the same posture as the five pre-session failures above. A
refusal is deterministic: retrying buys the same answer again.

**The ordinary failure has a ceiling, and the one that counts is the control
plane.** A session that died carries no signal telling it apart from one that
would die again, so it still throws and is still retried — what changed is that
the **sequence** now has an end. On closing a `failed` session,
`PATCH /v1/sessions/:id/finish` counts, inside its own transaction, the final
sessions of the `(job, node)` pair from the most recent backwards, stopping at
the first that did not fail; once the ceiling is reached, the job is blocked with
a reason naming the node and the count, and the `job.blocked` event carries
`consecutive_failures`. That lives in the control plane (`repositories/job.ts`)
and not in the runner because the sequence **crosses leases and processes** — the
runner dispatching the fourth attempt may never have seen the first three (D1).

The ceiling belongs to the graph document: `max_consecutive_failures` at the
root, absent meaning **3** (`docs/spec/graph.md` §1). Three details that are part
of the decision:

- **A session that worked zeroes the sequence.** The count is a tail count:
  failed, failed, worked, failed is *one* failure behind it, not three.
- **A refusal does not enter the count.** It has already been blocked by the
  runner on its first occurrence, and counting it here too would put two owners
  on the same flag — which is how a job ends up blocked with nothing pending.
- **A job already blocked is not blocked again.** The reason the person is
  reading is the first one; overwriting it would hide the cause behind a
  symptom.

What is still open, and is recorded as out of scope: if the runner dies between
the `PATCH /finish` and the refusal's `POST /blocks`, the job stays leasable for
one more session — which, being refused too, blocks on **its own** first
occurrence. The cost is one extra session, not the infinite loop.

### A report the control plane refused holds the job at the node (`t268`)

The third way a dispatch stops a job on its own account, and the first whose fact
**comes from a read**: the other two the runner decides alone, with what it
already has in hand.

Since `t253` the `PATCH /v1/sessions/:id/finish` checks the reported `output`
against the `output` schema of the skill the node pins — resolving `no_id` plus
the job's `graph_version_id` down to the registry's `(id, version)` row — and,
when it refuses, writes `null` into the column and the list of reasons into
`output_schema_error` in the event. Closing the session is never prevented by
that: the self-report of a work node was never evidence, and losing the session's
**end** over it would leave the session open forever.

What nobody did was **read that verdict**. The runner discarded the `/finish`
response — only a write failure survived — and decided the route by reparsing, on
its own account, the same `` ```resultado `` block the control plane had just
judged. Two readings of the same report, never compared: a refused report moved
the job down the edge all the same, and the next node received an `input`
projection with nothing inside — gap 2 of the
[second bets crossing](../../notas/2026-08-17-second-bets-run.md).

**The verdict started travelling in the answer.** `PATCH /finish` answers with
the session's projection plus `output_accepted` (always) and
`output_schema_error` (only on a refusal). Only that answer:
`GET`/`POST /v1/sessions*` still return what `toWireSession` assembles, because
*why* a report was refused is telemetry of the log and not part of the session —
what changed is the one question somebody needs answered **synchronously**, at
the instant they decide whether the job moves. There is no new column and no
migration: the verdict is computed where the check already happened and delivered
to whoever needs it.

**And the dispatch obeys.** With `output_accepted: false`, it calls
`blockForOutputSchemaRefusal` (`packages/runner/src/dispatch/blocks.ts`) and does
not call `advance` — it holds just the same for a single-exit node and for a
gate, because what is barred is the whole call and not the choice of an edge
inside it. The blocking reason names the node, the session and **all** the
schema's problems, for the same reason `output_schema_error` carries the whole
list: whoever unblocks has to fix the report, and a truncated list is a second
round of the same conversation.

**It stops on the first refusal**, like the engine refusal above. What was
refused is the report's **shape**, and a second session receiving exactly the
same prompt is being invited to produce the same shape again. Retrying with the
problems attached to the prompt is a real alternative and is another owner's
ticket: it asks for an attempt count crossing dispatches and a second decision
about how many are enough.

**One owner per flag, and an order between the two blocks.** Neither of the two
fires on a job a question has already stopped — ordinary escalation is already a
block, posted by the control plane in the same transaction as
`input_request.created`. And between them the refusal comes first: a refused
report is a more fundamental fact than a dirty tree — there is no result to
commit anything about —, and the same rule that forbids a second owner forbids
posting both.

What is left open, and is recorded as out of scope: the routing label
(`resultado`) and the vocabulary of the skill's `output` schema (`outcome`,
`evidencia`) are still two words for one concept — that is `t269`; and
`announceFinishedExecution` (`t262`) still announces a finished round from
`current_node_id` against `final_nodes` alone, without looking at the verdict.

### Every call has a deadline (`t193`)

A control plane that is down answers, and every method of the client already
knows what to do with the answer. The case that was missing is another: a control
plane that **accepts the connection and writes nothing** — a stuck process, a
proxy that held the request. With no deadline the call waits forever, and with it
the `tick()` that made it, the loop that waits for the tick and the shutdown that
waits for the loop.

Since `t193` there is a single HTTP mechanism for every client of the runner
([`http-client.ts`](../../packages/runner/src/controller/http-client.ts)), and it
does three things: it puts a deadline on every request, it reads the **status
before** decoding the body (`t156`'s discipline, now with a single owner —
whoever answers an error is not always the control plane, and a 502 in HTML
cannot become a raw `SyntaxError`) and it returns the error **the caller**
built.

| Deadline | Default | Who configures it |
|---|---|---|
| Any call to the control plane | 30 s | `--request-timeout-ms` |
| A heartbeat beat | the heartbeat's own interval (`ttl/3`) | derived, not configurable |

The heartbeat has a shorter deadline because it has a natural window: whoever
arms it knows how often the next beat falls due, and a beat still in the air when
the next one falls due renews nothing any more. For the same reason, **a beat
that did not come back is skipped, never overlapped** — otherwise a stuck control
plane would pile up one open request per interval, for the whole session.
Skipping costs one beat, and the TTL already tolerates two.

A call that runs past its deadline rejects with `AbortSignal.timeout`'s
`TimeoutError`, with no new type for anybody to catch. Nothing is retried here:
the failed tick is recorded and the loop asks again at the next interval, which
is the retry mechanism that already existed.

### Stopping always ends, and leaves no orphan session (`t193`)

Stopping a runner is a request, and it has three stages:

1. **The first SIGINT/SIGTERM.** The loop stops **scheduling**: no new tick is
   born. The dispatch in flight carries on — killing a live session from outside
   would leave a process writing into the worktree with nobody to report what it
   did.
2. **The grace period.** `--shutdown-grace-seconds` (default **120 s**) is how
   long that dispatch has to finish on its own. Once it is spent, the live
   session is cancelled.
3. **The second SIGINT/SIGTERM.** It waits for nothing: it cancels right there.

Cancelling reuses the path the dispatch already had for an end conducted by the
adapter — `cancelled` becomes `travada` in the taxonomy, the **worktree is
preserved** (a cancelled session did not conclude), the lease comes back through
the controller's `finally` and the final error is the `DispatchError` the loop
already records. Nothing new is written about "how a cancelled session is
closed": there is simply one more caller of what already existed.

Below that, every adapter registers a `process.on('exit')` while it has a live
session and signals SIGTERM to the process group on the way out. It is the safety
net for the exits the three stages above do not cover — an uncaught exception
somewhere else, a bare `process.exit()`. It is SIGTERM and nothing else:
`'exit'` is the process's last synchronous turn, and there is no event loop left
to escalate to SIGKILL five seconds later.

**The honest limit is still a limit:** a `SIGKILL` on the runner itself runs no
JavaScript at all, `'exit'` does not fire, and nothing inside this process
prevents that orphan. What stands against it is the lease expiring on the server
and the job going back to the queue (D5).

### Zero database access

Nothing in `packages/runner` imports a SQLite driver or any module of
`packages/core/src/db`. The rule is checked statically by
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs), which
runs in the lint over the whole repository, and it is exercised in the end-to-end
test: the control plane comes up as a **separate process**, and the only surface
between the two is the HTTP port.

And, since `t143`, on another **machine**:
[`cross-machine-dispatch.e2e.test.ts`](../../packages/runner/test/controller/cross-machine-dispatch.e2e.test.ts)
brings the binary up with `CARTOGRAFO_HOST=0.0.0.0`, reaches it over the
interface's real IPv4 address (not `127.0.0.1`) and runs the whole cycle —
granting, heartbeat, release — presenting **only** the credential pairing issued.
It is what turns `t124`'s configurable `CARTOGRAFO_HOST` into a proven path, and
not an option nobody ever exercised. Where the machine has no external IPv4
interface, the test skips instead of failing: what it would report there is the
absence of a network, not a regression.

---

## 5. Endpoints

All under `/v1` and, since `t124`, all demanding
`Authorization: Bearer <token>` — the runner presents a credential on every call,
like any other client of the API. Since `t196`, granting records `lease.granted`
and every lease the sweep kills records a `lease.expired`, both in the
transaction that writes the row. What is still without a trace is the ordinary
**release**, and for want of a type in the taxonomy — the item left over in §7.

Since `t143` the runner's credential is **its own**, issued at pairing, and the
"who calls" column below is contract, not convention: whoever pairs, revokes and
sees the whole fleet is the operator (a `usuario` credential), and the runner
only reaches the four routes of its own dispatch plus `GET /v1/jobs`. The
runner's route list is literal
([`auth.ts`](../../packages/core/src/auth.ts)): a new route is born outside it,
and that is how `GET /v1/runners` is the operator's without anything having been
written to refuse it — through the same door `GET /v1/executions` and
`GET /v1/sessions` already stay outside.

| Method | Route | Who calls | What it does |
|---|---|---|---|
| `POST` | `/v1/runners` | operator | Pairs a runner. `201` the first time — with `token`, the runner's credential, returned exactly once —, `200` (idempotent) with `token: null` if the `id` already exists. |
| `GET` | `/v1/runners` | operator | Lists the fleet with each runner's health: `active_leases`, `last_heartbeat` (the largest `heartbeat_at` of **any** lease it ever had) and `last_expiration` (`{job_id, expires_at, expiration_reason}` of the last one that ran out, or `null`). All derived from the `lease` table; there is no runner ping. |
| `POST` | `/v1/runners/:id/revocations` | operator | Revokes every live credential of that runner. `200 {revoked: <how many>}`, including `0`: calling again is not an error. |
| `POST` | `/v1/leases` | runner or operator | Claims the expired ones and tries to grant. `201` with the lease, or `200` with `{lease: null, reason}`. |
| `POST` | `/v1/leases/:id/heartbeats` | runner or operator | Renews the deadline. Optional body `{ttl_seconds}`; without it, the lease's TTL is kept. |
| `POST` | `/v1/leases/:id/releases` | runner or operator | Closes the lease and gives the slot back immediately. |
| `GET` | `/v1/leases` | runner or operator | Lists, with `project_id`, `runner_id` and `status` filters. No pagination at this stage. |

### The scope of the runner credential

The credential is born at `POST /v1/runners` (`201`), in the bootstrap token's
format: 32 random bytes in hex, returned once, kept only as a SHA-256 digest. It
is refused with `403 out_of_scope_credential` in two situations, and the
difference between them matters:

- **Outside the route list** — the list is literal, in
  [`auth.ts`](../../packages/core/src/auth.ts), and it holds for all the rest of
  `/v1`: proposals, skill import, graph mutation, the event stream. A new route
  does not come in by prefix; it comes in because somebody wrote it there.
- **Outside its own identity** — inside those routes, the credential holds for
  **one** `runner_id`. Asking for a lease for another runner, beating a heartbeat
  or releasing another's lease, or listing another's leases, are all `403`.
  `GET /v1/leases` with no filter is filled in silently with the credential's
  runner; with the filter pointing at another, it is refused.

Revoking (`POST /v1/runners/:id/revocations`) stamps `revogada_em` and nothing
else: the dead token falls into `401 invalid_credential` on the very next
request, along with the tokens that never existed. There is no reissue under the
same `id` — recovering a revoked runner's access means pairing it with a new
`id`.

The body of `POST /v1/leases`:

```json
{
  "runner_id": "runner-a",
  "project_id": 3,
  "job_id": 42,
  "runner_cap": 2,
  "project_cap": 4,
  "ttl_seconds": 30
}
```

Both caps arrive **as a parameter on every request**, not as persisted
configuration: no ticket on the board creates a project configuration table yet,
and inventing one here would be scope nobody asked for. The day one exists, the
default starts coming from it and the parameter becomes an override.

Error codes:

| Situation | Code | `error` |
|---|---|---|
| A runner `id` that is absent or empty | `400` | `id_required` |
| A request field absent or of the wrong type | `400` | `invalid_body` (with `field`) |
| An invalid listing filter | `400` | `invalid_filter` (with `field`) |
| A `runner_id` that is not paired (a lease request or a revocation) | `404` | `unknown_runner` |
| A lease that does not exist | `404` | `unknown_lease` |
| A runner credential outside its routes, or acting for another runner | `403` | `out_of_scope_credential` |
| A heartbeat or a release over a lease that is not `ativa` | `409` | `lease_not_active` (with `status`) |

A refusal by a cap or by a job already leased does **not** appear in this table:
it is a `200` with a `motivo`, for §3's reasons.

Implementation: [`routes/runners.ts`](../../packages/core/src/routes/runners.ts),
[`routes/leases.ts`](../../packages/core/src/routes/leases.ts),
[`auth.ts`](../../packages/core/src/auth.ts),
[`repositories/runners.ts`](../../packages/core/src/repositories/runners.ts),
[`repositories/leases.ts`](../../packages/core/src/repositories/leases.ts),
[`repositories/credentials.ts`](../../packages/core/src/repositories/credentials.ts),
[`controller/`](../../packages/runner/src/controller). Only `src/db/` touches the
SQLite driver (D1); repositories and routes are handed the database already open.

---

## 6. `job_id` is an opaque integer

`POST /v1/leases` **does not read the `job` table** and has no FK to it. The
original reason was build order (the table was `t102`'s delivery, which has since
landed in migration `0003`), but the cut stays for the design reason — the same
choice `t102` made for `graph_version_id`. Tightening the FK later is additive,
and it belongs to the ticket that wires the two sides together.

The division of responsibility that produces is, in fact, the correct one:

- **eligibility** (is the job blocked? which node is it on?) is decided by
  `GET /v1/jobs`, consulted by the controller **before** asking for the lease;
- **exclusivity and capacity** are decided by `POST /v1/leases`.

---

## 7. What this layer does not do yet

Every item here is another ticket's declared scope, not an oversight:

- **No event for the release.** The emission of
  [`lease.granted`](../../specs/events/schemas/lease.granted.schema.json)
  and [`lease.expired`](../../specs/events/schemas/lease.expired.schema.json)
  has been switched on since `t196` — the columns already carried everything the
  two events ask for (`runner_id`, `job_id`, `expires_at`,
  `expiration_reason`), and it was a direct mapping. **What is left over is the
  bigger gap:** `t98`'s taxonomy does not declare `lease.released`, and the
  reference reducer
  ([`reconstruct-state.mjs`](../../specs/events/reducers/reconstruct-state.mjs))
  projects `leases` with `active`/`expired` alone. The table has three states, so
  either the taxonomy gains a `lease.released`, or the event projection stays
  blind to the ordinary close — which is the most common case of all. Growing the
  taxonomy is another ticket's decision; `t196` switched on the two types that
  already had a contract and did not touch it.
- **Really opening a session** through the `EngineAdapter` — `despachar` is an
  injected callback (`t106`/`t109`). **Built by `t106`:**
  [`createClaudeCodeDispatch`](../../packages/runner/src/dispatch/dispatch.ts) is
  an implementation of that callback — it opens the session, records
  `session.opened` and `session.finished`, and turns an escalation request into a
  question through the API ([human-escalation.md](human-escalation.md)). The
  controller still does not know an engine exists: nothing in this file changed
  for that to happen, which was the point of the seam. **Closed by `t161`:** the
  node's instruction comes from the registered graph, no longer from a literal —
  [`resolve-node.ts`](../../packages/runner/src/dispatch/resolve-node.ts) reads
  the snapshot once per dispatch and
  [`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)
  fetches the pinned skill, checks the hash (a pin that does not match does not
  dispatch, D4) and renders the instructions, the node's contract, the checks and
  the permissions into the session. The **permissions** the manifest declares
  started holding in the same movement. **Closed by `t259`:** the two holes left
  in that same seam — `resolveInput`, which resolved `{}` and made every
  placeholder fail closed, now reads the real projection
  ([`GET /v1/jobs/:id/context`](../../packages/core/src/domain/context.ts),
  through
  [`resolve-input.ts`](../../packages/runner/src/dispatch/resolve-input.ts)), and
  the work node, which received an `output_schema` in the prompt and was never
  taught to return anything in it, now closes the turn with a `resultado` block
  ([`result-protocol.ts`](../../packages/runner/src/dispatch/result-protocol.ts))
  that the dispatch sends to `/finish` as `output` — which is exactly what the
  next node's projection reads. **Corrected by `t267`:** what a session receives
  today is four things, each with its own label — the manifest's body already
  interpolated, the **values** the skill's `input` names (the
  `### Valores de entrada` block, cut at 16 KB with a marker and a pointer to
  `GET /v1/jobs/:id/context`,
  [`render-input-values.ts`](../../packages/runner/src/dispatch/render-input-values.ts)),
  the node's `contrato` labelled as documentation, and the pinned skill's
  `output` labelled as what `/finish` checks (D9). Before that the session saw
  only the placeholders the manifest had remembered to cite, and was introduced
  to the node's `saida_schema` as though it were the validator — which it is not
  ([graph.md](graph.md)). What is still pending through the same hole is the
  **budget the skill declares**: `t163` gave the session two watchdogs (a wall
  clock and silence), with the manifest declaring `orcamentos` and the runner
  resolving by the smaller of the two
  ([`resolveBudget`](../../packages/runner/src/engine/resolve-budget.ts)), but
  whoever dispatches still uses the runner's ceiling — the field exists in the
  manifest and nobody reads it into the dispatch. It is one line in the same seam
  `t161` opened, and it belongs to the ticket that feels the pain.
- **Advancing a node and the end of a traversal** — also closed by `t161`, and
  cited here because both were gaps of this layer. A session that ends clean and
  does not escalate makes the transition POST itself, down the edge the graph
  dictates: a single exit goes straight through, a gate with two or more exits
  reads the fenced `resultado` block the session emitted, and a result that
  matches no edge becomes a question for a person (`ator.tipo: "sistema"`)
  instead of a failure. And `listarTrabalhosLiberados` started filtering by
  `concluido` as well as `bloqueado`: the field comes out of `GET /v1/jobs` since
  `t152`, derived from `current_node_id` against the version's `nos_finais`, and
  without reading it a job that landed on the final node stayed a candidate
  forever — the controller redispatched it to the same node on every tick.
- **The runner's life-cycle hygiene** — **closed by `t207`**, and cited here
  because all three halves were gaps of this layer. (1) Every `EngineAdapter`
  drops the session's heavy state as soon as it ends — the `ChildProcess`, the
  caller's listener, the buffers and the timers — keeping only the terminal
  `SessionStatus` per id, which is what invariant 3 of the frozen contract
  (`getStatus` answers after `onFinished`) actually demands; a long-lived runner
  stopped growing with every dispatched job. (2) `GitWorktreeManager.release()`
  runs `git status --porcelain` before removing: a session that ends **finished
  but with a dirty tree** has its tree **retained** and the job **blocked** by
  [`POST /v1/jobs/:id/blocks`](../../packages/runner/src/dispatch/dispatch.ts)
  with the tree's path in the reason, and does not advance — the old premise
  ("what was committed already lives in the branch's history") only held while
  the session committed, and nothing obliges it to commit. No new field in
  `/finish`: that route's vocabulary is `t213`'s (D20). (3)
  [`cartografo-runner prune`](../../packages/runner/src/cli/prune.ts) collects
  what is left over — `ticket-<id>-<hex>` directories that `git worktree list`
  recognizes and `ticket-<id>` branches —, asking the control plane, job by job,
  whether it is `concluido` (D1: the runner asks, it never guesses). `bloqueado`
  is **not** a signal of an ending: an unblocked job carries on from the same
  node, with a fresh tree. A branch goes with `git branch -d` and never `-D` —
  `concluido` says the traversal reached a final node, and says nothing about the
  commits having been merged —, and a refusal for "not merged" is an ordinary
  result, reported and with no effect on the exit code. **What is still out:** a
  TTL/expiry for the adapters' map of terminal statuses, reconciling a dirty
  session on its own (committing or discarding on somebody's behalf), a `--json`
  output for `prune` and scheduling built into it — whoever operates arms the
  cron outside, the same posture as the rest of this CLI. And `git worktree
  prune`, git's own, is still another command: it reconciles an orphaned record
  of a directory deleted by hand, which this one does not do.
- **Local mode** (evaluating a directory with no control plane): it has no schema
  and no acceptance criterion written anywhere in the repository. Revisit when
  there is a concrete use case.
- **A cap configuration table** per runner or per project (§5).
- **A sweep of the expired ones decoupled from the dispatch** (§3). What `t164`
  closed here is not the trigger but the **visibility**: `GET /v1/runners` (§5)
  and the screen's `/runners` page show, per runner, how many leases it holds,
  when it was last heard from and which job it lost to the TTL — and
  [`multi-runner-fleet.e2e.test.ts`](../../packages/runner/test/controller/multi-runner-fleet.e2e.test.ts)
  demands the whole cycle with a runner that stops beating. A routine that sweeps
  with nobody asking for work is still another ticket's scope.
- **A liveness signal independent of the lease.** `ultimo_heartbeat` and
  `ultima_expiracao` come out of the `lease` table alone: a paired runner that
  never picked up work is, to this control plane, indistinguishable from one that
  is down. A runner ping is additive, and it belongs to the ticket that feels the
  pain.
- **A WIP limit per stage of the graph** — here there is only the blunt cap on
  concurrent sessions.
- **Reissuing a credential for an already paired `id`.** `t143` closed the
  issuing at pairing and the revocation (§5), but only the `201` path issues: a
  runner that was revoked or lost its token comes back by pairing a new `id`. A
  rotation route is additive, and it belongs to the ticket that feels the pain in
  practice.
- **A scope per project or per graph node.** The runner credential's scope stops
  at "this family of routes, as this runner". A paired runner can still compete
  for work of any `projeto_id` it declares.
- **A limit on attempts** (rate limiting, blocking after N invalid or
  out-of-scope credentials). Nothing in this layer counts attempts.
