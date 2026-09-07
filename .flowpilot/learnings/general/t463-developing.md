### t463 (developing, unverified)

- npm test for this monorepo reliably exceeds the 120s foreground Bash timeout (full run took ~80s just for the runner package alone, ~5+ min total) — redirect to a log file and run with an explicit longer timeout rather than letting it get auto-backgrounded.
