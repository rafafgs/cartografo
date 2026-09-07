### t460 (integrating, unverified)

- `node scripts/validate-graph.mjs schema/examples/*.json` exits 1 by design — five of the thirteen fixtures are named `graph-invalid-*` and are supposed to be refused. Judge it by the per-file marks (all eight `graph-valid-*` are ✔), never by the exit code.
