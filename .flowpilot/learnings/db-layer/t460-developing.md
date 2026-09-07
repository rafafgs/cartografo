### t460 (developing, unverified)

- AT2's fixture is single-exit. The ticket's AT text says 'multi-exit edge' but also says to reuse a schema/examples/graph-invalid-*.json fixture, and the only edge_with_condition counterexample there has one exit; the rule is per-edge and fan-out never enters it, so the fixture was reused with condition set to null (job 5's actual shape) rather than a new document invented.
