# Specification: transition hooks declared in the graph

**API version:** `v1` · **Migrations:**
[`0016_gancho`](../../packages/core/migrations/0016_gancho.sql),
[`0018_segredo_gancho`](../../packages/core/migrations/0018_segredo_gancho.sql)
**Format:** [`schema/graph.schema.json`](../../schema/graph.schema.json) ·

This document is the contract for whoever writes the graph **and** for whoever
receives the delivery, and it is deliberately self-sufficient: the hook and the
whole receiver — signature verification included — can be written without opening
a line of the control plane's code. What travels is the envelope of the
[event taxonomy](../../specs/events/taxonomy.md), with no translation
along the way, exactly the same object the [SSE stream](events-stream.md)
delivers in its `data:` field and the
[signed webhooks](webhooks-events.md) deliver by POST.

---

## 1. What it is, and when to use it instead of a webhook

A hook is a reaction **the graph itself declares**: "when a job enters the
`testar` node, tell this address"; "when it gets stuck at `revisar`, call that
one". The declaration lives inside the graph document, beside the nodes and the
edges.

| | Webhook ([`webhooks-events.md`](webhooks-events.md)) | Hook (this document) |
|---|---|---|
| Who declares it | an operator, through `POST /v1/webhooks` | whoever writes the graph, inside the document |
| Where it lives | a row in `webhook_subscription` | the `hooks` key of the version's snapshot |
| Scope | every event of the project (with a filter by type) | one node, one trigger |
| Versioned with the graph | no | **yes** — it changes by proposal, with a diff and a way back |
| Where the HMAC key sits | `webhook_subscription.secret` | `hook_secret`, referenced by name (§2.1) |
| Transport | a signed POST, six attempts | the same, byte for byte |

Rule of thumb: if the reaction belongs to the PROCESS — "every time any job
reaches this step" —, it belongs to the map, and it is a hook. If it belongs to
your integration — "I want this project's whole log in my tool" —, it is a
webhook.

**Why that matters.** A registered webhook is state that exists only on the
machine where somebody ran the `POST`: exporting the graph does not take it
along, the topografo cannot propose it, and reverting a version does not undo it.
A hook is data in the document, so it survives an export, enters a proposal with
evidence and is undone together with the version that introduced it (D2, D15).

**What a hook is not:** it is not an edge. It does not change the current node,
does not decide a path, does not block and has no way of stopping the job. A
hook's failure is an incident (§6), never an outcome.

---

## 2. Declaring a hook

`hooks` is an optional list at the top of the document. Absent = no reaction,
which is the case for every graph written before this ticket — not one of them
had to be touched.

```json
{
  "problem_class": "nota-curta",
  "nodes": [ ... ],
  "edges": [ ... ],
  "initial_node": "redigir",
  "final_nodes": ["revisar"],
  "hooks": [
    {
      "id": "avisar-revisao",
      "trigger": "node_entered",
      "node_id": "revisar",
      "destination": {
        "type": "webhook",
        "url": "https://my-service.example/cartografo",
        "secret_ref": "gancho-revisao"
      },
      "description": "Tells the on-duty reviewer when a note arrives for review."
    }
  ]
}
```

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Unique in the document. The same character class as a node's id: `^[a-z0-9][a-z0-9_-]*$`. |
| `trigger` | yes | `node_entered` or `node_blocked`. Any other value is refused at validation. |
| `node_id` | yes | Has to be the id of a node that exists in `nodes`. |
| `destination.type` | yes | Today only `webhook` (§7). |
| `destination.url` | yes | An absolute `http:` or `https:` URL — the same rule as `POST /v1/webhooks`. |
| `destination.secret_ref` | yes | The **name** of the HMAC key, never the key (§2.1). The same character class as a node's id. |
| `description` | no | What the reaction is for, in one sentence. |

The complete example, with one hook per trigger, is in
`schema/examples/graph-valid-with-hooks.json` — cited and not linked, because
the file's own name is still Portuguese and a link target is prose to a sweep
that reads lines; renaming it belongs to the path ticket.

### 2.1. The secret does not live in the document

The document **names** the key; the one that keeps it is the deployment. A graph
that still carries a `secret` field is refused at shape validation — the required
`secret_ref` is missing, and the unknown key hits `additionalProperties: false`.

**Why.** The document is content-addressed (D15): it goes whole into the
version's hash, comes out whole through `GET /v1/graph-versions/:id`, is written
to disk by `cartografo export` and copied byte for byte into the atlas D7 orders
published. A key written there is a key belonging to everybody who reads the map
— and rotating one that leaked would mean proposing a new version whose diff
shows the old one and the new one side by side, forever, in a history that is
never erased.

`secret_ref` belongs to the same family as `engine`, `model` and
`escalation_policy` ([`graph.md`](graph.md)): a value the document declares and
the deployment resolves at dispatch time, never the validator at import — because
the validator does not know what THIS deployment has. That is why a `secret_ref`
that does not resolve is **not** a validation error: it is zero deliveries (§4).

Registering the key is an authenticated `PUT`, with the name in the path:

```
PUT /v1/hook-secrets/gancho-revisao
Content-Type: application/json

{"value": "a-long-random-string-that-i-chose"}
```

| Route | What it does |
|---|---|
| `PUT /v1/hook-secrets/:nome` | Registers (`201`) or **rotates** (`200`). Answers `{nome, criada_em}` — the `valor` never comes back. |
| `GET /v1/hook-secrets` | Lists `{segredos: [{nome, criada_em, revogada_em}]}`, oldest to newest, with no `valor` anywhere. |
| `DELETE /v1/hook-secrets/:nome` | Revokes the live key of that name. Idempotent; `404` on a name nobody registered. |

All three demand a `usuario` credential: a runner takes a
`403 credencial_fora_de_escopo`.

**Rotating is registering again.** The `PUT` revokes the live row and writes a
new one, in the same transaction — nothing is overwritten and nothing is deleted
(D15/D2), so "when did this key stop holding" is still answerable. The new key
holds from the next queued delivery on; a delivery already in flight ends with
the one that held when it was born (§4). And the graph document does not change a
comma: the name is still the same, so there is no new version, no proposal and no
diff.

The `value` sits in clear text in the database, and that is deliberate: the
signature is an HMAC, so the key has to be REUSED on every delivery — it cannot
become a digest the way `0007`'s credential does. It is exactly
`webhook_subscription.secret`'s posture; what this ticket changed was
WHERE the key lives, not how it is kept.

---

## 3. What fires, exactly

| Trigger | Fires on | Matches when |
|---|---|---|
| `node_entered` | `job.transitioned` | `data.to_node_id` equals the hook's `node_id` |
| `node_blocked` | `job.blocked` | the job's `no_atual` at the moment of the block is the hook's `node_id` |

Several hooks can match the same fact, and each one becomes an independent
delivery: one that fails neither delays nor cancels the other (§6).

**A hook on the `initial_node` never fires.** Placing the job at the start is a
`job.created`, not a `job.transitioned` — for the same reason `from_node_id` is
`null` on the first transition. It is not a hidden limitation: it is what
"entered the node" means when the arrival is the birth. If you need to react to
the creation, the transport for that is a `job.created` webhook.

**Unblocking fires nothing.** `node_unblocked`, `node_exited` and custom
conditions are outside this ticket's scope.

---

## 4. Queuing is synchronous; delivering is not

This is the heart of the "a hook never stalls the traveller" guarantee, and it is
worth being explicit about both halves:

1. **Queuing** happens INSIDE the same SQLite transaction that writes the job's
   projection and the event. If the transition is rolled back, its deliveries
   disappear with it; there is no window in which the job moved without the
   declared reaction being in the queue.
2. **Attempting to deliver** happens afterwards, in a background tick.
   `POST /v1/jobs/:id/transitions` answers `200` without waiting on any network
   call — not the first attempt, not the 10-second timeout, not the six retries.

It is the webhooks' discipline ("the write path never waits on a webhook"), and it is
what makes the guarantee structural rather than defensive: there is no
`try/catch` protecting the traversal because there is no code path from the
socket to it.

The document's `url` and the key **resolved** from the `secret_ref` are copied
into the delivery row at the moment it is queued. A new version of the graph can
point the same hook somewhere else, and a `PUT /v1/hook-secrets/:nome` can rotate
the key — and a delivery in flight ends against the destination that held when it
was born, never against the one that would hold today. It is the same instant and
the same reason for both: only the SOURCE of the key moved, the semantics
of the delivery row's `secret` column are what they always were.

If the job has no `graph_version_id`, if the version cited does not resolve, if
its snapshot has no `hooks`, or if a hook's `secret_ref` matches no live secret,
the result is the same: zero deliveries, zero errors. The last case is that of
somebody who imported a graph without registering what it references, and for now
it is silent on purpose — giving a signal about it (an event, a gate, a warning
at import) is a separate ticket.

---

## 5. The delivery, and how to verify the signature

Every firing becomes a POST identical to a registered webhook's:

```
POST /cartografo HTTP/1.1
Host: my-service.example
Content-Type: application/json
X-Cartografo-Signature: sha256=8f4c...  (64 hex characters)

{"id":131,"type":"job.transitioned","project_id":1,"execution_id":2,"entity":{"type":"job","id":7},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-16T12:00:03.114Z","data":{"from_node_id":"redigir","to_node_id":"revisar"}}
```

The body is the whole envelope of the event that fired the hook, byte for byte
the same object `GET /v1/executions/:id/events` returns and the stream's `data:`
carries. There is no field saying which hook produced this delivery: the receiver
knows which one is its own because every hook has its own URL and its own secret.

The signature recipe, in full — the webhooks' own, with one difference in the key:

> `X-Cartografo-Signature` = `sha256=` + HMAC-SHA256 of the **raw body**, with
> the key THIS HOOK's `destination.secret_ref` resolved to, in lowercase hex.

Nothing changes on your side: the key is the string you sent in the `valor` of
`PUT /v1/hook-secrets/:nome`. The graph document carries its name, and the
control plane resolves the name at queuing time — you never read the key back
through any route, so keep it when you register it.

Three details that decide whether your verification works:

- **Sign the bytes that arrived, not the reparsed object.** `JSON.parse` followed
  by `JSON.stringify` does not necessarily give back the same bytes, and a
  different byte is a different digest. Read the raw body first, verify, and only
  then parse.
- **Compare in constant time** (`crypto.timingSafeEqual`), never with `===`.
- **With no valid signature, do not trust the body.** The URL is written in a
  graph document any client of the API reads; the signature is the only thing
  separating a delivery from the control plane from whoever found the address.
  The key that produces it is no longer in that document — whoever
  reads the map reads where the reaction goes, not what it signs with.

In Node, the whole recipe is one line — the same one the server runs:

```javascript
import { createHmac } from 'node:crypto';
const signature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
```

The zero-dependency minimal receiver of
[§8 of `webhooks-events.md`](webhooks-events.md) serves here without a line of
difference: swap the secret's variable for the key you registered for this hook's
`secret_ref`.

**Answer fast.** Any `2xx` closes the delivery; the server does not read your
response's body. If your processing is slow, accept (`200`), queue on your side
and process afterwards.

---

## 6. Retries, giving up, and the failure event

The scale is the webhooks', step for step — the same `RETRY_BACKOFF_MS`, so that a
receiver already written needs no adjustment at all:

| Attempt | When |
|---|---|
| 1st | as soon as the hook is queued (up to ~1s after the fact) |
| 2nd | 10 seconds after the failure |
| 3rd | 1 minute later |
| 4th | 5 minutes later |
| 5th | 30 minutes later |
| 6th | 2 hours later |

Six attempts in total. What counts as a failure is the 10-second `timeout`, a
network error and **any** response that is not `2xx` — including a `3xx`, which
is not followed.

| State | Means |
|---|---|
| `entregue` | a `2xx` arrived. `entregue_em` records when, and **nothing is written to the log**. |
| `esgotada` | all six attempts failed. `last_error` keeps the last one, and the control plane writes ONE `job.hook_failed`. |

**Success is mute, giving up is an event.** A hook has no registered subscriber:
nobody is polling its queue, so a reaction that fails forever in silence is
exactly what whoever wrote the graph cannot find out about. The
[`job.hook_failed`](../../specs/events/schemas/job.hook_failed.schema.json)
solves that through the transports that already exist — it shows up in the stream
and in the registered webhooks with no extra work at all:

```json
{"hook_id":"avisar-revisao","node_id":"revisar",
 "url":"https://my-service.example/cartografo","last_error":"HTTP 502"}
```

It is written **only on exhaustion**, never per attempt: a transient failure is
retried and disappears on its own, and one event per attempt would fill the log
with noise that corrects itself. And it is an **incident, not an outcome** —
`entity.id` is the job, but nothing in its traversal changes because of it.

An `esgotada` delivery is not retried, however much time passes, and there is no
route to send it again — the webhooks' own absence. The row is not deleted: "I tried six
times and gave up" is an audit fact.

A broken hook is nobody's problem but its own: a batch's deliveries go out
together, each with its own timeout, and no failure delays another hook's, holds
up the tick or touches the write path.

---

## 7. Validation: what is refused, and where

SHAPE validation belongs to
[`graph.schema.json`](../../schema/graph.schema.json) — a missing required field,
a `trigger` outside the vocabulary, an unknown `destination.type`, a `url` that
is not an absolute `http(s)` one, a `secret_ref` outside the charset
`^[a-z0-9][a-z0-9_-]*$` (and a leftover `secret`, which is how a document in the
old format is refused).

What validation does **not** do is resolve the `secret_ref` against the database.
Both structural passes are pure and database-free, kept in byte-for-byte parity
between `scripts/validate-graph.mjs` and the port in
`packages/core/src/domain/graph.ts` — a check that consulted the database would
break the contract for one of the two and not for the other. A name that does not
resolve is zero deliveries (§4), never a `422`.

REFERENTIAL validation belongs to the graph validator's **structural** pass
(`scripts/validate-graph.mjs` and the port in
`packages/core/src/domain/graph.ts`, kept in byte-for-byte parity):

| Code | When |
|---|---|
| `gancho_no_inexistente` | the hook's `node_id` is not a node of the document |
| `id_gancho_duplicado` | two hooks with the same `id` |
| `gancho_invalido` | the entry in `hooks` is not an object |

A dangling hook is **not** a soundness violation. The four formal rules
(reachable, terminates, edge with a condition, node with a contract) are
properties of the workflow net, and a reaction pointing nowhere says nothing
about the net — it is a shape defect, and it comes out in the `estrutura.erros`
list of the `422`.

---

## 8. What does not exist yet

- **A `local_command` destination.** Having the control plane run a shell command
  that arrived as graph DATA is another ticket, with a review/permission gate of
  its own mirroring the one for skill import (D4). `destination.type` is an enum
  of a single value precisely so that the second variant is additive. Note the
  asymmetry with the rest of the system: every command the cartografo runs today
  executes inside a session's worktree, under the runner, and never on the
  control plane's machine.
- **Other triggers** (`node_exited`, `node_unblocked`, a custom condition).
- **A signal for a `secret_ref` that does not resolve.** Today it produces zero
  deliveries in silence (§4). An event, a gate or a warning at import is a
  separate ticket, and it is worth writing if this ever bites somebody in
  practice.
- **Manually resending** an `esgotada` delivery.
- **A screen for hooks.** This ticket is control plane only; a hook is read and
  edited in the graph document.
- **A filter by job or by execution.** A hook reacts to a node, for every job
  that goes through it.
