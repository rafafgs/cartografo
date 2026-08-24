# Extension and a quality standard for an open project (2026-08-14)

An iteration with Rafael: cartografo as an open orchestration model, with a high
quality standard and extension points to build on top of.

## The organising principle

**In an open project, the real extension points are the formats, not the code.**
Code interfaces change; documented formats stay. Four formats treated as a
product, with a versioned schema and a specification document:

1. **The graph schema** — nodes, edges, gates, contracts; exportable,
   importable, diffable, publishable.
2. **The skill manifest** — the contract plus declared permissions.
3. **The event taxonomy** — the format of the telemetry is a public API (it is
   what third-party dashboards and topographers consume).
4. **The EngineAdapter interface**.

## Extension points

1. **EngineAdapter** — plugging in a new CLI; quality guaranteed by a
   **conformance kit** (a suite a third-party adapter has to pass).
2. **Skills** — the registry is an extension by nature; the import gate (D4)
   holds the quality when it opens to the world.
3. **Deterministic gates** — a test runner, a linter, a schema validator; a cheap
   and safe surface to contribute to.
4. **Pluggable topographers** — the most strategic one, and non-existent on the
   market: analysers (flow, cost, quality) reading the same telemetry and issuing
   proposals in the same format. A community writing topographers = a community
   improving the system's brain.
5. **Events to the outside** — webhooks/a stream of transitions; a headless,
   API-first core; the official screen is just another client of the API, with no
   privileges.

## The quality non-negotiables

- **Formal graph validation at the synthesis gate**: the soundness of workflow
  nets (van der Aalst) is mechanically verifiable — every node reachable,
  termination guaranteed, no edge without a condition, no node without a
  skill/contract. Part formal code, part human judgement. The positioning
  sentence: "we formally verify the graphs the AI proposes".
- **Replayability by event sourcing**: graph vN + inputs ⇒ an execution
  replayable from the log (it makes a third party's bug report tractable).
- **Skill safety**: permissions in the manifest (filesystem, network), a pin by
  hash, a sandbox wherever the engine allows one.
- **One-command startup** (`npx cartografo`): time-to-first-graph is a quality
  feature.
- **Automatic database migrations and a versioned API from v0 onwards**: an open
  project does not control when other people update.

## The graph as a shareable artifact (the network effect)

Graph + skills + contracts export as a publishable bundle; the community
contributes **maps**, not only code. A community atlas of graphs per problem
class is at once the viral distribution (a funnel to agentsmaestro.dev) and the
moat a large player cannot copy by absorbing a feature.

## The rule of two consumers

An extension point designed before two real consumers exist is born wrong. In
practice: two adapters (Claude Code + a second CLI) before freezing the
EngineAdapter; two topographers (flow and cost) before freezing the proposal
format; two graphs (software + a second domain) before freezing the graph schema.
The MVP's ordering (D6) already forces almost all of that.
