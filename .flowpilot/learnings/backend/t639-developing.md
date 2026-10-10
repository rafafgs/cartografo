### t639 (developing, unverified)

- The e2e spawns the binary per read (~0.5s each), so AT19 takes ~9s; the dispatch hook is the only place the test still reads the API itself (to pick the fake session's script by node).
