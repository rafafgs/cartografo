### t545 (integrating, unverified)

- `--graph` means two different things now: `job create --graph <graph-version-id>` and `graph propose --graph <lineage-id>`. USAGE lists it once as `--graph <id>` with a line for each subcommand. Any other flag both sides add should be merged the same way, not listed twice.
- Main has removed the ordinal counts from README's CLI paragraphs ('the ninth', 'the tenth'), so a CLI ticket that meets main should drop its ordinal rather than renumber it.
- Full npm test: core 989/989. Runner 911 tests with 909 pass and 0 fail; the other 2 are skipped/todo, as t584 already recorded.
