# Specification: signed event webhooks

**API version:** `v1` · **Migration:**
[`0008_webhook`](../../packages/core/migrations/0008_webhook.sql)
**Origin:** extension point nº 5 —
["events going out"](../../notes/2026-08-14-extension-and-quality.md) · **Ticket:** t142

This document is the contract for whoever consumes, and it is deliberately
self-sufficient: a whole receiver — signature verification included — can be
written without opening a line of the control plane's code. What travels is the
envelope of the [event taxonomy](../../specs/events/taxonomy.md), with
no translation along the way, exactly the same object the
[SSE stream](events-stream.md) delivers in its `data:` field.

---

## 1. What it is, and when to use it instead of the stream

A webhook is telemetry's ***push*** transport: you register a URL, and the
control plane `POST`s to it on every new event, with an HMAC signature that
proves the delivery came from it.

| | Stream ([`events-stream.md`](events-stream.md)) | Webhook (this document) |
|---|---|---|
| Who keeps the connection | you, open all the time | nobody: every delivery is a POST |
| Who retries | you, with `Last-Event-ID` | the server, with backoff (§6) |
| If nobody is listening | the event goes by and does not come back | the delivery stays in the queue and is retried |
| Needs a public address | no | yes |
| Typical latency | ~300ms | ~1s |

Rule of thumb: if your consumer is a process you keep running, the stream is
simpler. If it is an HTTP function, a third-party service or anything that cannot
hold a socket open, it is a webhook.

**What webhooks are not:** they are not history. A subscription is born pointing
at the END of the log and receives only what is written from then on (§4). To
read a whole round after the fact, there is
`GET /v1/executions/:id/events`.

---

## 2. Registering a subscription

```
POST /v1/webhooks
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{"url": "https://my-service.example/cartografo",
 "secret": "a-long-random-string-that-i-chose",
 "filter_types": ["job.created", "job.transitioned"],
 "project_id": 1}
```

| Field | Required | Rule |
|---|---|---|
| `url` | yes | An absolute `http:` or `https:` URL. Anything else is `400`. |
| `segredo` | yes | A non-empty string, **chosen by you**. It is the HMAC's key (§5). |
| `tipos` | no | A list of exact taxonomy types. Absent or empty = every type. An unknown type is `400`. |
| `projeto_id` | no | An integer; without it, the default project (`1`). |

The `201` response:

```json
{"id": 3,
 "project_id": 1,
 "url": "https://my-service.example/cartografo",
 "filter_types": ["job.created", "job.transitioned"],
 "initial_event_id": 128,
 "created_at": "2026-08-15T12:00:00.000Z",
 "deactivated_at": null}
```

**The `segredo` comes back in no response**, neither here nor in the listing. It
is yours: the server does not generate a secret, does not reveal what it stored
and has no route to read it back. If you have lost it, register another
subscription and deactivate this one.

The values accepted in `tipos` are the types the control plane writes today — the
stream's own catalogue:

```
job.created          session.opened       input_request.created
job.transitioned       session.finished   input_request.answered
job.blocked                           input_request.auto_resolved
job.unblocked
job.amended
job.dependency_declared
```

`lease.*` and `graph_version.*` are declared in the taxonomy but are not written
by anybody yet, so asking for them is a `400` — and not a subscription that never
receives anything, which is the worse of the two errors.

---

## 3. Listing and deactivating

```
GET /v1/webhooks               → {"webhooks": [ ...subscriptions... ]}
GET /v1/webhooks?project_id=9  → only that project's
DELETE /v1/webhooks/3          → the subscription, now with deactivated_at
```

`DELETE` **deactivates**, it does not delete: the row goes on existing, with
`desativada_em` filled in, and goes on appearing in the listing. It is the rest
of the repository's discipline — nothing is deleted, and "when did it stop
holding?" is an audit question a boolean would erase.

Deactivating does three things, in the same call:

1. the subscription stops receiving the fan-out of new events;
2. every delivery of it that was still `pendente` becomes `esgotada` — that is,
   the retry in flight is cut, and nothing stays stuck in the queue;
3. calling `DELETE` again returns `200` with the **same** `desativada_em`.
   Deactivating is a state, not an event to be counted. `DELETE` on an unknown id
   is a `404`.

---

## 4. Where the subscription starts

`evento_inicial_id` is the `id` of the log's last event at the moment of
registration. From there on, the subscription receives everything written with a
larger `id` — and **nothing** that was already there.

It is the stream's rule without `Last-Event-ID`, and it exists for the same
reason: registering a webhook against a control plane that has been running for
months cannot mean taking ten thousand POSTs in the face.

Resuming is automatic and there is nothing for you to configure: the server keeps
one delivery row per (subscription, event), and that is what it derives where to
carry on from. A server restarted in the middle of a burst resumes exactly where
it stopped, without repeating what it has already queued.

---

## 5. The delivery, and how to verify the signature

Every event becomes a POST:

```
POST /cartografo HTTP/1.1
Host: my-service.example
Content-Type: application/json
X-Cartografo-Signature: sha256=8f4c...  (64 hex characters)

{"id":129,"type":"job.created","project_id":1,"execution_id":2,"entity":{"type":"job","id":7},"actor":{"type":"system","ref":"control-plane"},"occurred_at":"2026-08-15T12:00:03.114Z","data":{"title":"doc example","entry_node_id":"entry","body":null,"acceptance_criteria":null}}
```

The body is the whole envelope, byte for byte the same object
`GET /v1/executions/:id/events` returns and the stream's `data:` carries.

The signature recipe, in full:

> `X-Cartografo-Signature` = `sha256=` + HMAC-SHA256 of the **raw body**, with
> your `segredo` as the key, in lowercase hex.

Three details that decide whether your verification works:

- **Sign the bytes that arrived, not the reparsed object.** `JSON.parse` followed
  by `JSON.stringify` does not necessarily give back the same bytes, and a
  different byte is a different digest. Read the raw body first, verify, and only
  then parse.
- **Compare in constant time** (`crypto.timingSafeEqual`), never with `===`. A
  comparison that leaves on the first differing byte leaks, through timing, how
  much of the digest the attacker has already got right.
- **With no valid signature, do not trust the body.** Your webhook's URL is
  public; the signature is the only thing separating a delivery from the control
  plane from anybody who found the address.

A closed vector, to check your implementation **before** wiring it to the real
thing — if your arithmetic does not give exactly this, the problem is yours and
not the delivery's:

| | |
|---|---|
| `segredo` | `segredo-de-exemplo` |
| raw body | `{"id":1,"type":"job.created"}` |
| signature | `sha256=4d62c8b3801c05f74e912c122b02b34cf183e64ec81d1bb7dc38bb8f329b1bb2` |

In Node, the whole recipe is one line — the same one the server runs:

```javascript
import { createHmac } from 'node:crypto';
const signature = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
```

**Answer fast.** Any `2xx` closes the delivery; the server does not read your
response's body. If your processing is slow, accept (`200`), queue on your side
and process afterwards — holding the connection only makes you hit the 10-second
timeout and receive the same delivery again.

---

## 6. Retries and terminal states

| Attempt | When |
|---|---|
| 1st | as soon as the event is queued (up to ~1s after the fact) |
| 2nd | 10 seconds after the failure |
| 3rd | 1 minute later |
| 4th | 5 minutes later |
| 5th | 30 minutes later |
| 6th | 2 hours later |

Six attempts in total: the first, plus one step per delay on the scale. What
counts as a failure is the 10-second `timeout`, a network error and **any**
response that is not `2xx` — including a `3xx`, which is not followed.

Every delivery ends in one of two states, and both are final:

| State | Means |
|---|---|
| `entregue` | a `2xx` arrived. `entregue_em` records when. |
| `esgotada` | all six attempts failed, or the subscription was deactivated with this delivery pending. `last_error` keeps the last failure. |

An `esgotada` delivery is **not** retried, however much time passes, and there is
no route to send it again. The row is not deleted, so "I tried six times and gave
up" is an answerable question — and the log is still the source of truth: what
you missed is whole in `GET /v1/executions/:id/events`, and the way to recover
from a window of unavailability is to read the log there.

A broken subscriber is nobody's problem but its own: a batch's deliveries go out
together, each with its own timeout, and no failure delays another subscriber's,
holds up the fan-out or touches the control plane's write path.

---

## 7. Registration errors

Before any write, the body is validated. An error is a `400`,
`application/json`, with the WHOLE list of problems — not only the first:

```json
{"error": "validation_failed",
 "details": ["url has to use http or https (got: ftp:)",
             "secret has to be a non-empty string",
             "tipo \"does_not_exist\" is not in the taxonomy (see KNOWN_TYPES)"]}
```

Before the validation comes the credential: without a valid
`Authorization: Bearer <token>`, `401` with `credencial_ausente` or
`credencial_invalida`. It is the same credential that opens the whole `/v1`
(`t124`) — there is no webhook-only scope.

---

## 8. A minimal receiver, zero dependencies

Node ≥ 20, nothing installed. It reads the raw body, verifies the signature in
constant time and only then trusts the event:

```javascript
// receiver.mjs — CARTOGRAFO_WEBHOOK_SECRET=... node receiver.mjs
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const secret = process.env.CARTOGRAFO_WEBHOOK_SECRET;

/** Compares two hexes of the same algorithm without leaking where they differ. */
function matches(expected, received) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  // timingSafeEqual demands equal lengths; a different length is already a refusal.
  return a.length === b.length && timingSafeEqual(a, b);
}

createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }

  // The RAW body, in chunks, with nothing parsed yet: it is over these bytes
  // that the signature was computed.
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

    // Node normalizes the header's name to lowercase.
    if (!matches(expected, request.headers['x-cartografo-signature'])) {
      console.error('signature does not match — discarding');
      response.writeHead(401).end();
      return;
    }

    // Only after checking does the body become an object.
    const event = JSON.parse(rawBody);
    console.log(`#${event.id} ${event.type} ${JSON.stringify(event.data)}`);

    // Answer before processing: a 2xx closes the delivery, and the server does
    // not read this body. Slow work goes to a queue of yours, not in here.
    response.writeHead(200).end();
  });
}).listen(8099, () => console.error('listening on http://127.0.0.1:8099'));
```

Registering that receiver (with a tunnel, or from inside the same network):

```
curl -sS -X POST http://127.0.0.1:4317/v1/webhooks \
  -H "authorization: Bearer $CARTOGRAFO_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:8099/cartografo","secret":"'"$CARTOGRAFO_WEBHOOK_SECRET"'"}'
```

And a round happening on the other side:

```
#129 job.created {"title":"demo round","entry_node_id":"entry","body":null,"acceptance_criteria":null}
#130 job.transitioned {"from_node_id":null,"to_node_id":"refinar"}
#131 job.transitioned {"from_node_id":"refinar","to_node_id":"construir"}
```

**An unknown type is to be ignored, it is not an error.** An old receiver getting
a new type carries on handling what it understands; it is what makes the taxonomy
extensible additively.

---

## 9. The guarantees, and what they cost

| Guarantee | How |
|---|---|
| No duplicate delivery from reprocessing | one row per (subscription, event), with a `UNIQUE` in the database; redoing the fan-out creates no new row |
| No event skipped while the subscription lives | the cursor is derived from the deliveries already written, not from a counter in memory |
| Authenticity | HMAC-SHA256 of the raw body, with the secret only you and the server know |
| A dead subscriber affects nobody | a batch's deliveries go out together, each with its own timeout; a failure becomes a retry, never an exception that goes up |
| The write path never waits on a webhook | the tick reads the log and writes only into its own tables; `recordEvent` does not know it exists |

What does **not** exist in this version:

- **exactly-once delivery.** If your service answers `2xx` but falls before
  persisting, the control plane has already considered it delivered. Treat the
  event's `id` as an idempotency key on your side — it is unique and monotonic;
- **manually resending** an `esgotada` delivery;
- **SSRF protection** on the signed URL (loopback and private ranges are not
  blocked): it is the same trust boundary as every `/v1` route — a valid token
  already opens the whole API;
- **credential scope**: the token that registers a webhook is the one that opens
  the whole `/v1`;
- **a rate limit per subscription** and a cap on simultaneous outbound requests.

---

## 10. What does not exist yet

**The webhook's lifecycle in the taxonomy** — "subscribed", "delivered",
"exhausted" are not log events yet: they live in the columns of
`entrega_webhook` and nowhere else. While the trail of those columns is enough,
that is how it stays; becoming an event type is a ticket of its own, with a
schema and an entry in the taxonomy.

**A server-generated secret**, revealed once, the way `0007` does with the
credential. Today the secret is yours, which avoids building a second reveal flow
before the first has run in production.
