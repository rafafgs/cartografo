# Factory graph 2 — asymmetric bets (investment thesis)

> The second validation instance of **D14**, written as a graph ready to use:
> triage → collect fundamentals → analyze asymmetry → red team → size risk →
> decide (mandatory human gate, always) → record and monitoring.

**This bundle models an investment-analysis workflow as an example of graph
structure — seven nodes, nine edges, a contract per step — and is not investment
advice.**

**State: content, not format.** This ticket (`t116`) designs no new format: it
applies the two already settled — the graph document
([`docs/spec/graph.md`](../../docs/spec/graph.md), `t96`) and the skill manifest
([`specs/formats/skill-manifest.md`](../../specs/formats/skill-manifest.md),
`t97`) — to a problem class that is not software. It is the direct pair of
[factory graph 1](../software-development/README.md) (`t105`), and the
second consumer the rule of two consumers asked for
(`docs/spec/graph.md:172`) before the edge format could grow.

| File | What it is |
|---|---|
| [`graph.json`](./graph.json) | The graph document: seven nodes, nine edges, one pinned `skill_ref` per node. |
| [`skills/triage-thesis.json`](./skills/triage-thesis.json) | `gate` — filters the idea before spending research on it. |
| [`skills/collect-fundamentals.json`](./skills/collect-fundamentals.json) | `work` — gathers fundamentals from primary documents and separates fact, assumption and gap. |
| [`skills/analyze-asymmetry.json`](./skills/analyze-asymmetry.json) | `work` — the downside floor, the upside target, scenarios fastened to assumptions. |
| [`skills/red-team-thesis.json`](./skills/red-team-thesis.json) | `gate` — red team: a role dedicated to killing the thesis, with counter-evidence of its own. |
| [`skills/size-risk.json`](./skills/size-risk.json) | `work` — position size, accepted maximum loss and exit trigger. |
| [`skills/escalate-decision.json`](./skills/escalate-decision.json) | `gate` — assembles the dossier and escalates; never decides a capital allocation. |
| [`skills/record-crossing.json`](./skills/record-crossing.json) | `work` — the crossing's process metrics and the monitoring plan. |

## The topology

```
                         triage
                           │
              ┌──advance───┴───discard───┐
              ▼                          │
      collect-fundamentals               │
              │ always                   │
              ▼                          │
      analyze-asymmetry                  │
              │ always                   │
              ▼                          │
          red-team ──────dead────────────┤
              │                          │
              │ survives                 │
              ▼                          │
          size-risk                      │
              │ always                   │
              ▼                          │
           decide ──approved / rejected──┤
                                         ▼
                                 record-monitoring
```

`initial_node: "triage"`, `final_nodes: ["record-monitoring"]`.

| `id` | `role` | `node_type` | pinned skill |
|---|---|---|---|
| `triage` | `triager` | `gate` | `triage-thesis` |
| `collect-fundamentals` | `researcher` | `work` | `collect-fundamentals` |
| `analyze-asymmetry` | `analyst` | `work` | `analyze-asymmetry` |
| `red-team` | `red-team` | `gate` | `red-team-thesis` |
| `size-risk` | `risk-manager` | `work` | `size-risk` |
| `decide` | `decision-maker` | `gate` | `escalate-decision` |
| `record-monitoring` | `recorder` | `work` | `record-crossing` |

| `from` | `to` | `condition` | When |
|---|---|---|---|
| `triage` | `collect-fundamentals` | `advance` | the idea has a floor and a trigger |
| `triage` | `record-monitoring` | `discard` | it did not get past the first filter |
| `collect-fundamentals` | `analyze-asymmetry` | `always` | a single way out |
| `analyze-asymmetry` | `red-team` | `always` | a single way out |
| `red-team` | `size-risk` | `survives` | the thesis answered the serious objections |
| `red-team` | `record-monitoring` | `dead` | a serious objection with no answer |
| `size-risk` | `decide` | `always` | a single way out |
| `decide` | `record-monitoring` | `approved` | the founder approved |
| `decide` | `record-monitoring` | `rejected` | the founder refused |

**One final node, four ways of reaching it.** Three end with no allocation
(discard at the triage, death at the red team, human rejection) and one ends
with an open position (human approval). There is no separate `archive` node: it
is the same state-collapse criterion
[graph 1](../software-development/graph.json) used for the flowpilot
queues, and it is what makes the **process metrics hold per crossing** — the
discarded one and the dead one count as much as the approved one, which is
exactly what D14 wants the topographer to learn.

The mapping between a gate's `resultado` and the edge label is fixed, and it is
written in each gate's `instructions`:

| Gate | `passed` | `failed` |
|---|---|---|
| `triage` | `advance` | `discard` |
| `red-team` | `survives` | `dead` |
| `decide` | `approved` | `rejected` |

## The two nodes that define this class

**`red-team` is a gate that verifies with evidence of its own — against the
thesis.** Its `input` receives complete fundamentals and analysis, and its
`output` demands an `objections` list (each one with a severity and the thesis's
answer, or `null` when there was none) plus a `researched_counter_evidence` list
with a source external to the material received. The `instructions` forbid, in
so many words, concluding `passed` while a high-severity objection has no
answer. An empty objection list is refused by the contract: a red team that
found nothing did not run.

**`decide` never decides.** This is the only node in the system where escalating
is not a resort for when the agent does not know — it is **mandatory by
design**. If `input.perguntas_respondidas` does not contain the founder's answer
to this thesis's allocation question, the session ends the turn with an
`input-request` block and **returns no output at all**. When the answer exists,
`output` demands `human_decision` with a `question_id` and the literal
transcription of the answer — the schema refuses a `resultado` without it. The
rule is a contract, not a recommendation: no session of this graph can allocate
capital on its own, not even by mistake.

The position-size ceiling follows the same principle: it is a `maximum` in
`size-risk`'s `output`, not a check somebody could argue against.

## How to enter a thesis

A thesis comes in as **a work item on the board**, and not as a `tese` object
somebody assembles by hand:

- **`title`** is the thesis title and **`body`** is the hypothesis in free
  prose: what the market would be getting wrong, and where the idea came from.
  The origin has no field of its own — it lives in the `body`.
- **`fields`** carries the fields this class declares in `custom_fields`.
  `asset`, `premise_source` and `intended_size` are **demanded at `triage`**:
  the work does not leave that node without the three. `intended_size` is the
  size asked for the position, as a % of capital — it is what the risk-ceiling
  criterion is judged against, and without it the criterion comes out
  `undetermined` on every crossing. `downside` and `upside` are informational.
- **`entry_node_id: "triage"`**, plus this class's graph version.

The investor's criteria, their circle of competence and the state of the
portfolio do **not** come from the work: they live in the top-level `project`
object of [`graph.json`](./graph.json), which the input projection publishes at
`input.project` (`t253`,
[`packages/core/src/domain/context.ts`](../../packages/core/src/domain/context.ts)).
There are three keys, and the triage interpolates all three:

- **`triage_criteria`** — the criteria the thesis is judged against, and only
  those.
- **`circle_of_competence`** — the list of sectors and structures the investor
  declares they understand. The circle criterion is judged against that declared
  list, never against a circle the session invents.
- **`portfolio`** — open positions and current exposure. It is **required and
  nullable**, never absent: with no open position it is `null`, and omitting the
  key would make the placeholder engine refuse the whole session.

What is there is the base class's example configuration; a project variant
overwrites the whole object with the real criteria, circle and portfolio of
whoever invests (D13). There is no portfolio-state mechanism in the control
plane, so what is in the document is a still picture and keeping it current is
editing a file.

Nobody supplies the triaged thesis's `id`: `triage` derives it from the number
of the work itself (`tese-<n>`), and it is by that id that the nodes after it
speak of the same thesis.

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
[`tests/factory-graph-2.test.mjs`](../../tests/factory-graph-2.test.mjs)
(`node --test`), with the crossing fixture in
[`tests/fixtures/bets-asymmetric-thesis-example.json`](../../tests/fixtures/bets-asymmetric-thesis-example.json).

## Directory convention

`factory-graphs/<class>/` is the shape of the bundle, named from the
document's `problem_class` string (D8) — the same note as bundle 1. It is also
the shape of the atlas, one subdirectory per class, specified in
[`docs/formats/atlas-bundle.md`](../../docs/formats/atlas-bundle.md) (v0, not
frozen). Publishing this map into an atlas is copying it there once validated:

```sh
node scripts/publish-atlas-bundle.mjs factory-graphs/asymmetric-bets ../atlas
```

The two factory maps live in the same atlas without touching each other — it is
what D14 calls the seed of the shareable atlas.

## Recorded divergences

Seven places where this bundle departs from bundle 1 or from what the format
would suggest. They are written down because an unrecorded divergence becomes a
trap for whoever comes next.

1. **No manifest has a deterministic check.** In bundle 1, `make check` is the
   shop floor: the suite runs, it passes or it fails, and agentic judgement
   enters only where no command settles it. This problem class has no such
   floor — there is no command that answers "does the thesis have a floor?" or
   "is the counter-evidence real?". All seven manifests are 100% agentic, each
   one with at least one check whose `required_evidence` is not empty. It is the
   honest application of principle 6 of the README (verification density is the
   ceiling, not intelligence): manufacturing a decorative deterministic check
   here would give a sense of rigour with no rigour at all. What **can** be
   structural is structural — the position-size ceiling is a JSON Schema
   `maximum`, not a check.
2. **`collect-fundamentals` opens an unrestricted network, with no `domains`.**
   It is the inverse of bundle 1, where only the test gate opens the network and
   even then restricted to loopback. Fundamentals research sweeps public sources
   far too varied for a fixed allowlist to make sense (regulator filings,
   releases, transcripts, contracts, market data, news), and the manifest
   specification allows an unrestricted network for a **native** skill — it
   would be rejected at import. The other six manifests keep
   `network.allowed: false`, and `filesystem.write` is `[]` in all seven: not
   one node of this graph writes into the investor's repository.
3. **Escalating to the human is not an edge — and at `decide` it is
   mandatory.** All seven manifests carry the same escalation contract as
   bundle 1 (the `input-request` block), and a session that needs the founder
   pauses instead of routing: the work blocks, the question goes into the queue,
   and once answered the session resumes and only then settles
   (`docs/spec/human-escalation.md`, §4 and §5). `escalate_human` exists in the
   enum because the gate format demands the three values, and no session of this
   graph emits it. What is new relative to bundle 1 is the `decide` node: there
   escalation is *available*, here it is *mandatory by design* at one specific
   node. Identical mechanism (`perguntas_respondidas` in the `input`, an
   `input-request` at the end of the turn); a new convention on top of it, not a
   new format.
4. **The graph and the manifest speak the same outcome enum.** In bundle 1 the
   `output_schema` of the `test` node uses `approved`/`rework`/`escalate` while
   the manifest uses `pass`/`fail`/`escalate_human` — a divergence inherited from
   `t96`'s master example. Here the two sides are born together, so the outcome
   is `pass`/`fail`/`escalate_human` on both, and the domain label lives where it
   belongs: in the edge's `condition`.
5. **The crossing is proven by contract, not by live execution.** The original
   criterion asked for "a real thesis crosses all the way to the human
   decision". Pulling the skill of the registered graph version into the session
   is `t109`'s scope (`packages/runner/src/dispatch/dispatch.ts`), which had no
   commit on `main`. This bundle follows bundle 1's precedent — whose acceptance
   criterion is also the deterministic validator, and not "import it through the
   API" — and proves the crossing at the level that is already verifiable today:
   a fixture of a real thesis in which each node's conforming output feeds the
   next node's input, contract by contract, up to `decide`, where no edge is
   followed without a recorded human answer (`tests/factory-graph-2.test.mjs`,
   AT11). Once `t109` exists, a real execution test through the runner is
   stronger than this one and worth writing.
6. **The entry node read an input nobody assembled** (`t260`). Until that
   ticket, `triar-tese` — `triage-thesis` since the D24 translation — named
   `{{input.tese.titulo}}`, `{{input.tese.ativo}}`, `{{input.tese.hipotese}}` and
   `{{input.criterios_de_triagem}}`, and the input projection publishes
   something else: `input.job` (the identity of the work itself),
   `input.project` (the static configuration of the class), the bucket the node
   declares in `contract.produces`, and the class fields as flat scalars at the
   top level. A `tese` object and a top-level `criterios_de_triagem` existed
   nowhere, so the first node of a real thesis aborted with
   `UnresolvedPlaceholderError` before opening a session — failing closed on
   purpose, and exactly the repair `t259` had already made in bundle 1.
   Today the manifest reads `input.job.title`, `input.asset`, `input.job.body`
   and `input.project.triage_criteria`, `graph.json` gained the `project` that
   feeds those paths and the class field `asset`, and the crossing
   `triage` → `collect-fundamentals` runs live with a real runner and a real
   control plane in
   [`packages/runner/test/controller/factory-graph-bets.e2e.test.ts`](../../packages/runner/test/controller/factory-graph-bets.e2e.test.ts).

   **The limit of that ticket was explicit: only `triage` →
   `collect-fundamentals` crossed live** — the other five nodes stayed proven by
   contract (divergence 5). `t276` closed that limit and the whole graph crosses
   today (divergence 7); of the two holes that were named here rather than
   forgotten, neither is still open: the `capital` one closed in `t278` (just
   below) and the `resultado` one, here:

   - **`resultado` in the gate's `output`.** The report protocol tells the
     session to return ONE block only, with the edge label
     (`advance`/`discard`) INSIDE the object of the contract (`t161`, `t259`).
     Since the `output` of these manifests closes on `additionalProperties`, a
     schema that does not declare `resultado` makes the control plane refuse the
     whole report and store `null` — and then the next node cannot find the
     triaged thesis. `triage-thesis` started declaring the field there;
     `red-team-thesis` and `escalate-decision`, in `t276` (divergence 7).

   **Closed since `t278`: `size-risk` and its bare top-level `capital`.** The
   manifest asked for an object nothing in the graph produced, and static
   contract matching (`docs/spec/graph.md` §6.1) now refuses exactly that at
   import. It was closed as a DECLARATION, not by weakening the check: `capital`
   moved under `input.project`, beside where `portfolio` already lives, and the
   `project` of `graph.json` carries the snapshot that feeds it — the same
   still-picture posture, and the same "keeping it current is editing the
   document" caveat. The manifest went to `1.1.0` with a new content hash, and
   the node's pin followed (D4, D22).

7. **The other two gates were wrong in the same way, and nobody could see it**
   (`t276`). `red-team-thesis` and `escalate-decision` closed their `output` with
   `additionalProperties: false` without declaring `resultado`, exactly like
   `triage-thesis` before `t260` — so any live crossing through `red-team` or
   `decide` would have had its whole report refused (`output must NOT have
   additional properties`), stored as `null`, and the next node would have
   projected its `input` from nothing. It was not a theoretical risk but a defect
   never exercised: `t260`'s live crossing stops at `collect-fundamentals` and
   `t270`'s takes the `discard` shortcut, so no test in this repository had ever
   opened the two nodes. Both manifests started declaring the field (version
   `1.0.1` then, hash recomputed, the node's pin with it), and the **whole**
   graph started crossing live in
   [`packages/runner/test/controller/factory-graph-bets.e2e.test.ts`](../../packages/runner/test/controller/factory-graph-bets.e2e.test.ts):
   `advance` → a red team the thesis survives → the sizing → the human gate that
   pauses with an `input-request`, is answered by the founder and resumes → the
   final node; plus the `dead` path, the cheapest death in the graph. The only
   human in the crossing answers the allocation question, which is D14's design
   and not an operator unsticking anything by hand.

   **The other half of the same mismatch is still open, and it is not this
   ticket's:** the closing prose of the **three** gates still teaches
   `resultado: "passed"`/`"failed"`, which was the vocabulary from before `t178`
   and `t161` — today the schema's field is `outcome`
   (`pass`/`fail`/`escalate_human`) and `resultado` is the edge label
   (`survives`/`dead`, `approved`/`rejected`). A real session that follows the
   prose emits a label that matches no edge and stops the work at the node. The
   three are wrong in the same way and `triage-thesis` is the third, so the
   repair is a single one, it crosses `AT8` of
   [`tests/factory-graph-2.test.mjs`](../../tests/factory-graph-2.test.mjs)
   (which matches the prohibitive prose by the word `passed`) and is worth doing
   in one go. The D24 translation (`t293`) carried this divergence across word
   for word rather than repairing it, on the same principle bundle 1 followed:
   a translation ticket changes the language, never the behaviour.

## The edge format did not grow

`docs/spec/graph.md:54` and `:172` mark this graph as the second consumer that
could press `condition` into becoming a boolean expression. It does not press:
this graph's nine labels fit whole inside the current vocabulary — the outcome
label of the source node, or `"always"`. No transition here needed an "and", an
"or" or a comparison. With no evidence, the format stays as it is; the extension
waits for a third real graph that actually asks for it.
