# Specification: intake — from the request to the breakdown into tickets on the graph

**API version:** `v1` · **Migration:** [`packages/core/migrations/0006_intake.sql`](../../packages/core/migrations/0006_intake.sql)
**Founding decision:** [D3](../../DECISIONS.md) — synthesizing the topology and
breaking down the work are **two acts**: the first produces nodes (once per
class), the second produces tickets (once per execution), and the path stays
frozen during the execution

Until now work entered the graph through `POST /v1/jobs`, with a title, an entry
node and nothing else: no body, no acceptance criterion, no relation between
tickets. This layer is D3's second act — take a request in natural language,
already decomposed into items, **propose** the breakdown over the class's
registered graph, and only create the `trabalho` rows once a human has confirmed.

The sentence that sums up the design: **intake proposes, the human confirms, and
none of it touches the graph.** Confirming a draft creates travellers; it creates
no graph version, moves no pointer, changes no node.

---

## 1. Two phases, and why not one

| Phase | Route | What it writes | What it emits into the log |
|---|---|---|---|
| Propose | `POST /v1/intake` | One row in `intake_draft` | Nothing |
| Confirm | `POST /v1/intake/:id/confirmations` | N `job` + M `job_dependency` | N `job.created` + M `job.dependency_declared` |

The draft **emits no event at all** — not when it is born, not when it is edited,
not when it is discarded. It is storage for work in progress, not an audit fact:
the log only gains a row when a traveller actually comes into being. That is why
the `intake_rascunho` projection can be updated in place without hurting the
log's append-only rule
([taxonomy](../../specs/events/taxonomy.md)): nothing in it is
reconstructed from the log, because nothing of it was ever recorded there.

The confirmation is a plural subresource (`/confirmations`, `/discards`) and not
a status field somebody edits, for the same reason the job has `/transitions` and
`/blocks`: each one corresponds to a distinct **fact**.

**What is outside:** how the draft is PRODUCED from the request in natural
language. `items` arrives already decomposed in the request body, whether it
comes from a person typing, from an agent session run separately, or from a
future chat screen. This layer dispatches no session and knows no engine.

---

## 2. The item, and what intake guarantees about it

```json
{"ref": "migracao",
 "title": "Migração 0005",
 "body": "Colunas novas em trabalho e as duas tabelas do intake.",
 "acceptance_criteria": ["a migração roda do zero"],
 "tier": "standard",
 "depends_on": ["dominio"]}
```

`ref` and `title` are required; `body`, `acceptance_criteria`, `fields`, `tier`
and `depends_on` are optional. `ref` is an identity **local to the batch**: it
exists so that one item can cite another, and it dies at confirmation, when every
`ref` becomes a real `job.id`.

The item's keys have spoken English since t255
([the glossary](glossario-wire.md) §1.1): they travel in the body of
`POST /v1/intake`, which is what D20 calls "the fields and query parameters of
the API's JSON". Nothing answers to the old spelling — an item with `titulo`
comes back as `missing_required_field`, because `title` is the required one.

The criteria intake writes are **preliminary**. What really produces them is
factory graph 1's `refinar` node, whose contract takes `{ticket_id, pedido}` and
returns `{especificacao, criterios_de_aceite, ...}`
([`factory-graphs/software-development/grafo.json`](../../factory-graphs/software-development/grafo.json)).
Demanding a complete acceptance criterion on the way in would be asking intake to
do the graph's work.

The validation lives in
[`packages/core/src/domain/intake.ts`](../../packages/core/src/domain/intake.ts),
a pure function with no `Database` — the same spirit as `domain/graph.ts` and
`domain/operations.ts` — and it returns **the whole list of problems**, never the
first one (`validateItems`, line 242):

| Code | When |
|---|---|
| `invalid_list` | `items` is not a list, or is an empty list |
| `invalid_item` | an item is not an object |
| `missing_required_field` | `ref` or `title` is missing |
| `invalid_field` | `body`, `acceptance_criteria`, `fields`, `tier` or `depends_on` has the wrong shape |
| `duplicate_ref` | two items of the batch use the same `ref` |
| `unknown_dependency` | `depends_on` cites a `ref` belonging to no item of the batch |
| `self_dependency` | the item cites its own `ref` |
| `dependency_cycle` | the dependencies close a cycle |

Every problem is `{code, message, target}` — the same shape as the graph report
(§5.3 of the glossary), and in English since t255 for the same reason as the
item: that report IS the body of the `400`.

The first two field codes are the ones the route beside it already answered with
(`missing_required_field`, `invalid_field`): t255 folded the validator's two into
them rather than translating them, so that one item does not come back with two
spellings of the same problem.

The cycle is hunted by depth-first search with three colours (`findCycles`, line
209). Grey = on the current path, black = already closed: hitting a grey one is a
cycle, hitting a black one is only a node reached twice. A diamond — `a` depends
on `b` and on `c`, both depending on `d` — is a perfectly good breakdown, and a
traversal that confuses the two rejects precisely the shape a real batch has.

---

## 3. Confirming: one transaction, three writes

[`repositories/intake.ts`](../../packages/core/src/repositories/intake.ts),
`confirmDraft` (line 258). The order inside the transaction is not decoration:

1. **It rereads the class's current pointer.** The route resolves
   `getClassBase` → `getVersion` at confirmation time, not at proposal time:
   between proposing and accepting, the class may have gained a version, and the
   travellers belong to the one that holds now.
2. **It creates one `job` per item**, all at the `no_inicial` of the version in
   force, all with its `graph_version_id` and with the draft's
   `project_id`/`execution_id`. Every creation writes `job.created`.
3. **Only then does it write the dependencies.** An edge can only be recorded
   once both ends have a real id — `ref` is local to the batch and dies here.

All of that is **one SQLite transaction**: every job, every dependency and every
event go in together or none goes in. The nested `db.transaction` of `createJob`
becomes a savepoint in `better-sqlite3`, the same composition human escalation
already uses.

The draft's final `UPDATE` is guarded by `AND status = 'pendente'` and the whole
transaction falls if it does not affect exactly one row: confirming twice is a
`409`, never two batches of work.

### The confirmation's actor

The gate is human by design, and `t124` authenticated the API — but a token
proves possession, not identity: whoever presents the operator credential could
be anybody on the team, and the control plane has no way of saying which. Rather
than invent a user, the log honestly records the component that acted —
`INTAKE_ACTOR`, `sistema`/`intake` (line 47) — and whoever knows who is on the
other side sends `ator` in the confirmation's body, as in any other write of this
API.

> **A note on scope.** The ticket also listed `ator?` in the body of
> `POST /v1/intake`. It is accepted and ignored there: creating the draft emits
> no event and the table has no actor column, so the only place a declared actor
> changes anything is the confirmation.

---

## 4. A declared dependency is a record, not a flag

```sql
CREATE TABLE job_dependency (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            INTEGER NOT NULL REFERENCES job(id),
  depends_on_job_id INTEGER NOT NULL REFERENCES job(id),
  created_at        TEXT NOT NULL,
  CHECK (job_id != depends_on_job_id)
);
```

Every edge also becomes a
[`job.dependency_declared`](../../specs/events/schemas/job.dependency_declared.schema.json)
event, the catalogue's 16th type:

```json
{"depende_de_trabalho_id": 101}
```

`entidade.id` is the **dependent** job; `dados.depende_de_trabalho_id` is the one
it depends on. "This one waits for that one" is a fact belonging to the one that
waits, and it is on its timeline that somebody will look for the reason it has
not moved — `GET /v1/jobs/:id/events` of the dependent shows the declaration, the
other one's does not.

**Declaring does not block.** No `job.blocked` is born here. Enforcing the order
— blocking automatically, ordering the dispatch, counting WIP per dependency — is
another ticket's decision, and a flag nobody knows how to lower would be worse
than no flag at all.

A dependency **does not cross batches**: `depends_on` only resolves a `ref` of
items in the same draft. Declaring a dependency on a `trabalho` that already
exists is not supported in this version.

---

## 5. The job gained content

The migration adds two columns to `job` (lines 33-34), and the `job.created`
event's contract gained the two corresponding fields, **optional**
([`event-validation.ts:143-153`](../../packages/core/src/db/event-validation.ts)):

| Column | Type | Note |
|---|---|---|
| `corpo` | TEXT | `null` when the job was born with a title alone |
| `criterios_de_aceite` | TEXT (JSON `string[]`) | `null` is **not** `[]` |
| `tier` | TEXT (`trivial` \| `standard`) | t175. `null` is **not** `trivial` |

`null ≠ []` is the distinction that matters to the node that refines: "nobody has
written a criterion yet" and "I declare there is no criterion" are different
statements.

`null ≠ trivial` is the same discipline with a bigger price: `tier` is the cost
triage the intake session does for free (t175, the ticket
[`intake-generation.md`](intake-generation.md)), and it is where the runner takes
the model that will run each node from. Reading absence as "trivial" would demote
to a cheaper model every job born before this column existed, without anybody
having chosen it and without anything failing anywhere. What the tier changes is
how much a node COSTS to run, never which edge the job leaves by: the graph is
still frozen during the execution, and flowpilot's topology shortcuts are still
outside the port ([`graph.md`](graph.md), the `work_tier` section).

A job created by hand through `POST /v1/jobs` is still born with a title alone,
and in that case both fields reach the log as an explicit `null` — the
normalization rule this taxonomy has applied to every optional field from the
start. `PATCH /v1/jobs/:id` still edits **only** `titulo`: the `refinar` node
rewriting the body and the criteria through `job.amended` is a ticket of its own.

---

## 6. The HTTP surface

Registered in [`routes/intake.ts`](../../packages/core/src/routes/intake.ts)
(`registerIntake`, line 72; one line in `server.ts:60`).

| Route | Response | Errors |
|---|---|---|
| `POST /v1/intake` | `201 {draft}` | `400 missing_required_field` (no `class`/`request`) · `404 unknown_graph` · `400 invalid_items` |
| `GET /v1/intake` | `200 {drafts}` | filters `status`, `class`, `project_id` |
| `GET /v1/intake/:id` | `200 {draft}` | `404 unknown_draft` |
| `PATCH /v1/intake/:id` | `200 {draft}` | `404` · `409 draft_not_pending` · `400 invalid_items` |
| `POST /v1/intake/:id/discards` | `200 {draft}` | `404` · `409 draft_not_pending` |
| `POST /v1/intake/:id/confirmations` | `201 {draft, jobs}` | `404` · `409 draft_not_pending` · `404 unknown_graph` · `400 validation_failed` |

The codes, the keys and the filters above have spoken English since t226
([the glossary](glossario-wire.md) §1.4), and this table only found that out in
t258's alpha round: it belongs to t122, and neither the API's migration nor
t231's citation sweep came through here — §1.4 is precisely the glossary section
that sweep does not read. What holds the table to account now is
[`spec-intake-http-codes.test.ts`](../../packages/core/test/spec-intake-http-codes.test.ts):
every status+code pair is resolved against the route's `refusal` calls, every
success body against the keys it returns, every filter against the query
parameters it reads. The oracle is the route, never a word list — a table of
statuses is a promise about what the client receives.

Since t226 there has been **one** error envelope across the whole `/v1` surface —
`{error, message?}` with the route's context as a sibling property
([`routes/common.ts`](../../packages/core/src/routes/common.ts)) — and intake has
no error shape of its own at all. What the confirmation still has of its own is
being the only route of this layer that writes an EVENT, and that is where the
table's one code the route does not write comes from: a crooked event envelope
(an `actor` that is not `{type, ref}`, for instance) is refused by the same
`validateEvent` that serves the whole API and comes back through that file's
`withValidation`, with the same `{error: "validation_failed", details: [...]}`
body `POST /v1/jobs` returns. Whoever needs to fix their own `actor` should not
have to learn a second error shape to find that out — it was a `500` until
t139's alpha round. The refused draft is still `pending` and still confirmable;
no `trabalho`, no dependency and no log row survives the transaction that fell.

`PATCH` **replaces** the list of items, never merges: an intake that merged would
have no way of removing an item somebody gave up on, and "send me the breakdown
you want" is a simpler contract than a patch language over a list.

The class has to name an already registered lineage — suggesting a class by
resemblance (D8) and graph variants (D13) are out. Without an exact match, `404`,
and nothing is written.

---

## 7. The proof that the graph does not move

It is the ticket's original acceptance criterion, and the test that guards it is
`AT16` in
[`packages/core/test/intake-routes.test.ts`](../../packages/core/test/intake-routes.test.ts):
the complete flow runs against the class registered from factory bundle 1, and
the list of versions before and after is compared whole. Also run by hand against
the factory graph, with no edit at all to the document — the transcript below was
re-recorded in a fresh run on 2026-08-17, against the recreated database D20 asks
for, and that is why it speaks English from beginning to end:

```
POST /v1/graphs -> 201
POST /v1/intake -> 201 status: pending
POST /v1/intake/:id/confirmations -> 201
trabalhos criados: {"migracao":1,"dominio":2,"rotas":3}
nós de entrada: refinar, refinar, refinar
graph_version_id dos trabalhos: sha256:36023db054cb9499742b3d44f96142aba9f59faed5a60652064aec592330a37f

=== GET /v1/graphs/software-development/versions (ANTES e DEPOIS) ===
{"versions":[{"id":"sha256:36023db054cb9499742b3d44f96142aba9f59faed5a60652064aec592330a37f",
              "graph_id":"software-development","parent_version":null,
              "source":"manual","proposal_id":null,
              "created_at":"2026-08-17T11:12:37.705Z"}]}

mesma lista? true

eventos do trabalho "rotas": job.created, job.dependency_declared
data da dependência: {"depends_on_job_id":2}
```

No route of this layer calls `registerBaseGraph`, `insertVersion` or
`movePointer` — directly or indirectly. It is D3 ("the path stays frozen")
applied to intake.

---

## 8. What this layer does not do yet

> **Generating the draft** from the request in natural language left this list
> with t144, and is still outside **this layer**: what decomposes is a runner
> command that dispatches an agent session and arrives here through
> `POST /v1/intake` like any other client — see
> [`intake-generation.md`](./intake-generation.md). These routes still dispatch
> no session and know no engine.

- **Enforcing the declared dependency.** The edge is a record; automatic
  blocking, dispatch order and WIP per dependency are out.
- **Dependencies across batches** and on an already existing job.
- **Editing the body/criteria of an already created job** — that is the `refinar`
  node, through `job.amended`, in a ticket of its own.
- **A review and confirmation screen.** D11 puts observability and the inbox
  before an editing screen; here only the API is delivered, in the same spirit as
  the proposal inbox.
- **Per-user identity** — `t124` closed the authentication of these routes, but
  it does not say WHO confirmed (see "The confirmation's actor") — and
  **submission idempotency**: sending the same request twice creates two drafts.
