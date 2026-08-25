/**
 * What the `CodexAdapter` still holds after a session ends (t207-A).
 *
 * The mirror of `session-cleanup.claude-code.test.ts`, against the second
 * adapter, for the reason the header of `codex-adapter.ts` already records: the
 * two lifecycles are deliberately duplicated rather than extracted, so a fix
 * applied to one of them proves nothing about the other. Two consumers, two
 * cases.
 *
 * The seam is the same and so is the claim: after the end, the heavy state of a
 * session is gone and `getStatus` still answers the terminal status — invariant
 * 3 of the frozen contract (`docs/formats/engine-adapter.md:778`), exercised by
 * C1, C3, C8 and C9 of the kit this adapter also runs.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { buildCommand } from '../../src/engine/codex-command.ts';
import { UnknownSessionError, type SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** How many sessions the case runs through one adapter. See the claude-code twin. */
const SESSIONS = 50;

/** Ceiling on one session of the fake engine, which normally ends in milliseconds. */
const DEADLINE_MS = 15_000;

/** The adapter every case here builds: the real one, pointed at the fake engine. */
function fakeEngineAdapter(): CodexAdapter {
  return new CodexAdapter({
    commandBuilder: (spec) => {
      const built = buildCommand(spec);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });
}

/** Opens one session and resolves with the handle once `onFinished` has landed. */
async function runOneSession(
  adapter: CodexAdapter,
  workingDir: string,
): Promise<{ handle: string; status: SessionStatus }> {
  let announce: (status: SessionStatus) => void = () => undefined;
  const finished = new Promise<SessionStatus>((resolve) => {
    announce = resolve;
  });

  const handle = await adapter.startSession(
    {
      workingDir,
      instructions: 'node instructions, coming from the database',
      prompt: 'the work of this turn',
      timeoutSeconds: 30,
      envOverrides: { FAKE_ENGINE_EXIT_CODE: '0' },
    },
    {
      onOutput() {
        /* the lines are C6's business, not this ficha's */
      },
      onFinished(status) {
        announce(status);
      },
    },
  );

  const status = await Promise.race([
    finished,
    new Promise<SessionStatus>((_resolve, reject) => {
      const clock = setTimeout(() => {
        reject(new Error(`a session did not end within ${DEADLINE_MS}ms`));
      }, DEADLINE_MS);
      clock.unref();
    }),
  ]);

  return { handle, status };
}

test('t207-A AT — fifty finished sessions leave no live session behind', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t207a-codex-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const adapter = fakeEngineAdapter();
  const handles: string[] = [];

  for (let index = 0; index < SESSIONS; index += 1) {
    const { handle, status } = await runOneSession(adapter, workingDir);
    assert.equal(status, 'completed', `session ${index} did not end cleanly`);
    handles.push(handle);
  }

  assert.equal(
    adapter.liveSessionCount,
    0,
    `${String(adapter.liveSessionCount)} of ${SESSIONS} finished sessions are still held live: ` +
      'a long-lived runner keeps every ChildProcess, listener and buffer it ever dispatched',
  );

  for (const handle of [handles[0], handles.at(-1) ?? '']) {
    assert.equal(
      await adapter.getStatus(handle),
      'completed',
      'getStatus stopped answering for a finished session — invariant 3 of the frozen contract',
    );
  }
});

test('t207-A AT — a pruned session still answers cancel and still refuses an unknown id', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t207a-codex-cancel-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const adapter = fakeEngineAdapter();
  const { handle } = await runOneSession(adapter, workingDir);

  assert.equal(adapter.liveSessionCount, 0);

  await adapter.cancel(handle);

  await assert.rejects(
    async () => adapter.getStatus('nunca-existiu'),
    (error: unknown) => {
      assert.ok(error instanceof UnknownSessionError, `expected UnknownSessionError: ${String(error)}`);
      return true;
    },
  );
  await assert.rejects(
    async () => adapter.cancel('nunca-existiu'),
    (error: unknown) => {
      assert.ok(error instanceof UnknownSessionError, `expected UnknownSessionError: ${String(error)}`);
      return true;
    },
  );
});
