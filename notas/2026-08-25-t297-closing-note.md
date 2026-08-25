# t297 closing note — the licence that was only declared, and the line that was six days old and two hundred tickets stale

**Subject:** `LICENSE`, `README.md:6-9`, and the two gates that pin them.
**Commits:** `37898a6` (the gates, red at AT1-AT3 and AT5-AT7), `9ab7fa5`
(`LICENSE`), `c6a62c1` (the status line), on `ticket-297`.
**Written:** 2026-08-25, during development, following t300's and t303's
precedent.

## What each added claim is standing on

Every sentence the status line now makes, with the line of the note it came
from. Nothing here is inferred from the code; all of it is somebody's recorded
observation of a run that happened.

| The README now says | Source |
|---|---|
| a control plane, a runner, a screen and the two factory graphs of D14 | `packages/core`, `packages/runner`, `packages/screen`, `factory-graphs/{desenvolvimento-de-software,bets-assimetricas}` — and the README's own "How to run it", whose four commands resolve to the four `bin` entries |
| the software graph ran `refinar → desenvolver → integrar → testar → implantar` | `notas/2026-08-18-game-feature-2.md`, the node-by-node table and the `Path:` line under it |
| five nodes by agent, five reports accepted at the first attempt, no human gate opened, no operator | same note, same paragraph, verbatim: "Five nodes by agent, five reports accepted at the first attempt, no human gate opened, no operator action" |
| 15 minutes, around US$ 12 | same note: "The whole traversal took 15 minutes"; cost table, "**total** ≈ US$ 12 (cap 25)" |
| the bets graph ran `triagem → coleta-fundamentos → analise-assimetria → red-team` | `notas/2026-08-18-third-bets-run.md`, the `Path:` line |
| 8 objections, 2 of them high, verdict `morta` | same note, session 5 row: "**`morta`** — 8 objections (2 high), 1 high unanswered" |
| the `decisao` gate was never reached, with no operator | same note: "the `decisao` gate was not reached — the red team killed the thesis"; "The operator did **not** hand-carry anything" |
| the learning loop stands at n=1, no version B, the human gate never exercised, no A/B measurement | `notas/2026-08-18-n3-round.md`: "The n=3 round therefore has n=1 on version A (round 3, execution 3, complete) and no version B; the human gate was not exercised; no A/B measurement exists" |
| the round was stopped after the quota killed the same node twice | same note: `coleta-fundamentos` failed at sessions 3-6 on HTTP 429, the job blocked at 13:50Z and again at 16:12Z, and Rafael decided at 16:00Z not to repeat |

The two claims the README does NOT make, though the notes would support them:
the flow surveyor's proposal on the game round (it is pending and debatable, and
the note says so itself) and D16 parity, which is Rafael's judgement and not a
fact any note can record for him.

## The one thing the ticket said twice, differently

FR1 asks for the canonical text "with the appendix boilerplate's copyright line
filled in ... and **nothing else changed**". AT3 asks that `LICENSE` "ends with
the line `Copyright 2026 Rafael Gomes` and **nothing after it**". The canonical
file has twelve more lines after that one — the per-file header notice — so the
two cannot both be satisfied literally.

**AT3 was followed, and here is why it is the reading that holds.** AT2 and AT3
together partition the file with no gap: everything before the copyright line is
canonical byte for byte, and the copyright line is the last. Under the other
reading, AT2 pins the first 189 lines, AT3 pins one, and the twelve-line tail is
pinned by nothing — a hole in a gate whose whole subject is a text nobody may
retype. A ticket this precise did not leave that by accident.

It is also the reading that survives on the merits. The terms of Apache-2.0 end
at `END OF TERMS AND CONDITIONS`, on line 186; everything after is an APPENDIX
that explains how to apply the licence **to a source file**, and its boilerplate
is what you paste into a file header, not into a repository's `LICENSE`. What
this tree ships is every binding word, the appendix's explanation, and the
attribution of who holds the copyright. `licensee` — what GitHub detects a
licence with — strips the appendix before hashing, so the detection is unchanged.

If Rafael wants the full 202 lines, it is `head -189 fixture` becoming `cat
fixture` plus one `sed` on line 190, and AT3's last-line assertion becomes an
assertion about the appendix line. One commit.

**The indentation stayed.** The line in the file is `   Copyright 2026 Rafael
Gomes` with the appendix's three spaces, because FR1 changes the line's content
and not the formatting around it; AT3 reads it through `trim()`.

## FR3: the audit happened, and it came up empty

The refinement predicted this and asked for it to be recorded either way. Read
against `notas/2026-08-15-first-execution.md`, the four `notas/2026-08-17-*.md`
and the four `notas/2026-08-18-*.md`, no other present-tense claim in the README
is false:

- **"How to run it"** is the largest surface and the most checkable. Its four
  commands (`cartografo`, `cartografo-runner`, `cost-surveyor`,
  `cartografo-surveyor`, `cartografo-screen`) each resolve to a `bin` entry that
  exists after t303's rename; `factory-graphs/desenvolvimento-de-software` is
  the path step 3 imports and it is in the tree; the ports (4317, 4318) match
  the defaults the prose states.
- **"Pieces"** lists a *topology synthesizer* that does not exist, and that is
  not a false claim: the section is the design's parts, D6 orders the synthesizer
  last on purpose, and the new status line enumerates what runs today without
  it — so a reader has the boundary two screens above the list.
- **"Cheap prototype"** and **"The plan"** are the original conception and a
  roadmap. They were true as statements of intent when written and they are not
  claims about the present state. Left alone, per Out of Scope: the prose is the
  author's.
- The **origin sentence** of the old lines 6-9 is still true and is kept
  verbatim, moved to a paragraph of its own.

## Gotchas

- **The retired-claims blocklist reads prose, the citation checks read raw.**
  They have to. AT5 blanks fenced blocks and backtick spans, so a future table
  quoting what the README *used to say* does not trip it. AT6 and AT7 cannot take
  that cut: this repository writes a cited filename as a code span
  (`` [`notas/x.md`](notas/x.md) ``), and blanking spans would blank the exact
  token being searched for. Whoever extends either check should know which half
  they are in.
- **A paragraph is the co-occurrence unit, and lines are joined before matching.**
  The README wraps at eighty columns and a claim plus its citation routinely
  spans three lines, so `no A/B measurement` and `n=1` are matched against the
  paragraph with its newlines flattened to spaces. A regular expression run
  line-by-line would have missed both. This is the same trap t300 recorded for a
  `(literally "…")` gloss wrapped across two lines — per-line matching over
  eighty-column prose is a recurring hole in this tree's gates.
- **The fixture needs a digest or the diff is circular.** `LICENSE` is compared
  against `tests/fixtures/apache-2.0-license.txt`, and nothing would stop an
  editor from re-copying a broken `LICENSE` over the fixture to turn the diff
  green. AT2 pins the fixture by SHA-256
  (`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, fetched
  from `https://www.apache.org/licenses/LICENSE-2.0.txt` on 2026-08-25). That
  digest is the only assertion in the file about Apache's text rather than about
  this tree's copy of it.
- **`^\s*Copyright ` matches exactly one line of the canonical text.** Line 190.
  Section 2's heading spells the word too — `2. Grant of Copyright License` —
  but not at the start of a line, which is what keeps the anchor honest. A gate
  that grepped for the bare word would have split the file in the wrong place.
- **One red was mine, not the artifact's.** The first run of AT5's regression
  fixture failed because `State: idea on the record, pre-prototype.` trips TWO
  entries of the blocklist on one line, and the expectation named one. The
  expectation was corrected before the red was committed — a fixture that fails
  for its own reason is not a valid red, and the reported-once-per-claim shape is
  the better one anyway: a half-repair cannot go quiet.
- **`npm ci` before the baseline.** This checkout arrived with no
  `node_modules`, so the first `npm test` would have looked catastrophically red
  for reasons that have nothing to do with the ticket.

## Definition of Done

- Gates written first and confirmed red for the right reason: AT1-AT3 on a
  missing `LICENSE`, AT5-AT7 on an uncorrected `README.md`. **AT4 was green from
  the first run** — `package.json` has declared `"license": "Apache-2.0"` since
  before this ticket, and AT4 pins that agreement rather than creating it.
- `npm test` (333 root tests plus every workspace group), `npm run lint` and
  `npm run typecheck` all green on the final tree.
- **No `NOTICE` file, no badge, no contributing guide.** Out of Scope names all
  three, and an Apache-2.0 repository with no third-party notices to pass on does
  not need a `NOTICE` anyway.
- **No D24 entry was added** to `DECISIONS.md`, which still stops at D23. Same
  boundary t300 and t303 recorded: recording a decision is Rafael's act.
- **No file outside the ticket's declared surface was touched.**
