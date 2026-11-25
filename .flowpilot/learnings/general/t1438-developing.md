### t1438 (developing, unverified)

- packages/runner/src/dispatch/resolve-executor-environment.ts is at exactly 600 lines, the limit in file-size-budget.test.ts. Re-wrapping one execFile call pushed it to 605, so the three runGit sites keep a one-line call of about 116 columns. The next ticket that adds a line there has to split the module.
- The headers of claude-code-adapter.ts, codex-adapter.ts and copilot-adapter.ts (around line 10 or 12) still say 'the detached spawn', which is now true only off Windows. They were left alone because FR6 names only the process-lifecycle header and the two inline comments.
- tests/windows-hide-spawn.test.mjs requires every runtime child_process call to carry a literal windowsHide: true in an inline options object. Passing options through a variable or a spread-only object fails the scan, as does a default, namespace or dynamic import of child_process.
