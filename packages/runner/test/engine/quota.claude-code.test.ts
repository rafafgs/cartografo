/**
 * What the `ClaudeCodeAdapter` reports when the ACCOUNT refused (t296, AC1/AC4).
 *
 * The third instance of one shape: `failed` is a single word for facts that
 * need different answers. t265 separated the engine's refusal from the crash;
 * this separates the account's quota from both. The measurement is a real run
 * (`notas/2026-08-18-n3-round.md`, hole 1): `api_error_status: 429`,
 * `terminal_reason: api_error`, the reset time in the message — and
 * `failure_kind: null` on the way out, so the runner retried it into the
 * consecutive-failure cap and blocked the job twice in three hours.
 *
 * `api_error_status` and not `terminal_reason` is what this reads, and the
 * difference matters: `api_error` covers every API error there is — a 500, an
 * overload, a network hiccup — and those are exactly the ones a retry SHOULD
 * buy. The status code is the only field on that frame that says which of them
 * happened.
 *
 * The status stays `failed`, for the reason the frozen spec already records
 * naming this very case ("Rejected — a richer `SessionStatus`",
 * `docs/formats/engine-adapter.md`): the cause rides beside the status in
 * `SessionFinishDetail`, which is the interface's declared additive-growth
 * point.
 *
 * **The reset instant is the tolerant half**, and every case below that asks
 * for it also asks what happens when it is not there. There is no captured 429
 * frame in this repository — the only evidence is the prose that note quoted —
 * so the adapter reads the text wherever the CLI puts it and a parse that fails
 * reports NOTHING rather than throwing: a missing hint costs a longer backoff,
 * an exception on the terminal path costs the session's `onFinished`, which is
 * invariant 1 of the frozen contract.
 *
 * Absence is a contract here exactly as it is next door in
 * `refusal.claude-code.test.ts`, so the cases assert on the KEY: a present key
 * holding `undefined` reads as present to `'quotaResetAt' in detail`, and that
 * is the difference between "the engine said nothing" and "the adapter reported
 * a value nobody measured".
 *
 * The engine is the fake one, for the reason the conformance kit records: CI
 * has to be deterministic and must not depend on an installed, authenticated
 * CLI (`docs/formats/engine-adapter.md`). What is under test is the ADAPTER's
 * reading of a frame, and the frame is fixture material either way.
 *
 * English per the repository's language rule.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type { SessionFinishDetail, SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Ceiling on one session of the fake engine, which normally ends in milliseconds. */
const DEADLINE_MS = 15_000;

/**
 * The refusal text the real CLI printed, verbatim from the note that measured
 * it (`notas/2026-08-18-n3-round.md:23`).
 *
 * A quotation, so it stays spelled exactly as the engine spells it — the
 * middle dot included: whatever the parser ends up matching on, it has to match
 * on THIS and not on a tidied-up version of it.
 */
const LIMIT_TEXT = "You've hit your session limit · resets 4:40pm Europe/Lisbon";

/** The zone that text names, and the wall clock it names in that zone. */
const ZONE = 'Europe/Lisbon';
const WALL_CLOCK = '16:40';

/** One terminal `result` frame, as a line of the fake engine's stream. */
function resultFrame(fields: Record<string, unknown>): string {
  return JSON.stringify([
    {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'result',
        session_id: 'cc-t296',
        ...fields,
      }),
    },
  ]);
}

/**
 * The same terminal frame, plus a raw line the CLI wrote outside the JSON.
 *
 * The stream mixes structured frames with "a dying scream in plain text"
 * (`docs/formats/engine-adapter.md`), and where the limit message travels is
 * precisely what no capture in this repository settles. Both shapes are fed to
 * the adapter, because the fix may not depend on a guess about that.
 */
function resultFrameWithRawLine(fields: Record<string, unknown>, raw: string): string {
  return JSON.stringify([
    { stream: 'stderr', text: raw },
    {
      stream: 'stdout',
      text: JSON.stringify({ type: 'result', session_id: 'cc-t296', ...fields }),
    },
  ]);
}

/** What `onFinished` was handed, once it has been handed anything. */
interface Reported {
  status: SessionStatus;
  exitCode: number | null;
  detail: SessionFinishDetail | undefined;
}

/**
 * Runs one session of the fake engine printing `lines`, and reports its end.
 *
 * @param workingDir Directory the session runs in.
 * @param lines The `FAKE_ENGINE_LINES` payload.
 * @param exitCode What the fake engine exits with — `1` for the measured
 *   refusal, and the reason a quota is indistinguishable from a crash without
 *   the field this ficha reads.
 * @returns The three arguments of `onFinished`.
 */
async function runSession(
  workingDir: string,
  lines: string,
  exitCode = '1',
): Promise<Reported> {
  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (spec) => {
      const built = buildCommand(spec);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });

  let announce: (reported: Reported) => void = () => undefined;
  const finished = new Promise<Reported>((resolve) => {
    announce = resolve;
  });

  await adapter.startSession(
    {
      workingDir,
      instructions: 'node instructions, coming from the database',
      prompt: 'the work of this turn',
      timeoutSeconds: 30,
      envOverrides: { FAKE_ENGINE_LINES: lines, FAKE_ENGINE_EXIT_CODE: exitCode },
    },
    {
      onOutput() {
        /* the lines are C6's business, not this ficha's */
      },
      onFinished(status, code, detail) {
        announce({ status, exitCode: code, detail });
      },
    },
  );

  return Promise.race([
    finished,
    new Promise<Reported>((_resolve, reject) => {
      const clock = setTimeout(() => {
        reject(new Error(`the session did not end within ${DEADLINE_MS}ms`));
      }, DEADLINE_MS);
      clock.unref();
    }),
  ]);
}

/** A temporary working directory, removed when the case ends. */
function workdir(t: { after: (fn: () => void) => void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cartografo-t296-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** The wall clock an instant reads as, in the zone the message named. */
function wallClockIn(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

test('t296 AC1 — a 429 on the terminal frame is reported as a quota failure', async (t) => {
  const reported = await runSession(
    workdir(t, 'quota'),
    resultFrame({ api_error_status: 429, terminal_reason: 'api_error' }),
  );

  assert.equal(
    reported.status,
    'failed',
    'the status stays one of the six: the interface is frozen and the cause rides beside it',
  );
  assert.equal(reported.exitCode, 1);
  assert.ok(reported.detail !== undefined, 'a quota refusal has something the status cannot say');
  assert.equal(reported.detail.failureKind, 'quota');
  assert.ok(
    !('refusalCategory' in reported.detail),
    'a quota is not a category the engine gave: that field belongs to the refusal',
  );
});

test('t296 AC1 — the reset instant travels when the frame carries the message', async (t) => {
  const reported = await runSession(
    workdir(t, 'reset-frame'),
    resultFrame({ api_error_status: 429, terminal_reason: 'api_error', result: LIMIT_TEXT }),
  );

  assert.equal(reported.detail?.failureKind, 'quota');
  const resetAt = reported.detail?.quotaResetAt;
  assert.equal(typeof resetAt, 'string', `a parsable reset time has to be reported: ${LIMIT_TEXT}`);

  const instant = new Date(resetAt as string);
  assert.ok(!Number.isNaN(instant.getTime()), `\`${String(resetAt)}\` is not an ISO instant`);
  assert.equal(
    wallClockIn(instant, ZONE),
    WALL_CLOCK,
    `the instant has to read as ${WALL_CLOCK} in ${ZONE}, which is what the engine said`,
  );
  assert.ok(instant.getTime() > Date.now(), 'a reset that already happened is not a reset to wait for');
  assert.ok(
    instant.getTime() - Date.now() <= 24 * 60 * 60 * 1_000,
    'a wall clock with no date resolves against today, never a year out',
  );
});

test('t296 AC1 — and when the CLI screamed it in plain text beside the frame', async (t) => {
  const reported = await runSession(
    workdir(t, 'reset-raw'),
    resultFrameWithRawLine({ api_error_status: 429, terminal_reason: 'api_error' }, LIMIT_TEXT),
  );

  assert.equal(reported.detail?.failureKind, 'quota');
  const resetAt = reported.detail?.quotaResetAt;
  assert.equal(typeof resetAt, 'string', 'the message is read wherever the CLI puts it');
  assert.equal(wallClockIn(new Date(resetAt as string), ZONE), WALL_CLOCK);
});

for (const [label, fields] of [
  ['the frame said nothing about a reset', { api_error_status: 429 }],
  [
    'the text has no time in it',
    { api_error_status: 429, result: "You've hit your session limit" },
  ],
  [
    'the time has no zone',
    { api_error_status: 429, result: 'resets 4:40pm' },
  ],
  [
    'the zone is not a zone',
    { api_error_status: 429, result: 'resets 4:40pm Middle/Earth' },
  ],
  [
    'the clock is not a clock',
    { api_error_status: 429, result: 'resets 99:99pm Europe/Lisbon' },
  ],
] as const) {
  test(`t296 AC4 — ${label}: the quota is still reported, with no instant`, async (t) => {
    const reported = await runSession(workdir(t, 'no-reset'), resultFrame(fields));

    assert.equal(reported.status, 'failed');
    assert.equal(
      reported.detail?.failureKind,
      'quota',
      'a reset time nobody could parse may never cost the fact that it was a quota',
    );
    const detail: Record<string, unknown> = { ...(reported.detail ?? {}) };
    assert.ok(
      !('quotaResetAt' in detail),
      `\`quotaResetAt\` has to be OMITTED when ${label} — absence is absence, and a key ` +
        'holding `undefined` reads as present',
    );
  });
}

for (const [label, fields] of [
  ['no api_error_status at all', {}],
  ['a 500 the next attempt may well survive', { api_error_status: 500 }],
  ['an api_error with no status beside it', { terminal_reason: 'api_error' }],
  ['the status as prose rather than a number', { api_error_status: '429' }],
] as const) {
  test(`t296 AC1 — ${label} is not a quota`, async (t) => {
    // Exit 1 on purpose: what must not happen is an ordinary crash being read as
    // a quota because the adapter guessed from the exit code — the same guard
    // t265's own cases put around the refusal.
    const reported = await runSession(workdir(t, 'not-quota'), resultFrame(fields));

    assert.equal(reported.status, 'failed');
    const detail: Record<string, unknown> = { ...(reported.detail ?? {}) };
    assert.ok(!('failureKind' in detail), `\`failureKind\` must not appear for ${label}`);
    assert.ok(!('quotaResetAt' in detail), `\`quotaResetAt\` must not appear for ${label}`);
  });
}

test('t296 AC1 — a session that ended clean carries neither field', async (t) => {
  const reported = await runSession(
    workdir(t, 'clean'),
    resultFrame({ subtype: 'success', result: 'done' }),
    '0',
  );

  assert.equal(reported.status, 'completed');
  const detail: Record<string, unknown> = { ...(reported.detail ?? {}) };
  assert.ok(!('failureKind' in detail));
  assert.ok(!('quotaResetAt' in detail));
});
