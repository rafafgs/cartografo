### t1331 (developing, unverified)

- The acceptance tests were committed first (64abcc0) and confirmed red for the right reasons before any src change. The route cases failed with `stale_proposal`, `unknown_graph`, a spurious `version_without_effect`, an unregistered-pin refusal, 409 on revert, and `execution_without_evidence` or a wrong 200 on outcome. The CLI cases failed with `unknown_proposal`. AT8 (project 1 unchanged) passes before and after, because it pins existing behaviour.
