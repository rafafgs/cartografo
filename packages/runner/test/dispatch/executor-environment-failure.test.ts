/**
 * Acceptance tests for the bench read that could not START (issue #4).
 *
 * Under memory pressure `git -C <bench> rev-parse main` failed to start on a
 * Windows host: exit 3221225794 (0xC0000142, STATUS_DLL_INIT_FAILED) with an
 * empty stderr. Minutes later the same command answered with exit 0 and nothing
 * had changed — yet the job had been blocked as a permanent bench
 * misconfiguration. The rule these tests pin is the one t688 set for spawn
 * failures: the CODE decides, never the message text. A git that ran and
 * refused stays a block; a git that could not start is retried through the
 * existing bounded pre-session retry.
 *
 * POSIX exit statuses are truncated to 8 bits, so 3221225794 cannot come out of
 * a fake `git` script: that value is tested through the pure mapper, the
 * predicate and the error. The real-process cases use a real non-repository
 * (exit 128) and a `kill -9` script (a signal).
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type * as ExecutorEnvironmentModule from '../../src/dispatch/resolve-executor-environment.ts';
import type { GitFailure } from '../../src/dispatch/resolve-executor-environment.ts';
import type * as PreSessionFailureModule from '../../src/dispatch/pre-session-failure.ts';
import type * as RetryModule from '../../src/dispatch/pre-session-retry.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Imports a module under test, failing with its path while it does not exist.
 *
 * The idiom this directory already uses: in the red phase the failure has to
 * read as "the implementation is missing", never as a module resolution stack
 * trace.
 */
async function load<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

const loadEnvironment = () =>
  load<typeof ExecutorEnvironmentModule>('src/dispatch/resolve-executor-environment.ts');
const loadClassifier = () =>
  load<typeof PreSessionFailureModule>('src/dispatch/pre-session-failure.ts');
const loadRetry = () => load<typeof RetryModule>('src/dispatch/pre-session-retry.ts');

/** A failure record with every field defaulted to "nothing happened". */
function failure(partial: Partial<GitFailure> = {}): GitFailure {
  return { exitCode: null, errno: null, signal: null, stderrEmpty: false, ...partial };
}

const JOB = Object.freeze({
  id: 1053,
  current_node_id: 'testar',
  graph_version_id: 'sha256:0123456789abcdef',
});

const NTSTATUS_DLL_INIT_FAILED = 3221225794; // 0xC0000142, the value from the issue

/* -------------------------------------------------------------------------- */
/* AT1 — the predicate                                                        */
/* -------------------------------------------------------------------------- */

test('AT1 — classifyGitFailure: only a git that could not start is transient', async () => {
  const { classifyGitFailure } = await loadEnvironment();

  const rows: ReadonlyArray<[string, GitFailure, 'transient' | 'permanent']> = [
    ['0xC0000142 with no output', failure({ exitCode: NTSTATUS_DLL_INIT_FAILED, stderrEmpty: true }), 'transient'],
    ['0xC000012D with no output', failure({ exitCode: 0xc000012d, stderrEmpty: true }), 'transient'],
    ['0xC0000005 with no output', failure({ exitCode: 0xc0000005, stderrEmpty: true }), 'transient'],
    ['0xC0000142 WITH stderr text', failure({ exitCode: NTSTATUS_DLL_INIT_FAILED, stderrEmpty: false }), 'permanent'],
    ['0xBFFFFFFF, just below the range', failure({ exitCode: 0xbfffffff, stderrEmpty: true }), 'permanent'],
    ['ENOMEM', failure({ errno: 'ENOMEM' }), 'transient'],
    ['EAGAIN', failure({ errno: 'EAGAIN' }), 'transient'],
    ['EMFILE', failure({ errno: 'EMFILE' }), 'transient'],
    ['ENFILE', failure({ errno: 'ENFILE' }), 'transient'],
    ['ENOENT', failure({ errno: 'ENOENT' }), 'permanent'],
    ['an errno nobody listed', failure({ errno: 'EACCES' }), 'permanent'],
    ['SIGKILL', failure({ signal: 'SIGKILL' }), 'transient'],
    ['ENOENT even with a signal set', failure({ errno: 'ENOENT', signal: 'SIGKILL' }), 'permanent'],
    ['exit 128 with stderr', failure({ exitCode: 128, stderrEmpty: false }), 'permanent'],
    ['exit 1 with no output', failure({ exitCode: 1, stderrEmpty: true }), 'permanent'],
    ['exit 0 (empty stdout)', failure({ exitCode: 0 }), 'permanent'],
    ['the all-null default', failure(), 'permanent'],
  ];

  for (const [label, input, expected] of rows) {
    assert.equal(classifyGitFailure(input), expected, label);
  }
});

/* -------------------------------------------------------------------------- */
/* AT2 — the mapper                                                           */
/* -------------------------------------------------------------------------- */

test('AT2 — toGitFailure keeps the exit code, the errno, the signal and whether stderr was empty', async () => {
  const { toGitFailure } = await loadEnvironment();

  assert.deepEqual(toGitFailure({ code: NTSTATUS_DLL_INIT_FAILED }, ''), {
    exitCode: NTSTATUS_DLL_INIT_FAILED,
    errno: null,
    signal: null,
    stderrEmpty: true,
  });
  assert.deepEqual(toGitFailure({ code: 128 }, 'fatal: not a git repository'), {
    exitCode: 128,
    errno: null,
    signal: null,
    stderrEmpty: false,
  });
  assert.deepEqual(toGitFailure({ code: 'ENOMEM' }, ''), {
    exitCode: null,
    errno: 'ENOMEM',
    signal: null,
    stderrEmpty: true,
  });
  assert.equal(toGitFailure({ code: 'ENOENT' }, '').errno, 'ENOENT');
  assert.deepEqual(toGitFailure({ code: null, killed: true, signal: 'SIGKILL' }, ''), {
    exitCode: null,
    errno: null,
    signal: 'SIGKILL',
    stderrEmpty: true,
  });
});

/* -------------------------------------------------------------------------- */
/* AT3 — the error                                                            */
/* -------------------------------------------------------------------------- */

test('AT3 — ExecutorEnvironmentError carries the failure and tags its message with it', async () => {
  const { ExecutorEnvironmentError, classifyGitFailure } = await loadEnvironment();
  const summary = 'the reference `main` of the test bench could not be read';
  const command = 'git -C /srv/bench rev-parse main';

  const exited = new ExecutorEnvironmentError(
    summary,
    command,
    '',
    failure({ exitCode: NTSTATUS_DLL_INIT_FAILED, stderrEmpty: true }),
  );
  assert.equal(exited.exitCode, NTSTATUS_DLL_INIT_FAILED);
  assert.equal(exited.command, command);
  assert.equal(exited.stderr, '', 'stderr keeps its meaning: what was printed, trimmed');
  assert.ok(
    exited.message.endsWith(' (exit 3221225794)'),
    `the message ends with the exit tag: ${exited.message}`,
  );

  const spawn = new ExecutorEnvironmentError(summary, command, 'spawn git ENOMEM', failure({ errno: 'ENOMEM' }));
  assert.equal(spawn.errno, 'ENOMEM');
  assert.ok(spawn.message.endsWith(' (errno ENOMEM)'), spawn.message);

  const killed = new ExecutorEnvironmentError(summary, command, '', failure({ signal: 'SIGKILL' }));
  assert.equal(killed.signal, 'SIGKILL');
  assert.ok(killed.message.endsWith(' (signal SIGKILL)'), killed.message);

  const legacy = new ExecutorEnvironmentError(summary, command, 'fatal: nope');
  assert.equal(legacy.message, `${summary}: \`${command}\` failed — fatal: nope`, 'no tag at all');
  assert.equal(legacy.exitCode, null);
  assert.equal(legacy.errno, null);
  assert.equal(legacy.signal, null);
  assert.equal(legacy.stderrEmpty, false);
  assert.equal(classifyGitFailure(legacy), 'permanent', 'three arguments classify as permanent');
});

/* -------------------------------------------------------------------------- */
/* AT4/AT5 — real git                                                         */
/* -------------------------------------------------------------------------- */

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** Reads the bench with the real resolver and returns what it rejects with. */
async function readBench(benchPath: string): Promise<unknown> {
  const { createExecutorEnvironmentResolver } = await loadEnvironment();
  const resolver = createExecutorEnvironmentResolver({
    testBenchPath: benchPath,
    referenceMode: 'ponta_do_principal',
    mainBranch: 'main',
  });
  try {
    await resolver({ id: 1 } as never, { node: { id: 'testar' }, edges: [] } as never, {});
  } catch (error) {
    return error;
  }
  assert.fail('the resolver was expected to reject');
}

function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-gitfail-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('AT4 — a real git on a path that is not a repository refuses with exit 128, permanent', async (t) => {
  const { ExecutorEnvironmentError, classifyGitFailure } = await loadEnvironment();
  const error = await readBench(scratch(t, 'not-a-repo'));

  assert.ok(error instanceof ExecutorEnvironmentError, String(error));
  assert.equal(error.exitCode, 128);
  assert.equal(error.stderrEmpty, false);
  assert.equal(classifyGitFailure(error), 'permanent');
});

/** Puts an executable `git` shell script first on PATH for the rest of the test. */
function fakeGit(t: TestHook, dir: string, body: string): void {
  const bin = mkdtempSync(path.join(dir, 'bin-'));
  const script = path.join(bin, 'git');
  writeFileSync(script, `#!/bin/sh\n${body}\n`);
  chmodSync(script, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  t.after(() => {
    process.env.PATH = previous;
  });
}

test(
  'AT5 — a real git that is killed is transient; one that refuses or says nothing is not',
  { skip: process.platform === 'win32' ? 'shell-script fake git needs a POSIX shell' : false },
  async (t) => {
    const { ExecutorEnvironmentError, classifyGitFailure } = await loadEnvironment();
    const bench = scratch(t, 'fake-git');

    await t.test('kill -9 $$ → signal SIGKILL, transient', async (sub) => {
      fakeGit(sub, bench, 'kill -9 $$');
      const error = await readBench(bench);
      assert.ok(error instanceof ExecutorEnvironmentError, String(error));
      assert.equal(error.signal, 'SIGKILL');
      assert.equal(error.exitCode, null);
      assert.equal(classifyGitFailure(error), 'transient');
      assert.ok(error.message.endsWith(' (signal SIGKILL)'), error.message);
    });

    await t.test('fatal on stderr, exit 128 → permanent', async (sub) => {
      fakeGit(sub, bench, 'echo "fatal: bad revision" >&2\nexit 128');
      const error = await readBench(bench);
      assert.ok(error instanceof ExecutorEnvironmentError, String(error));
      assert.equal(error.exitCode, 128);
      assert.equal(classifyGitFailure(error), 'permanent');
    });

    await t.test('prints nothing and exits 0 → permanent', async (sub) => {
      fakeGit(sub, bench, 'exit 0');
      const error = await readBench(bench);
      assert.ok(error instanceof ExecutorEnvironmentError, String(error));
      assert.equal(error.exitCode, 0);
      assert.equal(classifyGitFailure(error), 'permanent');
    });
  },
);

/* -------------------------------------------------------------------------- */
/* AT6 — the classifier                                                       */
/* -------------------------------------------------------------------------- */

test('AT6 — classifyPreSessionFailure: transient bench failures are null, refusals block with the detail', async () => {
  const { ExecutorEnvironmentError } = await loadEnvironment();
  const { classifyPreSessionFailure } = await loadClassifier();
  const make = (stderr: string, detail: GitFailure) =>
    new ExecutorEnvironmentError('the reference of the test bench could not be read', 'git -C /b rev-parse main', stderr, detail);

  for (const [label, detail] of [
    ['exit 0xC0000142', failure({ exitCode: NTSTATUS_DLL_INIT_FAILED, stderrEmpty: true })],
    ['ENOMEM', failure({ errno: 'ENOMEM', stderrEmpty: true })],
    ['EAGAIN', failure({ errno: 'EAGAIN', stderrEmpty: true })],
    ['EMFILE', failure({ errno: 'EMFILE', stderrEmpty: true })],
    ['SIGKILL', failure({ signal: 'SIGKILL', stderrEmpty: true })],
  ] as const) {
    assert.equal(classifyPreSessionFailure(make('', detail), JOB), null, `${label} is retried`);
  }

  const flags = ['--test-bench-path', '--reference-repo', '--main-branch', 'unblock'];
  const refused = classifyPreSessionFailure(
    make('fatal: not a git repository', failure({ exitCode: 128 })),
    JOB,
  );
  assert.ok(refused !== null, 'a git that ran and refused still blocks');
  for (const needle of [...flags, 'exit 128', 'fatal: not a git repository']) {
    assert.ok(refused.includes(needle), `the reason names "${needle}": ${refused}`);
  }

  const missing = classifyPreSessionFailure(make('spawn git ENOENT', failure({ errno: 'ENOENT' })), JOB);
  assert.ok(missing !== null, 'a missing git binary is a configuration error');
  for (const needle of [...flags, 'errno ENOENT']) {
    assert.ok(missing.includes(needle), `the reason names "${needle}": ${missing}`);
  }

  const legacy = classifyPreSessionFailure(
    new ExecutorEnvironmentError('the reference of the test bench could not be read', 'git -C /b rev-parse main', 'fatal: x'),
    JOB,
  );
  assert.ok(legacy !== null);
  assert.ok(legacy.includes('(fatal: x)'), `the parenthesis is as it was: ${legacy}`);
  assert.ok(!/\bexit \d|errno /.test(legacy), `and carries no detail: ${legacy}`);
});

/* -------------------------------------------------------------------------- */
/* AT7 — the retry handler                                                    */
/* -------------------------------------------------------------------------- */

test('AT7 — handlePreSessionFailure retries a transient bench failure, then blocks quoting the exit code', async () => {
  const { ExecutorEnvironmentError } = await loadEnvironment();
  const { PreSessionFailureTracker, handlePreSessionFailure } = await loadRetry();

  const posted: Array<{ route: string; body: unknown }> = [];
  const call = (<T>(route: string, _method: string, body?: unknown): Promise<T> => {
    posted.push({ route, body });
    return Promise.resolve(undefined as T);
  }) as ControlPlaneCall;
  const reasonsPosted = () => posted.filter((entry) => entry.route.endsWith('/blocks'));

  const transient = new ExecutorEnvironmentError(
    'the reference `main` of the test bench could not be read',
    'git -C /b rev-parse main',
    '',
    failure({ exitCode: NTSTATUS_DLL_INIT_FAILED, stderrEmpty: true }),
  );

  const ceiling = 3;
  const tracker = new PreSessionFailureTracker();
  for (let attempt = 1; attempt < ceiling; attempt += 1) {
    assert.equal(await handlePreSessionFailure(transient, JOB, call, tracker, ceiling), null);
    assert.deepEqual(reasonsPosted(), [], `attempt ${String(attempt)} blocks nothing`);
  }
  const reason = await handlePreSessionFailure(transient, JOB, call, tracker, ceiling);
  assert.ok(reason !== null && reason.includes('3221225794'), String(reason));
  assert.equal(reasonsPosted().length, 1, 'exactly one block, at the ceiling');
  assert.ok(
    ((reasonsPosted()[0]?.body as { reason: string }).reason).includes('3221225794'),
    'the posted reason quotes the exit code',
  );

  posted.length = 0;
  const permanent = new ExecutorEnvironmentError(
    'the reference `main` of the test bench could not be read',
    'git -C /b rev-parse main',
    'fatal: unknown revision',
    failure({ exitCode: 128 }),
  );
  const first = await handlePreSessionFailure(permanent, JOB, call, new PreSessionFailureTracker(), ceiling);
  assert.ok(first !== null && first.includes('exit 128'), String(first));
  assert.equal(reasonsPosted().length, 1, 'a refusal blocks on the first call');
});
