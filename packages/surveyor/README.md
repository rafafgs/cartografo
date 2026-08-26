# @cartografo/surveyor — the watcher that runs the lenses unattended

Subscribes to the finished-execution stream and runs both surveyor lenses over
every round that ends, until somebody stops it. It is the difference between a
lens somebody remembers to run and a lens that runs.

That is the whole of what it changed: **who calls the lens**. It applies nothing,
approves nothing and answers no question — the human gate is untouched (D21).

**Workspace-internal** (`"private": true`).

## The command

```
cartografo-surveyor watch --url http://127.0.0.1:4317 --token <token>
```

One subcommand, `watch`. `--lens <flow|cost|all>` picks which lens runs per
execution; `--dry-run` reports what each would run and runs neither. Exit codes
follow the house convention, with `1` reserved for what does not improve on a
retry: the stream refused the credential or the filter.

The flow lens spends one real agent session per execution; the cost lens spends
none.

## What it exposes

No `exports` map and no library surface: this package is a process, and its whole
job is a loop.

## Four rules shape that loop, and each is a decision

- **One execution at a time, one lens at a time inside it.** No overlap, no
  queue, no concurrency knob — that is how both lenses already run by hand, and
  running two agent sessions at once is a cost decision nobody has made. Whoever
  wants throughput starts a second process: the control plane's deduplication is
  the only coordination two watchers need.
- **One lens failing is not the round failing.** A rejection becomes an `error`
  line and the next lens runs anyway. A watcher that stopped on the first bad
  round would be a watcher that is down by morning, and the round after it is the
  one nobody looked at.
- **The lenses are injected.** The defaults build the real ones; the tests hand
  in callables. That seam is what lets the dispatch be proven without an agent
  session.
- **`--dry-run` skips a lens outright** rather than running it and holding the
  write back. The flow lens is one atomic call — it opens a session and posts in
  the same breath — so "analyse but do not post" has no seam to hang off. What a
  dry run buys is a cheap check that the plumbing is right.

## What it deliberately does not do

- **It starts itself nowhere.** No startup script, no service file, no CI job.
  Running this is a decision of its own, and it is the founder's. What this
  command is, is the thing that decision would start.
- **It remembers nothing between runs.** Killed and started again, it picks the
  stream up at the present and misses whatever fired while it was down. What it
  does not do is duplicate: two runs over the same round meet the control plane's
  deduplication.

## How it relates to the others

This is the one package that depends on siblings, and only through the doors they
declare:

| Import | From |
|---|---|
| `@cartografo/runner/surveyor/proposal` | the flow lens |
| `@cartografo/runner/engine/claude-code-adapter` | the engine that lens opens its session on |
| `@cartografo/cost-surveyor/cli` | the cost lens |

Never an internal path, never a `src/db`. Everything else it needs it reads over
HTTP from `packages/core` — the finished-execution stream included — as an
ordinary, unprivileged client (D1, D11).
