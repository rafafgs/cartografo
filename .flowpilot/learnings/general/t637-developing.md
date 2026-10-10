### t637 (developing, unverified)

- When a subgraph node's `output_schema` requires nothing, `validateContracts` also reports the bucket itself (e.g. `note`) as `unproduced_input` for a downstream node, not only `note.text`. That is how the existing check treats a bucket nothing lands in. My first AT9 expected only `note.text`; I corrected that assertion in my own new test file, not a pre-existing one.
- `validateSubgraphCalls` skips a call whose `class` is not a filled text, because `validateStructure` already reports that. It does not check the self-call either, for the same reason.
- The class lookup is `getClass Base` then `getVersion` on its `current_version_id`. A variant-only lineage never answers: AT20 pins that by inserting a variant row through the test's `ctx.db` handle, since a variant normally cannot exist without a base.
- No file outside the ticket's declared list was touched beyond `packages/core/src/domain/graph.ts`'s siblings the ticket already named. Two new test files, `domain-graph-subgraph-contracts.test.ts` and `graph-subgraph-registration.test.ts`, are new and not in the declaration.
- A `{{{input.a}}}` string passes as a literal `{` plus a valid token plus `}`, because `[^{}]*` cannot match across a brace. Stray `}}` in a literal is never flagged.
- `graph-invalid-subgraph-*` fixtures are valid documents, so `node scripts/validate-graph.mjs` marks all four new fixtures ✔. The exit code stays 1 for the older `graph-invalid-*` files, so judge by the per-file marks.
