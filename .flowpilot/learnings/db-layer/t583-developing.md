### t583 (developing, unverified)

- Declaring `body: OPEN_OBJECT_SCHEMA` on a Fastify route refuses a POST with NO body (no content-type) as 400 invalid_body ('body must be object'). approve/apply had callers doing exactly that (packages/runner/test/surveyor/close-outcome.e2e.test.ts's api() helper), so adding a body schema to a previously body-less route is a breaking change; read the body leniently with isObject instead.
