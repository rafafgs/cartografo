/**
 * Acceptance tests for the files that carry a node's inputs (t689, FR5–FR7).
 *
 * `newInputFilesDir` mints one directory per render, and `createInputFiles`
 * turns a plan into bytes on disk and takes them away again. The properties
 * that matter: the bytes are exact (UTF-8, no BOM), a write never overwrites,
 * two attempts never share a directory, and removal can never fail the
 * dispatch it is cleaning up after.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { PlannedInputFile } from '../../src/dispatch/interpolate-input.ts';
import { createInputFiles, newInputFilesDir } from '../../src/dispatch/input-files.ts';

function scratchRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t689-files-'));
  t.after(() => {
    try {
      chmodSync(root, 0o700);
    } catch {
      // nothing to restore
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function planIn(dir: string): PlannedInputFile[] {
  return [
    { placeholderPath: 'doc', filePath: path.join(dir, 'doc.json'), content: '{"a":"é 😀"}' },
    { placeholderPath: 'a.b', filePath: path.join(dir, 'a.b.json'), content: 'plain text\n' },
    { placeholderPath: 'empty', filePath: path.join(dir, 'empty.json'), content: '' },
  ];
}

test('AT4 — newInputFilesDir is <root>/job-<id>/<16 hex>, and two calls for one job differ', (t) => {
  const root = scratchRoot(t);

  const first = newInputFilesDir(root, 42);
  const second = newInputFilesDir(root, 42);

  assert.notEqual(first, second);
  for (const dir of [first, second]) {
    assert.equal(path.dirname(path.dirname(dir)), root);
    assert.equal(path.basename(path.dirname(dir)), 'job-42');
    assert.match(path.basename(dir), /^[0-9a-f]{16}$/);
    for (const segment of path.relative(root, dir).split(path.sep)) {
      assert.match(segment, /^[A-Za-z0-9_.-]+$/);
    }
  }
  assert.equal(existsSync(first), false, 'minting a name creates nothing');
});

test('AT4 — write() creates the directory and the exact bytes, UTF-8, no BOM, private modes', async (t) => {
  const root = scratchRoot(t);
  const dir = newInputFilesDir(root, 7);
  const handle = createInputFiles(planIn(dir));

  await handle.write();

  assert.ok(statSync(dir).isDirectory());
  const bytes = readFileSync(path.join(dir, 'doc.json'));
  assert.deepEqual([...bytes], [...Buffer.from('{"a":"é 😀"}', 'utf8')]);
  assert.notEqual(bytes[0], 0xef, 'no BOM');
  assert.equal(readFileSync(path.join(dir, 'a.b.json'), 'utf8'), 'plain text\n');
  assert.equal(readFileSync(path.join(dir, 'empty.json')).length, 0, 'an empty string is an empty file');
  assert.deepEqual(readdirSync(dir).sort(), ['a.b.json', 'doc.json', 'empty.json']);

  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(dir, 'doc.json')).mode & 0o777, 0o600);
  }
});

test('AT4 — write() refuses to overwrite an existing file and leaves it as it was', async (t) => {
  const root = scratchRoot(t);
  const dir = newInputFilesDir(root, 7);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'doc.json'), 'somebody else');

  await assert.rejects(() => createInputFiles(planIn(dir)).write(), /EEXIST/);

  assert.equal(readFileSync(path.join(dir, 'doc.json'), 'utf8'), 'somebody else');
});

test('AT4 — dispose() removes the directory and the emptied job-<id>, and is idempotent', async (t) => {
  const root = scratchRoot(t);
  const dir = newInputFilesDir(root, 9);
  const handle = createInputFiles(planIn(dir));
  await handle.write();

  await handle.dispose();

  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(path.dirname(dir)), false, 'the emptied job-<id> goes too');
  assert.ok(existsSync(root), 'the root itself is never touched');

  await handle.dispose();
});

test('AT4 — dispose() keeps a job-<id> that still holds another attempt', async (t) => {
  const root = scratchRoot(t);
  const left = newInputFilesDir(root, 9);
  const mine = newInputFilesDir(root, 9);
  mkdirSync(left, { recursive: true });
  writeFileSync(path.join(left, 'stale.json'), 'crash leftover');
  const handle = createInputFiles(planIn(mine));
  await handle.write();

  await handle.dispose();

  assert.equal(existsSync(mine), false);
  assert.equal(readFileSync(path.join(left, 'stale.json'), 'utf8'), 'crash leftover', 'no sweep, no reuse');
});

test('AT4 — dispose() survives a directory that never existed, an empty plan, and a failing removal', async (t) => {
  const root = scratchRoot(t);

  await createInputFiles(planIn(newInputFilesDir(root, 1))).dispose();
  await createInputFiles([]).write();
  await createInputFiles([]).dispose();
  assert.deepEqual(readdirSync(root), [], 'an empty plan touches nothing');

  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const dir = newInputFilesDir(root, 2);
  const handle = createInputFiles(planIn(dir));
  await handle.write();
  chmodSync(path.dirname(dir), 0o500);
  try {
    await handle.dispose();
  } finally {
    chmodSync(path.dirname(dir), 0o700);
  }
});

test('AT4 — a write that fails halfway still lets dispose() clean what was created', async (t) => {
  const root = scratchRoot(t);
  const dir = newInputFilesDir(root, 3);
  const plan = planIn(dir);
  const handle = createInputFiles(plan);
  // The second file's name is taken by a directory: the first file is written, the second fails.
  const blocker = plan[1];
  assert.ok(blocker !== undefined);
  mkdirSync(blocker.filePath, { recursive: true });

  await assert.rejects(() => handle.write());
  assert.ok(existsSync(path.join(dir, 'doc.json')), 'the first file was created before the failure');

  await handle.dispose();

  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(path.dirname(dir)), false);
});

test('AT4 — a read-only root fails the write, and dispose() is still harmless', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const root = scratchRoot(t);
  chmodSync(root, 0o500);
  const handle = createInputFiles(planIn(newInputFilesDir(root, 4)));

  await assert.rejects(() => handle.write(), /EACCES|EPERM/);
  await handle.dispose();

  chmodSync(root, 0o700);
  assert.deepEqual(readdirSync(root), []);
});
