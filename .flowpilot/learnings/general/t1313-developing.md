### t1313 (developing, unverified)

- The event mirror's 'string' shape had no length bound. t1313 added FieldRule.maxLength, checked only in the 'string' case.
- session-collector's end promise only ever resolves, so 'collected.end rejects' cannot be produced. AT6 simulates a throw before the outcome by letting POST /v1/sessions reach the real control plane and then losing its answer. The row exists, the inner catch cancels the handle, and no /finish is sent.
- In dispatch.ts the compensating closure is armed right after the inner try/catch (pending = {sessionId, exitCode, lines}). It is disarmed immediately BEFORE finishSession is awaited, not after, so a lost answer can never produce a second /finish. dispatch.ts grew 8 lines (now 737, a recorded exception in file-size-budget.test.ts).
- report.ts finishSession's catch variable was renamed from error to thrown, because the new trailing parameter is called error.
- AT5, AT6 (runner) and AT11 (core streak guard) passed before the implementation: they pin existing behaviour.
- The live closing of job 2's sessions 25–38 is still owed by the flow operator: stop the runner, run 'node scripts/close-stuck-sessions.mjs --job 2' as a dry run, then with --yes, and confirm 'cartografo job 2' shows failed rows with the operator error line.
- Full npm test at load average ~50-117 took about 35 minutes, and run-all-tests prints each workspace's output only when that workspace finishes, so the log looks frozen for long stretches. Write it to a file and poll for an EXIT marker rather than judging progress by the log.
