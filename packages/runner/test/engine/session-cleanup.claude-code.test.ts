/**
 * What the `ClaudeCodeAdapter` still holds after a session ends (t207-A).
 *
 * A long-lived runner dispatches hundreds of jobs through ONE adapter object.
 * Until this ticket every one of them left a full `Session` behind in the
 * adapter's map — the `ChildProcess`, the caller's `SessionListener` (which in
 * the real dispatch closes over the whole transcript buffer,
 * `dispatch.ts`'s `lines: string[]`), the timers, the leftovers —
 * because `#finish` marked `finished = true` and never deleted the entry. The
 * map only ever grew.
 *
 * What makes this non-trivial is that the entry cannot simply be deleted:
 * invariant 3 of the FROZEN contract says "`getStatus` only returns a terminal
 * status after `onFinished` has run" (`docs/formats/engine-adapter.md:844`), and
 * four cases of the conformance kit (C1, C3, C8, C9) call `getStatus` AFTER the
 * end and expect the terminal status rather than an `UnknownSessionError`. So
 * what is dropped is the heavy state; what survives is a string per id.
 *
 * `liveSessionCount` is a diagnostic seam of THIS adapter, in the same family as
 * `commandBuilder` and `probeEnvironment` — it is not part of `EngineAdapter`,
 * which is frozen by the rule of two consumers.
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
import { UnknownSessionError, type SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/**
 * How many sessions the case runs through one adapter.
 *
 * Enough that a leak is a fact rather than a rounding error, and small enough
 * that fifty sequential `node` boots stay inside an ordinary test run. The
 * assertion is on ZERO live sessions, so the number is not a threshold — it is
 * the volume that makes the claim about a long-lived runner honest.
 */
const SESSIONS = 50;

/** Ceiling on one session of the fake engine, which normally ends in milliseconds. */
const DEADLINE_MS = 15_000;

/** The adapter every case here builds: the real one, pointed at the fake engine. */
function fakeEngineAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec) => {
      const built = buildCommand(spec);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });
}

/** Opens one session and resolves with the handle once `onFinished` has landed. */
async function runOneSession(
  adapter: ClaudeCodeAdapter,
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
        /* the lines are C6's business, not this ticket's */
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
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t207a-claude-'));
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

  // The other half of the claim, and the one that makes the pruning legal: the
  // frozen invariant 3 is unchanged, for the first id as much as for the last.
  for (const handle of [handles[0], handles.at(-1) ?? '']) {
    assert.equal(
      await adapter.getStatus(handle),
      'completed',
      'getStatus stopped answering for a finished session — invariant 3 of the frozen contract',
    );
  }
});

test('t207-A AT — a pruned session still answers cancel and still refuses an unknown id', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t207a-claude-cancel-'));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  const adapter = fakeEngineAdapter();
  const { handle } = await runOneSession(adapter, workingDir);

  assert.equal(adapter.liveSessionCount, 0);

  // C5's "already finished" is a silent no-op, and it has to stay one after the
  // heavy state is gone: whoever cancels races the adapter's own streaming
  // thread and has no way of knowing it lost.
  await adapter.cancel(handle);

  // C7, unchanged: an id this adapter never handed out is still an error, and
  // the terminal-status stub must not turn every string into a known session.
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
