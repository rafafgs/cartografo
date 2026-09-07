/**
 * Acceptance tests for the READ side of `external_call`, as t371 needs it.
 *
 * t370 built the table, the two-phase write and the unfiltered listing, and its
 * own cases live in `jobs.test.ts` beside the rest of the job family's routes.
 * What this ticket adds is narrower and is a file of its own because the ticket
 * declared it as one: three query filters on the listing, and three new values
 * on the `outcome` vocabulary.
 *
 * **Why the filters exist at all.** RF-35 is answered by a lookup and by nothing
 * else: before writing a node's declared output the runner asks whether THIS
 * job, on THIS node, has already delivered THAT name — and a client that had to
 * fetch a job's whole call history and filter it in memory would be re-deriving,
 * per attempt, an answer the index
 * `idx_external_call_lookup (job_id, node_id, name, direction)` was declared to
 * give directly (`0033_external_calls.sql`).
 *
 * **Why the three new outcomes are values and not a second column.** A call that
 * was skipped because an identical one already succeeded, one a person told the
 * runner to abandon, and one a person declared already done outside the system
 * are all the same fact seen once: how this delivery ended. What they are not is
 * `ok` — nothing was sent — and reading them as `ok` would make the log claim a
 * call that never left the machine.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Job,
  type TestContext,
} from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The artifacts these cases need on disk. */
const ARTIFACTS = Object.freeze({
  t370Migration: 'migrations/0033_external_calls.sql',
  outcomeMigration: 'migrations/0034_external_call_outcomes.sql',
  repository: 'src/repositories/external-calls.ts',
  routes: 'src/routes/jobs.ts',
});

/** One row of `external_call`, as `/v1` publishes it. */
interface ExternalCall {
  id: number;
  job_id: number;
  node_id: string;
  direction: 'input' | 'output';
  name: string;
  server: string;
  tool: string;
  arguments_sha256: string;
  arguments_summary: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  result_summary: string | null;
}

/**
 * The three outcomes this ticket adds, spelled here and not imported.
 *
 * The contract the test demands, which is not the same object as the contract
 * the implementation happens to declare: a list imported from `src/` agrees with
 * itself whatever it says.
 */
const NEW_OUTCOMES = ['skipped_duplicate', 'skipped_by_person', 'marked_done_by_person'] as const;

/** A job with no graph behind it — every case here only needs an id. */
async function jobForCalls(ctx: TestContext, title: string): Promise<Job> {
  return await createJob(ctx, { title, entry_node_id: 'deliver' });
}

/** Opens one call's record, and answers the row. */
async function openCall(
  ctx: TestContext,
  jobId: number,
  overrides: Record<string, unknown> = {},
): Promise<ExternalCall> {
  const created = await request<{ external_call: ExternalCall }>(
    ctx,
    'POST',
    `/v1/jobs/${jobId}/external-calls`,
    {
      node_id: 'deliver',
      direction: 'output',
      name: 'delivered_proposal',
      server: 'drive',
      tool: 'upload_file',
      arguments_sha256: 'a'.repeat(64),
      arguments_summary: '{"folder":"clients/1"}',
      started_at: '2026-09-07T12:00:00.000Z',
      ...overrides,
    },
  );
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.external_call;
}

/** Closes one call's record with the outcome given. */
async function closeCall(
  ctx: TestContext,
  jobId: number,
  callId: number,
  outcome: string,
): Promise<{ status: number; body: { external_call?: ExternalCall; error?: string } }> {
  return await request<{ external_call?: ExternalCall; error?: string }>(
    ctx,
    'POST',
    `/v1/jobs/${jobId}/external-calls`,
    {
      call_id: callId,
      finished_at: '2026-09-07T12:00:01.000Z',
      outcome,
      result_summary: `closed as ${outcome}`,
    },
  );
}

/** The listing, with whatever query string a case wants on it. */
async function listCalls(
  ctx: TestContext,
  jobId: number,
  query = '',
): Promise<ExternalCall[]> {
  const listed = await request<{ external_calls: ExternalCall[] }>(
    ctx,
    'GET',
    `/v1/jobs/${jobId}/external-calls${query}`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  return listed.body.external_calls;
}

test('t371 AT-C1 — the listing filters by node_id, name and direction, and they add up as AND', async (t) => {
  requireArtifacts(...Object.values(ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job with a busy call history');

  // Four rows that differ in exactly one coordinate each, so a filter that
  // silently matched everything, or nothing, cannot pass by accident.
  const wanted = await openCall(ctx, job.id);
  const otherName = await openCall(ctx, job.id, { name: 'delivered_invoice' });
  const otherNode = await openCall(ctx, job.id, { node_id: 'review' });
  const otherDirection = await openCall(ctx, job.id, { direction: 'input', tool: 'download_file' });

  assert.deepEqual(
    (await listCalls(ctx, job.id)).map((row) => row.id),
    [wanted.id, otherName.id, otherNode.id, otherDirection.id],
    'unfiltered, the listing is what it always was: everything, oldest first',
  );

  assert.deepEqual(
    (await listCalls(ctx, job.id, '?direction=output')).map((row) => row.id),
    [wanted.id, otherName.id, otherNode.id],
  );
  assert.deepEqual(
    (await listCalls(ctx, job.id, '?node_id=deliver')).map((row) => row.id),
    [wanted.id, otherName.id, otherDirection.id],
  );
  assert.deepEqual(
    (await listCalls(ctx, job.id, '?name=delivered_proposal')).map((row) => row.id),
    [wanted.id, otherNode.id, otherDirection.id],
  );

  // The three together are the idempotency question RF-35 actually asks.
  assert.deepEqual(
    (
      await listCalls(
        ctx,
        job.id,
        '?node_id=deliver&name=delivered_proposal&direction=output',
      )
    ).map((row) => row.id),
    [wanted.id],
    'the three filters are an AND, and they answer exactly one delivery',
  );

  assert.deepEqual(
    await listCalls(ctx, job.id, '?node_id=deliver&name=nobody-declared-this&direction=output'),
    [],
    'a name nothing was ever written under is an empty list, never everything',
  );
});

test('t371 AT-C2 — a filtered listing never reaches another job', async (t) => {
  requireArtifacts(...Object.values(ARTIFACTS));
  const ctx = await startControlPlane(t);

  const mine = await jobForCalls(ctx, 'mine');
  const theirs = await jobForCalls(ctx, 'theirs');

  await openCall(ctx, theirs.id);

  assert.deepEqual(
    await listCalls(ctx, mine.id, '?node_id=deliver&name=delivered_proposal&direction=output'),
    [],
    'the same node and the same name on ANOTHER job is not this job\'s delivery',
  );
});

test('t371 AT-C3 — the three new outcomes round-trip through the completion route', async (t) => {
  requireArtifacts(...Object.values(ARTIFACTS));
  const ctx = await startControlPlane(t);
  const job = await jobForCalls(ctx, 'a job whose deliveries end in three new ways');

  for (const outcome of NEW_OUTCOMES) {
    const opened = await openCall(ctx, job.id, { name: `by-${outcome}` });
    const closed = await closeCall(ctx, job.id, opened.id, outcome);

    assert.equal(closed.status, 200, `${outcome}: ${JSON.stringify(closed.body)}`);
    assert.equal(closed.body.external_call?.outcome, outcome);
    assert.equal(closed.body.external_call?.finished_at, '2026-09-07T12:00:01.000Z');

    const [readBack] = await listCalls(ctx, job.id, `?name=by-${outcome}`);
    assert.equal(readBack.outcome, outcome, 'and it survives the round trip through the column');
  }

  // The vocabulary is wider, not open: a word nobody publishes is still a 400.
  const opened = await openCall(ctx, job.id, { name: 'by-nonsense' });
  const refused = await closeCall(ctx, job.id, opened.id, 'went_fine_probably');
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'invalid_body');
});

test('t371 AT-C4 — widening the outcome vocabulary is a migration, and it keeps the two indexes', async () => {
  requireArtifacts(...Object.values(ARTIFACTS));

  const sql = readFileSync(path.join(PACKAGE_ROOT, ARTIFACTS.outcomeMigration), 'utf8');

  // The column carried `CHECK (outcome IN ('ok','error'))` from t370's own
  // migration, which SQLite cannot ALTER: widening it is a table rebuild, and
  // the two indexes have to be recreated with it or the idempotency lookup this
  // ticket's whole retry story rests on degrades into a table scan nobody
  // notices.
  assert.ok(/DROP TABLE external_call/.test(sql), 'the rebuild has to replace the old table');
  assert.ok(/RENAME TO external_call/.test(sql), 'and rename the new one into its place');
  assert.ok(
    /idx_external_call_lookup/.test(sql),
    'the (job_id, node_id, name, direction) index is recreated',
  );
  assert.ok(/idx_external_call_job/.test(sql), 'and so is the listing index');
  assert.ok(
    !/CHECK\s*\(\s*outcome/.test(sql),
    'the outcome vocabulary lives in the repository now, not in a CHECK a second ' +
      'ticket would have to rebuild the table to widen again',
  );
});
