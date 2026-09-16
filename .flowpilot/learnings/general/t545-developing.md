### t545 (developing, unverified)

- The full `npm test` run failed on 4 runner tests: conformance-kit C9 inactivity ×3 and t400's deadline test. That is the known wall-clock flake. This branch does not change packages/runner (git diff main is empty), and running packages/runner's tests alone right after gave 909 pass, 0 fail, 2 not run. Core (971), screen and root were all green in the full run.
- Registering a second lineage in a test only needs the same fixture with a different problem_class. The snapshot hash changes, so the version id differs, and POST /v1/graphs gives no 409.
- GET /v1/graphs/:id/versions nests the contract state as `contracts.state`. There is no flat `contracts_state` field on the wire, even though the ticket's FR6 wording suggests one; that column only exists in the table.
- Diffing a JSON value that is not an object (e.g. null) would crash, and an array would diff as 'remove every node'. graph propose refuses any non-object file as a usage error before diffing.
