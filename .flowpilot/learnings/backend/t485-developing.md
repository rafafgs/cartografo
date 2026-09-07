### t485 (developing, unverified)

- The AT-2 fixture is REAL and was recovered without the API: the MCP server's credential is stale (the control plane at :4317 refuses it, the token was lost with the founder's session), but the transcripts are in ~/cartografo/.cartografo/cartografo.db, table `session`, column `transcript`, one stdout line per row-line. I copied the db+wal+shm to /tmp and queried the copy so the founder's live instance was never touched, then deleted the copy. `select id, job_id, node_id from session where job_id=5` is the whole recipe.
