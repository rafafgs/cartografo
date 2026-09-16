### t548 (developing, unverified)

- `cartografo up --no-screen` alone STILL opens the browser: packages/core/src/cli/up.ts:702 checks only flags.browser, with no link to flags.screen, so it opens a URL where nothing is listening. Every no-browser example in README, getting-started and what-cartografo-is therefore says `--no-screen --no-browser`. FR9/FR11's literal `up --no-screen` would have sent a reader to a browser tab with no page behind it. A one-line code fix (skip the browser when the screen is off) is worth its own ticket; it is out of scope here.
