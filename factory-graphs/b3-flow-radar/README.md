# Factory graph 3 — B3 flow radar (reading one trading day)

> The third runnable map, and the first one outside both software and a
> decision about capital: check intake → triage → contextualize → hypothesize →
> red team → compose brief → scorecard, over three real trading days that ship
> inside the bundle.

**This bundle models a market-data workflow as an example of graph structure —
seven nodes, nine edges, a contract per step — and is not a trading signal, not
investment advice and not a recommendation about any security.**

**State: content, not format.** This ticket (`t406`) designs no new format: it
applies the two already settled — the graph document
([`docs/spec/graph.md`](../../docs/spec/graph.md), `t96`) and the skill manifest
([`specs/formats/skill-manifest.md`](../../specs/formats/skill-manifest.md),
`t97`, including the `command` field `t332` added) — to a third problem class.
It is the direct pair of [factory graph 1](../software-development/README.md)
(`t105`) and [factory graph 2](../asymmetric-bets/README.md) (`t116`), and like
both of them it proves its crossing by contract here and leaves live execution
through the runner to its own follow-up ticket.

| File | What it is |
|---|---|
| [`graph.json`](./graph.json) | The graph document: seven nodes, nine edges, one pinned `skill_ref` per node, the class's one field and its `project` configuration. |
| [`skills/check-flow-intake.json`](./skills/check-flow-intake.json) | `gate` — the deterministic intake, run as a command on the `shell` engine. |
| [`skills/triage-flow-signals.json`](./skills/triage-flow-signals.json) | `gate` — filters the day's computed signals against the class's materiality criteria. |
| [`skills/contextualize-flow-signals.json`](./skills/contextualize-flow-signals.json) | `work` — puts each kept signal beside the ticker's own figures and the day's facts. |
| [`skills/hypothesize-flow-driver.json`](./skills/hypothesize-flow-driver.json) | `work` — one explanation per signal, with a confidence and the context it cites. |
| [`skills/red-team-flow-hypothesis.json`](./skills/red-team-flow-hypothesis.json) | `gate` — red team: kills the explanation with the day's own records. |
| [`skills/compose-flow-brief.json`](./skills/compose-flow-brief.json) | `work` — the day's reading, one section per surviving hypothesis. |
| [`skills/record-flow-scorecard.json`](./skills/record-flow-scorecard.json) | `work` — the crossing's process metrics and what the day left to watch. |
| [`./scripts/check-intake.mjs`](./scripts/check-intake.mjs) | The Node script `check-intake` spawns. Not a script beside the graph: it **is** the first node. |
| [`fixtures/day-1`](./fixtures/day-1), [`day-2`](./fixtures/day-2), [`day-3`](./fixtures/day-3) | Three real consecutive B3 trading days, four JSON files each. |
| [`demo/job.json`](./demo/job.json) | The literal body of a `POST /v1/jobs` that starts a crossing on `day-1`. |

## The topology

```
                       check-intake
                            │
             ┌────pass──────┴──────fail───────┐
             ▼                                │
          triage ────────discard──────────────┤
             │                                │
             │ advance                        │
             ▼                                │
       contextualize                          │
             │ always                         │
             ▼                                │
        hypothesize                           │
             │ always                         │
             ▼                                │
         red-team ────────dead────────────────┤
             │                                │
             │ survives                       │
             ▼                                │
      compose-brief ───────always─────────────┤
                                              ▼
                                          scorecard
```

`initial_node: "check-intake"`, `final_nodes: ["scorecard"]`.

| `id` | `role` | `node_type` | `engine` | pinned skill |
|---|---|---|---|---|
| `check-intake` | `intake-gate` | `gate` | `shell` | `check-flow-intake` |
| `triage` | `triager` | `gate` | *(default)* | `triage-flow-signals` |
| `contextualize` | `researcher` | `work` | *(default)* | `contextualize-flow-signals` |
| `hypothesize` | `analyst` | `work` | *(default)* | `hypothesize-flow-driver` |
| `red-team` | `red-team` | `gate` | *(default)* | `red-team-flow-hypothesis` |
| `compose-brief` | `writer` | `work` | *(default)* | `compose-flow-brief` |
| `scorecard` | `recorder` | `work` | *(default)* | `record-flow-scorecard` |

| `from` | `to` | `condition` | When |
|---|---|---|---|
| `check-intake` | `triage` | `pass` | the day's four files are there and hold their declared row counts |
| `check-intake` | `scorecard` | `fail` | a file is missing, unreadable as an array or out of range |
| `triage` | `contextualize` | `advance` | something clears the materiality criteria |
| `triage` | `scorecard` | `discard` | nothing does — a day with no material signal |
| `contextualize` | `hypothesize` | `always` | a single way out |
| `hypothesize` | `red-team` | `always` | a single way out |
| `red-team` | `compose-brief` | `survives` | a hypothesis answered its serious objections |
| `red-team` | `scorecard` | `dead` | an unanswered high-severity objection |
| `compose-brief` | `scorecard` | `always` | a single way out |

**One final node, four ways of reaching it.** Three end with no brief (a failed
intake, a discarded day, a dead hypothesis) and one ends with a published
reading. There is no separate archive node: it is the same state-collapse
criterion bundle 2 used for `record-monitoring`, generalized here to a graph
with no mandatory human gate — and it is what makes the **process metrics hold
per crossing**, so the day that produced nothing counts as much as the day that
produced a brief.

The mapping between a gate's `resultado` and the edge label is fixed, and each
gate's `instructions` says it:

| Gate | `pass` | `fail` |
|---|---|---|
| `check-intake` | `pass` | `fail` |
| `triage` | `advance` | `discard` |
| `red-team` | `survives` | `dead` |

## The three nodes that define this class

**`check-intake` runs a command, not a session.** The node declares
`"engine": "shell"` and its pinned skill carries a `command` block instead of
instructions a model reads — the pair
[`schema/examples/graph-valid-shell-engine.json`](../../schema/examples/graph-valid-shell-engine.json)
and
[`specs/formats/examples/skill-manifest.shell-echo.json`](../../specs/formats/examples/skill-manifest.shell-echo.json)
is the reference, and
[`packages/runner/src/engine/shell-adapter.ts`](../../packages/runner/src/engine/shell-adapter.ts)
is what spawns it. Its argv is:

```
node factory-graphs/b3-flow-radar/scripts/check-intake.mjs {{input.trading_day}} {{input.project.expected_row_counts}}
```

— with `env_allowlist: ["PATH"]`, which is the whole reason `argv[0]` may be the
name `node` rather than an absolute path. Counting rows in four JSON files is
not a judgement, and paying a model to do it is exactly what `t332` exists to
stop: the engine was added *because* of b3-radar's own D15
([`docs/formats/engine-adapter.md:87`](../../docs/formats/engine-adapter.md)),
and this node is its first real consumer.

The ranges the script checks against are **graph data**, not a constant inside
it: `project.expected_row_counts` in [`graph.json`](./graph.json) declares a
`[min, max]` per file, the argv passes it in, and the bundle's own acceptance
tests hold the shipped fixtures against that same declaration. The check at
rest and the check at runtime cannot drift apart.

**`red-team` attacks with the day's own records, and researches nothing.**
Bundle 2's red team demands counter-evidence *external* to the material it
received. This one cannot have any: every skill here declares
`network.allowed: false`, so a researched field would name a capability the
manifest forbids itself. What replaces research is the rest of the day — the
figures and the facts the hypothesis did not look at — and every entry of
`counter_evidence` cites a `file` and a `record` a reader can open. The
`instructions` forbid, in so many words, concluding `pass` while a
high-severity objection carries a `null` `hypothesis_answer`, and an empty
objection list is refused by the contract: a red team that found nothing did
not run.

**`scorecard` records process, and no instruction.** Its `output.process_metrics`
requires `intake_passed`, `signals_triaged_count`, `red_team_ran` and a
`final_outcome` of `published` / `no_signal` / `dead_hypothesis` /
`intake_failed` — one per path into the node. No key of its output may name a
direction, a target or an expected return. This is signal *detection*: a reading
that turned out to be right does not validate a crossing that skipped the red
team, which is the same principle D14 states for bets, stated here for a radar.

**There is no human-decision node**, and that is deliberate. Bundle 2 makes
escalation mandatory at `decide` because allocating capital without a person is
the one thing its contracts must make impossible. Publishing a reading of the
flow is not that act, so escalation here is available at every node and required
at none — the `input-request` block is in all seven `instructions`, and
`escalate_human` sits in the gate enum because the format demands the three
values.

## How to enter a crossing

A crossing comes in as **a job on the board**, one per trading day:

- **`title`** and **`body`** say which day is being read and what for.
- **`fields`** carries the one field this class declares in `custom_fields`:
  **`trading_day`**, demanded at `check-intake`. Its value is `day-1`, `day-2`
  or `day-3` — the three directories under [`fixtures`](./fixtures). The days
  are *named*, not dated, so that no document in this repository encodes a date
  that reads as "current" long after it stops being one; the data inside each
  file is real and dated.
- **`entry_node_id: "check-intake"`**, plus this class's graph version.

[`demo/job.json`](./demo/job.json) is that body, ready to post — the shape
[`docs/getting-started.md`](../../docs/getting-started.md) walks through in
step 4:

```json
{"title": "…", "body": "…", "entry_node_id": "check-intake",
 "fields": {"trading_day": "day-1"}}
```

The materiality criteria and the row-count ranges do **not** come from the job:
they live in the top-level `project` object of [`graph.json`](./graph.json),
which the input projection publishes at `input.project` (`t253`,
[`packages/core/src/domain/context.ts`](../../packages/core/src/domain/context.ts)).
`project.repo` is `.` — this repository itself — because the fixtures the graph
reads live inside it, the same dogfood posture
[factory graph 1](../software-development/graph.json) takes.

### What is in a day

Each of [`fixtures/day-1`](./fixtures/day-1), [`day-2`](./fixtures/day-2) and
[`day-3`](./fixtures/day-3) holds four JSON arrays, from three real consecutive
B3 sessions:

| File | Rows | What it holds |
|---|---|---|
| [`daily-figures.json`](./fixtures/day-1/daily-figures.json) | 40–60 | Per-ticker daily figures for a curated liquid subset: open, high, low, close, vwap, turnover, trades, brokers. |
| [`broker-flow.json`](./fixtures/day-1/broker-flow.json) | 80–200 | Per-ticker, per-broker net flow — the three largest net positions in each ticker. |
| [`signals.json`](./fixtures/day-1/signals.json) | 5–25 | The day's computed signals, each carrying the query that produced it. |
| [`facts.json`](./fixtures/day-1/facts.json) | 1–10 | News and material-fact items standing in for context. |

The whole tree is a couple of hundred kilobytes. It was exported once from
`~/b3-radar`'s already-consolidated tables and trimmed to the ranges above;
the capture and consolidation that produced those tables stay in that
repository and never enter this one. Nothing here is refreshed, by this bundle
or by anything else: the three days are frozen.

## How to validate

```bash
# graph + manifests + hash pins, all at once
node ../../scripts/validate-factory-bundle.mjs .

# cross-check of the manifest format, with a third-party validator
npx --yes ajv-cli@5 validate \
  -s ../../specs/formats/skill-manifest.schema.json \
  -d './skills/*.json' --spec=draft2020
```

The first command checks the three things that make this a bundle rather than a
handful of JSON files in the same directory: the graph is sound by `t96`'s four
rules, every manifest holds against `t97`'s schema, and **every pin closes** —
the recomputed hash of each manifest's content matches what the corresponding
node's `skill_ref` pins (D4).

This bundle's acceptance tests are in
[`tests/factory-graph-3.test.mjs`](../../tests/factory-graph-3.test.mjs)
(`node --test`), with the crossing fixture in
[`tests/fixtures/b3-flow-radar-crossing.fixture.json`](../../tests/fixtures/b3-flow-radar-crossing.fixture.json).
Two of them are worth knowing about: one runs
[`./scripts/check-intake.mjs`](./scripts/check-intake.mjs) against a temporary
fixture tree for its four verdicts and its one crash, and one runs static
contract matching
([`packages/core/src/domain/graph.ts`](../../packages/core/src/domain/graph.ts),
`validateContracts`) over the bundle's real manifests, so the bundle classifies
as `checked` the moment it is imported.

## Directory convention

`factory-graphs/<class>/` is the shape of the bundle, named from the document's
`problem_class` string (D8) — the same note as bundles 1 and 2. It is also the
shape of the atlas, one subdirectory per class, specified in
[`docs/formats/atlas-bundle.md`](../../docs/formats/atlas-bundle.md) (v0, not
frozen). Publishing this map into an atlas is copying it there once validated:

```sh
node scripts/publish-atlas-bundle.mjs factory-graphs/b3-flow-radar ../atlas
```

What is new in this bundle's shape, and what the atlas format does not know
about yet, are the two directories the earlier two did not have: `fixtures/`
and `demo/`.

## Recorded divergences

Six places where this bundle departs from bundles 1 and 2, or from what the
format would suggest. They are written down because an unrecorded divergence
becomes a trap for whoever comes next.

1. **The bundle ships its own data.** No factory graph before this one carried
   a byte of anything but JSON contracts. This class has no meaning without a
   trading day, and RF-28 forbids fetching one, so three real days ride inside
   the bundle as fixtures. The consequence to notice is that `project.repo` is
   this repository: a job of this class has the cartografo checkout as its
   working directory, because that is where the data is.
2. **`demo/job.json` is a precedent, not a convention yet.** It is the first
   demo job any bundle has shipped, and nothing consumes it: the "run an
   example" command that would post it end-to-end is a ticket that has not been
   written. What it does today is answer, in one file, the question a reader of
   a map always asks second — what do I actually send to start one.
3. **The network is closed on all seven nodes.** Bundle 1 opens it at one node
   (loopback, for the test gate) and bundle 2 at one node (unrestricted, for
   fundamentals research). Here nobody does. It is a direct consequence of
   RF-28 applying to the WHOLE bundle rather than to one exception, and it is
   what forced this class's red team to be built differently: it attacks with
   the day's own records instead of with counter-evidence it went and found.
4. **The intake script resolves its fixtures in two places.** It looks for
   `fixtures/<trading_day>/` under the working directory first, and under the
   bundle's own directory failing that. One rule would have been cleaner; two
   is what makes the same argv work both from the bundle directory (where the
   validation commands above run, and where a test can stand a temporary tree
   in for the shipped one) and from the repository root (which is where a live
   crossing's working directory is). The second is only ever reached when the
   first is not there at all.
5. **The two defect classes bundle 2 found the hard way are closed from the
   first version.** Every gate declares `resultado` — an optional string with
   no enum — beside an `output` that closes on `additionalProperties: false`,
   so a routing report is never refused whole
   ([`packages/runner/src/dispatch/parse-node-result.ts`](../../packages/runner/src/dispatch/parse-node-result.ts);
   bundle 2 learned this across `t260` and `t276`, one gate at a time). And no
   manifest names an input path nobody produces: static contract matching runs
   over the bundle's own manifests in its acceptance tests, which is also what
   proves the three short paths into `scorecard` are legal rather than merely
   untested (`t278`).
6. **The crossing is proven by contract, not by live execution.** The fixture
   in
   [`tests/fixtures/b3-flow-radar-crossing.fixture.json`](../../tests/fixtures/b3-flow-radar-crossing.fixture.json)
   carries one crossing from `check-intake` to `compose-brief` in which each
   node's conforming output feeds the next node's input, and each gate routes
   down an edge the graph declares. Its payloads quote the bundle's own `day-1`
   rows, because a crossing built on invented data would prove the contracts
   fit and hide whether the fixtures do — but they are the smallest payloads
   that still validate, and nothing in them is a claim about any ticker.
   Running this graph live through the runner is the explicit subject of the
   follow-up ticket this one was split from, exactly as `t259`/`t260`/`t270`/
   `t273` were for the first two bundles.

## The edge format did not grow

[`docs/spec/graph.md:172`](../../docs/spec/graph.md) records the rule of two
consumers for the `condition` grammar. This graph is a third consumer and it
does not press either: its nine labels fit whole inside the current vocabulary —
the outcome label of the source node, or `"always"`. No transition here needed
an "and", an "or" or a comparison. With no evidence, the format stays as it is.
