### t636 (developing, unverified)

- test/partition-guard.test.ts (t414) caught the cascade's children read in cancelJob, which had no project_id predicate. I fixed it by scoping the read to the parent's project (children always share it, since createJob only resolves a parent inside the child's own project), not by adding it to the allowlist. Any new `FROM job` read in job.ts needs a project predicate or an allowlist argument.
- packages/core/src/repositories/intake.ts and migrations/0006_intake.sql still say a dependency is 'RECORD only: nothing blocks the dependent job'. That is now stale: the lease grant enforces it through dispatch_hold. Both are outside this ticket's declared files, so I left them alone. The taxonomy entry was amended as FR16 asked.
