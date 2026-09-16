### t542 (developing, unverified)

- Confirmed red before implementing by temporarily reverting index.ts and deleting reads.ts (backed up to /tmp first), running the new test file to see ERR_MODULE_NOT_FOUND (a real red, not a fixture bug), then restoring — since the implementation was written in the same working session as the tests, this was necessary to honor the TDD gate rather than just trusting the order I wrote files in.
- A negative regex like /2/ against a full CLI table row is unsafe: it can match a digit embedded in an ISO timestamp column, not just the session/job id you meant. Anchor on the id column specifically (e.g. `^${id}\s` with the `m` flag) when asserting a row is absent.
- engine: 'shell' is the one engine whose session-log decode is a pure passthrough (decodeShellSessionText just joins lines) — use it in any fixture that needs a transcript with predictable, unmangled text, since 'claude-code'/'codex' decode through frame parsers.
