### t465 (developing, unverified)

- packages/screen/src/client.ts's Conversation had to gain `partial` (the Out of Scope line excludes only that file's Session interface), and the five hand-written shapes in interview.test.ts's t433 AT17 needed `partial: null` to keep typechecking — a compile consequence of a new required field, not a change of what AT17 asserts.
- thinking and partial are derived from ONE `sessions.find(open)`, not a `some()` plus a separate lookup — two reads would be two chances to disagree about whether there is an open session and which one it is.
