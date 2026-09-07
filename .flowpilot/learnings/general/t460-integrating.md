### t460 (integrating, unverified)

- Any future test that seeds a mid-interview draft must use `{ done: false, ...draft }`. `graph` is required at the top level of the `interview` node's output_schema in factory-graphs/map-design/graph.json; `draft` as a key is dead since t464.
