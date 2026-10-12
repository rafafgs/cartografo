/**
 * The `CopilotAdapter` running the whole conformance kit (C1–C11) (t675).
 *
 * The SAME `runConformanceKit` the other two adapters run, imported and not
 * copied, against the unchanged `fake-engine.mjs`. What is specific to this
 * engine lives here:
 *
 * - **No `engineRefFrame`.** The other two engines print their session id in a
 *   frame, so the kit can feed that line to the fake and compare. This CLI
 *   prints no start frame at all — the id appears only in the final `result`
 *   (measured against `@github/copilot@1.0.95`) — so the adapter CHOOSES the
 *   id and passes it as `--session-id`. The id is random, so the kit cannot
 *   know it in advance; the tests below prove the same thing from the other
 *   side: `onEngineRef` fires exactly once, with a UUID, and it is the very
 *   value the command builder received and put in the argv.
 * - **The terminal `result` frame.** It carries `exitCode`, and a run whose
 *   frame says non-zero is failed even when the process then exits 0.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import { buildCommand } from '../../src/engine/copilot-command.ts';
import { runConformanceKit } from '../../src/engine/conformance-kit.ts';
import {
  resolveCapabilities,
  type SessionSpec,
  type SessionStatus,
} from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

runConformanceKit(
  (fakeEnginePath) =>
    new CopilotAdapter({
      // The kit's seam: the argv the real `copilot` would receive, whole and
      // unedited, handed to the fake engine. `stdin` is spread along, so the
      // oversized case (C11) goes through the channel the real command picks.
      commandBuilder: (spec, engineRef) => {
        const built = buildCommand(spec, engineRef);
        return { ...built, command: process.execPath, args: [fakeEnginePath, ...built.args] };
      },
      graceMs: 300,
    }),
  FAKE_ENGINE,
);

test('engineName is the stable identifier persisted on the session row', () => {
  assert.equal(new CopilotAdapter().engineName, 'copilot');
});

test('capabilities declares only structured output; resume stays undeclared', () => {
  // `-r/--resume` exists in the CLI and is deliberately not wired: lighting up
  // a field with no consumer is the way a format rots.
  const declared = new CopilotAdapter().capabilities();

  assert.deepEqual(declared, { hasStructuredOutput: true });
  assert.equal(resolveCapabilities(declared).hasResume, false);
});

/* --- one session of the fake, seen from the outside ----------------------------- */

interface Outcome {
  readonly status: SessionStatus;
  readonly exitCode: number | null;
  readonly finishes: number;
  readonly refs: string[];
  readonly argv: string[];
  readonly builderRefs: string[];
}

/** Runs one session of the fake engine, emitting `lines` on stdout and exiting with `exit`. */
async function runFake(lines: readonly string[], exit: number): Promise<Outcome> {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t675-conf-'));
  const recordPath = join(root, 'record.json');
  const workingDir = join(root, 'work');
  const builderRefs: string[] = [];

  const adapter = new CopilotAdapter({
    commandBuilder: (spec: SessionSpec, engineRef: string) => {
      builderRefs.push(engineRef);
      const built = buildCommand(spec, engineRef);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });

  const refs: string[] = [];
  let finishes = 0;
  let outcome: { status: SessionStatus; exitCode: number | null } | null = null;
  let announce: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    announce = resolve;
  });

  try {
    mkdirSync(workingDir, { recursive: true });
    await adapter.startSession(
      {
        workingDir,
        instructions: 'node instructions',
        prompt: 'the work of this turn',
        timeoutSeconds: 30,
        envOverrides: {
          FAKE_ENGINE_RECORD: recordPath,
          FAKE_ENGINE_LINES: JSON.stringify(lines.map((text) => ({ stream: 'stdout', text }))),
          FAKE_ENGINE_EXIT_CODE: String(exit),
        },
      },
      {
        onOutput() {
          /* the lines are C6's business */
        },
        onEngineRef(ref) {
          refs.push(ref);
        },
        onFinished(status, exitCode) {
          finishes += 1;
          outcome = { status, exitCode };
          announce();
        },
      },
    );
    await done;
    await new Promise((resolve) => setTimeout(resolve, 200));

    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { argv: string[] };
    assert.ok(outcome, 'the session never ended');
    const ended: { status: SessionStatus; exitCode: number | null } = outcome;
    return { ...ended, finishes, refs, argv: record.argv, builderRefs };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const resultFrame = (exitCode: number): string =>
  JSON.stringify({ type: 'result', sessionId: 'whatever', exitCode, usage: {} });

test('onEngineRef fires exactly once with a UUID: the one the builder got and --session-id carries', async () => {
  const outcome = await runFake([resultFrame(0)], 0);

  assert.equal(outcome.refs.length, 1, 'once, not zero and not twice');
  assert.match(outcome.refs[0] ?? '', UUID);
  assert.deepEqual(outcome.builderRefs, outcome.refs, 'the builder received the same value');
  assert.equal(outcome.argv[outcome.argv.indexOf('--session-id') + 1], outcome.refs[0]);
  assert.equal(outcome.finishes, 1);
});

test('the engine ref is chosen per session, never reused', async () => {
  const [first, second] = [await runFake([], 0), await runFake([], 0)];

  assert.notEqual(first.refs[0], second.refs[0]);
});

test('onEngineRef fires even when the stream carries no frame at all', async () => {
  const outcome = await runFake([], 0);

  assert.equal(outcome.refs.length, 1, 'nothing is parsed for it: the adapter already knows the id');
});

test('a `result` frame with a non-zero exitCode is failed even when the process exits 0', async () => {
  const outcome = await runFake(['{"type":"assistant.turn_end","data":{}}', resultFrame(1)], 0);

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 0, 'the exit code reported is the process\'s own, not the frame\'s');
  assert.equal(outcome.finishes, 1);
});

test('a `result` frame with exitCode 0 and a clean exit is completed', async () => {
  const outcome = await runFake([resultFrame(0)], 0);

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.exitCode, 0);
});

test('with no `result` frame the exit code alone decides', async () => {
  assert.equal((await runFake([], 0)).status, 'completed');

  const failed = await runFake(['not json at all', '{"type":"assistant.message","data":{}}'], 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
});

test('a non-zero exit is failed even when the `result` frame says 0', async () => {
  assert.equal((await runFake([resultFrame(0)], 1)).status, 'failed');
});

test('only a real `result` frame counts: a line that merely mentions one does not', async () => {
  // An assistant message quoting a `result` frame is `type: assistant.message`;
  // and a string that is not an object at all is just text.
  const quoted = JSON.stringify({
    type: 'assistant.message',
    data: { content: '{"type":"result","exitCode":1}' },
  });
  const outcome = await runFake([quoted, 'result exitCode 1', '{"type":"result","exitCode":"1"}'], 0);

  assert.equal(outcome.status, 'completed');
});
