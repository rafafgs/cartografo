# Specification: the outbound event stream

**API version:** `v1` · **Migration:** none (it reads the `event` table of
[`0003`](../../packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql))
**Origin:** extension point nº 5 —
["events going out"](../../notas/2026-08-14-extension-and-quality.md) · **Ticket:** t123

This document is the contract for whoever consumes. It is deliberately
self-sufficient: a whole client can be written without opening a line of the
control plane's code. The format of what travels is the envelope of the
[event taxonomy](../../especificacoes/eventos/taxonomy.md), with no translation
along the way.

---

## 1. What it is

`GET /v1/events/stream` is a **near real-time** read of the telemetry log over
[SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html)
(`text/event-stream`): the connection stays open and every new fact arrives as a
message, in `id` order.

Why SSE and not WebSocket: the traffic is one-way (server → client) and the
envelope already carries the monotonic `id` that SSE's reconnection protocol
wants. WebSocket would bring a bidirectional machine nobody here uses, and a new
dependency in the repository.

**What this endpoint is not:** it is not history. It starts in the present (§5)
and serves the past only when you ask for it by cursor. To read a whole round
after the fact, there is `GET /v1/executions/:id/events`, which returns the
complete list in JSON.

---

## 2. The route

```
GET /v1/events/stream
Accept: text/event-stream
```

| | |
|---|---|
| Response | `200` with `content-type: text/event-stream`, a body open indefinitely |
| Headers | `cache-control: no-cache, no-transform`, `connection: keep-alive`, `x-accel-buffering: no` |
| Authentication | `Authorization: Bearer <token>` — mandatory, as on every v1 route since `t124` |
| Connection limit | none; there is no rate limit and no per-client backpressure either |

The token is the one the control plane prints on its first start
(`bootstrapToken` on the `cartografo.ready` line) and that the CLI reads from
`CARTOGRAFO_TOKEN`. It goes in the header of the request that OPENS the stream;
after that there is no renegotiation — a revoked credential is only noticed on
the next connection.

A slow consumer does **not** hold the control plane up: the connection reads the
table on its own account, on a clock of its own, and is not wired to the write
path. The worst a stalled client causes is its own delay.

---

## 3. Filters

Both are optional and they **add up** (AND, never OR).

| Parameter | Format | What it does |
|---|---|---|
| `projeto_id` | integer | Only that project's events. A non-integer value is a `400`. |
| `tipo` | a comma-separated list | Only the types cited, matching the exact string. An unknown type is a `400`. |

```
GET /v1/events/stream?projeto_id=1&tipo=job.transitioned,job.blocked
```

The values accepted in `tipo` are the types the control plane writes today:

```
job.created                session.opened               input_request.created
job.transitioned           session.finished             input_request.answered
job.blocked                session.permission_denied    input_request.auto_resolved
job.unblocked
job.amended                lease.granted                graph_version.registered
job.dependency_declared    lease.expired                graph_version.applied
job.hook_failed                                         graph_version.reverted

execution.finished
```

They are the taxonomy's nineteen, and the growth was additive as promised: the
filter never declared a list of its own — it validates against `KNOWN_TYPES`
(`packages/core/src/db/event-validation.ts`) —, so switching on the emission of
`lease.*` and `graph_version.*` in `t196` made them askable without a line of
contract change here, and `execution.finished` (D21, `t245`) came in the same
way: whoever wants to know only about the end of rounds subscribes with
`?type=execution.finished` and receives nothing else. A type outside the taxonomy
is still a `400`, and not an open connection that never delivers anything —
which is the worse of the two errors.

---

## 4. The message format

Every event becomes an SSE message with all three fields:

- `id` — the envelope's `id`. **It is the cursor**, and it is the only total
  order there is ([taxonomy](../../especificacoes/eventos/taxonomy.md));
- `event` — the event's `type`, which is what the browser's `EventSource` uses to
  dispatch through `addEventListener`;
- `data` — the whole envelope in JSON, on a single line.

A real excerpt from the wire, captured with `curl -sN`:

```
id: 1
event: job.created
data: {"id":1,"type":"job.created","project_id":1,"execution_id":2,"entity":{"type":"job","id":1},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-14T23:10:11.489Z","data":{"title":"exemplo do doc","entry_node_id":"entrada","body":null,"acceptance_criteria":null}}

: heartbeat

```

The object in `data` is byte for byte the same envelope
`GET /v1/executions/:id/events` returns — the
[taxonomy](../../especificacoes/eventos/taxonomy.md)'s eight fields, with the
type's whole specific payload inside `data`.

**A type's payload grows too, and it grows additively.** The envelope always has
the same eight fields; what lives inside `data` is per type, and gaining a new
field there never asked for a contract change here — the same path §3 describes
for the set of types. `session.finished` is the most touched of the nineteen: it
got `output` and `output_schema_error` in `t253`, `failure_kind` and
`refusal_category` in `t265`, and `output_accepted` in `t268`.

**`output_accepted` is the verdict on the session's structured report** — whether
it was accepted when checked against the `output` schema of the skill the node
pins (D9). Of the three, it is the only one that appears in **every** closure
from `t268` on: `true` when the report matched and also when nothing was
reported, `false` only on a refusal — and it is only on a refusal that `output`
comes back `null` and the reasons come whole in `output_schema_error`. For
whoever reads this stream that is what makes counting possible: a refused report
is `output_accepted === false`, and not the absence of the reasons list, because
"it was not refused" and "it was not checked" would be the same absence. Absent
is not `false` either, and that is why the schema declares it optional: the log
written before `t268` does not have the field, and is still valid. The one that
decides whether the job moves from that verdict is the runner, and it reads it
**synchronously** in the answer of the `PATCH /finish` itself, not from here
([runner-and-controller.md](runner-and-controller.md), "A report the control
plane refused holds the job at the node", `t268`): this stream is observation,
never a decision path.

The field-by-field of each type is still the
[taxonomy](../../especificacoes/eventos/taxonomy.md)'s, and not this document's:
repeating the payload descriptions here would create a second source of truth
purely so that it could diverge from the first.

**An unknown type is to be ignored, it is not an error** — and so is an unknown
field inside `data`. An old client reading a new log carries on reconstructing
what it understands; it is what makes the taxonomy extensible additively, in both
dimensions. It holds for whoever reads this stream.

---

## 5. Reconnecting: `Last-Event-ID`

The resume mechanism is **one only**, SSE's standard. There is no `desde_id`
parameter in the query: two ways of doing the same thing is one too many.

| Situation | What arrives |
|---|---|
| A connection **without** `Last-Event-ID` | Only what is written from the moment of the connection on. No history by accident. |
| A connection **with** `Last-Event-ID: 42` | Everything with `id > 42`, in order, and live from there on. |

The browser sends that header on its own when the `EventSource` reconnects. Any
other client sends it by hand — keep the `id` of the last message you
**processed** (not the one you received) and give that value back in the
reconnection's header. It is what closes the gap without duplicating anything.

A `Last-Event-ID` that is not an integer ≥ 0 is a `400`.

A badly delayed resume does not become one single burst: the server delivers the
backlog in reads of at most 500 events, chained until it catches up with the
present.

---

## 6. Keep-alive

Every **15 seconds with no real byte**, the connection receives a comment:

```
: heartbeat
```

It is what stops a proxy or a load balancer from dropping an idle connection. The
count runs from the last byte written, so a busy stream simply spends no comments
at all.

**Every line starting with `:` is a comment and must be ignored by the client.**
Whoever uses `EventSource` gets that for free; whoever reads the body by hand has
to filter (the example in §8 filters).

---

## 7. Errors

Before any byte of SSE, the filters are validated. If something is wrong, the
answer is an ordinary HTTP response — `400`, `application/json`, and the
connection **never** becomes `text/event-stream` at all:

```json
{"error": "validation_failed",
 "details": ["tipo \"nao_existe\" is not in the taxonomy (see KNOWN_TYPES)"]}
```

`details` carries the whole list of problems, not only the first.

Before the filters comes the credential (§2). Without it, or with one that does
not resolve, the answer is a `401` — also `application/json`, also without
becoming `text/event-stream`:

```json
{"error": "missing_credential", "message": "esta rota exige `Authorization: Bearer <token>` — ..."}
```

`missing_credential` is "no usable header came" and `invalid_credential` is "one
came and it does not hold (unknown or revoked)". Neither of the two improves with
a retry: it is configuration, not unavailability.

Once the stream has opened, there is no possible error body: what there is is the
connection dropping. Treat a drop as a reconnection (§5), not as a failure.

---

## 8. A minimal consumer, zero dependencies

Node ≥ 20, nothing installed. It reconnects on its own by the cursor:

```javascript
// events-stream.mjs — CARTOGRAFO_TOKEN=... node events-stream.mjs [http://127.0.0.1:4317]
const base = process.argv[2] ?? 'http://127.0.0.1:4317';
const token = process.env.CARTOGRAFO_TOKEN;
const query = new URLSearchParams({ tipo: 'job.created,job.transitioned' });

let lastEventId = null;

// Reconnecting is the client's work: the server keeps nothing of the connection,
// and `Last-Event-ID` is what makes the resume have neither a gap nor a
// repetition. The credential goes on every attempt: each reconnection is a new
// request.
for (;;) {
  try {
    const response = await fetch(`${base}/v1/events/stream?${query}`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId === null ? {} : { 'Last-Event-ID': lastEventId }),
      },
    });

    // 400 is a wrong contract (an invalid filter) and 401 is the credential:
    // insisting fixes neither of the two.
    if (!response.ok) {
      console.error(`stream refused (${response.status}):`, await response.text());
      break;
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });

      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);

        // A line starting with ':' is a comment — it is the keep-alive. Ignore it.
        const lines = block.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
        if (lines.length === 0) continue;

        const message = {};
        for (const line of lines) {
          const separator = line.indexOf(':');
          message[line.slice(0, separator)] = line.slice(separator + 1).replace(/^ /, '');
        }

        lastEventId = message.id ?? lastEventId;
        const event = JSON.parse(message.data);
        console.log(`#${event.id} ${event.type} ${JSON.stringify(event.data)}`);
      }
    }
  } catch (failure) {
    // The server is down, the socket was cut mid-way: that is a drop, and a drop
    // is a reconnection. Only the 400 above is a reason to give up.
    console.error(`stream unavailable: ${failure.message}`);
  }

  console.error(`reconnecting from id ${lastEventId}`);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
```

Running against a control plane with a round happening:

```
#1 job.created {"title":"rodada de demonstração","entry_node_id":"entrada","body":null,"acceptance_criteria":null}
#2 job.transitioned {"from_node_id":null,"to_node_id":"refinar"}
#3 job.transitioned {"from_node_id":"refinar","to_node_id":"construir"}
```

In the browser the same consumption fits in five lines, and reconnecting with
`Last-Event-ID` is automatic:

```javascript
const stream = new EventSource('/v1/events/stream?tipo=job.transitioned');
stream.addEventListener('job.transitioned', (message) => {
  const event = JSON.parse(message.data);
  console.log(event.entity.id, event.data.from_node_id, '→', event.data.to_node_id);
});
```

With one caveat since `t124`: `EventSource` does not allow a header to be sent,
and the route demands one. That snippet only works behind an origin that attaches
the credential for the browser — which is exactly the screen's role (D11: it
keeps a service token and passes it along, the browser presents none). The
screen's `/v1/*` forwarding still waits for the body to end before answering, and
an SSE body does not end, so that path is listed in §10.

---

## 9. The guarantees, and what they cost

| Guarantee | How |
|---|---|
| No gap and no repetition on reconnection | `id > cursor`, strictly; the `id` is assigned by the server and is monotonic |
| Order | always ascending by `id`, within and across reconnections |
| Latency | up to ~300ms: the connection *polls* the table at that rhythm, and is not coupled to the write |
| A bounded burst | at most 500 events per read, chained until it catches up with the present |
| A dead consumer affects nobody | the connection dies with the socket; its clocks are disarmed with it |

What does **not** exist in this version: guaranteed delivery (if nobody is
connected, nobody receives — the log is what is the source of truth, and it is
still there), a limit on simultaneous connections, and a read-only credential.

Credential scope came into existence in `t143`, and it is not this one: the
runner credential, issued at pairing, reaches a literal list of five dispatch
routes ([runner-and-controller.md](runner-and-controller.md) §5) — and this route
is not among them. A runner presenting its token here takes a
`403 credencial_fora_de_escopo`. Whoever opens the stream is still the operator
credential, the same one that opens the whole `/v1`; a read credential, telling
"read the log" apart from "write to the control plane", still does not exist.

---

## 10. What does not exist yet

The *push* transport has come into existence: **signed webhooks, with retries**
([`docs/spec/webhooks-events.md`](webhooks-events.md), `t142`), for whoever does
not want to keep a connection open. With it, extension point nº 5 is closed on
both halves — this document is the *pull* one. Its §1 compares the two and says
when each one serves.

**The stream crossing the screen** — `packages/tela`'s `/v1/*` forwarding reads
the whole response before handing it back, which serves for JSON and does not
serve for a body that never ends. Until that changes, §8's `EventSource` has no
way in: consuming the stream is a job for a client outside the browser, with the
header set by hand.
