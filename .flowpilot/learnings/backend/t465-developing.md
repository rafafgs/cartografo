### t465 (developing, unverified)

- Fastify's default bodyLimit is 1 MiB, which is EXACTLY TRANSCRIPT_CAP_BYTES — so a partial-text route without an explicit bodyLimit makes its own cap unreachable (413 before the handler). Reused FINISH_BODY_LIMIT_BYTES; FR2 did not name it and AT5 cannot pass without it.
