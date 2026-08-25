# Specification: the cost surveyor (the token and time lens)

**Package:** [`packages/cost-surveyor`](../../packages/cost-surveyor) · **Version of the API consumed:** `v1`
**Founding rule:** ["two topografos (flow and cost) before the proposal format is frozen"](../../notes/2026-08-14-extension-and-quality.md)

A topografo reads telemetry and writes a hypothesis. This one reads **cost**: how
many tokens and how much session time each node consumed, in each graph version,
in one execution — and proposes where to act when a node falls off the curve.

What this document specifies is not primarily the heuristic; it is the
**boundary**. The cost lens exists to answer, with running code, a question the
architecture had been asserting without proof: *is a topografo a real extension
point, or only a name for the first analyser we wrote?* This ticket's answer is
mechanical — the whole package is an ordinary client of the public API, declares
no SQLite driver, imports nothing from `packages/core` and opens no shared
schema. If it needed any one of those things, "extension point" would be an
assertion with nothing behind it.

---

## 1. The unit of observation: `(graph version, node)`

`GET /v1/executions/:id/metrics-by-version` already crosses version × telemetry
([`job.ts`](../../packages/core/src/repositories/job.ts)), but it counts jobs and
events per `grafo_versao_id` and stops there. That answers "v2 moved more than
v1"; it does not answer "**which node** got expensive in v2" — and a cost policy
with no target has no operation to propose.

The lens goes one level down and aggregates per pair:

| Field | What it is |
|---|---|
| `grafo_versao_id`, `no_id` | the observed pair |
| `tokens_total` | the sum of the four subkeys of `session.usage` |
| `sessoes_com_uso` / `sessoes_sem_uso` | how many sessions reported usage, and how many did not |
| `tempo_total_segundos` | the sum of `finalizada_em - aberta_em` |
| `sessoes_com_tempo` / `sessoes_sem_tempo` | the same, for the time stamps |

**No new column was needed.** `session.usage` and both stamps already exist and
already come out of `GET /v1/sessions` alongside `no_id` and `trabalho_id`; each
session's `grafo_versao_id` resolves through `job.graph_version_id`, which
already comes in `GET /v1/jobs`. The join is done on the client, with two GETs.

### Absence is never zero

The rule runs through the whole aggregation, and it is inherited from the core
([`session.ts`](../../packages/core/src/repositories/session.ts)): a session with
`uso: null` does **not** enter as zero tokens, and a session still open does
**not** enter as zero duration. Zero is a measurement; `null` is the engine
having reported nothing, and collapsing the two destroys precisely the metric
this lens exists to read.

The `sessoes_sem_uso` and `sessoes_sem_tempo` counters are the honest price of
that: they say how much of the total can be believed, and they travel in the
evidence of every proposal.

### Nothing disappears

A session with no job (discovery, a conversation turn) or a job with no declared
version produces a pair with `null` at one end. Those rows are not discarded:
they sit in a group of their own, ordered last — the same choice as
`metricasPorVersao`. A report that hides what it cannot classify lies about the
total.

Only the **identified** rows (version and node filled in) reach the policies:
without both fields there is no node to point at and no snapshot to read the
description from.

---

## 2. The two policies

| Policy | Question | Needs |
|---|---|---|
| `ceiling` | did this node go past N tokens (or N seconds)? | a declared ceiling |
| `tier` | does this node cost far more than its neighbours in the same version? | a sample base |

**`ceiling` is absolute and stays quiet when it does not know.** Without
`--token-cap` or `--second-cap` the policy does not run: there is nothing to
exceed, and inventing a default number would be the lens deciding on its own
account what is expensive. "Exceeds" is strictly greater. A row that blows
through both ceilings is still **one** candidate — the target is the node, not
the limit; `tokens` takes the label because it is the primary metric, and the
time number travels in the evidence either way.

**`tier` is relative and demands a base.** A node is a candidate when its
`tokens_total` is ≥ `tierFactor` times the **median** of its own version, and
only when that version has at least `tierMinNodes` nodes with usage data. Three
choices, each with a reason:

- **the median, not the mean** — the metric serves to find an outlier, and the
  mean is pulled by exactly the outlier being looked for;
- **within the version** — comparing nodes across versions would mix a topology
  change with a cost change, and the lens would have no way of saying which of
  the two explained the number;
- **a minimum of measured nodes** — with two nodes, calling one of them an
  outlier is noise. A node with no session carrying `uso` counts neither toward
  the minimum nor into the median: it is not a cheap node, it is an unmeasured
  one.

A median of zero switches the policy off: with half the measured nodes at zero
tokens, any positive value would pass any factor, and every node would become an
outlier.

The defaults (`tierFactor = 3`, `tierMinNodes = 3`) are calibration, not
architecture, and they are exposed as command-line options so they can be
recalibrated without touching the design.

---

## 3. Why every proposal from this lens is advisory

This is the lens's hard point, and it is a consequence, not a preference.

Neither the graph document
([`grafo.schema.json`](../../schema/grafo.schema.json), whose node is
`additionalProperties: false`) nor the
[skill manifest](../../specs/formats/skill-manifest.schema.json) has a
cost, budget or model-tier field today. A cost policy **has nowhere to land** in
those formats. And opening either of them is outside this ticket by acceptance
criterion: what is being proved is that a second topografo fits inside the
existing API without altering a shared format — altering a schema to make it fit
would refute the very thesis.

What is left is the only mutation the current operation vocabulary allows on a
node without inventing a field: `change_node_field` over `description`. So every
candidate carries exactly one operation, which **appends** a readable
recommendation to the node's current description:

```json
{
  "type": "change_node_field",
  "node_id": "implementar",
  "field": "description",
  "from": "<current description>",
  "to": "<current description>\n\n[cost-surveyor] token ceiling exceeded: …",
  "inverse": {
    "type": "change_node_field",
    "node_id": "implementar",
    "field": "description",
    "from": "<to>",
    "to": "<from>"
  }
}
```

The real numbers travel in `evidence` and `expected_metric`, which are free JSON
by design (D15):

```json
{
  "evidence": {
    "lens": "cost",
    "node_id": "implementar",
    "graph_version_id": "sha256:…",
    "tokens_total": 412000,
    "total_seconds": 5400,
    "sessions_with_usage": 9,
    "sessions_without_usage": 1,
    "ceiling_exceeded": "tokens",
    "type": "ceiling"
  },
  "expected_metric": {
    "nome": "tokens_total of node \"implementar\" goes back under the declared ceiling",
    "direcao": "cai",
    "de": 412000,
    "para": 200000
  }
}
```

The candidate's keys have spoken English since t255
([the glossary](glossario-wire.md) §5.5); the CONTENT of `expected_metric` is
still `{nome, direcao, de, para}` because that is the frozen hypothesis format of
[`domain/hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts) — and that
is exactly why it is here. Until t255 this lens invented a metric of its own — a
sentence, a target and the knob that produced the target —, which looked like a
hypothesis and was not: `POST /v1/proposals/:id/outcome` refused it with
`422 invalid_expected_metric`, and no proposal from this lens could close its own
experiment.

`de` is the measured number; `para` is where it ought to land (the ceiling, or
the `factor × median` threshold). `direcao` is always `cai`: every candidate from
this lens is a cost cut.

The `"lens": "cost"` of the example above stopped being just a label with `t246`:
it is the control plane's deduplication discriminator (D21). `POST /v1/proposals`
keys every proposal by `(lens, target_version, operations)` — a key computed by
the server, never accepted in the body and never returned in the response — and a
repeated signal that matches a proposal still `pending` answers `200` with that
same proposal, adding the new evidence to its list, instead of `201` with a
clone. Running `evaluate` twice over the same telemetry therefore no longer piles
up repeated candidates. Two lenses proposing the same diff are still two
proposals, on purpose: the reasoning behind each one is different evidence even
when the diff coincides. And the uniqueness holds only within `pending` —
replaying the signal after a rejection opens a new proposal, because the earlier
decision is the past.

**The honest consequence:** applying a proposal from this lens reduces no cost by
itself — it informs whoever reads the node. Mechanical enforcement of a ceiling
or a tier waits for a real policy surface, which the
[learning note](../../notes/2026-08-14-learning.md) already names as a surface
of its own. This is not an irreversible regression: when the field exists, the
same aggregation and the same policies start emitting the structural operation,
and only the operation changes.

---

## 4. The command

```
cost-surveyor evaluate --url <url> --execution <id>
                         [--token-cap N] [--second-cap N]
                         [--tier-factor N] [--tier-min-nodes N]
```

The whole path, in order:

1. `GET /v1/sessions?execution_id=` and `GET /v1/jobs?execution_id=` (in
   parallel);
2. builds the `trabalho_id -> grafo_versao_id` map;
3. aggregates per `(version, node)` and drops the unidentified rows;
4. `GET /v1/graph-versions/:id` **once per distinct version** — it is where the
   current `description` comes from, which becomes the operation's `from` and the
   inverse's `to`;
5. evaluates both policies;
6. `POST /v1/proposals` per candidate, and prints one line per created proposal.

The exit codes follow the convention of the `cartografo` CLI
([`cli/index.ts`](../../packages/core/src/cli/index.ts)): `0` it did what it
promised (including when there was no candidate), `1` a negative result (the
server is down, the API refused), `2` the command line is wrong.

---

## 5. The boundary: four routes, and not one more

| Route | Verb | What for |
|---|---|---|
| `/v1/sessions` | GET | tokens and time per `no_id` |
| `/v1/jobs` | GET | the `trabalho_id -> grafo_versao_id` map |
| `/v1/graph-versions/:id` | GET | the node's current `description` |
| `/v1/proposals` | POST | the candidate, as a pending proposal |

The paths are English (D18); the **keys** of the body (`sessoes`, `trabalhos`,
`grafo_versao`, `proposta`) are still Portuguese, because they are format and
D18 explicitly takes them out of English's scope.

The table's most important absence is `POST /v1/proposals/:id/apply`. The
topografo **creates** and stops: applying, approving or reverting is a human
decision at the gate (README, principle 5), and the inbox is a ticket of its own
(`t111`). That is locked down by a test — the list of routes a real run of the
command touches is an acceptance assertion, not a review convention.

The other half of the boundary comes out of the same test, checked by the generic
gate [`check-single-writer.mjs`](../../scripts/check-single-writer.mjs) that
already runs in the lint: the package declares no SQLite driver, does not reach
`packages/core/src/db` and depends on neither the core package nor the runner.
The same boundary as the screen's (D11) and the runner's (D1) — a topografo is
not privileged for being "one of ours".

The types the package consumes from the API are **redeclared locally**, in the
subset it uses, rather than imported from the core — the same choice as
[`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts).
It is what lets the lens survive a new field in the core without changing a line,
and what keeps the dependency from coming back through the types' door.

---

## 6. What this lens does not do yet

Every item here is declared scope, not an oversight:

- **Deduplicating proposals across repeated runs of the command.** Running twice
  over the same telemetry creates repeated proposals. When this ticket was
  written, checking for duplicates would have demanded a listing route that did
  not exist, and creating it would have been a change in the core — exactly what
  the ticket exists in order not to need. `GET /v1/proposals` exists today
  ([`proposals.ts`](../../packages/core/src/routes/proposals.ts)), so the blocker
  is gone; the check is still not implemented, and it is still outside **this**
  ticket's scope, which is about fitting inside the API and not about
  idempotency. It is a ticket for whoever wants it, and the route is already
  there.
- **A real cost/tier field** in the graph document or in the skill manifest (§3).
- **A formal policy surface** — a versioned `politica` table, a budget per
  execution, timeouts. The ceilings are command-line arguments today, and the
  learning note already names "Policies" as a surface of its own.
- **Cost in money.** The lens counts tokens and seconds; price per token is
  engine vocabulary, and the `session.finished` schema refuses a cost field on
  purpose. Converting is for whoever has the price table.
- **Crossing with the outcome.** "This node is expensive" and "this node is
  expensive **and** fails a lot" are different sentences; the second is the flow
  lens, and crossing the two is a ticket for whoever has both running side by
  side.
