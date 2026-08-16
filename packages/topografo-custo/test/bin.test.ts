/**
 * Acceptance test for the installable `topografo-custo` command (t199, FR3).
 *
 * It runs `bin/topografo-custo.mjs` as a real child process, in the same mould
 * as `packages/core/test/startup.test.ts`: the contract of a CLI IS the process
 * — exit code, stdout and stderr — and none of that exists when `runCli` is
 * called directly (which is what `cli.test.ts` already does, and it covers
 * something else).
 *
 * What this proves is the gap the ticket closes: until now this package only
 * ran as `node --import tsx src/cli.ts`, even though its own usage text has
 * documented `topografo-custo avaliar …` since t180. The bin registers the tsx
 * loader in process and imports `src/cli.ts` — whoever runs the command does
 * not have to know that tsx exists.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The executable under test. */
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'topografo-custo.mjs');

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: bin/topografo-custo.mjs');
  const done = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

test('AT — `topografo-custo --help` exits 0 and prints the usage text', () => {
  const result = run('--help');

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /^usage: topografo-custo avaliar/m);
  assert.match(result.stdout, /--teto-tokens/);
  assert.equal(result.stderr, '', 'asking for help is stdout, not an error');
});

test('AT — `topografo-custo` with no argument at all exits 2', () => {
  const result = run();

  assert.equal(result.code, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /unknown subcommand/);
  // A wrong command line leaks no stack trace: the message and the usage go out.
  assert.doesNotMatch(result.stderr, /\n\s+at\s+\S+/);
});

test('AT — the package declares the bin under the same name its usage text documents', () => {
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  assert.deepEqual(manifest.bin, { 'topografo-custo': './bin/topografo-custo.mjs' });
  // The bin imports `tsx/esm/api` on its first line: outside the monorepo a
  // devDependency is not installed and the command dies right there (t199, FR2).
  assert.ok(manifest.dependencies?.tsx, 'tsx is a runtime dependency for whoever publishes a bin');
});
