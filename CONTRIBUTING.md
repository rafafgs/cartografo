# Contributing

Thank you for reading this far. Before anything else, the honest framing: this
is a one-maintainer project, published to be read and copied at least as much as
to be installed. The README's invitation to take the patterns is the main way to
use it. That shapes what is easy to contribute and what is not.

## What lands easily, and what does not

**Always welcome:** issues and discussions. A question about why something is
shaped the way it is, a report that a document is wrong, a bug with the steps to
see it — those are useful whether or not you send a patch.

**Usually lands:** a small, focused pull request. A bug fix with a test that
fails without it. A correction to a specification that has drifted from the
code. A gap in an error message.

**Talk first:** anything that adds a dependency, changes a published format
(the graph document, the skill manifest, the event taxonomy, the
`EngineAdapter` interface), or spans several packages. Not because it is
unwelcome, but because those have recorded decisions behind them
([`DECISIONS.md`](DECISIONS.md)) and a PR that contradicts one is a
conversation, not a review.

**Unlikely to land unannounced:** a large refactor, a new subsystem, or a change
of architecture. Open an issue and say what you want to do.

## Running it

Node 20.11 or newer; `.nvmrc` pins the version CI uses. It is an npm workspace
monorepo.

```bash
npm ci          # not `npm install` — installs exactly the lockfile
npm run lint
npm run typecheck
npm test
```

`npm test` runs two groups, the workspaces and the root, one after the other, so
one red group never hides the state of the other. The suite runs against a fake
engine on purpose: you do **not** need `claude` or `codex` installed to run it.
You need one of them installed and authenticated only to run the product against
a real engine.

CI runs exactly those three commands on Node 22 and 24, and then checks that the
suite wrote nothing inside the checkout.

## Conventions this repository actually enforces

**English, everywhere** ([D24](DECISIONS.md)). Code, identifiers, commit
messages, comments, documents. The exceptions are the name `cartografo`, a small
frozen vocabulary the wire still carries, and the migration filenames, which are
database keys and cannot be renamed.

**Contract first** ([D9](DECISIONS.md)). A capability declares its input and its
output as JSON Schema plus a list of typed checks — a deterministic command or
an agentic judgement with required evidence. A skill with no contract does not
enter the registry, and that is the rule the whole graph model rests on.

**Only the control plane writes to the database** ([D1](DECISIONS.md)). The
runner, the screen, the surveyors and the MCP server are clients of the public
API. `npm run lint` enforces this with a static check, and a change that gives
another package a database handle will fail there.

## What the tests are for

The suite describes **what the product does**. It exercises the control plane,
the runner, the dispatch, the engine adapters, the screen, the surveyors, the
MCP server, the shipped bundles against the schema they declare, and the scripts
that validate and publish a bundle.

It deliberately does **not** test this repository about itself. Tests that
assert how a document is written, that a link resolves, that a file contains a
sentence, or that a naming convention holds were removed on purpose: a suite is
read as a description of the product, and housekeeping assertions make it
describe the wrong thing. Please do not add them back.

A bug fix comes with a test that fails without it. A test that needs a real
engine, a network or a clock does not belong in the suite.

## Commits and pull requests

Commit messages are English, in the imperative, and explain **why** rather than
restating the diff. The history here is unusually verbose about reasoning; match
it where the reasoning is not obvious, and keep it short where it is.

One concern per pull request. If you found two things, send two.

## Decisions

[`DECISIONS.md`](DECISIONS.md) is an incremental record and the entries are the
maintainer's to write. If you think a recorded decision should change, say so in
an issue and propose the text there — do not edit the ledger in a pull request.
A decision is reversed by another recorded decision, never by deletion.

## Security

Do not open a public issue for a suspected vulnerability. See
[`SECURITY.md`](SECURITY.md) for the private reporting channel and for the list
of behaviours that are designed properties rather than defects.

## Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
