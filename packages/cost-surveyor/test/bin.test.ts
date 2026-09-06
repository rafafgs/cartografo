/**
 * Acceptance test for the installable `cost-surveyor` command (t199, FR3).
 *
 * It runs `bin/cost-surveyor.mjs` as a real child process, in the same mould
 * as `packages/core/test/startup.test.ts`: the contract of a CLI IS the process
 * — exit code, stdout and stderr — and none of that exists when `runCli` is
 * called directly (which is what `cli.test.ts` already does, and it covers
 * something else).
 *
 * What this proves is the gap t199 closed: until then this package only ran
 * through a `node` invocation carrying a loader flag, even though its own usage
 * text has documented `cost-surveyor avaliar …` since t180 — `evaluate` since
 * t255. The bin imports `src/cli.ts` directly and Node strips the types itself,
 * so whoever runs the command has no loader to know about.
 *
 * The last case changed shape in t248 (D23). It used to assert that THIS package
 * declares the `cost-surveyor` command and carries the loader as a runtime
 * dependency. Neither is true any more, and both were made false on purpose: the
 * product ships as ONE publishable package, so `cartografo` is the only manifest
 * that claims a command name — two workspace members claiming one name is a race
 * over whichever gets linked — and this package is reached through it. What is
 * asserted instead is the half that has to hold for that to work.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The executable under test. */
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cost-surveyor.mjs');

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: bin/cost-surveyor.mjs');
  const done = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

test('AT — `cost-surveyor --help` exits 0 and prints the usage text', () => {
  const result = run('--help');

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /^usage: cost-surveyor evaluate/m);
  assert.match(result.stdout, /--token-cap/);
  assert.equal(result.stderr, '', 'asking for help is stdout, not an error');
});

test('AT — `cost-surveyor` with no argument at all exits 2', () => {
  const result = run();

  assert.equal(result.code, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /unknown subcommand/);
  // A wrong command line leaks no stack trace: the message and the usage go out.
  assert.doesNotMatch(result.stderr, /\n\s+at\s+\S+/);
});

test('t248 — the command is claimed by `cartografo`, and this package exposes its bin to it', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    exports?: Record<string, unknown>;
  };

  assert.equal(
    manifest.bin,
    undefined,
    'only `cartografo` declares a command name (D23): two members claiming one is a race',
  );
  assert.deepEqual(
    manifest.exports?.['./bin/cost-surveyor'],
    { default: './bin/cost-surveyor.mjs' },
    'the delegator in packages/core reaches this file BY PACKAGE NAME, in the checkout and in the tarball alike',
  );

  const host = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, '..', 'core', 'package.json'), 'utf8'),
  ) as { bin?: Record<string, string>; bundledDependencies?: string[] };

  assert.equal(
    host.bin?.['cost-surveyor'],
    './bin/cost-surveyor.mjs',
    'the published package carries this command',
  );
  assert.ok(
    host.bundledDependencies?.includes('@cartografo/cost-surveyor'),
    'and bundles this package, or the command it carries would resolve to nothing',
  );
});
