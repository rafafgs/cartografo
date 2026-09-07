# Specification: the MCP client in the runner

> t370. What a node declares it needs from outside, fetched before the session
> exists — and the record the control plane keeps of every call.
> RF-31, RF-32, RF-34, and the input half of RF-37.

`packages/mcp` is cartografo **as a server**. This document is about the
opposite direction: the runner as a **client** of MCP servers that live on the
machine it runs on. The two halves share a wire format and no code.

---

## 1. The claim

A node may declare what it needs from outside:

```json
{
  "id": "collect-fundamentals",
  "external": {
    "inputs": [
      {
        "name": "report",
        "server": "reports",
        "tool": "read_file",
        "arguments": { "path": "notes/{{input.thesis.slug}}.md" },
        "as": "external/report.md"
      }
    ]
  }
}
```

Before the session opens, the runner calls `reports.read_file` and writes what
comes back to `<worktree>/external/report.md`. The session finds a **file**. It
never sees the server, the transport, or the credential that reached it — and
it does not need network permission to have it, because every call finished
before `startSession` was reached.

The node's own input gains one drawer:

```json
"external": {
  "report": { "path": "external/report.md", "size": 1240, "sha256": "a1b2…" }
}
```

which a manifest reads with the interpolation it already has:
`{{input.external.report.path}}`.

`input.external` is `{}` for a node that declares nothing — which is every
graph written before the field existed, and which keeps
`{{input.external.anything}}` failing closed rather than rendering `undefined`.

---

## 2. Resolving a server: two capabilities, two questions

Discovery (t400, `EngineAdapter.discoverMcpServers?()`) answers **which servers
this machine's engine names**, and `McpServerRef` is `{name}` and nothing else:
`claude mcp list` has no machine-readable mode, so the format promises only what
every source can agree on.

That leaves the second question unanswered, so t370 adds a second, symmetric,
optional capability:

```ts
export type McpServerConnection =
  | { transport: 'stdio'; command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
  | { transport: 'http'; url: string; headers?: Readonly<Record<string, string>> };

// on EngineAdapter, optional on the METHOD:
resolveMcpServerConnection?(name: string): Promise<McpServerConnection | null>;
```

Optional on the method and not merely on its fields, for `listModels`'s and
`discoverMcpServers`'s compatibility reason: a third-party adapter written
before this existed keeps compiling. A caller checks
`typeof adapter.resolveMcpServerConnection === 'function'` first.

The two are **not merged**. They answer different questions, and folding the
connection into `McpDiscovery` would widen a frozen, carefully narrow format for
a reason that applies to exactly one caller.

| Adapter | Sources | Shape |
|---|---|---|
| `claude-code` | the project's `.mcp.json` first, then `~/.claude.json`'s `mcpServers` | `type: 'http'`/`'sse'`, or a bare `url`, selects http; everything else is stdio, with `args`/`env` defaulting to `[]`/`{}` |
| `codex` | `$CODEX_HOME/config.toml`'s `[mcp_servers.<name>]` plus `[mcp_servers.<name>.env]` | always stdio; a table with no `command` is `null`, never a half connection |

Project scope wins over user scope, which is precedence rather than
presentation: `.mcp.json` travels with the repository the session runs against.
(The discovery merge reads the two in the other order, and that is not a
contradiction — it produces a LIST, where order is presentation.)

Neither adapter parses the CLI's output for this. `claude mcp list` prints the
transport inside a human sentence nobody versions, and parsing a command line
out of prose in order to then **spawn** it is not a risk this takes. The CLI's
own approval rules still apply, one step earlier: the discovery gate refuses a
server the listing does not carry.

### Environment placeholders

Real configuration files carry `${VAR}` and `${VAR:-default}` — this
repository's own `.mcp.json` writes
`"CARTOGRAFO_URL": "${CARTOGRAFO_URL:-http://127.0.0.1:4317}"`. Both forms are
expanded against the **runner's own** environment, which is where the credential
lives (RNF-12, RNF-13).

**A referenced variable that is unset and names no default is a resolution
failure**, not an empty string. It is the fail-closed rule
`{{input.<path>}}` already runs under, applied where it matters most: a wrong
credential can succeed against something else, and none fails loudly.

---

## 3. The client: three methods and a notification, no SDK

`packages/runner/src/mcp/client.ts`

| Method | Wire |
|---|---|
| `initialize()` | `initialize`, then the `notifications/initialized` the spec requires |
| `listTools()` | `tools/list` |
| `callTool(name, args, timeoutMs)` | `tools/call`, returning `{content, isError?}` verbatim |
| `close()` | ends the transport; safe twice, and on one that never opened |

Written out rather than imported, for the argument
`packages/mcp/src/protocol.ts` already makes from the other side: this is the
whole usable subset, it has been compatible across every revision since
2024-11-05, and the runner declares no runtime dependency (D17). An SDK would
add a supply chain — reviewed at no gate, pinned by no hash — to save a few
hundred lines the tests pin anyway. The cost is named: a future revision this
client should speak arrives as work here rather than as an upgrade.

Two transports, and nothing above them knows which one it holds:

- **stdio** (`transport-stdio.ts`) — spawns `command`/`args` with
  `env: {...process.env, ...connection.env}`, so declared keys override the
  inherited environment and `PATH` still resolves a `"command": "npx"`.
  Line-delimited JSON-RPC, one object per line. The process opens **lazily**, so
  a resolution that refuses before the call never spawns anything, and a child
  that dies with messages in flight rejects them all — a promise nobody will
  settle is the failure mode this exists to avoid.
- **http** (`transport-http.ts`) — one `POST` per message, expecting a single
  JSON body back. **No SSE and no streaming** (Out of Scope): reading an event
  stream is a state machine with a reconnection story of its own, and nothing
  here needs one.

`isError: true` is a **result**, not a protocol error, and the client passes it
through: the caller is what can act on the message inside it.

---

## 4. Resolution, in order

`packages/runner/src/mcp/resolve-external-inputs.ts`, per entry, in declared
order:

1. **the discovery gate** — a server this machine's engine does not name is not
   callable, whatever a file on disk says. That includes one merely declared and
   still pending approval, since discovery applies each CLI's own rules. An
   adapter with no discovery at all is not an engine with zero servers, and
   neither of those makes a server callable;
2. **the connection** — `resolveMcpServerConnection`, including the environment
   expansion above;
3. **the arguments** — `interpolate()` from `interpolate-input.ts`, verbatim,
   over each string value. Before any client is built, which is what keeps a
   placeholder that does not resolve from ever spawning a server;
4. **the client** — one per distinct `server` name per dispatch, `initialize`d
   once, reused, and closed at the end of the resolution on every path;
5. **the call** — `tools/list` first (a tool that is not published is a
   different fact from a call that failed), then
   `callTool(tool, args, callTimeoutMs)`;
6. **the bytes** — the FIRST entry of `result.content`: `type: 'text'` as UTF-8,
   or `type: 'resource'` with a base64 `blob` (decoded) or its own `text`.
   Anything else is "the tool returned no usable content";
7. **the accumulation** — `{path, size, sha256}` into `input.external.<name>`,
   and the bytes into `pendingWrites`.

### Why the write is not here

The whole resolution runs in the **pre-worktree** window, beside the other seven
pre-session reads and for their reason: everything that fails there fails with
no directory cut, no session row, no engine process and no token spent. But
`input.external.<name>` has to exist before `renderSkillInstructions`
interpolates it — which puts the resolution *before* `worktrees.acquire`, where
there is no `workingDir` yet.

So the work is split at exactly that seam. The **network** call and its
classification happen in `resolve-session-plan.ts`; the **disk** write of the
already-fetched bytes happens in `dispatch.ts` the moment the tree exists and
before `buildSessionSpec`. `writeExternalInput` asserts the target stays under
`path.resolve(workingDir)` — defense in depth, given that t369's schema already
refuses `as: "../x"` at registration, and the same posture `local-store.ts`
takes about an input that "only ever originates from this module's own" trusted
source.

A failure of the write is an **ordinary throw**, not a ninth classified cause:
the network call was classified long ago, and a write into a directory created
one line earlier failing at all is the same unclassified,
`pre-session-retry.ts`-bounded territory `worktrees.acquire` is in.

### The size cap

`10 MiB`, a fixed module constant with no flag and no environment variable (Out
of Scope). An MCP server is a third party the operator approved on their engine,
not a component of this system, and an unbounded read is a runner one answer
away from its own memory. Checked **before** anything is written and before the
bytes are held any longer than the check needs. Raising it later is additive.

---

## 5. The five reasons

`ExternalInputResolutionError` carries `{nodeId, inputName, server, tool,
reason, detail}` and becomes the **eighth** classified pre-session cause
(`pre-session-failure.ts`, `runner-and-controller.md` §4). The job is blocked
with a reason a person reads; nothing here ever creates an `input_request`,
because no session ever opened.

(The field is `inputName` and not `name` for one reason: a class extending
`Error` cannot shadow `Error.name` without making one stack trace in ten
thousand unreadable. The constructor still takes `name`, so call sites read as
the format writes it.)

| `reason` | What happened | Example |
|---|---|---|
| `unknown_server` | the entry names a server this machine's engine does not list — or the adapter cannot answer at all | a node declaring `server: "reports"` dispatched on a runner where nobody approved it |
| `call_error` | the connection could not be read, the tool refused, the content was unusable, or the result was over the cap | `${REPORTS_TOKEN}` unset with no default; `isError: true`; an empty `content`; 12 MiB of answer |
| `tool_not_found` | the server is there and publishes no tool of that name | `tool: "read_the_future"` against a server that publishes `read_file` |
| `timeout` | the server accepted the message and said nothing inside `mcpCallTimeoutMs` | a server that hung on `tools/call` |
| `unresolved_argument` | an argument names input this dispatch does not carry | `{{input.thesis.slug}}` with no `thesis.slug` in the projection |

`call_error` and `tool_not_found` are deliberately two: the first is fixed at the
server or in the call, the second by editing the graph. The same
two-reasons-are-different-facts discipline `pre-session-failure.ts` already
applies to `SkillNotRegisteredError` and a control-plane 5xx.

---

## 6. The record

`POST /v1/jobs/:id/external-calls` — **one** route, two phases, told apart by
the body:

| Body | Answer |
|---|---|
| no `call_id`: `{node_id, direction?, name, server, tool, arguments_sha256, arguments_summary?, started_at}` | `201 {external_call}` with `finished_at`, `outcome` and `result_summary` all `null` |
| `{call_id, finished_at, outcome, result_summary?}` | `200 {external_call}`, completed |
| a `call_id` of another job, or of nothing | `404 not_found` |
| a `call_id` that already has an outcome | `409 external_call_already_completed` |
| a missing or malformed field | `400 invalid_body`, with `field` |

`GET /v1/jobs/:id/external-calls` lists them, scoped with `requireProject` like
the job family's other reads. It is **operator-only by omission**: this dispatch
never reads its own call history back, and t371 is the first runner-side reader
— it adds its own allowlist line the day it needs one, on the one-route-at-a-time
discipline t166 and t401 already set. The `POST` **is** in `RUNNER_SURFACE`, as
one line for both phases.

Both summaries are truncated to **1 KiB by the server**, never on the caller's
word that it already capped: RF-37 asks for a summary, and a column that could
hold a whole result would eventually hold a credential somebody passed as an
argument.

`direction` carries `'input'` and `'output'` from the first migration. This
ticket only ever writes `'input'`; having the value in the `CHECK` now spares
t371 a migration whose only content would be widening a constraint.

### "Unknown" is read, never written

There is no `outcome: 'unknown'`. A row whose `finished_at` and `outcome` are
still `NULL` well after `started_at` is a call whose fate nobody recorded — a
runner that died mid-call, a process somebody killed — and "unknown" is what a
**reader** concludes. Storing it would mean the crash had had the presence of
mind to write something down, which is exactly what a crash does not do.

The row is updated once rather than duplicated. Append-only here means
`lease`'s sense — never deleted — and not the stricter sense no table of this
schema has ever meant.

---

## 7. What the session sees

Nothing about the server's name, its `command`/`args`/`env`/`url`, or the
credential inside that `env` is written into `instructions`, the `prompt`,
`envOverrides`, or any file under the worktree other than the ones the declared
`external.inputs` produce (RF-34).

Permissions are built exactly as they were: a skill declaring
`network.allowed: false` still runs network-closed, and still gets its file —
because every MCP call happened and finished before `startSession` was reached.

---

## 8. Out of scope

- writing a node's **output** back to a server, idempotency, `unsafe_to_retry` —
  t371;
- any curated catalogue of servers, and any OAuth flow a server needs: the
  server is configured and authorised by a person, on their engine, before this
  runs;
- resources and prompts of the MCP spec beyond `tools/call`; streaming results;
- a CLI flag for `mcpCallTimeoutMs`, and a configurable size cap.
