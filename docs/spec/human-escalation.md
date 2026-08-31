# Specification: human escalation, end to end

**API version:** `v1` · **Migration:** none (it reuses the tables of
[`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Founding decision:** [D16](../../DECISIONS.md) — the PoC's ruler demands "human
questions flowing through the API" with "sessions dispatched by the
EngineAdapter"

Human escalation is a first-class entity, not a special case
([README](../../README.md), principle 5). The entity — the question,
the answer, the auto-resolution, the queue — and stopped on purpose before wiring
it to the job — is described here, as the cycle it closes:

```
session asks → job blocks → somebody answers → job unblocks
             → the next tick redispatches, already knowing the answer
```

The point is none of the five arrows on its own: it is that not one of them
depends on a manual step somebody could forget to take.

---

## 1. Where each half lives

| Half | Where | Why |
|---|---|---|
| question ↔ block flag | `packages/core` (the question's repository) | Both live in the same database and the same process. Atomicity comes for free. |
| escalation block → question | `packages/runner` (`src/dispatch/`) | Only the runner sees a session's output. The control plane never reads a transcript. |

The boundary is the usual one: **only the server writes**
([D1](../../DECISIONS.md)). The runner reads the job, opens the session, and what
it does with an escalation request is `POST /v1/input-requests` — like any other
client of the API.

---

## 2. Asking blocks, in the same transaction

`POST /v1/input-requests` writes the question, the
[`input_request.created`](../../specs/events/schemas/input_request.created.schema.json)
event **and** raises the owning job's flag, all inside the same transaction — a
nested `db.transaction` becomes a savepoint in `better-sqlite3`, so either all
three things happen or none of them does.

```json
{"reason": "awaiting the answer to input request 900"}
```

The reason cites the question's id (the example is the
[taxonomy](../../specs/events/taxonomy.md)'s own): whoever reads the
job finds out from the reason what has to happen for it to move again, without
crossing two tables.

**The block's actor is `sistema/escalacao-humana`**, and not the agent that asked
nor the human who will answer: what raised the flag was the wiring. It is the
only use of the `ATOR_ESCALACAO` constant.

**The route did not change shape.** `POST /v1/input-requests` still returns the
question alone; whoever wants the flag reads `GET /v1/jobs/:id`. Returning both
together would save a request and cost a contract — the question-creation
response would start speaking about a job.

### Why the runner is not left to do the blocking

Because that would be two owners for one flag. The runner would have to call
`POST /v1/input-requests` and `POST /v1/jobs/:id/blocks` in sequence, and every
process that died between the two calls would leave a pending question with the
job loose — which is exactly the state the cycle exists to prevent. Both routes
still exist and are still valid for a manual block; what does not exist is a path
where asking and blocking can come apart.

---

## 3. Answering unblocks, with the actor of whoever answered

`PATCH /v1/input-requests/:id/answer` and
`PATCH /v1/input-requests/:id/auto-resolution` write the answer and lower the
flag in the same transaction. The
[`job.unblocked`](../../specs/events/schemas/job.unblocked.schema.json)
event carries the **same actor** as the answer's event:

| Who answered | The answer's event | The unblock's actor |
|---|---|---|
| a person | `input_request.answered` | `usuario/<respondido_por>` |
| an automatic gate | `input_request.auto_resolved` | `sistema/portao-auto-aprovacao` |

This is not a logging detail. The whole safety ladder of the evolution
([README](../../README.md), principle 5) depends on being able to answer "was
this decided by a person or by the system?" — and an unblock that always says
"system" erases half the answer.

The unblock is unconditional: it does not check whether the flag was raised by
this question. A job may have been blocked for another reason at the same time,
and "I answered and the job stayed put" is the worst possible outcome for
somebody who has just answered.

---

## 4. From the block of text to the question

A session that cannot go on without a decision **ends the turn** with a fenced
block and stops. It does not stay alive waiting: a stalled session is stalled
quota, and the control plane already knows how to keep the state.

````
```input-request
{"question": "...", "context": "...", "options": ["..."],
 "recommendation": "...", "default": "..."}
```
````

The parser (`packages/runner/src/dispatch/parse-input-request.ts`) inherits its
behavioural contract from flowpilot's `controller_parser.py`
([D17](../../DECISIONS.md) — flowpilot is a behavioural reference, never a
dependency):

1. **The block's extent comes from the JSON, never from a search for the closing
   fence.** A `context` quotes fenced code all the time, and a naive scan for the
   next fence would cut the block in half.
2. **A malformed block is ignored, never thrown.** Bad model output cannot take a
   dispatch down: the job simply carries on without escalation.
3. **The last valid block wins.** The final answer beats the draft — and rubbish
   written after a valid block does not erase the valid block.

Only `question` is required. A block with no question is not answerable, and
recording it would put an empty row in somebody's queue with a blocked job behind
it.

### The output comes in frames, not in prose

The Claude Code adapter delivers `stream-json`: every line is a frame, and the
agent's text arrives **escaped** inside it. If the parser got the raw lines, no
fenced block would ever parse — the quotes would be `\"` and the breaks literal
`\n`. That is why the dispatch decodes the frames back into text before calling
the parser.

The suite's fake engine prints plain text lines, which pass through that decoding
untouched. Which is to say: **this is a case CI does not catch and only the
manual proof catches** (`scripts/spike-human-escalation.mjs`).

---

## 5. Resuming is redispatching

There is no session resume. `continueSession`/resume is declaredly outside
`EngineAdapter` v0
([engine-adapter.md](../formats/engine-adapter.md), "Out of scope (v0)"), and
It is not brought in through the back door: **resuming here is always a
fresh dispatch**, made by the next `tick()` of the
[controller](runner-and-controller.md), with a new session.

What crosses from one session to the next is the **prompt**. For every question
of that job that has already been answered, the dispatch assembles:

```
## What you already asked, and what came back

This is decided. Do not ask again: follow the answer.

- **You asked:** <the question>
  **<who> replied:** <the answer>
```

Without that block, the redispatched session trips over the same doubt and asks
again, forever. With it, the same node instruction produces different behaviour
across the two dispatches — and that is exactly what the manual proof
demonstrates: session 1 asks and creates nothing, session 2 creates the file with
the name the person chose.

**Where each half comes from:** the ORDER of the questions comes from the job's
timeline (`GET /v1/jobs/:id/events` — the log is the only total order there is),
and the ANSWER comes from the projection
(`GET /v1/input-requests?status=answered`). It is not redundancy:
`input_request.answered` does not carry `job_id` in its payload, so the job's
timeline structurally does not see it
([`events.ts`](../../packages/core/src/db/events.ts), `EventFilter`). Whoever
reads that timeline expecting to see answers will be surprised — which is why it
is written down here.

---

## 6. Asking is a successful dispatch

`despachar` **resolves** when the session ends having asked. The lease goes back
through the `finally` the controller already has, and the job stops being a
candidate because it is blocked — not because somebody treated the dispatch as a
failure.

It rejects only what is a real failure: a session that did not come up
(`SessionStartError`) or that ended with a status other than `completed`
(`failed`, `timed_out`, `cancelled`). And even in those cases the question, if
there is one, is recorded before the error goes up: an escalation already written
cannot be lost because the process that produced it died right afterwards.

---

## 7. The one that asks is the node, not the runner

Everything above describes **one** behaviour: ask when stuck, and block until
somebody answers. That behaviour is the *default*, and not the only
option — the node declares its own in the graph, in `escalation_policy`
([graph.md](graph.md), §2):

| Policy | What the session gets in the prompt | What the wiring does with an escalation request |
|---|---|---|
| `always` | The `input-request` block **plus** the instruction to escalate before closing the node, even when it thinks it knows | `POST /v1/input-requests` — the whole cycle described above |
| `on_uncertainty` (default) | The `input-request` block, with the usual text | `POST /v1/input-requests` — the whole cycle described above |
| `never` | **No block.** In its place, the instruction that this node has nobody to ask, and that getting stuck here is reported as a failure of the node's contract | `POST /v1/jobs/:id/blocks`, with a reason citing the node and what got stuck. No question is created |

**Absent means `on_uncertainty`**, resolved at dispatch time: every graph written
before this field behaves exactly as it behaved, and the text the session
receives is byte for byte the one from before.

### Why `never` is not just a sentence in the prompt

Because a prompt instruction is obeyed with a probability, not with certainty,
and what is at stake here is a pending question in the queue of somebody who does
not exist. If the only defence were the instruction, the first session that wrote
the block anyway would create a `pergunta` **nobody** would answer, with the job
blocked behind it forever — the worst possible outcome, and precisely the one the
policy declared it wanted to avoid.

So `never` is wiring, not text: the runner resolves the node's policy before any
write and, when it is `never`, swaps the route. Both routes already existed, and
neither of them is new — `POST /v1/jobs/:id/blocks` has been the unconditional
block with a reason. What the policy picks is **which of the two
mechanics stops the job**, and nothing else.

The job stops either way. The difference is that in one of them somebody is
called.

That holds for **both** doors a question is born through (§2 and §4): the one the
session writes, and the one the wiring raises on its own when a node with two
exits ends without naming either. At a `never` node both become a block with a
reason.

`always` and `on_uncertainty` are still instructions, and that is deliberate:
whether the session really was uncertain is not machine-checkable, and a gate
that pretended to check it would be checking nothing.

### Changing the policy is a proposal

`escalation_policy` and `escalation_recipient` went into `CHANGEABLE_FIELDS`
(`packages/core/src/domain/operations.ts`), so changing a node's policy is a
`change_node_field` operation like any other: it goes through the human gate,
produces a new `grafo_versao`, revalidates the whole document and has an inverse.
Who changed it, when and what for stays in the history — which is the minimum for
a decision of the "this node stops calling people" kind.

### Which node the question came from

`input_request` gained the `node_id` column, stamped by the server from the
owning job's `current_node_id` — never coming from the request body, the same
trust boundary `project_id` and `execution_id` already had. The
`input_request.created` event carries the same field, and
`GET /v1/executions/:id/metrics-by-version` returns `input_requests_by_node`
alongside the per-version metrics.

Without that, a per-node policy would be a policy nobody can evaluate: "this node
stops to ask too often" needs a number, and the number needs to know which node
the question came from.

---

## 8. What this layer does not do yet

Every item here is another ticket's declared scope, not an oversight:

- **An auto-answer policy.** The `auto_aprovavel` field is written as `true` by
  the dispatch, and nothing reads it to answer on its own. The `/auto_resolucao`
  route exists and works; whoever calls it is a person, for now. That did not
  build it: what it left ready is the **fact** that gate will need to read — the
  node's policy, in the graph's snapshot, and the `node_id` on the question
  itself.
- **Updating `engine_session_ref` after the opening.** `session.opened` is
  written as soon as the session comes up, and the ref the engine reveals in its
  first frame arrives after that — there is no PATCH endpoint to fill it in. In
  practice the field stays `null`, and `null` here means "the engine had not said
  yet", never "this engine has no ref".
- ~~**Node instructions coming from the registered graph.**~~ **Closed by
  the graph.** A job sitting at a node of a registered graph is dispatched with that
  node's skill rendered into the session —
  [`render-skill-instructions.ts`](../../packages/runner/src/dispatch/render-skill-instructions.ts)
  fetches the pinned manifest, refuses the dispatch if the hash does not match
  (D4) and composes instructions, the node's contract, the checks and the
  permissions. The fixed literal (`DEFAULT_INSTRUCTIONS`) still exists, and only
  for the case with no graph to read at all.
  **What this adds to this document:** the paragraph about the `input-request`
  block became the `ESCALATION_PROTOCOL` constant, and it goes into BOTH texts.
  It is not tidying: a session that does not know how to escalate never
  escalates, and without that composition the whole cycle described here would
  have disappeared in silence for precisely the jobs that started driving on
  its own.
  **And it renders LAST, which is measured and not style.** From there
  until the first real crossing of the bets graph (the shift of 2026-08-17) that
  paragraph OPENED the system prompt, and in that crossing every session came
  back refused by `claude --print` itself: `stop_reason: "refusal"`,
  `stop_details.category: "reasoning_extraction"`, zero output tokens, 5 out of
  5, before the model read the node. The bisect isolated the cause to the
  POSITION and to nothing else — the same prompt without those lines arrives at
  `end_turn`, the same lines moved to the end arrive at `end_turn`, and a gentler
  rewrite kept at the top is still refused. What Anthropic's safeguard classifier
  bites on is a fenced JSON template OPENING a system prompt. Whoever touches
  that order again is turning every graph-dispatched session into a refusal: the
  text opens with the node's heading and closes with this paragraph, and that is
  how `DEFAULT_INSTRUCTIONS` (the case with no graph) always composed it — it was
  never implicated by the bisect because it already put the constant at the end.
- **A question raised by the wiring, not by the session.** A node
  with two or more exits whose session ends without naming any of them — no
  block, a malformed block, or a `resultado` that matches no edge — becomes a
  question through the same route and with the same blocking effect described
  here. The only difference is the actor: `{"tipo": "sistema", "ref": "runner"}`,
  against the `{"tipo": "agente"}` of a question the session wrote. They are two
  different facts — a model asking for a decision, and the wiring reporting that
  it has no rule to apply — and two spellings is what lets the log tell them
  apart.
- **A timeout on a pending question.** An unanswered question blocks the job
  forever, by design: the alternative is the system deciding on its own what it
  declared it could not decide. The same holds for the block of a `never` node
  (§7): it too waits for somebody, and what raises it is
  `POST /v1/jobs/:id/unblocks`, which already exists.
- **Delivering the escalation to `escalation_recipient`.** The node can name who
  ought to be called, and nothing sends anything to that name: there is no
  notification system and no system of roles in this repository to deliver to.
  The field is graph data, and that is all ([graph.md](graph.md), §2).
- **The queue's screen** and **the identity of whoever answers**: authentication
  authenticated these routes, but the token does not say which person is on the
  other side, and `respondido_por` still comes from the body.
