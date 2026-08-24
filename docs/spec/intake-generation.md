# Specification: generating the intake draft, from the request to the proposed breakdown

**API version:** `v1` · **Implementation:** [`packages/runner/src/intake/`](../../packages/runner/src/intake)
**Layer consumed:** [`docs/spec/intake.md`](./intake.md) (t122) — this ticket adds
no route, no column and no migration; it is the first client that **produces**
`items`

[t122](./intake.md) delivered intake in two phases: `POST /v1/intake` proposes a
draft from an already decomposed list of `items`, and
`POST /v1/intake/:id/confirmations` is the human gate that turns the draft into
`trabalho`. §8 of that specification named exactly what was missing — *generating
the draft from the request in natural language* — and said that whoever writes
`items` was a future ticket's decision. This is the future ticket.

One sentence sums up the design: **the session decomposes, the command writes the
draft, and the human is still the one who confirms.** Nothing here creates a
ticket.

---

## 1. The four parts

| Part | Where | What it does | Deterministic? |
|---|---|---|---|
| Prompt | [`prompt.ts`](../../packages/runner/src/intake/prompt.ts) | Assembles the session's whole contract: the role, the hard rules, the item's format. | Yes: a pure function. |
| Orchestrator | [`generate.ts`](../../packages/runner/src/intake/generate.ts) | Refuses an unknown class, dispatches **one** session, reads the file, writes the draft. | Everything but the session. |
| Command line | [`command-line.ts`](../../packages/runner/src/intake/command-line.ts) | argv, the environment, the credential, the two ports and the refusal message. | Yes. |
| Entrypoint | [`cli.mjs`](../../packages/runner/src/intake/cli.mjs) | The engine, the draft directory, stdout and the exit code. | — |

The split is the topografo's (t146) and the synthesizer's, for the reason
`synthesize.ts` records: **what a test reaches without starting a process is what
stays covered.** That is why reading argv does not live in the `.mjs`.

---

## 2. The command

```
npm run intake --workspace @cartografo/runner -- \
  "<request>" --class <name> \
  [--url <url>] [--dir <path>] [--token <token>]
```

| Argument | Required | Default | Role |
|---|---|---|---|
| `<request>` | yes (positional) | — | The request in natural language, as the person describes it. |
| `--class` | **yes** | — | The **already registered** class whose graph the tickets will cross. |
| `--url` | no | `http://127.0.0.1:4317` | The control plane. |
| `--dir` | no | a temporary directory | Where the session runs and writes its answer. |
| `--token` | no | `CARTOGRAFO_TOKEN` from the environment | The control plane credential. |

The credential's precedence is `--token` > `CARTOGRAFO_TOKEN` > none, the same as
[`packages/core/src/cli/url.ts`](../../packages/core/src/cli/url.ts), the cost
topografo, the flow topografo and the synthesizer. With no credential at all the
client sends no header and takes a `401` — an empty header would look like a
credential. This has been here since the first commit because of
[t146](./topografo-flow.md): the topografo was born with no token flag and was
entirely unusable until it got one.

The exit codes are the contract, because that is what a person (or a script)
reads:

- **`0`** — a draft was proposed. The id is the first line of stdout;
- **`1`** — it ran and did not work out: the class is not registered, the session
  died, the file is unusable, or the control plane refused the write. **Nothing
  was written**;
- **`2`** — the command was typed wrong. Nothing ran.

`1` and `2` are separate on purpose, as in the synthesizer: whoever cannot tell
"your command line is wrong" from "the session failed" cannot decide whether
trying again makes sense.

---

## 3. The order of a round

```
GET /v1/classes
        │
        ├─ the class in --class is NOT registered ──▶ exit 1, WITHOUT opening a session
        ▼
ONE EngineAdapter session, with §5's prompt
        │
        ├─ status != completed
        ├─ intake-proposto.json absent, or not JSON
        ├─ no `items`, or `items` empty
        │  ──▶ exit 1, NO POST /v1/intake
        ▼
POST /v1/intake  {class, request, items}
        │
        ├─ 404 unknown_graph · 400 invalid_items ──▶ exit 1
        ▼
201 {rascunho} — status `pendente`, no event, no ticket
        ▼
prints the id  ──▶  done. Confirming is the human's.
```

The first step is a decision, not an accident: refusing an unknown class comes
**before** any session, mirroring the order the synthesizer applies to its own
pre-check. Finding a typo in `--class` after spending a whole session is finding
it late. The error code echoes the API's
(`grafo_desconhecido`, [`routes/intake.ts`](../../packages/core/src/routes/intake.ts))
so that the two refusals are obviously the same refusal.

The engine's probe (`verifyCli`) runs **lazily**, on the first session, and not at
the command's entrance. Probing first would make the class refusal depend on
having the CLI installed, which would trade an exact message for a generic one in
exactly the most common case.

---

## 4. Why this command writes, and the synthesizer does not

The repository already had two precedents for "an agent session between a request
and a write to the control plane", and they decided differently **on purpose**:

| Ticket | What the session produces | Who writes | Why |
|---|---|---|---|
| Synthesizer ([t115](./synthesizer.md), [D10](../../DECISIONS.md)) | A local draft file | A person, running `cartografo import` | Registering a graph has no undo at the API level: **the import IS the gate**. |
| Topografo ([t110](./topografo-flow.md)) | The operations of a semantic diff | The command itself, in `POST /v1/proposals` | A proposal is born `pendente` and nobody applies it: the safety ladder is the **absence** of an `apply` method in the client. |

Intake follows the topografo, and the reason is t122's own design: the draft is
born `pendente`, is freely editable by `PATCH`, discardable by `/discards`,
**emits no event at all**, and only becomes work at `/confirmations`
([§1](./intake.md)). The human gate is already there. Stopping at a file for
somebody to submit by hand would not add a second gate — it would duplicate the
first.

The consequence in the HTTP client is literal: it gained `criarIntake` and
nothing else. There is no `confirmarIntake`, `emendarIntake` or `descartarIntake`
in
[`cliente-controle.ts`](../../packages/runner/src/controller/cliente-controle.ts),
for the same reason `aplicar` never went in: **a client that does not have the
method does not take the decision by mistake.**

---

## 5. The session: one turn, one file, no privilege

The `SessionSpec` follows the normative rule of the
[EngineAdapter](../formatos/engine-adapter.md): `instructions` and `prompt` never
arrive concatenated by the caller.

- **`instructions`** — the role and the item's hard rules, listed in §6.
- **`prompt`** — the request **verbatim**, the target class, and the output
  contract repeated. The request is not summarized on the way in: `pedido` is
  written down beside the batch, and whoever refines later reads the original,
  not a paraphrase.
- **`workingDir`** — a temporary directory. The session receives no control plane
  URL, no credential and no write access to anything else. The only `POST` in
  this ticket is the orchestrator's.

### The output contract is a file, not a fenced block

The session writes `intake-proposto.json` in the current directory, with exactly:

```json
{"items": [ ... ]}
```

A file and not a ` ```fenced``` ` block on stdout, and this is the scar of
[t148](./synthesizer.md): the output of a real CLI is a stream of `stream-json`
frames, one per line, so the block's quotes arrive as `\"` and its breaks as `\n`
— and the fence scanner matches neither. It cost the synthesizer a whole round of
real executions with every fake-engine test green. Nothing here needs to watch
the output as it flows, so the contract that survives is the one the session
fulfils with **one write**.

It is the same choice as `proposta-topografo.json`
([`surveyor/proposal.ts`](../../packages/runner/src/surveyor/proposal.ts)), for
the same reason.

---

## 6. What the prompt teaches, and why it has to teach everything

`workingDir` is an empty temporary directory: the session **cannot open**
[`domain/intake.ts`](../../packages/core/src/domain/intake.ts). Every rule
`validateItems` applies and the prompt does not state is a rule the session has
no way of following — and the bill arrives as an `invalid_items` nobody asked
for. It is t138's lesson, one floor up.

So the prompt says, in full:

| Rule | The code that fails it |
|---|---|
| `ref` and `title` are required | `missing_required_field` |
| `ref` is an identity **local to the batch**, never a real id | — (it dies at confirmation) |
| two items never use the same `ref` | `duplicate_ref` |
| `depends_on` cites only a `ref` of this batch | `unknown_dependency` |
| no item depends on itself | `self_dependency` |
| the dependencies close no cycle (a diamond is fine) | `dependency_cycle` |
| `acceptance_criteria` only when there really is a criterion | — |
| `tier` only `"trivial"` or `"standard"`, and omitting it is allowed | `invalid_field` |

The second to last is the one that misleads most and is therefore said with
emphasis: **`null` is not `[]`**
([`domain/intake.ts:34-43`](../../packages/core/src/domain/intake.ts)). "Nobody
has written a criterion yet" and "I declare there is no criterion" are different
statements, and the node that refines is precisely the one that needs to tell
them apart. An empty list passes validation and lies to the rest of the graph —
the worst kind of error, because it does not show.

The last one arrived with t175 and is the reason the triage is **free**: this
session is already reading the request and proposing the breakdown, so asking it
to classify each item as well costs no new session, no new call and no new model.
The prompt teaches both values and where the line sits — `trivial` for a rename,
a typo, a documentation-only change, a configuration tweak with no design
decision inside; `standard` for everything else, and `standard` when in doubt.
Omitting it is still valid and means "nobody classified this", which is **not**
`trivial`: whoever omits leaves the decision open, whoever writes `trivial`
asserts the item is small, and it is that assertion that makes the runner run
that node on a cheaper model.

---

## 7. What this command does NOT validate

`generate.ts` does not mirror `validateItems`. It is a deliberate difference from
the topografo, which does mirror `validateOperation` on the runner's side:

- a bad `POST /v1/proposals` is expensive to have made — which is why the
  topografo checks the shape before spending the write;
- a bad `POST /v1/intake` is **cheap and reversible**: the draft is discarded, no
  ticket was born, no event was emitted. And the server already returns the whole
  report (`invalid_items` with every problem, never just the first).

Duplicating that judgement here would be a second copy that can diverge from the
first, and the person would be left with two verdicts to reconcile.

---

## 8. Endpoints

| Method | Route | Role in this layer |
|---|---|---|
| `GET` | `/v1/classes` | Is the class registered? If it is not, the command refuses before any session. |
| `POST` | `/v1/intake` | The only write. Returns `201 {rascunho}`, always `pendente`. |

One read and one write. `/confirmations`, `/discards` and `PATCH` exist
([§6 of t122](./intake.md)) and are **not** called from here.

---

## 9. Out of scope, and why

| Does not do | Why |
|---|---|
| Confirm, amend or discard the draft | That is t122's human gate, intact. The client does not even have the methods. |
| Revalidate `items` on the runner's side | §7. |
| `--projeto-id` / `--execucao-id` | The route has a default for both (`DEFAULT_PROJECT`); the flag arrives the day somebody needs it. |
| Join the traversal or the runner's dispatch loop | Manual and one-shot, like `synthesize` and the topografo (README, principle 5). |
| A multi-turn conversation to refine the batch | One session only: resuming is outside `EngineAdapter` v0. Editing afterwards is `PATCH /v1/intake/:id`, which already exists. |
| Suggest the class by resemblance | [D8](../../DECISIONS.md) puts the name in the user's hands, and the class here has to exist already. |
| A screen | CLI only, like the runner's other commands. |
