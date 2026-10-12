/**
 * The shared process lifecycle of the three CLI adapters, pinned once (t678).
 *
 * `process-lifecycle.ts` is what `ClaudeCodeAdapter`, `CodexAdapter` and
 * `CopilotAdapter` delegate to. The conformance kit and the session-cleanup
 * suites certify each adapter's BEHAVIOUR through its public class; this file
 * drives the helper directly, so that the contract the three now share — and
 * each of its five hooks — has one place where it is stated.
 *
 * The engine is `test/fixtures/fake-engine.mjs`, configured by environment. The
 * one exception is case 1: the fake writes every line whole, in a single
 * `write`, so a line split across chunks needs a two-line inline script.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { reapIfAlive } from '../../src/engine/conformance-kit.ts';
import {
  ProcessLifecycle,
  type LifecycleChannel,
  type LifecycleHooks,
} from '../../src/engine/process-lifecycle.ts';
import {
  SessionStartError,
  UnknownSessionError,
  type SessionFinishDetail,
  type SessionListener,
  type SessionStatus,
} from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Short, so the escalation cases end in well under a second each. */
const GRACE_MS = 200;

/** Ceiling on any one wait of this file. */
const DEADLINE_MS = 10_000;

/** What a listener heard, in order. */
type Heard =
  | { kind: 'output'; line: string }
  | { kind: 'ref'; ref: string }
  | {
      kind: 'finished';
      status: SessionStatus;
      exitCode: number | null;
      detail: SessionFinishDetail | undefined;
    };

interface Recorder {
  readonly heard: Heard[];
  readonly listener: SessionListener;
  /** Resolves on the first `onFinished`. */
  readonly finished: Promise<Extract<Heard, { kind: 'finished' }>>;
  /** Resolves on the first `onOutput`. */
  readonly firstOutput: Promise<void>;
  finishedCount(): number;
}

function recorder(options: { onEngineRef?: boolean } = {}): Recorder {
  const heard: Heard[] = [];
  let announceFinished: (end: Extract<Heard, { kind: 'finished' }>) => void = () => undefined;
  const finished = new Promise<Extract<Heard, { kind: 'finished' }>>((resolve) => {
    announceFinished = resolve;
  });
  let announceOutput: () => void = () => undefined;
  const firstOutput = new Promise<void>((resolve) => {
    announceOutput = resolve;
  });

  const listener: SessionListener = {
    onOutput(line) {
      heard.push({ kind: 'output', line });
      announceOutput();
    },
    onFinished(status, exitCode, detail) {
      const end = { kind: 'finished' as const, status, exitCode, detail };
      heard.push(end);
      announceFinished(end);
    },
  };
  if (options.onEngineRef !== false) {
    listener.onEngineRef = (ref) => {
      heard.push({ kind: 'ref', ref });
    };
  }

  return {
    heard,
    listener,
    finished,
    firstOutput,
    finishedCount: () => heard.filter((entry) => entry.kind === 'finished').length,
  };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let clock: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    clock = setTimeout(() => reject(new Error(`${label}: nothing within ${DEADLINE_MS}ms`)), DEADLINE_MS);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(clock);
  }
}

/** A scratch directory for one case, removed afterwards. */
function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cartografo-t678-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The fake engine's command, with its controls in the environment. */
function fakeEngine(controls: Record<string, string>): {
  command: { command: string; args: string[] };
  environment: () => NodeJS.ProcessEnv;
} {
  return {
    command: { command: process.execPath, args: [FAKE_ENGINE] },
    environment: () => ({ ...process.env, ...controls }),
  };
}

/** Lines in the fake engine's `FAKE_ENGINE_LINES` shape. */
function lines(...entries: Array<[LifecycleChannel, string]>): string {
  return JSON.stringify(entries.map(([stream, text]) => ({ stream, text })));
}

interface FakeRecord {
  pid: number;
  grandchildPid: number | null;
}

/** The fake engine's sidecar, once it has written it. Reaps its group afterwards. */
async function readRecord(t: TestContext, path: string): Promise<FakeRecord> {
  const limit = Date.now() + DEADLINE_MS;
  while (Date.now() < limit) {
    if (existsSync(path)) {
      try {
        const record = JSON.parse(readFileSync(path, 'utf8')) as FakeRecord;
        t.after(() => {
          reapIfAlive(record.pid);
          if (record.grandchildPid) reapIfAlive(record.grandchildPid);
        });
        return record;
      } catch {
        /* half-written; read again */
      }
    }
    await sleep(20);
  }
  throw new Error(`the fake engine never wrote ${path}`);
}

function exists(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Waits for a process (positive) or a process group (negative) to be gone. */
async function requireGone(target: number, label: string): Promise<void> {
  const limit = Date.now() + 5_000;
  while (Date.now() < limit) {
    if (!exists(target)) return;
    await sleep(25);
  }
  assert.fail(`${label}: ${target} still exists after the end`);
}

const SPEC = { timeoutSeconds: 30 } as const;

function lifecycle<State = undefined>(
  hooks: Partial<LifecycleHooks<State>> = {},
): ProcessLifecycle<State> {
  return new ProcessLifecycle<State>({ graceMs: GRACE_MS, ...hooks });
}

test('t678 AT1 — a split line arrives whole and once; tails drain on close and do not mix', async (t) => {
  const workingDir = scratch(t);
  const channels: Array<[string, LifecycleChannel]> = [];
  const helper = lifecycle({
    onLine: (_state, line, channel) => {
      channels.push([line, channel]);
    },
  });
  const heard = recorder();

  // Three chunks for one stdout line, then an unterminated tail on EACH stream.
  const script = [
    'const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'process.stdout.write("hel"); await wait(40);',
    'process.stdout.write("lo wor"); await wait(40);',
    'process.stdout.write("ld\\nout-tail"); await wait(40);',
    'process.stderr.write("err-tail");',
  ].join('\n');

  await helper.start({ ...SPEC, workingDir }, heard.listener, {
    command: { command: process.execPath, args: ['--input-type=module', '-e', script] },
    environment: () => process.env,
    state: undefined,
  });
  const end = await within(heard.finished, 'AT1');

  assert.equal(end.status, 'completed');
  const outputs = heard.heard.flatMap((entry) => (entry.kind === 'output' ? [entry.line] : []));
  assert.deepEqual(outputs.filter((line) => line === 'hello world'), ['hello world']);
  assert.deepEqual([...outputs].sort(), ['err-tail', 'hello world', 'out-tail']);
  assert.deepEqual(
    [...channels].sort(([a], [b]) => a.localeCompare(b)),
    [
      ['err-tail', 'stderr'],
      ['hello world', 'stdout'],
      ['out-tail', 'stdout'],
    ],
  );
});

test('t678 AT2 — a natural exit finishes exactly once with the exit code deciding', async (t) => {
  for (const [code, expected] of [
    ['0', 'completed'],
    ['1', 'failed'],
  ] as const) {
    const workingDir = scratch(t);
    const helper = lifecycle();
    const heard = recorder();
    const { command, environment } = fakeEngine({ FAKE_ENGINE_EXIT_CODE: code });

    await helper.start({ ...SPEC, workingDir }, heard.listener, { command, environment, state: undefined });
    const end = await within(heard.finished, `AT2 exit ${code}`);
    await sleep(100);

    assert.equal(end.status, expected);
    assert.equal(end.exitCode, Number(code));
    assert.equal(end.detail, undefined);
    assert.equal(heard.finishedCount(), 1);
  }
});

/** The three stops ours or a caller's can order, each against a hanging engine. */
const STOPS = [
  {
    name: 'cancel',
    spec: { timeoutSeconds: 30 },
    status: 'cancelled',
    reason: undefined,
    order: true,
  },
  {
    name: 'wall clock',
    spec: { timeoutSeconds: 0.4 },
    status: 'timed_out',
    reason: 'wall_clock',
    order: false,
  },
  {
    name: 'inactivity watchdog',
    spec: { timeoutSeconds: 30, silenceSeconds: 0.3 },
    status: 'timed_out',
    reason: 'silence',
    order: false,
  },
] as const;

for (const stop of STOPS) {
  test(`t678 AT3/AT4 — ${stop.name}: finishes once, and the escalation leaves no process of the group`, async (t) => {
    const workingDir = scratch(t);
    const recordPath = join(workingDir, 'record.json');
    const helper = lifecycle();
    const heard = recorder();
    // The C4 scenario: an engine and a grandchild that both ignore SIGTERM.
    const { command, environment } = fakeEngine({
      FAKE_ENGINE_HANG: '1',
      FAKE_ENGINE_IGNORE_SIGTERM: '1',
      FAKE_ENGINE_SPAWN_CHILD: '1',
      FAKE_ENGINE_RECORD: recordPath,
    });

    const id = await helper.start({ ...stop.spec, workingDir }, heard.listener, {
      command,
      environment,
      state: undefined,
    });
    const record = await readRecord(t, recordPath);
    assert.ok(record.grandchildPid, 'the fixture must leave a grandchild alive');

    if (stop.order) helper.cancel(id);
    const end = await within(heard.finished, `AT3 ${stop.name}`);
    await sleep(GRACE_MS);

    assert.equal(end.status, stop.status);
    assert.equal(end.exitCode, null, 'killed by a signal: there was no exit code');
    assert.equal(end.detail?.timeoutReason, stop.reason);
    if (stop.reason === undefined) assert.equal(end.detail, undefined);
    assert.equal(heard.finishedCount(), 1);

    await requireGone(record.pid, `${stop.name}: engine`);
    await requireGone(record.grandchildPid, `${stop.name}: grandchild that ignores SIGTERM`);
    await requireGone(-record.pid, `${stop.name}: process group`);
  });
}

test('t678 AT4 — a natural exit leaves no engine process and no group behind', async (t) => {
  const workingDir = scratch(t);
  const recordPath = join(workingDir, 'record.json');
  const helper = lifecycle();
  const heard = recorder();
  const { command, environment } = fakeEngine({ FAKE_ENGINE_RECORD: recordPath });

  await helper.start({ ...SPEC, workingDir }, heard.listener, { command, environment, state: undefined });
  const record = await readRecord(t, recordPath);
  await within(heard.finished, 'AT4 natural');

  await requireGone(record.pid, 'natural exit: engine');
  await requireGone(-record.pid, 'natural exit: process group');
});

test('t678 AT5 — a second cancel while a stop is in flight is a no-op: the first status wins', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle();
  const heard = recorder();
  // The line goes out after the SIGTERM handler is in place, so the stop
  // really has to escalate: the second cancel lands mid-flight.
  const { command, environment } = fakeEngine({
    FAKE_ENGINE_LINES: lines(['stdout', 'up']),
    FAKE_ENGINE_HANG: '1',
    FAKE_ENGINE_IGNORE_SIGTERM: '1',
  });

  const id = await helper.start({ ...SPEC, workingDir }, heard.listener, {
    command,
    environment,
    state: undefined,
  });
  await within(heard.firstOutput, 'AT5 first line');
  helper.cancel(id, 'cancelled');
  helper.cancel(id, 'timed_out');

  const end = await within(heard.finished, 'AT5');
  assert.equal(end.status, 'cancelled');
  assert.equal(helper.getStatus(id), 'cancelled');
  assert.equal(heard.finishedCount(), 1);
});

test('t678 AT6 — a finished handle answers forever; a never-opened one throws', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle();
  const heard = recorder();
  const { command, environment } = fakeEngine({ FAKE_ENGINE_HANG: '1' });

  const id = await helper.start({ ...SPEC, workingDir }, heard.listener, {
    command,
    environment,
    state: undefined,
  });
  assert.equal(helper.getStatus(id), 'running');
  assert.equal(helper.liveSessionCount, 1);

  helper.cancel(id);
  await within(heard.finished, 'AT6');

  assert.equal(helper.getStatus(id), 'cancelled');
  assert.doesNotThrow(() => helper.cancel(id));
  assert.equal(helper.getStatus(id), 'cancelled');
  assert.equal(helper.liveSessionCount, 0);
  assert.equal(heard.finishedCount(), 1);

  for (const call of [() => helper.getStatus('never-opened'), () => helper.cancel('never-opened')]) {
    assert.throws(call, (error: unknown) => {
      assert.ok(error instanceof UnknownSessionError, `expected UnknownSessionError: ${String(error)}`);
      return true;
    });
  }
});

test('t678 AT7 — no onOutput after onFinished, even from an engine still printing when stopped', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle();
  const heard = recorder();
  const many = Array.from({ length: 200 }, (_value, index): [LifecycleChannel, string] => [
    index % 2 === 0 ? 'stdout' : 'stderr',
    `line ${index}`,
  ]);
  const { command, environment } = fakeEngine({
    FAKE_ENGINE_LINES: lines(...many),
    FAKE_ENGINE_HEARTBEAT_MS: '5',
    FAKE_ENGINE_IGNORE_SIGTERM: '1',
    FAKE_ENGINE_HANG: '1',
  });

  const id = await helper.start({ ...SPEC, workingDir }, heard.listener, {
    command,
    environment,
    state: undefined,
  });
  await within(heard.firstOutput, 'AT7 first line');
  helper.cancel(id);
  await within(heard.finished, 'AT7');
  await sleep(300);

  assert.equal(heard.heard.at(-1)?.kind, 'finished', 'something reached the listener after onFinished');
  assert.equal(heard.finishedCount(), 1);
});

test('t678 AT8 — the status classifier overrides the default, and a stop still outranks it', async (t) => {
  interface State {
    sawFailure: boolean;
  }
  const helper = lifecycle<State>({
    onLine: (state, line) => {
      if (line === 'FAILURE') state.sawFailure = true;
    },
    classifyExit: (code, state) => (code === 0 && !state.sawFailure ? 'completed' : 'failed'),
  });

  const workingDir = scratch(t);
  const failing = recorder();
  const one = fakeEngine({ FAKE_ENGINE_LINES: lines(['stdout', 'FAILURE']), FAKE_ENGINE_EXIT_CODE: '0' });
  await helper.start({ ...SPEC, workingDir }, failing.listener, {
    ...one,
    state: { sawFailure: false },
  });
  const failed = await within(failing.finished, 'AT8 classifier');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 0);

  const clean = recorder();
  await helper.start({ ...SPEC, workingDir }, clean.listener, {
    ...fakeEngine({ FAKE_ENGINE_EXIT_CODE: '0' }),
    state: { sawFailure: false },
  });
  assert.equal((await within(clean.finished, 'AT8 clean')).status, 'completed');

  const cancelled = recorder();
  const id = await helper.start({ ...SPEC, workingDir }, cancelled.listener, {
    ...fakeEngine({ FAKE_ENGINE_HANG: '1' }),
    state: { sawFailure: true },
  });
  helper.cancel(id);
  assert.equal((await within(cancelled.finished, 'AT8 cancelled')).status, 'cancelled');
});

test('t678 AT8 — finish-detail keys travel beside timeoutReason; an empty result is no detail', async (t) => {
  interface State {
    models: string[] | null;
  }
  const helper = lifecycle<State>({
    onLine: (state, line) => {
      if (line.startsWith('model:')) state.models = [line.slice('model:'.length)];
    },
    finishDetail: (state) => (state.models === null ? {} : { models: state.models }),
  });

  const workingDir = scratch(t);
  const timed = recorder();
  await helper.start({ timeoutSeconds: 0.4, workingDir }, timed.listener, {
    ...fakeEngine({ FAKE_ENGINE_LINES: lines(['stdout', 'model:m-1']), FAKE_ENGINE_HANG: '1' }),
    state: { models: null },
  });
  const end = await within(timed.finished, 'AT8 detail');
  assert.deepEqual(end.detail, { timeoutReason: 'wall_clock', models: ['m-1'] });

  const plain = recorder();
  await helper.start({ ...SPEC, workingDir }, plain.listener, {
    ...fakeEngine({ FAKE_ENGINE_EXIT_CODE: '0' }),
    state: { models: null },
  });
  assert.equal((await within(plain.finished, 'AT8 no detail')).detail, undefined);
});

test('t678 AT8 — an up-front engine ref is announced exactly once, once the process is up', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle({ extractEngineRef: (line) => (line.startsWith('ref:') ? line.slice(4) : null) });
  const heard = recorder();
  let liveWhenAnnounced: number | null = null;
  const listener: SessionListener = {
    ...heard.listener,
    onOutput: (line) => heard.listener.onOutput(line),
    onFinished: (...args) => heard.listener.onFinished(...args),
    onEngineRef: (ref) => {
      liveWhenAnnounced = helper.liveSessionCount;
      heard.listener.onEngineRef?.(ref);
    },
  };

  await helper.start({ ...SPEC, workingDir }, listener, {
    // A line that looks like a ref must not produce a second announcement.
    ...fakeEngine({ FAKE_ENGINE_LINES: lines(['stdout', 'ref:from-the-stream']) }),
    state: undefined,
    engineRef: 'chosen-up-front',
  });
  await within(heard.finished, 'AT8 up-front ref');

  const refs = heard.heard.filter((entry) => entry.kind === 'ref');
  assert.deepEqual(refs, [{ kind: 'ref', ref: 'chosen-up-front' }]);
  assert.equal(liveWhenAnnounced, 1);
  assert.equal(heard.heard[0]?.kind, 'ref', 'the up-front ref comes before any line');
});

test('t678 AT8 — a line-extracted engine ref is announced exactly once, on the first matching line', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle({ extractEngineRef: (line) => (line.startsWith('ref:') ? line.slice(4) : null) });
  const heard = recorder();

  await helper.start({ ...SPEC, workingDir }, heard.listener, {
    ...fakeEngine({
      FAKE_ENGINE_LINES: lines(['stdout', 'noise'], ['stdout', 'ref:A'], ['stdout', 'ref:B']),
      FAKE_ENGINE_HEARTBEAT_MS: '10',
    }),
    state: undefined,
  });
  await within(heard.finished, 'AT8 extracted ref');

  assert.deepEqual(heard.heard.slice(0, 4), [
    { kind: 'output', line: 'noise' },
    { kind: 'output', line: 'ref:A' },
    { kind: 'ref', ref: 'A' },
    { kind: 'output', line: 'ref:B' },
  ]);
  assert.equal(heard.heard.filter((entry) => entry.kind === 'ref').length, 1);

  // A listener with no `onEngineRef` is simply never asked.
  const silent = recorder({ onEngineRef: false });
  await helper.start({ ...SPEC, workingDir }, silent.listener, {
    ...fakeEngine({ FAKE_ENGINE_LINES: lines(['stdout', 'ref:A']) }),
    state: undefined,
  });
  assert.equal((await within(silent.finished, 'AT8 no onEngineRef')).status, 'completed');
});

test('t678 AT8 — the per-line hook receives the channel of every line', async (t) => {
  const workingDir = scratch(t);
  const seen: Array<[string, LifecycleChannel]> = [];
  const helper = lifecycle({
    onLine: (_state, line, channel) => {
      seen.push([line, channel]);
    },
  });
  const heard = recorder();

  await helper.start({ ...SPEC, workingDir }, heard.listener, {
    ...fakeEngine({
      FAKE_ENGINE_LINES: lines(['stdout', 'to stdout'], ['stderr', 'to stderr']),
      FAKE_ENGINE_HEARTBEAT_MS: '10',
    }),
    state: undefined,
  });
  await within(heard.finished, 'AT8 channel');

  assert.deepEqual(seen, [
    ['to stdout', 'stdout'],
    ['to stderr', 'stderr'],
  ]);
});

test('t678 AT9 — a binary that does not exist rejects with SessionStartError and leaves no session', async (t) => {
  const workingDir = scratch(t);
  const helper = lifecycle();
  const heard = recorder();

  await assert.rejects(
    helper.start({ ...SPEC, workingDir }, heard.listener, {
      command: { command: join(workingDir, 'no-such-engine'), args: [] },
      environment: () => process.env,
      state: undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
      assert.equal(
        error.message,
        `could not open a session with "${join(workingDir, 'no-such-engine')}" in "${workingDir}"`,
      );
      return true;
    },
  );
  assert.equal(helper.liveSessionCount, 0);
  assert.equal(heard.heard.length, 0, 'a session that never came up reports nothing');

  // An environment builder that throws is a session that could not start.
  await assert.rejects(
    helper.start({ ...SPEC, workingDir }, heard.listener, {
      command: { command: process.execPath, args: [FAKE_ENGINE] },
      environment: () => {
        throw new Error('no environment');
      },
      state: undefined,
    }),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
      assert.equal(error.message, `could not start "${process.execPath}"`);
      return true;
    },
  );
  assert.equal(helper.liveSessionCount, 0);
});
