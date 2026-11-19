/**
 * Hygiene guard for `cli-support.ts`'s `runCli` (t1334).
 *
 * `runCli` creates a database directory for every call. A static count cannot
 * see a leak there (the file also removes the directory of a different
 * helper), so this test counts inside a private temp directory: `os.tmpdir()`
 * reads `TMPDIR` on every call on POSIX, so pointing it at a directory of our
 * own makes every `mkdtemp` the helper does land where it can be listed.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from './cli-support.ts';

/** Points `TMPDIR` at a private directory for the length of the test. */
function privateTmpdir(t: { after: (fn: () => void) => void }): string {
  const savedTmpdir = process.env.TMPDIR;
  const privateDir = mkdtempSync(path.join(tmpdir(), 'cartografo-t1334-hygiene-'));
  process.env.TMPDIR = privateDir;
  t.after(() => {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    rmSync(privateDir, { recursive: true, force: true });
  });
  return privateDir;
}

test('t1334 AT1 — runCli leaves nothing behind on a normal run', { timeout: 60_000 }, async (t) => {
  const privateDir = privateTmpdir(t);

  const result = await runCli(['--help']);

  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.deepEqual(readdirSync(privateDir), []);
});

test('t1334 AT2 — runCli leaves nothing behind when the spawn fails', { timeout: 60_000 }, async (t) => {
  const privateDir = privateTmpdir(t);

  await assert.rejects(runCli(['--help'], { cwd: path.join(privateDir, 'does-not-exist') }));

  assert.deepEqual(readdirSync(privateDir), []);
});

test('t1334 AT2 — runCli leaves nothing behind when the child is killed', { timeout: 60_000 }, async (t) => {
  const privateDir = privateTmpdir(t);

  const result = await runCli(['up', '--no-runner'], { timeoutMs: 1 });

  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
  assert.deepEqual(readdirSync(privateDir), []);
});
