# @cartografo/mcp

The cartografo as **MCP tools**, over stdio — so a model can read the map and
drive it from wherever it is, instead of from a terminal with `curl`.

It is one more client of the public API, with no privilege at all over the
control plane, exactly like [`@cartografo/screen`](../screen/README.md) (D11):
another process, another pipe, no database. Everything it answers came through
`/v1/*`, and what does not exist there it has no way to invent.

## What it is for

Everything here can already be done with `curl` by anybody holding the token.
Four things are different when it goes through this server:

1. **It works away from the terminal.** Any MCP client — Claude Code, an editor,
   a desktop app — can drive the cartografo without a shell.
2. **The credential leaves the transcript.** `CARTOGRAFO_TOKEN=… npx cartografo
   import …` writes the operator's credential into the shell history, and a
   session transcript is stored as the agent printed it
   ([`packages/core/src/repositories/session.ts`](../core/src/repositories/session.ts)).
   This server holds the token in its own process; the model never sees it, and
   no failure it returns carries it.
3. **The arguments have a contract.** `POST /v1/jobs` takes an open body; the
   tools do not. A field this server does not declare is refused before a
   request is made, which turns a typo into an error instead of a silent no-op.
4. **The answers are digested.** One graph version's document is tens of
   kilobytes of JSON Schema. `cartografo_describe_graph` answers with the map —
   nodes, edges, gate verdict — and every long string is clipped with the clip
   declared in the text.

## Running it

The server is meant to be **started by an MCP client**, not by hand. It speaks
JSON-RPC on stdin/stdout, and everything a human reads goes to stderr.

For this repository that is already wired: [`.mcp.json`](../../.mcp.json) at the
root declares it, so a client opened on this checkout finds it with no setup.

```json
{
  "mcpServers": {
    "cartografo": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/mcp/bin/mcp.mjs"],
      "env": {
        "CARTOGRAFO_URL": "${CARTOGRAFO_URL:-http://127.0.0.1:4317}"
      }
    }
  }
}
```

**The credential is not in that file, and it is not an oversight.** `.mcp.json`
is versioned and read by whoever opens the repository; a token written there is
a token published. The server reads it from the environment the client was
started in — `CARTOGRAFO_MCP_TOKEN` first, `CARTOGRAFO_TOKEN` after — so
exporting the one the control plane printed, in the shell you start the client
from, is the whole of the setup. Without it every call comes back refused, in
one line naming the variable to set.

To drive the cartografo from **another** project — which is most of the point —
register it there instead, where the token is your own machine's configuration
and not a file in a repository:

```bash
claude mcp add cartografo \
  -e CARTOGRAFO_URL=http://127.0.0.1:4317 \
  -e CARTOGRAFO_MCP_TOKEN=<the token printed when the control plane started> \
  -- node /absolute/path/to/cartografo/packages/mcp/bin/mcp.mjs
```

The control plane has to be up (`npx cartografo`); this server starts nothing.
When it is down, or when the credential is missing, the tools answer with the
line that says what to do about it.

| Variable | What it decides |
|---|---|
| `CARTOGRAFO_URL` | Control plane to drive. Also `--url`. Default `http://127.0.0.1:4317`. |
| `CARTOGRAFO_PORT` | Its port, when the URL is left at the default host. |
| `CARTOGRAFO_MCP_TOKEN` | This server's credential, checked first. |
| `CARTOGRAFO_TOKEN` | The credential the CLI and the runner share, used when the one above is unset. |

**The credential is deliberately not a flag.** An MCP client starts this command
from a configuration file that lives in a repository and is read by whoever
opens it; a token written there is a token published.

## The tools

Eleven read, five write.

| Tool | Answers |
|---|---|
| `cartografo_status` | Is the control plane up, and what is it holding: classes, runners, executions, counts of jobs, blocked jobs, pending questions and proposals. |
| `cartografo_list_graphs` | The problem classes and every lineage under them, with the version in force. |
| `cartografo_describe_graph` | The map of a version: nodes, edges, initial and final nodes, and the contract gate's verdict. |
| `cartografo_list_skills` | The capability registry — what a node may pin, and the contracts behind it. |
| `cartografo_list_jobs` | The board — where each job stands, whether it is blocked and why. |
| `cartografo_get_job` | One job with its sessions, its open questions and its timeline. The "why is it stuck" tool. |
| `cartografo_list_executions` | The rounds that exist, with their counts. |
| `cartografo_list_sessions` | Which engine ran where, how it ended, what it spent. |
| `cartografo_read_transcript` | What a session printed — the tail by default, with both truncations named. |
| `cartografo_list_input_requests` | The questions waiting on a human, and the answers already given. |
| `cartografo_list_proposals` | What a surveyor proposed, with the lens and the operations. **Reading only.** |
| `cartografo_create_job` | Puts work on the graph, pinned to the version in force. |
| `cartografo_answer_input_request` | Answers a question, which unblocks the job waiting on it. |
| `cartografo_block_job` | Stops a job where it stands, with the reason in the log. |
| `cartografo_unblock_job` | Releases it; it resumes from the same node. |
| `cartografo_register_graph` | Registers a graph document as a new class and its first version. |

## What it will not do, and why

The surface is a decision, not a mapping of the API. Three things are absent on
purpose, and the tests hold their absence:

- **No deciding a proposal.** `approve`, `apply`, `reject` and `revert` are not
  here. Those are the human gate (README, principle 5). A tool that let the same
  model that ran the surveyor approve the surveyor's own proposal would close the
  learning loop with no judge outside it, which is what the loop is for. Read a
  proposal here; decide it at the screen (`/`).
- **No moving a job.** `POST /v1/jobs/:id/transitions` is the runner writing down
  what it actually did. A transition invented from a chat window would leave the
  log saying work happened at a node where none did — and the log is what the
  surveyor reads to propose the next version. Blocking and unblocking *are* here:
  those are operator facts about an operator decision.
- **No starting or stopping anything.** The control plane, the runner and the
  surveyor are long-lived commands an operator brings up ([D21](../../DECISIONS.md)),
  and a request/response tool is the wrong shape for them.

One more boundary worth naming: `cartografo_register_graph` registers a graph,
not a bundle. It does not put skills in the registry, so a node pinned to a skill
the registry does not hold produces a version whose contracts are not `checked` —
which accepts no job, and says so in `describe_graph` and in the refusal of
`create_job`. Importing a factory bundle, with the skill hash pins checked
against local files (D4), stays `npx cartografo import <dir>` at the terminal.

There is no tool that registers a SKILL either, and that one is not a boundary
this package drew — it is arithmetic. A manifest carries its own content hash and
the registry recomputes it before a row exists (D4), so authoring one means
computing a canonical hash over the manifest's own body. A tool that did that
would own a second copy of the canonicalization, and a copy that drifted would
mint pins the registry rejects. Reading the registry is `cartografo_list_skills`;
filling it is the CLI's import, which hashes the files it reads.

## Why the protocol is written out by hand

MCP has an official SDK, and this package does not use it. The surface a tool
server needs is four methods plus `ping`, and all of them have been compatible
across every revision of the spec since 2024-11-05. Against that, the packages
here carry one runtime dependency between them — the tsx loader every
`bin/*.mjs` registers — and `packages/screen` serves HTTP with `node:http` and
no framework for the same reason.

The cost is named rather than hidden: a revision that adds something this server
should speak arrives as work in `src/protocol.ts` instead of as an upgrade.
`SUPPORTED_PROTOCOL_VERSIONS` is where that shows up first.

## Layout

| File | What lives there |
|---|---|
| [`src/client.ts`](src/client.ts) | HTTP client of the public API — the only door to the state. |
| [`src/tools.ts`](src/tools.ts) | The catalogue: what a model may ask, and how the answer is digested. |
| [`src/protocol.ts`](src/protocol.ts) | JSON-RPC over stdio: the handshake, `tools/list`, `tools/call`. |
| [`src/index.ts`](src/index.ts) | Where the control plane is, what credential to present. |
| [`bin/mcp.mjs`](bin/mcp.mjs) | The command, a thin tsx shell. |

## Tests

```bash
npm test --workspace @cartografo/mcp
```

The end-to-end suite spawns the real command against a real control plane and
imports the real factory bundle: what an MCP client starts is `bin/mcp.mjs`, and
the two things most likely to break in that path — the tsx shell, and stdout
staying clean enough to parse — exist only in a real process with real pipes.
