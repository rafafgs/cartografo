/**
 * The `ClaudeCodeAdapter` carrying content that does not fit in an argv (t203).
 *
 * C11 of the kit certifies the OUTCOME — the oversized content reaches the
 * process by some legitimate path, and not by the one that dies at `spawn`.
 * What it deliberately does not certify is the MECHANISM, because the mechanism
 * is each adapter's private business. This file is where this adapter's
 * mechanism is pinned: an ephemeral system-prompt file in the workdir, plus the
 * prompt on stdin.
 *
 * Two properties of that file are the whole reason it is tested here and not
 * left to the kit:
 *
 * - **mode 0600.** The file carries the node's instructions verbatim, in a
 *   directory a session is running commands in. World-readable would be a skill
 *   leaking to every process on the machine.
 * - **it is removed on EVERY exit path.** Natural completion, timeout and
 *   cancellation all pass through `#finish`, and a file left behind in a
 *   worktree that gets handed back is both a leak and a surprise for whatever
 *   reads that directory next.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import {
  ARGV_INLINE_LIMIT_BYTES,
  SYSTEM_PROMPT_FILE_NAME,
  buildCommand,
} from '../../src/engine/command.ts';
import type { SessionSpec, SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for a session that is expected to come up and end. */
const DEADLINE_MS = 15_000;

/** Instructions past the inline limit, which is what puts the file branch in play. */
const OVERSIZED_INSTRUCTIONS = `oversized node instructions\n${'i'.repeat(ARGV_INLINE_LIMIT_BYTES)}`;

const MARKER = 'MARKER-t203-claude-code';
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
  readonly adapter: ClaudeCodeAdapter;
  readonly handle: string;
  readonly workingDir: string;
  readonly recordPath: string;
  readonly ended: Promise<Ending>;
  cleanup(): void;
}

/**
 * Opens one session against the fake engine, seamed exactly as the kit seams it.
 *
 * The sidecar lives OUTSIDE the workdir for the same reason it does in the kit:
 * inside, it would show up in the very file listing these cases inspect.
 */
async function openSession(spec: Partial<SessionSpec> = {}): Promise<LiveSession> {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t203-'));
  const workingDir = join(root, 'workdir');
  mkdirSync(workingDir);
  const recordPath = join(root, 'record.json');

  const adapter = new ClaudeCodeAdapter({
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

  const handle = await adapter.startSession(
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
        /* the lines are C6's business, not this ficha's */
      },
      onFinished(status, exitCode) {
        announce({ status, exitCode });
      },
    },
  );

  return {
    adapter,
    handle,
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

test('t203 AT — the oversized instructions go to a 0600 file and the prompt to stdin', async () => {
  const session = await openSession({
    // Alive long enough to observe the file while the session is running; the
    // wait for the end is still deadline-based.
    envOverrides: { FAKE_ENGINE_EXIT_CODE: '0', FAKE_ENGINE_DELAY_MS: '500' },
  });
  const path = join(session.workingDir, SYSTEM_PROMPT_FILE_NAME);

  try {
    assert.ok(existsSync(path), 'the ephemeral system prompt was not written before the spawn');
    assert.equal(
      statSync(path).mode & 0o777,
      0o600,
      'the node instructions are readable by anyone on the machine',
    );
    assert.equal(
      readFileSync(path, 'utf8'),
      OVERSIZED_INSTRUCTIONS,
      'the instructions have to reach the file verbatim, with no prefix or reformatting',
    );

    const end = await session.ended;
    assert.equal(end.status, 'completed');
    assert.equal(end.exitCode, 0);

    const record = await readRecord(session.recordPath);
    assert.equal(record.stdin, OVERSIZED_PROMPT, 'the prompt did not reach the process on stdin');
    assert.ok(
      !record.argv.join('\n').includes(OVERSIZED_INSTRUCTIONS),
      'the instructions are still in the argv, which is the ceiling this ficha exists to dodge',
    );

    assert.equal(
      existsSync(path),
      false,
      'the ephemeral file survived the session — a skill left behind in a worktree',
    );
  } finally {
    session.cleanup();
  }
});

test('t203 AT — the ephemeral file is removed when the wall clock kills the session', async () => {
  const session = await openSession({
    timeoutSeconds: 1,
    envOverrides: { FAKE_ENGINE_HANG: '1' },
  });
  const path = join(session.workingDir, SYSTEM_PROMPT_FILE_NAME);

  try {
    assert.ok(existsSync(path), 'the file has to exist while the session is running');

    const end = await session.ended;
    assert.equal(end.status, 'timed_out');
    assert.equal(existsSync(path), false, 'a session killed by the clock left its file behind');
  } finally {
    session.cleanup();
  }
});

test('t203 AT — the ephemeral file is removed when the session is cancelled', async () => {
  const session = await openSession({ envOverrides: { FAKE_ENGINE_HANG: '1' } });
  const path = join(session.workingDir, SYSTEM_PROMPT_FILE_NAME);

  try {
    assert.ok(existsSync(path), 'the file has to exist while the session is running');

    await session.adapter.cancel(session.handle);
    const end = await session.ended;
    assert.equal(end.status, 'cancelled');
    assert.equal(existsSync(path), false, 'a cancelled session left its file behind');
  } finally {
    session.cleanup();
  }
});

test('t203 AT — a session under the limit writes no file and keeps stdin closed', async () => {
  // The regression that matters: the branch is opt-in by SIZE, and the ordinary
  // session has to keep the shape invariant 6 gave it — nothing written, and
  // nothing left in the workdir that the node did not put there.
  const session = await openSession({
    instructions: 'node instructions, coming from the database',
    prompt: 'the work of this turn',
    envOverrides: { FAKE_ENGINE_EXIT_CODE: '0' },
  });

  try {
    const end = await session.ended;
    assert.equal(end.status, 'completed');

    const record = await readRecord(session.recordPath);
    assert.equal(record.stdin, '', 'the small-content path must not open a pipe to the engine');
    assert.deepEqual(
      Object.keys(record.files),
      [],
      'the small-content path must not leave a file in the workdir',
    );
  } finally {
    session.cleanup();
  }
});

test('t203 AT — an engine that dies before reading stdin does not bring the runner down', async () => {
  // A broken pipe is not a session failure: the engine exited, which is an
  // outcome the adapter already knows how to report. What it must not be is an
  // unhandled `'error'` on `child.stdin`, which in Node is an uncaught
  // exception — the runner dying because one session's process was fast.
  //
  // The payload is large on purpose. Node buffers a small write outright and
  // the race never happens; past the pipe's own buffer (64 KiB on both
  // platforms) the write is still in flight when the child is already gone.
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t203-epipe-'));
  const adapter = new ClaudeCodeAdapter({
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

    // The uncaught exception, if there is one, is asynchronous: it lands after
    // `onFinished`, on the write that never made it. Giving the loop a turn is
    // what makes this case able to see it at all.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
