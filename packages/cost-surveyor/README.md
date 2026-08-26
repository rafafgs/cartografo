# @cartografo/cost-surveyor — the second telemetry lens

Reads an execution's telemetry through the public API, aggregates what it cost by
`(graph version, node)`, applies two policies, and files one **pending** proposal
per candidate. Tokens and time, nothing else.

It exists as much to prove a claim as to measure cost: a second surveyor had to
fit the API that already existed without altering a shared format. It does — this
package opens no schema, adds no field, and holds no privilege.

**Workspace-internal** (`"private": true`).

## The command

```
cost-surveyor evaluate --url http://127.0.0.1:4317 --execution 7 --token-cap 200000
```

One subcommand, `evaluate`. Exit codes are the `cartografo` CLI's: `0` did what
it promised (**including when there was no candidate**), `1` ran and the result
was negative, `2` the command line is wrong.

## What it exposes

`./cli` — `evaluateExecution` and `withCredential`, which is how
`@cartografo/surveyor` runs this lens without spawning a process.

## The four routes it speaks, and not one more

| Route | What for |
|---|---|
| `GET /v1/sessions?execution_id=` | tokens and time per node |
| `GET /v1/jobs?execution_id=` | the job-to-graph-version map |
| `GET /v1/graph-versions/:id` | the node's current description, which becomes the operation's "before" |
| `POST /v1/proposals` | the candidate, as a pending proposal |

## Two policies, saying different things

- **`ceiling`** is absolute — this node went past N tokens or N seconds. It only
  exists when somebody declares the ceiling; with none declared there is nothing
  to exceed, and the lens stays quiet rather than inventing a number.
- **`tier`** is relative — this node costs far more than its neighbours in the
  same version. It demands a sample base, because with two measured nodes calling
  one an outlier is noise.

Two conventions inherited from the core shape the arithmetic in `cost.ts`, and
neither is a detail. **An absent usage figure is never worth zero**: zero tokens
is a measurement, absence is the engine not having reported, and the two become
separate counters so the report can say how much of its own total is believable.
**Nothing disappears**: a session with no job, or a job with no declared version,
falls into a group of its own ordered last, because a report that hides what it
cannot classify lies about the total.

## What it deliberately does not do

- **It applies nothing.** `POST /v1/proposals/:id/apply` is called nowhere in
  this package. Applying is a human decision at the gate (principle 5).
- **It does not deduplicate, and no longer has to.** The control plane does it
  for every caller at once: a repeat that matches a still-pending proposal comes
  back as that same proposal with its evidence strengthened, instead of a clone.
  What still creates a new proposal is a repeat whose match has already left
  `pending` — so a rejection is not a permanent, silent ban on the same signal
  ever being raised again.

## How it relates to the others

HTTP to `packages/core`, like everybody else — three reads and one write, above.
`@cartografo/surveyor` is what calls it unattended; the flow lens it runs
alongside lives in `@cartografo/runner` under `./surveyor/proposal`. The two
lenses share the proposal format and nothing else.
