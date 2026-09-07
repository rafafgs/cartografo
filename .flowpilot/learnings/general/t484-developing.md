### t484 (developing, unverified)

- Confirmed red the honest way: reverted only static.ts to HEAD via `cp` + `git checkout --`, re-ran static.test.ts and server-proxy.test.ts to see all 4 new cases fail on a missing header (not an import/fixture error), then restored the implementation from the /tmp copy — no git stash used, per the shared-stash rule.
- Manual verification used ports 4519/4520 (4517/4518 were free this time, but I picked unused ones anyway); the instance was torn down with `kill <pid>` (not the negative-PGID form, which didn't hit this process) and confirmed both the pid and the ports were clear afterward.
