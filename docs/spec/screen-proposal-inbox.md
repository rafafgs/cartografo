# Specification: the proposal inbox on the screen

**Package:** [`packages/tela`](../../packages/tela) · **Port:** `4318`
**Founding decisions:** [D11](../../DECISIONS.md) — "the screen is a client of
the public API" · [D1](../../DECISIONS.md) — "only the server writes to the
database" · principle 5 of the [README](../../README.md) — "the safety ladder"

The screen is the human half of the safety ladder. The topografo (`t110`) writes
hypotheses about the graph; the soundness gate fails the ones that would break
the execution; what is left needs somebody to look at the evidence, read the diff
and decide. This document specifies that inbox: what it shows, which decisions it
offers, and how it reaches the control plane without gaining any privilege over
it.

One sentence sums up the boundary: **the screen knows nothing the public API does
not tell it**. No import of `packages/core`, no SQLite driver in the manifest, no
private route — the same surface any other client would have, and a static gate
(`packages/tela/test/no-privileged-access.test.ts`,
[`scripts/check-single-writer.mjs`](../../scripts/check-single-writer.mjs)) that
fails the opposite.

---

## 1. The same-origin pattern

The browser cannot talk straight to the control plane: the core does not install
`@fastify/cors`, and opening CORS on the system's only writer (D1) is a far
bigger decision than "the screen needs data". So the screen gets an HTTP server
of its own, with two jobs:

| Path | What happens |
|---|---|
| `/v1/*` | A **verbatim** proxy to `CARTOGRAFO_URL` — method, path, query, body and headers cross unchanged, and the status comes back as it came. |
| Anything else | A static file from `packages/tela/src/public/` (`/` serves `index.html`). |

The browser talks only to the origin the page came from; the screen is still one
more HTTP client of the public API. Nothing on the core's boundary changes.

**Verbatim is literal, and for a reason.** `409 proposta_nao_pendente` and
`422 invalid_graph` are **answers** the inbox needs to show, not errors the proxy
may rewrite into "something went wrong". The only answer the proxy invents is the
one for a control plane that is down:

```json
{ "error": "control_plane_indisponivel", "message": "não deu para falar com o control plane em http://127.0.0.1:4317 — rode `npx cartografo` primeiro (ou aponte outro endereço com CARTOGRAFO_URL)" }
```

`502`, with the same `error` / `message` pair every error response of the core
uses (§6 of [`entities-versioning.md`](entities-versioning.md)) — the page has
one way of showing a failure instead of two. The cause (`ECONNREFUSED`, a stack
trace) is discarded on purpose: for whoever is looking at the inbox, what is
actionable is the address that did not answer and the command that brings the
server up.

Three headers do not cross, because they describe the hop that ends here: `host`,
`connection` and company, plus `content-length` and `accept-encoding` — `fetch`
recomputes the first and decodes the second, and passing them along is how a
proxy ends up announcing a length or an encoding that does not match the bytes it
is sending. On the way back, only `content-type` is passed along.

No server framework and no client framework: `node:http` on one side, HTML and
native ES modules on the other, with no bundler and no build step — the same
minimalism as the rest of the repository (a new dependency only where it cannot
be avoided).

### Configuration

| Variable | Default | What for |
|---|---|---|
| `CARTOGRAFO_TELA_PORT` | `4318` | The screen's port (the control plane's, plus one). |
| `CARTOGRAFO_URL` | `http://127.0.0.1:4317` | The control plane `/v1/*` goes to. |
| `CARTOGRAFO_PORT` | `4317` | The control plane's port in the default above. |

The same precedence as
[`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts):
`CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT` > default. The resolution is
**duplicated** in `packages/tela/src/proxy.ts`, not imported: the screen declares
no dependency on the core package, and that is precisely the boundary D11 asks
for. Duplicated and pinned by a test, like the graph validator of
[`scripts/validar-grafo.mjs`](../../scripts/validar-grafo.mjs).

It listens on `127.0.0.1`, and it stays there after `t124`: the screen does not
ask the browser for a credential — it CARRIES its own (`CARTOGRAFO_TELA_TOKEN`,
with `CARTOGRAFO_TOKEN` as a fallback) and presents it to the control plane on
every call, including the ones the proxy passes along. Whoever exposes the screen
on an external interface is deciding to open the system's only writer to whoever
reaches the port.

To bring it up: `npm start --workspace @cartografo/tela`. It prints a readiness
line on stdout, in the spirit of `cartografo.ready`:

```json
{"event":"cartografo.tela.ready","url":"http://127.0.0.1:4318","controlPlane":"http://127.0.0.1:4317"}
```

---

## 2. The control plane contract this screen assumes (`t111`)

The screen **creates no route at all** in `packages/core`. It consumes six
endpoints, and since `t165` all six exist. Whoever touches the core side checks
against this section.

| Method | Route | State | What the screen uses |
|---|---|---|---|
| `GET` | `/v1/proposals` | exists | The list for both sections. Ideally filterable by `?status=`; today the screen asks for everything and splits on the client. |
| `GET` | `/v1/proposals/:id` | exists (`t165`) | The detail: `operacoes`, `evidencia`, `metrica_esperada`, `resultado`, `motivo_reversao`, `motivo_rejeicao`. |
| `POST` | `/v1/proposals/:id/approve` | exists (`t165`) | `pendente` → `aprovada`. No body. |
| `POST` | `/v1/proposals/:id/reject` | exists (`t165`) | `{motivo}` required → `rejeitada`, written into `motivo_rejeicao`. |
| `POST` | `/v1/proposals/:id/apply` | exists | Runs the flow of §5 of `entities-versioning.md`. Demands `aprovada`. |
| `POST` | `/v1/proposals/:id/revert` | exists | `{motivo}` required; moves the pointer back. |

The paths are those of the English `/v1` surface (D18, renamed by `t127`); the
**keys** of the bodies (`propostas`, `proposta`, `motivo`, `grafo_versao`) and
the status vocabulary (`pendente`, `aprovada`, …) are still Portuguese, which is
what D18 deliberately left out. Pinned against the real client in
`packages/tela/test/inbox-spec-routes.test.ts`.

The response envelope the screen expects — and how it protects itself from being
wrong about it:

- the list: `{propostas: [...]}` (a bare array is accepted too);
- the detail and the actions: `{proposta: {...}}` (a bare proposal is accepted
  too), plus `{grafo_versao: {id}}` on `apply`, which is what the row starts
  showing;
- an error: `{error, message}`, on any non-2xx status.

**The incompatibility `t165` settled.** Until it landed,
[`routes/proposals.ts`](../../packages/core/src/routes/proposals.ts) demanded
`status === 'pendente'` in order to apply and the `aprovada` state did not even
exist in the migration's `CHECK` — so the Apply button, which this screen only
shows on `aprovada`, appeared in an unreachable state and the inbox was useless
for the very decision it exists to take. Today both sides speak the same
vocabulary: `aprovar` leads to `aprovada`, `aplicar` demands `aprovada` and
refuses anything else with `409 proposta_nao_aprovada` — which the screen shows
inline, without breaking. The whole cycle (`pendente` → `aprovada` → `aplicada` →
outcome → `revertida`) has already been walked by this screen over real
telemetry.

---

## 3. The two sections, and state → actions

The list comes out in two sections: **Pending** (`pendente`, `aprovada` — what is
waiting on a human decision) and **History** (`aplicada`, `revertida`,
`rejeitada`). A rejected proposal does not disappear: it is negative knowledge
for the topografo
([`notas/2026-08-14-learning.md`](../../notas/2026-08-14-learning.md)), and
its place is the history, read-only.

Every proposal offers exactly the actions valid for the status it is in:

| Status | Actions | Reason required? |
|---|---|---|
| `pendente` | Approve, Reject | only Reject |
| `aprovada` | Apply | no |
| `aplicada` | Revert | yes |
| `revertida`, `rejeitada` | — (read-only) | — |
| anything else | — (read-only) | — |

The last row is the one that matters most: the core owns the status vocabulary
and will grow it (`t112` writes `resultado`). An unknown status **fails safe** —
it becomes read-only, never an exception in the middle of rendering. A button
that shows up and comes back `409` teaches a person to distrust the screen, which
is worse than one button fewer.

Where the reason is required, the field appears with its question in a visible
`<label>`, tied to the input by `for`/`id`
(`Por que esta hipótese não vale a pena?`,
`Por que a versão aplicada está sendo abandonada?`). Not a placeholder: a
placeholder is a hint, it disappears on the first character typed and it is not a
reliable accessible name — and this is precisely the page's field that asks for a
written justification. Pinned in
`packages/tela/test/inbox-reason-field.test.ts`, which resolves the name the way
a screen reader would.

The rule lives in a pure function, `resolveActionsForStatus`
([`src/public/actions.js`](../../packages/tela/src/public/actions.js)), tested in
Node even though it runs in the browser.

After a successful action **only that row changes** — the new status and, on
`aplicar`, the returned `grafo_versao`. No page reload. An unsuccessful action
shows `error: message` on the row itself; the whole list only reloads on the
"Refresh" button (there is no polling and no websocket at this stage).

---

## 4. The diff in prose

D15 chose a **semantic** diff rather than a line diff precisely so that a
proposal could be **judged** ("it adds a red-team gate before deployment")
instead of merely approved without being understood. Dumping the operation's JSON
onto the page would throw that away. One readable line per operation, in the
vocabulary of §3 of
[`entities-versioning.md`](entities-versioning.md):

| Operation | Line |
|---|---|
| `add_node` | `+ nó "red_team" (tipo portao)` |
| `remove_node` | `- nó "revisar_manual"` |
| `add_edge` | `+ aresta testar → red_team (condição: aprovado)` |
| `remove_edge` | `- aresta testar → implantar` |
| `change_node_field` | `~ nó "implementar": campo "papel" de "fazer" para "conferir"` |
| an unknown type | `? operação de tipo desconhecido ("mover_no")` |
| a malformed entry | `? operação malformada` |
| an empty or absent `operacoes` | `nenhuma alteração` |

An object value (a whole `contrato` in a `change_node_field`) comes out as
compact JSON truncated at 60 characters: it is the **value** that changes, not
the operation, and hiding it would make `change_node_field` impossible to judge.

The type's name is what the operation carries on the wire (English,
`glossario-wire.md` §3); the rendered line is still in Portuguese, word for word.
What moved was the key, not the text a person reads before approving.

Nothing here throws. The operations come from a topografo this screen has never
seen, and a strange line is a bad render — an exception is the whole page blank.
Implementation and format pinned in
[`src/public/diff.js`](../../packages/tela/src/public/diff.js) and
`packages/tela/test/diff.test.ts`.

---

## 5. What this screen does not do yet

Every item is another ticket's declared scope, not an oversight:

- **The observability screen** (executions, sessions, the event log) — the other
  half of D11's content.
- **Preventing a rejected proposal from being proposed again** — the topografo's
  behaviour (`t110`); here the history is read-only.
- **Logging in from the browser, and per-route authorization.** `t124`
  authenticated the control plane and the screen passes its own credential along;
  what is left out is asking the browser for a credential and cutting down what
  each credential reaches.
- **Pagination or virtualization** of the list — acceptable at the PoC's scale.
- **Real-time updates** (websocket, polling) — the list moves when the user acts.
- **Variant lineages** (D13) — the screen shows the `grafo_id` the proposal
  carries, with no special treatment (`t118`).
