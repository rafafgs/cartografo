### t492 (developing, unverified)

- Which schema a session's report is validated against is the PINNED SKILL's `output` (`repositories/session.ts` resolveOutputSchema), never the graph document's own `contract.output_schema`. That is why the screen test needs its own fixture graph: to make the control plane really accept a nested report, the fixture's first step has to pin a manifest carrying the pre-t464 contract.
