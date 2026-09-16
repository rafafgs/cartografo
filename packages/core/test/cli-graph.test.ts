/**
 * Acceptance tests of `cartografo graph` (t545, D26): editing a graph's
 * topology from the terminal — `export` → hand-edit the file → `graph propose`
 * — through the one door the graph editor page also uses, a proposal created,
 * approved and applied; plus the two reads `graph versions` and `graph show`.
 *
 * Against a REAL control plane, through the real binary, the same posture
 * `cli-proposals.test.ts` takes — including its second database connection for
 * AT11's direct read of the event log (see that file's header for why a child
 * process leaves no `ctx.db` to hand `loadEvents()`).
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openDatabase } from '../src/db/connection.ts';
import type { GraphDocument } from '../src/domain/graph.ts';
import { loadEvents, type Event } from './support.ts';
import {
  REPO_ROOT,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
} from './cli-support.ts';

const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');
const CLASS = 'nota-curta';

interface Graph {
  id: string;
  current_version_id: string | null;
}

interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  snapshot: GraphDocument;
}

interface Proposal {
  id: number;
  status: string;
  graph_id: string;
  result: unknown;
  target_version: string;
  applied_version_id: string | null;
}

async function post<T>(plane: RunningControlPlane, route: string, body: unknown, expected = 201): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `POST ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

async function get<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

/** A control plane with the minimal graph registered as a base lineage. */
async function seeded(
  t: Parameters<typeof temporaryArea>[0],
  label: string,
): Promise<{ plane: RunningControlPlane; area: string; databasePath: string }> {
  const area = temporaryArea(t, `cartografo-t545-${label}-`);
  const databasePath = path.join(area, 'cartografo.db');
  const plane = await startControlPlane(t, { databasePath });
  await post(plane, '/v1/graphs', minimalGraph());
  return { plane, area, databasePath };
}

/** Exports the class through the CLI and returns the file and its parsed content. */
async function exported(
  plane: RunningControlPlane,
  area: string,
  name = 'edited.graph.json',
): Promise<{ file: string; document: GraphDocument }> {
  const file = path.join(area, name);
  const result = await runCli(['export', CLASS, '--out', file, '--url', plane.url], { token: plane.token });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  return { file, document: JSON.parse(readFileSync(file, 'utf8')) as GraphDocument };
}

function write(file: string, document: GraphDocument): void {
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

async function currentGraph(plane: RunningControlPlane, id = CLASS): Promise<Graph> {
  return (await get<{ graph: Graph }>(plane, `/v1/graphs/${id}?project_id=1`)).graph;
}

async function version(plane: RunningControlPlane, id: string): Promise<GraphVersion> {
  return (await get<{ graph_version: GraphVersion }>(plane, `/v1/graph-versions/${id}?project_id=1`)).graph_version;
}

async function proposals(plane: RunningControlPlane): Promise<Proposal[]> {
  return (await get<{ proposals: Proposal[] }>(plane, '/v1/proposals?project_id=1')).proposals;
}

/** The unreachable-node edit of AT4/AT5: the minimal graph's only edge, removed. */
function withoutEdges(document: GraphDocument): GraphDocument {
  return { ...document, edges: [] };
}

/** Proposes a description edit through the CLI and demands it applied. */
async function applyDescription(plane: RunningControlPlane, area: string, text: string): Promise<void> {
  const { file, document } = await exported(plane, area);
  document.nodes[0].description = text;
  write(file, document);
  const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
}

test(
  'AT1 — a description edit proposed with no --graph applies; the new current version differs only in that description',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'apply');
    const before = await currentGraph(plane);
    const { file, document } = await exported(plane, area);

    document.nodes[0].description = 'Writes the note, now in two paragraphs.';
    write(file, document);

    const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

    const after = await currentGraph(plane);
    assert.notEqual(after.current_version_id, before.current_version_id);

    const previous = await version(plane, before.current_version_id as string);
    const current = await version(plane, after.current_version_id as string);
    const expected = structuredClone(previous.snapshot);
    expected.nodes[0].description = 'Writes the note, now in two paragraphs.';
    assert.deepEqual(current.snapshot, expected);
  },
);

test(
  'AT2 — a node id renamed in place is refused locally: exit 1, no request, stderr names id, the position and both ids',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'rename');
    const { file, document } = await exported(plane, area);
    document.nodes[1].id = 'review';
    write(file, document);

    const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
    assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /\bid\b/);
    assert.match(result.stderr, /position 1/);
    assert.match(result.stderr, /"revisar"/);
    assert.match(result.stderr, /"review"/);
    assert.equal((await proposals(plane)).length, 0);
  },
);

test(
  'AT3 — an engine change on a node that keeps its id is refused locally: exit 1, no request, stderr names engine',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'engine');
    const { file, document } = await exported(plane, area);
    document.nodes[0].engine = 'codex';
    write(file, document);

    const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
    assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /\bengine\b/);
    assert.match(result.stderr, /"redigir"/);
    assert.equal((await proposals(plane)).length, 0);
  },
);

test(
  'AT4 — --dry-run over an edit leaving a node unreachable prints the operations and the soundness reasons, exits 1, creates nothing',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'dry');
    const before = await currentGraph(plane);
    const { file, document } = await exported(plane, area);
    write(file, withoutEdges(document));

    const result = await runCli(['graph', 'propose', file, '--dry-run', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /- edge redigir → revisar/);
    assert.match(result.stderr, /^ {2}(structure|soundness) {2}\S+: /m);

    assert.equal((await proposals(plane)).length, 0);
    assert.equal((await currentGraph(plane)).current_version_id, before.current_version_id);
  },
);

test(
  'AT5 — the same broken edit without --dry-run exits 1 with the same reasons; the version stays, the proposal is rejected with the report',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'broken');
    const before = await currentGraph(plane);
    const { file, document } = await exported(plane, area);
    write(file, withoutEdges(document));

    const dry = await runCli(['graph', 'propose', file, '--dry-run', '--url', plane.url], { token: plane.token });
    const reasons = dry.stderr.split('\n').filter((line) => /^ {2}(structure|soundness) {2}/.test(line));
    assert.ok(reasons.length > 0, `no reasons in:\n${dry.stderr}`);

    const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
    assert.equal(result.code, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    for (const reason of reasons) assert.ok(result.stderr.includes(reason), `"${reason}" missing from:\n${result.stderr}`);

    assert.equal((await currentGraph(plane)).current_version_id, before.current_version_id);
    const all = await proposals(plane);
    assert.equal(all.length, 1);
    const proposal = (await get<{ proposal: Proposal }>(plane, `/v1/proposals/${all[0].id}?project_id=1`)).proposal;
    assert.equal(proposal.status, 'rejected');
    assert.ok(proposal.result !== null && typeof proposal.result === 'object', 'the report is the result');
    assert.equal((proposal.result as { valid?: unknown }).valid, false);
  },
);

test(
  'AT6 — --no-apply leaves the created proposal pending, prints its id, and does not move the version',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'pending');
    const before = await currentGraph(plane);
    const { file, document } = await exported(plane, area);
    document.nodes[1].description = 'Checks the note and closes the traversal.';
    write(file, document);

    const result = await runCli(['graph', 'propose', file, '--no-apply', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

    const all = await proposals(plane);
    assert.equal(all.length, 1);
    assert.match(result.stdout, new RegExp(`#${all[0].id}\\b`));
    const proposal = (await get<{ proposal: Proposal }>(plane, `/v1/proposals/${all[0].id}?project_id=1`)).proposal;
    assert.equal(proposal.status, 'pending');
    assert.equal((await currentGraph(plane)).current_version_id, before.current_version_id);
  },
);

test('AT7 — an unedited file prints "no change to propose", exits 0, creates nothing', { timeout: 180_000 }, async (t) => {
  const { plane, area } = await seeded(t, 'unedited');
  const { file } = await exported(plane, area);

  const result = await runCli(['graph', 'propose', file, '--url', plane.url], { token: plane.token });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stdout, /no change to propose/);
  assert.equal((await proposals(plane)).length, 0);
});

test('AT8 — --dry-run with --no-apply is a usage error: exit 2, nothing created', { timeout: 180_000 }, async (t) => {
  const { plane, area } = await seeded(t, 'contradiction');
  const { file, document } = await exported(plane, area);
  document.nodes[0].description = 'changed';
  write(file, document);

  const result = await runCli(['graph', 'propose', file, '--dry-run', '--no-apply', '--url', plane.url], {
    token: plane.token,
  });
  assert.equal(result.code, 2, `stderr:\n${result.stderr}`);
  assert.match(result.stderr, /run `cartografo --help` for usage/);
  assert.equal((await proposals(plane)).length, 0);
});

test(
  'AT9 — graph versions lists every version oldest-first with its parent; --json is the wire body',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'versions');
    const base = (await currentGraph(plane)).current_version_id as string;
    await applyDescription(plane, area, 'First edit.');
    const first = (await currentGraph(plane)).current_version_id as string;
    await applyDescription(plane, area, 'Second edit.');
    const second = (await currentGraph(plane)).current_version_id as string;

    const result = await runCli(['graph', 'versions', CLASS, '--url', plane.url], { token: plane.token });
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 3, result.stdout);
    assert.ok(lines[0].startsWith(`${base}  parent=none`), lines[0]);
    assert.ok(lines[1].startsWith(`${first}  parent=${base}`), lines[1]);
    assert.ok(lines[2].startsWith(`${second}  parent=${first}`), lines[2]);

    const json = await runCli(['graph', 'versions', CLASS, '--json', '--url', plane.url], { token: plane.token });
    assert.equal(json.code, 0, `stderr:\n${json.stderr}`);
    assert.deepEqual(JSON.parse(json.stdout), await get(plane, `/v1/graphs/${CLASS}/versions?project_id=1`));
  },
);

test(
  'AT10 — graph show reads the current version, an older one by --version, and refuses a version of another lineage',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area } = await seeded(t, 'show');
    const base = (await currentGraph(plane)).current_version_id as string;
    await applyDescription(plane, area, 'An edit that moves the current version.');
    const current = (await currentGraph(plane)).current_version_id as string;

    const shown = await runCli(['graph', 'show', CLASS, '--url', plane.url], { token: plane.token });
    assert.equal(shown.code, 0, `stderr:\n${shown.stderr}`);
    assert.match(shown.stdout, new RegExp(current));
    assert.match(shown.stdout, /redigir {2}redator {2}work/);
    assert.match(shown.stdout, /revisar {2}revisor {2}gate/);
    assert.match(shown.stdout, /redigir → revisar {2}\(sempre\)/);

    const older = await runCli(['graph', 'show', CLASS, '--version', base, '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(older.code, 0, `stderr:\n${older.stderr}`);
    assert.match(older.stdout, new RegExp(base));
    assert.doesNotMatch(older.stdout, new RegExp(current));

    const olderJson = await runCli(['graph', 'show', CLASS, '--version', base, '--json', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(olderJson.code, 0, `stderr:\n${olderJson.stderr}`);
    assert.deepEqual(JSON.parse(olderJson.stdout), await version(plane, base));

    const other = minimalGraph();
    other.problem_class = 'another-class';
    const registered = await post<{ graph_version: { id: string } }>(plane, '/v1/graphs', other);

    const foreign = await runCli(
      ['graph', 'show', CLASS, '--version', registered.graph_version.id, '--url', plane.url],
      { token: plane.token },
    );
    assert.equal(foreign.code, 1, `stdout:\n${foreign.stdout}\nstderr:\n${foreign.stderr}`);
    assert.ok(foreign.stderr.includes(registered.graph_version.id), foreign.stderr);
    assert.ok(foreign.stderr.includes('another-class'), foreign.stderr);
    assert.ok(foreign.stderr.includes(CLASS), foreign.stderr);
  },
);

test(
  'AT11 — graph propose --by attributes approve and apply to that user in the event log',
  { timeout: 180_000 },
  async (t) => {
    const { plane, area, databasePath } = await seeded(t, 'actor');
    const { file, document } = await exported(plane, area);
    document.nodes[0].description = 'Attributed edit.';
    write(file, document);

    const result = await runCli(['graph', 'propose', file, '--by', 'alice', '--url', plane.url], {
      token: plane.token,
    });
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

    const [proposal] = await proposals(plane);
    const full = (await get<{ proposal: Proposal }>(plane, `/v1/proposals/${proposal.id}?project_id=1`)).proposal;
    assert.equal(full.status, 'applied');

    const { getEventsByEntity } = await loadEvents();
    const db = openDatabase(databasePath);
    try {
      const approved = (getEventsByEntity(db, 'graph_version', full.target_version) as Event[]).filter(
        (event) => event.type === 'graph_version.proposal_approved',
      );
      assert.equal(approved.length, 1);
      assert.deepEqual(approved[0].actor, { type: 'user', ref: 'alice' });

      const applied = (getEventsByEntity(db, 'graph_version', full.applied_version_id as string) as Event[]).filter(
        (event) => event.type === 'graph_version.applied',
      );
      assert.equal(applied.length, 1);
      assert.deepEqual(applied[0].actor, { type: 'user', ref: 'alice' });
    } finally {
      db.close();
    }
  },
);

test('AT-usage — no verb or an unknown verb exits 2 naming the three verbs', { timeout: 60_000 }, async () => {
  const noVerb = await runCli(['graph']);
  assert.equal(noVerb.code, 2);
  assert.match(noVerb.stderr, /graph needs a verb: propose, versions or show/);

  const bogus = await runCli(['graph', 'bogus']);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /graph needs a verb/);
});
