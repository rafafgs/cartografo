/**
 * Acceptance tests for the artifact upload a declared output triggers (t423,
 * FR2).
 *
 * The rule Rafael settled on 2026-09-05: an artifact is only what a step's
 * CONTRACT declares as output, never everything a session touched. So the whole
 * of this module's input is a schema and a report — the `output` document of
 * the node the job stands on, and the object `parse-node-result.ts` decoded out
 * of the session's closing block — and what it decides is which of the report's
 * own properties name a file that has to leave the worktree before the worktree
 * stops existing.
 *
 * Same harness discipline as `report.test.ts`: the function takes its `fetch`
 * as a parameter, so a fake that records what it was handed is the whole rig —
 * no server, no engine, no database. The FILESYSTEM is real, and deliberately
 * so: three of the eight cases below are about a path, and a fake `statSync`
 * would be a test of the fake.
 *
 * English per D18; this file is post-decision code.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as UploadModule from '../../src/dispatch/upload-artifacts.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/upload-artifacts.ts';

let cache: typeof UploadModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadUpload(): Promise<typeof UploadModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/upload-artifacts.ts', import.meta.url).href
  )) as typeof UploadModule;
  return cache;
}

/** One request the fake `fetch` was handed, flattened for assertions. */
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as the bytes it actually was — this route sends raw, not JSON. */
  body: Uint8Array;
}

/**
 * A `fetch` that records every request and answers each one with an id.
 *
 * The ids are handed out in order (`artifact-1`, `artifact-2`, …) rather than
 * fixed, because two of the cases below upload two files and the whole point of
 * the rewrite is that each property gets ITS own id.
 */
function recorder(status = 201): { sent: Sent[]; doFetch: typeof fetch } {
  const sent: Sent[] = [];
  const doFetch: typeof fetch = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers)) headers[name] = value;
    sent.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body as Uint8Array,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ id: `artifact-${String(sent.length)}` }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { sent, doFetch };
}

/** A `fetch` that records nothing and fails the test if it is ever called. */
function forbidden(): typeof fetch {
  return () => {
    assert.fail('no HTTP request may be made for a declaration that never passed its checks');
  };
}

/** A worktree of this test, with the files it is asked for already written. */
function worktree(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cartografo-t423-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
  return dir;
}

/** An `output` document declaring the named properties as artifacts. */
function schemaWithArtifacts(...keys: string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    nota: { type: 'string', minLength: 1 },
  };
  for (const key of keys) properties[key] = { type: 'string', 'x-artifact': true };
  return { type: 'object', properties };
}

/** The options every case passes, with the `fetch` of that case wired in. */
function options(doFetch: typeof fetch): UploadModule.UploadArtifactsOptions {
  return { urlBase: 'https://control.plane', token: 'token-abc', doFetch };
}

test('t423 AT — a declared artifact inside the worktree is uploaded, rewritten and removed', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'the crossing produced this' });
  const { sent, doFetch } = recorder();

  const result = await uploadArtifacts(options(doFetch), 77, dir, schemaWithArtifacts('relatorio'), {
    nota: 'done',
    relatorio: 'report.md',
  });

  assert.equal(sent.length, 1, 'one declared artifact is one upload');
  assert.equal(sent[0].url, 'https://control.plane/v1/sessions/77/artifacts');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].headers['content-type'], 'application/octet-stream');
  assert.equal(
    sent[0].headers['x-artifact-name'],
    'relatorio',
    "the name is the CONTRACT's own property key, not the file's basename",
  );
  assert.equal(sent[0].headers.authorization, 'Bearer token-abc');
  assert.equal(
    Buffer.from(sent[0].body).toString('utf8'),
    'the crossing produced this',
    'the bytes go up raw: this route is not a JSON envelope',
  );

  assert.deepEqual(
    result.output,
    { nota: 'done', relatorio: 'artifact-1' },
    'the report carries the id the store answered, never the local path',
  );
  assert.equal(result.problems, undefined);
  assert.ok(
    !existsSync(path.join(dir, 'report.md')),
    'an uploaded artifact leaves the worktree, or every session that produces one trips ' +
      'the uncommitted-work guard',
  );
});

test('t423 AT — a path that escapes the worktree is refused without touching the network', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  for (const escape of ['../../etc/passwd', path.join(tmpdir(), 'somewhere-else.md')]) {
    const result = await uploadArtifacts(
      options(forbidden()),
      77,
      dir,
      schemaWithArtifacts('relatorio'),
      { nota: 'done', relatorio: escape },
    );

    assert.equal(result.output, undefined, 'a refused report is not handed back rewritten');
    assert.equal(result.problems?.length, 1, `one problem for one bad key, for: ${escape}`);
    const problem = result.problems?.[0] ?? '';
    assert.ok(problem.includes('relatorio'), `the property has to be named: ${problem}`);
    assert.ok(problem.includes(escape), `and the path it named: ${problem}`);
  }
});

test('t423 AT — a declared artifact that was never written is refused, and nothing is sent', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  const result = await uploadArtifacts(
    options(forbidden()),
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    { nota: 'done', relatorio: 'never-written.md' },
  );

  assert.equal(result.output, undefined);
  assert.equal(result.problems?.length, 1);
  const problem = result.problems?.[0] ?? '';
  assert.ok(problem.includes('relatorio'), `the property has to be named: ${problem}`);
  assert.ok(problem.includes('never-written.md'), `and the file it named: ${problem}`);
});

test('t423 AT — a directory is not a regular file, and is refused the same way', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'sub/inside.md': 'not the thing that was declared' });

  const result = await uploadArtifacts(
    options(forbidden()),
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    { nota: 'done', relatorio: 'sub' },
  );

  assert.equal(result.output, undefined);
  assert.equal(result.problems?.length, 1);
  assert.ok(
    (result.problems?.[0] ?? '').includes('relatorio'),
    `the property has to be named: ${String(result.problems?.[0])}`,
  );
});

test('t423 AT — a declared artifact reported as a number is refused', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  const result = await uploadArtifacts(
    options(forbidden()),
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    { nota: 'done', relatorio: 42 },
  );

  assert.equal(result.output, undefined);
  assert.equal(result.problems?.length, 1);
  assert.ok(
    (result.problems?.[0] ?? '').includes('relatorio'),
    `the property has to be named: ${String(result.problems?.[0])}`,
  );
});

test('t423 AT — an output schema declaring no artifact leaves the report exactly as it came', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'nobody declared this' });
  const report = { nota: 'done', relatorio: 'report.md' };

  const result = await uploadArtifacts(options(forbidden()), 77, dir, {
    type: 'object',
    properties: { nota: { type: 'string' }, relatorio: { type: 'string' } },
  }, report);

  assert.equal(result.problems, undefined);
  assert.deepEqual(result.output, { nota: 'done', relatorio: 'report.md' });
  assert.ok(
    existsSync(path.join(dir, 'report.md')),
    'a file nobody declared is not this module\'s to move or to delete',
  );
});

test('t423 AT — a schema that is not a schema declares no artifact at all', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  for (const schema of [undefined, null, 'not an object', { type: 'object' }, { properties: 7 }]) {
    const result = await uploadArtifacts(options(forbidden()), 77, dir, schema, { nota: 'done' });
    assert.equal(result.problems, undefined, `tolerated as declaring none: ${String(schema)}`);
    assert.deepEqual(result.output, { nota: 'done' });
  }
});

test('t423 AT — a declared artifact simply absent from the report is not a problem', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  const result = await uploadArtifacts(
    options(forbidden()),
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    { nota: 'done' },
  );

  assert.equal(result.problems, undefined, 'an optional artifact this run did not produce');
  assert.deepEqual(result.output, { nota: 'done' }, 'and the rest of the report passes through');
});

test('t423 AT — a report with no structured content at all passes through untouched', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, {});

  const result = await uploadArtifacts(
    options(forbidden()),
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    undefined,
  );

  assert.equal(result.problems, undefined);
  assert.equal(result.output, undefined, 'nothing was reported, and nothing is invented');
});

test('t423 AT — two declared artifacts are uploaded and rewritten independently', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'the first', 'evidence/log.txt': 'the second' });
  const { sent, doFetch } = recorder();

  const result = await uploadArtifacts(
    options(doFetch),
    77,
    dir,
    schemaWithArtifacts('relatorio', 'evidencia'),
    { nota: 'done', relatorio: 'report.md', evidencia: 'evidence/log.txt' },
  );

  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent.map((call) => call.headers['x-artifact-name']).sort(),
    ['evidencia', 'relatorio'],
    'one upload per declared property, each named by its own key',
  );
  assert.equal(result.problems, undefined);

  const output = result.output ?? {};
  assert.equal(output.nota, 'done');
  assert.notEqual(output.relatorio, 'report.md');
  assert.notEqual(output.evidencia, 'evidence/log.txt');
  assert.notEqual(output.relatorio, output.evidencia, 'two files are two ids');
  assert.ok(!existsSync(path.join(dir, 'report.md')));
  assert.ok(!existsSync(path.join(dir, 'evidence', 'log.txt')));
});

test('t423 AT — one bad declaration refuses the report, and the good upload is NOT rolled back', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'the one that was really written' });
  const { sent, doFetch } = recorder();

  const result = await uploadArtifacts(
    options(doFetch),
    77,
    dir,
    schemaWithArtifacts('relatorio', 'evidencia'),
    { nota: 'done', relatorio: 'report.md', evidencia: 'never-written.txt' },
  );

  assert.equal(sent.length, 1, 'the valid one still goes up');
  assert.ok(
    !existsSync(path.join(dir, 'report.md')),
    'and is still removed: the store is content-addressed, so a stray upload is harmless',
  );

  assert.equal(result.output, undefined, 'the WHOLE report is refused, for the other problem');
  assert.equal(result.problems?.length, 1, 'one problem, for the one key that had one');
  const problem = result.problems?.[0] ?? '';
  assert.ok(problem.includes('evidencia'), `the failing property: ${problem}`);
  assert.ok(problem.includes('never-written.txt'), `and the file it named: ${problem}`);
  assert.ok(!problem.includes('relatorio'), `and nothing about the one that worked: ${problem}`);
});

test('t423 AT — an upload the store refused throws, and is not one of the two refusals', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'too big for whatever cap is set' });
  const { doFetch } = recorder(413);

  await assert.rejects(
    async () =>
      await uploadArtifacts(options(doFetch), 77, dir, schemaWithArtifacts('relatorio'), {
        nota: 'done',
        relatorio: 'report.md',
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        error.message.includes('413'),
        `the status is what tells a cap from an outage: ${error.message}`,
      );
      return true;
    },
    'a store that refused the bytes is an ordinary dispatch failure, never a silent drop',
  );
});

test('t423 AT — with no token configured, no Authorization header goes out at all', async (t) => {
  const { uploadArtifacts } = await loadUpload();
  const dir = worktree(t, { 'report.md': 'anonymous' });
  const { sent, doFetch } = recorder();

  await uploadArtifacts(
    { urlBase: 'https://control.plane', doFetch },
    77,
    dir,
    schemaWithArtifacts('relatorio'),
    { nota: 'done', relatorio: 'report.md' },
  );

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0].headers.authorization,
    undefined,
    'an empty credential would look like a credential (t124/t147)',
  );
});
