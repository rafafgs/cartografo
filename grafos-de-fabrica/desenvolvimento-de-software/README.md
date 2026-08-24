# Factory graph 1 — software development

> The cartografo's first real map: the software delivery flow, with the five
> skill manifests its nodes pin by hash. A factory graph in the sense of
> **D14** — shipped ready to use, not synthesized.

**Status: content, not format.** This ticket (`t105`) designs no new format: it
applies the two already closed — the graph document
([`docs/spec/graph.md`](../../docs/spec/graph.md), `t96`) and the skill manifest
([`especificacoes/formatos/skill-manifest.md`](../../especificacoes/formatos/skill-manifest.md),
`t97`) — to produce the first real content. It is direct input to the PoC (D16)
and the seed of the factory library.

| File | What it is |
|---|---|
| [`grafo.json`](./grafo.json) | The graph document: five nodes, five edges, one pinned `skill_ref` per node. |
| [`skills/refine-ticket.json`](./skills/refine-ticket.json) | `work` — a raw request becomes an executable specification. |
| [`skills/develop-ticket.json`](./skills/develop-ticket.json) | `work` — implementation in an isolated checkout, acceptance tests first. |
| [`skills/integrate-branch.json`](./skills/integrate-branch.json) | `work` — a merge that reconciles both sides, with quality reverified on the merged tree. |
| [`skills/alpha-test.json`](./skills/alpha-test.json) | `gate` — a semantic walkthrough of the acceptance criteria against the running application. |
| [`skills/verify-release.json`](./skills/verify-release.json) | `work` — deterministic verification that the merge commit is published. |

## The topology

```
refine ──always──▶ develop ──always──▶ integrate ──always──▶ test
                       ▲                                      │
                       └──────────── rework ──────────────────┤
                                                              │
                                              deploy ◀──approved
```

`initial_node: "refine"`, `final_nodes: ["deploy"]`. One node per flowpilot
activity state; the queue states (`to_refine`, `to_develop`, …) are scheduling
plumbing and do not become nodes, which is why `backlog`/`done` stay out too.
There is no separate rejection edge: the only way back is the `test → develop`
rework cycle.

The `grafo.json` **starts from**
[`schema/exemplos/graph-valid-flowpilot.json`](../../schema/exemplos/graph-valid-flowpilot.json)
— `t96`'s master example, read as a reference and **never modified**. Two places
differ from it. Each node's `skill_ref`: in the example the hashes are
reproducible placeholders (no real skill existed to pin) and the ids carry an
illustrative `cartografo/` prefix; here the ids are pure kebab-case, identical
to each manifest's `id`, and the hashes are the real hashes of the pinned
content. And each node's `contract.checks`, which in the example illustrated the
format with commands from an invented stack (`make check`, `make smoke`) and
here restates the `checks` of the pinned manifest — see "Recorded divergences".

Per D17 flowpilot is a **behavioural reference, with no code dependency**: the
port is a reimplementation, and nothing in this bundle reads anything from there
at run time.

## How to validate

```bash
# graph + manifests + hash pins + check parity, all at once
node ../../scripts/validate-factory-bundle.mjs .

# cross-check of the manifest format, with a third-party validator
npx --yes ajv-cli@5 validate \
  -s ../../especificacoes/formatos/skill-manifest.schema.json \
  -d './skills/*.json' --spec=draft2020
```

The first command checks the four things that make this a bundle and not a
handful of JSON in the same directory: the graph is sound by `t96`'s four rules,
every manifest validates against `t97`'s schema, **every pin closes** — the
recomputed hash of each manifest's content matches what the corresponding node's
`skill_ref` pins (D4) — and **the two declarations of how each node verifies
itself agree**: `contract.checks` in the graph and `checks` in the pinned
manifest carry the same number of items, the same sequence of `type` and the
same `command` on every deterministic item (`t176`).

The hash is the one from the manifest specification's canonical procedure:
`sha256` of the canonical JSON of `{instructions, input, output, checks,
permissions}`. Touch a line of `instructions`, loosen a check or open a
permission, and the hash changes and the bundle stops validating until the
node's `skill_ref` is updated — which is exactly the change D4 wants brought
back to the human gate.

This bundle's acceptance tests live in
[`tests/factory-graph-1.test.mjs`](../../tests/factory-graph-1.test.mjs)
(`node --test`), and the validator's in
[`scripts/validate-factory-bundle.test.mjs`](../../scripts/validate-factory-bundle.test.mjs).

## Directory convention

`grafos-de-fabrica/<class>/` is the bundle's shape, named after the document's
`problem_class` string (D8), and it is the same shape the atlas uses: one
subdirectory per class, with `grafo.json` and the manifests its nodes pin. The
layout, the publication step and the integrity check during a traversal are in
[`docs/formatos/atlas-bundle.md`](../../docs/formatos/atlas-bundle.md) — v0, not
frozen, by the rule of two consumers.

In practice that means this directory and an atlas checkout are interchangeable
inputs of the same command, and that publishing this bundle into an atlas is
copying it there once validated:

```sh
node scripts/publish-atlas-bundle.mjs \
  grafos-de-fabrica/desenvolvimento-de-software ../atlas
```

The control plane's skill registry already exists, and `cartografo import
grafos-de-fabrica/desenvolvimento-de-software` registers the five manifests
(`POST /v1/skills`, each one revalidated by the server) before sending the
graph: a manifest the registry refuses aborts the import and the graph never
goes up. The deterministic validator above remains the acceptance criterion **of
the bundle as a repository artifact** — it runs with no server at all, inside
`npm test`, and it is what guarantees the directory is sound before any import.
The path through the API has its own coverage in
[`packages/core/test/cli-import-export.test.ts`](../../packages/core/test/cli-import-export.test.ts).

## Recorded divergences

Three places where this port departs from what the source does or from what
`t96`'s draft suggested, plus two that have already been reconciled. They are
written down because an unrecorded divergence becomes a trap for whoever comes
next.

1. **`deploy` is an agentic node and should not be.** In flowpilot this step
   never opens a session: it is a 100% deterministic sweep (one commit-ancestry
   question, three possible answers). The graph schema's `node_type` only knows
   `work` and `gate`, both of which dispatch a skill through an engine, and
   creating a third "sessionless" type now would violate the rule of two
   consumers — the graph schema only extends after two real graphs press on it.
   The port leaves the node agentic with 100% deterministic checks and trivial
   instructions; when there is a second real case, the new type arrives with two
   consumers to prove the format.
2. **Two vocabularies for the gate's outcome — and the edge label is neither
   of them (`t275`).** The `test` node's `output_schema` still declares
   `outcome` with `approved`/`rework`/`escalate`, inherited from the master
   example, while the manifest declares the enum the gate format demands,
   `pass`/`fail`/`escalate_human`. That half stays open. What closed is the
   routing: the edge is named by neither of those, but by the reserved key
   `resultado` — the node declares it beside `outcome`, with the `condition` of
   its own two edges, and the manifest's instructions map the verdict onto it,
   `outcome: "pass"` with `resultado: "approved"` and `outcome: "fail"` with
   `resultado: "rework"`. Until `t275` those instructions spent `resultado` on
   the verdict itself (`resultado: "passou"`), a value no edge of this graph
   carries: a session that obeyed them routed nowhere AND reported without the
   `outcome` the manifest requires. The skill's `output` does not declare
   `resultado`, and must not — the control plane takes the key out of the report
   before holding it against that schema (`docs/spec/graph.md`, `t269`). The KEY
   itself stays spelled `resultado` after `t280`'s translation, and that is not
   an oversight: it is the result protocol's reserved word, read by
   `packages/runner/src/dispatch/parse-node-result.ts` and stripped by the
   control plane, so it belongs to the runner's vocabulary and not to this
   bundle's. Its VALUES are this graph's edge labels, and those are English.
3. **Half the bundle crosses live; the other half is still only proven by
   contract** (`t259`). `refine` → `develop` → `integrate` runs end to end with
   a real runner: each node receives what the previous one produced, the
   refinement's specification reaches whoever develops and the development's
   branch reaches whoever integrates, with no operator in between
   ([`packages/runner/test/controller/factory-graph-software.e2e.test.ts`](../../packages/runner/test/controller/factory-graph-software.e2e.test.ts)).
   `test` and `deploy` do **not** cross, and it is not missing wiring: they name
   `{{input.project.application.*}}` (a running application),
   `{{input.banco_de_testes.*}}` (a shared test checkout) and
   `{{input.referencia.*}}` (the commit of a running install). None of the three
   had a source in the input projection, a mechanism in the runner, or a design
   anywhere in this repository — that is a ticket of its own, for whoever feels
   the pain first. Meanwhile the two nodes **block with a legible reason**
   instead of entering a retry loop (`t252`), which is the correct behaviour for
   a failure that reproduces identically on every tick.

   Two things changed in the bundle for the first half to work, and they are
   recorded because they are not obvious. The five manifests read
   `{{input.ticket.id}}`/`{{input.ticket.titulo}}` for the work's own identity
   and `{{input.projeto.*}}` for the class configuration; the projection
   publishes those at `input.job` and `input.project` (`t253`), so the manifests
   moved to the names that exist — `{{input.ticket.especificacao}}` stayed as it
   was, because that one IS the bucket `refine` declares in `contract.produces`
   (and `t280` renamed it to `{{input.ticket.specification}}`, which is this
   bundle's own key to rename). And `{{input.ticket.tipo}}`,
   `{{input.workspace.*}}` and the unconditional `{{input.contexto_falha}}` at
   the end of every instruction went away: the first never had a column feeding
   it, the second would only exist if the worktree were cut before the prompt
   was rendered (the opposite of `dispatch.ts`'s guarantee), and the third is the
   half of `t253` that has not been built yet (FR8) — whoever exercises the
   `test → develop` rework cycle brings it back when it exists.

   The `grafo.json`'s top-level `project` carries the reference project's
   configuration (this repository): without it the base graph cannot dispatch
   even the first node. By D13 a project-specific value lives in the variant — a
   variant of this class overrides that whole object, and that is how the same
   map serves another repository.

**Reconciled by `t176` — the manifest is the only source that declares HOW
a node verifies itself.** The graph was born from `t96`'s master example with
`make check` on `develop`, `integrate` and `test` and `make smoke` on `deploy`:
hardcoded technology, and in `test`'s case the **opposite** of what the manifest
demands — the test skill explicitly forbids rerunning the gates the integration
already ran against this very tree (`flowpilot testing.py:77`, "NEVER re-run the
quality gates as the validation"). Where the two disagreed, the manifest won: it
is the one the runner injects into the session. Today each node's
`contract.checks` restates the `checks` of the manifest the node pins — same
count, same sequence of `type`, same `command` on the deterministic ones — and
`test` was left with the semantic walkthrough alone. The two remain **distinct
formats for the same verification**, not the same field duplicated:
`required_evidence` is a list of artifacts in the manifest and the literal `true`
in the graph, and the text of an agentic item is rewritten in each format rather
than copied — the discipline
`packages/runner/src/synthesizer/prompt.ts` already states for the synthesizer.
Diverging in structure again now brings the validator down, with no dependency
on a manual parity review.

**Closed (t177, 2026-08-15): the stale `output_schema` of `refine` and
`test`.** It was the same class of divergence `t176` reconciled just above, one
field over — the copy of `t96`'s master example ageing while the manifest, which
is what counts, moved on. The `test` node declared `evidence` as a single string
and `defects` as a list of strings; it now declares `verdicts` (one per
criterion, `{ref, verdict, evidence}`, required) and `bugs` with `severity`,
mirroring `alpha-test.json`'s `output`. The `refine` node started requiring
`note` and declaring `model_tier` and `gotchas`, mirroring `refine-ticket.json`.
The node's `outcome` and its `approved`/`rework`/`escalate` enum stay as they
are: it is edge vocabulary, and translating it is divergence 2, still open.
Whoever reconciles is whoever first notices the difference — this was it.

**Two parity criteria that were already closed.** The parity review of
2026-08-15 listed as missing two rules the manifests already carried, and the
note stays here so the next review does not repeat the mistake: the rule "the
same gate fails three times in a row for the same reason → stop and ask" is in
`develop-ticket.json` and in `integrate-branch.json`, in each one's "## When
something is genuinely stuck" section; and "never weaken a check to make it
pass" is in step 4 of "## Reconciling", in `integrate-branch.json`. Compare with
flowpilot's `development.py:105-109`, `integration.py:117-121` and
`integration.py:107-110` (D17: behavioural reference, with no code dependency).
Reading only `grafo.json`'s summary is not enough — the comparison is against the
manifest.

And one consequence worth spelling out: **escalating to a human is not an
edge**. The five skills carry the same escalation contract (the `input-request`
block) — not only the test gate, and that is what `AT8` of
[`tests/factory-graph-1.test.mjs`](../../tests/factory-graph-1.test.mjs) checks
across the five manifests —, and a session that needs the founder pauses instead
of routing: the work is blocked, the question enters the escalation queue, and
once answered the session resumes and only then settles. It holds for all five
nodes, and that is why it keeps not being an edge: escalation is a first-class
entity (`input_requests`), not a special case of routing, and declaring an
"escalate" edge out of every node would duplicate that mechanism inside the
topology — five edges no session ever walks. `escalate_human` exists in the enum
because the gate format demands the three values, but in this graph no session
emits it: the only in-flight decisions are gate outcomes over edges already
declared.
