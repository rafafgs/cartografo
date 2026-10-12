/**
 * What the `CopilotAdapter` still holds after a session ends (t207-A, t675).
 *
 * The mirror of `session-cleanup.claude-code.test.ts`, against the second
 * adapter, for the reason the header of `copilot-adapter.ts` already records: the
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import { buildCommand } from '../../src/engine/copilot-command.ts';
import {
  UnknownSessionError,
  type SessionFinishDetail,
  type SessionStatus,
} from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** How many sessions the case runs through one adapter. See the claude-code twin. */
const SESSIONS = 50;

/** Ceiling on one session of the fake engine, which normally ends in milliseconds. */
const DEADLINE_MS = 15_000;

/** The adapter every case here builds: the real one, pointed at the fake engine. */
function fakeEngineAdapter(): CopilotAdapter {
  return new CopilotAdapter({
    commandBuilder: (spec, engineRef) => {
      const built = buildCommand(spec, engineRef);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });
}

/** Opens one session and resolves with the handle once `onFinished` has landed. */
async function runOneSession(
  adapter: CopilotAdapter,
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

test('t675 AT — fifty finished sessions leave no live session behind', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t675-copilot-'));
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

test('t675 AT — a pruned session still answers cancel and still refuses an unknown id', async (t) => {
  const workingDir = mkdtempSync(join(tmpdir(), 'cartografo-t675-copilot-cancel-'));
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

/* --- the four ways a session ends leave nobody behind ------------------------ */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** True while a process with this pid still exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What the fake engine writes about itself (`FAKE_ENGINE_RECORD`). */
interface Sidecar {
  pid: number;
  grandchildPid: number | null;
}

interface Ending {
  status: SessionStatus;
  exitCode: number | null;
  detail: SessionFinishDetail | undefined;
}

/**
 * Runs one session of the fake engine that leaves a grandchild ignoring SIGTERM
 * behind (the kit's C4 shape), waits for the end, and reports the pids that
 * were alive and whether any survived.
 */
async function endedBy(
  how: 'exit' | 'cancel' | 'wall-clock' | 'inactivity',
): Promise<{ endings: Ending[]; survivors: number[] }> {
  const workingDir = mkdtempSync(join(tmpdir(), `cartografo-t675-copilot-${how}-`));
  // Outside the working directory: the fake reproduces the files of its cwd in
  // the sidecar, and a sidecar listing itself is a read that races its own write.
  const recordDir = mkdtempSync(join(tmpdir(), `cartografo-t675-copilot-rec-${how}-`));
  const recordPath = join(recordDir, 'record.json');
  const endings: Ending[] = [];
  let announce: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const adapter = fakeEngineAdapter();
  const envOverrides: Record<string, string> = {
    FAKE_ENGINE_RECORD: recordPath,
    // A natural exit is the engine's own business and the other two adapters
    // do not sweep its group either; the grandchild matters when WE ended it.
    FAKE_ENGINE_SPAWN_CHILD: how === 'exit' ? '0' : '1',
    FAKE_ENGINE_IGNORE_SIGTERM: '1',
    FAKE_ENGINE_HANG: how === 'exit' ? '0' : '1',
    FAKE_ENGINE_EXIT_CODE: '0',
  };
  if (how === 'exit') envOverrides.FAKE_ENGINE_DELAY_MS = '300';

  try {
    const handle = await adapter.startSession(
      {
        workingDir,
        instructions: 'node instructions',
        prompt: 'the work of this turn',
        timeoutSeconds: how === 'wall-clock' ? 1 : 60,
        silenceSeconds: how === 'inactivity' ? 1 : undefined,
        envOverrides,
      },
      {
        onOutput() {
          /* not what this case measures */
        },
        onFinished(status, exitCode, detail) {
          endings.push({ status, exitCode, detail });
          announce();
        },
      },
    );

    // The fake writes its sidecar once its grandchild is up: wait for it.
    const readRecord = (): Sidecar | null => {
      try {
        return JSON.parse(readFileSync(recordPath, 'utf8')) as Sidecar;
      } catch {
        return null;
      }
    };
    const ready = (found: Sidecar | null): found is Sidecar =>
      found !== null && (how === 'exit' || found.grandchildPid !== null);
    let record = readRecord();
    for (let attempt = 0; attempt < 100 && !ready(record); attempt += 1) {
      await sleep(50);
      record = readRecord();
    }
    assert.ok(ready(record), 'the fake engine never wrote its sidecar');
    const pids = [record.pid, ...(record.grandchildPid === null ? [] : [record.grandchildPid])];

    if (how === 'cancel') await adapter.cancel(handle);

    await Promise.race([
      finished,
      sleep(DEADLINE_MS).then(() => {
        throw new Error(`the session did not end within ${DEADLINE_MS}ms (${how})`);
      }),
    ]);

    // Let the SIGKILL escalation land, then look for anyone left in the group.
    await sleep(600);
    return { endings, survivors: pids.filter(alive) };
  } finally {
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(recordDir, { recursive: true, force: true });
  }
}

for (const how of ['exit', 'cancel', 'wall-clock', 'inactivity'] as const) {
  test(`t675 AT — ending by ${how}: onFinished exactly once and no process of the group survives`, async () => {
    const { endings, survivors } = await endedBy(how);

    assert.equal(endings.length, 1, 'onFinished has to run exactly once');
    assert.deepEqual(survivors, [], 'a process of the session\'s group outlived its end');

    const expected: Record<typeof how, SessionStatus> = {
      exit: 'completed',
      cancel: 'cancelled',
      'wall-clock': 'timed_out',
      inactivity: 'timed_out',
    };
    assert.equal(endings[0]?.status, expected[how]);
    if (how === 'wall-clock') assert.equal(endings[0]?.detail?.timeoutReason, 'wall_clock');
    if (how === 'inactivity') assert.equal(endings[0]?.detail?.timeoutReason, 'silence');
  });
}
