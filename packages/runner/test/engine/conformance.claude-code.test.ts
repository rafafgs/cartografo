/**
 * The `ClaudeCodeAdapter` running the whole conformance kit (C1–C10).
 *
 * The kit knows nothing about this adapter: it receives a factory and a path to
 * a fake engine. Every Claude Code specificity lives in this file — the seam
 * that swaps the real binary for the fake, and the shape of the `stream-json`
 * frame the `engineRef` comes out of. It is that boundary that makes the same
 * suite serve the second adapter (t119) without a copy.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { runConformanceKit } from '../../src/engine/conformance-kit.ts';
import type {
  SessionFinishDetail,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const ENGINE_REF = 'engine-session-ref-abc123';

runConformanceKit(
  (fakeEnginePath) =>
    new ClaudeCodeAdapter({
      // The seam the kit demands: the argv the `claude` CLI would receive,
      // whole and unedited, handed to the fake engine. Changing only the binary
      // is what makes C2 measure the real injection, and not a simplified
      // version of it built for the test.
      commandBuilder: (spec) => ({
        command: process.execPath,
        args: [fakeEnginePath, ...buildCommand(spec).args],
      }),
      // Short grace: C4 waits for the escalation to SIGKILL within the case's
      // own deadline.
      graceMs: 300,
    }),
  FAKE_ENGINE,
  {
    engineRefFrame: {
      line: JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: ENGINE_REF,
        model: 'claude-opus-5',
      }),
      expectedRef: ENGINE_REF,
    },
  },
);

test('engineName is the stable identifier persisted on the session row', () => {
  assert.equal(new ClaudeCodeAdapter().engineName, 'claude-code');
});

test('capabilities declares only what has a consumer', () => {
  // `hasStructuredOutput` because `stream-json` is parseable; `hasResume` since
  // t173, because `SessionSpec.resumeFrom` gave the flag the consumer it had
  // been waiting for; and `reportsUsage` since t172, for the same reason the
  // second one arrived — the terminal `result` frame always carried `usage`,
  // and what it lacked was somebody reading it. All three flags of
  // `EngineCapabilities` now have one, which is the only condition this adapter
  // has ever declared one under ("declaring the fourth, fifth and sixth before
  // anybody reads them is how a format rots",
  // `docs/formatos/engine-adapter.md:160-165`).
  const declared = new ClaudeCodeAdapter().capabilities();

  assert.deepEqual(declared, {
    hasStructuredOutput: true,
    hasResume: true,
    reportsUsage: true,
  });
  assert.equal(declared.hasResume, true);
  assert.equal(declared.reportsUsage, true);
});

/* -------------------------------------------------------------------------- */
/* t172 — the terminal frame's token accounting and the models that ran.      */
/*                                                                            */
/* The fixtures below are NOT invented: `usage` and `modelUsage` are copied    */
/* from a real `claude 2.1.233` run (FR12, evidence in the ficha), extra keys  */
/* and all. Those extras are the whole point of the shape — the CLI reports    */
/* nine keys where the taxonomy's `uso` contract accepts exactly four and      */
/* closes `additionalProperties`, so an adapter that passed the object through */
/* would have every `/finish` call refused with a 400 by the control plane.    */
/* -------------------------------------------------------------------------- */

/** Deadline for a session that is expected to come up and end. */
const USAGE_DEADLINE_MS = 15_000;

/** The four counts the `uso` contract declares — and the only four. */
const EXPECTED_USAGE = {
  input_tokens: 2,
  output_tokens: 5,
  cache_creation_input_tokens: 3022,
  cache_read_input_tokens: 15688,
};

/**
 * The `usage` object of a real terminal frame, verbatim.
 *
 * Everything past the fourth key is what the CLI adds and the contract does not
 * know: `service_tier`, `iterations`, `speed` and the rest. Trimming this
 * fixture down to the four keys would make the test pass against an adapter
 * that just forwards the object, which is exactly the adapter that breaks in
 * production.
 */
const REAL_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 3022,
  cache_read_input_tokens: 15688,
  output_tokens: 5,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: { ephemeral_1h_input_tokens: 3022, ephemeral_5m_input_tokens: 0 },
  inference_geo: 'not_available',
  speed: 'standard',
};

/** One model's entry of a real `modelUsage` breakdown. */
function modelEntry(inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.000593,
    contextWindow: 200000,
    maxOutputTokens: 32000,
    provider: 'firstParty',
  };
}

/** The terminal `result` frame, with whatever accounting the case declares. */
function resultFrame(extra: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: ENGINE_REF,
    result: 'pronto',
    duration_ms: 1234,
    num_turns: 1,
    ...extra,
  });
}

/** What one fake session reported when it ended. */
interface Ending {
  status: SessionStatus;
  exitCode: number | null;
  detail: SessionFinishDetail | undefined;
}

/**
 * Runs one fake session to its end and hands back the whole `onFinished` call.
 *
 * The adapter is seamed onto the fake engine exactly as the kit above seams it,
 * because what is under test is the same path production takes: the lines reach
 * `#pump` as raw chunks, the terminal frame is one line among others, and the
 * detail is assembled where the outcome is.
 *
 * @param lines The stdout lines the fake engine prints, in order.
 * @param spec Extra session fields the case needs (a silence budget, say).
 * @returns The status, the exit code and the third argument of `onFinished`.
 */
async function runFakeSession(
  lines: readonly string[],
  spec: Partial<SessionSpec> = {},
): Promise<Ending> {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t172-'));
  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (built) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(built).args],
    }),
    graceMs: 300,
  });

  let announce: (ending: Ending) => void = () => undefined;
  const settled = new Promise<Ending>((resolve) => {
    announce = resolve;
  });
  const end = Promise.race([
    settled,
    new Promise<Ending>((_, reject) => {
      const clock = setTimeout(() => {
        reject(new Error(`the session did not end within ${USAGE_DEADLINE_MS}ms`));
      }, USAGE_DEADLINE_MS);
      clock.unref();
    }),
  ]);

  try {
    await adapter.startSession(
      {
        workingDir: root,
        instructions: 'node instructions, coming from the database',
        prompt: 'the work of this turn',
        timeoutSeconds: 30,
        ...spec,
        envOverrides: {
          FAKE_ENGINE_LINES: JSON.stringify(
            lines.map((text) => ({ stream: 'stdout', text })),
          ),
          ...spec.envOverrides,
        },
      },
      {
        onOutput() {
          /* the lines themselves are C6's business, not this ficha's */
        },
        onFinished(status, exitCode, detail) {
          announce({ status, exitCode, detail });
        },
      },
    );
    return await end;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('t172 AT — a result frame with usage and one model reports both through the detail', async () => {
  const ending = await runFakeSession([
    JSON.stringify({ type: 'system', subtype: 'init', session_id: ENGINE_REF }),
    resultFrame({
      usage: REAL_USAGE,
      modelUsage: { 'claude-sonnet-5': modelEntry(2, 5) },
    }),
  ]);

  assert.equal(ending.status, 'completed');
  assert.deepEqual(
    ending.detail?.usage,
    EXPECTED_USAGE,
    'the four counts of the contract, and NOTHING the CLI adds around them',
  );
  assert.deepEqual(ending.detail?.models, ['claude-sonnet-5']);
});

test('t172 AT — a two-model modelUsage reports both, in the order the frame declared them', async () => {
  const ending = await runFakeSession([
    resultFrame({
      usage: REAL_USAGE,
      // The order a real run produced: the small helper model first, the main
      // turn's model second. Order is the frame's, never sorted by us — a
      // reordering here would be this adapter inventing a ranking.
      modelUsage: {
        'claude-haiku-4-5-20251001': modelEntry(523, 14),
        'claude-sonnet-5': modelEntry(2, 5),
      },
    }),
  ]);

  assert.deepEqual(ending.detail?.models, ['claude-haiku-4-5-20251001', 'claude-sonnet-5']);
  assert.deepEqual(ending.detail?.usage, EXPECTED_USAGE);
});

test('t172 AT — a result frame with no accounting at all reports neither, never zeros', async () => {
  const ending = await runFakeSession([resultFrame({})]);

  assert.equal(ending.status, 'completed');
  assert.equal(
    ending.detail?.usage,
    undefined,
    'a build of the CLI that reports nothing must not be read as a session that spent nothing',
  );
  assert.equal(ending.detail?.models, undefined);
});

test('t172 AT — a session killed before any result frame reports neither', async () => {
  const ending = await runFakeSession(
    [JSON.stringify({ type: 'system', subtype: 'init', session_id: ENGINE_REF })],
    // Never reaches a terminal frame: it hangs after the init line and the
    // inactivity watchdog is what ends it.
    { silenceSeconds: 1, envOverrides: { FAKE_ENGINE_HANG: '1' } },
  );

  assert.equal(ending.status, 'timed_out');
  assert.equal(ending.detail?.timeoutReason, 'silence', 'the cause still travels');
  assert.equal(ending.detail?.usage, undefined);
  assert.equal(ending.detail?.models, undefined);
});
