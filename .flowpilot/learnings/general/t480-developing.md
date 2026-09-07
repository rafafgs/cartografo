### t480 (developing, unverified)

- report.ts is at 538 of its 600-line budget after this. The next ticket to add a helper there has about sixty lines of headroom, comments included — and this package's files are majority documentation, so that is less than it sounds.
- The mirror and the runner's parser take DELIBERATELY opposite postures on a malformed item (400 the whole write vs. drop the field and keep the question). Both are documented in place; changing either to match the other would be a regression, not a cleanup.
