/**
 * EngineAdapter conformance kit — the ten C1–C10 cases of the table in
 * `docs/formats/engine-adapter.md`, as `node:test` tests parameterized by any
 * implementation of the interface.
 *
 * "This is the suite a third-party adapter has to pass to get in"
 * (`docs/formats/engine-adapter.md:342-346`). That is why it lives in `src/`
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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCapabilities,
  SessionStartError,
  type EngineAdapter,
  type SessionFinishDetail,
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

/**
 * Slack C9 allows between the silence window closing and `onFinished` landing.
 *
 * A ceiling on a wait that normally ends in milliseconds — the SIGTERM, the
 * pipes closing, the `close` event — never an expected duration. Wide enough
 * that a loaded machine does not turn the case red, narrow enough that a
 * watchdog armed on the wrong instant still shows.
 */
const SILENCE_TOLERANCE_MS = 3_000;

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

/** One outcome, as the collector saw it — with the instant it landed (C9). */
interface Ending {
  status: SessionStatus;
  exitCode: number | null;
  detail: SessionFinishDetail | undefined;
  /** When `onFinished` fired. C9 is the only case that measures time. */
  at: number;
}

/** Collects everything the adapter reports and can wait for the end with a deadline. */
class Collector implements SessionListener {
  readonly lines: string[] = [];
  readonly refs: string[] = [];
  readonly endings: Ending[] = [];
  linesAfterEnd = 0;
  /** When the last line arrived, which is what the inactivity case measures from. */
  lastOutputAt: number | null = null;

  #waiters: Array<() => void> = [];

  onOutput(line: string): void {
    if (this.endings.length > 0) this.linesAfterEnd += 1;
    this.lastOutputAt = Date.now();
    this.lines.push(line);
  }

  onEngineRef(engineRef: string): void {
    this.refs.push(engineRef);
  }

  onFinished(status: SessionStatus, exitCode: number | null, detail?: SessionFinishDetail): void {
    this.endings.push({ status, exitCode, detail, at: Date.now() });
    const pending = this.#waiters;
    this.#waiters = [];
    for (const notify of pending) notify();
  }

  async awaitEnd(label: string, deadlineMs: number): Promise<Ending> {
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
  /**
   * A second sidecar, for the only case that opens TWO sessions in the same
   * workdir (C10). Separate files because each process writes its own, and one
   * path would leave the case reading whichever wrote last.
   */
  readonly secondRecordPath: string;
  readRecord(deadlineMs?: number): Promise<FakeRecord>;
  readSecondRecord(deadlineMs?: number): Promise<FakeRecord>;
  cleanup(): void;
}

/**
 * How long the fake's sidecar may take to appear.
 *
 * Same 5s `requireProcessDead` allows, and for the same reason: it is the ceiling
 * on a wait that normally ends in milliseconds, not an expected duration.
 */
const RECORD_DEADLINE_MS = 5_000;

/**
 * The fake's sidecar, once it is readable on disk.
 *
 * This is a wait for something that MUST happen, so by this kit's own rule it is
 * deadline-based with an explicit failure — never a fixed sleep. A fixed 300ms
 * one used to stand at C4's call site, and on a loaded machine it was not enough
 * for a freshly spawned `node` to boot, read its stdin, fork the grandchild and
 * write the JSON: the case died with a bare `ENOENT ... record.json` naming
 * neither the case nor what it was checking. Retrying also closes a second race
 * the fixed wait could not see — the write is not atomic, so the file can exist
 * while still being half a JSON document.
 *
 * @param recordPath Where the fake was told to write it.
 * @param deadlineMs Ceiling on the wait.
 * @returns What the process recorded about what it received.
 */
async function awaitRecord(recordPath: string, deadlineMs: number): Promise<FakeRecord> {
  const limit = Date.now() + deadlineMs;
  let lastError: unknown;
  for (;;) {
    try {
      return JSON.parse(readFileSync(recordPath, 'utf8')) as FakeRecord;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= limit) break;
    await sleep(25);
  }
  return assert.fail(
    `the fake engine did not write a readable ${recordPath} within ${deadlineMs}ms ` +
      `(last failure: ${String(lastError)})`,
  );
}

function buildScenario(): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-kit-'));
  const workingDir = join(root, 'workdir');
  mkdirSync(workingDir);
  // The sidecar lives OUTSIDE the workdir: inside, it would itself show up in
  // the file list case C2 inspects.
  const recordPath = join(root, 'record.json');
  const secondRecordPath = join(root, 'record-2.json');
  return {
    workingDir,
    recordPath,
    secondRecordPath,
    readRecord: async (deadlineMs = RECORD_DEADLINE_MS) => await awaitRecord(recordPath, deadlineMs),
    readSecondRecord: async (deadlineMs = RECORD_DEADLINE_MS) =>
      await awaitRecord(secondRecordPath, deadlineMs),
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
 * Combined size of `instructions` + `prompt` in C11, in bytes.
 *
 * ~300 KB is not a round number picked for looks: it is comfortably past
 * Linux's 128 KiB single-argument ceiling (`MAX_ARG_STRLEN`) AND past macOS's
 * ~256 KiB whole-block one (`ARG_MAX`), so an adapter that keeps the content in
 * argv fails on both platforms rather than only on the stricter one.
 */
const OVERSIZED_INSTRUCTIONS_BYTES = 200 * 1024;
const OVERSIZED_PROMPT_BYTES = 100 * 1024;

/**
 * Registers the eleven conformance cases against an adapter.
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

        const record = await scenario.readRecord();
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
        const received = everythingTheProcessReceived(await scenario.readRecord());
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

        await requireProcessDead((await scenario.readRecord()).pid, 'C3');

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
        // killing guarantees both pids. Waiting for it to APPEAR, rather than
        // for a fixed window, is what keeps this case about process death
        // instead of about how loaded the machine is.
        const record = await scenario.readRecord();

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

      const run = async (label: string, exitCode: number): Promise<Ending & { lines: string[] }> => {
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

    test('C8 — stop race (the first stop wins)', async () => {
      // Two independent callers can order a stop: the adapter's own clock and
      // `cancel()`. Whoever gets there FIRST decides the terminal status —
      // "recording the reason HERE is what takes the watchdog out of the race
      // with the adapter's own streaming thread" (`types.ts:239-241`). A second
      // stop landing while the SIGTERM→SIGKILL escalation is still armed has to
      // be a complete no-op, or the reported status depends on which internal
      // path (the natural close, or the escalation's safety net) happens to fire.
      const raceSpec = (scenario: Scenario): SessionSpec => ({
        workingDir: scenario.workingDir,
        instructions: 'node instructions',
        prompt: 'work that resists SIGTERM',
        // Generous on purpose: the internal clock must never fire on its own,
        // so the only two stops in play are the ones the case orders.
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_HANG: '1',
          // Surviving the SIGTERM is what keeps the grace window open long
          // enough for the second stop to land INSIDE it.
          FAKE_ENGINE_IGNORE_SIGTERM: '1',
        },
      });

      const race = async (
        label: string,
        first: SessionStatus,
        second: SessionStatus,
      ): Promise<void> => {
        const scenario = buildScenario();
        const collector = new Collector();
        const adapter = newAdapter();

        try {
          const handle = await adapter.startSession(raceSpec(scenario), collector);
          // The fake installs the SIGTERM handler right after writing the
          // sidecar; stopping before that would kill it with the first signal
          // and there would be no grace window to race inside (the same reason
          // C4 waits here). Between the two stops there is NO wait at all.
          const record = await scenario.readRecord();

          await adapter.cancel(handle, first);
          await adapter.cancel(handle, second);

          const end = await collector.awaitEnd(label, deadline);
          assert.equal(
            end.status,
            first,
            `${label}: the status reported is the SECOND stop's, not the first one's`,
          );
          requireBaselineStatus(end.status, label);
          assert.equal(
            await adapter.getStatus(handle),
            first,
            `${label}: getStatus disagrees with the status delivered to onFinished`,
          );

          // Mirrors C4: whichever stop won, the process still has to die.
          await requireProcessDead(record.pid, label);

          await sleep(SETTLE_MS);
          assert.equal(
            collector.endings.length,
            1,
            `${label}: the second stop must not arm a second escalation/safety net`,
          );
        } finally {
          scenario.cleanup();
        }
      };

      await race('C8 (timed_out, then cancelled)', 'timed_out', 'cancelled');
      // Swapped: proves "the first one wins" and not "'timed_out' wins".
      await race('C8 (cancelled, then timed_out)', 'cancelled', 'timed_out');
    });

    test('C9 — inactivity', async () => {
      // The second watchdog (t163): a session that keeps printing is alive, and
      // one that goes quiet is stuck. The case is built so that ONLY the
      // inactivity clock can end it — the wall clock is a minute away — and so
      // that a watchdog which never resets would fire visibly early: the
      // heartbeats span two whole silence windows, and an unreset timer would
      // stop the session in the middle of them.
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const silenceSeconds = 1;
      const silenceMs = silenceSeconds * 1_000;
      const heartbeatMs = silenceMs / 2;
      const heartbeats: FakeLine[] = [1, 2, 3, 4].map((index) => ({
        stream: 'stdout',
        text: `heartbeat ${index}`,
      }));

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions: 'node instructions',
        prompt: 'work that talks and then goes quiet',
        // Generous on purpose: whatever ends this session, it is not the clock.
        timeoutSeconds: 60,
        silenceSeconds,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_LINES: linesForEnv(heartbeats),
          // One line per interval instead of all at once — and then, with
          // nothing left to say, the engine hangs alive and silent.
          FAKE_ENGINE_HEARTBEAT_MS: String(heartbeatMs),
          FAKE_ENGINE_HANG: '1',
        },
      };

      try {
        const startedAt = Date.now();
        const handle = await adapter.startSession(spec, collector);
        const end = await collector.awaitEnd('C9', deadline);

        assert.equal(
          end.status,
          'timed_out',
          'C9: silence past the budget is "timed_out" — the vocabulary does not grow a status for it',
        );
        requireBaselineStatus(end.status, 'C9');
        assert.equal(end.exitCode, null, 'C9: a process killed by a signal has no exit code');
        assert.deepEqual(
          end.detail,
          { timeoutReason: 'silence' },
          'C9: the cause has to travel with the outcome, or the two watchdogs are indistinguishable',
        );
        assert.equal(await adapter.getStatus(handle), 'timed_out');

        assert.equal(
          collector.lines.length,
          heartbeats.length,
          `C9: every heartbeat has to survive — the session was stopped after ` +
            `${collector.lines.length} of ${heartbeats.length}, so the watchdog does not reset on output`,
        );

        const lastOutputAt = collector.lastOutputAt;
        assert.ok(lastOutputAt !== null, 'C9: no output ever arrived; the fixture is broken');
        assert.ok(
          end.at - startedAt >= heartbeats.length * heartbeatMs,
          'C9: the session ended before the heartbeats did — the watchdog fired from the start, not from the last line',
        );
        // Timers do not fire early; the small slack is for the gap between the
        // re-arm (on the raw chunk) and the `onOutput` that follows it.
        assert.ok(
          end.at - lastOutputAt >= silenceMs - 100,
          `C9: the stop came ${end.at - lastOutputAt}ms after the last line, short of the ${silenceMs}ms window`,
        );
        assert.ok(
          end.at - lastOutputAt <= silenceMs + SILENCE_TOLERANCE_MS,
          `C9: the stop came ${end.at - lastOutputAt}ms after the last line, far past the ${silenceMs}ms window`,
        );

        await requireProcessDead((await scenario.readRecord()).pid, 'C9');

        // Whoever stopped it first decided; a cancel afterwards is the same
        // silent no-op C5 already demands.
        await adapter.cancel(handle);
        await sleep(SETTLE_MS);
        assert.equal(collector.endings.length, 1, 'C9: onFinished happened more than once');
        assert.equal(
          collector.linesAfterEnd,
          0,
          'C9: no onOutput may arrive after onFinished (invariant 2)',
        );
      } finally {
        scenario.cleanup();
      }
    });

    test('C10 — session continuation', async () => {
      // The first case whose EXPECTED OUTCOME depends on what the adapter
      // declares: `hasResume` split the engines in two, and both halves are
      // conformant. What is not conformant is a third answer — accepting
      // `resumeFrom` and opening a fresh session anyway. That is the same
      // failure `permissions` already forbids ("an engine unable to express a
      // policy has to say so before opening, never open a session that quietly
      // enforces less than what was asked", `types.ts:126-131`), applied to the
      // one field whose silent loss nothing downstream can detect: a session
      // that resumed nothing looks exactly like a session that resumed.
      const adapter = newAdapter();
      const supportsResume = resolveCapabilities(adapter.capabilities()).hasResume;

      if (!supportsResume) {
        const scenario = buildScenario();
        const collector = new Collector();
        try {
          await assert.rejects(
            () =>
              adapter.startSession(
                {
                  workingDir: scenario.workingDir,
                  instructions: 'node instructions',
                  prompt: 'a turn that continues something',
                  timeoutSeconds: 30,
                  resumeFrom: 'ref-of-a-session-this-engine-cannot-continue',
                  envOverrides: {
                    FAKE_ENGINE_RECORD: scenario.recordPath,
                    FAKE_ENGINE_EXIT_CODE: '0',
                  },
                },
                collector,
              ),
            SessionStartError,
            'C10: an engine that does not declare hasResume has to refuse the session, ' +
              'not drop resumeFrom on the floor',
          );

          // Refusing AFTER the spawn would already have cost a process, an
          // output and a row somewhere. The sidecar is the proof: the fake
          // engine writes it as its first act, so its absence is the absence of
          // a process.
          await sleep(SETTLE_MS);
          assert.equal(
            existsSync(scenario.recordPath),
            false,
            'C10: the refusal came after the engine process was already spawned',
          );
          assert.equal(
            collector.endings.length,
            0,
            'C10: a session that never opened must not report an outcome',
          );
        } finally {
          scenario.cleanup();
        }
        return;
      }

      const scenario = buildScenario();
      try {
        const first = new Collector();
        const opening: FakeLine[] = [];
        if (options.engineRefFrame) {
          opening.push({ stream: 'stdout', text: options.engineRefFrame.line });
        }

        const firstHandle = await adapter.startSession(
          {
            workingDir: scenario.workingDir,
            instructions: 'node instructions',
            prompt: 'the first turn',
            timeoutSeconds: 30,
            envOverrides: {
              FAKE_ENGINE_RECORD: scenario.recordPath,
              FAKE_ENGINE_LINES: linesForEnv(opening),
              FAKE_ENGINE_EXIT_CODE: '0',
            },
          },
          first,
        );
        await first.awaitEnd('C10 (first session)', deadline);

        // The ref the ENGINE gave, as `onEngineRef` reported it — which is what
        // a caller would have to hand back. The fallback keeps the case
        // engine-agnostic: an adapter whose engine announces no ref still has
        // to carry an opaque string through.
        const engineRef = first.refs[0] ?? 'ref-captured-from-a-previous-session';

        const second = new Collector();
        const secondHandle = await adapter.startSession(
          {
            // The SAME directory on purpose, and conservatively: the real
            // `claude` was measured continuing from a directory it had never
            // seen (t173), but that is one engine's answer, and a kit that
            // certifies any engine must not demand the loosest of them.
            workingDir: scenario.workingDir,
            instructions: 'node instructions',
            prompt: 'the turn that continues the first one',
            timeoutSeconds: 30,
            resumeFrom: engineRef,
            envOverrides: {
              FAKE_ENGINE_RECORD: scenario.secondRecordPath,
              FAKE_ENGINE_EXIT_CODE: '0',
            },
          },
          second,
        );
        const end = await second.awaitEnd('C10 (continued session)', deadline);

        assert.equal(end.status, 'completed', 'C10: the continued session did not complete');
        assert.notEqual(
          secondHandle,
          firstHandle,
          'C10: continuing a session is a NEW local handle — the engine ref is the ' +
            "engine's, the handle is the adapter's, and the two are not the same thing",
        );

        // C2's discipline: only what the PROCESS received counts. Checking the
        // `SessionSpec` here would be testing the test.
        const received = everythingTheProcessReceived(await scenario.readSecondRecord());
        assert.ok(
          received.includes(engineRef),
          'C10: the engine ref did not reach the process by any path ' +
            '(argument, environment, stdin or ephemeral file), so the session ' +
            'declared as continued started fresh',
        );
      } finally {
        scenario.cleanup();
      }
    });

    test('C11 — oversized prompt', async () => {
      // The case that certifies the OTHER half of C2: not "did the content
      // arrive", but "does it still arrive when there is too much of it to fit
      // where it usually goes". The ceiling is the operating system's, not
      // ours — Linux caps a single argv element at 128 KiB and macOS caps the
      // whole argv+envp block at ~256 KiB — and it is reached by a `prompt`
      // that grows with the transcript of a resumed job, which is the ordinary
      // shape of a long-running session, not a pathological one.
      //
      // It fails EARLY and blind when it fails: `spawn` itself dies with
      // E2BIG, so there is no process, no output and no session to report the
      // problem through. That is what makes it a kit case rather than an
      // adapter's private test — an adapter with no channel off argv is an
      // adapter that stops working at a size nobody declared.
      //
      // Which channel it uses is deliberately not asserted. The normative rule
      // already leaves that open — each adapter decides how it injects, by the
      // engine's flag, its stdin or an ephemeral file
      // (`engine-adapter.md:277-279`) — and `everythingTheProcessReceived`
      // accepts all four, exactly as C2 does.
      const scenario = buildScenario();
      const collector = new Collector();
      const adapter = newAdapter();

      const marker = 'MARKER-c11-4d5e6f';
      const instructions = 'i'.repeat(OVERSIZED_INSTRUCTIONS_BYTES);
      const prompt = `${marker}\n${'p'.repeat(OVERSIZED_PROMPT_BYTES - marker.length - 1)}`;

      const spec: SessionSpec = {
        workingDir: scenario.workingDir,
        instructions,
        prompt,
        timeoutSeconds: 30,
        envOverrides: {
          FAKE_ENGINE_RECORD: scenario.recordPath,
          FAKE_ENGINE_EXIT_CODE: '0',
        },
      };

      try {
        // The failure this guards against happens HERE, at the spawn, and it
        // arrives as a rejected `startSession` rather than as a bad outcome.
        await adapter.startSession(spec, collector);
        const end = await collector.awaitEnd('C11', deadline);

        requireBaselineStatus(end.status, 'C11');
        assert.equal(
          end.status,
          'completed',
          'C11: the oversized session did not run to a clean end',
        );

        const record = await scenario.readRecord();
        assert.ok(
          everythingTheProcessReceived(record).includes(marker),
          'C11: the prompt marker did not reach the process by any path ' +
            '(argument, environment, stdin or ephemeral file)',
        );

        // ...and it did not arrive by the path that would have blown up on a
        // real kernel. Without this, an adapter that merely got lucky with the
        // platform's ceiling would pass the case on the machine that has room
        // and fail in production on the machine that does not.
        const argv = record.argv.join('\n');
        assert.ok(
          !argv.includes(prompt) && !argv.includes(instructions),
          'C11: the oversized content is still in the argv — it fits on this ' +
            'machine and will not fit on the next one',
        );
      } finally {
        scenario.cleanup();
      }
    });
  });
}
