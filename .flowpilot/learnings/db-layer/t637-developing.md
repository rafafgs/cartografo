### t637 (developing, unverified)

- `REQUIRED_NODE_FIELDS` in graph.ts and validate-graph.mjs is now the schema's `node.required` (`id, role, node_type, contract`). `validateStructure` walks two private per-kind lists instead: skill nodes keep `skill_ref` between `node_type` and `contract`, subgraph nodes add `subgraph` after `contract`. `domain-manifest-fields.test.ts` and `domain-graph.test.ts` AT1 passed unmodified.
