### t583 (developing, unverified)

- Touched a file outside the declared surface: packages/core/test/graph-version-events.test.ts t196 AT3 pinned the base version's timeline as exactly [registered, applied]; approving now keys graph_version.proposal_approved to target_version, so the expected list gained that third entry (the assertion's intent — applying adds nothing to the base timeline — is unchanged).
- The approve/reject event is keyed to proposal.target_version, so any test that reads a base version's full event list after approving a proposal on it will now see the extra event.
- specs/events/taxonomy.md:117 still says '21 types'; left untouched per Out of Scope (the code-side KNOWN_TYPES is now 23).
