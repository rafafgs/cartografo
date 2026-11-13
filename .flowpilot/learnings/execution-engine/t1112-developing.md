### t1112 (developing, unverified)

- A job with no graph_version_id stays released after its session completes, so in the e2e a project with work keeps getting its first job redispatched. AT25 therefore checks the order of the first four sessions (A,B,A,B), which proves the alternation; it does not prove that each project's second job was reached.
