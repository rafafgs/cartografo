# t300 closing note — the internal record, in English, and the gate over the whole tree

**Subject:** `especificacoes/**`, all thirteen Portuguese `notas/`, `schema/**`,
the three configuration files of FR6, and the new sweep over the document tree.
The third and last of the tickets t281 was split into on 2026-08-24.
**Commits:** `5a94e6d` (tests, red at 1 name and 1,930 lines), `9a944b6` (the
shared primitives), `9c02bcb` (the renames and every citation of them), then five
translation commits ending at `1ec0f3d`, then `0dcec21` (the line anchors), on
`ticket-300`.
**Written:** 2026-08-25, during development, following t299's, t281's and t293's
precedent.

## Line counts

| | Before | After |
|---|---|---|
| `notas/**` (13 translated + 7 touched) | 1,459 Portuguese lines of 2,740 | 2,807 lines, 0 Portuguese |
| `especificacoes/**` markdown | 1,301 | 1,321 |
| `especificacoes/eventos/schemas/**` | 119 prose strings | 119, all English |
| `schema/exemplos/**` (11 fixtures) | 1,165 | 1,165 |
| `schema/grafo.schema.json` | 57 Portuguese descriptions | 0 |
| `.github/workflows/ci.yml` + 2 configs | 85 + 33 + 27 | same, comments moved |

Real edit volume: `notas/` **+1,551 / −1,484**, `especificacoes/` **+2,472 /
−2,432**, `schema/` **+163 / −163**, `packages/` **+219 / −217**, `docs/`
**+58 / −58**. The rename half is measurable on its own: `9c02bcb` is **169
files, +807 / −805** — thirty-five files moved and 139 files whose only change is
a single-token citation swap.

## What the ticket did not know it was taking

Four surfaces, in order of how much they cost.

### 1. `especificacoes/eventos/schemas/**` was not "already English"

The ticket's Schema/Data Changes section says those twenty-one JSON Schemas "are
unaffected". Their KEYS and their file names were English; their **119 `title`
and `description` strings were Portuguese**, and the new sweep reads JSON raw. The
same is true of `schema/grafo.schema.json`, 57 more.

Both are inside the trees FR8 declares, and FR10 forbids a content allowlist, so
the three requirements only close together if the prose moves. It did — with no
key, no enum value and no `$ref` touched, which is the reading of "unaffected"
that survives: no structural change to a schema, only to the sentences that
explain it.

### 2. The reference reducer has three consumers, not two

FR3 names `exemplos.test.mjs` and `replay.test.mjs`. The third is
`packages/core/test/replay-consistency.test.ts`, which imports `reconstruirEstado`
by name and mirrors all six projections in a local interface — and whose own
header said the reducer's keys "stay in Portuguese … outside this ticket's rename
scope (t127, FR8)". It is the one file where the rename could have gone quiet
instead of red: TypeScript would have failed on the import, but only after the
control plane had booted.

### 3. Nine citations carry a line anchor into text this ticket rewrote

The ticket named two (`atlas-bundle.md`, `engine-adapter.md`). There are eighteen
citation sites across six anchors, and they reach into `packages/runner/src/`,
`packages/runner/bin/` and four test files as well as the two format documents.
Six moved, three did not; all nine were re-read against the final text. The table
is in `0dcec21`.

### 4. `packages/core/test/skill-routes.test.ts` pins the negative fixture by id

AT8 greps the refusal message for the broken check's id and AT9 reads back
`GET /v1/skills/<the fixture's id>`. Both ids moved with the translation, and both
tests went red on the full run — the only two failures of the whole ticket that
were not the expected translation red.

## The sweep, and the one thing it needed that the ticket did not specify

`tests/no-portuguese-document-tree.test.mjs` does what FR8 asks: path segments
across `docs/`, `especificacoes/`, `notas/`, `schema/` and the two root documents;
contents fence-and-span-aware for `.md`, raw for `.json`/`.jsonl`.

**One exception had to be added to the raw JSON read: a string value that is
ENTIRELY a URL or a hostname.** `com` is one of the seven stopwords and also the
commonest TLD there is, so `"github.com"` in the develop manifest's `domains` list
reads as Portuguese prose. t299 met the same thing twice in markdown and answered
it with a code span — an escape hatch JSON does not have, and one FR10 forbids
replacing with an allowlist entry. Only the whole string counts: a hostname inside
a sentence is still read, and AT4 pins both halves. It is a latent hole in the
approach `no-portuguese-factory-bundles` established, not a defect this ticket
introduced; that gate would red the day a bundle declares a `.com` domain.

**The carve-out list is honest about being bookkeeping.** FR10's five segments —
`especificacoes`, `notas`, `eventos`, `formatos`, `exemplos` — carry neither a
diacritic nor a stopword, so removing an entry would not turn the gate red on its
own. What gives the list teeth is AT3's third assertion: every entry has to name a
segment the tree really has. The day t282 renames one, the entry goes stale, the
gate reds, and the reason text gets read by whoever is standing there.

**`docs/spec/glossario-wire.md` is content-carved-out**, which FR8 did not
mention. It is permanently t281's, its rows are written in retired Portuguese
names by design, and t299's sweep carves it out for the same reason. Its path
segments are still read; only its lines are spared.

## FR9: the extraction was clean, with one correction to the premise

`DIACRITIC`, `STOPWORD` and `GLOSS` were byte-for-byte identical in
`tests/no-portuguese-reader-documents.test.mjs` and
`tests/no-portuguese-factory-bundles.test.mjs`, exactly as the refinement found.
**`blank()` was not**: it exists in the reader-documents sweep and does not exist
in the factory-bundle one, which has no spans to blank. It still moved, because
the new sweep needs it and a fourth copy would have been the third.

So `scripts/no-portuguese-prose.mjs` holds four primitives shared by two, three,
two and two consumers respectively — not four shared by two.
`scripts/no-portuguese-prose.test.mjs` pins the three expressions against their
pre-refactor source text by `toString()`, which is the only thing that catches the
failure mode that matters: a gate that goes quiet instead of red.

What deliberately did NOT move is each gate's scanning STRATEGY. That is t287's
distinction, and it is why this is a four-constant module and not a shared sweep.

## Values corrected rather than translated

Nine, all of them retired wire vocabulary that the schema in the next directory
already contradicted. A reader copying any of the first seven would have written
an event the format refuses:

| Where | Was | Is | Contradicted by |
|---|---|---|---|
| `taxonomy.md` §envelope | `entity.type: "sessao"` | `"session"` | `envelope.schema.json`'s enum, since t227 |
| `taxonomy.md` §permission_denied | `resource ∈ filesystem, rede` | `network` | `session.permission_denied.schema.json` |
| `taxonomy.md` §auto_resolved | `based_on: "recomendacao"` | `"recommendation"` | `input_request.auto_resolved.schema.json` |
| `taxonomy.md` §input_request.created | `"type":"pergunta"` | `"kind":"question"` | the schema has no `type` in `data` |
| `taxonomy.md` §job.amended | `["corpo","testes_de_aceite"]` | `["body","acceptance_criteria"]` | the example log's own fields |
| `taxonomy.md` §parity | `entity {tipo:"trabalho", id}` | `{type:"job", id}` | the envelope |
| `taxonomy.md` §extensions | `graph_version.aplicada/.revertida` | `.applied/.reverted` | the schema file names |
| `taxonomy.md` §hook_failed | `status='entregue'` | `'delivered'` | migration `0008`'s CHECK |
| `taxonomy.md` §hook_failed | "t142's `entrega_webhook`" | "t142's webhook delivery" | no table by that name exists |

One sentence was **deleted** rather than translated: the note under
`graph_version.contracts_checked` saying that entry is in English while the ones
around it are Portuguese. It was true when t283 wrote it, and this ticket is what
makes it false — the D18-sentence precedent, applied in the direction that
removes rather than preserves.

## Phrases that resisted, and names that stayed

1. **`nota-curta` stays Portuguese, and `desenvolvimento-de-software` with it.**
   The ticket protects the second by name. The first turned out to be the same
   kind of thing, found rather than given: it is spelled as a literal in
   twenty-five files across five packages, all outside this ticket's surface, and
   it trips neither signal. Moving it in the fixture alone would have left the tree
   with two names for one example class. Its derivative could not stay —
   `nota-curta-com-ganchos` carries `com` between hyphens — so that one became
   `short-note-with-hooks`, with its single consumer following. The family is split
   on purpose, and this paragraph is why.
2. **`contexto_falha` and `perguntas_respondidas`** stay in the two example
   manifests, annotated in place. They are the projection names
   `GET /v1/jobs/:id/context` really publishes, and `context.ts` and
   `domain-context.test.ts` both spell them. t280's closing note lists the same
   fourteen.
3. **The example manifests were rewritten, not word-swapped.** Their vocabulary
   had drifted from the bundle they teach: they said `input.ticket.titulo` and
   `gates: passou|falhou` while the live software bundle has dispatched on
   `input.job.title` and `passed|failed` since t280. An example that teaches a
   vocabulary nothing runs is worse than no example.
4. **`resultado` is still not written between backticks in
   `skill-manifest.md`.** t184's gate greps every inline code span of that
   document for a retired format key, and `resultado` is one — the manifest's
   field was renamed to `outcome`. The fenced report block is ```` ```resultado ````
   (a fence, not a span, and the runner's live `FENCE` constant), and the paragraph
   explaining why the routing key is named in prose is now in English and still
   says it.
5. **A slip preserved.** `2026-08-15-closed-learning-loop` writes "`de` and
   `depois`" for the two numbers of its own verdict line, which the table beside it
   records as `antes` and `depois`. It reads oddly in English and read oddly in the
   original. A translation moves language, not facts.

**Inline `(literally "…")` glosses used: 3.** The first real use of the
convention in this repository — t280 and t299 both reported an honest zero. All
three are quotations of Rafael's own instructions in the notes of 2026-08-18,
where the English rendering is what a reader needs and the original is what was
actually said.

## Gotchas

- **A `(literally "…")` gloss wrapped across two lines is invisible to the
  sweep**, for exactly the reason t299 recorded about backtick spans: `GLOSS` is
  matched per line. Two of the three glosses had to be reflowed onto one line
  each. Whoever uses the convention on a phrase longer than about sixty characters
  will meet this.
- **The same trap bit three already-English closing notes**, t280's, t281's and
  t299's. Their Portuguese quotations were correctly inside backticks and the
  sweep saw them anyway, because the span wrapped. Reflowed, not reworded — the
  quotations are unchanged.
- **`.com` is a Portuguese stopword, in markdown too.** The market note's
  fourteen bare source URLs all tripped. They are code spans now, which is what
  t299 did to `engine-adapter.md`'s three.
- **`STOPWORD` carries no `i` flag**, and never did: a capitalised `Uma` opening
  a sentence goes unseen. Pinned as a fixture in
  `scripts/no-portuguese-prose.test.mjs` rather than fixed — widening the
  expression is a change to three gates at once, and belongs to whoever measures
  the cost.
- **`scripts/check-engine-adapter-spec.test.mjs` is flaky under a parallel root
  run**, which t299's closing note already recorded for AT1. It failed here on AT2
  with "no table row for 'event harvesting'" and passed immediately on its own,
  with the row present in the document and no edit between the two runs. Not caused
  by this ticket; worth knowing before anybody bisects it.
- **`git ls-files` and not a filesystem walk.** A translation ticket leaves
  renamed files behind in a dirty checkout, and an editor backup under `notas/` is
  not part of the tree the gate makes a claim about. Same reading as
  `tests/decisions-rename-integrity.test.mjs`.
- **Recomputing a manifest pin in another language is a two-line script, and it
  has to be checked against the JS one.** All three example hashes were recomputed
  in Python; what says they are right is that `skill-manifest.test.mjs` reproduces
  each of them from the canonical subset with its own implementation.
- **A path segment check is weak, and the header says so.** Of every Portuguese
  name in the tree before this ticket, the two signals could reach exactly one:
  `grafo-valido-com-ganchos.json`. `notas/2026-08-14-mercado.md`,
  `manifesto-skill.md` and `taxonomia.md` all went unseen. The check is still worth
  having — nothing else in this repository reads a file name — but it catches a
  reintroduction, not a survival.

## Definition of Done

- **No D24 entry was added** to `DECISIONS.md`. The file still stops at D23, and
  recording the decision that governs this very ticket is the founder's act.
- **`.flowpilot/profile.yml` was not touched** and could not be: it is gitignored
  and does not exist in this checkout, exactly as t299 found. Its stale
  `notas/2026-08-14-*` references will keep pointing at the old names until the
  flowpilot tooling regenerates it.
- The seven per-package `no-portuguese-*` sweeps under `packages/*/test/` were not
  touched, per the ticket's Out of Scope and t287's finding.
- No standing citation-integrity gate for `notas/` path references was added. The
  repair is grep-verified above; the gate is worth a follow-up ticket, and the
  ticket says so.
