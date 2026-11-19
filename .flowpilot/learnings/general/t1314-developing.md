### t1314 (developing, unverified)

- Red-before-green was not literal for AT5, AT6 and AT7. The old catch already skipped the question, blocks and advance, kept the tree and surfaced the upload error, so they passed before the change. I added an assertion to each that the closure (PATCH /finish) was sent, so all three fail for the right reason before the fix. AT8 is green before and after, as the ticket says.
- Only the runner workspace was run in full, because the diff touches one runner source file and one new runner test file. Other workspaces were not re-run. No existing test file was modified.
