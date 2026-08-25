# Specification: the flow topografo, from telemetry to a proposal

**API version:** `v1` · **Implementation:** [`packages/runner/src/surveyor/`](../../packages/runner/src/surveyor)
**Founding decision:** [D16](../../DECISIONS.md) — "beating flowpilot is the next milestone (the topografo's first proposal with evidence)"

A graph that runs produces a trail; a graph that **improves** needs somebody to
read that trail and say where it hurts, with a number. This layer is the first of
those readers: it reads the log of ONE finished execution, measures how much each
node cost, picks the worst and turns that into a proposal to change the graph —
which enters the ledger `pendente` and is applied by nobody.

Two boundaries organize the whole document, and they are better read before any
detail:

- **The topografo is an ordinary client of the API.** It lives in
  `packages/runner`, not in the control plane. It does not open the database, it
  does not import `packages/core/src/db` and it has no privilege the screen does
  not have — the same posture as [D11], extended to the analysers by
  [`notas/2026-08-14-extension-and-quality.md`](../../notas/2026-08-14-extension-and-quality.md):
  "analysers reading the same telemetry and emitting proposals in the same
  format".
- **The agent decides ONE thing.** The numbers, the evidence and the hypothesis
  come out of our code, deterministically, from the log. The agent session picks
  only the `operations` — the semantic diff — and hands that back in a file. It
  is what makes "evidence traceable to numbers in the log" a structural guarantee
  rather than a promise about the model's memory.

---

## 1. The two halves

| Half | Where | What it does | Deterministic? |
|---|---|---|---|
| Flow lens | [`metrics.ts`](../../packages/runner/src/surveyor/metrics.ts) | Folds the execution's log into four numbers per node and names the bottleneck. | Yes: a pure function, no HTTP, no clock. |
| Orchestrator | [`proposal.ts`](../../packages/runner/src/surveyor/proposal.ts) | Assembles the evidence and the hypothesis, dispatches **one** session to pick the operations, validates and writes the proposal. | The part that matters, yes — only picking the operations is agentic. |

The first half's input is `GET /v1/executions/:id/events` (§6) plus the node ids
of the graph version the execution ran under. The second half's output is one row
in `proposta`, always with status `pendente`.

---

## 2. The four measures, and who each one is billed to

| Measure | Which pair of events it comes from | Attributed to |
|---|---|---|
| `agent_ms` | `session.opened` → `session.finished` | The node in `session.opened.data.node_id`. |
| `blocked_ms` | `job.blocked` → `job.unblocked` | The node the job **was on at the moment it blocked**. |
| `queue_ms` | `job.transitioned` → the next `session.opened` of the same job **at the same node** | The transition's destination node. It is dispatch latency. |
| `input_requests` | `input_request.created` | The node of the session that asked (`data.session_id` → `session.opened.data.node_id`). |

Three rules run through the fold, and each one is a decision:

- **The order is the `id`, never `occurred_at`.** Two events can carry the same
  stamp; only the id the server assigns is a total order. The same rule as the
  reference reducer
  ([`reconstruct-state.mjs`](../../specs/events/reducers/reconstruct-state.mjs)).
- **The node the job was on is reconstructed from the log**, by folding
  `job.created` and `job.transitioned`. The projection only knows where the job
  is *now*, and "where was it when it blocked?" is a question about the past.
- **What cannot be attributed is not counted.** A question with no session
  (`session_id: null` is valid in the taxonomy), a session at a node the graph no
  longer has, an interval that runs backwards: all discarded. A number invented
  so as not to leave a hole is worse than the hole.

`job.created` does **not** open a queue: a queue is the wait between arriving at
a node by transition and that node's session opening. A second transition with no
session in between discards the pending queue — the job left the node with nobody
working on it, and there is nobody to bill that time to.

---

## 3. The ranking and the bottleneck

`total_ms` is the sum of the three time measures (`input_requests` does **not**
enter the sum: they are a signal of another nature, and mixing them would demand
an arbitrary exchange rate between a second and a question). The ranking orders
by `total_ms` descending, with ties broken by the node id ascending — two
executions with the same numbers have to name the same bottleneck.

The `gargalo` is the first of the ranking, **provided it costs more than zero**.
When the whole execution sums to zero, `gargalo` is `null`, and that is not an
error: it is a round with no signal, and the right outcome is to propose nothing
(§5).

---

## 4. The evidence and the hypothesis

A proposal is a hypothesis: `POST /v1/proposals` refuses with `400` any that
arrives without `evidencia` and without `metrica_esperada`
([`entities-versioning.md` §6](entities-versioning.md)). The topografo assembles
both before any agent enters the story.

```json
{
  "lens": "flow",
  "fonte": "topografo/fluxo",
  "execution_id": 110,
  "graph_version_id": "sha256:55be71af…",
  "node_id": "redigir",
  "agent_ms": 20507,
  "blocked_ms": 5009,
  "queue_ms": 0,
  "total_ms": 25516,
  "input_requests": 0,
  "event_ids": [2, 3, 4, 5],
  "by_node": [ … the whole ranking … ]
}
```

`event_ids` is the field that gives the contract its name: they are the **real**
ids of the events every number came from, and it is through them that anybody
reconstructs the arithmetic without trusting anyone. Evidence that summarizes
without citing an id is an opinion, not evidence. `by_node` travels with it so
that "why THIS node?" is answerable without running anything again.

The keys above have been English since `t264`
([`glossario-wire.md` §5.6](glossario-wire.md)): until then the flow lens was the
only one still writing Portuguese inside `evidence`, and the cost lens had
already migrated in `t255`. A hypothesis opened BEFORE that ticket names
`tempo_agente_ms:<no>`, and `measureForExpectedMetric` answers `null` for it —
refusing is the correct behaviour: closing it with a zero would read as "the
bottleneck is gone", which is the best possible verdict, when what happened was
that nobody measured anything.

`lens` is the field the control plane reads, and not the topografo: since `t246`
(D21), `POST /v1/proposals` deduplicates by
`(lens, target_version, operations)` — the key is computed by the server, never
accepted in the body and never returned in the response. Running this lens twice
over the same execution does **not** create two proposals: the second call
answers `200` with the proposal that already existed and its evidence becomes a
list, with the new occurrence at the end. `fonte` is still where it always was
and was not replaced — it is the provenance this module declares, `lens` is the
server's discriminator, and both lenses need the same field name (`cost` in the
cost one, since `t255`) in order to fall into the same dimension. The uniqueness
holds only while the proposal is `pending`: once rejected or applied, the same
signal opens a new proposal.

The hypothesis points at the bottleneck's **dominant component**, not at the
total: "the node costs 25s" is not actionable, "the node spends 20s with an agent
open" is.

```json
{ "nome": "agent_ms:redigir", "direcao": "cai", "de": 20507, "para": 16406 }
```

`para` is 20% below `de` — declared ambition, not a threshold. Whoever judges the
hypothesis in the following round (`t112`) compares the measured number with
**`de`**, never with `para`
([`hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts)): "it moved in
the declared direction, by less than hoped" is a confirmed hypothesis, not a
failure.

---

## 5. The session: one task, one file, no privilege

The only thing an agent decides here is **which operations** attack the
bottleneck. The `SessionSpec` it receives is:

- `instructions` — the output contract: the five operation types
  ([§3 of `entities-versioning.md`](entities-versioning.md), no new type), the
  requirement of the inverse, and the file to write;
- `prompt` — the nodes and edges of the version that ran, plus the execution's
  measurement table with the bottleneck pointed out;
- `workingDir` — a draft directory, which is the only place the session touches.

The output is the file `proposta-topografo.json`, with the shape
`{"operations": [...]}` and nothing else. A file, and not stdout, because the
output of a real CLI is a stream of frames with prose in between
([`human-escalation.md` §4](human-escalation.md)) — a contract that survives that
is one the session fulfils with a single write.

The session receives **no** control plane URL, no credential and no write access
to anything else. The only `POST` in this layer is the orchestrator's.

---

## 6. The order of a round

```
resolve the execution's version   (GET /v1/executions/:id/metrics-by-version)
        │
        ├─ no version declared ──▶ error, nothing written
        ▼
read the version's snapshot       (GET /v1/graph-versions/:id)
read the execution's whole log    (GET /v1/executions/:id/events)
        ▼
calcularMetricasDeFluxo(events, the snapshot's nodes)
        │
        ├─ gargalo == null ──▶ exit 0, WITHOUT opening a session and WITHOUT proposing anything
        ▼
assemble the evidence + the expected metric   (our code, deterministic)
        ▼
one EngineAdapter session picks the operations
        │
        ├─ failed / ran out of clock / file absent / `operations` empty
        │  or malformed ──▶ error, ZERO calls to POST /v1/proposals
        ▼
POST /v1/proposals  (exactly once)  ──▶  a `pendente` proposal
```

Three guarantees the design buys, and that the acceptance tests demand:

1. **Zero writes on a bad round.** The operations are validated on the client
   side, with the server's own structural rules, BEFORE the `POST`. The server is
   still the authority — it validates again — but finding a malformed diff does
   not cost a row in the database.
2. **Exactly one proposal per round.** There is no loop and no silent retry.
3. **Nothing is applied.** There is no call to `POST /v1/proposals/:id/apply` in
   this layer, and the runner's client does not even have the method: applying is
   a human decision (README, principle 5), and a client that does not have the
   button does not press it by mistake.

The target version is the version the execution **ran** under — it is the one the
evidence speaks about. If the graph has moved since then, the proposal stays in
the ledger and it is `aplicar` that refuses with `409 proposta_desatualizada`;
redoing the diff over the new base is another round's work
([t118](entities-versioning.md)).

---

## 7. Endpoints and command

| Method | Route | Role in this layer |
|---|---|---|
| `GET` | `/v1/executions/:id/events` | **New (t110).** The execution's whole log, in `id` order. An execution with no event at all answers `200` with an empty list — an execution is an opaque grouper, never an entity, so there is no `404`. |
| `GET` | `/v1/executions/:id/metrics-by-version` | Which version the round ran under (the log does not carry `graph_version_id`). |
| `GET` | `/v1/graph-versions/:id` | The snapshot: the nodes the measurement reports and the edges that go into the prompt. |
| `POST` | `/v1/proposals` | The only write. Returns `201` with the `pendente` proposal. |

On the runner's side, all of that goes through `ClienteControle`
([`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts)),
which is still the process's only HTTP door.

The command is manual, and it is that way on purpose (§8):

```
npm run surveyor --workspace @cartografo/runner -- <execution_id> [url] [dir] [--token <token>]
```

The credential is not optional in practice: since `t124` no `/v1` route answers
anonymously, and the four this command uses refuse with `401`. It comes from
`--token` or from `CARTOGRAFO_TOKEN` — the same precedence as the `cartografo`
CLI ([`cli/url.ts`](../../packages/core/src/cli/url.ts)) and the cost topografo —,
and it is the token printed on the readiness line of the control plane's first
start. Without it the command does not degrade: it is denied, and it says in one
line what to do about it.

Exit codes: `0` when it wrote the proposal (the id goes to stdout) **or** when
there was nothing to propose; `1` when the session failed, did not return usable
`operations` or had its credential refused — and in that case nothing was
written.

The manual proof against the real CLI is
[`scripts/spike-surveyor-flow.mjs`](../../packages/runner/scripts/spike-surveyor-flow.mjs)
(`npm run spike:surveyor`): it brings up a real control plane, makes a job cross
two nodes with two real `claude` sessions, blocks and unblocks the job, and only
then runs the topografo. It is not a CI test and must not become one — the suite
runs against the fake engine precisely so as not to depend on an installed
binary. It asks nothing of the environment: since it brings up its own control
plane against a fresh database, the token it presents on every call is the one
that start printed.

---

## 8. What this layer does not do yet

Every item here is another ticket's declared scope, not an oversight:

- **Automatic firing — it exists, and it is still somebody who switches it on**
  (`t247`, [D21]'s third child). `cartografo-topografo watch`
  ([`packages/topografo`](../../packages/topografo)) subscribes to
  `GET /v1/events/stream?type=execution.finished`
  ([events-stream.md](events-stream.md)) and runs both lenses — this one and the
  cost one — over every execution the control plane declares finished, with
  nobody typing any id. What changed is WHO calls the lens; the rest of the
  ladder is intact: the topografo is still not a node of the graph and not a step
  of the controller's dispatch loop, and it still only *suggests* — applying is
  still a human decision at the gate (principle 5 of the README, [D10]'s "a
  copilot in the MVP" posture). What `watch` does not do is bring itself up: no
  startup script, service or CI job invokes it, and switching it on in production
  is the operator's decision, as [D21] asked.
- **The learnable "policies" surface** (timeouts, concurrency, auto-answering):
  today there is no versioned artifact a proposal could address —
  `schema/grafo.schema.json` has no policy field, and the runner's caps and TTLs
  are per-request parameters
  ([`runner-and-controller.md` §5](runner-and-controller.md)).
- **A second topografo** (cost, quality) and freezing the proposal format: the
  rule of two consumers asks for two before freezing
  ([`notas/2026-08-14-extension-and-quality.md`](../../notas/2026-08-14-extension-and-quality.md)).
- **The hypothesis's `resultado`** (`confirmada`/`sem_efeito`/`piorou`): that is
  `t112`, and it exists already — it is only that this layer is not the one that
  calls it.
- **Human approval or rejection** as an action (`t111`), and **variants** born of
  a proposal (`t118`).
- **`proposta.*` events**: the taxonomy deferred those types to a ticket of its
  own in wave 2
  ([`taxonomy.md`](../../specs/events/taxonomy.md)), so a topografo
  round emits no telemetry about itself.
- **Concurrency** between two topografos on the same execution: v1 assumes a
  single manual invocation.
- **Credential scope** on the new route and in the command. `t124` authenticated
  every `/v1` route, this one included, and the command presents the token
  (`CARTOGRAFO_TOKEN` or `--token`, §7 — it was `t146` that closed that half);
  what it presents is an operator credential, because the topografo's four routes
  are outside the surface `t143` opened to a runner credential. Cutting a
  credential that reaches exactly these routes is another ticket.

[D10]: ../../DECISIONS.md
[D11]: ../../DECISIONS.md
[D21]: ../../DECISIONS.md
