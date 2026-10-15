### t741 (developing, unverified)

- AT7's unsound dry-run case cannot come from a bad edit to nodes or edges. In directory mode verifyBundle runs first and would answer `invalid bundle`. The test reaches `invalid_graph` by giving the fake lineage snapshot a different `initial_node`. The diff only covers nodes and edges, so `initial_node` differences are invisible to it, and applying the edit to that lineage is unsound.
- manifestHash does not include `version`. A test that bumps a manifest has to change real content (instructions) and recompute the hash, or the new version carries the old hash.
- The usage text in index.ts is a template literal, so a backtick in the help prose is a parse error that shows up as an eslint 'Parsing error', not a TypeScript one.
- AT10 and AT11's 'no graph.json' case already passed before implementation. They pin existing behaviour, not new behaviour.
- Registration runs after the frozen-field check but before the diff is acted on. The no-change path therefore registers manifests, and a refused edit registers nothing.
- The ticket does not name `line` in import.ts's exports, but graph.ts needs it for the skills line, so I exported it with `registerBundleSkills` and `RegistryOutcome`. It is the only export beyond what the ticket listed.
