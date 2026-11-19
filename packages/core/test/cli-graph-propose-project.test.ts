/**
 * Acceptance tests of `--project` on the two CLI paths that decide a proposal
 * (t1331, #5): `graph propose --by` and `proposals approve|apply|reject|revert`.
 *
 * `graph propose` created its proposal through `scoped()`, so it landed in the
 * project the operator named, and then posted approve/apply to a URL with no
 * scope at all — which is project 1, where that proposal does not exist. The
 * `proposals` decisions had the same omission while `show` and `list` already
 * forwarded the project.
 *
 * A real control plane child and the real binary, the posture of
 * `cli-graph-propose-bundle.test.ts` and `cli-project-flag.test.ts`.
 */

import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { GraphDocument } from '../src/domain/graph.ts';
import type { Operation } from '../src/domain/operations.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import {
  FACTORY_BUNDLE,
  REPO_ROOT,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
  type TestHook,
} from './cli-support.ts';

const CLASS = 'software-development';
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

type Json = Record<string, unknown>;

/* --------------------------------------------------------------- fixtures */

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** A writable copy of a bundle directory. */
function bundleCopy(t: TestHook, from: string, label: string): string {
  const directory = path.join(temporaryArea(t, 'cartografo-t1331-'), label);
  cpSync(from, directory, { recursive: true });
  return directory;
}

/** A factory update: one skill gets a new version, and the graph's pin follows it. */
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

async function declareProject(plane: RunningControlPlane, name: string): Promise<number> {
  const response = await fetch(`${plane.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json()) as { id: number };
  assert.equal(response.status, 201, `POST /v1/projects returned ${response.status}`);
  return body.id;
}

async function importInto(
  plane: RunningControlPlane,
  directory: string,
  projectId: number,
): Promise<void> {
  const imported = await runCli(
    ['import', directory, '--project', String(projectId), '--url', plane.url],
    { token: plane.token },
  );
  assert.equal(imported.code, 0, `import into ${projectId} failed:\n${imported.stderr}`);
}

async function proposeInto(
  plane: RunningControlPlane,
  directory: string,
  projectId: number,
): ReturnType<typeof runCli> {
  return await runCli(
    [
      'graph',
      'propose',
      directory,
      '--by',
      'tester',
      '--evidence',
      'x',
      '--project',
      String(projectId),
      '--url',
      plane.url,
    ],
    { token: plane.token },
  );
}

async function getJson<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function currentVersion(
  plane: RunningControlPlane,
  projectId: number,
  graphId = CLASS,
): Promise<string | null> {
  const body = await getJson<{ graph: { current_version_id: string | null } }>(
    plane,
    `/v1/graphs/${graphId}?project_id=${projectId}`,
  );
  return body.graph.current_version_id;
}

/* ------------------------------------------------------------ graph propose */

test('AT9 — graph propose --by --project 2 applies in project 2 and leaves project 1 alone', {
  timeout: 240_000,
}, async (t) => {
  const first = bundleCopy(t, FACTORY_BUNDLE, 'one');
  const second = bundleCopy(t, FACTORY_BUNDLE, 'two');
  bumpSkill(second);
  const upgrade = bundleCopy(t, second, 'upgrade');
  bumpSkill(upgrade);

  const plane = await startControlPlane(t, {
    databasePath: path.join(temporaryArea(t, 'cartografo-t1331-db-'), 'cartografo.db'),
  });
  assert.equal(await declareProject(plane, 'second'), 2);
  await importInto(plane, first, 1);
  await importInto(plane, second, 2);

  const baseOne = await currentVersion(plane, 1);
  const baseTwo = await currentVersion(plane, 2);
  assert.notEqual(baseTwo, baseOne, 'the two projects hold the graph at different versions');

  const result = await proposeInto(plane, upgrade, 2);

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown_proposal|stale_proposal|was not applied/);
  const movedTwo = await currentVersion(plane, 2);
  assert.notEqual(movedTwo, baseTwo, 'project 2’s graph moved');
  assert.match(result.stdout, new RegExp(`proposal #\\d+ applied — ${CLASS} is now at ${movedTwo}`));
  assert.equal(await currentVersion(plane, 1), baseOne, 'project 1’s graph did not');
});

test('AT10 — graph propose --by --project 2 works for a graph only project 2 holds', {
  timeout: 240_000,
}, async (t) => {
  const installed = bundleCopy(t, FACTORY_BUNDLE, 'installed');
  const upgrade = bundleCopy(t, FACTORY_BUNDLE, 'upgrade');
  bumpSkill(upgrade);

  const plane = await startControlPlane(t, {
    databasePath: path.join(temporaryArea(t, 'cartografo-t1331-db-'), 'cartografo.db'),
  });
  assert.equal(await declareProject(plane, 'second'), 2);
  await importInto(plane, installed, 2);
  const missing = await fetch(`${plane.url}/v1/graphs/${CLASS}?project_id=1`, {
    headers: { authorization: `Bearer ${plane.token}` },
  });
  assert.equal(missing.status, 404, 'project 1 holds no such graph');
  const before = await currentVersion(plane, 2);

  const result = await proposeInto(plane, upgrade, 2);

  assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /unknown_proposal|unknown_graph/);
  assert.notEqual(await currentVersion(plane, 2), before);
});

/* --------------------------------------------------------------- proposals */

interface Proposal {
  id: number;
  status: string;
}

async function createInProject(
  plane: RunningControlPlane,
  projectId: number,
  graphId: string,
  target: string,
  operations: Operation[],
  note: string,
): Promise<Proposal> {
  const response = await fetch(`${plane.url}/v1/proposals?project_id=${projectId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
    body: JSON.stringify({
      graph_id: graphId,
      target_version: target,
      operations,
      evidence: { fonte: 'surveyor', observacao: note },
      expected_metric: { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 },
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { proposal: Proposal }).proposal;
}

function addNodeOperations(nodeId: string): Operation[] {
  const node = {
    id: nodeId,
    role: 'reviewer',
    node_type: 'work',
    description: 'Checks each claim of the note against the cited source.',
    skill_ref: { id: 'cartografo/check-facts', version: '1.0.0', hash: `sha256:${'0'.repeat(64)}` },
    contract: {
      input_schema: { type: 'object', required: ['texto'], properties: { texto: { type: 'string' } } },
      output_schema: {
        type: 'object',
        required: ['aprovado'],
        properties: { aprovado: { type: 'boolean' } },
      },
      checks: [
        { type: 'deterministic', command: 'test -s check.md', description: 'The report exists.' },
      ],
    },
  };
  return [
    { type: 'add_node', node, inverse: { type: 'remove_node', node_id: nodeId } },
    {
      type: 'add_edge',
      edge: { from: 'redigir', to: nodeId, condition: 'sempre' },
      inverse: { type: 'remove_edge', edge: { from: 'redigir', to: nodeId } },
    },
    {
      type: 'add_edge',
      edge: { from: nodeId, to: 'revisar', condition: 'sempre' },
      inverse: { type: 'remove_edge', edge: { from: nodeId, to: 'revisar' } },
    },
  ] as Operation[];
}

async function statusIn(plane: RunningControlPlane, projectId: number, id: number): Promise<string> {
  const body = await getJson<{ proposal: Proposal }>(
    plane,
    `/v1/proposals/${id}?project_id=${projectId}`,
  );
  return body.proposal.status;
}

test('AT11 — proposals approve, apply, reject and revert carry --project', {
  timeout: 240_000,
}, async (t) => {
  const plane = await startControlPlane(t, {
    databasePath: path.join(temporaryArea(t, 'cartografo-t1331-db-'), 'cartografo.db'),
  });
  assert.equal(await declareProject(plane, 'second'), 2);

  const registered = await fetch(`${plane.url}/v1/graphs?project_id=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${plane.token}` },
    body: JSON.stringify(readJson(MINIMAL_EXAMPLE) as unknown as GraphDocument),
  });
  const registeredBody = (await registered.json()) as {
    graph: { id: string };
    graph_version: { id: string };
  };
  assert.equal(registered.status, 201, JSON.stringify(registeredBody));
  const graphId = registeredBody.graph.id;
  const base = registeredBody.graph_version.id;

  // Two independent proposals over the SAME base, so rejecting one has nothing
  // to do with the other going through approve -> apply -> revert.
  const toApply = await createInProject(plane, 2, graphId, base, addNodeOperations('check_facts'), 'a');
  const toReject = await createInProject(plane, 2, graphId, base, addNodeOperations('check_dates'), 'b');

  const run = (args: string[]): ReturnType<typeof runCli> =>
    runCli(['proposals', ...args, '--url', plane.url], { token: plane.token });

  await t.test('without --project the decisions look in project 1 and find nothing', async () => {
    for (const args of [
      ['approve', String(toApply.id), '--by', 'tester'],
      ['apply', String(toApply.id), '--by', 'tester'],
      ['reject', String(toReject.id), '--by', 'tester', '--reason', 'no'],
      ['revert', String(toApply.id), '--by', 'tester', '--reason', 'no'],
    ]) {
      const refused = await run(args);
      assert.equal(refused.code, 1, `proposals ${args[0]}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stderr, /unknown_proposal/);
    }
    assert.equal(await statusIn(plane, 2, toApply.id), 'pending');
    assert.equal(await statusIn(plane, 2, toReject.id), 'pending');
  });

  await t.test('with --project 2 approve then apply both succeed', async () => {
    const approved = await run(['approve', String(toApply.id), '--by', 'tester', '--project', '2']);
    assert.equal(approved.code, 0, `stderr:\n${approved.stderr}`);
    const applied = await run(['apply', String(toApply.id), '--by', 'tester', '--project', '2']);
    assert.equal(applied.code, 0, `stderr:\n${applied.stderr}`);
    assert.equal(await statusIn(plane, 2, toApply.id), 'applied');
  });

  await t.test('with --project 2 reject succeeds', async () => {
    const rejected = await run([
      'reject',
      String(toReject.id),
      '--by',
      'tester',
      '--reason',
      'not now',
      '--project',
      '2',
    ]);
    assert.equal(rejected.code, 0, `stderr:\n${rejected.stderr}`);
    assert.equal(await statusIn(plane, 2, toReject.id), 'rejected');
  });

  await t.test('with --project 2 revert succeeds and moves the pointer back', async () => {
    const reverted = await run([
      'revert',
      String(toApply.id),
      '--by',
      'tester',
      '--reason',
      'did not help',
      '--project',
      '2',
    ]);
    assert.equal(reverted.code, 0, `stderr:\n${reverted.stderr}`);
    assert.equal(await statusIn(plane, 2, toApply.id), 'reverted');
    assert.equal(await currentVersion(plane, 2, graphId), base);
  });
});
