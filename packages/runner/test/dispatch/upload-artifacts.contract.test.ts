/**
 * Contract test for the artifact upload against the REAL control plane (t1311).
 *
 * `upload-artifacts.test.ts` answers the route with a recorder, and for a whole
 * wave the recorder answered `{ id: 'artifact-N' }` — a shape the core never
 * served — so a node whose output declares an `x-artifact` property could not
 * finish, and nothing in the runner suite noticed. This file closes that gap by
 * talking to the one thing that cannot drift from itself: a spawned control
 * plane, a real session, a real `fetch` and the bootstrap token.
 *
 * Decision recorded in the ticket: the runner normalizes. The core's `id` is a
 * number on four public `/v1` routes; the manifest format says an `x-artifact`
 * property is a string; the runner writes `String(id)`. Test 2 below is the
 * assertion that fails, by name, if the core ever changes that type.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bootCore, type TestHook } from '@cartografo/test-support';

import { uploadArtifacts } from '../../src/dispatch/upload-artifacts.ts';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    nota: { type: 'string' },
    relatorio: { type: 'string', 'x-artifact': true },
    evidencia: { type: 'string', 'x-artifact': true },
  },
};

interface Plane {
  url: string;
  token: string;
  /** A fresh session on a fresh job, opened through the real routes. */
  openSession: () => Promise<number>;
  /** A fresh worktree with the given files already written. */
  worktree: (files: Record<string, string>) => string;
}

/** Boots the control plane and hands back what every case below needs. */
async function startPlane(t: TestHook): Promise<Plane> {
  const { url, token } = await bootCore(t);

  const post = async (route: string, body: unknown): Promise<{ id: number }> => {
    const response = await fetch(`${url}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    assert.equal(response.status, 201, `POST ${route} answered ${String(response.status)}: ${text}`);
    return JSON.parse(text) as { id: number };
  };

  return {
    url,
    token,
    openSession: async () => {
      const job = await post('/v1/jobs', { title: 'an artifact crossing', entry_node_id: 'redigir' });
      const session = await post('/v1/sessions', {
        job_id: job.id,
        node_id: 'redigir',
        engine: 'claude-code',
        working_dir: '/tmp/cartografo',
        prompt: 'Write the report.',
      });
      return session.id;
    },
    worktree: (files) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'cartografo-t1311-'));
      t.after(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), content, 'utf8');
      }
      return dir;
    },
  };
}

async function getJson<T>(plane: Plane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${String(response.status)}: ${text}`);
  return JSON.parse(text) as T;
}

function options(plane: Plane): { urlBase: string; token: string } {
  return { urlBase: plane.url, token: plane.token };
}

test('t1311 AT-contract-roundtrip — the id written into the report reads the file back from the real core', async (t) => {
  const plane = await startPlane(t);
  const sessionId = await plane.openSession();
  const dir = plane.worktree({ 'report.md': 'the bytes the session wrote' });

  const result = await uploadArtifacts(
    options(plane),
    sessionId,
    dir,
    OUTPUT_SCHEMA,
    { nota: 'done', relatorio: 'report.md' },
  );

  assert.equal(result.problems, undefined);
  const id = result.output?.relatorio;
  assert.equal(typeof id, 'string', 'the manifest declares the property a string');

  const listed = await getJson<{ artifacts: Array<{ id: number }> }>(
    plane,
    `/v1/sessions/${String(sessionId)}/artifacts`,
  );
  assert.equal(listed.artifacts.length, 1);
  assert.equal(id, String(listed.artifacts[0].id), "the property is the decimal string of the record's id");

  const content = await fetch(`${plane.url}/v1/artifacts/${String(id)}/content`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.equal(content.status, 200);
  assert.equal(await content.text(), 'the bytes the session wrote');
  assert.ok(!existsSync(path.join(dir, 'report.md')), 'the local file is removed afterwards');
});

test('t1311 AT-contract-core-id-is-number — the real route answers an artifact id as a JSON number', async (t) => {
  const plane = await startPlane(t);
  const sessionId = await plane.openSession();

  const response = await fetch(`${plane.url}/v1/sessions/${String(sessionId)}/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${plane.token}`,
      'content-type': 'application/octet-stream',
      'x-artifact-name': 'relatorio',
    },
    body: new Uint8Array(Buffer.from('raw bytes')),
  });
  const body = (await response.json()) as { id: unknown };

  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(
    typeof body.id,
    'number',
    'the runner normalizes a NUMBER; if the core changes this type, upload-artifacts.ts has to follow',
  );
});

test('t1311 AT-contract-two-artifacts — each property carries the id of its own upload', async (t) => {
  const plane = await startPlane(t);
  const sessionId = await plane.openSession();
  const dir = plane.worktree({ 'report.md': 'the first', 'evidence.txt': 'the second' });

  const result = await uploadArtifacts(
    options(plane),
    sessionId,
    dir,
    OUTPUT_SCHEMA,
    { nota: 'done', relatorio: 'report.md', evidencia: 'evidence.txt' },
  );

  assert.equal(result.problems, undefined);
  const output = result.output ?? {};
  assert.notEqual(output.relatorio, output.evidencia, 'two uploads are two ids');

  for (const [key, bytes] of [
    ['relatorio', 'the first'],
    ['evidencia', 'the second'],
  ] as const) {
    const content = await fetch(`${plane.url}/v1/artifacts/${String(output[key])}/content`, {
      headers: { authorization: `Bearer ${plane.token}` },
    });
    assert.equal(await content.text(), bytes, `${key} reads back the bytes of its own file`);
  }
});

test('t1311 AT-contract-unknown-session — the real status reaches the caller, not the no-id error', async (t) => {
  const plane = await startPlane(t);
  const dir = plane.worktree({ 'report.md': 'nobody will store this' });

  await assert.rejects(
    async () =>
      await uploadArtifacts(options(plane), 999999, dir, OUTPUT_SCHEMA, {
        nota: 'done',
        relatorio: 'report.md',
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('answered 404'), error.message);
      assert.ok(!error.message.includes('no artifact id'), error.message);
      return true;
    },
  );
});
