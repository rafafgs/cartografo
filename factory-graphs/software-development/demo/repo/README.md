# The demo project of `software-development`

A disposable fixture, and nothing else. It exists so the
`software-development` graph has a real git repository to be demonstrated
against, instead of the empty one `cartografo up` provisions when a machine has
never run the product.

**This directory is never edited in place.** Every
`POST /v1/examples/software-development/run` COPIES it into whatever the
project's `workspace_root` setting points at, runs `git init` there and commits
it as that repository's first commit. The demo's sessions work on the copy; this
one stays exactly as it is in the repository, which is what makes a second demo
run start from the same place as the first.

The route refuses rather than guesses: it provisions only a `workspace_root`
that does not exist, is empty, or is the pristine one-empty-commit repository
`cartografo up` leaves behind. A workspace that already holds work — including
the one a previous demo run provisioned — is answered `409 workspace_not_empty`
and is not touched. Resetting it between runs (deleting the directory, or
pointing the setting somewhere else) is the operator's own call.

## What is in it

| Path | What it is |
|---|---|
| `package.json` | No dependencies, and `npm test` is `node --test`. |
| `lib/text.js` | One module, exporting `slugify`. |
| `test/text.test.js` | Its sibling suite, green as committed. |

## The change the demo job asks for

`demo/job.json` asks for one small, concrete addition: a `titleCase` export
beside `slugify` in `lib/text.js`, with its own cases in `test/text.test.js`.
Small on purpose — the point of the demo is the graph crossing
`refine → develop → integrate → test`, not the difficulty of the work it
carries.
