/**
 * What a session-start failure says about its cause (t688).
 *
 * GitHub issue #2: a shell node whose argv exceeded the Windows command-line
 * limit made `spawn` throw `ENAMETOOLONG`, and the operator read
 * `could not start "node"` five times — the code and message of the underlying
 * error never reached the message. These cases pin the helper that builds the
 * message and the two start sites that use it.
 *
 * AT4 and AT5 drive a real 4 MiB argument. Node throws that synchronously on
 * POSIX (`E2BIG`) and on Windows (`ENAMETOOLONG`), so both codes are accepted.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { ShellAdapter } from '../../src/engine/shell-adapter.ts';
import { ProcessLifecycle, describeStartFailure } from '../../src/engine/process-lifecycle.ts';
import {
  SessionStartError,
  type SessionListener,
  type SessionSpec,
} from '../../src/engine/types.ts';

const OVERSIZE = 'x'.repeat(4 * 1024 * 1024);
const TOO_LONG = ['E2BIG', 'ENAMETOOLONG'];

const listener: SessionListener = {
  onOutput: () => undefined,
  onFinished: () => undefined,
};

function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cartografo-t688-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codeOf(error: SessionStartError): string {
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  assert.ok(typeof code === 'string' && TOO_LONG.includes(code), `unexpected cause code: ${String(code)}`);
  return code;
}

test('t688 AT1 — the helper names the cause code and message', () => {
  const cause = Object.assign(new Error('spawn ENAMETOOLONG'), { code: 'ENAMETOOLONG' });

  assert.equal(
    describeStartFailure('node', cause),
    'could not start "node": ENAMETOOLONG (spawn ENAMETOOLONG)',
  );
});

test('t688 AT2 — without a string code the message alone is appended', () => {
  assert.equal(describeStartFailure('node', new Error('boom')), 'could not start "node": boom');
  assert.equal(
    describeStartFailure('node', Object.assign(new Error('boom'), { code: 7 })),
    'could not start "node": boom',
  );
});

test('t688 AT3 — anything else keeps the bare message', () => {
  const bare = 'could not start "node"';

  assert.equal(describeStartFailure('node', undefined), bare);
  assert.equal(describeStartFailure('node', 'a string'), bare);
  assert.equal(describeStartFailure('node', { code: 'E2BIG', message: 'plain object' }), bare);
  assert.equal(describeStartFailure('node', new Error('')), bare);
});

test('t688 AT4 — ProcessLifecycle names the code of a real oversize argv and keeps the cause', async (t) => {
  const workingDir = scratch(t);
  const helper = new ProcessLifecycle({ graceMs: 200 });

  await assert.rejects(
    helper.start({ timeoutSeconds: 30, workingDir }, listener, {
      command: { command: process.execPath, args: ['-e', '0', OVERSIZE] },
      environment: () => ({ ...process.env }),
      state: undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
      const code = codeOf(error);
      assert.ok(error.message.includes(code), `the message has to carry the code: ${error.message}`);
      assert.ok(error.message.includes(process.execPath), error.message);
      return true;
    },
  );
  assert.equal(helper.liveSessionCount, 0);
});

function shellSpec(workingDir: string, argv: readonly string[]): SessionSpec {
  return {
    workingDir,
    instructions: 'A shell node.',
    prompt: 'Ticket: a deterministic node.',
    timeoutSeconds: 30,
    command: { argv },
  };
}

test('t688 AT5 — ShellAdapter names the code of a real oversize argv and keeps the cause', async (t) => {
  const workingDir = scratch(t);
  const adapter = new ShellAdapter({ graceMs: 200 });

  await assert.rejects(
    adapter.startSession(shellSpec(workingDir, [process.execPath, '-e', '0', OVERSIZE]), listener),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
      const code = codeOf(error);
      assert.ok(error.message.includes(code), `the message has to carry the code: ${error.message}`);
      assert.ok(error.message.includes(process.execPath), error.message);
      return true;
    },
  );
});

test('t688 AT6 — a throwing environment builder is named in the message and kept as cause', async (t) => {
  const workingDir = scratch(t);
  const failure = new Error('no environment');
  const adapter = new ShellAdapter({
    graceMs: 200,
    environmentBuilder: () => {
      throw failure;
    },
  });

  await assert.rejects(
    adapter.startSession(shellSpec(workingDir, [process.execPath, '-e', '0']), listener),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
      assert.ok(error.message.endsWith(': no environment'), error.message);
      assert.equal(error.cause, failure);
      return true;
    },
  );
});
