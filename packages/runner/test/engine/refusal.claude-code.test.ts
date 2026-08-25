/**
 * What the `ClaudeCodeAdapter` reports when the ENGINE refused to answer
 * (t265, AT1).
 *
 * t198's first real traversal of the bets bundle put a thesis through `triage`
 * and got four refused sessions in a row before a fifth one worked:
 * `stop_reason: "refusal"`, `stop_details.category: "reasoning_extraction"`,
 * exit 1, zero output tokens
 * (`notes/2026-08-17-first-bets-run.md:34`). To the adapter every one of
 * them looked exactly like a crash — a non-zero exit becomes `failed`, and the
 * two keys that say WHY were never read.
 *
 * The fix is the shape `timeoutReason` already has and not a seventh
 * `SessionStatus`: the interface is frozen at v1 (rule of two consumers), the
 * status stays `failed`, and the cause rides beside it in
 * `SessionFinishDetail` — the interface's own declared additive-growth point,
 * which t172 already used twice.
 *
 * Absence is the whole contract here, so every case asserts on the KEY and not
 * on the value: a frame that says nothing about a refusal has to leave both
 * fields out, exactly as `usage`/`models` do. `'failureKind' in detail` is what
 * separates that from a key present holding `undefined`.
 *
 * The engine is the fake one, for the reason the conformance kit records: CI has
 * to be deterministic and must not depend on an installed, authenticated CLI
 * (`docs/formats/engine-adapter.md:363-366`). What is under test is the
 * ADAPTER's reading of a frame, and the frame is fixture material either way.
 *
 * English per D18.
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

/** The category the on-call session's bisection measured on the real refusal. */
const CATEGORY = 'reasoning_extraction';

/** One terminal `result` frame, as a line of the fake engine's stream. */
function resultFrame(fields: Record<string, unknown>): string {
  return JSON.stringify([
    {
      stream: 'stdout',
      text: JSON.stringify({
        type: 'result',
        session_id: 'cc-t265',
        ...fields,
      }),
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
 * @param exitCode What the fake engine exits with — `1` for every refusal
 *   measured so far, and the reason a refusal is indistinguishable from a crash
 *   without the two keys this ticket reads.
 * @returns The three arguments of `onFinished`.
 */
async function runSession(
  workingDir: string,
  lines: string,
  exitCode: string,
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
        /* the lines are C6's business, not this ticket's */
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

test('t265 AT1 — a refusal with a category reports both fields', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t265-refusal-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const reported = await runSession(
    workingDir,
    resultFrame({ stop_reason: 'refusal', stop_details: { category: CATEGORY } }),
    '1',
  );

  assert.equal(
    reported.status,
    'failed',
    'the status stays one of the six: the interface is frozen and the cause rides beside it',
  );
  assert.equal(reported.exitCode, 1);
  assert.ok(reported.detail !== undefined, 'a refusal has something the status does not carry');
  assert.equal(reported.detail.failureKind, 'engine_refusal');
  assert.equal(
    reported.detail.refusalCategory,
    CATEGORY,
    'the category is the engine own word, carried verbatim',
  );
});

test('t265 AT1 — a refusal with no stop_details reports the kind and no category', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t265-refusal-bare-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const reported = await runSession(workingDir, resultFrame({ stop_reason: 'refusal' }), '1');

  assert.ok(reported.detail !== undefined);
  assert.equal(reported.detail.failureKind, 'engine_refusal');
  assert.ok(
    !('refusalCategory' in reported.detail),
    'the category is OMITTED when the frame carried none — absence is absence, never an empty string',
  );
});

for (const [label, fields] of [
  ['no stop_reason at all', {}],
  ['an ordinary end_turn', { stop_reason: 'end_turn' }],
] as const) {
  test(`t265 AT1 — ${label} reports neither field`, async (t) => {
    const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t265-plain-'));
    t.after(() => {
      rmSync(workingDir, { recursive: true, force: true });
    });

    // Exit 1 on purpose: what must not happen is a plain crash being read as a
    // refusal because the adapter guessed from the exit code.
    const reported = await runSession(workingDir, resultFrame(fields), '1');

    assert.equal(reported.status, 'failed');
    const detail: Record<string, unknown> = { ...(reported.detail ?? {}) };
    assert.ok(!('failureKind' in detail), `\`failureKind\` must not appear for ${label}`);
    assert.ok(!('refusalCategory' in detail), `\`refusalCategory\` must not appear for ${label}`);
  });
}
