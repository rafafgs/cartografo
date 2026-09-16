### t543 (developing, unverified)

- GET /v1/jobs works with no graph_version_id at all (fires job.created only) — useful for tests that only need arrival/reconnect events; job.transitioned and execution.finished need a real registered graph with skill pins resolved (schema/examples/graph-valid-minimal.json + test/support.ts's resolvePinsOver, reused via a plain-fetch adapter since cli-support.ts's startControlPlane already authorizes the global fetch).
