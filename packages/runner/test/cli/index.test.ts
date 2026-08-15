/**
 * Acceptance tests of the runner command's command line (t162, AT1–AT7).
 *
 * Pure parsing: nothing here opens a socket, and that is half of what is being
 * proven. A command line the CLI cannot read must die before the first request
 * — a runner that dials a control plane and only then discovers that
 * `--project abc` is not a number has already spent a round trip to say
 * something it knew at argument zero.
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

  assert.equal(parseRunnerOptions([], {}).url, DEFAULT_URL);

  // ...and the precedence above that default, in the two steps it has.
  assert.equal(
    parseRunnerOptions([], { CARTOGRAFO_URL: 'http://127.0.0.1:5000' }).url,
    'http://127.0.0.1:5000',
    'the environment beats the default',
  );
  assert.equal(
    parseRunnerOptions(['--url', 'http://127.0.0.1:6000'], {
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
    parseRunnerOptions(['--token', 'from-the-flag'], { CARTOGRAFO_TOKEN: 'from-the-env' }).token,
    'from-the-flag',
  );
  assert.equal(parseRunnerOptions([], { CARTOGRAFO_TOKEN: 'from-the-env' }).token, 'from-the-env');

  const options = parseRunnerOptions([], {});
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
    code = await runRunnerCli(['--project', 'abc'], {}, { run: spy.run });
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
    code = await runRunnerCli(['--engine', 'bogus'], {}, { run: spy.run });
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

  for (const args of [['--turbo'], ['start'], ['--url', 'http://127.0.0.1:4317', 'extra']]) {
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
      code = await runRunnerCli(['--url', 'http://127.0.0.1:4999'], {}, {
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

  const options = parseRunnerOptions([], {});

  assert.equal(options.projectId, 1, 'the same project every other part of the system falls back to');
  assert.equal(options.runnerCap, 1);
  assert.equal(options.projectCap, 4);
  assert.equal(options.intervalMs, 2000);
  assert.equal(options.leaseTtlSeconds, 60);
  assert.equal(options.workingDir, process.cwd());
  assert.equal(options.engine, 'claude-code', 'the default engine is named, never implied');
  assert.notEqual(options.runnerId, '', 'a runner without an identity cannot pair');

  // ...and each one really is overridable, or the defaults above would be the
  // only values these flags ever have.
  const given = parseRunnerOptions(
    [
      '--project', '7',
      '--runner-cap', '3',
      '--project-cap', '9',
      '--interval-ms', '250',
      '--lease-ttl-seconds', '30',
      '--working-dir', path.join(PACKAGE_ROOT, 'src'),
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
  assert.equal(given.workingDir, path.join(PACKAGE_ROOT, 'src'));
  assert.equal(given.runnerId, 'runner-at7');
  assert.equal(given.engine, 'codex');
});
