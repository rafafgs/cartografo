### t675 (developing, unverified)

- FR2 says nothing goes through stdin, but kit case C11 requires content to leave the argv. Measured: with NO `-p`, piped stdin is the prompt (300 KB, dash-leading, byte for byte); with `-p` it is ignored. So above 64 KiB (instructions + prompt, bytes) the command drops `-p` and the adapter pipes the composition to stdin, as Codex does.
- `--output-format json` has no start frame. The session id appears only in the final `result` frame, and `result.sessionId` always equalled the `--session-id` passed. A failed run (unreachable provider) ends with `session.error`, a `result` frame carrying `exitCode:1`, and process exit 1.
- The session-cleanup natural-exit case leaves out the grandchild: none of the three adapters sweeps the process group on a natural exit, so asserting 'no process of the group survives' there would test the fake engine, not the adapter. Cancel, wall clock and inactivity do assert it, with a SIGTERM-ignoring grandchild.
