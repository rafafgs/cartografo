/**
 * The failure branches of `cartografo export`, in process (t212).
 *
 * `cli-import-export.test.ts` walks the round trip against a real control plane
 * and proves the thing that matters most about this command: what comes out
 * reimports to the SAME `graph_version.id`. What it cannot walk is what happens
 * when the control plane answers something OTHER than a healthy 200 — an
 * unknown class, a lineage with no current version, a version that comes back
 * without a snapshot — because producing those against a real server means
 * breaking it on purpose. That is why `export.ts` sat at 33 % of branches while
 * its lines read 87 %.
 *
 * Here the control plane is scripted, so each of those answers is one line of
 * fixture. The rule the file keeps is that a bad answer is always a MESSAGE and
 * an exit code, never a stack trace and never a half-written file: `export`
 * exists so the data can leave, and a file that exists but is wrong is worse
 * than no file at all.
 *
 * English per D18; since t226 so are the wire codes it prints (`unknown_graph`,
 * `unknown_graph_version`) and the field names it reads — the API child of D20.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runExport } from '../src/cli/export.ts';
import { UsageError } from '../src/cli/url.ts';
import { temporaryArea } from './cli-support.ts';
import { capture, startFakeControlPlane, type FakeAnswer } from './cli-unit-support.ts';

/** A graph document, in the only shape this command cares about: opaque. */
const SNAPSHOT = {
  problem_class: 'desenvolvimento-de-software',
  nodes: [{ id: 'refinar' }],
  edges: [],
};

const VERSION_ID = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * The healthy pair of answers: the lineage, then the version.
 *
 * Each test overrides one of the two and leaves the other alone, which is what
 * keeps every fixture below a statement about a single failure.
 */
function healthy(overrides: { lineage?: FakeAnswer; version?: FakeAnswer } = {}) {
  return (request: { path: string }): FakeAnswer => {
    if (request.path.startsWith('/v1/graph-versions/')) {
      return overrides.version ?? { status: 200, body: { graph_version: { snapshot: SNAPSHOT } } };
    }
    return (
      overrides.lineage ?? { status: 200, body: { graph: { current_version_id: VERSION_ID } } }
    );
  };
}

test('a class that is only whitespace never becomes a request', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());

  await assert.rejects(
    capture(() => runExport({ className: '   ', url: plane.url })),
    UsageError,
  );
  assert.deepEqual(plane.requests, [], 'a wrong command line costs the server nothing');
});

test('a class the control plane does not know comes back as unknown_graph', async (t) => {
  const plane = await startFakeControlPlane(t, healthy({ lineage: { status: 404 } }));
  const area = temporaryArea(t, 'cartografo-t212-export-');
  const output = path.join(area, 'saida.json');

  const run = await capture(() =>
    runExport({ className: 'classe-que-nao-existe', url: plane.url, output }),
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown_graph/);
  assert.match(run.stderr, /classe-que-nao-existe/);
  assert.equal(existsSync(output), false, 'a failed export writes no file');
});

test('any other status on the lineage is reported with its number', async (t) => {
  const plane = await startFakeControlPlane(t, healthy({ lineage: { status: 503 } }));

  const run = await capture(() => runExport({ className: 'desenvolvimento', url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /HTTP 503/);
  assert.equal(
    plane.requests.length,
    1,
    'the version is never asked for once the lineage failed',
  );
});

test('a lineage with no current version is refused, in each of its shapes', async (t) => {
  const shapes: FakeAnswer[] = [
    { status: 200, body: { graph: {} } },
    { status: 200, body: { graph: { current_version_id: '' } } },
    { status: 200, body: { graph: { current_version_id: 42 } } },
    { status: 200, body: { graph: 'nem objeto' } },
    { status: 200, body: {} },
    { status: 200, body: ['nem objeto'] },
    { status: 200, text: 'not json at all' },
  ];

  for (const lineage of shapes) {
    const plane = await startFakeControlPlane(t, healthy({ lineage }));
    const run = await capture(() => runExport({ className: 'desenvolvimento', url: plane.url }));

    assert.equal(run.code, 1, `shape refused: ${JSON.stringify(lineage)}`);
    assert.match(run.stderr, /has no current version to export/);
  }
});

test('a version the control plane cannot serve is unknown_graph_version', async (t) => {
  const plane = await startFakeControlPlane(t, healthy({ version: { status: 404 } }));

  const run = await capture(() => runExport({ className: 'desenvolvimento', url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /unknown_graph_version/);
  assert.match(run.stderr, new RegExp(VERSION_ID.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a version that comes back without a snapshot is refused, in each of its shapes', async (t) => {
  const shapes: FakeAnswer[] = [
    { status: 200, body: { graph_version: {} } },
    { status: 200, body: { graph_version: 'nem objeto' } },
    { status: 200, body: {} },
    { status: 200, text: 'not json at all' },
  ];

  for (const version of shapes) {
    const plane = await startFakeControlPlane(t, healthy({ version }));
    const run = await capture(() => runExport({ className: 'desenvolvimento', url: plane.url }));

    assert.equal(run.code, 1, `shape refused: ${JSON.stringify(version)}`);
    assert.match(run.stderr, /came back without a snapshot/);
  }
});

test('the export writes the snapshot and nothing around it', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());
  const area = temporaryArea(t, 'cartografo-t212-export-');
  // A directory that does not exist yet: the command owes the path it was given.
  const output = path.join(area, 'pasta', 'nova', 'desenvolvimento.grafo.json');

  const run = await capture(() =>
    runExport({ className: 'desenvolvimento', url: plane.url, output }),
  );

  assert.equal(run.code, 0);
  assert.equal(
    readFileSync(output, 'utf8'),
    `${JSON.stringify(SNAPSHOT, null, 2)}\n`,
    'no envelope: what comes out is what import accepts back',
  );
  assert.match(run.stdout, /graph exported/);
  assert.match(run.stdout, /graph_version\.id\s+sha256:/);
  assert.match(run.stdout, new RegExp(output.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(
    plane.requests.map((request) => request.path),
    ['/v1/graphs/desenvolvimento', `/v1/graph-versions/${encodeURIComponent(VERSION_ID)}`],
    'the class and the version id travel encoded',
  );
});

test('without --out the file is named after the class, where the command was run', async (t) => {
  const plane = await startFakeControlPlane(t, healthy());
  const area = temporaryArea(t, 'cartografo-t212-export-');

  const previous = process.cwd();
  process.chdir(area);
  t.after(() => process.chdir(previous));

  const run = await capture(() => runExport({ className: 'desenvolvimento', url: plane.url }));

  assert.equal(run.code, 0);
  assert.equal(existsSync(path.join(area, 'desenvolvimento.grafo.json')), true);
});
