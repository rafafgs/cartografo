### t636 (developing, unverified)

- On a minimal-graph job, `completed` takes more than a transition to `revisar`: that final node pins a skill, so a session on it must finish `completed` with an output. The test helper arrive() does transition, then open a session, then PATCH /finish.
- cli-watch.test.ts AT1 failed in two full runs, and once when run alone, while an integrator session in another worktree was running its full suite. On the baseline source it passed 3/3; on this branch it passed 3/3 once the machine was quiet, and a third full npm test was fully green. This is the known contention pattern; re-run it alone on a quiet machine before believing a red.
