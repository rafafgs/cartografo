/**
 * Acceptance tests for the runner's artifact spool (t1340, FR2, AT1–AT6).
 *
 * The spool is where a completed session's declared file waits when the
 * artifact store refused it: outside the worktree (which is released and
 * discarded right after), on this machine's disk, under
 * `<root>/job-<J>/session-<S>/`. Everything here is plain filesystem work, so
 * these cases run against a real temporary directory and nothing else.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as SpoolModule from '../../src/dispatch/artifact-spool.ts';
import * as options from '../../src/dispatch/options.ts';

const SPOOL_MODULE = path.resolve(import.meta.dirname, '..', '..', 'src', 'dispatch', 'artifact-spool.ts');

/** The module under test, loaded only once it exists, so a missing one is an assertion. */
async function load(): Promise<typeof SpoolModule> {
  assert.ok(existsSync(SPOOL_MODULE), 'artifact does not exist yet: packages/runner/src/dispatch/artifact-spool.ts');
  return (await import(SPOOL_MODULE)) as typeof SpoolModule;
}

const NOW = 1_800_000_000_000;

interface Area {
  root: string;
  tree: string;
}

/** A spool root and a fake worktree, both removed after the case. */
function area(t: { after: (fn: () => void) => void }): Area {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1340-spool-'));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const tree = path.join(base, 'tree');
  mkdirSync(tree);
  return { root: path.join(base, 'spool'), tree };
}

/** Every file under a directory, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Array<{
    name: string;
    parentPath: string;
    isFile: () => boolean;
  }>)
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

function hex(name: string): string {
  return Buffer.from(name, 'utf8').toString('hex');
}

test('AT1 — hold copies the bytes, removes the original, and writes state.json and output.txt', async (t) => {
  const { ArtifactSpool } = await load();
  const { root, tree } = area(t);
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13]);
  const file = path.join(tree, 'report.bin');
  writeFileSync(file, bytes);

  const spool = new ArtifactSpool({ root, now: () => NOW });
  const entry = spool.hold({
    jobId: 7,
    projectId: 3,
    sessionId: 41,
    nodeId: 'implementar',
    output: 'the decoded session text',
    files: [{ name: 'relatorio', file }],
  });

  const dir = path.join(root, 'job-7', 'session-41');
  assert.equal(entry.dir, dir);
  assert.deepEqual(readFileSync(path.join(dir, 'files', hex('relatorio'))), bytes, 'byte-identical copy');
  assert.equal(existsSync(file), false, 'the original left the worktree');
  assert.equal(readFileSync(path.join(dir, 'output.txt'), 'utf8'), 'the decoded session text');

  const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(state, {
    version: 1,
    job_id: 7,
    project_id: 3,
    session_id: 41,
    node_id: 'implementar',
    names: ['relatorio'],
    attempts: 1,
    next_attempt_at: NOW + options.DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS[0],
  });
  assert.deepEqual(entry.state, state);
  assert.equal(entry.output, 'the decoded session text');
  assert.deepEqual(filesUnder(dir), ['files/' + hex('relatorio'), 'output.txt', 'state.json']);
});

test('AT2 — a name with `/`, `..` or non-ASCII characters never creates a path outside the root', async (t) => {
  const { ArtifactSpool } = await load();
  const { root, tree } = area(t);
  const names = ['../../escape', 'a/b/c', '..', 'relatório-ñ-日本'];
  const files = names.map((name, index) => {
    const file = path.join(tree, `f${String(index)}`);
    writeFileSync(file, name);
    return { name, file };
  });

  const spool = new ArtifactSpool({ root, now: () => NOW });
  const entry = spool.hold({ jobId: 1, sessionId: 2, nodeId: 'n', output: '', files });

  const base = path.dirname(root);
  assert.deepEqual(
    readdirSync(base).sort(),
    ['spool', 'tree'],
    'nothing was written beside the root',
  );
  assert.deepEqual(readdirSync(path.join(root)).sort(), ['job-1']);
  for (const { name } of files) {
    const stored = path.join(entry.dir, 'files', hex(name));
    assert.equal(readFileSync(stored, 'utf8'), name);
    assert.ok(stored.startsWith(root + path.sep));
  }
  assert.deepEqual(entry.state.names, names, 'the names live in state.json, verbatim');
});

test('AT3 — a new spool on the same root finds the entry (restart survival)', async (t) => {
  const { ArtifactSpool } = await load();
  const { root, tree } = area(t);
  const file = path.join(tree, 'r.md');
  writeFileSync(file, 'content');
  new ArtifactSpool({ root, now: () => NOW }).hold({
    jobId: 9,
    projectId: 2,
    sessionId: 90,
    nodeId: 'implementar',
    output: 'text',
    files: [{ name: 'relatorio', file }],
  });

  const fresh = new ArtifactSpool({ root });
  const found = fresh.find(9, 2);
  assert.ok(found !== null);
  assert.equal(found.state.session_id, 90);
  assert.equal(found.output, 'text');
  assert.equal(readFileSync(fresh.fileOf(found, 'relatorio'), 'utf8'), 'content');
  assert.equal(fresh.find(10, 2), null, 'another job has no entry');
});

test('AT4 — find tolerates an absent root, an unparseable state and an unknown version', async (t) => {
  const { ArtifactSpool } = await load();
  const { root } = area(t);
  const spool = new ArtifactSpool({ root });
  assert.equal(spool.find(1), null, 'the root does not exist yet');

  const broken = path.join(root, 'job-1', 'session-5');
  mkdirSync(broken, { recursive: true });
  writeFileSync(path.join(broken, 'state.json'), '{ not json');
  assert.equal(spool.find(1), null);
  assert.ok(existsSync(path.join(broken, 'state.json')), 'left on disk');

  const future = path.join(root, 'job-2', 'session-6');
  mkdirSync(future, { recursive: true });
  writeFileSync(
    path.join(future, 'state.json'),
    JSON.stringify({ version: 2, job_id: 2, session_id: 6, node_id: 'n', names: [], attempts: 1, next_attempt_at: 0 }),
  );
  assert.equal(spool.find(2), null);
  assert.ok(existsSync(path.join(future, 'state.json')), 'left on disk');
});

test('AT5 — discard removes the session dir then an empty job dir; recordAttempt touches two fields', async (t) => {
  const { ArtifactSpool } = await load();
  const { root, tree } = area(t);
  const spool = new ArtifactSpool({ root, now: () => NOW });
  const make = (sessionId: number): SpoolModule.SpoolEntry => {
    const file = path.join(tree, `s${String(sessionId)}`);
    writeFileSync(file, 'x');
    return spool.hold({ jobId: 4, sessionId, nodeId: 'n', output: 'o', files: [{ name: 'k', file }] });
  };

  const first = make(1);
  const updated = spool.recordAttempt(first, { attempts: 3, next_attempt_at: NOW + 5 });
  const onDisk = JSON.parse(readFileSync(path.join(first.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(onDisk, { ...first.state, attempts: 3, next_attempt_at: NOW + 5 });
  assert.deepEqual(updated.state, onDisk);

  const second = make(2);
  spool.discard(first);
  assert.equal(existsSync(first.dir), false);
  assert.ok(existsSync(path.join(root, 'job-4')), 'the job dir still holds another session');
  spool.discard(second);
  assert.equal(existsSync(path.join(root, 'job-4')), false, 'an empty job dir goes too');

  spool.discard(second);
  spool.discard(null);
});

test('AT6 — the ladder repeats its last rung and caps at 3600 s; unusable overrides fall back', async () => {
  const { ArtifactSpool, MAX_ARTIFACT_UPLOAD_BACKOFF_MS, backoffAfter, resolveArtifactUploadBackoff, resolveMaxArtifactUploadAttempts } =
    await load();
  const { DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS, DEFAULT_MAX_ARTIFACT_UPLOAD_ATTEMPTS } = options;
  assert.equal(MAX_ARTIFACT_UPLOAD_BACKOFF_MS, 3_600_000);
  assert.deepEqual([...DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS], [60_000, 120_000, 240_000, 480_000]);
  assert.equal(DEFAULT_MAX_ARTIFACT_UPLOAD_ATTEMPTS, 5);

  const ladder = [1_000, 2_000, 3_000];
  assert.equal(backoffAfter(ladder, 1), 1_000);
  assert.equal(backoffAfter(ladder, 2), 2_000);
  assert.equal(backoffAfter(ladder, 3), 3_000);
  assert.equal(backoffAfter(ladder, 9), 3_000, 'the last rung repeats');
  assert.equal(backoffAfter([10_000_000], 1), 3_600_000, 'capped at an hour');
  assert.equal(backoffAfter(ladder, 0), 1_000, 'a count below one reads the first rung');

  for (const unusable of [[], [0], [-5], [Number.NaN], [1_000, 0]]) {
    assert.equal(resolveArtifactUploadBackoff(unusable), DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS, JSON.stringify(unusable));
  }
  assert.equal(resolveArtifactUploadBackoff(undefined), DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS);
  assert.deepEqual(resolveArtifactUploadBackoff([5, 10]), [5, 10]);

  for (const unusable of [0, -1, Number.NaN, 1.5, undefined]) {
    assert.equal(resolveMaxArtifactUploadAttempts(unusable), 5, String(unusable));
  }
  assert.equal(resolveMaxArtifactUploadAttempts(2), 2);

  const custom = new ArtifactSpool({ root: '/nonexistent', backoffMs: [0] });
  assert.equal(custom.backoffMs, DEFAULT_ARTIFACT_UPLOAD_BACKOFF_MS, 'the spool resolves its own ladder');
});
