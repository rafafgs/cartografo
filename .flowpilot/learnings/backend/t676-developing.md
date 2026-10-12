### t676 (developing, unverified)

- The t675 test at packages/runner/test/cli/index.test.ts:~895 still passes but its comment 'A raw passthrough for now' is stale now that the route decodes frames (['a','b'] still joins raw because non-frame lines pass through). Left untouched per 'never edit a test'.
