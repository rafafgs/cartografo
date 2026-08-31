# Specification: the versioning entities and the API

**API version:** `v1` · **Migration:** [`packages/core/migrations/0002_grafo_versao_proposta.sql`](../../packages/core/migrations/0002_grafo_versao_proposta.sql)
**Founding decision:** [D15](../../DECISIONS.md) — "graph versioning: in the database, with git's ideas"

The graph is data (D15), and [`docs/spec/graph.md`](graph.md) specifies the
format of that data. This document specifies where it **lives** and how it
**moves**: the three tables that keep the lineage, the snapshot and the
hypothesis; the procedure that gives a version its identity; the semantic diff
vocabulary; and the API that exposes all of it.

The whole idea fits in one sentence: we version the way git thinks, with no git
in the core. A version is addressed by the hash of its own content, points at its
parent, and is never rewritten; what moves is a pointer. A rollback moves the
pointer back and deletes nothing — it is what lets the topografo cross
"version × telemetry" with a join later, in the abandoned versions too.

---

## 1. The three entities

| Entity | What it is | Does it change? |
|---|---|---|
| `graph` | The **lineage**: the class, the lineage type (base or variant) and the pointer to the version that holds today. | Only the pointer. |
| `graph_version` | An immutable **snapshot** of the whole document, addressed by the hash of its content, with a pointer to its parent. | Never. |
| `proposal` | A **hypothesis**: the target version, the semantic diff with its inverses, the evidence that motivated it and the metric it expects to move. | Only the status and the result. |

`class` is a column of `graph`, not a table of its own: D8 fixes the class as an
identity named by the user and a **versioning root**, and D13 describes class and
variant as attributes of the graph, not as an entity with a life cycle of its
own. That is why a class's base lineage is born with `id = class`. If a navigable
class with no graph ever exists, extracting the table is additive.

```sql
CREATE TABLE graph (
  id                  TEXT PRIMARY KEY,          -- the class, for the base lineage (D8)
  class               TEXT NOT NULL,
  lineage_type        TEXT NOT NULL CHECK (lineage_type IN ('base', 'variant')),
  base_class          TEXT,                      -- variant only (D13)
  origin_proposal_id  INTEGER REFERENCES proposal(id),
  current_version_id  TEXT REFERENCES graph_version(id),
  created_at          TEXT NOT NULL,
  CHECK (
    (lineage_type = 'base' AND base_class IS NULL)
    OR (lineage_type = 'variant' AND base_class IS NOT NULL)
  )
);

CREATE UNIQUE INDEX graph_class_base_unique ON graph (class) WHERE lineage_type = 'base';

CREATE TABLE graph_version (
  id               TEXT PRIMARY KEY,   -- sha256:<64 hex> of the canonical snapshot (§2)
  graph_id         TEXT NOT NULL REFERENCES graph(id),
  parent_version   TEXT REFERENCES graph_version(id),
  snapshot         TEXT NOT NULL,      -- the complete graph document, canonicalized
  source           TEXT NOT NULL CHECK (source IN ('manual', 'synthesizer', 'proposal')),
  proposal_id      INTEGER REFERENCES proposal(id),
  created_at       TEXT NOT NULL,
  contracts_state  TEXT NOT NULL DEFAULT 'unchecked'
                     CHECK (contracts_state IN ('checked', 'unchecked', 'failed')),
  contracts_report TEXT NOT NULL DEFAULT '[]'   -- JSON: ContractProblem[]
);

CREATE TABLE proposal (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  graph_id            TEXT NOT NULL REFERENCES graph(id),
  target_version      TEXT NOT NULL REFERENCES graph_version(id),
  operations          TEXT NOT NULL,   -- JSON: Operacao[] (§3)
  evidence            TEXT NOT NULL,   -- JSON
  expected_metric     TEXT NOT NULL,   -- JSON
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'reverted', 'rejected')),
  applied_version_id  TEXT REFERENCES graph_version(id),
  revert_reason       TEXT,
  result              TEXT,            -- JSON
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
```

**`contracts_state` is the one column of `graph_version` that changes after the
row is written.** Everything else about a version is frozen — the
snapshot, the parent and the hash that IS its identity — and this is a mutable
STATUS on an otherwise append-only row, the same shape `skill.deprecated_at`
already has. It records whether the contract check of `graph.md` §6.1 ever got to
run: `checked` (it ran and passed), `unchecked` (a skill pin resolved to nothing,
so it never ran) or `failed` (it ran and refused). Registering the missing
manifest re-runs the check and moves the row, recording
`graph_version.contracts_checked`. Only `checked` may carry a job — see §6.

Reading notes:

- **`current_version_id` is the only field that answers "what holds today".**
  There is no `ativa` flag on `graph_version`: two sources for the same fact
  diverge.
- **`source` tells apart who produced the snapshot** — `manual` (imported or
  written by hand), `synthesizer` (D10) or `proposal` (the topografo). In the PoC
  only `manual` and `proposal` happen; the value exists because origin is a fact
  about the data, not about the phase.
- **The column names copy the event schemas literally**, as already specified in
  [`specs/events/schemas/`](../../specs/events/schemas)
  (`graph_id`, `parent_version`, `source`, `proposal_id`, `reason`). That is what
  made the emission a direct mapping and not a translation:
  every path that writes a version records `graph_version.registered` and —
  because writing and coming into force happen in the same transaction in all
  three cases — also `graph_version.applied`. Reverting records a
  `graph_version.reverted` on its own, with `entity.id` on the **abandoned**
  version, because no new version is written.
- **Nothing is deleted.** There is no `DELETE` and no `UPDATE` of
  `graph_version` on any code path. The only `UPDATE` of `graph` is the
  pointer's.

---

## 2. A version's identity: the snapshot's hash

`graph_version.id` is `sha256:` followed by the sha256 of the **canonical** JSON
serialization (keys sorted recursively, the part of RFC 8785 these formats use)
of the **whole** graph document.

```
id = "sha256:" + sha256( JSON.stringify( canonicalizar( documento ) ) )
```

Two deliberate consequences:

1. **It covers the whole document**, unlike the skill manifest's hash
   ([`skill-manifest.md`](../../specs/formats/skill-manifest.md)),
   which covers only `{instrucoes, entrada, saida, checks, permissoes}`. There,
   catalogue metadata must not invalidate the pin; here the opposite holds — a
   version's snapshot **is** the whole document ([`graph.md` §7](graph.md)), and
   changing the graph's description is a new version.
2. **Reordering a key is not a change.** The order of the keys and the JSON's
   formatting carry no meaning in a graph document; two files that differ only in
   that have the same hash and are the same version.

Since the hash IS the identity, a result identical to a version that already
exists in the lineage is not a new version: it is a proposal with no effect, and
applying it is refused (§5).

Implementation: [`packages/core/src/dominio/hash.ts`](../../packages/core/src/dominio/hash.ts)
(the same `canonicalizar` function as `scripts/validar-bundle-fabrica.mjs`).

---

## 3. The semantic operation vocabulary

A proposal carries a **semantic diff**, not a line diff (D15): a list of typed
operations, each one with an inverse of its own. It is what makes a proposal
judgeable ("it adds a red-team gate before deployment") rather than merely
readable as a patch, and what gives any change a way back.

The vocabulary has travelled the wire in English since D20 (`glossary-wire.md`
§3): the type's name, the operation's keys and the validation report. Nothing
already written in `proposal.operations` was migrated — the development databases
are recreated, and an operation still written in Portuguese is an unknown type,
not an old dialect accepted in parallel.

| Type | Fields | Inverse |
|---|---|---|
| `add_node` | `node` (the node's document) | `remove_node` of the same `id` |
| `remove_node` | `node_id` | `add_node` of the same node |
| `add_edge` | `edge` (`from`, `to`, `condition`) | `remove_edge` of the same edge |
| `remove_edge` | `edge` (`from`, `to`, `condition?`) | `add_edge` of the same edge |
| `change_node_field` | `node_id`, `field`, `from`, `to` | `change_node_field` with `from`/`to` swapped |

The operation's before/after pair is called `from`/`to` by the same name the
document's edge already used for its ends, and it is on purpose: they are two
formats that meet inside the same operation, and they now say the same word for
the same thing.

`change_node_field` swaps `papel`, `descricao`, `skill_ref` or the whole
`contrato`. `id` and `tipo_no` are **not** changeable fields: the id is the key
edges, telemetry and old proposals refer to the node by, and swapping it is a
semantic operation of its own, not a cosmetic rename.

```json
{
  "type": "add_edge",
  "edge": { "from": "testar", "to": "red_team", "condition": "aprovado" },
  "inverse": {
    "type": "remove_edge",
    "edge": { "from": "testar", "to": "red_team", "condition": "aprovado" }
  }
}
```

**`condition` in `remove_edge`'s target is optional, and it is what breaks the
tie on a parallel edge.** Two edges between the same pair of nodes with different
conditions are two edges (the schema always allowed it: they are two outcomes of
the same step), and a target with only the two ends does not say which of them to
remove. With a `condition`, the operation removes exactly that one; without, it
removes the first edge between those two ends — which is what the operation
always meant. For the same reason, the inverse is only incompatible when BOTH
sides declare a `condition` and they disagree; a side that declares none matches
the other.

Two boundaries:

- **Validating an operation is structural.** `validarOperacao` checks the keys,
  the types and the inverse's compatibility (a paired type and the **same
  target** — another node's inverse is not an inverse), and answers
  `{valid, errors: [{code, message}]}`. It does not stop the operation from
  producing a broken graph: what fails that is the soundness gate, after
  applying. An edge with `condition: ""` is a well-formed operation **and** an
  unsound graph; the two judgements belong to different layers, and it is that
  which makes the error reach the client with the rule's name instead of a
  generic 400.
- **Applying refuses a target that does not exist.** Removing a node that is not
  in the snapshot blows up rather than becoming a silent no-op: the proposal is
  speaking about another version of the graph, and recording "applied, nothing
  changed" would be a version lying about what happened.

Five operations are the minimum that proves the apply/soundness/revert cycle —
not the topografo's final vocabulary. Growing is additive, and the rule of two
consumers says to wait for a second real consumer before freezing.

Implementation: [`packages/core/src/dominio/operacoes.ts`](../../packages/core/src/dominio/operacoes.ts).

### 3.1 The semantic diff between two documents

`applyOperations` is the outbound half — a document plus operations gives a new
document. `diffGraphs(from, to)` is its inverse pair: two complete documents give
the list of operations that takes one to the other, in the same vocabulary of
five above. It is the engine promotion and offering (§6) needed in order to
exist.

Three boundaries, all deliberate:

- **Only `nos` and `arestas` enter the diff.** `classe`, `linhagem`, `metadata`,
  `no_inicial` and `nos_finais` have no operation that expresses them, and
  `applyOperations` never touches them either. It is by construction that a
  promotion/offer proposal preserves the **target's** identity: a base stays a
  base, a variant stays a variant.
- **The comparison is canonical.** Never `===` and never raw `JSON.stringify`:
  key order means nothing in a graph document (§2), so two nodes that differ only
  in it are the same node, and emitting an operation there would be inventing a
  diff.
- **No fork point, no three-way merge.** The engine sees the two snapshots it was
  given and nothing else.

How each difference becomes an operation:

| Difference | Operations |
|---|---|
| A node only in `from` | `remove_node` |
| A node only in `to` | `add_node` |
| The same `id`, only `papel`/`descricao`/`skill_ref`/`contrato` changes | one `change_node_field` per field, in the fixed order `papel`, `descricao`, `skill_ref`, `contrato` |
| The same `id`, `tipo_no` or any key outside those four changes | `remove_node` + `add_node` (a whole swap) |
| An edge (`from`, `to`) on one side only | `remove_edge` / `add_edge` |
| The same ends, `condition` (or any key) changes | `remove_edge` + `add_edge` |

A changeable field present on one side and absent on the other also falls into
the whole swap: `change_node_field` writes the key, it never erases it, and an
operation with `to: undefined` loses the key when it is serialized into
`proposal.operations` and comes back malformed.

The emission order is fixed and is part of the contract: (a) node removals in
`from` order, (b) node additions in `to` order, (c) `change_node_field` in `to`
order, (d) edge removals in `from` order, (e) edge additions in `to` order.
Removal before addition is what lets the swap (removing and re-adding the same
`id`) apply without hitting `duplicate_node`; reading each list in its own order
is what makes the round trip reproduce `to`, because canonicalizing sorts keys,
not list positions.

Out of that comes the property the engine promises: `applyOperations(from,
diffGraphs(from, to))` does not blow up and returns `nos`/`arestas` canonically
equal to `to`'s, and every emitted operation passes `validarOperacao` untouched.

Implementation: [`packages/core/src/domain/diff.ts`](../../packages/core/src/domain/diff.ts)
— a file born after D18, so the path here is already the real one, in English,
unlike this document's other links.

---

## 4. The validation gate

Every document that enters the database — registered directly or produced by a
proposal — goes through the same pair of checks, which is the TypeScript port of
The reference validator ([`graph.md` §6](graph.md)):

- `validateStructure` — shape and referential integrity (`{valid, errors}`);
- `validateSoundness` — the four workflow-net rules, in the order `reachable`,
  `terminates`, `edge_with_condition`, `node_with_contract` (`{valid, violations}`).

The report returned in the `422` is exactly
[`scripts/validate-graph.mjs`](../../scripts/validate-graph.mjs)'s — the same
codes, the same targets, the same order. The parity between the two validators is
locked down by a test over every fixture in `schema/examples/`
([`test/domain-graph.test.ts`](../../packages/core/test/domain-graph.test.ts)):
the script lives outside the package's publishable tree, so the duplication is
deliberate — and watched.

There is no Fastify/ajv schema declared against
[`schema/graph.schema.json`](../../schema/graph.schema.json): the schema is draft
2020-12 and the ajv that ships with Fastify v5 is configured for draft-07.
Reconfiguring the compiler is possible and waits for somebody to need complete
shape validation at the HTTP edge.

Implementation: [`packages/core/src/dominio/grafo.ts`](../../packages/core/src/dominio/grafo.ts).

---

## 5. The flows that move the pointer — and the one that closes the hypothesis

### Registering a new lineage

`POST /v1/grafos` takes the raw document and does, in one transaction: validate →
create `graph` → create `graph_version` (`parent_version: null`,
`source: "manual"`) → point `current_version_id` at it.

Registering does **not** move the pointer
([`taxonomy.md`](../../specs/events/taxonomy.md)) — except here, in
the bootstrap of a new lineage, because there is no earlier "current" to preserve
and a lineage with no pointer would be a graph that exists without holding.

### Forking a lineage

`POST /v1/grafos/:id/fork` creates a base's **variant** (D13) and is the second —
and last — bootstrap of this layer, with the same pointer exception as the flow
above:

```
check that :id exists and is a base lineage
        ↓
assemble the document: the base's CURRENT snapshot, swapping only the lineage
        ↓ (a hash that already exists in any lineage: 409, nothing is written)
write graph (lineage_type = variante, class and base_class = the base's class)
        ↓
write graph_version (parent_version = the base's current version)
        ↓
move the variant's current_version_id
```

Branch semantics: forking **carries no diff at all**. A `git branch` does not
change content — it creates a pointer and a parentage, and the variant and the
base move apart afterwards, through the ordinary proposal flow, which needs no
special case for a variant.

Two consequences the design takes on purpose:

- **The parentage crosses the lineage.** The `parent_version` of the variant's
  first version is the **base's** current version. The schema allows it:
  `parent_version` only references `graph_version(id)`, without demanding the
  same `graph_id`. It is that pointer that records the fork point — promotion and
  offering do **not** use it yet (their diff compares the two current snapshots,
  §3.1), and it is where a three-way merge will come from when one exists (§7).
- **The hash is global, not scoped to a lineage.** Two forks of the same base
  with the same origin (or both with no origin) would produce the same document,
  and `graph_version.graph_id` is a single column — one row cannot belong to two
  lineages at once. The second is refused with `409 bifurcacao_sem_efeito`,
  before any write.

The body asks for `id` (the identity of the lineage being born; the `classe` is
inherited from the base) and accepts an optional `origem_proposta_id`. It is
checked **for existence only**, in any status: the topografo does not know how to
propose a fork yet. When present, the version is born with `origem: "proposta"`;
absent, with `origem: "manual"` — the same treatment the base's bootstrap already
gives a version with no proposal behind it.

The field's type diverges on purpose between the database and the document:
`graph.origin_proposal_id` is `INTEGER REFERENCES proposal(id)`, and
`linhagem.origem_proposta_id` is a `string` in
[`graph.schema.json`](../../schema/graph.schema.json) — designed to accommodate
an id from outside, like an imported atlas's. The integer stays in the database
and becomes `String(id)` in the document. Without an `origem_proposta_id`, the
key is **omitted** from the document, never `null`, the way `base` already does
with the two fields the schema forbids it.

### Applying a proposal

`POST /v1/propostas/:id/aplicar` is D15's whole flow. It only runs over an
**`approved`** proposal: the human gate comes first, and skipping the gate is a
`409 proposta_nao_aprovada` (§ "The proposal's states"). The order of what comes
next is not negotiable:

```
apply the operations over a COPY of the target snapshot
        ↓
validate structure + soundness ON THE RESULT
        ↓ (failed: status = rejected, the report in result, 422)
compute the hash of the resulting document
        ↓
write graph_version (parent_version = target_version, source = proposal)
        ↓
move graph.current_version_id
        ↓
status = applied, applied_version_id = the hash
```

The gate runs over the document that **would come out**, not over the one that
went in: it is the composition of the operations that breaks the graph — each one
in isolation can be impeccable. On a failure, nothing enters the database beyond
the status and the report: the new version never comes into existence at all.

A rejection does not delete the proposal. A failed hypothesis is evidence for the
topografo, not rubbish.

### Reverting

`POST /v1/propostas/:id/reverter` moves `current_version_id` back to
`target_version` and writes `revert_reason`. The abandoned version stays in
`graph_version` and stays listed in the history — append-only has no exception.

`motivo` is **mandatory**, mirroring the `data.reason` of the
[`graph_version.reverted`](../../specs/events/schemas/graph_version.reverted.schema.json)
event — which is really written, with `entity.id` on the abandoned
version: it is the evidence the topografo will cross with that version's
telemetry. Reverting without saying why loses the useful half of the fact.

### Closing the experiment

A proposal is a hypothesis, an approval is an experiment, the next round's
telemetry is the result
([`notes/2026-08-14-learning.md`](../../notes/2026-08-14-learning.md)).
`POST /v1/propostas/:id/resultado` is where that cycle closes: it takes
`{execucao_id, depois}` and writes the hypothesis's verdict into
`proposal.result`.

Two shapes that were opaque until then become required **here, and only here**:

```jsonc
// proposal.expected_metric — what the hypothesis declared it would move
{ "nome": "retrabalho_por_travessia", "direcao": "cai", "de": 0.4, "para": 0.1 }

// proposal.result — the verdict, written exactly once
{ "veredito": "piorou", "antes": 0.4, "depois": 0.9,
  "execucao_id": 7, "avaliado_em": "2026-08-14T18:20:31.004Z" }
```

`POST /v1/propostas` **still does not validate** `metrica_esperada`: changing an
already published endpoint is another ticket, and an old proposal with an
incomplete metric simply has no verdict to compute (`422`).

The verdict's rule, with no tolerance band — a strict numeric comparison:

| How `depois` moved relative to `de` | Verdict |
|---|---|
| Equal | `sem_efeito` |
| In the declared direction (`cai` → smaller; `sobe` → larger) | `confirmada` |
| In the opposite direction | `piorou` |

The baseline is `de`, never `para`: `para` is the target the proposal hoped for,
and judging against it would turn "it moved the right way, by less than hoped"
into a failure.

Three guarantees around the arithmetic:

- **`depois` belongs to the caller.** There is no named-metric engine in v1; who
  computes it is the topografo, which already had to compute the same
  metric in order to write `metrica_esperada` when it created the proposal.
- **The following execution is demonstrated, not claimed.** `execucao_id` is
  checked against `metricasPorVersao`: without at
  least one `job` of that execution recorded under `applied_version_id`, it is a
  `422 execucao_sem_evidencia`. It is the join that proves the applied version
  really ran.
- **Only the first call counts.** With `result` already filled in, the route is a
  `409 proposta_ja_avaliada` and nothing changes. Re-evaluating would be
  rewriting a hypothesis's past.

Closing the experiment does **not** change the status: a proposal that made
things worse is still `applied`, and this route never calls the revert. "It got
worse" is data, not an action — the evolution's safety ladder (README, principle
5) orders suggesting and going through a human gate, not reverting on its own.
The queue of those suggestions is a filtered read,
`GET /v1/propostas?status=applied&veredito=piorou`, and nothing beyond that: an
active notification, if one ever exists, is another ticket's decision.

### The proposal's states

```
              reject (with a reason)
   pending ───────────────────────────────▶ rejected
      │                                         ▲
      │ approve                                 │ apply (the gate fails it)
      ▼                                         │
   approved ─────────────────────────────────────┤
      │              apply (the gate passes it)  │
      ▼                                          │
   applied ───────────────────────────────▶ reverted
                revert (with a reason)
```

`approved` is principle 5's human gate, and it is mandatory:
applying demands `approved`, and a proposal that skips the gate takes a
`409 proposta_nao_aprovada`. It is the same ladder the screen has drawn since
The inbox ([`screen-proposal-inbox.md` §3](screen-proposal-inbox.md)) reads `pending`
offers Approve/Reject, `approved` offers Apply.

Approving writes nothing beyond the status: applying is a deliberate second act,
and collapsing the two into one click would undo the ladder in the name of one
click fewer.

Two paths reach `rejected`, and the two stories live in different columns on
purpose:

| Who rejected | From which state | Where the reason lives |
|---|---|---|
| A person, through the inbox | `pending` | `rejection_reason` (free text, mandatory) |
| The soundness gate, during the `aplicar` | `approved` | `result` (§4's whole report) |

A `rejected` row written before that rule has `rejection_reason = NULL`, and that is the
correct thing: it was never rejected by a person. There was no backfill.

The verdict is orthogonal to this diagram: it writes `result` and leaves the
state where it was. `result` carries two uses that never coexist — the report
that failed a `rejected` proposal, or the verdict on the hypothesis of a proposal
that got as far as `applied`. A reverted proposal **keeps** the verdict that
justified the reversal.

---

## 6. Endpoints

All under `/v1`, all demanding
`Authorization: Bearer <token>`. The four that write a version or
move the pointer — `POST /graphs`, `POST /graphs/:id/fork`,
`POST /proposals/:id/apply` and `POST /proposals/:id/revert` — **write the
corresponding event in the same transaction as the row**. The two that only open
a pending proposal (`/promote` and `/offer`) write nothing, because no version
changed.

The paths below are in this document's Portuguese spelling; the implemented
surface was renamed to English (D18), and it is the one that holds:
`/v1/graphs`, `/v1/graphs/:id/fork`, `/v1/graph-versions/:id`, `/v1/proposals`,
`/v1/proposals/:id/apply` and so on. Rewriting the whole table is another ticket.

| Method | Route | What it does |
|---|---|---|
| `POST` | `/v1/grafos` | Registers a new **base** lineage from the complete document (a raw body, with no envelope). |
| `POST` | `/v1/grafos/:id/fork` | Forks a base into a **variant** (§5). Body: `{id, origem_proposta_id?}`. |
| `POST` | `/v1/grafos/:id/promote` | `:id` is a **variant**: opens a pending proposal **on the class's base** with `diffGraphs(base, variante)` (D13, §3.1). Body: `{evidencia, metrica_esperada}`. |
| `POST` | `/v1/grafos/:id/offer` | `:id` is a **base**: opens a pending proposal **on the named variant** with `diffGraphs(variante, base)` (D13, §3.1). Body: `{variante_id, evidencia, metrica_esperada}`. |
| `GET` | `/v1/classes` | The catalogue of registered classes. |
| `GET` | `/v1/grafos` | Every lineage. |
| `GET` | `/v1/grafos/:id` | One lineage, with its current-version pointer. |
| `GET` | `/v1/grafos/:id/versoes` | The whole chain of versions, including the ones abandoned by a reversal. |
| `GET` | `/v1/grafo-versoes/:id` | One version, with the complete `snapshot`. |
| `POST` | `/v1/propostas` | Creates a pending proposal. |
| `GET` | `/v1/propostas` | Lists the proposals in `id` order; optional `status` and `veredito` filters. |
| `GET` | `/v1/propostas/:id` | One proposal, with `operacoes`, `evidencia`, `metrica_esperada`, `resultado`, `motivo_reversao` and `motivo_rejeicao`. |
| `POST` | `/v1/propostas/:id/aprovar` | The human gate: `pending` → `approved`. No body. |
| `POST` | `/v1/propostas/:id/rejeitar` | The human gate: `pending` → `rejected`; demands `motivo`, which goes into `motivo_rejeicao`. |
| `POST` | `/v1/propostas/:id/aplicar` | Runs §5's flow. Demands `approved`. |
| `POST` | `/v1/propostas/:id/reverter` | Moves the pointer back; demands `motivo`. |
| `POST` | `/v1/propostas/:id/resultado` | Closes the experiment: writes the hypothesis's verdict. Does not change the status. |

Error codes, per route:

| Situation | Code | `erro` |
|---|---|---|
| The document failed the gate | `422` | `grafo_invalido` (with `estrutura` and `soundness`) |
| `linhagem.tipo` ≠ `base` in `POST /v1/grafos` | `400` | `linhagem_nao_base` |
| The class already has a base graph | `409` | `classe_ja_registrada` |
| Forking something that is not a `base` lineage | `400` | `base_invalida` |
| The variant's `id` is absent or empty | `400` | `campo_obrigatorio_ausente` |
| The variant's `id` is already a lineage | `409` | `id_ja_registrado` |
| `origem_proposta_id` is not a positive integer | `400` | `origem_proposta_id_invalido` |
| `origem_proposta_id` with no matching proposal | `400` | `origem_proposta_desconhecida` |
| A base with no `versao_corrente_id`, and on either side of a diff too (a defensive invariant) | `409` | `grafo_sem_versao_corrente` |
| A fork that produces an already existing snapshot | `409` | `bifurcacao_sem_efeito` |
| Promoting something that is not a variant, or offering to another class's variant | `400` | `variante_invalida` |
| Offering from something that is not a `base` lineage | `400` | `base_invalida` |
| `variante_id` absent or empty in the offer | `400` | `campo_obrigatorio_ausente` |
| A promotion/offer whose two snapshots already agree on `nos`/`arestas` | `422` | `diff_sem_efeito` |
| `versao_alvo` does not exist or belongs to another graph | `400` | `versao_alvo_desconhecida` |
| An operation of an unknown type, with no inverse or malformed | `400` | `operacoes_invalidas` |
| Approving/rejecting a proposal that is not `pending` | `409` | `proposta_nao_pendente` |
| Applying a proposal that did not go through the human gate | `409` | `proposta_nao_aprovada` |
| Reverting, or closing the experiment of, a proposal that is not `applied` | `409` | `proposta_nao_aplicada` |
| The base moved underneath the proposal | `409` | `proposta_desatualizada` |
| The operation does not apply to the snapshot | `422` | `operacao_inaplicavel` |
| A result identical to an existing version | `422` | `versao_sem_efeito` |
| Reverting or rejecting with no reason | `400` | `motivo_obrigatorio` |
| `evidencia` or `metrica_esperada` absent; `execucao_id`/`depois` absent or not numeric | `400` | `campo_obrigatorio_ausente` |
| A result already written by an earlier execution | `409` | `proposta_ja_avaliada` |
| `metrica_esperada` without the `{nome, direcao, de, para}` shape | `422` | `metrica_esperada_invalida` |
| No job of the execution ran under `versao_aplicada_id` | `422` | `execucao_sem_evidencia` |
| A resource that does not exist | `404` | `grafo_desconhecido` / `grafo_versao_desconhecida` / `proposta_desconhecida` |

One refusal of this family does not live on any route of the table above, and
belongs here anyway because it is the enforcement point of the version state this
document's §1 declares. `POST /v1/jobs` answers `409` when the
`graph_version_id` it is given RESOLVES and its `contracts_state` is not
`checked`:

| Situation | Code | `error` |
|---|---|---|
| The named version was never contract-checked (a skill pin resolves to nothing) | `409` | `graph_version_unchecked` |
| The named version ran the check and failed it | `409` | `graph_version_contracts_failed` |

Both carry `graph_version_id` and `contracts` (`{state, problems}`) as sibling
context. A job with no `graph_version_id`, or with one that resolves to nothing,
is not gated: there is no version to read a state off.

The error body always carries `erro` — a stable, machine-readable code — and,
when there is something to explain, a `mensagem` for people. In `grafo_invalido`
it comes with §4's whole report (`estrutura` and `soundness`), which is what
makes it possible to point at the rule and the target instead of only saying
"invalid".

Implementation: [`routes/grafos.ts`](../../packages/core/src/routes/grafos.ts),
[`routes/propostas.ts`](../../packages/core/src/routes/propostas.ts),
[`dominio/hypothesis.ts`](../../packages/core/src/dominio/hypothesis.ts) (the
verdict, pure) and [`repositorios/`](../../packages/core/src/repositorios). Only
`src/db/` touches the SQLite driver (D1); repositories and routes are handed the
database already open.

---

## 7. What this layer does not do yet

Every item here is another ticket's declared scope, not an oversight:

- **A three-way merge between a variant and its base** (D13). Promoting and
  offering already exist (`/promote` and `/offer`, §6), but on top of a diff
  between the **two current snapshots** and nothing else: the engine does not
  know the fork point. The consequence is asymmetric and worth saying out loud —
  an offer **overwrites** the nodes and edges where the variant had already
  diverged, instead of laying only the base's own increment on top. Until that
  changes, offering to a variant that has moved on its own is a decision for
  whoever approves the proposal, not an implementation detail. A diff anchored on
  the ancestor (`base-at-the-fork` → `current-base`) is real future work.
- **Running an operation's inverse** — here only its shape is validated.
- **Registering a new manual version over an existing lineage**, outside the
  proposal flow.
- **Reverting to an arbitrary version**, outside a proposal's
  `target_version` / `applied_version_id` pair.
- **Human approval/rejection** as an API action.
- **Computing `depois` automatically** from the telemetry, and firing the verdict
  "when the execution ends": there is no named-metric engine and no
  finished-execution entity or event in v1
  ([`routes/executions.ts`](../../packages/core/src/routes/executions.ts)).
  Closing the experiment is always an explicit API call (§5).
- **The identity of the caller.** Authentication is closed — every one of
  these routes demands a credential —, but a token proves possession, not a
  person: the `actor` of the events is
  `{type: "system", ref: "control-plane"}`, the component that acted, and none of
  these routes accepts an `actor` in the body.
