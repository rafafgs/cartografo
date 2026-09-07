### t460 (integrating, unverified)

- A session report refused by a node's output_schema is stored as `output: null`, not stored-and-flagged (t464, `repositories/session.ts`). So a stale test seed surfaces far from its cause: AT9/AT10 failed inside `reportFrom`'s `output_accepted` assertion, and had that assertion not been there they would have failed as 'the panel drew nothing' with no hint that the seed was the problem.
