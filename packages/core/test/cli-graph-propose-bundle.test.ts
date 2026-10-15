/**
 * Acceptance tests of `cartografo graph propose <bundle dir>` (t741): the upgrade
 * route for an installation whose class is already registered.
 *
 * `import` refuses an existing class, so a factory version that moved a
 * `skill_ref` pin could not be installed by re-importing. The directory form of
 * `graph propose` checks the bundle locally, registers its manifests
 * (idempotently) and then proposes the new graph version the way it does for a
 * file.
 *
 * Two postures, as in `cli-graph.test.ts` and `cli-import-unit.test.ts`: the
 * real binary against a real control plane when the assertion is about real
 * state, and `runGraph` against a scripted control plane when it is about which
 * requests were sent.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runGraph } from '../src/cli/graph.ts';
import { UsageError } from '../src/cli/url.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import {
  FACTORY_BUNDLE,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
  type TestHook,
} from './cli-support.ts';
import {
  capture,
  startFakeControlPlane,
  type Captured,
  type FakeAnswer,
  type RecordedRequest,
} from './cli-unit-support.ts';

const CLASS = 'software-development';

type Json = Record<string, unknown>;

/* --------------------------------------------------------------- fixtures */

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function manifestCount(directory: string): number {
  return readdirSync(path.join(directory, 'skills')).filter((name) => name.endsWith('.json')).length;
}

/** A writable copy of the factory bundle. */
function bundleCopy(t: TestHook, label = 'bundle'): string {
  const area = temporaryArea(t, 'cartografo-t741-');
  const directory = path.join(area, label);
  cpSync(FACTORY_BUNDLE, directory, { recursive: true });
  return directory;
}

/**
 * A factory update: one skill gets new instructions, a new version and a
 * recomputed hash, and the graph's pin follows it.
 */
function bumpSkill(directory: string, id = 'refine-ticket'): void {
  const file = path.join(directory, 'skills', `${id}.json`);
  const manifest = readJson(file);
  const [major, minor, patch] = String(manifest.version).split('.').map(Number);
  manifest.version = `${major}.${minor}.${patch + 1}`;
  manifest.instructions = `${String(manifest.instructions)}\n\nA line added by a newer factory version.`;
  manifest.hash = manifestHash(manifest);
  writeJson(file, manifest);

  const graphFile = path.join(directory, 'graph.json');
  const graph = readJson(graphFile);
  for (const node of graph.nodes as Json[]) {
    const pin = node.skill_ref as Json | undefined;
    if (pin !== undefined && pin.id === id) {
      pin.version = manifest.version;
      pin.hash = manifest.hash;
    }
  }
  writeJson(graphFile, graph);
}

/** A description edit: a change that needs no manifest at all. */
function editDescription(directory: string, text = 'Edited by the test.'): void {
  const graphFile = path.join(directory, 'graph.json');
  const graph = readJson(graphFile);
  (graph.nodes as Json[])[0].description = text;
  writeJson(graphFile, graph);
}

/* ---------------------------------------------------------- scripted plane */

const SNAPSHOT_VERSION = 'sha256:' + '0'.repeat(64);

/**
 * A control plane holding the factory graph as the lineage's current version,
 * accepting every manifest and every proposal call.
 */
function lineagePlane(
  snapshot: unknown = readJson(path.join(FACTORY_BUNDLE, 'graph.json')),
  skills: (request: RecordedRequest) => FakeAnswer = (request) => ({ status: 201, body: request.body }),
): (request: RecordedRequest) => FakeAnswer {
  return (request) => {
    if (request.route === '/v1/skills') return skills(request);
    if (request.route === `/v1/graphs/${CLASS}`) {
      return { status: 200, body: { graph: { id: CLASS, current_version_id: SNAPSHOT_VERSION } } };
    }
    if (request.route.startsWith('/v1/graph-versions/')) {
      return { status: 200, body: { graph_version: { id: SNAPSHOT_VERSION, graph_id: CLASS, snapshot } } };
    }
    if (request.route === '/v1/proposals') return { status: 201, body: { proposal: { id: 7 } } };
    if (/^\/v1\/proposals\/7\/(approve|apply)$/.test(request.route)) return { status: 200, body: { ok: true } };
    return { status: 404, body: { error: 'not_found' } };
  };
}

function propose(plane: { url: string }, args: string[]): Promise<Captured> {
  return capture(() => runGraph('propose', [...args, '--by', 't', '--evidence', 'e'], { url: plane.url, projectId: 1 }));
}

function posts(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.method !== 'GET');
}

/* -------------------------------------------------------- real plane helpers */

async function importedPlane(
  t: TestHook,
  directory: string,
): Promise<{ plane: RunningControlPlane; databasePath: string }> {
  const databasePath = path.join(temporaryArea(t, 'cartografo-t741-db-'), 'cartografo.db');
  const plane = await startControlPlane(t, { databasePath });
  const imported = await runCli(['import', directory, '--url', plane.url], { token: plane.token });
  assert.equal(imported.code, 0, `import failed:\n${imported.stderr}`);
  return { plane, databasePath };
}

async function proposeCli(
  plane: RunningControlPlane,
  directory: string,
  extra: string[] = [],
): ReturnType<typeof runCli> {
  return await runCli(
    ['graph', 'propose', directory, '--by', 't', '--evidence', 'e', ...extra, '--url', plane.url],
    { token: plane.token },
  );
}

async function getJson<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

interface VersionRow {
  id: string;
  parent_version: string | null;
}

async function versions(plane: RunningControlPlane): Promise<VersionRow[]> {
  return (await getJson<{ versions: VersionRow[] }>(plane, `/v1/graphs/${CLASS}/versions?project_id=1`)).versions;
}

async function proposalsOf(plane: RunningControlPlane): Promise<{ id: number; status: string }[]> {
  const body = await getJson<{ proposals: { id: number; status: string; graph_id: string }[] }>(
    plane,
    '/v1/proposals?project_id=1',
  );
  return body.proposals.filter((proposal) => proposal.graph_id === CLASS);
}

/* ------------------------------------------------------------------- tests */

test('AT1 — an upgraded bundle registers its new manifest and applies the new graph version', { timeout: 180_000 }, async (t) => {
  const directory = bundleCopy(t);
  const { plane } = await importedPlane(t, directory);
  const before = await versions(plane);
  assert.equal(before.length, 1);

  bumpSkill(directory);
  const result = await proposeCli(plane, directory);

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(
    result.stdout,
    new RegExp(`skills\\s+1 registered, ${manifestCount(directory) - 1} already in the registry`),
  );
  assert.match(result.stdout, /proposal #\d+ applied/);

  const after = await versions(plane);
  assert.equal(after.length, 2);
  assert.equal(after[1].parent_version, after[0].id);
  const proposals = await proposalsOf(plane);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].status, 'applied');

  await t.test('AT2 — the same command again changes nothing and says so', async () => {
    const again = await proposeCli(plane, directory);

    assert.equal(again.code, 0, `stdout:\n${again.stdout}\nstderr:\n${again.stderr}`);
    assert.match(again.stdout, /no change to propose/);
    assert.match(again.stdout, new RegExp(`skills\\s+0 registered, ${manifestCount(directory)} already in the registry`));
    assert.equal((await proposalsOf(plane)).length, 1, 'no second proposal');
    assert.equal((await versions(plane)).length, 2);
  });
});

test('AT3 — an unchanged graph still registers a manifest the registry lacks', { timeout: 180_000 }, async (t) => {
  // The registry holds every manifest of the bumped bundle but one, and the
  // lineage already sits at the bumped graph: the only thing missing is a
  // manifest, which is exactly the state an operator is left in by a refused
  // `import` that stopped half way.
  const directory = bundleCopy(t);
  bumpSkill(directory);
  const databasePath = path.join(temporaryArea(t, 'cartografo-t741-db-'), 'cartografo.db');
  const plane = await startControlPlane(t, { databasePath });

  const skillsDir = path.join(directory, 'skills');
  for (const name of readdirSync(skillsDir).filter((file) => file.endsWith('.json'))) {
    if (name === 'refine-ticket.json') continue;
    const response = await fetch(`${plane.url}/v1/skills?project_id=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(readJson(path.join(skillsDir, name))),
    });
    assert.ok(response.status === 201 || response.status === 200, `seeding ${name}: ${response.status}`);
  }
  const graph = await fetch(`${plane.url}/v1/graphs?project_id=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(readJson(path.join(directory, 'graph.json'))),
  });
  assert.equal(graph.status, 201, await graph.text());

  const result = await proposeCli(plane, directory);

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /skills\s+1 registered, \d+ already in the registry/);
  assert.match(result.stdout, /no change to propose/);
  assert.equal((await proposalsOf(plane)).length, 0);
});

test('AT4 — a broken pin is refused locally and nothing is sent', async (t) => {
  const directory = bundleCopy(t);
  rmSync(path.join(directory, 'skills', 'refine-ticket.json'));
  const plane = await startFakeControlPlane(t, lineagePlane());

  const run = await propose(plane, [directory]);

  assert.equal(run.code, 1);
  assert.match(run.stderr, /invalid bundle/);
  assert.match(run.stderr, /pin\s+node "refine"/);
  assert.match(run.stderr.trimEnd(), /nothing was sent to the control plane$/);
  assert.deepEqual(plane.requests, []);
});

test('AT5 — a manifest the registry refuses stops the command before any proposal', async (t) => {
  const directory = bundleCopy(t);
  bumpSkill(directory);
  const plane = await startFakeControlPlane(
    t,
    lineagePlane(undefined, () => ({
      status: 409,
      body: { error: 'skill_version_conflict', details: ['already names different content; bump the version'] },
    })),
  );

  const run = await propose(plane, [directory]);

  assert.equal(run.code, 1);
  assert.match(run.stderr, /the registry refused a skill \(HTTP 409\) — [a-z-]+/);
  assert.match(run.stderr, /skill_version_conflict/);
  assert.match(run.stderr, /bump the version/);
  assert.match(run.stderr.trimEnd(), /cartografo: no proposal was created$/);
  assert.doesNotMatch(run.stderr, /the graph was not sent/);
  assert.equal(
    plane.requests.some((request) => request.route === '/v1/proposals'),
    false,
  );
});

test('AT6 — a frozen-field refusal comes before any manifest is registered', async (t) => {
  // The first node moves to the end of the array: every id shifts by position.
  const directory = bundleCopy(t);
  const graphFile = path.join(directory, 'graph.json');
  const graph = readJson(graphFile);
  const nodes = graph.nodes as Json[];
  graph.nodes = [...nodes.slice(1), nodes[0]];
  writeJson(graphFile, graph);
  const plane = await startFakeControlPlane(t, lineagePlane());

  const run = await propose(plane, [directory]);

  assert.equal(run.code, 1);
  assert.match(run.stderr, /appears to have been renamed from/);
  assert.match(run.stderr.trimEnd(), /nothing was sent to the control plane$/);
  assert.deepEqual(
    plane.requests.filter((request) => request.route === '/v1/skills'),
    [],
  );
  assert.deepEqual(posts(plane.requests), []);
});

test('AT7 — --dry-run with a directory sends no POST and prints no skills line', async (t) => {
  await t.test('an edit that applies and passes the gate exits 0', async (inner) => {
    const directory = bundleCopy(inner);
    editDescription(directory);
    const plane = await startFakeControlPlane(inner, lineagePlane());

    const run = await propose(plane, [directory, '--dry-run']);

    assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
    assert.match(run.stdout, /dry run: the edit applies and passes the soundness gate/);
    assert.doesNotMatch(run.stdout, /skills/);
    assert.deepEqual(posts(plane.requests), []);
    assert.ok(plane.requests.length > 0, 'the lineage is still read');
  });

  await t.test('an unsound edit exits 1 with invalid_graph', async (inner) => {
    // The diff carries only nodes and edges, so an edit to `initial_node` is
    // invisible to it. The lineage here starts at another node: the bundle is
    // sound on its own, the edit applied to the lineage is not.
    const directory = bundleCopy(inner);
    editDescription(directory);
    const snapshot = readJson(path.join(FACTORY_BUNDLE, 'graph.json'));
    snapshot.initial_node = 'develop';
    const plane = await startFakeControlPlane(inner, lineagePlane(snapshot));

    const run = await propose(plane, [directory, '--dry-run']);

    assert.equal(run.code, 1, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
    assert.match(run.stderr, /invalid_graph/);
    assert.doesNotMatch(run.stdout, /skills/);
    assert.deepEqual(posts(plane.requests), []);
  });
});

test('AT8 — --no-apply with a directory registers the manifests and leaves the proposal pending', { timeout: 180_000 }, async (t) => {
  const directory = bundleCopy(t);
  const { plane } = await importedPlane(t, directory);
  const [first] = await versions(plane);
  bumpSkill(directory);

  const result = await proposeCli(plane, directory, ['--no-apply']);

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /skills\s+1 registered, \d+ already in the registry/);
  assert.match(result.stdout, /proposal #\d+ created, pending/);
  const after = await versions(plane);
  assert.deepEqual(after.map((row) => row.id), [first.id], 'the lineage is still at the old version');
  assert.equal((await proposalsOf(plane))[0].status, 'pending');
});

test('AT9 — --json with a directory keeps stdout to JSON bodies, one per line', async (t) => {
  const directory = bundleCopy(t);
  editDescription(directory);
  const plane = await startFakeControlPlane(t, lineagePlane());

  const run = await propose(plane, [directory, '--json']);

  assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
  const lines = run.stdout.split('\n').filter((text) => text !== '');
  assert.equal(lines.length, 3, 'created, approved, applied');
  for (const text of lines) JSON.parse(text);
  assert.doesNotMatch(run.stdout, /skills/);
  assert.ok(
    plane.requests.some((request) => request.route === '/v1/skills'),
    'the manifests are still registered',
  );
});

test('AT10 — a plain file registers nothing and prints no skills line', async (t) => {
  const directory = bundleCopy(t);
  editDescription(directory);
  const plane = await startFakeControlPlane(t, lineagePlane());

  const run = await propose(plane, [path.join(directory, 'graph.json')]);

  assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
  assert.match(run.stdout, /proposal #7 applied/);
  assert.doesNotMatch(run.stdout, /skills/);
  assert.equal(
    plane.requests.some((request) => request.route === '/v1/skills'),
    false,
  );
});

test('AT11 — a directory without skills/ is read like a file; one without graph.json is a usage error', async (t) => {
  await t.test('no skills/: proposes from graph.json, no /v1/skills request', async (inner) => {
    const directory = bundleCopy(inner);
    rmSync(path.join(directory, 'skills'), { recursive: true });
    editDescription(directory);
    const plane = await startFakeControlPlane(inner, lineagePlane());

    const run = await propose(plane, [directory]);

    assert.equal(run.code, 0, `stderr:\n${run.stderr}`);
    assert.match(run.stdout, /proposal #7 applied/);
    assert.doesNotMatch(run.stdout, /skills/);
    assert.equal(
      plane.requests.some((request) => request.route === '/v1/skills'),
      false,
    );
  });

  await t.test('no graph.json: exit 2 territory, "could not read"', async (inner) => {
    const empty = path.join(temporaryArea(inner, 'cartografo-t741-empty-'), 'bundle');
    mkdirSync(empty);
    const plane = await startFakeControlPlane(inner, lineagePlane());

    await assert.rejects(
      () => runGraph('propose', [empty, '--by', 't'], { url: plane.url, projectId: 1 }),
      (error: unknown) => error instanceof UsageError && /could not read/.test(error.message),
    );
    assert.deepEqual(plane.requests, []);
  });

  await t.test('through the binary the usage error exits 2', async (inner) => {
    const empty = path.join(temporaryArea(inner, 'cartografo-t741-empty-'), 'bundle');
    mkdirSync(empty);

    const result = await runCli(['graph', 'propose', empty, '--by', 't', '--url', 'http://127.0.0.1:9']);

    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /could not read/);
  });
});
