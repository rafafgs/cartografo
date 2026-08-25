# Specification: the graph configuration screen

**Package:** [`packages/screen`](../../packages/screen) · **Port:** `4318` ·
**Page:** `/graph-editor.html`
**Founding decisions:** [D11](../../DECISIONS.md) — "the screen is a client of
the public API, with no privileges" · [D15](../../DECISIONS.md) — "a semantic
diff, an operation with its inverse, append-only versioning" · principle 5 of the
[README](../../README.md) — "the safety ladder"

D11 fixed the order: observability first, the inbox next, graph editing last. The
first two arrived (`t107`, `t111`); this is the third. It is the page where a
person touches a graph's topology — adds a node, takes an edge away, corrects a
gate's contract — without writing JSON by hand and without there being, anywhere,
a second way to change a graph.

One sentence sums up the boundary, and it is the inbox's: **the screen knows
nothing the public API does not tell it, and writes nothing the public API does
not write**. Saving here is three calls any script could make — create the
proposal, approve it, apply it — in order, stopping at the first that fails. No
new route in `packages/core`, no batch write, no "just this once".

---

## 1. What this screen edits

**Base-graph topology**: the nodes and edges of the current version of a `base`
lineage. It is the slice `t170` delivered after the founder split the original
ticket in three.

| Editable | How |
|---|---|
| Add a node | A new card, with `id`, `node_type`, `engine`, `role`, description, `skill_ref` and `contract` — all inside a single `add_node` operation. |
| Remove a node | One button per card. The edges that touched the node go with it, and the screen **says** how many went. |
| Edit an existing node | `role`, description, `skill_ref` (`id`/`version`/`hash`) and `contract` (raw JSON). Nothing beyond that — §3. |
| Add / remove an edge | One card per edge, with `from`, `to`, `condition` and a description. |
| Edit an edge | Comes out as a **removal followed by an addition**: the operation vocabulary identifies an edge by its two ends and has no edit operation. |

The selector reads `GET /v1/classes`, which lists **base lineages only**. A
variant (D13) is another conversation: forking, promotion and offering are still
`t118`, and this page neither offers nor edits them.

---

## 2. The control plane contract this screen assumes

The screen **creates no route at all** in the core. It consumes six endpoints,
every one of them older than this ticket.

| Method | Route | What the screen uses |
|---|---|---|
| `GET` | `/v1/classes` | The base-graph selector: `classe` and `grafo_id` of every base lineage. |
| `GET` | `/v1/graphs/:id` | `versao_corrente_id` — which version the edits will sit on top of. |
| `GET` | `/v1/graph-versions/:id` | The `snapshot`: the nodes and edges the page draws. |
| `POST` | `/v1/proposals` | `{grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada}` → `201 {proposta}`. |
| `POST` | `/v1/proposals/:id/approve` | `pendente` → `aprovada`. No body. |
| `POST` | `/v1/proposals/:id/apply` | Runs the gate over the document that would come out and, on a pass, writes the new version. |

Ids go **percent-encoded** in the path: `versao_corrente_id` is `sha256:` plus 64
hex characters, and an id that came from the API is not a path fragment the page
trusts.

Pinned against the real client in
[`packages/screen/test/graph-editor-acceptance.test.ts`](../../packages/screen/test/graph-editor-acceptance.test.ts),
which records the sequence of calls the page made and compares it with this list
— a seventh call fails it.

### Evidence and metric for a manual edit

`POST /v1/proposals` demands `evidencia` and `metrica_esperada` because a
proposal is a **hypothesis** (D15). A person dragging a node is making no
hypothesis at all, so both fields are fixed and inert:

```json
{ "evidencia": { "fonte": "tela-configuracao", "observacao": "edição manual via tela de configuração do grafo" },
  "metrica_esperada": { "nome": "edição manual (sem métrica)", "direcao": "sobe", "de": 0, "para": 0 } }
```

Inventing a number to satisfy the field would be worse than admitting the gap.
The metric's shape is only validated in `POST /v1/proposals/:id/outcome`
([`hypothesis.ts`](../../packages/core/src/domain/hypothesis.ts)), which nothing
in this flow calls.

---

## 3. What cannot be changed on a node that already exists

`id`, `node_type` and `engine` appear on the card, **read-only**, with the phrase
`remova e recrie o nó para mudar isso` beside them. It is not an interface
limitation:

- `id` and `node_type` are the node's identity. An edge, the telemetry and an old
  proposal all point at an id, and the comment in
  [`CHANGEABLE_FIELDS`](../../packages/core/src/domain/operations.ts) itself says
  that swapping either of them "is an operation of its own, not a field change".
- `engine` — and along with it `model`, `escalation_policy` and
  `escalation_recipient` — is **execution policy**. The core has accepted
  proposals for all four since `t166`/`t167`; what does not exist yet is the
  screen design for them, which is the separate ticket "Per-node execution
  policies (schema + API)". They were left out for scope, not for want of an
  operation.

Removing and recreating is still the way, and it is an honest way: it is born as
two operations with inverses, goes through the same gate and becomes a new
version like any other change.

---

## 4. Saving is three calls, and approval comes chained

```
POST /v1/proposals  →  POST /v1/proposals/:id/approve  →  POST /v1/proposals/:id/apply
```

It stops at the first that fails, and **nothing is retried on its own**.

Chaining the `approve` is the one point where this page steps out of the inbox's
rhythm, and it is deliberate: the person who has just edited the graph **is** the
person the human gate would ask, and a second click on their own draft would be
ceremony, not judgement. A topografo's proposal still stops at `pendente` and
still waits for somebody at `/` — principle 5's safety ladder is about a change
**somebody else** proposed.

What the page produces is byte for byte what a scripted client would produce:
acceptance test `AC1` registers the same graph in **two independent control
planes**, drives the page against one and replays its request body against the
other, and demands that the `graph_version.id` — which is the hash of the
snapshot — be the same on both sides.

---

## 5. The gate's refusal, in prose

`POST /v1/proposals/:id/apply` validates the document that **would come out**,
before writing anything, and answers `422` with the whole report when it fails.
It is the page's most useful moment — it is the system saying, in the graph's own
vocabulary, why that edit cannot exist — and dumping the JSON there would throw
that away exactly the way a line diff throws away a semantic diff.

| Answer | What the page shows |
|---|---|
| `422 grafo_invalido` | One line per entry of `estrutura.erros` (the `mensagem` as it came, written by the core) and one per rule in `soundness.violacoes`, naming the node or edge in `alvo`. |
| `422 operacao_inaplicavel` | `mensagem` as it came: it already speaks of the snapshot ("node X does not exist"). |
| `422 versao_sem_efeito` | `mensagem` as it came: the result is a snapshot that already exists in the lineage. |
| `409 proposta_desatualizada` | `a base do grafo mudou enquanto você editava`, plus a **Reload** button. No silent rebase: redoing the diff is the decision of whoever was editing. |

The four soundness rules become these sentences:

| Rule | Line |
|---|---|
| `alcançável` | `o nó "X" não é alcançável a partir do nó inicial: falta uma aresta que chegue até ele` |
| `termina` | `do nó "X" não há caminho até um nó final: quem cair nele não conclui a travessia` |
| `aresta_com_condicao` | `a aresta A → B está sem condição: uma transição sem rótulo é um caminho que o executor não sabe quando tomar` |
| `no_com_contrato` | `o nó "X" não declara skill_ref e contract completos: sem contrato não há como verificar o que ele produziu` |

The mapping lives in
[`src/public/graph-soundness.js`](../../packages/screen/src/public/graph-soundness.js),
a pure function, tested in Node. And it cannot diverge in silence:
`graph-soundness.test.ts` runs the four counterexamples of
[`schema/examples/`](../../schema/examples) through the reference validator
([`scripts/validate-graph.mjs`](../../scripts/validate-graph.mjs)) and demands that
every violation coming out of it has a sentence of its own here.

---

## 6. No framework, no build — and no `innerHTML`

Native ES modules, with no bundler and no build step, like the rest of this half
of the package. Three modules, and the split is what makes every rule testable
outside the browser:

| Module | What it is |
|---|---|
| [`graph-operations.js`](../../packages/screen/src/public/graph-operations.js) | A pure function: `diffGraphs(loaded, edited)` → typed operations with inverses. |
| [`graph-soundness.js`](../../packages/screen/src/public/graph-soundness.js) | A pure function: the gate's report → one line per problem. |
| [`graph-editor.js`](../../packages/screen/src/public/graph-editor.js) | The only one that touches the DOM. It takes `document` and `fetch` as arguments, which is what makes it drivable from Node. |

**The order of the operations is not cosmetic.** `applyOperations` runs the list
in order over a single document and refuses an operation the snapshot does not
admit, so the diff comes out in the one order that always applies: edges removed,
nodes removed, nodes added, fields changed, edges added.

Everything that is drawn goes in through `textContent`, **never** `innerHTML`: a
node id, a `role` or a condition was written by an agent inside a graph document,
and D4 treats agent content as an injection vector. It is the same rule
`inbox.js` already follows.

Every editable field carries `data-campo` with the field's name, and every card
carries `data-node` or `data-edge` — structural markers, in the same spirit as
the `data-*` of [`screen.md`](screen.md) §6. Acceptance test `AC3` uses exactly
those markers to demand that an existing node **offer no control at all** for
`id`, `node_type` or `engine`.

The contract travels as **text** and is only parsed on `Save`: half-typed JSON is
a normal state of an editor, not an error to shout about on every keystroke.

---

## 7. What this screen does not do yet

Every item is another ticket's declared scope, not an oversight:

- **Per-node execution policies** (model, pause, timeout, escalation) — the
  ticket "Per-node execution policies (schema + API)". The core already accepts
  proposals for `engine`, `model`, `escalation_policy` and
  `escalation_recipient`; the screen design is what is missing.
- **Editing the skill registry** — half-solved by `t215`, and the half that is
  left is named here. The registry stopped being create-only: the versions of a
  skill coexist (D22), and this screen reads `GET /v1/skills?id=` for every
  pinned skill and offers a selector of the registered versions when there is any
  besides the one the node pins. Choosing one writes the three fields of
  `skill_ref` (`id`, `version`, `hash`) — the pin goes as `change_node_field`,
  through the same door as ever, and is refused on apply if the registry does not
  carry that hash. What does **not** exist here is editing the CONTENT of a
  manifest, or seeing the diff between two of its versions: that is still the
  ticket "Skill & contract editing (API + diff UI)". Editing the node's own
  `contract`, yes — it is a field of the graph document, like `skill_ref`.
- **A draggable canvas.** The graph document has no coordinate field
  ([`schema/grafo.schema.json`](../../schema/grafo.schema.json)); inventing one is
  a decision of its own, with a rendering dependency this package does not carry.
  What exists here is a structured, editable list — visual in the same sense the
  inbox is.
- **Swapping the `id`, `node_type` or `engine` of an existing node** — §3.
- **Editing `initial_node`, `final_nodes`, `metadata` or `custom_fields`** —
  there is no semantic operation for any of them; growing the vocabulary is
  additive and waits for the rule of two consumers.
- **Variant lineages** (D13) — this editor aims at base graphs.
- **Concurrency beyond `409 proposta_desatualizada`** — no lock, no live
  collaboration, no automatic rebase.
- **Real-time updates** (polling, websocket) — the page moves when whoever is on
  it acts, like the rest of the screen.
- **Logging in from the browser** — unchanged: the screen still presents the
  `t124` service credential.
