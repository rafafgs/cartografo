### t639 (developing, unverified)

- Sibling positions are assigned by creation order (MAX+1 per parent), so position order and id order can never differ; AT3's 'the two orders differ' cannot be arranged. The test interleaves unrelated jobs and asserts position order; the CLI orders child rows by the parent's own `children` array.
- Touched outside the declared list: packages/core/test/cli-composition-support.ts (new shared seeding helpers for the two core test files) and packages/mcp/test/tools.test.ts's JOB_FIXTURE-style job at ~:378, which only needed the seven new fields to keep typechecking now that the MCP Job type declares them (no assertion changed).
- After a registered minimal graph exists, a second POST /v1/graphs is refused; look the version up via GET /v1/classes by `class === problem_class`, never classes[0] (the factory bundle's map-design is listed first).
- In a template-literal RegExp, `\s` must be written `\\s` (new RegExp(`^\\s+id`)); `\s` silently becomes a literal `s`.
- `cancel` output uses line() (label padded to 18), so tests must match `\s+` between label and value, not a fixed run of spaces.
- mcp-server.md §2 no longer says 'verbatim ... lines 1-45': the header comment of tools.ts gained a third exclusion (cancel), so the sentence now says 'from the catalogue's own header comment'.
