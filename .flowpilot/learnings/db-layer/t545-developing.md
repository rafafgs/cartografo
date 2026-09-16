### t545 (developing, unverified)

- The minimal fixture schema/examples/graph-valid-minimal.json has only one edge. Removing it is the cheapest edit that validateGraph refuses, and the real /apply then answers 422 invalid_graph and auto-rejects the proposal with the report stored in `result` (result.valid === false).
