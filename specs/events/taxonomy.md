# Taxonomy of telemetry events — v1

The format of the telemetry log is a **public API**. It is what the
observability screen reads, what the pluggable topographers consume and what a
third-party integration will receive once the event stream exists. That is why
it is one of the four formats treated as a product, with a versioned schema and
a specification document (`notes/2026-08-14-extension-and-quality.md`,
organising principle and extension point 5).

This is the v1 specification. It delivers **a contract, not code**: no SQL
table, no endpoint, no server — the MVP's ordering (D6) puts control plane +
EngineAdapter + fixed graph before anything here turns into an implementation.

## Files

| File | What it is |
|---|---|
| `schemas/envelope.schema.json` | The fields that exist in every event |
| `schemas/<type>.schema.json` | One per event type (19) |
| `examples/example-log.jsonl` | One end-to-end execution, with all 19 types |
| `examples/expected-final-state.json` | The state that log reconstructs |
| `reducers/reconstruct-state.mjs` | The fold of the log down to that state |
| `tests/` | Node's native runner, with no `package.json` and no dependency |

To run them, from the root of the repository:

```sh
node --test "specs/events/tests/*.test.mjs"   # only this ficha
node --test                                             # everything there is
```

Passing the directory (`node --test specs/events/tests/`) does **not**
work on Node 25: from 23 onwards the positional argument is treated as a
file/glob path, not as a folder to sweep. Use one of the two forms above.

> **The count.** v1 was born with **15 types + the envelope = 16 files** in
> `schemas/` (ficha t98 spoke of "16 types"; its normative table is the one that
> held). The two-phase intake added the 16th type,
> `job.dependency_declared` (t122), and skill permission enforcement added the
> 17th, `session.permission_denied` (t125), and the hooks declared in the graph
> added the 18th, `job.hook_failed` (t169), and D21's end of execution added the
> 19th, `execution.finished` (t245), and the graph version's contract state
> added the 20th, `graph_version.contracts_checked` (t283) —
> growing is additive, and that is what the "an unknown type is ignored" rule
> buys. Today: **20 types + the envelope = 21 files**.

## The envelope

Every event carries the same eight fields. The type-specific payload lives
whole inside `data`, and nowhere else.

| Field | Type | What it is |
|---|---|---|
| `id` | integer | Monotonic, assigned by the server. **It is the order of the log** and the only total ordering that exists. |
| `type` | string | The discriminator, e.g. `"job.created"`. Every value has a schema that pins it with `const`. |
| `project_id` | integer | The project that owns the event. |
| `execution_id` | integer \| null | The execution the event belongs to; `null` when the fact happens outside a round. |
| `entity` | `{type, id}` | The subject of the event — the join key with the rest of the database. `type` ∈ `job`/`session`/`input_request`/`lease`/`graph_version`/`execution`. |
| `actor` | `{type, ref}` | Who caused it. `type` ∈ `user`/`agent`/`system`; `ref` is a free string (a login, an agent's role, a component's name). |
| `occurred_at` | string (date-time) | When the fact happened, ISO 8601. |
| `data` | object | The type's payload. |

`entity.id` is always the id of the entity named in `entity.type`: in
`session.finished` it is the session's id, in `graph_version.applied` it is the
hash of the snapshot (a string — D15), in `execution.finished` it is the
`execution_id` itself (an integer), never the id of the job behind it.

A whole event, as it comes out of the log:

```json
{"id":5,"type":"session.finished","project_id":1,"execution_id":7,
 "entity":{"type":"session","id":5001},
 "actor":{"type":"system","ref":"runner-a"},
 "occurred_at":"2026-08-14T09:41:22Z",
 "data":{"status":"completed","exit_code":0,
          "usage":{"input_tokens":18422,"output_tokens":3110,
                 "cache_creation_input_tokens":9004,
                 "cache_read_input_tokens":120344}}}
```

**Why one log, and not flowpilot's trio of tables.** D15 requires crossing graph
version × telemetry by join, and D9 treats contract/schema as a common spine.
Three separate formats would give three joins and three versioning schemes for
the same act of reading. The generic entity (`entity.type` + `entity.id`) is the
price of that, and it is a cheap price: whoever wants sessions only filters by
`entity.type = 'session'`.

## The append-only rule

**The only operation on the log is insert.** There is no update of an event,
there is no delete of an event, there is no correction of an event — a fact
recorded wrongly is corrected by another fact, never by overwriting.

It is explicit parity with flowpilot's rule 10, where the guarantee is one of
code and not of convention: `TicketEventRepository` exposes `create` and reads,
and nothing else, with a test that sweeps `app/` for a mass update/delete
against the table. When this specification's control plane exists, the
corresponding repository is born with the same restriction.

Three consequences that run through this whole ficha:

1. **No schema here describes a modification.** There is no `event.updated`,
   there is no revision field, there is no change stamp — `occurred_at` is the
   envelope's only time, because a "modified at" field in an append-only log
   would be a lie.
2. **Nothing flowpilot mutates in place becomes a mutable column here.** The
   `agent_sessions` row that is born `pending` and is updated until `completed`
   became two events (`session.opened`, `session.finished`); the
   `input_requests` row that is answered in place became three types. Current
   state is a projection (see [Replay](#replay-the-proof)), never the source.
3. **`MAX(id)` summarises the log.** Since nothing disappears, the largest id is
   a complete "something changed" cursor — the same property flowpilot uses
   today.

## The catalogue

19 types, in 6 groups. "Who emits" is the expected `actor.type`; the examples
show the content of `data` and came out of `example-log.jsonl`.

### Job

The job (the traveller) crossing the graph. `entity.type` = `job`.

#### `job.created` — [schema](schemas/job.created.schema.json)

Emitted when a job enters the graph, at the end of the intake. Actor: `user`
(manual creation) or `agent` (automatic breakdown of a job).

```json
{"title":"Specify the taxonomy of telemetry events","entry_node_id":"intake",
 "body":"A single log, with a common envelope and a generic entity.",
 "acceptance_criteria":["one schema per type","the reducer reproduces the final state"]}
```

`body` and `acceptance_criteria` are **optional** and came in with the two-phase
intake (t122): a job can be born with content, and one created by hand goes on
being born with a title only — in which case both arrive at the log as `null`,
like every optional field of this taxonomy. The criteria the intake records are
**preliminary**: what really produces them is the node that refines, out of the
raw request, and it rewrites the job through `job.amended`.

`fields` is the third optional one and came in with the per-class custom fields
(t168): a map of scalar values whose KEYS the class declares in its own graph
(`custom_fields`), not this taxonomy — `{"premise_source": "quarterly report",
"downside": -12.5}` in asymmetric bets (D14). A job born with no field at all
records `null`, and `null` is not `{}`.

#### `job.transitioned` — [schema](schemas/job.transitioned.schema.json)

Emitted when the job moves from one node to another. Actor: `system` (the
controller moves it; a node does not choose a path at runtime — principle 2 of
the README). `from_node_id` is `null` on the first transition.

```json
{"from_node_id":"refinement","to_node_id":"development"}
```

#### `job.blocked` — [schema](schemas/job.blocked.schema.json)

Emitted when the job stops moving **without leaving the node**: a fact about a
flag, not about movement. Actor: `system` normally, `user` when the block is
manual.

```json
{"reason":"awaiting the answer to input request 900"}
```

#### `job.unblocked` — [schema](schemas/job.unblocked.schema.json)

Emitted when the flag comes down. Actor: `system` or `user`. No payload — the
fact is the falling of the flag itself.

```json
{}
```

#### `job.amended` — [schema](schemas/job.amended.schema.json)

Emitted when the **content** of the job is edited. Actor: `agent` (the refiner
enriching the ficha) or `user`.

```json
{"changed_fields":["body","acceptance_criteria"]}
```

It carries the **names** of the fields and never the content. This is an audit
record, not a version history — the same discipline as flowpilot's `AMENDED`.
Whoever wants the new text reads the job.

#### `job.dependency_declared` — [schema](schemas/job.dependency_declared.schema.json)

Emitted at the **intake's confirmation**, once per edge declared between two
jobs of the same batch (t122). Actor: `user` — it is a human gate, and when
whoever confirms identifies themselves it is their login that stays in
`actor.ref`; t124 authenticated the API, but a token proves possession and not
a person, so the control plane goes on honestly recording `system`/`intake`
instead of inventing a user.

```json
{"depends_on_job_id":101}
```

`entity.id` is the **dependent** job and `data.depends_on_job_id` is the one it
depends on: "this one waits for that one" is a fact about the one that waits,
and it is on its timeline that somebody will look for the reason it did not
move.

Declaring the dependency does **not** block the dependent job. The edge is a
record; enforcing the order — blocking automatically, ordering dispatch — is
another ficha's decision, and a flag nobody knows how to lower would be worse
than no flag at all.

#### `job.hook_failed` — [schema](schemas/job.hook_failed.schema.json)

Emitted when the delivery of a **hook declared in the graph** (t169) exhausts
its six attempts and gives up. Actor: `system` (the control plane, which is what
tries). `entity.id` is the job whose transition or block fired the hook.

```json
{"hook_id":"notify-on-duty","node_id":"development",
 "url":"https://on-duty.example/cartografo","last_error":"HTTP 502"}
```

**It is an incident, not an outcome** — the same reading as
`session.permission_denied`. The job does not change node, is not blocked and
never finds out: a hook does not take part in the traversal, and that is
precisely why "a hook failure never stalls the traveller" is true by
construction rather than by a `try/catch` somebody has to remember to maintain.

**Why this type exists, if t142's webhook delivery never needed one.** A
webhook subscription has an owner: somebody registered it through the API and
can consult `last_error` on the delivery row. A hook has none — it is a line of
the graph document, and nobody is polling its queue. Without this event, the
reaction whoever wrote the graph declared would fail silently forever. Since it
enters through the transports that already exist (t123's stream, t142's
webhooks), the signal reaches whoever is listening with no extra work at all —
and an old client ignores it, by the "an unknown type is ignored" rule.

**Only on exhaustion, never per attempt.** A transient failure — the consumer
restarting, a 502 lasting two minutes — is retried and goes away on its own;
recording an event for each one would fill the log with noise that corrects
itself. Success, by symmetry, is mute: `status='delivered'` on the delivery row
and nothing more.

### Session

The execution of an agent by an EngineAdapter. `entity.type` = `session`.

#### `session.opened` — [schema](schemas/session.opened.schema.json)

Emitted when the runner dispatches the session. Actor: `system` (`ref` = the
runner). `job_id`/`node_id` are optional: not every session serves a job.

```json
{"job_id":101,"node_id":"refinement","engine":"claude-code",
 "engine_session_ref":"cc-9f2b41d0","working_dir":"/Users/rafael/cartografo-ticket-98",
 "prompt":"Refine job 101 against the project conventions.","timeout_seconds":5400,
 "silence_seconds":900}
```

The two budgets are independent and optional (t163): `timeout_seconds` is
wall-clock, `silence_seconds` is how long the session may go without producing
any output at all. `null` in either of them is "declares no policy of its own",
never "zero".

`engine_session_ref` is the session's id in the engine's own vocabulary, and it
is what makes resuming possible after a quota pause — which is why it is
recorded as soon as it is known, not at the end.

#### `session.finished` — [schema](schemas/session.finished.schema.json)

Emitted at the end of the session's life. Actor: `system`. `status` ∈
`completed`, `failed`, `stuck`, `timed_out`, `quota_paused`, `resume_failed`.

```json
{"status":"timed_out","exit_code":null,"usage":null,"timeout_reason":"silence"}
```

The four statuses beyond completed/failed exist so that a healthy outcome
(`quota_paused` — out of fuel, resumable), an invalid ref (`resume_failed`) and
a stop of our own (`timed_out`) are never read as a bug to investigate.

**The two stops of our own are one single `status`.** The runner has two
independent watchdogs — wall-clock and silence (t163) — and both end up in
`timed_out`. What separates them is `data.timeout_reason` (`wall_clock` |
`silence` | `null`), not one more status: growing the status vocabulary was
rejected once, for quota states, and the reasoning holds identically — "the real
reason lives in the event log, which is append-only and loses nothing"
(`docs/formats/engine-adapter.md`, *Rejected — a richer `SessionStatus`*).

A course correction, recorded instead of erased: until t163 this section
described `stuck` as "stopped by silence", in a 1:1 port of flowpilot's
`STALLED`. That port was never built, and the only place that produces `stuck`
today (`TAXONOMY_STATUS`, `packages/runner/src/dispatch/`) uses it as the slot
for whoever has no slot — `pending`, `running` and `cancelled` have no
counterpart here. `stuck` has no relation at all to silence, and the sentence
that said otherwise was an aspiration documented as though it were a fact.

`usage` is `null` when the engine reported nothing — **never collapse into
zero**. There is no cost field: cost is engine vocabulary, and the log is
neutral.

And until t172 that `null` was *always*: the Claude Code adapter sent `usage:
null` hard-coded, because usage counting was in "Out of scope (v0)" in
`docs/formats/engine-adapter.md`. Every session this system ever ran recorded
zero cost data, and the placeholder was indistinguishable from an honest absence
— which is precisely why it lasted so long. That CLI's terminal `result` frame
always carried the count; what was missing was somebody reading it.

`models` (t172) is the identity that never existed anywhere in this taxonomy:
`session.opened.engine` says which ENGINE ran (`claude-code`, `codex`) and
nothing said which model. "Cost per model" had no answer because the datum was
never collected, not because aggregation was missing.

```json
{"status":"completed","exit_code":0,
 "usage":{"input_tokens":2,"output_tokens":5,
        "cache_creation_input_tokens":3022,"cache_read_input_tokens":15688},
 "timeout_reason":null,
 "models":["claude-haiku-4-5-20251001","claude-sonnet-5"]}
```

**It is a list, and the example above is from a real execution.** A single turn
of the CLI returned two models — the main turn's and that of a cheaper helper —
and collapsing into "the" model would attribute the whole bill to the wrong one,
which is the same damage the `usage` rule avoids for tokens. `null` is "the
engine named none"; an empty list is not an answer, and the schema refuses it
(`minItems: 1`). The set of values is open: the identifier is whatever the
engine reported, and a closed enum would demand a schema change for every new
model.

**What `models` does not promise.** It says which models ran, never how the four
counts of `usage` divide between them — that split exists in the engine's frame
and does not cross over to here, because `usage` is a single total. A
two-model session goes whole into both when somebody aggregates by model, and
that is what the cost lens reads.

**The node's structured report, and the verdict on it** (`t253`, `t268`).
`output` is what the session reported from the node — the object the next node's
`input` projection is built from — and it is checked, at closing time, against
the `output` schema of the skill the node pins (D9). When that check refuses,
`output` goes to `null` and the reasons travel whole in `output_schema_error`;
the terminal status is recorded either way, because losing the end of the
session over a malformed self-report would be strictly worse — a work node's
self-report was never evidence.

`output_accepted` is the same fact seen from the side of whoever acts: the list
says *why* a report was refused and exists only when there was a refusal; the
boolean says *whether* it was accepted, and is recorded on **every** closing —
`true` when nothing was reported and when the report matched, `false` only on a
refusal. It exists because the one who reads it is the runner, in the response
of `PATCH /finish` itself, to decide whether the job moves: until `t268` that
verdict was discarded and the route was chosen from a second parse of the same
block, so a report the control plane had refused moved the job along the edge
regardless.

#### `session.permission_denied` — [schema](schemas/session.permission_denied.schema.json)

Emitted when the session tries to use a tool its permission policy denied
(t125). Actor: `system` (the runner, which is what sees the refusal go past in
the engine's stream). `resource` ∈ `filesystem`, `network` — the two axes the
skill manifest declares.

```json
{"resource":"network","tool":"WebFetch",
 "reason":"Claude requested permissions to use WebFetch, but you have not granted it."}
```

**It is an incident, not an outcome.** There is no `UPDATE` on the session's row
and there is no status transition: the session goes on, and may be denied again
— the log is append-only and a second denial is a second fact. Ending a session
over a repeated denial would be an escalation policy, and nobody has decided
that yet.

`tool` carries engine vocabulary inside the log on purpose (`WebFetch`,
`Bash(curl *)`). It is the exception the "the log is neutral" rule accepts for
the same reason `session.opened` carries `engine`: without the exact name that
was denied, the denial is not auditable.

**What this event does not promise.** It records what the gating by tool name
caught, not everything the session tried. Measured against the real CLI: a tool
denied by name is never even offered to the model, so there is never an attempt
and never an event — what shows up here is the denial of a *pattern*
(`Bash(curl *)`), which is refused at the call. The absence of an event means
"did not try, or was not offered", never "nothing was blocked". The residual gap
is written down in `docs/formats/engine-adapter.md`, "The session's
permissions".

### Input request

Human escalation as a first-class entity. `entity.type` = `input_request`.

#### `input_request.created` — [schema](schemas/input_request.created.schema.json)

Emitted when an agent needs something from the human in order to continue.
Actor: `agent`. `kind` ∈ `question` (I need to know something) / `approval` (a
manual gate wants an OK on an artefact) — the same animal, the same queue, the
same loop.

```json
{"job_id":101,"session_id":5001,"node_id":"refinement","kind":"question",
 "question":"Do I unify flowpilot's trio of tables into a single event log, or port the three separately?",
 "context":"D15 requires crossing graph version with telemetry by join, which is cheaper with a single log.",
 "options":["Unify into a single log","Port the three separately"],
 "recommendation":"Unify into a single log, with a common envelope and a generic entity",
 "default_answer":"Unify into a single log, with a common envelope and a generic entity",
 "auto_approvable":true}
```

`auto_approvable` is carried explicitly because "no options and no default" was
never a good proxy for unapprovable: a question only the human can answer needs
to say so, not hope that its shape suggests it.

`node_id` is which **node** the question came from, stamped by the server from
the position of the owning job — never coming from the request's body. Without
it, "which stages stop to ask for a person most often?" can only be answered by
reconstructing the traversal event by event, and the per-node escalation policy
([graph.md](../../docs/spec/graph.md), §2) would be a policy nobody can
evaluate. Optional: `null` is "it is not known which node it came from" — a job
with no position, or a question recorded before the field existed.

#### `input_request.answered` — [schema](schemas/input_request.answered.schema.json)

Emitted when a human answers. Actor: `user`.

```json
{"answer":"Unify into a single log, with a common envelope and a generic entity","answered_by":"rafael"}
```

#### `input_request.auto_resolved` — [schema](schemas/input_request.auto_resolved.schema.json)

Emitted when the auto-approval gate answers on the human's behalf. Actor:
`system`. `based_on` ∈ `recommendation` / `default_answer` / `precedent`.

```json
{"answer":"Port the 12 nodes as they are; regrouping is another ficha's decision","based_on":"recommendation"}
```

Two types instead of one event with an `answer_source` column: `type` is already
the discriminator of all the rest of the log, and the guarantee that matters —
the audit **always** distinguishes approved-by-user from approved-by-system —
is stronger when it is the identity of the event that carries it, not a field
inside it.

### Lease

A runner's possession of a job, with a deadline (D5). `entity.type` = `lease`.

#### `lease.granted` — [schema](schemas/lease.granted.schema.json)

Emitted when the controller dispatches a job to a runner. Actor: `system`.

```json
{"job_id":102,"runner_id":"runner-b","expires_at":"2026-08-14T11:30:05Z"}
```

#### `lease.expired` — [schema](schemas/lease.expired.schema.json)

Emitted when the possession lapses and the job goes back to the queue. Actor:
`system`. `reason` ∈ `heartbeat_lost` (the runner stopped signalling before the
deadline) / `ttl_elapsed` (the deadline passed with no renewal).

```json
{"runner_id":"runner-b","reason":"heartbeat_lost"}
```

### Graph version

The graph lives as versioned data, with git-like semantics inside the database
(D15). `entity.type` = `graph_version`, and `entity.id` is the **hash of the
snapshot** — a string, not an integer.

#### `graph_version.registered` — [schema](schemas/graph_version.registered.schema.json)

Emitted when a new version enters the database. Actor: `user` (manual
registration) or `agent` (the synthesizer, outside the PoC). `source` ∈
`synthesizer` / `manual` / `proposal`.

```json
{"graph_id":"software-dev","parent_version":"sha256:1a0b7e55","source":"manual"}
```

**Registering does not move the pointer.** A version can exist in the database
without ever having held; what moves it is the next event.

#### `graph_version.applied` — [schema](schemas/graph_version.applied.schema.json)

Emitted when the current-version pointer comes to point at this version. Actor:
`user` (a human gate) or `system` (auto-application of a low-risk mutation, the
final rung of the safety ladder — principle 5 of the README).

```json
{"graph_id":"software-dev"}
```

#### `graph_version.reverted` — [schema](schemas/graph_version.reverted.schema.json)

Emitted on a rollback. Actor: `user` or `system`. `entity.id` is the abandoned
version; `target_version` is where the pointer went back to.

```json
{"graph_id":"software-dev","target_version":"sha256:1a0b7e55",
 "reason":"the new review node doubled the traversal time without moving the approval rate"}
```

A rollback moves a pointer and **nothing is erased**: the abandoned version
stays in the database with its telemetry, which is exactly what the topografo
will cross-reference later.

#### `graph_version.contracts_checked` — [schema](schemas/graph_version.contracts_checked.schema.json)

A version carries a contract-check state — `checked` / `unchecked` / `failed` —
and this is the fact of it MOVING (`t283`). Actor: always `system` /
`control-plane`; the control plane asserts it about itself (D1).

```json
{"state":"checked","problem_count":0}
```

**Only the re-check emits it, never a version's birth.** A version is born with
a state already computed (`POST /graphs` runs the check against the registry, a
fork copies its base's answer, applying a proposal recomputes), and that instant
already records `graph_version.registered` + `graph_version.applied` — a third
event for the same moment would repeat what the envelope already says, the same
reasoning `execution.finished` writes for its empty payload. What has no other
witness is the LATER move: registering a skill manifest re-judges every version
that pinned it and could not be checked, and each version that moves records
this.

**`problem_count`, not the report.** The problems are on the version row and one
`GET /v1/graph-versions/:id` away; carrying them here as well would put one
object in two places with no way to keep them agreeing — the same call
`job.blocked.consecutive_failures` makes.

### Execution

The whole round, as the subject of a single fact (D21). `entity.type` =
`execution`, and `entity.id` is the `execution_id` itself — an integer, like
almost everybody else's here.

This group **corrects a frame that predates the decision**. Until D21 the
taxonomy said that an execution was not an event entity: `execution_id` was an
opaque grouper and that was that, and that is what is still written in the
header of migration `0003` and in that of
`packages/core/src/routes/executions.ts`. Both predate D21, which recorded the
opposite — "at the end of every execution, the control plane declares the
execution finished (a fact only it asserts, D1)". The entity is born to carry
that fact, and only it: there still is no `execution` table, and the
`finished_at` the API publishes is derived from this event at read time, never a
column.

#### `execution.finished` — [schema](schemas/execution.finished.schema.json)

Emitted when **every** job of the round has reached a final node of its graph
and **no active lease** holds any of them any more. Actor: always `system` /
`control-plane` — the one that asserts is the control plane about itself (D1),
never the actor that happened to push the job that closed the account.

```json
{}
```

**No payload**, for the same reason as `job.unblocked`: the envelope's
`execution_id`, `entity.id` and `occurred_at` already say which round ended and
when, and repeating that inside `data` would be duplicated data within the event
itself.

**Once, forever.** The fact is recorded the first time the condition holds, in
the SAME transaction as the transition that made it true, and never again — a
job that leaves the final node and comes back does not produce a second event.
Zero jobs never satisfies the condition: a round with no job at all is not a
finished round.

**What it still does not see.** The check runs on the job's path
(`transitionJob` and `createJob`, in `packages/core/src/repositories/job.ts`)
and nowhere else. An ordinary lease release records no event — the taxonomy does
not declare `lease.released`, a gap known since t196 — so the round whose last
job arrives WITH its lease still active (which is the common case for the real
runner: it releases the lease after reporting the transition) will only be
declared finished if some job of it moves again afterwards. Closing that is the
ficha that links `lease` and `job` from both sides, as the header of migration
`0004` already foresees.

## Parity with flowpilot

Checked line by line against `~/flowpilot/app/models/ticket_event_model.py`,
`agent_session_model.py` and `input_request_model.py`. flowpilot is a reference
of behaviour, not a code dependency (D17).

Legend: **=** direct equivalence · **≠** justified divergence of model · **+**
an extension of cartografo with no counterpart there.

### `ticket_events` → job events

| flowpilot | cartografo | | Note |
|---|---|---|---|
| `EventKind.CREATED` | `job.created` | = | `entry_node_id` in place of the fixed initial state. |
| `EventKind.STATE_CHANGE` + `from_state`/`to_state` (`TicketState`) | `job.transitioned` + `from_node_id`/`to_node_id` | ≠ | cartografo has no fixed states: the path is the graph, frozen per version (principle 2, D2). An enum of 12 states in the event's schema would tie the log to one graph. |
| `EventKind.BLOCKED` | `job.blocked` | = | A free `note` becomes a required `reason`. |
| `EventKind.UNBLOCKED` | `job.unblocked` | = | |
| `EventKind.AMENDED` + `note` (comma-separated names) | `job.amended` + `changed_fields` | = | The same discipline (names only), with the payload typed as an array instead of a string. |
| — | `job.dependency_declared` | + | There the order between tickets is a convention of the human who creates them; here the intake breaks a request into a batch and the edge between two jobs of the batch is a fact of the log (t122). |
| `EventKind.INPUT_REQUESTED` + a row in `input_requests` | `input_request.created` | ≠ | There they are two things: the flag event and the content row. Here a single event, because the log is already the source of the content. |
| `EventKind.INPUT_ANSWERED` + `answer_source='user'` | `input_request.answered` | ≠ | The source of the answer became the type of the event. |
| `EventKind.INPUT_ANSWERED` + `answer_source='auto'` | `input_request.auto_resolved` | ≠ | Likewise. |
| `EventKind.SERVICE_CLASS` | — | | Out of scope: D16 does not ask for job urgency in the PoC. An additive extension if wave 2 needs it. |
| `ActorType.USER/AGENT/SYSTEM` | `actor.type` `user`/`agent`/`system` | = | Translated, not remodelled. |
| `actor_ref` | `actor.ref` | = | |
| `occurred_at` | `occurred_at` | = | A single time stamp, for the same reason as there. |
| `id` (BigInt autoincrement) | `id` | = | Monotonic, from the server, and the order of the log. |
| `ticket_id` (FK) | `entity` `{type:"job", id}` | ≠ | A generic entity: the same log carries session, input request, lease and graph version. |
| `note` (free text) | `data` (an object per type) | ≠ | A payload typed by schema instead of an interpretable string. |

### `agent_sessions` → session events

The `agent_sessions` row is born `pending` and is **updated** until a terminal
status. Here it is two events and no update — it is this ficha's structural
divergence.

| flowpilot (column) | cartografo | | Note |
|---|---|---|---|
| creation of the row (`pending`) | `session.opened` | ≠ | An event, not a mutable row. |
| terminal `status` | `session.finished.status` | ≠ | 6 values against 9: `pending`/`running` are not outcomes (the opening is already an event of its own). |
| `SessionStatus.COMPLETED/FAILED` | `completed`/`failed` | = | |
| `STALLED`/`TIMED_OUT` | `timed_out` + `data.timeout_reason` | ≠ | Two statuses there, one status and a cause here (t163). `stuck` is **not** the port of `STALLED`: it is the slot for `pending`/`running`/`cancelled`, which have none. |
| `PAUSED_QUOTA`/`RESUME_FAILED` | `quota_paused`/`resume_failed` | = | |
| `CANCELLED` | — | | **Not ported in v1** (it is not in the ficha's table). If the PoC needs to cancel a session, it is an additive addition to the enum. |
| `engine`, `engine_session_ref` | the same in `session.opened` | = | The border of LLM independence. |
| `working_dir`, `prompt`, `timeout_seconds` | the same | = | |
| `last_output_at` (the silence clock) | `session.opened.silence_seconds` + `session.finished.timeout_reason` | ≠ | There it is an instant updated on the row and swept from outside; here it is the budget at the opening and the cause at the end, with nothing mutable in between. |
| `stage` (the flow's state) | `node_id` | ≠ | A node of the graph, for the same reason as `job.transitioned`. |
| `ticket_id` | `job_id` (optional) | = | Optional there and here: not every session serves a job. |
| `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | `usage.{...}` | = | Identical names, on purpose. `null` ≠ zero, also on purpose. |
| `exit_code` | `exit_code` | = | |
| `log_path`, `worktree_path`, `branch`, `silence_seconds`, `quota_resets_at`, `last_output_at`, `processed_at` | — | | **Not ported in v1**: they are the controller's bookkeeping and local paths, not audit facts. Revisit when the control plane exists. |

### `input_requests` → input-request events

| flowpilot (column) | cartografo | | Note |
|---|---|---|---|
| creation of the row | `input_request.created` | = | |
| `kind` (`question`/`approval`) | `data.kind` (`question`/`approval`) | = | The same thesis: a question and an approval are the same animal. |
| `status` (`pending`/`answered`) | — (derived) | ≠ | It exists as a projection of the reducer, not as a field: the log says what happened, the state says where it stopped. |
| `answer_source` (`user`/`auto`) | — (the type of the event) | ≠ | `input_request.answered` vs `input_request.auto_resolved`. |
| `question`, `context`, `options_json`, `recommendation`, `default_answer` | `question`, `context`, `options`, `recommendation`, `default_answer` | = | Translated. |
| `auto_approvable` | `auto_approvable` | = | The same reason to exist. |
| `answer` | `answer` | = | |
| `answered_by` (FK `users`) | `answered_by` (a string) | ≠ | There is no user entity in the PoC; a free string, like `actor.ref`. |
| `session_id`, `ticket_id` | `session_id`, `job_id` | = | `session_id` optional for the same reason as there: the answer outlives the session. |
| `resumed_at` | — | | **Not ported in v1**: an idempotency marker of the controller, not an audit fact. |

### cartografo's extensions

| cartografo | | Why |
|---|---|---|
| `lease.granted`, `lease.expired` | + | D5: with N runners, the work of a dead runner goes back to the queue. flowpilot has a single runner and does not have the problem. |
| `graph_version.registered`, `.applied`, `.reverted` | + | D15: in flowpilot the flow is code, so there is nothing to version in a database. Here the graph is data, and it is the row the topografo cross-references with the telemetry. |
| `execution_id` in the envelope | + | There is no "execution" entity in flowpilot. |
| `execution.finished` + `entity.type = execution` | + | D21 amends the "there is no execution entity" this ficha wrote before it: the round has no table, but it has a fact — the control plane declaring its end (D1) — and a fact needs a subject. There the end of a round does not exist as a concept: every ticket finishes on its own account. |
| a generic `entity` | + | A single log for the trio of tables over there. |

## Replay: the proof

The quality non-negotiable is **replayability by event sourcing**: graph vN +
inputs ⇒ an execution replayable from the log. This ficha's executable proof is
`reducers/reconstruct-state.mjs`, which folds the log and returns:

```
{ jobs:           {[id]: {current_node_id, blocked, node_history}},
  sessions:       {[id]: {status, exit_code}},
  input_requests: {[id]: {status, answer, answer_source}},
  leases:         {[id]: {status}},
  current_graph_version: {[graph_id]: version_id},
  executions:     {[execution_id]: {finished_at}} }
```

`tests/replay.test.mjs` runs the reducer against `examples/example-log.jsonl`
and compares it with `examples/expected-final-state.json`, computed by hand from
that same log. For as long as that equality holds, the log is sufficient: no
final state needs another source.

Four decisions of the reducer that are, in practice, decisions of the format:

- **The order is that of `id`**, not that of the list received. Whoever reads
  from a file, from a paginated response or from an out-of-order stream arrives
  at the same state. `occurred_at` would not serve: two events can carry the
  same stamp.
- **An unknown type is ignored**, it is not an error. An old client reading a
  new log goes on reconstructing what it understands — it is what makes the
  taxonomy extensible additively.
- **`answer_source` goes back to being a field** in the input-request projection
  (`user`/`auto`), collapsing the two event types back into flowpilot's
  `answer_source`. In the log the source is an identity; in state, whoever reads
  wants to compare.
- **`job.amended` moves nothing.** It is a fact about content, not about flow —
  which is why it carries only field names.

## Outside the scope of v1

- **Proposal/topografo events** (`proposta.*`) — the topografo is outside the
  PoC (D6, D16). A wave-2 ficha.
- **`service_class`** (urgency) — D16 does not ask for it in the PoC.
- **Transport to the outside** — it left here, in both halves, and neither of
  them touched this envelope: `GET /v1/events/stream` delivers this same object
  over SSE, with a filter by `project_id`/`type` and reconnection by `id`
  ([`docs/spec/events-stream.md`](../../docs/spec/events-stream.md), t123), and
  the signed webhooks deliver it by `POST`, with HMAC-SHA256 of the raw body and
  retry with backoff
  ([`docs/spec/webhooks-events.md`](../../docs/spec/webhooks-events.md), t142).
  Both are consumers of the same `listEvents`, and neither of them writes to the
  log.
- **A SQL table and endpoints** that really record this — D6.
- **A hash/version of the event schema itself** — this is v1; it freezes only
  after two real consumers (the rule of two consumers). Until then, additive
  changes are expected, and v1 is a contract between this ficha and the building
  fichas that come after it, not a promise to third parties.
