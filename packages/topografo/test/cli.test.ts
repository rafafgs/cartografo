/**
 * The command line of `cartografo-topografo` (t247, FR1).
 *
 * The three-way exit convention this repository already uses — `0` did what it
 * promised, `1` ran and the result was negative, `2` the command line is wrong
 * — read in process, with no child spawned: argv parsing needs no socket, and
 * the one case that does (`1`, a refused stream) is exercised against a fake
 * `fetch` rather than a fake control plane.
 *
 * `watch.e2e.test.ts` next door is where the same command is spawned for real.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CliModule from '../src/cli.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_MODULE = 'src/cli.ts';

let cache: typeof CliModule | null = null;

async function loadCli(): Promise<typeof CliModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, CLI_MODULE)),
    `artifact does not exist yet: packages/topografo/${CLI_MODULE}`,
  );
  cache ??= (await import(new URL(`../${CLI_MODULE}`, import.meta.url).href)) as typeof CliModule;
  return cache;
}

/** Runs the command line, collecting what it wrote to stdout. */
async function run(args: string[], context: CliModule.CliContext = {}): Promise<{
  code: number;
  printed: string;
}> {
  const { runCli } = await loadCli();
  const printed: string[] = [];
  const code = await runCli(args, {
    write: (text) => printed.push(text),
    log: () => undefined,
    ...context,
  });
  return { code, printed: printed.join('') };
}

test('t247 FR1 — --help prints the usage and exits 0', async () => {
  const { USAGE } = await loadCli();

  for (const flag of ['--help', '-h']) {
    const result = await run([flag]);
    assert.equal(result.code, 0, `${flag} is not an error`);
    assert.equal(result.printed, `${USAGE}\n`);
  }

  // And it wins over everything else on the line: somebody who cannot get the
  // arguments right is exactly who is asking for the usage.
  const overSubcommand = await run(['watch', '--help']);
  assert.equal(overSubcommand.code, 0);
  assert.equal(overSubcommand.printed, `${USAGE}\n`);
});

test('t247 FR1 — the usage text names the subcommand, both required flags and the two options', async () => {
  const { USAGE } = await loadCli();

  for (const typed of ['watch', '--url', '--token', '--lens', '--dry-run']) {
    assert.ok(USAGE.includes(typed), `the usage does not mention ${typed}:\n${USAGE}`);
  }
});

test('t247 FR1 — a wrong command line is a 2, and prints nothing to stdout', async () => {
  const wrong: Array<[string, string[]]> = [
    ['no subcommand at all', []],
    ['a subcommand nobody has', ['evaluate', '--url', 'http://127.0.0.1:4317']],
    ['no --url', ['watch', '--token', 'operator-token']],
    ['no --token', ['watch', '--url', 'http://127.0.0.1:4317']],
    ['an empty --token', ['watch', '--url', 'http://127.0.0.1:4317', '--token', '  ']],
    [
      'a lens nobody has',
      ['watch', '--url', 'http://127.0.0.1:4317', '--token', 'operator-token', '--lens', 'quality'],
    ],
    [
      'a flag this command does not understand',
      ['watch', '--url', 'http://127.0.0.1:4317', '--token', 'operator-token', '--every', '5'],
    ],
  ];

  for (const [what, args] of wrong) {
    const result = await run(args);
    assert.equal(result.code, 2, `${what} has to be a usage error: ${args.join(' ')}`);
    assert.equal(result.printed, '', `${what} wrote to stdout, which is the line channel`);
  }
});

test('t247 FR1 — --lens defaults to all, and both spellings of an option parse', async () => {
  const { parseArguments } = await loadCli();

  assert.deepEqual(
    parseArguments(['--url', 'http://127.0.0.1:4317', '--token', 'operator-token']),
    { url: 'http://127.0.0.1:4317', token: 'operator-token', lens: 'all', dryRun: false },
  );

  assert.deepEqual(
    parseArguments([
      '--url=http://127.0.0.1:4317',
      '--token=operator-token',
      '--lens=flow',
      '--dry-run',
    ]),
    { url: 'http://127.0.0.1:4317', token: 'operator-token', lens: 'flow', dryRun: true },
  );

  for (const lens of ['flow', 'cost', 'all']) {
    assert.equal(
      parseArguments(['--url', 'http://x', '--token', 't', '--lens', lens]).lens,
      lens,
      `--lens ${lens} is one of the three this command has`,
    );
  }
});

test('t247 FR2 — a stream that refuses the credential is a 1, not a retry loop', async () => {
  // The consumer retries anything that could be transient, forever; a 401 is not
  // one of those, and it travels all the way out to the exit code.
  const doFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid_credential' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });

  const result = await run(
    ['watch', '--url', 'http://127.0.0.1:4317', '--token', 'a-revoked-token'],
    { doFetch },
  );

  assert.equal(result.code, 1, 'denied, not degraded: the process says why and stops');
  assert.equal(result.printed, '', 'and it wrote no outcome line, because nothing happened');
});
