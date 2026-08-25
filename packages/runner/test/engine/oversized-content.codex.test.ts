/**
 * The `CodexAdapter` carrying content that does not fit in an argv (t203).
 *
 * The symmetric file to `oversized-content.claude-code.test.ts`, and the
 * mechanism is the one place the two adapters part company: this engine has no
 * system-prompt flag, so there is nothing to split the content across and no
 * file to write — the whole `composeSingleArgument` goes to stdin, and the
 * trailing positional goes away with it.
 *
 * That last half is not a detail, it is the reason the branch is safe at all.
 * `codex exec --help`: "If stdin is piped **and a prompt is also provided**,
 * stdin is appended as a `<stdin>` block". Piping while keeping the positional
 * would deliver the prompt twice, once of them wrapped in a marker the node
 * never asked for. Dropping the positional is what makes stdin the prompt
 * rather than an annex to it.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { ARGV_INLINE_LIMIT_BYTES, buildCommand } from '../../src/engine/codex-command.ts';
import { composeSingleArgument, type SessionSpec, type SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for a session that is expected to come up and end. */
const DEADLINE_MS = 15_000;

const OVERSIZED_INSTRUCTIONS = `oversized node instructions\n${'i'.repeat(ARGV_INLINE_LIMIT_BYTES)}`;

const MARKER = 'MARKER-t203-codex';
const OVERSIZED_PROMPT = `${MARKER}\nthe work of this turn`;

/** What the fake engine recorded about what it received. */
interface FakeRecord {
  readonly argv: string[];
  readonly stdin: string;
  readonly files: Record<string, string>;
}

interface Ending {
  readonly status: SessionStatus;
  readonly exitCode: number | null;
}

interface LiveSession {
  readonly workingDir: string;
  readonly recordPath: string;
  readonly ended: Promise<Ending>;
  cleanup(): void;
}

async function openSession(spec: Partial<SessionSpec> = {}): Promise<LiveSession> {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t203-codex-'));
  const workingDir = join(root, 'workdir');
  mkdirSync(workingDir);
  const recordPath = join(root, 'record.json');

  const adapter = new CodexAdapter({
    commandBuilder: (built) => {
      const command = buildCommand(built);
      return { ...command, command: process.execPath, args: [FAKE_ENGINE, ...command.args] };
    },
    graceMs: 300,
  });

  let announce: (ending: Ending) => void = () => undefined;
  const settled = new Promise<Ending>((resolve) => {
    announce = resolve;
  });
  const ended = Promise.race([
    settled,
    new Promise<Ending>((_, reject) => {
      const clock = setTimeout(() => {
        reject(new Error(`the session did not end within ${DEADLINE_MS}ms`));
      }, DEADLINE_MS);
      clock.unref();
    }),
  ]);

  await adapter.startSession(
    {
      workingDir,
      instructions: OVERSIZED_INSTRUCTIONS,
      prompt: OVERSIZED_PROMPT,
      timeoutSeconds: 30,
      ...spec,
      envOverrides: { FAKE_ENGINE_RECORD: recordPath, ...spec.envOverrides },
    },
    {
      onOutput() {
        /* the lines are C6's business, not this ticket's */
      },
      onFinished(status, exitCode) {
        announce({ status, exitCode });
      },
    },
  );

  return {
    workingDir,
    recordPath,
    ended,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Waits for the fake's sidecar to be readable — never a fixed sleep. */
async function readRecord(recordPath: string): Promise<FakeRecord> {
  const limit = Date.now() + 5_000;
  let last: unknown;
  for (;;) {
    try {
      return JSON.parse(readFileSync(recordPath, 'utf8')) as FakeRecord;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= limit) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return assert.fail(`the fake engine wrote no readable sidecar (last failure: ${String(last)})`);
}

test('t203 AT — the whole composed argument reaches the process on stdin', async () => {
  const session = await openSession({ envOverrides: { FAKE_ENGINE_EXIT_CODE: '0' } });

  try {
    const end = await session.ended;
    assert.equal(end.status, 'completed');
    assert.equal(end.exitCode, 0);

    const record = await readRecord(session.recordPath);
    assert.equal(
      record.stdin,
      composeSingleArgument({
        workingDir: session.workingDir,
        instructions: OVERSIZED_INSTRUCTIONS,
        prompt: OVERSIZED_PROMPT,
        timeoutSeconds: 30,
      }),
      'the composition has to reach stdin byte for byte, exactly as it reached the argv before',
    );
    assert.ok(
      !record.argv.join('\n').includes(OVERSIZED_INSTRUCTIONS),
      'the content is still in the argv, which is the ceiling this ticket exists to dodge',
    );
    assert.deepEqual(
      Object.keys(record.files),
      [],
      'this adapter writes no ephemeral file — an AGENTS.md would collide with a real one',
    );
  } finally {
    session.cleanup();
  }
});

test('t203 AT — a session under the limit keeps stdin closed', async () => {
  // Invariant 6 as it stood before this ticket, and it stands: below the limit
  // nothing is written and nothing is piped, so the `<stdin>` block this
  // engine appends when both channels carry content cannot happen.
  const session = await openSession({
    instructions: 'node instructions, coming from the database',
    prompt: 'the work of this turn',
    envOverrides: { FAKE_ENGINE_EXIT_CODE: '0' },
  });

  try {
    await session.ended;
    assert.equal((await readRecord(session.recordPath)).stdin, '');
  } finally {
    session.cleanup();
  }
});

test('t203 AT — an engine that dies before reading stdin does not bring the runner down', async () => {
  // The same EPIPE guard the other adapter needs, and it needs it for the same
  // reason: an unhandled `'error'` on `child.stdin` is an uncaught exception in
  // Node, which takes the whole runner down over one session's fast exit.
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t203-codex-epipe-'));
  const adapter = new CodexAdapter({
    commandBuilder: () => ({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stdin: 'x'.repeat(512 * 1024),
    }),
    graceMs: 300,
  });

  let announce: (ending: Ending) => void = () => undefined;
  const settled = new Promise<Ending>((resolve) => {
    announce = resolve;
  });

  try {
    await adapter.startSession(
      {
        workingDir: root,
        instructions: 'node instructions',
        prompt: 'a turn whose engine will not read it',
        timeoutSeconds: 30,
      },
      {
        onOutput() {
          /* nothing to read here */
        },
        onFinished(status, exitCode) {
          announce({ status, exitCode });
        },
      },
    );

    const end = await Promise.race([
      settled,
      new Promise<Ending>((_, reject) => {
        const clock = setTimeout(() => {
          reject(new Error(`the session did not end within ${DEADLINE_MS}ms`));
        }, DEADLINE_MS);
        clock.unref();
      }),
    ]);

    assert.equal(end.status, 'completed', 'the engine exited 0; the broken pipe is not a failure');
    assert.equal(end.exitCode, 0);

    // The uncaught exception, if there is one, lands after `onFinished`, on the
    // write that never made it; giving the loop a turn is what lets this case
    // see it at all.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
