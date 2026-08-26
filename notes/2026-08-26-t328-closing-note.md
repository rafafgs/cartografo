# t328 — three buckets, thirty-five lines, and a premise that was wrong

**Date:** 2026-08-26 · **Branch:** `ticket-328` · **Subject:** the example
payloads inside fenced blocks, classified against the source rather than against
what they look like — and the ticket's headline fix, which turned out to be a
thing the repository had already decided not to do.

Six commits: the pinned inventory red on all thirty-five lines (`74c7c62`), the
corrections and translations (`a985547`), a pre-existing red on the branch that
was not this ticket's to cause (`fd9a082`), this note (`27ae8e9`), that same
pre-existing fix dropped in favour of main's (`75cba61`), and the two excused
blocks stated as cases — which is also where this note gained the founder's
answer.

## The premise that was wrong, first, because it is the headline

The ticket's Definition of Done asks that `docs/spec/intake.md`'s opening item
example (lines 50-55) "contains no Portuguese content", and the Context calls it
"the most visible" occurrence in the tree. **That item is not a defect and never
was.** This is not a scope change — the ticket's premise about that block was
wrong, the same way its predecessor's premise about seven "frozen" tokens was
wrong four times out of seven, and it is worth recording in those words.

`tests/t313-docs-specs-drift.test.mjs` AT7 is named *"intake.md keeps its
submitted-content example, on its own reason"* and asserts that the document
still contains all three strings verbatim:

```
'"Migração 0005"',
'"Colunas novas em trabalho e as duas tabelas do intake."',
'"a migração roda do zero"',
```

Its reason, in its own comment, is not "nobody got round to it":

> Not an oversight and not a leftover: intake accepts an item in ANY language,
> and a submitted item is USER content — it is not prose this project writes,
> which is the whole of what D24 governs. The example is what a request in some
> other language actually looks like on the wire, and translating it would leave
> the spec illustrating the one case that needs no illustrating.

That comment also records that t314 already re-litigated this once and that the
founder ruled on it — t314 dropped a *circular* cross-check (AT7 was the reason
two test fixtures could not be translated) but deliberately kept AT7 itself,
"on the reason that was always the real one".

**The founder's ruling, 2026-08-26:** keep the example Portuguese, close t328
without that DoD item, record §2 as a fourth excluded case beside §7's verbatim
transcript, and open no follow-up — there is nothing left open to follow up on.
And the reason is stronger than "an exception": *"That is not an exception to
D24; it is D24 applied correctly, which is why it deserves to be stated as a
case rather than buried as a skip."* D24 governs the prose this project writes.
A submitted item is not that.

So `docs/spec/intake.md` §2 is a **fourth case**, structurally identical to §7's
verbatim transcript that FR3 already excludes: a fenced block the document tree
keeps in Portuguese *on a recorded decision*. The refinement's three buckets have
no slot for it because the refinement never read AT7 — it is not in the ticket's
Context, its Out of Scope, or its shared-file surface.

Stated as a case, not buried: `EXCUSED_BLOCKS` in the new gate carries both
blocks with their fence ranges and their reasons, and AT3 asserts that no pin of
this ticket reaches inside either. For §2 it deliberately does **not** re-assert
the three strings against the document — AT7 owns that claim and had it first —
but reads them in `tests/t313-docs-specs-drift.test.mjs` instead, so that
retiring AT7 turns this gate red and names the decision rather than letting §2
drift on nobody's authority.

The whole example is held, not half of it. `"ref": "migracao"` and
`"depends_on": ["dominio"]` carry no diacritic and AT7 cannot see them, so they
*could* have been changed with nothing going red — and the result would have been
a half-translated payload, which is worse than either whole one. That is FR2's
own rule, and it applies to a block split by a gate exactly as to one split by
carelessness. `docs/spec/intake.md:168` — the retired `depende_de_trabalho_id`
in §4 — is a different block and IS fixed.

### The pattern, named because it is now twice

The founder's words: *"The ticket was wrong, not you, and for the second time in
a row: t327's body named a file t312 had already pinned, and this body named a
block t313's AT7 had already pinned with a recorded rationale that t314 then
re-litigated and deliberately kept. Both times the pin was in a file the ticket
never declared, and both times the developer stage caught what the refinement did
not."*

The cheap fix is mechanical and belongs to refinement, not to development:
**before declaring a file's content a defect, grep the test tree for the strings
you intend to remove.** Both misses would have been caught by one `grep -rl` over
`tests/` and `packages/*/test/`. This ticket's shared-file surface lists seven
paths; the gate that actually blocked it is in none of them, because a gate that
pins a document is not a file the document's ticket thinks it shares.

## The three buckets, by file and line

Every Portuguese-shaped token found live in the six files, with the source that
settled it. The measurement was a word list rather than a diacritic class, as
the ticket asks — of the sixty-odd tokens below, exactly **four** lines trip
`DIACRITIC` or `STOPWORD`, which is why every sweep in the D24 family could have
read these files unblanked and still missed almost all of it.

### Bucket 1 — frozen wire. Verified live today; not touched, not pinned.

| token | where | what proves it is live |
|---|---|---|
| `nota-curta` | `transition-hooks.md:61` | `schema/examples/graph-valid-minimal.json:2`; `notes/2026-08-25-t300-closing-note.md:144` records it stays |
| `redigir`, `revisar` | `transition-hooks.md:64,65,70,217,297` | node ids in `schema/examples/graph-valid-minimal.json:49`, `graph-valid-with-hooks.json`, `tests/graph-schema.test.mjs:570` |
| `avisar-revisao` | `transition-hooks.md:68,297` | `schema/examples/graph-valid-with-hooks.json:99`; `packages/core/test/job-hooks.test.ts:66` |
| `gancho-revisao` | `transition-hooks.md:74,120` | `schema/examples/graph-valid-with-hooks.json:105`; `packages/core/test/hook-secrets.test.ts:84` |
| `intake-proposto.json` | `intake-generation.md:85` | `OUTPUT_FILE`, `packages/runner/src/intake/prompt.ts:63` |
| `tipo` (message prefix) | `webhooks-events.md:241` | `packages/core/src/routes/webhooks.ts:106` still emits it |
| `refinar` | `events-stream.md:306,307`, `webhooks-events.md:317,318` | node id in `schema/examples/graph-valid-flowpilot.json:15,251` |

The sixth row is the one worth remembering. `packages/core/src/routes/events.ts:118`
emits `type "…" is not in the taxonomy`; its sibling
`packages/core/src/routes/webhooks.ts:106` emits `tipo "…"` for the same check
against the same `KNOWN_TYPES`. The two specs quoting them therefore have to
disagree, and they now do. FR5's oracle is the literal the code sends, not the
tidier of the two.

### Bucket 2 — retired wire. Corrected, not translated.

Every one was already a row in `docs/spec/glossary-wire.md`; each was
re-verified against the source that emits the current name.

| file:line | was | is | oracle |
|---|---|---|---|
| `intake.md:168` | `depende_de_trabalho_id` | `depends_on_job_id` | glossary:429; `packages/core/src/db/event-validation.ts:244` |
| `human-escalation.md:47` | `motivo` | `reason` | glossary:278; `specs/events/taxonomy.md:165` renders the same example |
| `transition-hooks.md:123` | `valor` | `value` | glossary:642; `packages/core/src/routes/hook-secrets.ts:76-78` |
| `webhooks-events.md:52,310` | `segredo` | `secret` | glossary:628; `packages/core/src/routes/webhooks.ts:130` |
| `webhooks-events.md:53,70` | `tipos` | `filter_types` | `routes/webhooks.ts:132` and its docblock :24-25; glossary:629 |
| `webhooks-events.md:71` | `evento_inicial_id` | `initial_event_id` | glossary:630; `packages/core/src/repositories/webhooks.ts:70` |
| `webhooks-events.md:72` | `criada_em` | `created_at` | glossary:553; `repositories/webhooks.ts:71` |
| `webhooks-events.md:73,104` | `desativada_em` | `deactivated_at` | glossary:631; `repositories/webhooks.ts:72` |
| `webhooks-events.md:103` | `?projeto_id=` | `?project_id=` | `routes/webhooks.ts:158-161`; glossary:130 |
| `webhooks-events.md:240` | `segredo has to be…` | `secret has to be…` | `routes/webhooks.ts:81`, verbatim |
| `events-stream.md:71,241,314` | `?projeto_id=`, `?tipo=` | `?project_id=`, `?type=` | `routes/events.ts:93-95`, docblock :31 |
| `events-stream.md:211` | `tipo "…"` | `type "…"` | `routes/events.ts:118`, verbatim |
| `events-stream.md:221` | `esta rota exige…` | `this route requires…` | `packages/core/src/auth.ts:156`, verbatim |
| `intake-generation.md:93` | `{rascunho}`, `pendente` | `{draft}`, `pending` | glossary:172, glossary:303; `packages/core/migrations/0006_intake.sql:60` |

Three of these were not merely stale wording — a reader who copied them got a
`400`. `events-stream.md:241`'s `URLSearchParams({ tipo: … })` is a working
snippet the document invites you to run, and `tipo` has not been a query
parameter since t226.

### Bucket 3 — illustrative content. Translated.

| what | where | rendering |
|---|---|---|
| `meu-servico.exemplo` | `transition-hooks.md:73,213,298`, `webhooks-events.md:51,69,146` | `my-service.example` — the reserved TLD, and the same string in all six places (FR4) |
| `uma-string-longa-e-aleatoria-que-eu-escolhi` | `transition-hooks.md:123`, `webhooks-events.md:52` | `a-long-random-string-that-i-chose` (FR4) |
| `exemplo do doc` | `events-stream.md:115`, `webhooks-events.md:150` | `doc example` |
| `entrada` (as `entry_node_id`) | `events-stream.md:115,305`, `webhooks-events.md:150,316` | `entry` — it names no node in `factory-graphs/**`, `schema/examples/**` or `packages/*/src`; an invented placeholder |
| `nao_existe` | `events-stream.md:211`, `webhooks-events.md:241` | `does_not_exist` — the caller's own unknown type |
| `segredo`, `CARTOGRAFO_WEBHOOK_SEGREDO` | `transition-hooks.md:252`, `webhooks-events.md:188,257,261,284,310` | `secret`, `CARTOGRAFO_WEBHOOK_SECRET` — a local and an environment variable of the reader's own receiver, invented by the document (zero hits in `packages/**`) |

The demo titles `demo round` at `events-stream.md:305` and
`webhooks-events.md:316` were already English and stay byte-identical:
`tests/t313-docs-specs-drift.test.mjs` AT6 asserts the two specs print the
**same** demo round and compares those two titles to each other.

### The one token that is none of the three

`construir`, at `events-stream.md:307` and `webhooks-events.md:318`. It names no
node anywhere in the tree — so by the letter of bucket 3 it is content — but it
sits in a three-line demo whose other node id, `refinar`, is bucket 1
(`schema/examples/graph-valid-flowpilot.json`). Translating one and not the
other would print `from_node_id: "refinar"` transitioning to `to_node_id:
"build"`, which is worse than either. Left alone, and it belongs with the
flowpilot example's own Portuguese node ids in whoever's ticket audits those.

## What was read and deliberately not edited

**`docs/spec/graph.md` was read and excluded on purpose.** Its roughly fifteen
fenced JSON examples carry the same retired vocabulary at document-wide scale —
`nos`, `arestas`, `no_inicial`, `nos_finais`, `classe`, `linhagem`, `papel`,
`tipo_no`, `contrato`, `entrada_schema`, `saida_schema`, `verificacoes`,
`versao`, `descricao` — every one confirmed retired against
`docs/spec/glossary-wire.md` and `schema/graph.schema.json`. That is a
correctness audit, not a translation, and it is document-wide rather than a line
or two per file. `notes/2026-08-26-t314-closing-note.md` already found and
costed it and recommended a dedicated ticket; this ticket applied that
recommendation instead of re-deciding it. **Recommend opening that ticket**,
scoped to auditing every fenced example in `docs/spec/graph.md` against
`schema/graph.schema.json` and the wire glossary, folding in the illustrative
content once the keys are current — and widening it to `schema/examples/**`,
whose `graph-valid-flowpilot.json` carries `refinar`/`desenvolver`/`integrar`/
`testar`/`implantar` as live node ids and is what makes `refinar` bucket 1 here.

That recommendation is about `docs/spec/graph.md` and nothing else. **There is no
follow-up for `docs/spec/intake.md` §2** — the founder's answer is explicit that
nothing there is left open. If a later reader finds §2 and reads it as unfinished
work, this note and `EXCUSED_BLOCKS` are the answer: it is finished, and the
finished state is Portuguese.

`specs/events/taxonomy.md` and `docs/spec/synthesizer.md`: read in full, no
edit, as the ticket predicted. The taxonomy's fenced examples are already
English; its one Portuguese token, `ficha`, is established cross-repository
jargon pinned as Portuguese-on-purpose by
`packages/runner/test/no-portuguese-runner-tests.test.ts:273`. The synthesizer's
two tokens are both t309-settled frozen wire.

`docs/spec/intake.md` §7's captured transcript (lines 285-301): untouched, FR3,
and now pinned PRESENT by AT3 so that a later sweep cannot quietly tidy it.

Every backtick span outside a fence: FR6, t327's surface. This leaves a visible
seam and it should be named rather than discovered — `webhooks-events.md`'s
field table at lines 60-62 still reads `` `segredo` ``, `` `tipos` `` and
`` `projeto_id` `` directly beneath a fenced block that now reads `secret`,
`filter_types` and `project_id`, and its prose at 76, 81 and 108 does the same.
`transition-hooks.md`'s route table at 128-133 still reads `` `:nome` ``,
`` `{nome, criada_em}` ``, `` `{segredos: …}` ``, `` `usuario` `` and
`` `credencial_fora_de_escopo` ``. The ticket's Code Changes table names those
five as this ticket's work; FR6 and Out of Scope both say they are t327's. FR6
and Out of Scope won — the Code Changes column called them "§2.1's hook-secrets
block (≈lines 120-140)", and the fence there actually closes at 124, so what
looked like block content is prose. **t327 should land soon after this.**

## Why a pinned inventory and not a parser

FR9 refused the general fenced-JSON key-vs-value parser and the refusal holds up
under contact. The fences in this tree hold JSON, shell, SQL, HTTP frames and
ASCII-art diagrams with nothing declaring which is which — `intake-generation.md`
alone has a shell invocation, a box-drawing flow diagram and a JSON fragment. And
`docs/spec/graph.md` carries `de` and `para` as **required edge keys** inside
fenced examples; a generic unblank-and-mask-keys pass trips on them, and removing
them is a D20 reversal costed in t314's note. The pinned inventory is narrow and
honest about being narrow: it makes no claim about a line it does not name.

## AT5, run, and what it proves

The reintroduction proof (AC4) reverts a pinned line to its original Portuguese
**in memory** and never on disk. Reverting `docs/spec/transition-hooks.md:123`:

```
✖ the reverted line still passes
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + [
  +   'docs/spec/transition-hooks.md:123: expected "{\"value\": \"a-long-random-string-that-i-chose\"}", found "{\"valor\": \"uma-string-longa-e-aleatoria-que-eu-escolhi\"}"',
  +   'docs/spec/transition-hooks.md:123: stopword "uma" in {"valor": "uma-string-longa-e-aleatoria-que-eu-escolhi"}'
  ]
  - []
```

Both pins bite, which is the interesting part only because it is rare: this is
one of just two lines in all six files where the byte pin and the signal pin
agree. On the other thirty-three the signal pin says nothing at all — the
Portuguese there carries no diacritic and no function word — and the byte pin is
the whole gate. That asymmetry is the measurement this ticket started from, and
it is the argument for keeping both: the byte pin has no idea what language it
is holding, and the signal pin has no idea what the line is supposed to say. A
paraphrased revert (`"tipos_filtro"` for `"filter_types"`) is caught by the
first and invisible to the second.

The last loop of AT5 re-reads every pinned line off disk afterwards and asserts
it still equals `after`, so the proof cannot leave the tree dirty.

## Two files the ticket did not anticipate

**`tests/no-portuguese-repo-sweep.test.mjs`** — one word. `GATE_PATTERNS` became
`export const GATE_PATTERNS` so that AT4 can import the regex and test this
gate's own path against it, which is what the ticket asks for by name. No
assertion changed and AT6 (the sweep run unmodified) is green. Cross-test imports
are the established shape here: `tests/glossary-wire-rename-integrity.test.mjs`
and `tests/t313-notes-quotation-inventory.test.mjs` both do it already.

**`notes/2026-08-26-t314-closing-note.md`** and the `TOUCHABLE` list in
**`tests/notes-redaction.test.mjs`** — a pre-existing red, fixed twice by two
sessions that could not see each other. `npm test` was already failing at
`df4a2be`, the commit this branch starts from: t314's own note quotes
`docs/spec/graph.md`'s stale edge with backtick spans that WRAP, and `SPAN` in
`scripts/no-portuguese-prose.mjs` pairs backticks within one line by design, so
the mark was invisible and `para` was read as prose. The repository had already
met this exact incident one note earlier — see the
`notes/2026-08-25-t309-closing-note.md` entry in `TOUCHABLE` — and chose the same
fix: quotation onto one line, not one character of quoted text changed, note
declared. `fd9a082` did that here.

**Main had done it independently, as `a94dbac`, while this branch was working** —
same two files, same reflow, same `TOUCHABLE` entry, different wording, and
reported by the t327 session rather than this one. `a94dbac`'s parent is
`df4a2be`, this branch's own starting point. `75cba61` therefore drops this
branch's copy and takes main's bytes verbatim, on the founder's instruction: two
versions of one fix on the two sides of a merge is a conflict for nobody's
benefit, and main's is the shared history. **Whoever integrates should see no
conflict in those two files at all** — if one appears, take main's side, because
that is already what this branch holds.

The lesson generalises and is the reason main's commit calls twice in one day a
pattern: **in this tree, a marked quotation must fit on one line or it is not
marked.** Reflowing a paragraph can silently disarm a language gate, and nothing
warns you — not the author, not the renderer, not review.

## Gates

`npm test`, `npm run lint`, `npm run typecheck`, `npm run build` — all green.

One flake seen and not reproduced: `C9 — inactivity` in
`packages/runner/src/engine/conformance-kit.ts:737` failed once under a
concurrent load ("the session was stopped after 0 of 4") and passed on every run
since, including two consecutive clean full-suite runs. It is a watchdog
heartbeat test and it is timing-sensitive; nothing in this branch touches the
runner.
