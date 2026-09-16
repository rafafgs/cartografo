### t547 (developing, unverified)

- A full `npm test` run failed once on packages/core's t250 docker e2e test with a container-name collision ('/cartografo-docker-test-1' already in use, then 'No such container') — caused by another concurrent worktree session racing the same fixed container name, not by this ticket's diff (which touches only packages/mcp and the two READMEs). Re-running t250 in isolation and re-running the full suite both came back green; if this recurs, check for a concurrent worktree also running docker-image.e2e.test.ts before assuming a real regression.
