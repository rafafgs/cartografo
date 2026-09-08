### t491 (developing, unverified)

- Running three package suites at once on this laptop produces a wave of false reds — 13 in one runner-suite run (t371's eight AT cases, two conformance-kit timeouts, dispatch.test.ts taking 28 minutes), all green when re-run alone. Judge a red here by an isolated re-run before believing it, especially while another worktree's session is testing.
