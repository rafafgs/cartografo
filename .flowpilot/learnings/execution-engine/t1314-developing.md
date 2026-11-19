### t1314 (developing, unverified)

- The failed-upload case also had to be excluded from `dirtyDespiteCompleted` and `refusedReport`, not just from `advance`. Without that, a session whose tree the manager kept would still post a 'uncommitted work' block on top of the failed upload. Both now carry `uploadFailure === null`, and a failed upload leaves `request` null, so no question is posted.
- The TDD exception is still owed to the flow operator: a real run of the finalize node on the live board with a deliberately failing upload, to see the transcript on the live session.
