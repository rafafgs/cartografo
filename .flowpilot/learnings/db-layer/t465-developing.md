### t465 (developing, unverified)

- The migration count is pinned in TWO test files, not one: packages/core/test/startup.test.ts (readiness.migrationsApplied) and packages/core/test/migrate.test.ts (applied.length). Both went 35 -> 36. Neither is in the ticket's declared shared-file surface.
