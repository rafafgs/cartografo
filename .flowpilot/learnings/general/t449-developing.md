### t449 (developing, unverified)

- The AT3 fixture must strip only node_modules segments from PATH, not replace PATH: ensureDefaultWorkspace shells out to `git`, and an empty PATH fails the test for the wrong reason.
- A manual repro of the DoD needs node's own directory on PATH anyway — `node_modules/.bin/cartografo` is a symlink to `cartografo.mjs`, whose `#!/usr/bin/env node` shebang resolves `node` off PATH. The fix is unaffected (children are spawned with process.execPath), but `env -i PATH=/usr/bin:/bin` alone dies with `env: node: No such file or directory` before up ever runs.
- Two exported names were added to up.ts beyond `resolveSibling`: `spawnFailureLine` (the shared stderr formatter, what AT2 asserts against) and `MISSING_SIBLING` (the reason string for the no-such-file branch). spawnByName itself stays unexported.
- The stale-prose sweep went slightly wider than FR7's three blocks: the `SpawnChild` type doc and `UpSeams.spawnChild`'s `Default: child_process.spawn, by name, off PATH` also asserted the old mechanism. Comments only; no signature or call site changed.
