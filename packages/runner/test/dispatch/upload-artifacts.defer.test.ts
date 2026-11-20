/**
 * Acceptance tests for the deferral mode of `uploadArtifacts` (t1340, FR1,
 * AT7–AT10).
 *
 * With `deferFailures` unset the function behaves exactly as it did: a store
 * failure throws. With it set, a failure of the store for a declared key is
 * reported back as `pending` instead, every declared key is still attempted,
 * and the file of a pending key is left where it is so the caller can spool it.
 * A REFUSED declaration keeps its meaning in both modes.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A namespace import, so AT7 runs (and passes) before `uploadOne` is exported.
import * as upload from '../../src/dispatch/upload-artifacts.ts';

const { uploadArtifacts } = upload;

const URL_BASE = 'http://control-plane.invalid';

const SCHEMA = {
  type: 'object',
  properties: {
    nota: { type: 'string' },
    relatorio: { type: 'string', 'x-artifact': true },
    anexo: { type: 'string', 'x-artifact': true },
  },
};

/** A worktree holding the given files, removed after the case. */
function worktree(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cartografo-t1340-defer-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

/**
 * A store that answers per artifact name: a status (with an id for a 2xx) or
 * a raw body for a 2xx with no usable id.
 */
function store(
  answers: Record<string, { status: number; body?: string }>,
): { doFetch: typeof fetch; names: string[] } {
  const names: string[] = [];
  let next = 10;
  const doFetch: typeof fetch = (_input, init) => {
    const name = new Headers(init?.headers).get('x-artifact-name') ?? '';
    names.push(name);
    const answer = answers[name] ?? { status: 201 };
    next += 1;
    const body =
      answer.body ??
      (answer.status < 300 ? JSON.stringify({ id: next, session_id: 5, name }) : `store said ${String(answer.status)}`);
    return Promise.resolve(new Response(body, { status: answer.status }));
  };
  return { doFetch, names };
}

test('AT7 — with deferFailures unset, a store 500 still rejects (existing behaviour)', async (t) => {
  const dir = worktree(t, { 'r.md': 'r' });
  const { doFetch } = store({ relatorio: { status: 500 } });
  await assert.rejects(
    uploadArtifacts({ urlBase: URL_BASE, doFetch }, 5, dir, SCHEMA, { nota: 'n', relatorio: 'r.md' }),
    /answered 500/,
  );
  assert.ok(existsSync(path.join(dir, 'r.md')));
});

test('AT8 — deferral: both keys attempted, the id for the good one, the path and the error for the other', async (t) => {
  const dir = worktree(t, { 'r.md': 'r', 'a.md': 'a' });
  const { doFetch, names } = store({ relatorio: { status: 500 } });

  const result = await uploadArtifacts(
    { urlBase: URL_BASE, doFetch, deferFailures: true },
    5,
    dir,
    SCHEMA,
    { nota: 'n', relatorio: 'r.md', anexo: 'a.md' },
  );

  assert.deepEqual(names, ['relatorio', 'anexo'], 'every declared key is still attempted');
  assert.equal(result.problems, undefined);
  assert.deepEqual(result.output, { nota: 'n', relatorio: 'r.md', anexo: '12' });
  assert.equal(result.pending?.length, 1);
  const [pending] = result.pending ?? [];
  assert.equal(pending.name, 'relatorio');
  assert.equal(pending.file, path.join(dir, 'r.md'));
  assert.match(pending.error, /answered 500: store said 500/);
  assert.ok(existsSync(path.join(dir, 'r.md')), 'the failing file is left for the spool');
  assert.equal(existsSync(path.join(dir, 'a.md')), false, 'the uploaded one is removed as before');
});

test('AT9 — deferral: a refused declaration plus a failing upload is `{problems}` only', async (t) => {
  const dir = worktree(t, { 'r.md': 'r' });
  const { doFetch } = store({ relatorio: { status: 500 } });

  const result = await uploadArtifacts(
    { urlBase: URL_BASE, doFetch, deferFailures: true },
    5,
    dir,
    SCHEMA,
    { nota: 'n', relatorio: 'r.md', anexo: 'missing.md' },
  );

  assert.deepEqual(Object.keys(result), ['problems']);
  assert.equal(result.problems?.length, 1);
  assert.match(result.problems?.[0] ?? '', /anexo.*does not exist/);
  assert.doesNotMatch(result.problems?.[0] ?? '', /500/, 'the upload error is not a problem');
});

test('AT10 — deferral: a 2xx with no usable id counts as a store failure', async (t) => {
  const dir = worktree(t, { 'r.md': 'r' });
  const { doFetch } = store({ relatorio: { status: 201, body: JSON.stringify({ id: 'seven' }) } });

  const result = await uploadArtifacts(
    { urlBase: URL_BASE, doFetch, deferFailures: true },
    5,
    dir,
    SCHEMA,
    { nota: 'n', relatorio: 'r.md' },
  );

  assert.deepEqual(result.output, { nota: 'n', relatorio: 'r.md' });
  assert.equal(result.pending?.length, 1);
  assert.match(result.pending?.[0].error ?? '', /no artifact id/);
  assert.ok(existsSync(path.join(dir, 'r.md')));

  // And the single upload is exported for the resume path, unchanged.
  const ok = store({});
  assert.equal(await upload.uploadOne({ urlBase: URL_BASE, doFetch: ok.doFetch }, 5, 'relatorio', path.join(dir, 'r.md')), '11');
});
