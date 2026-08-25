# The thread speaks English too, from the database to the page (D20, t213)

**When:** 2026-08-16–17 · **Decision:** [D20](../DECISIONS.md) ·
**Umbrella:** t213, split into seven children by surface ·
**Data migrated:** none, on purpose.

D18 had already taken the CODE to English. What was left in Portuguese was what
travels: the JSON's keys, the event names, the proposal operations, the
database's tables and columns, the screen's routes, the CLI flags and the
validation report. D20 decided to migrate that too, **before the repository
opens** (D7) — because a public project with two vocabularies teaches both — and
before the fichas that would touch those surfaces, so as not to do the work
twice.

This note closes the series.

## What moved, and who took it

| Surface | What changed | Ficha |
|---|---|---|
| The glossary | The single map, `docs/spec/glossario-wire.md`: one row per term, with the file it lives in today | t213 |
| The API and its errors | The JSON's fields and query parameters, the two error envelopes converged, the refusal codes | t226 |
| Events | Type names, envelope keys, entity and actor types, `data` keys, and the schemas of `especificacoes/eventos/schemas/` renamed alongside | t227 |
| Proposal operations | `add_node`, `remove_edge`, `change_node_field` and the keys they carry | t228 |
| The database (names) | Tables, columns and indexes | t229 |
| Routes, flags and the report | The screen's routes (`/board`, `/input-requests`…), `--class`/`--out`, and the validation report's keys in BOTH implementations | t230 |
| The database (values) | The VALUES stored in the columns — `status`, `entity_type`, `role`… — and, alongside them, the eighteen migrations rewritten | t235 |
| The specifications (database) | The specifications' schema citations, checked against a real database | t236, t237 |
| The specifications (thread) and the gate | The event, route and flag citations; the broken schema links; and the gate that stops the drift back | t231 |

## What was deliberately left out

- **The prose.** `DECISIONS.md`, `notas/`, `docs/` and the commit messages stay
  in Portuguese (D18). D20 changed what TRAVELS, not what is read.
- **`topografo-custo`'s `avaliar`** and its `--tier-*` options: t230 left them
  out by its own decision, and no ficha of this series reopened them.
- **`grafos-de-fabrica/` as a directory name** and `<classe>` as a path marker in
  `atlas-bundle.md`: D20 never declared a repository directory name to be a
  thread surface.
- **Four columns of `job` and of `session`** that §4.2 of the glossary does not
  record (`corpo`, `criterios_de_aceite`, `transcricao_truncada`,
  `transcricao_tamanho_original`). Closing the hole means adding rows there, and
  it is the work of a ficha of its own.

## There is no rename migration, and that is the decision

The log is append-only and a stored proposal is the record of what somebody
proposed: renaming a recorded event type would be rewriting history, and an old
row would not pass the new `CHECK` anyway. Since there is no production data, D20
answered by **recreating** the development database instead of migrating it.

That is why t235 did not stack a nineteenth migration that renamed: it rewrote
`0001`–`0018` in place, and the schema **is born in English**. A database older
than t235 is not updated by them — there is nothing to run. The update step is
one line, and it is in `README.md`:

```bash
rm -rf .cartografo/
npx cartografo
```

## The gate that stops the drift back

Every surface got its own, and none of them declares a vocabulary: they all read
the glossary at run time, so that a row added there becomes a checked term on the
next run.

- `packages/core/test/no-portuguese-wire.test.ts` (and its ports in `runner`,
  `tela` and `topografo-custo`) — the routes, the flags, the report and `/v1`'s
  JSON.
- `event-validation.test.ts` and `domain-operations.test.ts` — the event
  catalogue and the operation names, which also refuse the old spellings.
- `no-portuguese-database.test.ts` and `migrate.test.ts` — the schema and the
  queries.
- `spec-database-citations.test.ts` — the specifications' schema citations,
  resolved against a database the migrations really build.
- `glossario-wire-docs.test.ts` (t231) — the specifications' event, route and
  flag citations, and the links to `especificacoes/eventos/schemas/`.

The last one is the only one that reads Markdown, and its rule is narrow on
purpose: only what is **inside a backtick or a fenced block** is read. The prose
around it is Portuguese by decision, and a gate that could not tell "the question
that blocks the job" from a citation would have had to be switched off to be
usable.

## What the series taught

**Glossary first was not bureaucracy.** Without it, six fichas would have
invented five Englishes for the same term — and the repository would have opened
with two vocabularies instead of one. The glossary reuses the name the code
already exposed whenever one existed (`/v1/jobs` is what made `trabalho` become
`job`, and not `task`), which is how a translation stops being an opinion.

**A document that describes its own state goes wrong by itself.** The row in §5
of the glossary said `pendente` for a whole day after t230 landed green. Whoever
read the table to find out "where has it already moved" was misinformed by it.

**A code gate does not see paper.** Five children left the code impeccable and
the specifications citing `pergunta.criada` — with links to schema files that no
longer existed. A reader only found out by clicking. A surface with no gate rots,
and documentation is a surface.

**What was left is what nobody sweeps.** The API JSON's keys (§1), the event
envelope (§2.2) and the `data` keys (§2.4) have no citation gate in a document:
they are ordinary Portuguese words (`nome`, `motivo`, `campo`, `origem`) whose
cost in false positives, in prose, would pay badly for what it found. There is
drift there — `intake.md` still says that layer's errors speak Portuguese, and
`topografo-cost.md` says the same of its body's keys. It is the work of a ficha
of its own, with the kind of masking `no-portuguese-wire.test.ts` built for
source code.
