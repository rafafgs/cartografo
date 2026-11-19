### t1339 (developing, unverified)

- A settlement conflict (session not completed, name never declared, a different id for a settled name) is a SettlementConflictError thrown by the repository and mapped to 409 in the route. Everything else is a ValidationError (400). The check-and-append runs in one db.transaction, so two racing settlements cannot both pass.
- The partition guard and write-scope guard passed with no edit. Writing project_id inside the repository functions was fine; only the route handlers avoid the literal.
- RUNNER_SURFACE in auth.ts is untouched, as the ticket asked: a runner credential cannot reach the new settlement route yet, so that is the runner-side child's work.
