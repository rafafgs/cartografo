# Specification: the graph document

**Format version:** 1.0.0 · **Schema:** [`schema/graph.schema.json`](../../schema/graph.schema.json)
(JSON Schema draft 2020-12, `$id: urn:cartografo:schema:graph:1.0.0`)
**Reference validator:** [`scripts/validate-graph.mjs`](../../scripts/validate-graph.mjs)

The graph is **data, not code** (D15). This document specifies the format of that
data: what a work graph declares, what each field means, and the four formal
rules that separate an executable graph from a pretty drawing.

It is the project's extension point nº 1 — of the four formats treated as a
product (`notes/2026-08-14-extension-and-quality.md`), this is the first, and
everything that comes afterwards consumes it: the control plane keeps this whole
document in the `snapshot` column of `graph_version`; the factory graphs are
written in it; the atlas packages it.

---

## 1. The document

A graph is **one JSON file**, with seven top-level keys. There is no second file,
no include and no external reference to resolve: the document is self-contained
on purpose (see §7).

```json
{
  "problem_class": "software-development",
  "lineage": { "type": "base" },
  "metadata": { "name": "...", "schema_version": "1.0.0" },
  "nodes": [ /* ... */ ],
  "edges": [ /* ... */ ],
  "initial_node": "refine",
  "final_nodes": ["deploy"]
}
```

| Field | Type | Required | What it is |
|---|---|---|---|
| `problem_class` | string | yes | The identity of the problem class, named by the user (D8). The graph's versioning root and the telemetry's aggregation unit. |
| `lineage` | object | yes | The position in the class's lineage: base or variant (D13). See §5. |
| `metadata` | object | yes | Name, description, schema version, date, origin. A drawer deliberately open to extra keys. |
| `nodes` | list | yes | The steps. At least one. See §2. |
| `edges` | list | yes | The transitions. See §3. |
| `initial_node` | node id | yes | Where every traversal begins. It has to exist in `nodes`. |
| `final_nodes` | list of ids | yes | Where the traversal ends. At least one; all of them have to exist in `nodes`. |
| `project` | object | no | The class's **static** configuration, published by the input projection at `input.project` (`t253`). Absent means `{}`. See below. |
| `max_consecutive_failures` | integer ≥ 1 | no | How many failed sessions **in a row**, on the same job and the same node, block the job (`t265`). Absent means **3**. See below. |

### `project`: what the class declares for itself

What comes from no job and is produced by no node: the repository, the main
branch, the test command, the conventions, the ledger documents. Until `t253`
that material had nowhere to live — the software factory graph's skills already
read `{{input.projeto.*}}` and nothing assembled that object. `t259` closed both
sides: those manifests started reading `{{input.project.*}}`, which is the name
the projection publishes, and the software bundle declares the object.

```json
{
  "project": {
    "repo": "git@github.com:octo-org/cartografo.git",
    "branch_principal": "main",
    "test_command": "npm test",
    "quality_commands": ["npm test", "npm run lint", "npm run typecheck"]
  }
}
```

Three things the field decides:

- **Absence has a name, and the name is `{}`.** A class that does not declare a
  project configuration yet projects an empty object, and not a missing key: a
  placeholder resolves to something honest instead of refusing the dispatch. It
  is what keeps every graph written before this field valid and dispatchable —
  the same non-breaking posture as `hooks` and the node's `engine`.
- **The keys inside belong to the CLASS.** The schema opens the drawer
  (`additionalProperties: true`) for the same reason `custom_fields` exists:
  `test_command` is software-development vocabulary and would make no sense in
  asymmetric bets, and closing the set would ask for a schema edit per class.
- **Static, and therefore versioned with the document.** Change the test command
  and you change the graph, and the change is proposable and reversible like any
  other part of it (D2, D15). A value specific to one project lives in that
  project's **variant** (D13); what lives here is what the class declares for
  itself.

### `input.traversal`: the walk the control plane projects (`t270`)

Nothing here is a field of the document — it is `input.project`'s **sibling** on
the other side of the projection. `project` is what the class declares and it
travels frozen in the snapshot; `traversal` is what the log says happened to
**this** job, assembled on every `GET /v1/jobs/:id/context`. Both reach the same
`input`, and the difference between them is who answers for each key.

```json
{
  "traversal": {
    "nodes_visited": ["triage", "collect-fundamentals", "analyze-asymmetry"],
    "entered_at": "2026-08-17T22:41:03.117Z",
    "sessions_by_node": { "triage": [11], "collect-fundamentals": [12, 14] }
  }
}
```

| Key | Who supplies it | What it is |
|---|---|---|
| `nodes_visited` | the control plane, from `job.transitioned` | The nodes this traversal has **executed**, in walking order. |
| `entered_at` | the control plane, from `job.transitioned` | The ISO-8601 instant the job reached the node it is on. |
| `sessions_by_node` | the control plane, from the finished sessions | The `session_id`s per node, in the order they closed. |

Three things the projection decides:

- **The current node is not in `nodes_visited`.** A transition records where the
  job **went**, so the last one's `to_node_id` is the node it is standing on —
  and a node about to run has not executed. Without that cut,
  `red_team_executado` would answer `true` for a traversal that had only
  *arrived* at `red-team` and had reported nothing, which is exactly the
  self-report that skill's check exists to refuse. Zero transitions is an empty
  walk: whoever is at the entry node has executed nothing yet.
- **With no transition, `entered_at` is the job's creation.** It is the honest
  answer to "when did you get here?" from somebody who never left where they were
  born — and it is what makes `{{input.traversal.entered_at}}` resolve from the
  first node on, instead of refusing the entry dispatch.
- **Only the control plane can assemble this (D1).** It is a read of the
  append-only log, and a runner that reconstructed it through the public routes
  would be a second author of the same fact. Before `t270` nobody assembled it:
  `registrar-travessia` named `{{input.nos_executados}}` and
  `{{input.data_de_registro}}`, the dispatch refused closed, and the second real
  bets crossing was unblocked by a person typing both values into `fields` by
  hand.

The keys inside are **English**, unlike `perguntas_respondidas` beside them:
`input.job`, `input.project` and `input.traversal` are the core's projection
vocabulary, and new format vocabulary is born in English (D18). What is in
Portuguese over there is inherited from the manifests that came before the rule,
not a precedent.

### `max_consecutive_failures`: how many times in a row a node may fail

Until `t265` there was no ceiling: a job whose sessions kept failing went back to
the queue, got a lease again and opened the next session, forever. What stopped
the loop was the operator watching the log — which is what happened in the first
real crossing of the bets graph (`t198`).

```json
{
  "max_consecutive_failures": 3
}
```

Four things the field decides:

- **Absence has a name, and the name is 3.** Resolved at the moment a session
  closes, never at validation: a graph written before this field is still valid
  and gains a ceiling without being touched — the same non-breaking posture as
  `hooks`, `project` and the node's `engine`.
- **The count is a tail count.** It walks from the most recent session backwards
  and stops at the first that did not fail. Failed, failed, worked, failed is
  **one** failure behind it; a success zeroes the sequence.
- **It holds per node, but is declared at the root.** The counted pair is
  `(job, node)` — failing twice at `redigir` and once at `revisar` is not a
  sequence of three —, and the number belongs to the whole document. A ceiling
  per node is another ticket's decision, if the evidence shows up.
- **An engine's refusal does not come through here.** An engine that refuses to
  answer is deterministic and stops on the **first** occurrence, on the runner's
  side (`docs/spec/runner-and-controller.md`). The ceiling is for the ordinary
  failure, which may very well be a hiccup.

The one that counts is the control plane, inside the transaction that closes the
session: the sequence crosses leases and runner processes, and no runner on its
own can see it (D1).

**Node ids** are lowercase letters, digits, a hyphen and an underscore
(`^[a-z0-9][a-z0-9_-]*$`), unique within the document. They are the key edges,
telemetry and mutation proposals refer to the node by — swapping an id is a
semantic operation, not a cosmetic rename.

The field names are **in Portuguese**, like the rest of the repository. It is
worth reconsidering English when the schema is close to freezing (the rule of two
consumers: after factory graph 2, `t116`), not before.

---

## 2. Node

A step of the graph. Everything that executes in the system is a skill with a
contract; what changes is the role — **doing, checking, routing**.

```json
{
  "id": "test",
  "role": "tester",
  "node_type": "gate",
  "description": "Exercises the delivered behaviour and routes.",
  "skill_ref": { "id": "cartografo/alpha-test", "version": "1.0.0", "hash": "sha256:5f5184…" },
  "contract": { "input_schema": {}, "output_schema": {}, "checks": [] }
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | yes | A unique identifier in the document. |
| `papel` | yes | Who does the work, in the domain's language: `architect`, `developer`, `red-team`. |
| `node_type` | yes | `work` or `gate`. |
| `description` | no | What the node does, in one sentence. |
| `engine` | no | Which engine executes this node. Absent = the runner's default engine. See below. |
| `model` | no | Which model of that engine executes this node. Absent = the engine's own default. See below. |
| `escalation_policy` | no | When this node calls a person: `always`, `on_uncertainty`, `never`. Absent = `on_uncertainty`. See below. |
| `escalation_recipient` | no | Who ought to be called when this node escalates. Free text. See below. |
| `skill_ref` | yes | A pinned pointer to the registry's skill. |
| `contract` | yes | Input, output and verifications. |

### `engine`: which engine executes this node

A graph can mix engines, and the choice is **per node** (t141). A node that
declares `"engine": "codex"` runs on Codex; the next node, which declares
nothing, runs on the default.

```json
{
  "id": "conferir",
  "role": "reviewer",
  "node_type": "work",
  "engine": "codex",
  "skill_ref": { "id": "cartografo/review-note", "version": "1.0.0", "hash": "sha256:2df09e…" },
  "contract": { "input_schema": {}, "output_schema": {}, "checks": [] }
}
```

Three things the field decides, and that are worth writing down rather than
inferring:

- **Absence has a name.** A node with no `engine` runs on the runner's default
  engine, which is `claude-code` — the `DEFAULT_ENGINE` constant of
  `packages/runner/src/dispatch/dispatch.ts`. It is a named default and not an
  implicit one: the session's telemetry records the engine that ran, and nobody
  has to guess which it was. That is why every graph written before this field is
  still valid and still behaves exactly as before.
- **The resolution is at dispatch, never at validation.** What reads `engine` is
  the runner, at dispatch time, looking at the node the job is on *now*
  (`no_atual` against `snapshot.nos`). The graph validator does not know which
  engines exist on that machine, and it is not its job to know.
- **It is free text, and the refusal is the runner's.** There is no closed enum
  in the schema, for the same reason `papel` and `skill_ref.id` are free text
  too: an enum would force a schema edit on every new adapter, and the format is
  additive. A node that asks for an engine the runner has no route for **fails
  the dispatch** with `UnknownEngineError`, before any session opens — it never
  silently falls back to another engine, which would make the telemetry lie about
  what really ran.

The complete example:
[`graph-valid-two-engines.json`](../../schema/examples/graph-valid-two-engines.json).

### `model`: which model of that engine executes this node

Choosing the engine is half the decision; the other half is **how much** model
the node needs (t166). A gate that checks a diff does not ask for the same model
as the node that wrote the diff, and `model` is where that difference is written
down — per node, in the graph, and not in a machine's flag.

```json
{
  "id": "conferir",
  "role": "reviewer",
  "node_type": "gate",
  "engine": "codex",
  "model": "gpt-5.6-luna",
  "skill_ref": { "id": "cartografo/review-note", "version": "1.0.0", "hash": "sha256:2df09e…" },
  "contract": { "input_schema": {}, "output_schema": {}, "checks": [] }
}
```

Four things the field decides, and that are worth writing down rather than
inferring:

- **Absence has a name, and here the name is not ours.** A node with no `model`
  runs on the **engine's own** default — there is no `DEFAULT_MODEL` in the
  runner, on purpose. The runner has no way of knowing which models that
  installation has access to, and a constant here would put into every session a
  choice no graph made. In practice: no model flag is assembled, and the argv
  comes out identical to the one before this field existed. Every graph written
  before t166 is still valid and still behaves exactly as before.
- **It is free text, and the refusal is the engine's.** There is no closed enum
  in the schema, for `engine`'s reason: an enum would force a schema edit on
  every new model. An unknown or mistyped `model` is refused by the CLI itself
  when the session opens — a session that fails, and not a new validation error.
  The catalogue the API publishes (`GET /v1/engines`) is **discovery, not
  validation**: it serves whoever writes a graph to know what exists, and nothing
  compares the node against it before dispatch.
- **Changing the model is a version change.** `model` is graph data, so changing
  it is a proposal: `change_node_field` with `field: "model"` goes down the same
  path as ever — apply, validate soundness, write a new `grafo_versao`, move the
  pointer (D15) — and the same holds for `engine` since t166. It comes with an
  inverse and with evidence, like any other proposal, and what ran under which
  decision stays in the history.
- **It holds on the next traversal, not on the one running.** The graph is frozen
  during the execution: a job stays on the version it entered on, with the model
  that version declared, and what reads the new model is whichever dispatch
  happens under the new version.

The complete example:
[`graph-valid-model.json`](../../schema/examples/graph-valid-model.json).

### `escalation_policy`: when this node calls a person

Until `t167` the answer was one for the whole graph: every node asked when it got
stuck, and every request for a decision blocked the job until somebody answered.
That is the right behaviour for an architecture node and the wrong behaviour for
a node that runs in the middle of the night with nobody on the other side. The
policy becomes **per node**, and it is graph data — versioned, proposable and
revertible like any other field.

```json
{
  "id": "publicar",
  "role": "publisher",
  "node_type": "work",
  "escalation_policy": "never",
  "escalation_recipient": "editor-de-plantao",
  "skill_ref": { "id": "cartografo/publish-note", "version": "1.0.0", "hash": "sha256:e6952f…" },
  "contract": { "input_schema": {}, "output_schema": {}, "checks": [] }
}
```

The three values:

| Value | What the node does |
|---|---|
| `always` | Escalates before closing the node, **even when it thinks it knows** the answer. For the decision a person wants to see pass through them. |
| `on_uncertainty` | Escalates when it gets stuck. It is the behaviour every node always had, and it is the default. |
| `never` | It has nobody to ask. Getting stuck here is a failure of the node's own contract — the runner **blocks the job with a reason**, and no question is created. |

Four things the field decides, and that are worth writing down rather than
inferring:

- **Absence has a name, and the name is `on_uncertainty`.** A node with no
  `escalation_policy` behaves exactly as before the field existed, and that is
  why every graph already written is still valid and still behaves the same. The
  same convention as `engine` above.
- **The resolution is at dispatch, never at validation** —
  `resolveEscalationPolicy` in
  [`resolve-node.ts`](../../packages/runner/src/dispatch/resolve-node.ts),
  looking at the node the job is on *now*. A value outside the three (only
  possible in a snapshot that changed shape underneath) resolves to the default:
  it is not a guess about which of the three it was meant to be.
- **Unlike `engine`, the enum here is closed.** `engine` is free text because an
  enum would force a schema edit on every new adapter; here the three values
  **are** the vocabulary, and a fourth value is not a new capability, it is an
  error by whoever wrote it — caught by the schema, before any runner reads it.
- **Only `never` is deterministic.** `always` and `on_uncertainty` are an
  instruction in the prompt, like all the rest of the session's text: whether the
  session really was "uncertain" is not machine-checkable, and a gate that
  pretended to check it would be checking nothing. `never` is wiring: the runner
  swaps `POST /v1/input-requests` for `POST /v1/jobs/:id/blocks`, and that swap
  does not depend on the session obeying the instruction.

Changing a node's policy is a `change_node_field` proposal like any other
(`packages/core/src/domain/operations.ts`, `CHANGEABLE_FIELDS`): it produces a new
`grafo_versao`, revalidates the whole document and has an inverse. It is on
purpose that there is no path of its own to change it — a second way of changing
a node would have rules of its own about what is versioned.

The complete example:
[`graph-valid-escalation-never.json`](../../schema/examples/graph-valid-escalation-never.json).
The whole cycle is in [`human-escalation.md`](human-escalation.md).

### `escalation_recipient`: who ought to be called

Free text, with no imposed format — for the same reasons `resposta_padrao` and
`respondido_por` also are: **there is no identity system and no system of roles
in this repository** to validate against, and inventing a format now would freeze
a vocabulary before the first consumer.

The field is kept in the graph and returned by the snapshot
(`GET /v1/graph-versions/:id`). **Nothing sends anything to it**, and that is not
an oversight: notification and roles are a future ticket, and the field exists now
so that the policy and the recipient are born together instead of the graph
having to be rewritten when delivery arrives. It is not even read by the runner.

### `node_type`: why a gate is a node

**A gate is not a separate entity.** A gate is a node whose role is to check and
route, and it carries a skill and a contract exactly like any other node
(`notes/2026-08-14-learning.md`). The `work` / `gate` distinction exists
for reading and for telemetry — "how much time did the job spend in verification?"
—, not to give a gate a privileged place in the format.

Two consequences the format inherits from that choice:

- A gate is **deterministic wherever possible** (run a test, validate a schema,
  build) and **agentic only where there is judgement**. That shows up in the
  contract, in `checks`, not in a field of the node's own.
- An agentic gate verifies with **its own evidence** — it runs the result — never
  with the report of whoever did the work. Hence `required_evidence` being
  `const: true` in the schema: an agentic check with no evidence attached is not
  a verification, it is an opinion.

### `skill_ref`: a pinned pointer

```json
{ "id": "cartografo/alpha-test", "version": "1.0.0", "hash": "sha256:<64 hex>" }
```

An **opaque** pointer: the skill manifest's internal format is another document
(`t97`); here only the pin matters. All three fields are required because a skill
imported from an external repository is a prompt-injection vector (D4) — the hash
is what stops a skill's content being swapped in silence underneath an already
validated graph. `versao` is semver; `hash` is `sha256:` followed by 64 hex
characters.

> In this repository's examples the hashes are **reproducible placeholders**:
> the `sha256` of the string `placeholder:<the skill's id>@<versao>`. No real
> skill exists yet to be pinned.

### `contract`: the load-bearing piece

Input and output in JSON Schema, verification as a list of typed checks (D9,
README principle 3). With no contract the synthesizer composes by hallucination;
with a contract, composing a graph becomes **matching contracts**.

| Field | Required | What it is |
|---|---|---|
| `input_schema` | yes | The JSON Schema of the state projection the node receives. A projection, not a common window (README principle 4). |
| `output_schema` | yes | The JSON Schema of what the node hands back to the board. Documentation of the expected shape and the source of the edges' routing vocabulary — it is **not** the schema the session's report is checked against. It is here that the `resultado` of a node with two or more exits is declared; it never enters the skill's `output`. See below. |
| `checks` | yes | A list with **at least one** check. How what the node produced is verified. |
| `produces` | no | The name of the **bucket** this node's structured output accumulates in, in the input projection of the following nodes (`t253`). Absent = merged at the top of `input`. See below. |

#### `output_schema` documents; the skill is what validates (`t267`)

The two are different schemas on purpose, and confusing them cost three refused
reports in the second real crossing of the bets graph. The node's `output_schema`
is what THIS graph expects from here, and it is where the edges' vocabulary comes
from (an edge's `condition` matches the `outcome` it declares). What
`PATCH /v1/sessions/:id/finish` checks the fenced block's object against is the
`output` of the **pinned skill** (D9) — resolved by
[`resolveOutputSchema`](../../packages/core/src/repositories/session.ts), down the
path `job` → `graph_version` → node → `skill_ref` → registry. One skill serves
more than one graph, and that is why the validation lives in it and not in the
node.

The practical consequence for whoever writes a node's prompt: showing the
`output_schema` to a session and saying it is what the output will be checked
against is false. The runner renders both today, each with its own label
([`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)).

**The `resultado` key is reserved by the protocol and stays OUT of that check
(`t269`).** The fenced block is a single one, so the routing label travels inside
the same object as the report — but it is THIS graph's vocabulary (an edge's
`condition`), never the skill's `output`. When the reported object carries a
`resultado` that is a usable label (a non-empty string after `trim`, the same
reading as
[`parse-node-result.ts`](../../packages/runner/src/dispatch/parse-node-result.ts)),
the control plane takes it out before checking and does not keep it:
`session.output` and the `data.output` of the `session.finished` event are left
with the skill's fields and nothing else. The consequences, at both ends:

- a skill can close its own `output` (`additionalProperties: false`) without
  declaring `resultado`, which is `derrubar-tese@1.0.0`'s case, and still accept
  the report of a node with two exits — before `t269` it refused them all, and
  since `t268` a refusal like that **blocks** the node;
- declaring `resultado` as a property of a skill's `output` is not legal: the key
  never gets checked and never gets stored, so the declaration describes nothing.
  Whoever needs the label reads the edge that was taken in `job.transitioned`,
  not the session's output.

A `resultado` that is present and **not** a label (a number, an object, a string
of only spaces) is taken out of nothing: it stays in the object and a closed
schema refuses it as it always refused. A session that put rubbish in the routing
key did not understand the protocol, and washing the key in silence would store a
report beside a decision no edge carries.

#### `produces`: where this node's output lands

A node's structured output — what the session reports in
`PATCH /v1/sessions/:id/finish` and the control plane keeps after checking it
against the pinned skill's `output` (D9), already without the routing key
`resultado` (`t269`) — has to land somewhere in the next node's `input`.
`produces` is that somewhere, and it is a **bucket**, not a box per session: two
nodes that declare the same name write into the same object.

```json
{ "id": "develop", "contract": { "produces": "artifact", "…": "…" } }
{ "id": "test",      "contract": { "…": "…" } }
{ "id": "integrate",    "contract": { "produces": "artifact", "…": "…" } }
```

With those three declarations, `develop` writes `artifact.branch`, `integrate`
writes `artifact.merge_commit` — and `deploy`, two hops later, reads both. The
`test` gate in the middle declares **no** bucket: it produces no artifact of its
own, it merges at the top, and the `artifact` that already existed stays exactly
as it was. Were it a box per session, the `merge_commit` would arrive in an
object that no longer carries the `branch`, and it is that chaining — not the
isolated step — that the traversal needs.

Two consequences worth writing down:

- **Absence has a name.** A node with no `produces` merges at the top of `input`,
  which is what both factory graphs already did because the field did not exist.
  That is why it is optional and breaks no graph — `asymmetric-bets` still
  resolves node by node without declaring a single bucket.
- **On a key collision the last writer wins**, in traversal order (the session's
  `finalizada_em`). The order is the one that happened, not the one the query
  returned.

The whole assembly is `GET /v1/jobs/:id/context`, in the control plane
(`packages/core/src/domain/context.ts`): whoever writes to the database is
whoever assembles the projection (D1), and the runner is a client of it as of any
other route.

Every verification is of one of two types:

```json
{ "type": "deterministic", "command": "make check", "description": "…" }
```
```json
{ "type": "agentic",
  "instruction": "Run the behaviour and check every acceptance criterion. Attach the output.",
  "required_evidence": true,
  "description": "…" }
```

The framework's honest limit is here: **verification density** (README principle
6). Where a step's verification cannot be written down, there is no gate; with no
gate, the graph is decorative.

---

## 3. Edge

A labelled transition between two nodes.

```json
{ "from": "test", "to": "develop", "condition": "rework", "description": "…" }
```

| Field | Required | What it is |
|---|---|---|
| `from` | yes | The id of the source node; it has to exist in `nodes`. |
| `to` | yes | The id of the destination node; it has to exist in `nodes`. |
| `condition` | yes | A non-empty string. See below. |
| `description` | no | When this transition happens. |

**`condition` is a label, not an expression.** Two forms:

- **The source node's outcome label** (`"approved"`, `"rework"`) when the
  source has multiple exits — typically a gate. The label matches the `resultado`
  the source node's `output_schema` declares.
- **The literal `"always"`** when the source has a single exit.

There is no boolean expression language, and that is deliberate: designing one
before two real graphs are pressing on the format is designing for a use case
that does not exist yet (the rule of two consumers). When the second factory
graph (`t116`) asks for more, the format gains more — with evidence.

A cycle is legitimate (the `test → develop` rework is one), as long as the
`terminates` rule (§6) still holds. What is **not** legitimate is a node picking
a path freely at run time: the only decisions in flight are the gates', over
edges already declared (README principle 2).

---

## 4. `initial_node` and `final_nodes`

`initial_node` is single: every traversal begins in the same place. `final_nodes` is
a list because a graph can end in more than one way (approved and archived are
both legitimate endings). A final node does not have to be a topological leaf —
it only has to be a point where the traversal may stop.

### Reaching the final node is not having finished (`t262`)

**A final node is the node you do not leave — it is not the node that does
nothing.** A final node is a node like any other (§2): it has a `skill_ref`, it
has a contract, and it runs. What it does not have is an outgoing edge.

Hence the completion rule, which the control plane derives on every read and
never stores:

- **A final node that pins a skill** — the case of every registered graph,
  because the schema demands a `skill_ref` on every node (§6,
  `node_with_contract`) — only closes the traversal when that node's session
  finishes with `status: "completed"` and an `output` the pinned skill's `output`
  accepts. Until then the job is still a dispatch candidate like any other.
  Arriving does not conclude.
- **A final node with no `skill_ref` at all** closes on arrival. It is a
  defensive branch, not a supported document shape: no graph that goes through
  `POST /v1/graphs` gets here. It exists so that a malformed snapshot, or one
  older than the field, degrades instead of blowing up, the same posture as
  `resolveNode` and `resolveOutputSchema`.

The rule is about the **presence of the pin**, never about `node_type`: a gate is
not a separate entity (§2), and a final gate with a skill runs exactly like a
final work node with a skill.

Why this is here and not only in the code: the bets factory graph ends at
`registro-monitoramento`, which pins `registrar-travessia` — D14's recording and
monitoring step —, and the software one ends at `deploy`, which pins
`verify-release`. While completion came from arrival, those two steps never
got a session, and the traversal ended in silence: no failure, no event, no
record. It was gap 2 of the first real execution
(`notes/2026-08-17-first-bets-run.md`).

A session that finishes `completed` with a report the schema refused does **not**
conclude and does **not** block: the job is still a candidate. A ceiling on
consecutive failed attempts is a general problem of the core, not of this point
of the graph.

---

## 5. Class and lineage

`problem_class` (D8) is named by the user in the problem declaration; the synthesizer
only suggests an existing class when it recognizes a resemblance. It is the
graph's versioning root and the telemetry's aggregation unit — two graphs of the
same class are comparable; of different classes, not.

`lineage` (D13) positions this graph inside the class:

```json
{ "type": "base" }
```
```json
{ "type": "variante", "base_class": "software-development",
  "source_proposal_id": "prop-2026-08-31-004" }
```

| Field | Required | What it is |
|---|---|---|
| `type` | yes | `base` (the class's canonical graph) or `variante` (a fork of a base). |
| `base_class` | when `variante` | The class of the base graph the variant came out of. |
| `source_proposal_id` | no | The topografo's proposal that originated the fork. |

A `base` declares neither `base_class` nor `source_proposal_id` — the schema
forbids it.

`source_proposal_id` is optional, but almost always present: **a fork is never
born of an a-priori decision**, but of a topografo's proposal with evidence of
systematic divergence in the telemetry (D13). The foreseen exception is the
variant imported from an external atlas, which has no local proposal of origin.
Learning flows both ways and always through a gate: a variant's diff that beats
the base becomes a promotion proposal; an improvement in the base is offered to
the variants, never forced on them.

---

## 6. Soundness

**Shape** validation is the JSON Schema. **Soundness** validation is semantic and
lives in [`scripts/validate-graph.mjs`](../../scripts/validate-graph.mjs), which
exports two functions:

```js
validarEstrutura(doc) // → { valid, errors: [{ code, message, target }] }
validarSoundness(doc) // → { valid, violations: [{ rule, target }] }
```

`validarEstrutura` covers shape and referential integrity: the required keys
present, node ids unique, every edge and every id in `initial_node`/`final_nodes`
pointing at a node that exists. `validarSoundness` runs the four rules below, in
this order. Neither of them throws on a malformed document: the synthesizer needs
the whole report, not the first error.

The rules come from workflow nets (van der Aalst) and are one of the project's
quality non-negotiables. It is where the positioning sentence comes from: **"we
formally verify the graphs the AI proposes"**.

| Rule | What it demands | Reported target | Counterexample |
|---|---|---|---|
| `reachable` | Every node is reachable from `initial_node` by following `edges`. | the node's id | [`graph-invalid-unreachable-node.json`](../../schema/examples/graph-invalid-unreachable-node.json) |
| `terminates` | From every node there is a path to some node in `final_nodes`. | the node's id | [`graph-invalid-without-termination.json`](../../schema/examples/graph-invalid-without-termination.json) |
| `edge_with_condition` | No edge with a `condition` that is absent or empty. | `{from, to}` | [`graph-invalid-edge-without-condition.json`](../../schema/examples/graph-invalid-edge-without-condition.json) |
| `node_with_contract` | No node without a `skill_ref` or a `contract`, nor with an empty `checks`. | the node's id | [`graph-invalid-node-without-contract.json`](../../schema/examples/graph-invalid-node-without-contract.json) |

Reading notes:

- **`reachable` is topological.** It follows edges regardless of the condition:
  an edge with an empty label still connects two nodes. What complains about the
  label is `edge_with_condition`. The rules are independent on purpose — every
  counterexample in the repository violates exactly one of them, which makes each
  rule demonstrable in isolation.
- **`terminates` is computed backwards**, from the edges reversed starting at the
  final nodes. A node trapped in a cycle with no exit is simply never reached —
  that is how a legitimate rework cycle passes and a forgotten exit does not.
- **`node_with_contract` holds just the same for a gate**, which is a node like
  any other.

Running it from the command line (it exits 1 if any document fails):

```
node scripts/validate-graph.mjs schema/examples/*.json
```

The tests are `node --test` (the repository still has no `package.json`, by
choice — zero dependencies).

### 6.1 Contract matching: every required input has a producer (`t278`)

Structure and soundness judge the document's shape and its topology. Neither one
asks the question a session actually depends on: **when a job arrives at this
node, will the data its skill declares as required be there?** Three real
crossings answered that at dispatch time, after the sessions were paid for
(`notes/2026-08-17-second-bets-run.md` gap 5,
`notes/2026-08-17-t109-game-feature.md` gap 4). `validateContracts`
([`packages/core/src/domain/graph.ts`](../../packages/core/src/domain/graph.ts))
is that question, answered statically, before any session opens.

**It checks the PINNED SKILL's `input`/`output`, never the node's own
`input_schema`/`output_schema`.** The subsection [`output_schema` documents; the
skill is what validates](#output_schema-documents-the-skill-is-what-validates-t267)
already draws this line for output, and it holds for input too — where the two
have already drifted: the software bundle's `refine` node declares
`required: ["ticket_id", "request"]`, while `refine-ticket@1.0.0` really requires
`["job", "project"]`. Only the skill's schema is enforced anywhere, so only the
skill's schema is checked.

**The three sources a node can count on**, and nothing else:

| Source | Paths | Who supplies it |
|---|---|---|
| Control-plane projection | `job`, `job.id`, `job.title`, `job.body`, `traversal`, `traversal.nodes_visited`, `traversal.entered_at`, `traversal.sessions_by_node`, `perguntas_respondidas`, `project`, plus `project.<key>` for each key the document's own `project` declares, plus each `custom_fields[].name` as a top-level scalar | `domain/context.ts`'s `buildNodeInput` (`ALWAYS_AVAILABLE_INPUT_PATHS`) |
| Executor environment | `banco_de_testes`, `banco_de_testes.caminho`, `banco_de_testes.comandos_de_dados`, `referencia`, `referencia.commit`, `referencia.modo`, `referencia.lido_em` | the runner, at every dispatch (`EXECUTOR_PROVIDED_INPUT_PATHS`) |
| Ancestors' output | `<balde>.<name>` for every `name` in the ancestor's skill `output.required`, where `<balde>` is its `produces` (top level when it declares none) | whichever node ran before |

`job.type` is **not** on the list: the column does not exist, the projection
omits the key when it is absent, and a skill that requires it is refused even at
the initial node. `resultado` is never counted as produced: it is the routing
label, stripped before storage (`t269`).

**A node is judged on every path into it, not on some path.** A node can have
more than one incoming edge — a rework loop, three edges into one final node — so
availability is a meet over predecessors:

```
avail(initial_node) = BASE
avail(N)          = BASE ∪ ⋂ over every predecessor P of (avail(P) ∪ produced(P))
```

Intersection, not union, iterated to a fixed point (the set only shrinks, so it
converges in at most `nodes.length` rounds). A key produced only after a rework
loop is not there the first time the node runs, and this is what says so. It is
the same computation a compiler runs for "available expressions".

**Declared limit: one level of nesting, on both sides.** A required `project`
whose own schema requires `capital` is checked as `project` and `project.capital`
— and stops there. `project.capital.total` is **not** checked, on either the
producing or the consuming side. Two levels would mean walking arbitrary JSON
Schema (`$ref`, `allOf`, `items`) to decide what a path even means, and every
incident that motivated this rule is one level deep. A gap deeper than that
survives the check.

**The vocabulary of the report** (`ContractReport`, the `contracts` key of the
`422` and of the `201`):

| Name | What it says |
|---|---|
| `unproduced_input` | The node requires this key path and no path into it supplies one. Carries `node_id`, `key` and `produced_elsewhere_by`. |
| `skill_ref_unresolved` | The pin resolved to nothing, so this node's contract could not be read. It is not availability-checked, and it contributes nothing to its descendants. |
| `produced_elsewhere_by` | Node ids whose skill output would place this exact path *somewhere* — under a bucket the reader does not open, or on a path that does not always reach it. Empty means the key exists nowhere in the document. |

**Where it runs, and where it does not.** `cartografo import` runs it offline
over the bundle's own `skills/` (scope `contract`, alongside `graph`, `manifest`
and `pin`), which is the check a bundle author wants before anything is sent.
The three routes that write a graph version — `POST /v1/graphs`,
`POST /v1/graphs/:id/fork` and `POST /v1/proposals/:id/apply` — each answer for
the version they write, and the next subsection is how. The two DB-less
reference validators
([`scripts/validate-graph.mjs`](../../scripts/validate-graph.mjs) and
[`scripts/validate-factory-bundle.mjs`](../../scripts/validate-factory-bundle.mjs))
do not carry this check: it needs a skill lookup, and they have none by design.

**The outcome is on the answer, whichever it is (`t284`).** `POST /v1/graphs`
publishes `contracts` on the `201` too, and not only inside the `422`. Until
`t284` the success said `{graph, graph_version}` and nothing more, so "every
contract was checked and they hold" and "no contract was read at all" arrived at
a client as the same body — and the second one is a graph nobody has judged yet.

| `contracts` | When | What it carries |
|---|---|---|
| `{"status": "checked", "valid": …, "problems": […]}` | every pin resolved | the report above. `valid: false` is the `422`; on a `201` it is always `true` |
| `{"status": "skipped", "reason": "skill_ref_unresolved", "problems": […]}` | at least one pin unresolved | the `skill_ref_unresolved` problems and nothing else — no `valid`, because a check that did not run neither passed nor failed, and no `unproduced_input`, because those were computed with an ancestor that produces nothing only for want of a manifest |

`skipped` is what happened to the CALL, and since `t283` it is no longer the end
of the story: the same `201` carries `graph_version.contracts`, the state the
version was stored with, and §6.2 is what becomes of it. The two keys are not
the same shape and must not be read as one — `status`/`valid` is the verdict of
this call, `state` is where the version stands.

### 6.2 The state a version carries, and the one gate that reads it (`t283`)

Registering a document and running work against it are two different promises,
and until `t283` they were the same code path. `POST /v1/graphs` is permissive on
purpose — a graph whose skills arrive afterwards is the ordinary case for the
screen's editor, for a forked example and for every fixture in
`schema/examples/` — so the check standing aside there is right. It stops being
right the moment a job runs against that version, which is where D9's "contract
is the common spine" has to hold. So the check's outcome is no longer only
reported: it is **stored on the version**, and the gate moved to execution.

`graph_version` carries `contracts_state` and `contracts_report`
(`entities-versioning.md` §1), and every read of a version publishes them as
`contracts: {state, problems}` — `GET /v1/graphs/:id/versions`,
`GET /v1/graph-versions/:id` and the `201` of all three write routes.

| `state` | What it means | How a version gets there |
|---|---|---|
| `checked` | every pin resolved and the check passed | the check ran, at birth or on a re-check |
| `unchecked` | at least one pin resolved to nothing, so the question was never answered | birth over a registry that could not answer; it is left the moment the missing manifest is registered |
| `failed` | every pin resolved and the check refused | a re-check, or applying a proposal whose result is resolved and invalid — never `POST /v1/graphs`, which answers `422` for that document instead of writing it |

`unchecked` is **not** a soft `failed`. It is the absence of an answer, and the
distinction is what tells a caller what to do: register the manifests the report
names, and the version moves on its own; a `failed` one needs a new version of
the graph.

**The three write sites, and why they answer differently.** A default here would
have been a fourth answer and the wrong one: two of the three paths would mint
versions permanently `unchecked`, because the only re-check trigger is a manifest
arriving, and a class whose skills are already registered never fires one.

- **`POST /v1/graphs`** runs the check against the registry and stores what it
  classified. `failed` still refuses with `422` and writes nothing.
- **`POST /v1/graphs/:id/fork`** *copies* the base's stored answer. It does not
  recompute and does not touch the registry: the variant is the base's snapshot
  with `lineage` swapped, and this check reads `nodes`, `edges`, `custom_fields`,
  `project` and `initial_node` — never `lineage`.
- **`POST /v1/proposals/:id/apply`** *recomputes*, because the applied document
  differs from its target — that is what a proposal is. It adds no refusal of its
  own: a resolved-but-invalid result is stored `failed`, and the gate below is
  where that bites.

**The re-check.** Registering a manifest (`POST /v1/skills`, and only when a row
is really written — a same-hash reimport changes nothing) re-runs the whole check
over every `unchecked` version that pins it, against the registry as it stands
now. Each version that is re-judged records
[`graph_version.contracts_checked`](../../specs/events/taxonomy.md).
It re-runs the WHOLE check and not just the one pin, because a version can be
waiting on three manifests, and it may land on `failed`: resolving the last pin
is what finally makes an `unproduced_input` real evidence instead of an artefact
of an empty registry.

**The gate.** `POST /v1/jobs` refuses a `graph_version_id` that resolves to a
version whose state is not `checked`, with `409` and
`graph_version_unchecked` / `graph_version_contracts_failed`, carrying
`graph_version_id` and `contracts`. It is enforced in `createJob`
(`repositories/job.ts`), the single writer of a job row, so every future caller
inherits it. A job with **no** `graph_version_id`, or one that resolves to
nothing, is unchanged: the control plane has nothing to read, and refusing over
an absence would break the manual and imported flows for a fact it cannot check.

---

## 7. The document as an exportable bundle

We version the way git thinks, with no git in the core (D15). A graph version's
snapshot is **this whole document**, and that is what `graph_version`'s
`snapshot` column keeps once the control plane exists (`t100`/`t101`). Since the
document is self-contained, it **is already the minimal exportable bundle**: any
version comes out as one file, crosses the border (an atlas, a backup, a mirror
in the user's repository, a future approval via PR) and comes back without
needing the database it came from.

What the format assumes of the rest of the system:

- **A semantic diff, not a line diff.** A topografo's proposal is a list of typed
  operations over this document (add a node, redirect an edge, tighten a
  verification), each one with its inverse. The order of the keys and the JSON's
  formatting carry no meaning.
- **Append-only.** Applying a proposal is: apply the ops → validate soundness on
  the result → write a new version → move the pointer. A rollback moves the
  pointer back; nothing is deleted.

Multi-graph and multi-file packaging — the atlas's layout, the publication step,
the integrity check across the crossing — is in
[`docs/formats/atlas-bundle.md`](../formats/atlas-bundle.md), which treats one
directory per class (`graph.json` plus the manifests the nodes pin) and keeps the
verification on the two hashes that already exist: the graph version's `id` and
each node's `skill_ref.hash`. Here it ends at: one graph, one file,
self-contained.

---

## 8. Examples

All of them in [`schema/examples/`](../../schema/examples/), all of them
exercised by `tests/schema-grafo.test.mjs`.

| File | What it is for |
|---|---|
| [`graph-valid-minimal.json`](../../schema/examples/graph-valid-minimal.json) | The smallest sound document: one work node, one terminal gate, one `"always"` edge. A skeleton for the first graph. |
| [`graph-valid-flowpilot.json`](../../schema/examples/graph-valid-flowpilot.json) | **The master example.** See below. |
| [`graph-valid-two-engines.json`](../../schema/examples/graph-valid-two-engines.json) | Two work nodes on one edge, one with no `engine` and the other with `"engine": "codex"`: the smallest document that tells a default from a route (§2). |
| `graph-invalid-*.json` | One counterexample per soundness rule (§6). |

### The master example: flowpilot's flow

[`graph-valid-flowpilot.json`](../../schema/examples/graph-valid-flowpilot.json)
is flowpilot's software delivery flow expressed in this format, and it is
**direct input to factory graph 1 (`t105`)**: the factory graph's ticket starts
from this file instead of from a blank sheet. By D17 flowpilot is a behavioural
reference **with no code dependency** — the port is a reimplementation, and
nothing here reads anything from there at run time.

Five nodes, one per activity state:

| Node | Role | `node_type` | State in flowpilot |
|---|---|---|---|
| `refine` | architect | work | `refining` |
| `develop` | developer | work | `developing` |
| `integrate` | integrator | work | `integrating` |
| `test` | tester | **gate** | `testing` |
| `deploy` | deployer | work | `deploying` |

Five edges, following `ALLOWED_TRANSITIONS`:

```
refine ──always──▶ develop ──always──▶ integrate ──always──▶ test
                       ▲                                      │
                       └──────────── rework ──────────────────┤
                                                              │
                                              deploy ◀──approved
```

Two modelling decisions the port took:

1. **Flowpilot's queue states do not become nodes.** `to_refine`, `to_develop`,
   `to_integrate`, `to_test` and `to_deploy` are the controller's scheduling
   plumbing — where the work waits, not what the work does. The graph's edges are
   the transitions of `ALLOWED_TRANSITIONS` with those queues collapsed. By the
   same criterion, `backlog` and `done` stay out: `deploy` is the final node,
   and flowpilot's `deploying → done` has no destination node here.
2. **`test` is a `gate`.** It is the only node with multiple exits, and what
   it produces is a verdict that routes — `approved` carries on to deployment,
   `rework` goes back to development (flowpilot's alpha test cycle). The rest
   are `work`: they deliver an artifact and have a single exit.

The three edges of `TRIVIAL_EXTRA_TRANSITIONS` (the `work_tier` shortcuts) were
deliberately left out: a tier is a scheduling policy applied on top of the
topology, not topology. If the port needs them, they come in as a `t105`
decision, on the record.
