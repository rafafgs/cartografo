# t296 closing note — a quota refusal waits instead of burning the failure cap

**Subject:** an engine account at its own limit (`HTTP 429`) stops being
indistinguishable from a crash. The adapter reports `failure_kind: 'quota'`, the
control plane's consecutive-failure cap does not count it, and the runner holds
the work back until the reset instead of re-leasing it three seconds later —
without ever setting `job.blocked`.
**Commits:** `109e336` (the acceptance tests, red), `b081b43` (the fix), on
`ticket-296`.
**Written:** 2026-08-25, during development, following t282's and t303's
precedent.

## What the incident was

`notas/2026-08-18-n3-round.md`, hole 1, measured live on 2026-08-18: a
`coleta-fundamentos` session died on a `429` after 25 minutes and 4.04M
cache-read tokens; the runner re-leased the work; the next two attempts died in
11 s and 2.5 s; t265's cap blocked the job at 13:50Z. After an `unblock` at
15:42Z the next attempt did the same thing and blocked it again at 16:12Z.
≈US$9.3 for nothing usable, and a job whose `block_reason` said "consecutive
failures" about an account that was merely out of quota for the afternoon.

## What shipped

| Where | What |
|---|---|
| `packages/core/src/db/event-validation.ts` | `failure_kind` accepts `'quota'`; set still closed |
| `specs/events/schemas/session.finished.schema.json` | the same widening, in the contract that file mirrors |
| `packages/runner/src/engine/types.ts` | `failureKind: 'engine_refusal' \| 'quota'`; new `quotaResetAt?: string` |
| `docs/formats/engine-adapter.md` | both, mirrored into the published `SessionFinishDetail` |
| `packages/runner/src/engine/claude-code-adapter.ts` | `extractQuota`, `extractQuotaResetAt`, wired into `#harvest`/`#finish` |
| `packages/runner/src/dispatch/quota-retry.ts` (new) | `QuotaCooldownTracker`, `resolveQuotaBackoff`, `QUOTA_COOLDOWN_REASON` |
| `packages/runner/src/dispatch/options.ts` | `DEFAULT_QUOTA_BACKOFF_MS` (30s→15min), `quotaBackoffMs` |
| `packages/runner/src/dispatch/dispatch.ts` | pre-open cooldown check; quota branch with no block; reset on `completed` |

`packages/runner/src/dispatch/report.ts` was **not edited**, exactly as the
ficha predicted: `Outcome.failureKind` is typed by reference to
`SessionFinishDetail['failureKind']`, so the widening flowed through. Its test
proves it rather than asserting it (`report.test.ts`, `t296 AT1`).

## The two questions the Definition of Done asks

**Does the Codex adapter carry an equivalent structured 429 signal?** No — and
the reason is stronger than "not found". `codex-adapter.ts` reads *nothing* off
its frames except the session ref: its `#finish` reports `timeoutReason` and
nothing else, it has no `#harvest` at all, and its `capabilities()` does not
even declare `reportsUsage`. There is no `usage`, no `models`, no `stop_reason`
and no error status being read there today, so a quota detection for Codex is
not a field this ficha could have added — it is the whole frame-reading half of
that adapter, which does not exist. Whether the Codex CLI emits such a signal on
the wire is untested here and stays an open question for whoever writes it.

**Would `terminal_reason` alone have been enough?** No, and this is the one
place where the original ticket's own investigation would have produced a worse
fix. The captured frame carried both `api_error_status: 429` **and**
`terminal_reason: api_error`. `api_error` is *every* API error there is — a 500,
an overload, a connection that dropped mid-stream — and those are precisely the
failures a retry *should* buy: they are transient in the ordinary sense, and the
next attempt may well work. Branching on `terminal_reason` would have put every
transient server error into a 30-second-to-15-minute wait, which is a different
bug with the same shape as this one. `api_error_status` is the only field on
that frame that separates "come back later" from "try again now", so it is what
the adapter reads, and the test suite pins the distinction: a frame carrying
`api_error_status: 500`, or `terminal_reason: 'api_error'` with no status beside
it, reports no `failureKind` at all.

## What the ticket did not know it was taking

**1. The event schema is a second copy of the enum.**
`specs/events/schemas/session.finished.schema.json` declares
`failure_kind: {enum: ["engine_refusal", null]}`, and `event-validation.ts`'s
own header says it *mirrors* those schemas. The ficha's FR1 named only the
TypeScript side. Widening one and not the other would have left the mirror
claiming something its source refuses — the exact drift both headers exist to
prevent — so both moved. No test forced this (`specs/events/tests/schemas.test
.mjs` checks which keys exist, never their values), which is precisely why it
was worth doing rather than noticing later.

**2. `dispatch.ts` was at 599 of the 600 lines its own gate enforces.**
`test/dispatch/file-size-budget.test.ts` AT3 asserts that file specifically and
does **not** consult `RECORDED_EXCEPTIONS`, so an exemption was not available
even in principle: any addition at all had to be paid for by a subtraction. Two
things moved out, both of them wiring rather than sequence, which is the split
rule that file's own header states and that t223 and t272 already applied twice:

- `session-collector.ts` (new) — how one session's four outputs are caught (its
  lines, its engine ref, its denials, its end). WHEN each is read, and the
  precedence between the writes that depend on them, stayed in `dispatch.ts`,
  because that is the part with the load-bearing guarantees (t148, t207-B).
- `createPreSessionFailureHandler` in `pre-session-retry.ts` — the tracker, the
  ceiling and the one call that reads both, which had been assembled at the top
  of `dispatch.ts` because there was nowhere else to put them.

Nothing was renamed, reordered or re-timed by either move, and the whole runner
suite (667 tests) is the evidence. `dispatch.ts` ended at **586**, so the next
ficha has ~14 lines before it must split again.

**3. `quotaResetAt` could not travel on `Outcome`.** FR8 asks for
`outcome.quotaResetAt`, and `Outcome` is declared in `report.ts` — the one file
FR5 forbids touching. Rather than break either, the reset instant is kept
*beside* the outcome, on the collector (`collected.quotaResetAt()`), and never
enters the object `report.ts` serializes into `PATCH /finish`. That turned out
better than the ficha's own plan: "never reaches the wire" stopped being a rule
somebody has to remember and became a shape — there is no key to send.

**4. `SessionFinishDetail` in the published doc never had `failureKind` at
all.** t265 added the field to `types.ts` and did not mirror it into
`docs/formats/engine-adapter.md`; `spec-parity.test.ts` compares *exported
symbols*, not fields, so nothing caught it. FR3's "widen the value list in the
doc" therefore had no list to widen. The block now carries `failureKind` (in its
widened form), `refusalCategory` and `quotaResetAt` — the middle one is beyond
the letter of FR3 and is called out here for that reason: introducing
`failureKind: "engine_refusal" | "quota"` while silently leaving out the field
that carries the refusal's category would have made the published interface
assert something false about t265's own shape.

**5. A comment in `packages/core/src/repositories/session.ts` said "Today one
value, `engine_refusal`".** Corrected, along with the sibling comment that
explains why a `failure_kind` present is excluded from the cap. No logic in that
file changed, and nothing was promoted to the session projection — the Out of
Scope of both this ficha and t265.

## What was deliberately not done

- **No `quota_paused` `SessionStatus`.** Rejected in the frozen spec, by name,
  after the dormant wire value was born (`docs/formats/engine-adapter.md`,
  "Rejected — a richer `SessionStatus`"). The status stays `failed`.
- **No change to `packages/screen` or the session projection.** AC2 — the job
  stays unblocked, so the board reads "em curso" rather than "bloqueado" — is
  the proxy the ficha chose, and it is what the tests assert. If it reads as too
  weak in use, rendering `failure_kind` where the session table already renders
  `status` is a small separate ficha.
- **No glossary row.** `docs/spec/glossario-wire.md` maps retired Portuguese
  spellings to English ones; `engine_refusal` never needed a row and neither
  does `quota` — there is no Portuguese predecessor to retire.
- **`docs/spec/runner-and-controller.md` was not updated.** It narrates t265's
  two holes and their fix, and this ficha adds a third case to that story. It is
  outside every FR, it gates nothing, and it is a one-paragraph follow-up.
- **No change to `max_consecutive_failures`, to `controller.ts`, or to the cost
  of the research node** (hole 2 of the same note). All three Out of Scope.

## The one assumption that is not verified

There is **no captured 429 frame in this repository**. The only evidence is a
quoted line of prose in the incident note, and the field names read from it by
whoever wrote that note: `api_error_status: 429`, `terminal_reason: api_error`,
"the reset time in the message".

The detection reads `api_error_status` off the terminal `result` frame, which is
as strong as the evidence gets. The *reset instant* is where the evidence runs
out — nobody recorded which field the sentence travels in — so the parser does
not depend on the answer: `extractQuotaResetAt` runs over the **raw line**,
before it is parsed as a frame, so a message inside the frame's `result` and a
plain-text "dying scream" beside it are the same case. Both shapes are covered
by tests. The guard is a `line.includes('reset')` before the pattern, so the
cost on a session that never sees a limit is one substring search per line.

Everything about the parse fails soft, and that is the contract AC4 pins: no
time in the text, no zone, a zone the runtime does not know, a clock that is not
a clock — all report `quotaResetAt: undefined`, never an exception, because a
throw on that path would cost the session its `onFinished` (invariant 1) to save
a hint. A missing hint costs one rung of the backoff ladder and nothing else.

What a real capture should still confirm, next time an account hits its limit
with a runner attached: that `api_error_status` is a **number** on that frame
(the adapter compares strictly, so a `"429"` string would read as no quota at
all), and which field actually carries the sentence.

## The numbers

| | before | after |
|---|---|---|
| `packages/core` | 682 | **685** |
| `packages/runner` | 645 | **667** |
| root group | 325 | 325 |

The "before" column is the measured "after" minus the 25 cases this ficha added
(3 core, 22 runner), not a separate run: the branch is a single worktree and
re-measuring the parent commit would have meant moving it.

`npm test` (root, both groups), `npm run lint` (`eslint .` +
`check-single-writer.mjs` + `check-bin-dependencies.mjs`) and `npm run
typecheck` (all seven workspaces) are green. `spec-parity.test.ts` and
`no-leaked-row-keys.test.ts` needed no edit, as the Definition of Done demanded.

**The red, recorded before the fix existed** (`109e336`):

- `data.failure_kind has to be one of: engine_refusal` — on all four wire cases,
  including the end-to-end dispatch one, where it surfaced as
  `PATCH /v1/sessions/1/finish answered 400`. That is Context #1 of the ficha
  reproduced: without the enum widening, AC1 fails closed rather than silently.
- `artifact does not exist yet: packages/runner/src/dispatch/quota-retry.ts` —
  the tracker, in this directory's idiom for a missing module.
- `a quota refusal has something the status cannot say` — the adapter reporting
  no `detail` at all for a `429` frame.
- `Type '"quota"' is not assignable to type '"engine_refusal"'` (`tsc`) — the
  `report.ts` case, which is green at run time from birth because that module
  genuinely needed no change. Its red is a type error, and it is the honest one:
  it is the interface that was too narrow, not the reporter.

## Judgement calls worth a second opinion

- **The ladder** (`DEFAULT_QUOTA_BACKOFF_MS = 30s, 1m, 2m, 5m, 10m, 15m`) is a
  default with nothing in this codebase to anchor it to. Both ends were chosen
  against the incident — the measured re-leases were ~3 s apart, and the
  measured window was hours — and it only applies when the engine named no reset
  instant. Cheap to change; nothing depends on the numbers.
- **The cooldown is per job, not per account.** A second job dispatched during a
  cooldown will very likely buy the same `429` and start a cooldown of its own:
  one wasted session per job in the pool, once. Holding the *whole queue* back
  on one job's refusal is a bigger decision — it stops a project on the word of
  one node — and nobody has taken it. Written down in `quota-retry.ts` so the
  next ficha can weigh it with the cost in front of it.
- **The cooldown is process-local**, exactly like t272's streak, and for the
  same reason: the server-side alternative is a migration, a wire field and a
  `GET /v1/jobs` filter change for an incident that happened inside one runner
  process in one afternoon. It does not survive a restart, and two runners each
  get their own — both of which make a work retry *earlier* than the policy
  says, never later, which is the safe direction to be wrong in.
