### t1314 (integrating, unverified)

- On main without t1314's source change, t1314's test file already passed 7 of its 8 cases. t1313's compensating closure covers the transcript, the closure, kept tree, the precedence and the skip of every downstream write. After this integration the branch's net diff against main is only the new test file and the learnings.
- Whether a completed session whose only failure was the artifact upload should ever read `completed` is still an open, separate decision, as close-after-failure.ts says. It was deliberately not decided here.
- Still owed by the flow operator once done: one live run of the finalize node with a failing upload, checking that the session reads failed with the error line on `cartografo job` and that its transcript is stored.
