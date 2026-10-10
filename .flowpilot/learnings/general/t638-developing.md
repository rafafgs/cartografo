### t638 (developing, unverified)

- AT7, AT8, AT9 and AT11 pass before any implementation: they pin existing behaviour (pinless work node, statement count, unchecked storage). Every other new test went red for a missing piece first.
- The e2e cannot use resolvePins for the plan step: its stand-in manifest has output {type: object}, so validateContracts refuses the fan-out graph with unproduced_input plan / plan.items. The e2e registers a real plan-notes manifest (hash = sha256 of the canonical five content fields) and repoints the plan node's skill_ref before registering.
- classifyPreSessionFailure reads ANY ControlPlaneClientError 404 as 'the graph version is dangling'. subgraph-run.ts therefore catches every 4xx itself and blocks with the quoted refusal; only 5xx/network errors reach the pre-session handler.
- The job projection's `children` is a list of ids across ALL nodes of the parent, and `sibling_position` is per parent, not per node. The dispatch and the watcher both re-read each child and filter on parent_node_id; the watcher's 'N of M' is the index among this node's children.
- dispatch.ts now reads the graph version itself (resolveNode) before resolveSessionPlan and passes it in as the new optional 5th argument, so the version is still read once per dispatch. dispatch.ts grew 11 net lines (720, already a recorded exception).
