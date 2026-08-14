/**
 * EngineAdapter conformance kit — the seven C1–C7 cases of the table in
 * `docs/formatos/engine-adapter.md`, as `node:test` tests parameterized by any
 * implementation of the interface.
 *
 * "This is the suite a third-party adapter has to pass to get in"
 * (`docs/formatos/engine-adapter.md:342-346`). That is why it lives in `src/`
 * and not in `test/`: it is a published artifact of the package, consumed by
 * the Codex adapter (t119) and by whoever plugs in a new CLI, not a private
 * test of this repository.
 *
 * Two design rules keep the kit reusable:
 *
 * 1. **No engine vocabulary in here.** The kit only speaks `SessionSpec`,
 *    `SessionStatus` and `SessionListener`. The fake engine is configured
 *    through `envOverrides`, which the interface already defines as opaque
 *    additions to the process's environment — the kit configures the fake
 *    without knowing which binary the adapter decided to run.
 * 2. **Every wait has a deadline of its own and an explicit message** (the
 *    document's execution note): no case sleeps hoping for the best.
 *
 * The one point where a specific engine shows up is optional and injected:
 * `engineRefFrame` carries the line THAT engine emits with its session id,
 * because Claude Code's `system/init` and Codex's `thread.started` do not have
 * the same shape.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type EngineAdapter,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
  TERMINAL_STATUSES,
  UnknownSessionError,
} from './types.ts';

/** Default deadline when waiting for a terminal status. */
const DEFAULT_DEADLINE_MS = 15_000;

/**
 * Window used only to prove that NOTHING ELSE happens (a second `onFinished`, a
 * late `onOutput`, a clock still armed).
 *
 * It is the kit's only fixed wait, and it is fixed out of necessity: there is
 * no event for "what will not happen". The waits for something that must happen
 * are all deadline-based with an explicit failure.
 */
const SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** What the fake engine recorded about what the process received. */
interface FakeRecord {
  readonly pid: number;
  readonly grandchildPid: number | null;
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly stdin: string;
  readonly files: Record<string, string>;
}

/** A line the fake engine must emit, and on which stream. */
interface FakeLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface KitOptions {
  /**
   * The line THIS engine emits carrying its session id, and the id the adapter
   * must extract from it. Absent, the kit only checks that `onEngineRef` is not
   * called more than once.
   */
  readonly engineRefFrame?: { readonly line: string; readonly expectedRef: string };
  /** Deadline when waiting for a terminal status. Default 15s. */
  readonly deadlineMs?: number;
}

/** Collects everything the adapter reports and can wait for the end with a deadline. */
class Collector implements SessionListener {
  readonly lines: string[] = [];
  readonly refs: string[] = [];
  readonly endings: Array<{ status: SessionStatus; exitCode: number | null }> = [];
  linesAfterEnd = 0;

  #waiters: Array<() => void> = [];

  onOutput(line: string): void {
    if (this.endings.length > 0) this.linesAfterEnd += 1;
    this.lines.push(line);
  }

  onEngineRef(engineRef: string): void {
    this.refs.push(engineRef);
  }

  onFinished(status: SessionStatus, exitCode: number | null): void {
    this.endings.push({ status, exitCode });
    const pending = this.#waiters;
    this.#waiters = [];
    for (const notify of pending) notify();
  }

  async awaitEnd(
    label: string,
    deadlineMs: number,
  ): Promise<{ status: SessionStatus; exitCode: number | null }> {
    if (this.endings.length === 0) {
      await new Promise<void>((resolve, reject) => {
        const clock = setTimeout(() => {
          reject(
            new Error(
              `${label}: onFinished did not happen within ${deadlineMs}ms — ` +
                `${this.lines.length} line(s) received so far`,
            ),
          );
        }, deadlineMs);
        this.#waiters.push(() => {
          clearTimeout(clock);
          resolve();
        });
      });
    }
    const first = this.endings[0];
    assert.ok(first, `${label}: onFinished resolved without recording the outcome`);
    return first;
  }
}

/** Ephemeral directories of a case: the session's workdir and the fake's sidecar. */
interface Scenario {
  readonly workingDir: string;
  readonly recordPath: string;
  readRecord(): FakeRecord;
  cleanup(): void;
}

function buildScenario(): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-kit-'));
  const workingDir = join(root, 'workdir');
  mkdirSync(workingDir);
  // The sidecar lives OUTSIDE the workdir: inside, it would itself show up in
  // the file list case C2 inspects.
  const recordPath = join(root, 'record.json');
  return {
    workingDir,
    recordPath,
    readRecord: () => JSON.parse(readFileSync(recordPath, 'utf8')) as FakeRecord,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** `true` while the pid exists; `EPERM` counts as alive (it exists, but is not ours). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function requireProcessDead(pid: number, label: string, deadlineMs = 5_000): Promise<void> {
  const limit = Date.now() + deadlineMs;
  while (Date.now() < limit) {
    if (!isProcessAlive(pid)) return;
    await sleep(25);
  }
  assert.fail(`${label}: process ${pid} was still alive ${deadlineMs}ms after the end (orphan)`);
}

/** Every legitimate channel through which the process may have received anything. */
function everythingTheProcessReceived(record: FakeRecord): string {
  return [
    record.argv.join('\n'),
    Object.values(record.env).join('\n'),
    record.stdin,
    Object.values(record.files).join('\n'),
  ].join('\n');
}

function requireBaselineStatus(status: SessionStatus, label: string): void {
  assert.ok(
    (TERMINAL_STATUSES as readonly string[]).includes(status),
    `${label}: "${status}" is not a terminal status of the interface's baseline`,
  );
}

/**
 * Registers the seven conformance cases against an adapter.
 *
 * @param makeAdapter Factory returning a NEW adapter (clean state), already
 *   seamed to run `fakeEnginePath` in place of the real binary.
 * @param fakeEnginePath Path of the controllable fake engine.
 * @param options Adjustments specific to the engine under test.
 */
export function runConformanceKit(
  makeAdapter: (fakeEnginePath: string) => EngineAdapter,
  fakeEnginePath: string,
  options: KitOptions = {},
): void {
  const deadline = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const newAdapter = (): EngineAdapter => makeAdapter(fakeEnginePath);

  const linesForEnv = (lines: FakeLine[]): string => JSON.stringify(lines);

  describe('EngineAdapter conformance kit', () => {
    test('C1 — basic session', async () => {
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const lines: FakeLine[] = [];
      if (options.engineRefFrame) {
        lines.push({ stream: 'stdout', text: options.engineRefFrame.line });
      }
      lines.push({ stream: 'stdout', text: 'first line' });
      lines.push({ stream: 'stdout', text: 'second line' });

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions: 'node instructions, coming from the database',
        prompt: 'the work of this turn',
        timeoutSeconds: 30,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_LINES: linesForEnv(lines),
          FAKE_ENGINE_EXIT_CODE: '0',
          // Holds the process up long enough to observe "running" without a
          // race; waiting for the end is still deadline-based.
          FAKE_ENGINE_DELAY_MS: '500',
        },
      };

      try {
        const handle = await adapter.startSession(spec, collector);
        assert.equal(
          await adapter.getStatus(handle),
          'running',
          'C1: right after the start the session has to be "running"',
        );

        const end = await collector.awaitEnd('C1', deadline);
        assert.equal(end.status, 'completed');
        assert.equal(end.exitCode, 0);
        assert.equal(await adapter.getStatus(handle), 'completed');

        await sleep(SETTLE_MS);
        assert.equal(collector.endings.length, 1, 'C1: onFinished has to happen exactly once');
        assert.equal(
          collector.linesAfterEnd,
          0,
          'C1: no onOutput may arrive after onFinished (invariant 2)',
        );

        const record = scenario.readRecord();
        assert.equal(
          record.stdin,
          '',
          'C1: the engine received content on stdin — invariant 6 asks for stdin closed/on /dev/null',
        );

        assert.ok(collector.refs.length <= 1, 'C1: onEngineRef fires at most once');
        if (options.engineRefFrame) {
          assert.deepEqual(collector.refs, [options.engineRefFrame.expectedRef]);
        }
      } finally {
        scenario.cleanup();
      }
    });

    test('C2 — skill injection', async () => {
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const marker = 'MARKER-a1b2c3';
      const prompt = 'the work of this turn, without the marker';
      assert.ok(!prompt.includes(marker), 'C2: the fixture itself must not leak the marker into the prompt');

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions: `You are the test node. ${marker}`,
        prompt,
        timeoutSeconds: 30,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_EXIT_CODE: '0',
        },
      };

      try {
        await adapter.startSession(spec, collector);
        await collector.awaitEnd('C2', deadline);

        // An assertion the specification forbids: inspecting the SessionSpec.
        // Only what the PROCESS received counts.
        const received = everythingTheProcessReceived(scenario.readRecord());
        assert.ok(
          received.includes(marker),
          'C2: the instructions marker did not reach the process by any path ' +
            '(argument, system-prompt flag, stdin or ephemeral file)',
        );
        assert.ok(received.includes(prompt), "C2: the turn's prompt did not reach the process");
      } finally {
        scenario.cleanup();
      }
    });

    test('C3 — timeout', async () => {
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions: 'node instructions',
        prompt: 'work that never ends',
        timeoutSeconds: 1,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_HANG: '1',
        },
      };

      try {
        const handle = await adapter.startSession(spec, collector);
        const end = await collector.awaitEnd('C3', deadline);

        assert.equal(end.status, 'timed_out', 'C3: running the clock out is "timed_out", not "failed"');
        requireBaselineStatus(end.status, 'C3');
        assert.equal(await adapter.getStatus(handle), 'timed_out');

        await requireProcessDead(scenario.readRecord().pid, 'C3');

        // Past twice the original deadline, the clock must not fire again.
        await sleep(1_000 + SETTLE_MS);
        assert.equal(collector.endings.length, 1, 'C3: onFinished happened more than once');
      } finally {
        scenario.cleanup();
      }
    });

    test('C4 — process death (SIGTERM ignored, grandchild alive)', async () => {
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions: 'node instructions',
        prompt: 'work that resists SIGTERM',
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_HANG: '1',
          FAKE_ENGINE_IGNORE_SIGTERM: '1',
          FAKE_ENGINE_SPAWN_CHILD: '1',
        },
      };

      try {
        const handle = await adapter.startSession(spec, collector);
        // The sidecar exists as soon as the process came up; reading it before
        // killing guarantees both pids.
        await sleep(SETTLE_MS);
        const record = scenario.readRecord();

        await adapter.cancel(handle);
        const end = await collector.awaitEnd('C4', deadline);

        requireBaselineStatus(end.status, 'C4');
        assert.equal(collector.endings.length, 1, 'C4: onFinished has to happen even with SIGKILL');

        await requireProcessDead(record.pid, 'C4 (engine process)');
        assert.ok(record.grandchildPid, 'C4: the fixture must have left a grandchild alive');
        await requireProcessDead(record.grandchildPid, 'C4 (grandchild that outlived the parent)');
      } finally {
        scenario.cleanup();
      }
    });

    test('C5 — cancellation', async () => {
      const longSessionSpec = (scenario: Scenario): SessionSpec => ({
        workingDir: scenario.workingDir,
        instructions: 'node instructions',
        prompt: 'long work',
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_HANG: '1',
        },
      });

      // The reported status is THE ONE THAT WAS PASSED, not a fixed "cancelled".
      const withOwnStatus = buildScenario();
      try {
        const collector = new Collector();
        const adapter = newAdapter();
        const handle = await adapter.startSession(longSessionSpec(withOwnStatus), collector);
        await adapter.cancel(handle, 'timed_out');
        const end = await collector.awaitEnd('C5 (own status)', deadline);
        assert.equal(end.status, 'timed_out');

        // Cancelling again, already terminal, is a silent no-op — not an error.
        await adapter.cancel(handle);
        await sleep(SETTLE_MS);
        assert.equal(
          collector.endings.length,
          1,
          'C5: cancelling an already terminal session must not fire a second onFinished',
        );
      } finally {
        withOwnStatus.cleanup();
      }

      // With no argument, the default is "cancelled".
      const withoutArgument = buildScenario();
      try {
        const collector = new Collector();
        const adapter = newAdapter();
        const handle = await adapter.startSession(longSessionSpec(withoutArgument), collector);
        await adapter.cancel(handle);
        const end = await collector.awaitEnd('C5 (default)', deadline);
        assert.equal(end.status, 'cancelled');
      } finally {
        withoutArgument.cleanup();
      }
    });

    test('C6 — event harvesting', async () => {
      const sequence: FakeLine[] = [
        { stream: 'stdout', text: '{"type":"assistant","text":"structured frame 1"}' },
        { stream: 'stdout', text: 'dying scream in plain text, not JSON at all' },
        { stream: 'stdout', text: '{"type":"assistant","text":"structured frame 2"}' },
        { stream: 'stderr', text: 'runtime warning on stderr' },
      ];
      const onlyFromStream = (stream: 'stdout' | 'stderr'): string[] =>
        sequence.filter((l) => l.stream === stream).map((l) => l.text);

      const run = async (
        label: string,
        exitCode: number,
      ): Promise<{ status: SessionStatus; exitCode: number | null; lines: string[] }> => {
        const scenario = buildScenario();
        const collector = new Collector();
        const adapter = newAdapter();
        try {
          await adapter.startSession(
            {
              workingDir: scenario.workingDir,
              instructions: 'node instructions',
              prompt: 'harvest',
              timeoutSeconds: 30,
              envOverrides: {
                FAKE_ENGINE_RECORD: scenario.recordPath,
                FAKE_ENGINE_LINES: linesForEnv(sequence),
                FAKE_ENGINE_EXIT_CODE: String(exitCode),
              },
            },
            collector,
          );
          const end = await collector.awaitEnd(label, deadline);
          await sleep(SETTLE_MS);
          return { ...end, lines: [...collector.lines] };
        } finally {
          scenario.cleanup();
        }
      };

      const failed = await run('C6 (non-zero exit)', 3);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.exitCode, 3, 'C6: the exact exit code has to reach onFinished');

      for (const line of sequence) {
        assert.ok(
          failed.lines.includes(line.text),
          `C6: the line ${JSON.stringify(line.text)} (${line.stream}) did not reach onOutput`,
        );
      }

      // Order: stdout and stderr are two pipes, and only the order WITHIN each
      // one is deterministic at the reader. The merge of the two is checked by
      // presence.
      for (const stream of ['stdout', 'stderr'] as const) {
        const expected = onlyFromStream(stream);
        const received = failed.lines.filter((line) => expected.includes(line));
        assert.deepEqual(received, expected, `C6: the ${stream} lines arrived out of order`);
      }

      const ok = await run('C6 (zero exit)', 0);
      assert.equal(ok.status, 'completed');
      assert.equal(ok.exitCode, 0);
    });

    test('C7 — unknown handle', async () => {
      const adapter = newAdapter();
      const missing = 'handle-that-never-existed';

      await assert.rejects(
        () => adapter.getStatus(missing),
        UnknownSessionError,
        'C7: getStatus has to throw, never invent a status',
      );
      await assert.rejects(
        () => adapter.cancel(missing),
        UnknownSessionError,
        'C7: cancel has to throw for an unknown handle',
      );
    });
  });
}
