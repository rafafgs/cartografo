### t1339 (developing, unverified)

- Outside the declared surface: packages/core/test/event-validation.test.ts (t196 AT9) pins the exact ordered list of event types. I added the two new names after session.permission_denied and changed its title from 25 to 27, nothing else. The ticket allowed this extension.
- The shared Session type in test/support.ts has no `output` field, so the new test file declares its own WithOutput interface instead of editing support.ts. typecheck covers test files, `node --test` does not, and the first draft failed typecheck.
- An exact repeat of a settlement is answered 200 before the artifact is looked up again, and appends nothing. A different artifact id for a settled name is checked for existence, session and name first, so a non-existent id answers 400 and a valid conflicting one answers 409.
- effectiveOutput reads one session's events per completed session in nodeInputOf, which is fine at current job sizes. It is skipped for any session whose events carry no session.artifacts_pending, so sessions that declared nothing contribute exactly as before.
