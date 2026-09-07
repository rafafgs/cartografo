### t464 (developing, unverified)

- A report refused by the output schema is stored as `output: null` (`repositories/session.ts`: `problems.length === 0 ? judged : null`), not stored-and-flagged. That is what makes a not-yet-flattened fixture fail loudly rather than silently half-work, and it is why the e2e red surfaced as 'a session that asked nothing routed' rather than a shape mismatch.
