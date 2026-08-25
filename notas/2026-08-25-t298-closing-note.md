# t298 closing note — the cap that was a decision, and the two measurements that made it a number

**Subject:** `packages/runner/src/dispatch/render-input-values.ts:40-97`, and the
three tests that pin it.
**Commits:** `6dc6856` (the five acceptance tests, red at the 16 KB constant),
`7354025` (the constant, its comment, and the two stale references it created),
on `ticket-298`.
**Written:** 2026-08-25, during development, following t297's precedent.

## The measurement AC1 asks for

| Bundle | Largest input-values block | Kind of measurement | Source |
|---|---|---|---|
| `bets-assimetricas` | **39.092 bytes** (`red-team`); `analise-assimetria` 34.209 | **production** — a real traversal, a live model, real collected fundamentals | `notas/2026-08-18-third-bets-run.md:149` (hole 1) |
| `desenvolvimento-de-software` | **2.070 bytes** (`test`) | **design shape only** — a fake engine against scripted fixtures, NOT a production figure | computed here; see below |

**`bets-assimetricas` drove the cap.** The new value is **65.536 bytes (64 KB)**,
≈ **1,68×** the largest block production has actually produced. The software
bundle's figure changed nothing: it clears the new cap by roughly thirty times,
and it cleared the old one too.

FR3's recommended default therefore stands unchanged. It was not raised further,
because raising it further would be headroom over a number nobody measured — the
exact defect this ticket existed to remove.

### How the software bundle's 2.070 bytes were obtained

FR2 asks for `JSON.stringify(selectInputValues(declared, input), null, 2)` per
node, using `test/controller/factory-graph-software.e2e.test.ts`'s own fixture
reports as input. The input each node sees was rebuilt with the real projection —
`buildNodeInput` (`packages/core/src/domain/context.ts`) — fed with:

- the graph's own `project` object, read from `factory-graphs/desenvolvimento-de-software/grafo.json`;
- the job the e2e creates (`atravessar o grafo de fábrica de software de verdade`);
- `REFINADO`, `DESENVOLVIDO`, `INTEGRADO`, `TESTADO_REPORT` as the reports closed
  before each node opens, merged into the bucket its node's `contract.produces`
  names;
- for `test` and `deploy`, the executor environment `resolve-executor-environment.ts`
  merges in (`banco_de_testes`, `referencia`).

Filtered by each manifest's own `input`, the five nodes render:

| Node | Manifest | Bytes |
|---|---|---|
| `refine` | `refine-ticket.json` | 1.378 |
| `develop` | `develop-ticket.json` | 1.708 |
| `integrate` | `integrate-branch.json` | 1.576 |
| **`test`** | `alpha-test.json` | **2.070** |
| `deploy` | `verify-release.json` | 1.790 |

**This is a statement about the SHAPE of that bundle's inputs, not their size.**
The distinction is the raw ticket's own and it is worth keeping: every one of
those reports is a one-line fixture written to make a dispatch resolve. A real
`refine` specification is the body of a ticket like this one; a real `develop`
report carries commits and touched files by the dozen. What the table proves is
that the software bundle's input shape has no large bucket in it the way bets'
`fundamentos.numeros` does — no node of it hands the next one a corpus. What it
does not prove is what those nodes weigh under a real ticket, and nothing on
record does, because that bundle has never carried one end to end with a live
model.

Per Out of Scope, the script that produced the table was a throwaway. FR6's
regression guard is the only permanent artifact left behind.

## Option 2 was not needed (DoD 6)

No bucket was dropped. A single measured cap with headroom clears both bundles'
known maxima — bets by 1,68×, software by ~30× — so bucket-level dropping was
never reached for, exactly as Out of Scope predicted.

## Two files the ticket did not name

Raising the constant made two texts state a number that had stopped being true,
and both were corrected in `7354025`:

- `docs/spec/runner-and-controller.md:842` — "cut at 16 KB with a marker" → 64 KB.
- `render-input-values.ts:142`, `grouped`'s own doc example (`16.384` → `65.536`).

Neither is a shared-file surprise in the scheduling sense: the spec line is one
word, and the second is inside a file the ticket already declared. They are
recorded here because a document left asserting the old cap would be a lie this
change itself created.

## What would make the new number wrong

The comment says it and the ratchet enforces it: a node whose collected input
outgrows 64 KB — a research class reading more than bets does, or a bundle that
hands a node a whole corpus instead of a summary. The symptom is the one this
ticket fixed, a session escalating over its own truncated `required` keys. The
answer is to measure that traversal's real block and raise the number again.
Lowering it is what `t298 — the cap never regresses under the bets bundle's
confirmed real maximum` exists to stop.

## What this ticket did NOT fix

The cap still cuts, and a block over 64 KB still loses its tail. Hole 1 of
`notas/2026-08-18-third-bets-run.md` listed three fix candidates and this is only
the third of them; the other two — rendering `input.required` keys FIRST and
capping the rest, and writing the full input to `entrada.json` in the session's
worktree — remain unbuilt, and either would make the cap a matter of ordering
rather than of loss. Both were out of scope here. What changed is that a research
node's own required input no longer routinely trips a threshold nobody had
measured.
