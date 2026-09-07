### t462 (developing, unverified)

- factory-graphs/map-design/graph.json (not in the ticket's declared shared-file surface) had to be edited too: its pinned skill_ref for the interview node still named version 1.2.0/the old hash, and validate-factory-bundle.mjs refuses a stale pin — updated to 1.3.0/the recomputed hash.
- manifestHash's hashed subset is {instructions, input, output, checks, permissions, budgets, command} — version is NOT hashed, so bumping version alone never moves the pin; only the instructions edit did.
- renderMap's own doc comment (interview.ts) was updated in the same commit to describe the new prepend-and-render-map shape, since the old comment ('through the one renderer there is') became inaccurate.
