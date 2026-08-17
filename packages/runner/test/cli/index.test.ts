/**
 * Acceptance tests of the runner command's command line (t162, AT1–AT7; t179).
 *
 * Pure parsing: nothing here opens a socket, and that is half of what is being
 * proven. A command line the CLI cannot read must die before the first request
 * — a runner that dials a control plane and only then discovers that
 * `--project abc` is not a number has already spent a round trip to say
 * something it knew at argument zero. Nothing here touches the filesystem
 * either: the paths below name directories that do not exist, because deciding
 * where worktrees go is reading a command line, not inspecting a disk.
 *
 * The seam that makes "no HTTP call" checkable is the third parameter of
 * `runRunnerCli`: whoever calls it may hand in what actually runs the loop.
 * Production passes nothing and gets `runRunner`; the tests below pass a spy
 * and assert it was never reached.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as CliModule from '../../src/cli/index.ts';
import type * as RunModule from '../../src/cli/run.ts';
import type * as ClientModule from '../../src/controller/cliente-controle.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');

const CLI_MODULE = 'src/cli/index.ts';
const CLIENT_MODULE = 'src/controller/cliente-controle.ts';

/** The address the runner falls back to when nobody says otherwise. */
const DEFAULT_URL = 'http://127.0.0.1:4317';

/**
 * The repository a case names when it does not care which one (t179).
 *
 * Under `tmpdir()` and not under the package, so that it is nowhere near the
 * `process.cwd()` `--working-dir` falls back to: a case about `--project` must
 * not fail over a path that happens to overlap.
 */
const SOME_REPO = path.join(tmpdir(), 'cartografo-t179-repo');

/**
 * ...and its worktrees root, a SIBLING of it, exactly as the founder's answer
 * spells the layout (`--working-dir ~/proj --worktrees-root ~/proj-worktrees`).
 *
 * The name is deliberate: as a string it starts with {@link SOME_REPO}, so a
 * nesting guard written as a bare `startsWith` would reject the one layout the
 * usage text recommends.
 */
const SOME_WORKTREES = `${SOME_REPO}-worktrees`;

/**
 * `--worktrees-root`, required since t179, for the cases that are about
 * something else entirely.
 */
const ELSEWHERE = ['--worktrees-root', SOME_WORKTREES];

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Everything written to one of the two standard streams, while it is armed. */
interface Capture {
  written: () => string;
  restore: () => void;
}

/**
 * Swallows and records what the command writes on a standard stream.
 *
 * It swallows rather than forwarding on purpose: the lines under test here are
 * a usage error and a help text, and letting them through would mix the
 * command's output into the runner's own report of the suite.
 */
function captureStream(name: 'stdout' | 'stderr'): Capture {
  const stream = process[name];
  const original = stream.write.bind(stream);
  let written = '';

  stream.write = ((chunk: string | Uint8Array): boolean => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof stream.write;

  return {
    written: () => written,
    restore: () => {
      stream.write = original;
    },
  };
}

/** A `runRunner` that records the options it got and never dials anything. */
function spyRun(): {
  seen: Array<RunModule.RunnerOptions>;
  run: (options: RunModule.RunnerOptions) => Promise<void>;
} {
  const seen: Array<RunModule.RunnerOptions> = [];
  return {
    seen,
    run: async (options) => {
      seen.push(options);
    },
  };
}

test('AT1 — --help and -h print the usage on stdout, exit 0 and dial nothing', async () => {
  const { USAGE, runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  for (const flag of ['--help', '-h']) {
    const spy = spyRun();
    const stdout = captureStream('stdout');
    let code: number;
    try {
      code = await runRunnerCli([flag], {}, { run: spy.run });
    } finally {
      stdout.restore();
    }

    assert.equal(code, 0, `${flag} is a successful command, not an error`);
    assert.equal(stdout.written(), `${USAGE}\n`, `${flag} prints the usage verbatim`);
    assert.deepEqual(spy.seen, [], `${flag} must not start a runner`);
  }
});

test('AT2 — with no --url and no CARTOGRAFO_URL, the address is the local default', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  assert.equal(parseRunnerOptions([...ELSEWHERE], {}).url, DEFAULT_URL);

  // ...and the precedence above that default, in the two steps it has.
  assert.equal(
    parseRunnerOptions([...ELSEWHERE], { CARTOGRAFO_URL: 'http://127.0.0.1:5000' }).url,
    'http://127.0.0.1:5000',
    'the environment beats the default',
  );
  assert.equal(
    parseRunnerOptions(['--url', 'http://127.0.0.1:6000', ...ELSEWHERE], {
      CARTOGRAFO_URL: 'http://127.0.0.1:5000',
    }).url,
    'http://127.0.0.1:6000',
    'the flag beats the environment',
  );
});

test('AT3 — --token beats CARTOGRAFO_TOKEN, and with neither there is no credential', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);
  const { ClienteControle } = await loadModule<typeof ClientModule>(CLIENT_MODULE);

  assert.equal(
    parseRunnerOptions(['--token', 'from-the-flag', ...ELSEWHERE], {
      CARTOGRAFO_TOKEN: 'from-the-env',
    }).token,
    'from-the-flag',
  );
  assert.equal(
    parseRunnerOptions([...ELSEWHERE], { CARTOGRAFO_TOKEN: 'from-the-env' }).token,
    'from-the-env',
  );

  const options = parseRunnerOptions([...ELSEWHERE], {});
  assert.equal(options.token, undefined, 'no flag and no variable is no credential at all');

  // And "no credential" has to mean an absent header, never an empty one: the
  // client this CLI builds is the only thing that can prove it, so it is built
  // here — over a `fetch` that answers from memory and reaches no network.
  const sent: Array<Record<string, string>> = [];
  const doFetch: typeof fetch = async (_input, init) => {
    sent.push(Object.fromEntries(new Headers(init?.headers)));
    return new Response(JSON.stringify({ runner: { id: 'runner-at3' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const client = new ClienteControle({ urlBase: options.url, token: options.token, buscar: doFetch });
  await client.registrarRunner('runner-at3');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].authorization, undefined, 'an empty header would look like a credential');
});

test('AT4 — a non-integer where a number is required is a usage error, before any call', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const spy = spyRun();
  const stderr = captureStream('stderr');
  let code: number;
  try {
    code = await runRunnerCli(['--project', 'abc', ...ELSEWHERE], {}, { run: spy.run });
  } finally {
    stderr.restore();
  }

  assert.equal(code, 2, 'a wrong command line is a 2, never a 1');
  assert.deepEqual(spy.seen, [], 'nothing may be dialled with a command line this one');

  const written = stderr.written();
  assert.equal(written.split('\n').filter((line) => line !== '').length, 1, `one line, not a stack trace:\n${written}`);
  assert.match(written, /--project/, 'the line names the option that is wrong');
  assert.match(written, /abc/, 'and the value that made it wrong');
});

test('AT5 — an unknown --engine exits 2 and the message lists the engines there are', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const spy = spyRun();
  const stderr = captureStream('stderr');
  let code: number;
  try {
    code = await runRunnerCli(['--engine', 'bogus', ...ELSEWHERE], {}, { run: spy.run });
  } finally {
    stderr.restore();
  }

  assert.equal(code, 2);
  assert.deepEqual(spy.seen, []);
  assert.match(stderr.written(), /claude-code/);
  assert.match(stderr.written(), /codex/);
});

test('AT6 — an unrecognized flag and an extra positional argument both exit 2', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  for (const args of [
    ['--turbo', ...ELSEWHERE],
    ['start', ...ELSEWHERE],
    ['--url', 'http://127.0.0.1:4317', 'extra', ...ELSEWHERE],
  ]) {
    const spy = spyRun();
    const stderr = captureStream('stderr');
    let code: number;
    try {
      code = await runRunnerCli(args, {}, { run: spy.run });
    } finally {
      stderr.restore();
    }

    assert.equal(code, 2, `"${args.join(' ')}" is not a command line this command understands`);
    assert.deepEqual(spy.seen, [], `"${args.join(' ')}" must not start a runner`);
    assert.equal(
      stderr.written().split('\n').filter((line) => line !== '').length,
      1,
      `one actionable line for "${args.join(' ')}":\n${stderr.written()}`,
    );
  }
});

test('a runner that could not run exits 1, saying which control plane and what to do', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);
  const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(CLIENT_MODULE);

  // Not an AT of its own: it is the `1` of the exit-code table, and the line it
  // writes is the difference between "the port is somebody else's" and
  // `TypeError: fetch failed` — the failure the first dogfood actually hit.
  const failures: Array<{ thrown: unknown; expected: RegExp }> = [
    { thrown: new TypeError('fetch failed'), expected: /npx cartografo/ },
    {
      thrown: new ErroDoControlPlane('POST /v1/runners respondeu 401', 401, undefined),
      expected: /--token/,
    },
  ];

  for (const failure of failures) {
    const stderr = captureStream('stderr');
    let code: number;
    try {
      code = await runRunnerCli(['--url', 'http://127.0.0.1:4999', ...ELSEWHERE], {}, {
        run: async () => {
          throw failure.thrown;
        },
      });
    } finally {
      stderr.restore();
    }

    assert.equal(code, 1, 'a runner that could not run is a 1, never a 2');
    assert.equal(
      stderr.written().split('\n').filter((line) => line !== '').length,
      1,
      `one actionable line:\n${stderr.written()}`,
    );
    assert.match(stderr.written(), /http:\/\/127\.0\.0\.1:4999/, 'the line names the address');
    assert.match(stderr.written(), failure.expected);
  }
});

test('AT7 — every optional flag left out resolves to the documented default', async () => {
  const { parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  // `--worktrees-root` is the one flag that has no default and cannot get one
  // (t179): where a session may write is the operator's call. Everything else
  // below is what "left out" resolves to.
  const options = parseRunnerOptions([...ELSEWHERE], {});

  assert.equal(options.projectId, 1, 'the same project every other part of the system falls back to');
  assert.equal(options.runnerCap, 1);
  assert.equal(options.projectCap, 4);
  assert.equal(options.intervalMs, 2000);
  assert.equal(options.leaseTtlSeconds, 60);
  assert.equal(options.repoRoot, process.cwd(), 'the repository the worktrees are cut from');
  assert.equal(options.worktreesRoot, SOME_WORKTREES, 'and the root they are created under');
  assert.equal(options.engine, 'claude-code', 'the default engine is named, never implied');
  assert.notEqual(options.runnerId, '', 'a runner without an identity cannot pair');

  // ...and each one really is overridable, or the defaults above would be the
  // only values these flags ever have.
  const given = parseRunnerOptions(
    [
      '--project', '7',
      '--declared-runner-cap', '3',
      '--project-cap', '9',
      '--interval-ms', '250',
      '--lease-ttl-seconds', '30',
      '--working-dir', path.join(PACKAGE_ROOT, 'src'),
      '--worktrees-root', path.join(PACKAGE_ROOT, 'test'),
      '--runner-id', 'runner-at7',
      '--engine', 'codex',
    ],
    {},
  );

  assert.equal(given.projectId, 7);
  assert.equal(given.runnerCap, 3);
  assert.equal(given.projectCap, 9);
  assert.equal(given.intervalMs, 250);
  assert.equal(given.leaseTtlSeconds, 30);
  assert.equal(given.repoRoot, path.join(PACKAGE_ROOT, 'src'));
  assert.equal(given.worktreesRoot, path.join(PACKAGE_ROOT, 'test'));
  assert.equal(given.runnerId, 'runner-at7');
  assert.equal(given.engine, 'codex');
});

test('t179 AT1 — a command line with no --worktrees-root exits 2 and dials nothing', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const spy = spyRun();
  const stderr = captureStream('stderr');
  let code: number;
  try {
    // Otherwise impeccable, and that is the point: the only thing wrong here is
    // the flag that has no default, and a runner started without it would
    // otherwise discover it one `acquire` into its first dispatch.
    code = await runRunnerCli(['--url', DEFAULT_URL, '--project', '1'], {}, { run: spy.run });
  } finally {
    stderr.restore();
  }

  assert.equal(code, 2, 'a required flag left out is a wrong command line, never a failed run');
  assert.deepEqual(spy.seen, [], 'nothing may be dialled without somewhere to put the worktrees');

  const written = stderr.written();
  assert.equal(
    written.split('\n').filter((line) => line !== '').length,
    1,
    `one line, not a stack trace:\n${written}`,
  );
  assert.match(written, /--worktrees-root/, 'the line names the flag that is missing');
});

test('t179 AT2 — --worktrees-root inside --working-dir is refused; a sibling is taken', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  // The same directory, spelled three ways: verbatim, one level down, and a
  // path that only becomes the repository itself once it is resolved.
  const overlapping = [SOME_REPO, path.join(SOME_REPO, 'worktrees'), path.join(SOME_REPO, 'src', '..')];

  for (const worktreesRoot of overlapping) {
    const spy = spyRun();
    const stderr = captureStream('stderr');
    let code: number;
    try {
      code = await runRunnerCli(
        ['--working-dir', SOME_REPO, '--worktrees-root', worktreesRoot],
        {},
        { run: spy.run },
      );
    } finally {
      stderr.restore();
    }

    assert.equal(code, 2, `"${worktreesRoot}" is inside the repository it would be cut from`);
    assert.deepEqual(spy.seen, [], `"${worktreesRoot}" must not start a runner`);

    const written = stderr.written();
    assert.equal(
      written.split('\n').filter((line) => line !== '').length,
      1,
      `one actionable line for "${worktreesRoot}":\n${written}`,
    );
    assert.match(written, /--worktrees-root/, 'the line names the flag that is wrong');
    assert.match(written, /--working-dir/, 'and the one it overlaps with');
    assert.match(
      written,
      /git status/,
      `the line says what the overlap costs, not just that it is refused:\n${written}`,
    );
  }

  // ...and the layout the usage text recommends goes through, name prefix and
  // all: `~/proj-worktrees` is a sibling of `~/proj`, never a child of it.
  const spy = spyRun();
  const code = await runRunnerCli(
    ['--working-dir', SOME_REPO, '--worktrees-root', SOME_WORKTREES],
    {},
    { run: spy.run },
  );

  assert.equal(code, 0, 'a sibling worktrees root is the documented layout');
  assert.equal(spy.seen.length, 1, 'the runner really did start');
  assert.equal(spy.seen[0].repoRoot, SOME_REPO);
  assert.equal(spy.seen[0].worktreesRoot, SOME_WORKTREES);
});

/* -------------------------------------------------------------------------- */
/* t193 — a stop that is always bounded.                                      */
/*                                                                            */
/* Until this ficha the two stop signals were registered with `process.once`,  */
/* and the first of them only stopped the loop from SCHEDULING: a dispatch     */
/* already in flight was awaited to completion — up to an hour — and a second  */
/* signal found no listener at all, so the process died under Node's default   */
/* disposition with the engine still running in its worktree.                  */
/* -------------------------------------------------------------------------- */

/** A `run` holding one live session, which only ends when its cancel is called. */
function runWithLiveSession(): {
  run: (options: RunModule.RunnerOptions) => Promise<void>;
  cancels: () => number;
  started: () => boolean;
} {
  let cancels = 0;
  let started = false;

  return {
    cancels: () => cancels,
    started: () => started,
    run: async (options) => {
      let announceEnd: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        announceEnd = resolve;
      });

      started = true;
      // Exactly what `createClaudeCodeDispatch` reports: a live session, and
      // the one function that can take it down. The dispatch settles when the
      // cancel does, which is what makes the runner's own promise resolve.
      options.onSessionStarted?.(async () => {
        cancels += 1;
        options.onSessionEnded?.();
        announceEnd();
      });

      await ended;
    },
  };
}

/** Sends a signal the way a supervisor would, to the listeners of this process. */
function raise(signal: NodeJS.Signals): void {
  process.emit(signal, signal);
}

/** Deadline of these two cases: what "not never" means. */
const STOP_DEADLINE_MS = 10_000;

/** Resolves the command's exit code, or `null` if it did not come back in time. */
async function exitCodeWithin(pending: Promise<number>): Promise<number | null> {
  let guard: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    pending,
    new Promise<null>((resolve) => {
      guard = setTimeout(() => resolve(null), STOP_DEADLINE_MS);
    }),
  ]);
  clearTimeout(guard);
  return outcome;
}

test('t193 — a second stop signal takes the live session down instead of waiting it out', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const seam = runWithLiveSession();
  // The real default: this case may not be passing because the grace was short.
  const pending = runRunnerCli([...ELSEWHERE], {}, { run: seam.run });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seam.started(), 'the runner is up, with a session registered');

  raise('SIGINT');
  assert.equal(seam.cancels(), 0, 'the first signal stops the scheduling, it does not kill');

  raise('SIGINT');

  const code = await exitCodeWithin(pending);
  assert.equal(
    code,
    0,
    `a second SIGINT has to end the process; it did not come back within ${STOP_DEADLINE_MS}ms`,
  );
  assert.equal(seam.cancels(), 1, 'and it ended it by taking the session down, exactly once');
});

test('t193 — with no second signal, the grace elapsing takes the live session down', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const seam = runWithLiveSession();
  const pending = runRunnerCli(
    [...ELSEWHERE, '--shutdown-grace-seconds', '1'],
    {},
    { run: seam.run },
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seam.started());

  const asked = Date.now();
  raise('SIGTERM');

  const code = await exitCodeWithin(pending);
  const took = Date.now() - asked;

  assert.equal(
    code,
    0,
    `the grace is what bounds a stop nobody signalled twice; it did not come back within ${STOP_DEADLINE_MS}ms`,
  );
  assert.equal(seam.cancels(), 1, 'the session went down through the same cancel, once');
  assert.ok(
    took >= 900,
    `it took ${took}ms: the session in flight is given its grace before it is killed`,
  );
});

test('t193 — --shutdown-grace-seconds and --request-timeout-ms are documented, with defaults', async () => {
  const { USAGE, parseRunnerOptions } = await loadModule<typeof CliModule>(CLI_MODULE);

  const defaults = parseRunnerOptions([...ELSEWHERE], {});
  assert.equal(defaults.shutdownGraceSeconds, 120, 'the documented default grace');
  assert.equal(defaults.requestTimeoutMs, 30_000, 'the documented default deadline per request');

  const given = parseRunnerOptions(
    [...ELSEWHERE, '--shutdown-grace-seconds', '5', '--request-timeout-ms', '1500'],
    {},
  );
  assert.equal(given.shutdownGraceSeconds, 5);
  assert.equal(given.requestTimeoutMs, 1_500);

  for (const flag of ['--shutdown-grace-seconds', '--request-timeout-ms']) {
    assert.match(USAGE, new RegExp(flag), `${flag} has to be in the usage text like every other flag`);
  }
  assert.match(USAGE, /120/, 'and the grace default has to be stated there');
  assert.match(USAGE, /30000|30_000/, 'and so does the request deadline default');
});

test('t208 — the old --runner-cap spelling is a command line this command does not understand', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  const spy = spyRun();
  const stderr = captureStream('stderr');
  let code: number;
  try {
    code = await runRunnerCli(
      ['--runner-cap', '1', '--working-dir', SOME_REPO, ...ELSEWHERE],
      {},
      { run: spy.run },
    );
  } finally {
    stderr.restore();
  }

  // No alias and no deprecation warning: the repository is still private (D7),
  // so there is no caller out there to break — and a flag that keeps working
  // while its name says something else is exactly what t208 exists to end.
  assert.equal(code, 2, 'the old spelling is a wrong command line, like any other unknown flag');
  assert.deepEqual(spy.seen, [], 'and nothing may be started on it');
  assert.match(stderr.written(), /does not understand "--runner-cap"/);
});

test('t208 — USAGE names --declared-runner-cap and no longer promises simultaneous sessions', async () => {
  const { USAGE } = await loadModule<typeof CliModule>(CLI_MODULE);

  assert.match(USAGE, /--declared-runner-cap/, 'the flag is documented under the name it has');
  assert.doesNotMatch(
    USAGE,
    /simultaneous sessions of this runner/,
    'the value is a ceiling declared to the control plane, and this process ' +
      'dispatches one session at a time whatever it says',
  );

  // ...and the wire field it feeds is named the way the wire spells it since
  // t226 (`docs/spec/glossario-wire.md` §1.5). The help text is where somebody
  // goes to find out what the server is being told, so a name it retired sends
  // them looking for a field no route has (t254, FR4).
  assert.match(USAGE, /runner_cap/, 'the help names the body field the flag fills');
  assert.doesNotMatch(USAGE, /teto_runner/, 'and never the spelling t226 retired');
});
