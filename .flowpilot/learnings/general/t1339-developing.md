### t1339 (developing, unverified)

- The stream type filter needed no code: it validates against KNOWN_TYPES, which is derived from the RULES keys. AT12 only asserts a non-400 on the stream; it does not read an event off it.
- Only packages/core and the root test suites were run in full. runner, mcp, surveyor and screen were not re-run, since the diff only adds event types and routes in core. They were included in typecheck and build, both clean.
- Not done: the live-board check owed under the TDD exception (a real finalize run that settles an artifact after the closure). Nothing was exercised against a running control plane beyond the in-process test app.
