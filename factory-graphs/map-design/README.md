# Factory bundle: `map-design`

The fourth bundle in the box, and the only one whose subject is the product
itself. Somebody keeps solving the same kind of problem by hand and wants it to
become a map; this bundle interviews them into one.

The claim it stands for is §1.2 of the requirements: **the interview is itself a
map, not special code**. There is no chat engine and no conversation entity
behind it — the questions are ordinary input requests, the draft is the ordinary
structured output of a session, and the whole thing is a job on a graph like any
other job on any other graph.

## Files

| File | What it is |
|---|---|
| `graph.json` | Two nodes, one edge. `interview` (entry) and `deliver` (final). |
| `skills/interview.json` | Asks one question per session and reports the map under construction after every answer. |
| `skills/deliver-bundle.json` | Writes the draft out, holds it against `scripts/validate-graph.mjs`, and reports it. |

## Topology

```
interview --always--> deliver
```

One edge, and **no self-loop** — which is the one thing about this bundle worth
reading twice.

A session that ends with an `input-request` block does not move the job: the
control plane blocks it, on the node it is standing on, in the same transaction
that records the question. When a person answers, the job is unblocked and the
runner dispatches **that same node again**, as a fresh session whose prompt
already carries every question and answer of the interview so far
(`## What you already asked, and what came back`,
`packages/runner/src/dispatch/prompt.ts`). Twenty turns of an interview are
twenty dispatches of `interview`, and the graph needs no edge to say so.

The single edge is therefore taken exactly once: on the turn that asks nothing,
which is the turn that says the map is finished.

## The contract, in one paragraph

`interview` produces the bucket `interview`, so its report lands at
`input.interview` for the node after it. Every turn's report shallow-merges into
that bucket in closing order, so the **last** turn's `{done: true, draft}` is what
`deliver` reads — which is why each turn reports the draft **whole** rather than
as a patch: what a turn does not report is not there next turn.

The drafted manifests carry **no `hash`**. The pin is computed by whoever
registers the bundle, and a hash invented by the interview is a pin that will not
close (D4).

## Recorded divergences

1. **No demo job.** The other bundles that ship one are listed on the screen's
   examples page and can be run with a click. This one is started by a person
   describing their own problem, and a canned description would be a demo of the
   demo.
2. **`escalation_policy: "always"` on `interview`.** Every other node in the
   repository escalates on uncertainty; this one escalates by construction —
   asking IS the work it does.
3. **It is imported at `up`'s first start** (`packages/core/src/cli/up.ts`), not
   by hand, because the interview has to be there before anybody can start one.
   A second startup finds the class already registered and imports nothing.

## Validating it

```
node scripts/validate-factory-bundle.mjs factory-graphs/map-design
node scripts/validate-graph.mjs factory-graphs/map-design/graph.json
```

The crossing itself is
`packages/runner/test/controller/factory-graph-map-design.e2e.test.ts`: four
scripted turns against a real control plane, a real `Controller` and real leases.
