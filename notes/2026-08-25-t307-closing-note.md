# t307 — the notes keep the record and lose the positions

**Date:** 2026-08-25 · **Branch:** `ticket-307` · **Subject:** the redaction the
founder asked for before this repository is shared.

Four commits: the gate first and red (`cab219e`), the machine paths
(`225f7f2`), the four bets notes (`e567f79`), and this note. Sixteen files
changed, plus the new gate and this one.

The founder considered deleting the bets notes and chose redaction instead,
because they hold the record that the learning loop was never proven — the same
record `README.md` cites, in its own words, as evidence against itself. That
choice is the whole shape of this ticket: everything identifying comes out, and
everything unflattering stays in.

## The redaction table

| File | Thesis | Path | Why |
|---|---|---|---|
| `notes/2026-08-17-first-bets-run.md` | yes | yes | Round 1's gold miner, by name and ticker, with the third-party newsletter the thesis came from and the two index tickers it was benchmarked against |
| `notes/2026-08-17-second-bets-run.md` | yes | yes | Round 2's uranium producer, by name and ticker, three named research outlets, one of its own filings, and the identity-bearing context below |
| `notes/2026-08-18-third-bets-run.md` | yes | yes | Round 3's closed-end fund and its issuer, the activist counterparty, five filing form types, six precedent tickers, three source sites |
| `notes/2026-08-18-n3-round.md` | yes | yes | The same fund by ticker, and one filing-source name in the cost hole |
| `notes/2026-08-15-first-execution.md` | — | yes | One scratch repository for the tic-tac-toe build |
| `notes/2026-08-17-t109-game-feature.md` | — | yes | Two scratch trees and the game's own repository, ten occurrences |
| `notes/2026-08-18-game-feature-2.md` | — | yes | The bench clone, a scratch tree and the game's own repository, nine occurrences |
| `notes/2026-08-24-t299-closing-note.md` | — | yes | One path into this repository's own checkout, reduced to the repo-relative form |
| `notes/execution-monitoring-prompt.md` | — | yes | The board's checkout and database, three literal `sqlite3` command lines, and the on-duty releaser's tree |
| `specs/formats/skill-manifest.md` | — | yes | One citation of the reference skill file |
| `specs/events/taxonomy.md` | — | yes | One citation of the reference event model |
| `tests/graph-schema.test.mjs` | — | yes | One doc-comment citation of the reference state machine |
| `packages/core/test/cli-skill-import.test.ts` | — | yes | One doc-comment citation of the fixture's origin |
| `packages/core/src/cli/skill-import.ts` | — | yes | One doc-comment naming the two import targets |
| `tests/notes-redaction.test.mjs` | — | — | New: the gate |
| `notes/2026-08-25-t307-closing-note.md` | — | — | New: this note |

Two notes the ticket named as candidates and left out were re-checked against
the tree and are genuinely untouched: `notes/2026-08-18-action-plan.md` and
`notes/2026-08-24-bets-assimetricas-closing-note.md` carry neither a position
nor a path.

## The five non-note files: real paths, not illustrations

The ticket as filed guessed that some of these five were illustrative example
paths that could stay. They are not, and the reason is the same in all five:
each is a **citation of a document that was actually read**, in a sentence whose
whole point is that the reading happened. "Checked line by line against" a path
is a provenance claim; an illustration would not need a home directory in it.
Two of the five point at the board's own repository and one at a second private
sibling; the fixture in `packages/core/test/` is described as "a verbatim copy
of" its source, which is only true of a real file.

All five got the same fix: **drop the home-directory prefix, keep the relative
in-project path and the project name.** So a citation becomes "flowpilot's
`app/models/ticket_event_model.py`". The bare word stays deliberately — it is a
documented behavioural reference (D17) named across the specs, and hiding the
word would have made five citations unreadable while protecting nothing. What
was secret was the layout of one machine, and that is what left. The gate holds
both halves at once: neither home-prefixed form may appear in those files, and
each must still say the name.

Nothing else in those five files was touched — no assertion, no code, no
neighbouring line.

## The line between the run and the asset

The ticket says to keep every mechanical fact and to remove every identity, and
does not say where the boundary falls for the market data sitting between them.
The default taken, and the one to argue with if it is wrong:

- **The graph's own mechanics stay to the digit.** Node names, verdicts,
  durations, session counts, token counts, cache figures, costs, premise
  counts, the asymmetry ratios and the scenario weights. These are the record of
  what the software did, and they are the reason the notes were kept.
- **The asset's market data becomes relative.** Absolute share prices, per-unit
  commodity prices, subsidiary valuations, exact dated discount readings and
  exact historical drawdowns are stated as proportions of each other instead. A
  floor is "45% of the market price"; a realised price is "roughly a quarter
  below the term price". The argument survives intact; the lookup key does not.

The second bullet is the part a grep would never have produced, and the ticket
was right to warn about it. Three sentences named a position with the name
already removed: an exact statutory citation, an exact ownership percentage in a
named subsidiary, and a dated realised price quoted against a term price.
Any one of those is a search away from the company for a reader who knows the
sector.

Two dates were treated as the asset's rather than the run's and generalized: a
tender's commencement date and the spring filing date behind it. Every date
belonging to an execution — every round's own timestamps, the quota kill at
13:50Z, the 2026-08-18 the collection reported against — is untouched.

## The record that had to survive, and did

`README.md` cites `notes/2026-08-18-n3-round.md` for the claim that the learning
loop stands at n=1, with no version B and no A/B measurement, and
`tests/readme-status-claims.test.mjs` (AT7) pins that citation. After the
redaction the note still says, word for word:

- `n=1 on version A`
- `no A/B measurement exists`
- `US$ 9.3 for nothing usable`

So the README's citation is still literally true, and AT7 is green for the same
reason it was green before. `notes/2026-08-18-third-bets-run.md` likewise still
carries its six sessions, its five node names, the verdict `morta`, the claim
that every report was accepted by the skill schema at the first attempt, and the
≈ US$ 6 it cost. The gate asserts all of that positively, which is what makes it
more than a blocklist: a redaction that quietly softened the n=1 admission would
pass any list of forbidden words ever written.

## Gates

`npm test` green, both groups: root 351 (342 before this ticket, +9 from the new
gate), workspaces 1,555 unchanged. `npm run lint` green. `npm run typecheck`
green.
