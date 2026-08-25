# The first real execution of the asymmetric-bets graph (t198)

Date: 2026-08-17, 20:15–21:05 UTC. Operator: the on-duty agent (Claude), with
Rafael's authorization. The second instance of D14: the `bets-assimetricas` graph
crossed by a real thesis, with a real agent session — the first time this graph
has run outside the fake engine.

## Provenance

- Commit on `main`: `80142cf` (t261 included). The control plane and the runner
  came up from the `~/cartografo` checkout; the database recreated
  (`rm -rf .cartografo/`).
- Graph imported: `bets-assimetricas`, version
  `sha256:7e95e0015c19ed9bd41ddbbca5fcf278174aae21dee9e9cbaffcc3594f438584`
  (7 skills registered). The investor configuration = the example `project` of
  `grafo.json` itself (t260).
- Job: job **2**, execution **1**, entry node `triagem`. (Job 1 was created with
  no `execution_id` and blocked by hand to keep it out of the round.)
- Thesis: **a listed gold miner** — "miners price gold far below the cash flow at
  US$ 4,400"; the hypothesis and its origin in the `body` (a third-party weekly
  newsletter of 2026-08-17, read by Rafael); `fields.asset` = the miner's ticker,
  `fields.premise_source` = a pair of forward earnings multiples, the gold-mining
  index against the broad market, the silver premium in China. The full input in a
  scratch clone outside this repository; alternative candidates (a uranium
  producer, a copper miner, a silver fund) in the session's
  `scratchpad/teses-metais.json`.
- Engine: `claude-code` (`claude 2.1.233/2.1.234`, model `claude-fable-5`), the
  runner with `--working-dir` and `--worktrees-root` pointing into a scratch
  clone outside this repository.

## What happened, node by node

| # | Session | Node | Result | Output (tokens) | Cache created |
|---|---|---|---|---|---|
| 1–4 | 1, 2, 3, 4 | `triagem` | **refused by the model** before answering (`stop_reason: refusal`, category `reasoning_extraction`), exit 1 | 0 | 23,067 each |
| 5 | 5 | `triagem` | `completed` (exit 0) in ~72 s of session (84.5 s of agent time as the topografo measured it) | 5,369 | 23,133 |
| — | — | `registro-monitoramento` | a final node: the job was taken as finished on arriving at it; **the `registrar-travessia` skill did not run** | — | — |

The path: `triagem —descartar→ registro-monitoramento` (the discard edge). The
human gate (`decisao`) sits on the branch where the thesis survives; on this
traversal it was not reached. No `input-request` was opened.

### What the triage decided

`resultado: descartar`, `outcome: fail`. Criterion by criterion, over the text of
the input:

1. "downside limited by net cash or a real asset, not by a narrative" → **does
   not meet it**: the input offers only a multiple re-rating and a return from
   the sector index; no data on cash, debt, NAV, reserves or cost of production.
   (A mine is a real asset; the thesis can be reformulated with a balance-sheet
   floor, but the input does not bring one.)
2. "a dated event that forces the re-rating within 12 months" → **does not meet
   it**: "silver breaking US$ 71" is a price level in another metal, with no
   date; "gold at US$ 8,000 in two years" is outside the 12-month window.
3. "fits within the declared circle of competence" → **indeterminate** (not
   received).
4. "fits within the portfolio's risk ceiling" → **indeterminate**:
   `project.carteira` exists in the graph, but the triage skill has no
   placeholder for it — it never reached the node.

The session returned four reformulations that would reopen the thesis (a floor
from the miner's balance sheet; a corporate event with a date; the intended size
and the portfolio; the circle of competence) — exactly the kind of output the node
exists to produce.

## Topographers over execution 1

- **Flow** (`npm run surveyor -- 1`): a real analysis session; the bottleneck at
  `triagem` (84,554 ms of agent time, 0 questions); **proposal 1** pending:
  rewrite the `triagem` node's `description` to "a fast gate: it confronts the
  input against the fixed list of criteria and answers only deepen/discard with
  one sentence of reason per criterion; it does not research, it does not define
  scope" — the expected metric `tempo_agente_ms:triagem` falls from 84,554 to
  67,643. Applying is a human decision.
- **Cost** (`topografo-custo evaluate --execution 1 --token-cap 20000`):
  **proposal 2** pending: the `triagem` node's token ceiling blown (120,928
  observed across 5 sessions against 20,000 declared) — inflated by the 4
  refusals.

## The round's cost

Node sessions: 5 (4 refused + 1 good) ≈ 115 k tokens of cache created + 5.4 k of
output ≈ US$ 2.3. The flow topografo's session ≈ US$ 1. Diagnosing the refusal
(a bisection with `claude -p`, 8 calls) ≈ US$ 4. Total ≈ **US$ 7–8** for a thesis
rejected at the first stage — the graph's cheap path, and the right one for this
thesis.

## Holes found (each one became a ticket, in the backlog — releasing them is Rafael's decision)

1. **The generic escalation preamble at the top of the system prompt made the
   model refuse the session** (5/5 deterministic; moved to the end, it passes) —
   t261, already fixed in the middle of the round (`80142cf`).
2. **A final node with a work skill never runs**: `registro-monitoramento` has
   `registrar-travessia`, but the job is taken as finished on arriving at the
   final node. Either the record is a node that runs and only then finishes, or
   the skill is decorative — today it is the second, silently. → **t262**
3. **`execution.finished` did not fire** (t245): execution 1 has its only job
   finished and `finished_at` is still `null` in `GET /executions`. → **t264**
4. **A `job.transitioned` event with `from_node_id: null`** on the
   `triagem → registro-monitoramento` transition. → **t264**
5. **An engine refusal treated as a generic failure and retried 4×** (~US$ 1.9 on
   the same deterministic error) — it did not go into t261: the adapter does not
   tell `stop_reason: refusal` from any other failure, and the core has no
   ceiling of consecutive failed sessions per job — the executor would re-lease
   the work forever. → **t265**
6. **`carteira` does not reach the triage**: t260 put `carteira` in `project`,
   but the `triar-tese` skill only reads
   `input.project.criterios_de_triagem` — two criteria come out
   "indeterminate" for want of data the graph has. → **t263**
7. **The flow topografo's evidence still has Portuguese keys** (`fonte`,
   `execucao_id`, `no_id`, `tempo_agente_ms`…) — the rest of the thread (D20). →
   **t264**
8. `metrics-by-version` shows only `jobs`/`events` per version — no tokens/time
   per node (the cost lens has to recompute them from the sessions). → **t264**

### What t264 found about the four that fell to it (2026-08-18)

Holes 3, 7 and 8 were the three defects the list said they were, and they were
closed: a round is now also declared finished when the fact that closes the
condition is the return of the lease (and not a transition), the flow lens's
evidence moved to the English of §5.6 of the glossary, and every row of
`metrics-by-version` gained a `nodes` field with sessions, tokens and agent time
per node.

**Hole 4 was not a defect**, and it is the only item on this list that closes
without a line of code. `from_node_id: null` is the documented contract of a
job's FIRST transition — `job.transitioned.schema.json` and
[`taxonomy.md`](../specs/events/taxonomy.md) say so, and `jobs.test.ts`
already pinned the shape. `null` means "it left the entry node", and job 2's
entry node was `triagem`: whoever wrote the note read "the job was in triagem" as
contradicting the `null`, and the two are the same thing. t264 investigated and
changed nothing because of it.

## What the round proves and what it does not

It proves: the map receives a thesis through the job, projects the first node's
input out of job + project + fields (t253/t259/t260), opens a real session, the
node judges against the investor's criteria with structured evidence, returns the
output in the contract, the executor follows the correct edge and both
topographers produce proposals out of the telemetry — the "run → measure →
propose" cycle, whole, on a real thesis. And the triage rejected for the right
reasons: it was a good trade and not an asymmetric bet by the map's criteria.

It does not prove: the six nodes after the triage (collection with an open
network, asymmetry analysis, red team, sizing, the human gate, the record) — the
thesis never got there. A thesis that passes the triage (the uranium one, or
this one reformulated with a balance-sheet floor and a dated event, as the triage
itself suggested) is the next test; and the round with n>1 is still t239.
