# Specification: the copilot synthesizer, from the declaration to the draft

**API version:** `v1` · **Implementation:** [`packages/runner/src/synthesizer/`](../../packages/runner/src/synthesizer)
**Founding decision:** [D10](../../DECISIONS.md) — "the synthesizer is a copilot in the MVP: it proposes, the human edits, and that edit IS the whole gate"

The whole stack up to here executes graphs somebody wrote by hand. This layer is
the first that **produces** one: it takes a problem in natural language, consults
what already exists in the registry, and hands back a topology in the format of
[`schema/graph.schema.json`](../../schema/graph.schema.json) for a person to
edit.

Two boundaries organize the whole document, and they are better read before any
detail:

- **The synthesizer registers nothing.** It stops at a draft file. What turns a
  draft into a class is `cartografo import` ([t108](../../packages/core/src/cli/import.ts)),
  run by a person after they have edited the file. There is no `POST /v1/graphs`
  in this layer and its client does not even have the method — the same
  discipline that keeps `aplicar` out of the topografo's client.
- **The synthesizer does not name a class.** [D8](../../DECISIONS.md) puts that in
  the user's hands: `--class` is mandatory, and the similar classes the command
  computes are a *suggestion*, printed and embedded in the prompt, with no power
  at all over the name.

Together, that is the safety ladder of [README, principle 5](../../README.md)
applied to the synthesizer: the most autonomous piece of the system is the one
that writes least.

---

## 1. The five parts

| Part | Where | What it does | Deterministic? |
|---|---|---|---|
| Reading client | [`control-plane-client.ts`](../../packages/runner/src/synthesizer/control-plane-client.ts) | The API's three reads. No write. | Yes (it is HTTP). |
| Similarity | [`similarity.ts`](../../packages/runner/src/synthesizer/similarity.ts) | Scores the declaration against the registered classes. | Yes: a pure function. |
| Prompt | [`prompt.ts`](../../packages/runner/src/synthesizer/prompt.ts) | Assembles the session's whole contract. | Yes: a pure function. |
| Fence parser | [`parse-graph-proposal.ts`](../../packages/runner/src/synthesizer/parse-graph-proposal.ts) | Extracts the document from the ` ```grafo-proposto ` block. | Yes: a pure function, never throws. |
| Orchestrator | [`synthesize.ts`](../../packages/runner/src/synthesizer/synthesize.ts) | Refuses, scores, dispatches **one** session, writes the draft. | Everything but the session. |

The entrypoint ([`cli.mjs`](../../packages/runner/src/synthesizer/cli.mjs)) is
wiring and nothing else: the engine, the draft directory, stdout and the exit
code. Every decision — including reading argv — lives in `synthesize.ts`, where a
test reaches it without having to start a process.

---

## 2. The command

```
npm run synthesize --workspace @cartografo/runner -- \
  "<problem declaration>" --class <name> \
  [--url <url>] [--out <path>] [--timeout <seconds>]
```

| Argument | Required | Default | Role |
|---|---|---|---|
| `<declaration>` | yes (positional) | — | The problem in natural language, as the person describes it. |
| `--class` | **yes** | — | The class's name. The one who names is the user (D8). |
| `--url` | no | `http://127.0.0.1:4317` | The control plane. |
| `--out` | no | `<class>.grafo.rascunho.json` in the current directory | Where to write the draft. |
| `--timeout` | no | `900` | The session's clock limit, in seconds. |

The exit codes are the contract, because that is what a person (or a script)
reads:

- **`0`** — a draft was written. The path is the first line of stdout;
- **`1`** — it ran and did not work out: the class is already registered, the
  session died, or there was no valid block. **Nothing was written**;
- **`2`** — the command was typed wrong. Nothing ran.

`1` and `2` are separate on purpose: whoever cannot tell "your command line is
wrong" from "the session failed" cannot decide whether trying again makes sense.

---

## 3. The order of a round

```
GET /v1/classes
        │
        ├─ the class in --class already has a base graph ──▶ exit 1, WITHOUT opening a session
        ▼
for every class with a current version:
  GET /v1/graph-versions/:id  ──▶  similarity(declaration, nome + descricao)
        ▼
top 3 with score > 0  (a non-blocking suggestion: printed and embedded in the prompt)
        ▼
GET /v1/skills   ──▶  the capability catalogue
        ▼
ONE EngineAdapter session, with §5's prompt
        │
        ├─ status != completed, or no valid `grafo-proposto` block
        │  ──▶ exit 1, prints the raw output, writes NO file
        ▼
writes <class>.grafo.rascunho.json  (JSON indented with 2 spaces)
        ▼
prints the path + a one-line summary  ──▶  done. No POST.
```

The order of the first two steps is a decision, not an accident: refusing an
already registered class comes **before** the catalogue and before any session.
Extending an existing lineage is a proposal flow
([D13](../../DECISIONS.md), t118), and finding that out after spending a session
is finding it out late. The error code echoes the API's
(`classe_ja_registrada`, [`routes/graphs.ts`](../../packages/core/src/routes/graphs.ts))
so that the two refusals are obviously the same refusal.

---

## 4. The similarity, and why it decides nothing

The signal is `metadata.nome` + `metadata.descricao` of each class's **current
version**, never the class id on its own: `nota-curta` is two tokens, and two
tokens against a sentence produce a number that says nothing — the heuristic has
a floor of 3 characters per token, precisely so that a preposition does not
score.

The heuristic is the Jaccard of
[t113](../../packages/core/src/domain/similarity.ts), **ported** into the runner
rather than imported. It is the same trade the core already made when
`domain/graph.ts` ported `scripts/validate-graph.mjs`: the runner is an ordinary
client of the API ([D1](../../DECISIONS.md)/[D11](../../DECISIONS.md)), speaks
HTTP and nothing else, and a compile-time dependency on the control plane's
`domain/` would be the first crack in the wall
[`test/no-privileged-access.test.ts`](../../packages/runner/test/no-privileged-access.test.ts)
exists to keep standing.

A copy that can diverge is worse than no copy, so the parity is a **test**, not a
promise: `test/synthesizer/similarity.test.ts` runs the cases of
`packages/core/test/domain-similarity.test.ts` against the port. Changing the
heuristic on one side calls it out on the other.

The cap is 3, mirroring the top of the precedent base. The cut is not about cost:
a list long enough to include a weak resemblance teaches the session that
everything resembles everything — exactly the failure the 3-character floor
avoids one layer down.

A class with no current version, or whose version could not be read, is **skipped
in silence**. This is optional context; bringing the whole command down over one
precedent would be letting the accessory break the essential.

---

## 5. The session: one turn, one block, no privilege

The `SessionSpec` follows the normative rule of the
[EngineAdapter](../formats/engine-adapter.md): `instructions` and `prompt` never
arrive concatenated by the caller.

- **`instructions`** — the role and the hard rules: the `classe` is the user's
  and is literal; `linhagem` is always `{"tipo": "base"}`; every `skill_ref` is
  copied from the catalogue; every node needs an incoming and an outgoing edge;
  every edge has a `condicao`; every `contrato` carries `verificacoes` with at
  least one verification.
- **`prompt`** — the declaration verbatim, the target class, §4's precedents and
  the whole skill catalogue (`id`, `versao`, `hash`, `papel`, `descricao`,
  `entrada`, `saida`, `checks` of each one), plus the output contract.
- **`workingDir`** — a temporary directory. The session receives no control plane
  URL, no credential and no write access to anything else.

The catalogue carries the input contract, the output contract and the checks
because that is what stops composing from being guesswork: with a contract,
assembling a graph is matching contracts
([README, principle 3](../../README.md), [D9](../../DECISIONS.md)).

What does **not** go into the prompt is as deliberate as what does: each skill's
`instrucoes`, `permissoes` and `origem` stay out. The instruction text of an
imported skill is content nobody in this repository wrote — it is the
prompt-injection vector [D4](../../DECISIONS.md) closes by pinning by hash, and
dumping it inside the prompt of whoever is composing would open through the
window the door that decision closed.

The prompt's hardest rule is about `skill_ref`: **copied literally from the
catalogue, never invented**. A pin is what stops a capability from being swapped
in silence underneath an already validated graph (D4), and a hash the model
invented is not a pin — it is a graph that will be failed at `import` after it
has already cost somebody an edit.

### The prompt is the format's only source

`workingDir` is an empty temporary directory: the session **cannot open**
[`schema/graph.schema.json`](../../schema/graph.schema.json). Every rule the
`cartografo import` gate (§7) applies and the prompt does not state is a rule the
session has no way of following — and the bill arrives as `grafo_invalido` after
the person has already edited the draft.

That is how t138 showed up in the alpha round: a draft obeyed every word of the
prompt and still came back with `soundness no_com_contrato`, because
`contrato.verificacoes` has `minItems: 1` in the schema and the prompt said
nothing about it. Two consequences became text:

- **`verificacoes` with at least one verification**, stated in the hard rules and
  repeated in the output contract, naming the soundness rule that fails an empty
  list. It holds just the same for a gate, which is a node like any other.
- **A check from the catalogue is not a `verificacao`.** The two formats diverge
  on `evidencia_obrigatoria`: a list of artifacts in the
  [skill manifest](../../specs/formats/skill-manifest.md), the literal
  `true` in the graph document. Since the catalogue prints each skill's `checks`
  just above, the prompt shows both verification formats in full and says to
  rewrite, not to copy. `prompt.test.ts` validates those examples against the
  real schema, so they cannot diverge from the format they exist to teach.

This is still not validation (§9): the synthesizer does not check the document it
got back. It is only the format stated in full for somebody who cannot read it.

---

## 6. The ` ```grafo-proposto ` fence

The session ends the turn with exactly one fenced block:

````
```grafo-proposto
{ … graph document … }
```
````

The parser is the same algorithm as
[`parse-input-request.ts`](../../packages/runner/src/dispatch/parse-input-request.ts),
with all three rules intact, because they were never about escalation — they are
about reading a fenced JSON value in the middle of a model's prose:

1. **The block's extent comes from the JSON, never from a search for the closing
   fence.** A proposed graph is full of prose written by a model, and prose about
   a graph quotes a fenced graph example; scanning to the next ``` would cut the
   document in half.
2. **A malformed block is ignored, never thrown.** Bad model output does not take
   the command down: the caller gets `null` and §3 turns that into exit 1 with
   the raw output printed.
3. **The last valid block wins.** A session that drafts, corrects itself and
   answers has answered with the last document.

The fence has a name of its own instead of reusing `input-request` for a concrete
reason: both blocks can show up in the same flow — a synthesis session is as free
to escalate as any other — and two contracts sharing one fence name is how a
dispatch ends up reading a question as though it were a graph.

The parser **does not validate** the document. Structure and soundness are the
`cartografo import` gate; duplicating that judgement here would give the person
two verdicts to reconcile, and the ticket's whole point is that the human edit is
the gate.

---

## 7. The draft, and the mandatory manual step

On success the command writes the document indented with 2 spaces — the next
thing that happens to the file is somebody opening it in an editor — and prints
three lines: the path, the summary (a count of nodes, of edges, of similar
classes) and the next command.

The `.grafo.rascunho.json` suffix says out loud what the file is. It does **not
exist** for the control plane: no row in `grafo`, none in `grafo_versao`, no
event. It comes into existence when a person runs

```
cartografo import <file>
```

which is where the structure and soundness gate runs
([`domain/graph.ts`](../../packages/core/src/domain/graph.ts)) and where the base
lineage is born. This ticket wrote no new validation at all: D10's "the human
edits, and that edit is the whole gate" is satisfied entirely by a command that
already existed.

---

## 8. Endpoints

| Method | Route | Role in this layer |
|---|---|---|
| `GET` | `/v1/classes` | Does the class already have a base graph? If it does, the command refuses before any session. |
| `GET` | `/v1/graph-versions/:id` | Each class's current version, where `metadata.nome` and `metadata.descricao` come from for the scoring. |
| `GET` | `/v1/skills` | The catalogue of registered capabilities ([t117](../../packages/core/src/routes/skills.ts)). |

Three routes, **all of them reads**. The contract consumed from `/v1/skills` is
the `{id, versao, hash, papel, descricao, entrada, saida, checks}` subset of the
projection the route returns; if it changes,
[`control-plane-client.ts`](../../packages/runner/src/synthesizer/control-plane-client.ts)
is the only file to adjust.

---

## 9. Out of scope, and why

| Does not do | Why |
|---|---|
| Register or validate the synthesized graph | That is `cartografo import` (t108), unchanged. A second validator would give the same person two verdicts. |
| Forking a variant | It is born of a proposal with evidence (D13, t118), not of synthesis. |
| Importing an external skill | That is D4's gate, with human review and contract derivation. Here the native registry is only read. |
| Session telemetry (`sessao`/`evento`) | There is no `trabalho` and no execution to hang the session on. It arrives when there is a second consumer of the synthesis flow — the rule of two consumers. |
| A multi-turn conversation with the copilot | One session only: resuming is outside `EngineAdapter` v0 ([`engine-adapter.md`](../formats/engine-adapter.md)). Editing the draft is the next turn, and it belongs to the person. |
| A screen | CLI only, like the runner's other commands. |
