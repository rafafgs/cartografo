# Security

## Reporting a vulnerability

Report privately through GitHub's **[Security
Advisories](https://github.com/rafafgs/cartografo/security/advisories/new)** —
"Report a vulnerability" on the Security tab. That keeps the report between you
and the maintainer until there is something to publish.

If that page is not available, reach the maintainer directly on GitHub
([@rafafgs](https://github.com/rafafgs)) and say only that you have a security
report to send; the details belong in the private channel, not in the opening
message.

Please do not open a public issue for a suspected vulnerability, and do not
include a working exploit in the first message: the class of problem, the file
or route it lives in, and what an attacker gets are enough to start.

What to expect: an acknowledgement within a few days, and an assessment of
whether the report is a defect or one of the designed properties described
below. This is a small project with one maintainer — there is no bounty and no
guaranteed timeline beyond a reply.

## Supported versions

The `main` branch only. There are no release branches and no backports; a fix
lands on `main` and is published from there.

## What this software is, before what counts as a bug

cartografo runs agent sessions: it hands a command-line coding agent a working
directory, a prompt and a terminal, and records what came back. Several things
that would be defects in ordinary server software are the product here, and
reporting them as vulnerabilities will get the reply "this is documented". They
are listed so an operator can decide with them rather than discover them.

**The agent inherits the operator's whole environment.** `buildEnvironment`
([`packages/runner/src/engine/command.ts`](packages/runner/src/engine/command.ts))
puts the session's overrides on top of the environment the server was started
from and hands the result to the engine process. Every variable in that shell
goes with it, including credentials for unrelated services. Start the control
plane and the runner from a shell scoped to what the work needs.

**Session transcripts are stored unredacted.** The `transcript` column
([`packages/core/src/repositories/session.ts`](packages/core/src/repositories/session.ts))
keeps the engine's output whole, under a byte ceiling, and nothing scrubs it on
the way in. A command that echoed a credential put that credential at rest in
`.cartografo/cartografo.db`. Treat that file the way you treat a shell history
or a CI log.

**The permission policy is best-effort, and `Bash` is where it stops.**
[`packages/runner/src/engine/permission-policy.ts`](packages/runner/src/engine/permission-policy.ts)
says so in its own header, and
[`docs/formats/engine-adapter.md`](docs/formats/engine-adapter.md) writes the
residual gap down under "The session's permissions". A list of allowed tool
names is not process isolation. If you need a boundary, put one around the
whole runner — a container, a VM, a user with its own home — rather than
relying on the policy to hold one.

**A skill imported from elsewhere is a prompt-injection vector**, and the
project treats it as one (D4): a skill is registered pinned by version and
content hash, reviewed at import, and refused if editing its content did not
bump its version. That gate makes the content *stable and attributable*; it
does not make it *safe*. Read a skill before you import it, exactly as you
would read a script before you run it.

**The graph decides what runs.** Whoever can register or apply a graph version
decides which skills execute in your checkout. That is why applying a proposal
is a human decision at a screen and never a model's, and why the MCP server
publishes no tool that approves, applies, reverts or rejects one.

## What is closed, and is a bug if it opens

These are properties the project intends to hold. A report that one of them
does not hold is a vulnerability report.

- **The control plane listens on `127.0.0.1` by default.** Opening the port to
  a network is an explicit operator decision (`CARTOGRAFO_HOST`).
- **Every `/v1/*` route sits behind one credential gate**, registered on the
  whole scope rather than route by route. `/health` is deliberately open: it is
  an infrastructure probe and answers nothing about the data.
- **The database stores only the hash of a credential**, never the credential.
  The bootstrap token is printed once, at first start, and cannot be read back.
- **A runner's credential is its own**, issued when it pairs, and is not the
  operator's token.
- **The screen and the MCP server are unprivileged clients of the public API.**
  Neither touches the database. The screen holds a service credential and asks
  the browser for none, which is why it must stay on loopback: it is not a
  multi-user application, and exposing it exposes its credential.
- **Webhook and hook deliveries are signed**, and the secret lives in the
  database rather than in the graph document.
- **`.mcp.json` carries no token.** It is versioned, and a token written into a
  versioned file is a published token. The MCP server reads its credential from
  the environment and has no `--token` flag for the same reason.
- **An unexpected failure answers `{error, message, request_id}`** and nothing
  else — no stack, no path, no query. The detail stays in the server's log,
  addressable by `request_id`. (A request that fails its contract answers 400
  or 422 and does describe what was wrong with it: that is the caller's own
  input, not the server's interior.)

## Hardening, briefly

- Run the runner as a user that owns only what the work needs, in a container or
  a VM if the work is not yours.
- Point `--working-dir` at a checkout you are willing to lose, and
  `--worktrees-root` at a sibling directory outside it.
- Keep `CARTOGRAFO_HOST` on loopback unless you have put authentication and
  transport security in front of it yourself; the credential gate is not a
  substitute for TLS on a public interface.
- Back up or delete `.cartografo/cartografo.db` deliberately. It holds
  transcripts.
- Review a skill bundle before `cartografo import`, and keep the pins.
