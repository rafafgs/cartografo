### t463 (integrating, unverified)

- Both branches edit packages/screen/src/pages.ts heavily (t463 +126 lines around boardPage/stateCard/stateRow at 421-533 and 1361; t481 +50 lines around questionCard/interviewPage at 787-816, 1586, 2209) but the ONLY textual overlap is the import block at the top. The two features share the file and share nothing else in it.
- npm install removed 5 packages on entry to this worktree — the node_modules tree was stale relative to the merged lockfile. Run the setup command before judging any gate here; a baseline without it is misleading (the same trap MEMORY.md records for t252).
