### t464 (developing, unverified)

- FR10's `session_id: number` is not implementable together with its own 'routes/jobs.ts needs no change': `listSessions` returns `Session`, whose id column is `id`, so a `session_id` field breaks the structural passthrough. Named it `id` instead, which satisfies both halves.
