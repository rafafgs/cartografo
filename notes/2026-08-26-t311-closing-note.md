# t311 — the migrations read in English, and not one of them changes name

**Date:** 2026-08-26 · **Branch:** `ticket-311` · **Subject:** 1,494 Portuguese
diacritics inside 23 migration files whose NAMES are frozen permanently, and
the checksum ledger that had to be tripped on purpose to get them there.

Three commits plus this note: the sweep first and red (`489040d`), the
twenty-three translations (`b9e6be5`), the README paragraph (`c7595e9`).

The ticket's measurement held exactly. 1,494 diacritics before, 0 after. The
sweep's own count, which reads comment spans rather than raw bytes, found 652
offending lines across 23 of the 24 files, with
`0024_graph_version_contracts_state.sql` already at zero — the ticket predicted
that file would need nothing, and it needed nothing.

## The distinction this ticket is entirely about

A migration file NAME is a primary key. It is what `schema_migrations.id` holds
in every database that has ever run, so moving one replays a migration that
already applied. D24 froze the names for that reason and
`tests/no-portuguese-path-segments.test.mjs`'s `FROZEN_TREES` is what holds it.
A `--` comment above the DDL is prose, and D24 is about prose. Both facts live
in the same file without touching, and this ticket is the one that acts on the
second without disturbing the first.

The proof is mechanical rather than argued:

- `ls packages/core/migrations | sort` captured before the first edit and after
  the last is byte-identical — 24 names, `diff` silent (AC2/FR2);
- the SQL of all 24 files with every comment span cut is byte-identical to
  before, 355 non-blank code lines, `diff` silent. That check was re-run after
  every single file, not once at the end, and it is what made a full-file
  rewrite safe to do at all.

## FR3 — no SQL identifier moved, and four Portuguese ones are still there

The refinement's check re-runs clean: strip every line's trailing `--` comment,
scan the remainder for a diacritic across all 24 files, zero hits. That was true
before the translation and it is true after it.

But the check has a blind spot the refinement could not have seen, and it turned
up when a wider scan (Portuguese word stems, not just diacritics) was run over
the same stripped SQL. **Four column names are Portuguese and carry no diacritic
at all**, so no diacritic-based sweep will ever see them:

| column | born in | why it stayed |
|---|---|---|
| `job.corpo` | `0006_intake.sql` | no row in `docs/spec/glossary-wire.md` §4.2 |
| `job.criterios_de_aceite` | `0006_intake.sql` | same |
| `session.transcricao_truncada` | `0009_sessao_transcricao.sql` | §4.2 maps `transcricao` -> `transcript` and neither of these two |
| `session.transcricao_tamanho_original` | `0009_sessao_transcricao.sql` | same |

None of them is new information to the repository — `src/repositories/job.ts`
and `src/repositories/session.ts` both open with a paragraph explaining why the
column stayed, and the migrations' own headers say it too. They are left exactly
as they are, per the ticket's Out of Scope: renaming a live column is a schema
decision for a ticket with the live schema in view. **The English comments
around them now explain the Portuguese names in English**, which is the most this
ticket could honestly do.

Per the founder's explicit instruction on this ticket, no follow-up ticket was
opened for this or for anything else below.

## FR1 — what was translated, and the three judgement calls inside it

927 comment lines across `0001_init.sql` through
`0023_schema_migrations_checksum.sql`. Every ticket and decision reference is
verbatim (`t118`, `D13`, `t279`, …), and no backticked span was translated.

Three calls the ticket did not settle:

**1. Two annotations name format keys, and both were stale.** `skill.source`'s
shape read `{tipo, repo?, ref?, importado_por?, importado_em?, revisado_por?}`
in `0005_skill.sql`, while `0019_skill_versao.sql` — the migration that
recreates that very table — already spells the same six keys
`{type, repo?, ref?, imported_by?, imported_at?, reviewed_by?}`. The same for
`intake_draft.items` in `0006_intake.sql`, whose keys t255 moved to English.
Both were rewritten to the spelling the format carries today: the same keys,
none added, none dropped, and 0005 now agrees with 0019 instead of contradicting
it. Neither annotation tripped the sweep — no diacritic, no stopword — so this
was a choice, not a forced move.

**2. A quotation of a Portuguese source is translated, not glossed.**
`0021_proposta_dedupe_key.sql` quotes the cost lens's own comment ("it does not
deduplicate. Running twice over the same telemetry creates repeated
proposals"). D24 allows a verbatim Portuguese quotation, but a verbatim one here
would leave the sweep permanently red over a sentence that says nothing English
cannot. The `(literally "...")` gloss was not used anywhere in these 23 files:
no rendering flattened a nuance the Portuguese carried, so inventing a gloss
would have been decoration.

**3. Two migrations quote a third one's header, and the quotations moved with
it.** `0019_skill_versao.sql` quotes `0005_skill.sql` and
`0022_execucao_finalizada.sql` quotes `0003`. Both now quote the English those
headers say today, which is the only way the quotation stays a quotation.

## Findings — stale references the translation had to read past

None of these is Portuguese prose, so none is this ticket's to fix, and none
trips any gate. They are recorded here because a translator has to read every
line of a file and is therefore the person most likely to notice.

**Six citations name things that were renamed after the migration landed.**
t303 renamed three packages and t306 renamed the factory-graph node ids, and
the citations inside `packages/core/migrations/` did not move with them — unlike
`notas/` -> `notes/`, which t305 did update inside these same files.

| where | says | is now |
|---|---|---|
| `0010_proposta_aprovada.sql:4` | `packages/tela/src/public/actions.js` | `packages/screen/...` (t303) |
| `0017_trabalho_tier.sql:13` | `docs/spec/topografo-cost.md` | `docs/spec/surveyor-cost.md` (t303) |
| `0021_proposta_dedupe_key.sql:6` | `packages/topografo-custo/src/cli.ts` | `packages/cost-surveyor/src/cli.ts` (t303) |
| `0020_sessao_saida.sql` | `Session.saida`, aliased by the repository's `SELECT` | `Session.output`; t290 removed the last alias |
| `0020_sessao_saida.sql`, `0006_intake.sql` | nodes `implantar`, `integrar`, `refinar` | `deploy`, `integrate`, `refine` (t306) |
| `0012_motor_modelo.sql` | `no.model` in the graph schema | the document's key is `nodes` since t178 |

**`0011_sessao_orcamento_silencio.sql` names itself `0010` on its own first
line.** A pre-existing typo, preserved verbatim rather than quietly corrected:
the file's real number is 0011 and every other header in the series numbers
itself correctly.

## FR4 — the sweep, and why it is not a fifth copy of two regexes

`tests/no-portuguese-migration-comments.test.mjs` imports `DIACRITIC`,
`STOPWORD`, `GLOSS` and `blank()` from `scripts/no-portuguese-prose.mjs`, the
same four signals `tests/no-portuguese-reader-documents.test.mjs`,
`tests/no-portuguese-factory-bundles.test.mjs` and
`packages/core/test/no-portuguese-glossary-prose.test.ts` stand on. What stays
local is the part that is this gate's own — WHICH span to point them at — which
is exactly the split that module's header describes and t287 recorded before it.

Three cuts, all blanked rather than dropped so a failure names the right line:

- **the `--`-to-end-of-line span, and only it.** FR3 leaves every SQL identifier
  in place, so a gate that read the DDL would be red for a reason no comment
  edit could fix. `commentStart()` walks the line tracking quote state rather
  than splitting on the first `--`, because a `--` inside a quoted literal opens
  no comment — no migration has one today, and the walk is what makes the
  "SQL is out of this sweep" guarantee true rather than lucky;
- **backtick spans**, because `` `job.criterios_de_aceite` `` mid-sentence is a
  column name and not a word of the sentence. This one has teeth: the proposal
  operation shape `` `{tipo, no_id, campo, de, para, inversa}` `` carries the
  stopword `para`, so a sweep that did not cut backtick spans would go red on a
  correctly-preserved wire key;
- **the gloss**, D24's one sanctioned Portuguese survival.

Six assertions: the real sweep, a blindness guard (>= 24 files, 0001 and 0024
both present), one that the sweep bites on synthetic Portuguese, one that it
spares an English comment quoting a backticked identifier or a gloss, one that
the SQL body is invisible to it, and one that a blanked line keeps its length.
Five of the six were green while the main one was red — which is what made the
red a valid red rather than a broken gate.

## FR6 / AC4 — executed, not reasoned about

The freshly-created worktree had no `.cartografo/` of its own, so the whole
sequence below was run for real here.

1. **Empty database, translated migrations.** `npx cartografo` printed
   `cartografo.ready` with `migrationsApplied: 24` and a `bootstrapToken`. All
   24 rows carry a non-null checksum (`SELECT count(*), sum(checksum IS NOT
   NULL)` -> `24|24`).
2. **Second start, same database.** `migrationsApplied: 0`,
   `bootstrapToken: null`, no error — the guard reconciled all 24 recorded
   checksums against the translated bytes and passed.
3. **The break, reproduced deliberately.** A database was created from the
   PRE-translation migrations (checked out at `489040d`), the translated files
   restored, and the control plane started against it. Exit 1:
   `applied migration changed on disk: "0001_init" ran with content sha256:ce8354…,
   and 0001_init.sql is sha256:319075… today`. That is this repository's own dev
   database, exactly, and the error names the file just as the README now says
   it does.
4. **The remedy, run for real.** `rm -rf .cartografo/` and `npx cartografo`
   again: `migrationsApplied: 24`, a new `bootstrapToken` issued. The README
   paragraph is evidence-backed rather than argued.

## FR5 — the README paragraph

A new paragraph inside the existing callout, immediately after the sentence
ending at what was line 118, not a section of its own: it is the same shape of
break at the exact decision point a reader already lands on. It says the symptom
(`npx cartografo` refuses to start, naming the migration), the cause (t279's
checksum ledger doing its job, not failing) and the fix
(`rm -rf .cartografo/` && `npx cartografo`, which reissues the bootstrap token),
and it names D20 and t311 as the two times this project has done it on purpose
— the same way the paragraphs above it name t279 and D20.

## The authorization, and its limits

The refinement stopped at the checksum question rather than working around it,
and the founder (Rafael) authorized proceeding, case by case, on the same
precedent as D20 (2026-08-16). What makes the cost acceptable is narrow and
worth writing down: there is no production data (D1, pre-launch), the only
database that breaks is a development one, and anyone cloning the repository
from here on starts from empty and never meets the error at all. The one
shortcut that would have hidden the problem — patching the recorded checksum —
was never taken, and would have defeated precisely what t279 exists to catch.

## Operator action still owed

**The main checkout's own `.cartografo/` will refuse to boot** once this branch
is integrated: its `schema_migrations` rows carry the pre-translation checksums
for 0001-0023. The fix is the one this note and the README both name, and it is
a hand action, not something this ticket ships:

```
rm -rf .cartografo/ && npx cartografo
```

The database is new afterwards, so **a fresh `bootstrapToken` is printed and the
old one stops working** — it is the only time that value ever appears, so it has
to be captured from that line. Every other checkout of this repository that has
ever started the control plane needs the same treatment, once.

## Gates

`npm run lint`, `npm run typecheck` and `npm test` (both the `workspaces` and
`root` groups, 367 root tests) all green, run in full after the last edit.
`packages/core/test/startup.test.ts`'s twenty-four-migration assertion,
`packages/core/test/migrate.test.ts`'s t279 AT6-AT10 checksum tests and
`tests/no-portuguese-path-segments.test.mjs`'s `FROZEN_TREES` exclusion all pass
unchanged — the last of them being the standing confirmation that no file name
moved.
