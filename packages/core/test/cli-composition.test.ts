/**
 * Acceptance tests of the composition reads (t639, AT1-AT8): `jobs` and
 * `job <id>` showing parent/child structure, derived child states, holds and
 * cancellations.
 *
 * A real control plane, the real binary, seeded through the public API exactly
 * as an operator would. Parent/child pairs are opened with `POST /v1/jobs`
 * carrying `parent_job_id` and `parent_node_id`; the jobs have no graph version
 * unless a test needs one that has arrived.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { childOf, get, open, openCompleted, post, type Job } from './cli-composition-support.ts';
import { runCli, startControlPlane, temporaryArea } from './cli-support.ts';

/** The cells of the row of `jobs` that starts with this id. */
function jobRow(stdout: string, id: number): string[] {
  const line = stdout.split('\n').find((candidate) => new RegExp(`^${id}\\s`).test(candidate));
  assert.ok(line, `no row for job ${id} in:\n${stdout}`);
  return line.split(/ {2,}/);
}

/** The lines of the `children:` section of `job <id>`, header first. */
function childrenSection(stdout: string): string[][] {
  const lines = stdout.split('\n');
  const start = lines.indexOf('children:');
  assert.ok(start >= 0, `no children: section in:\n${stdout}`);
  const rows: string[][] = [];
  for (let index = start + 1; index < lines.length && lines[index] !== '' && !lines[index].startsWith('waiting on a person'); index += 1) {
    rows.push(lines[index].split(/ {2,}/));
  }
  return rows;
}

const JOBS_HEADER = ['id', 'state', 'current_node_id', 'execution_id', 'blocked', 'relation', 'hold', 'title'];

test('t639 composition reads', { timeout: 300_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t639-reads-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
  const cli = (args: string[]) => runCli([...args, '--url', plane.url], { token: plane.token });

  await t.test('AT1 — jobs prints the relation and hold columns', async () => {
    const parent = await open(plane, 'at1 parent');
    const first = await childOf(plane, parent, 'at1 first');
    await open(plane, 'at1 unrelated');
    const second = await childOf(plane, parent, 'at1 second');
    const nested = await open(plane, 'at1 grandchild', { parent_job_id: first.id, parent_node_id: 'inner' });
    const loose = await open(plane, 'at1 loose');

    const result = await cli(['jobs']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const header = result.stdout.split('\n')[0].trim().split(/ {2,}/);
    assert.deepEqual(header, JOBS_HEADER);

    assert.equal(jobRow(result.stdout, parent.id)[5], 'parent of 2');
    assert.equal(jobRow(result.stdout, second.id)[5], `child 2 of #${parent.id}`);
    assert.equal(jobRow(result.stdout, first.id)[5], `child 1 of #${parent.id}, parent of 1`);
    assert.equal(jobRow(result.stdout, nested.id)[5], `child 1 of #${first.id}`);
    assert.equal(jobRow(result.stdout, loose.id)[5], '-');
    assert.equal(jobRow(result.stdout, parent.id)[6], 'children');
    assert.equal(jobRow(result.stdout, parent.id)[7], 'at1 parent');
  });

  await t.test('AT2 — jobs --json is the API body, and --state still filters', async () => {
    const parent = await open(plane, 'at2 parent');
    const child = await childOf(plane, parent, 'at2 child');
    await post(plane, '/v1/input-requests', {
      job_id: child.id,
      kind: 'question',
      question: 'which one?',
      auto_approvable: false,
    });

    const result = await cli(['jobs', '--json']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const direct = await get<{ jobs: Job[] }>(plane, '/v1/jobs?project_id=1');
    assert.deepEqual(JSON.parse(result.stdout), direct);

    const parsed = JSON.parse(result.stdout) as { jobs: Job[] };
    const row = parsed.jobs.find((job) => job.id === child.id);
    assert.equal(row?.parent_job_id, parent.id);
    assert.equal(row?.sibling_position, 1);
    assert.equal(parsed.jobs.find((job) => job.id === parent.id)?.dispatch_hold, 'children');
    assert.deepEqual(parsed.jobs.find((job) => job.id === parent.id)?.children, [child.id]);

    const filtered = await cli(['jobs', '--state', 'awaiting_you', '--json']);
    const ids = (JSON.parse(filtered.stdout) as { jobs: Job[] }).jobs.map((job) => job.id);
    assert.ok(ids.includes(child.id));
    assert.ok(!ids.includes(parent.id));
  });

  await t.test('AT3 — job <parent> lists its children in position order', async () => {
    const parent = await open(plane, 'at3 parent');
    await open(plane, 'at3 interleaved');
    const first = await childOf(plane, parent, 'at3 first');
    await open(plane, 'at3 interleaved again');
    const second = await childOf(plane, parent, 'at3 second');
    const third = await childOf(plane, parent, 'at3 third');

    const result = await cli(['job', String(parent.id)]);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const rows = childrenSection(result.stdout);
    assert.deepEqual(rows[0], ['position', 'id', 'state', 'current_node_id', 'blocked', 'children', 'hold', 'title']);
    assert.deepEqual(
      rows.slice(1).map((row) => [row[0], row[1], row[7]]),
      [
        ['1', String(first.id), 'at3 first'],
        ['2', String(second.id), 'at3 second'],
        ['3', String(third.id), 'at3 third'],
      ],
    );
    assert.match(result.stdout, /^waiting on a person: \(none\)$/m);
    assert.ok(
      result.stdout.indexOf('children:') < result.stdout.indexOf('waiting on a person') &&
        result.stdout.indexOf('waiting on a person') < result.stdout.indexOf('timeline:'),
      'children, then the waiting line, then the timeline',
    );
  });

  await t.test('AT4 — the children waiting on a person are named, in position order', async () => {
    const parent = await open(plane, 'at4 parent');
    const first = await childOf(plane, parent, 'at4 first');
    const second = await childOf(plane, parent, 'at4 second');
    const third = await childOf(plane, parent, 'at4 third');
    const ask = (jobId: number) =>
      post(plane, '/v1/input-requests', {
        job_id: jobId,
        kind: 'question',
        question: 'which one?',
        auto_approvable: false,
      });

    await ask(second.id);
    const one = await cli(['job', String(parent.id)]);
    assert.match(one.stdout, new RegExp(`^waiting on a person: #${second.id} \\(position 2 of 3\\)$`, 'm'));
    const rows = childrenSection(one.stdout);
    assert.equal(rows.find((row) => row[1] === String(second.id))?.[2], 'awaiting_you');
    assert.notEqual(rows.find((row) => row[1] === String(first.id))?.[2], 'awaiting_you');

    await ask(third.id);
    const two = await cli(['job', String(parent.id)]);
    assert.match(
      two.stdout,
      new RegExp(
        `^waiting on a person: #${second.id} \\(position 2 of 3\\), #${third.id} \\(position 3 of 3\\)$`,
        'm',
      ),
    );
  });

  await t.test('AT5 — a child names its parent; dependencies and holds are told', async () => {
    const parent = await open(plane, 'at5 parent');
    const child = await childOf(plane, parent, 'at5 child');
    const dependency = await open(plane, 'at5 dependency');
    const dependent = await open(plane, 'at5 dependent', { depends_on: [dependency.id] });

    const asChild = await cli(['job', String(child.id)]);
    const lines = asChild.stdout.split('\n');
    assert.match(lines[0], /^#\d+ · at5 child · /);
    assert.equal(lines[1], `parent: #${parent.id} · node fan-out · position 1`);

    const asParent = await cli(['job', String(parent.id)]);
    assert.match(asParent.stdout, /^held: children$/m);

    const asDependent = await cli(['job', String(dependent.id)]);
    assert.match(asDependent.stdout, new RegExp(`^depends on: #${dependency.id}$`, 'm'));
    assert.match(asDependent.stdout, /^held: dependencies$/m);
  });

  await t.test('AT6 — job <parent> --json adds the children bodies', async () => {
    const parent = await open(plane, 'at6 parent');
    const first = await childOf(plane, parent, 'at6 first');
    const second = await childOf(plane, parent, 'at6 second');

    const result = await cli(['job', String(parent.id), '--json']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [
      'artifacts',
      'children',
      'events',
      'job',
      'questions',
      'sessions',
      'timeline',
    ]);
    assert.deepEqual(parsed.children, [
      await get<Job>(plane, `/v1/jobs/${first.id}`),
      await get<Job>(plane, `/v1/jobs/${second.id}`),
    ]);

    const alone = await cli(['job', String(first.id), '--json']);
    assert.deepEqual((JSON.parse(alone.stdout) as { children: unknown }).children, []);
  });

  await t.test('AT7 — a cancelled parent is marked, and so are its open children', async () => {
    const parent = await open(plane, 'at7 parent');
    const done = await openCompleted(plane, 'at7 completed child', {
      parent_job_id: parent.id,
      parent_node_id: 'fan-out',
    });
    const openChild = await childOf(plane, parent, 'at7 open child');

    await post(plane, `/v1/jobs/${parent.id}/cancellations`, {}, 200);

    const result = await cli(['job', String(parent.id)]);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /^cancelled: \d{4}-/m);
    assert.match(result.stdout.split('\n')[0], / · cancelled — \d{4}-/);

    const board = await cli(['jobs']);
    assert.equal(jobRow(board.stdout, parent.id)[6], 'cancelled');
    assert.equal(jobRow(board.stdout, openChild.id)[6], 'cancelled');
    assert.equal(jobRow(board.stdout, done.id)[6], '-');
  });

  await t.test('AT8 — a job with no relations prints what it printed before', async () => {
    const loose = await open(plane, 'at8 loose');
    const result = await cli(['job', String(loose.id)]);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    for (const label of ['parent:', 'children:', 'held:', 'depends on:', 'cancelled:', 'waiting on a person']) {
      assert.ok(!result.stdout.includes(label), `unexpected ${label} in:\n${result.stdout}`);
    }
    assert.match(result.stdout.split('\n')[0], / · in progress$/);

    const board = await cli(['jobs']);
    const row = jobRow(board.stdout, loose.id);
    assert.equal(row[5], '-');
    assert.equal(row[6], '-');
  });
});
