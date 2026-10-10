/**
 * Acceptance tests of `cartografo cancel` (t639, AT9-AT14).
 *
 * Real control plane, real binary. The route is `POST /v1/jobs/:id/cancellations`
 * (t636); what is under test is the CLI's write around it: the actor it records,
 * the optional reason, the exit codes and the refusals.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { get, open, openCompleted, type Job } from './cli-composition-support.ts';
import { runCli, startControlPlane, temporaryArea, type RunningControlPlane } from './cli-support.ts';

interface JobEvent {
  type: string;
  actor: { type: string; ref: string | null } | null;
  data: { reason: string | null; cascaded_from_job_id: number | null };
}

async function cancellations(plane: RunningControlPlane, id: number): Promise<JobEvent[]> {
  const body = await get<{ events: JobEvent[] }>(plane, `/v1/jobs/${id}/events`);
  return body.events.filter((event) => event.type === 'job.cancelled');
}

test('t639 cancel', { timeout: 300_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t639-cancel-');
  const plane = await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
  const cli = (args: string[]) => runCli([...args, '--url', plane.url], { token: plane.token });

  await t.test('AT9 — cancels with a reason and an actor, and cascades to the open child only', async () => {
    const parent = await open(plane, 'at9 parent');
    const done = await openCompleted(plane, 'at9 completed', { parent_job_id: parent.id, parent_node_id: 'fan-out' });
    const openChild = await open(plane, 'at9 open', { parent_job_id: parent.id, parent_node_id: 'fan-out' });

    const result = await cli(['cancel', String(parent.id), '--reason', 'theme dropped', '--by', 'rafael']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /^job cancelled$/m);
    assert.match(result.stdout, new RegExp(`^\\s+id\\s+${parent.id}$`, 'm'));
    assert.match(result.stdout, /^\s+cancelled_at\s+\d{4}-/m);
    assert.match(result.stdout, /^\s+children\s+2$/m);

    const own = await cancellations(plane, parent.id);
    assert.equal(own.length, 1);
    assert.deepEqual(own[0].actor, { type: 'user', ref: 'rafael' });
    assert.equal(own[0].data.reason, 'theme dropped');
    assert.equal(own[0].data.cascaded_from_job_id, null);

    const cascaded = await cancellations(plane, openChild.id);
    assert.equal(cascaded.length, 1);
    assert.equal(cascaded[0].data.cascaded_from_job_id, parent.id);
    assert.equal((await cancellations(plane, done.id)).length, 0);
  });

  await t.test('AT10 — the reason is optional, and a blank one is none', async () => {
    const plain = await open(plane, 'at10 plain');
    const blank = await open(plane, 'at10 blank');

    assert.equal((await cli(['cancel', String(plain.id)])).code, 0);
    assert.equal((await cli(['cancel', String(blank.id), '--reason', '   '])).code, 0);

    assert.equal((await cancellations(plane, plain.id))[0].data.reason, null);
    assert.equal((await cancellations(plane, blank.id))[0].data.reason, null);
  });

  await t.test('AT11 — --json prints exactly the route body', async () => {
    const job = await open(plane, 'at11');
    const result = await cli(['cancel', String(job.id), '--json']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), await get<Job>(plane, `/v1/jobs/${job.id}`));
  });

  await t.test('AT12 — an unknown job, a completed job and a repeat', async () => {
    const missing = await cli(['cancel', '424242']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no job #424242/);

    const completed = await openCompleted(plane, 'at12 completed');
    const refused = await cli(['cancel', String(completed.id)]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /job_completed/);

    const job = await open(plane, 'at12 twice');
    assert.equal((await cli(['cancel', String(job.id)])).code, 0);
    assert.equal((await cancellations(plane, job.id)).length, 1);
    assert.equal((await cli(['cancel', String(job.id)])).code, 0);
    assert.equal((await cancellations(plane, job.id)).length, 1, 'a repeat writes nothing');
  });

  await t.test('AT13 — a missing id, a non-integer id and an extra argument exit 2', async () => {
    const job = await open(plane, 'at13');
    for (const args of [['cancel'], ['cancel', 'abc'], ['cancel', String(job.id), '2']]) {
      const result = await cli(args);
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stderr}`);
    }
    assert.equal((await cancellations(plane, job.id)).length, 0, 'nothing was sent');
    assert.equal((await get<Job>(plane, `/v1/jobs/${job.id}`)).cancelled_at, null);
  });

  await t.test('AT14 — --help lists cancel, and --project is accepted and inert', async () => {
    const help = await runCli(['--help'], { token: plane.token });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^ {2}cancel <job-id>/m);

    const job = await open(plane, 'at14');
    const result = await cli(['cancel', String(job.id), '--project', '999']);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    assert.equal((await cancellations(plane, job.id)).length, 1);
  });
});
