/**
 * D20 gate: the four columns that stayed Portuguese never leak out of the row
 * (t286, FR3/FR4).
 *
 * Deleting the translation layer of the job cluster is a like-for-like rename
 * almost everywhere: the field takes the name of the column it already read, the
 * `AS` goes, the `toWire*` goes, and nothing observable moves. Four fields are
 * not like-for-like, and they are the reason this file exists.
 *
 * `job.corpo`, `job.criterios_de_aceite`, `session.transcricao_truncada` and
 * `session.transcricao_tamanho_original` are COLUMNS that are still spelled in
 * Portuguese in SQLite. D20's fourth child left them behind because
 * `docs/spec/glossario-wire.md` §4.2 has no row for any of the four, and
 * inventing a spelling the glossary does not hold is the one thing the glossary
 * exists to prevent. Renaming them is a migration and a glossary entry, and it
 * is a ficha of its own.
 *
 * So the projections have to build `body`, `acceptance_criteria`,
 * `transcript_truncated` and `transcript_original_size` EXPLICITLY, out of a row
 * that spells them the old way — while `toJob` and `toSession` both start from a
 * `{...row}` spread. A spread that forgets to drop the source key does not fail
 * anything: the object simply carries both spellings, the new one alongside the
 * old, and the old one rides all the way out to `/v1` under a name no client has
 * ever been told about. Nothing throws, no schema refuses it, and the route
 * tests keep passing as long as they assert on the fields they name rather than
 * on the whole object.
 *
 * ## Why both surfaces are asserted
 *
 * The HTTP half is the byte-identity guarantee this ticket may never break:
 * `/v1` answered exactly these keys before the rename and answers exactly these
 * keys after it. It passes before the work and after it, on purpose — that is
 * what it is for.
 *
 * The REPOSITORY half is the one the rename actually moves, and it is where the
 * leak would appear first: before this ticket `getJob` hands back `titulo`,
 * `corpo` and `concluido`, and after it the very same call has to hand back
 * `title`, `body` and `completed` and nothing else. A leaked `corpo` shows up
 * here one layer before it reaches a route, which is the layer that can still be
 * fixed without a wire change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { getJob } from '../src/repositories/job.ts';
import { getSession, getSessionTranscript } from '../src/repositories/session.ts';
import {
  T102_ARTIFACTS,
  createJob,
  request,
  requireArtifacts,
  startControlPlane,
  type Job,
  type Session,
  type TestContext,
} from './support.ts';

/**
 * The job projection with the three fields this file asserts on.
 *
 * Local, like `JobWithTier` in `jobs.test.ts` and `JobWithContent` in
 * `intake-routes.test.ts`: `support.ts`'s `Job` carries the columns every suite
 * shares, and whoever needs another one declares it where the assertion is.
 */
interface JobWithContent extends Job {
  body: string | null;
  acceptance_criteria: string[] | null;
  fields: Record<string, string | number | boolean> | null;
  tier: 'trivial' | 'standard' | null;
  completed: boolean;
}

const ARTIFACTS = [
  T102_ARTIFACTS.jobRepository,
  T102_ARTIFACTS.jobRoutes,
  T102_ARTIFACTS.sessionRepository,
  T102_ARTIFACTS.sessionRoutes,
];

/**
 * Every key a job carries, on the wire and in the projection alike.
 *
 * One list and not two: after this ticket the repository's object IS what `/v1`
 * publishes, and a second list would be the round trip growing back in the test
 * suite instead of in the source. Declaration order, not sorted order —
 * {@link shape} is what puts both sides of a comparison in the same order.
 */
const JOB_KEYS = Object.freeze([
  'id',
  'project_id',
  'execution_id',
  'title',
  'body',
  'acceptance_criteria',
  'fields',
  'tier',
  'entry_node_id',
  'current_node_id',
  'blocked',
  'block_reason',
  'graph_version_id',
  'completed',
  'created_at',
  'updated_at',
]);

/** Every key a session carries, same rule as {@link JOB_KEYS}. */
const SESSION_KEYS = Object.freeze([
  'id',
  'job_id',
  'execution_id',
  'node_id',
  'engine',
  'engine_session_ref',
  'working_dir',
  'prompt',
  'timeout_seconds',
  'silence_seconds',
  'status',
  'exit_code',
  'timeout_reason',
  'usage',
  'models',
  'transcript',
  'transcript_truncated',
  'transcript_original_size',
  'output',
  'opened_at',
  'finished_at',
]);

/** The three facts `GET /v1/sessions/:id/transcript` answers with (t232). */
const TRANSCRIPT_KEYS = Object.freeze([
  'transcript',
  'transcript_truncated',
  'transcript_original_size',
]);

/** What the session prints; short enough that the 1 MiB cap cannot bite. */
const TRANSCRIPT_TEXT = 'a short transcript, well under the cap';

/** The keys of an object, sorted — an unordered comparison written once. */
function keysOf(value: unknown): string[] {
  assert.ok(value !== null && typeof value === 'object', `not an object: ${JSON.stringify(value)}`);
  return Object.keys(value as Record<string, unknown>).sort();
}

/** The declared list, in the same order {@link keysOf} puts the real one. */
function shape(declared: readonly string[]): string[] {
  return [...declared].sort();
}

/** A job born with everything the four residual columns can hold. */
async function createFullJob(ctx: TestContext): Promise<JobWithContent> {
  return (await createJob(ctx, {
    title: 'a job with content',
    entry_node_id: 'refine',
    execution_id: 11,
    body: 'The body lives in a column nobody renamed yet.',
    acceptance_criteria: ['the response names it `body`', 'and never `corpo`'],
    fields: { area: 'core' },
    tier: 'standard',
  })) as JobWithContent;
}

test('t286 FR3 — a job never carries a residual column name, wire or projection', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await createFullJob(ctx);

  const fetched = await request<JobWithContent>(ctx, 'GET', `/v1/jobs/${created.id}`);
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body));
  assert.deepEqual(keysOf(fetched.body), shape(JOB_KEYS), 'GET /v1/jobs/:id changed shape');
  assert.deepEqual(keysOf(created), shape(JOB_KEYS), 'POST /v1/jobs changed shape');

  const projection = getJob(ctx.db, created.id);
  assert.deepEqual(
    keysOf(projection),
    shape(JOB_KEYS),
    'the projection is supposed to be the published object now; a key here that is ' +
      'not on the wire is a row key that leaked through a spread (t286 FR3)',
  );

  // The content really did come back, so the shape assertions above are not
  // passing over an object that lost the two fields instead of renaming them.
  assert.equal(projection?.body, 'The body lives in a column nobody renamed yet.');
  assert.deepEqual(projection?.acceptance_criteria, [
    'the response names it `body`',
    'and never `corpo`',
  ]);
  assert.deepEqual(fetched.body.body, projection?.body);
});

test('t286 FR4 — a finished session never carries a residual column name either', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const job = await createFullJob(ctx);

  const opened = await request<Session>(ctx, 'POST', '/v1/sessions', {
    job_id: job.id,
    node_id: 'refine',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine the ticket',
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const finished = await request<Session>(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    transcript: TRANSCRIPT_TEXT,
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));

  const listed = await request<{ sessions: Session[] }>(
    ctx,
    'GET',
    `/v1/sessions?job_id=${job.id}`,
  );
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.sessions.length, 1);
  assert.deepEqual(
    keysOf(listed.body.sessions[0]),
    shape(SESSION_KEYS),
    'GET /v1/sessions changed shape',
  );

  const projection = getSession(ctx.db, opened.body.id);
  assert.deepEqual(
    keysOf(projection),
    shape(SESSION_KEYS),
    'the projection is supposed to be the published object now; a key here that is ' +
      'not on the wire is a row key that leaked through a spread (t286 FR4)',
  );
  assert.equal(projection?.transcript, TRANSCRIPT_TEXT);
  assert.equal(projection?.transcript_truncated, false);
  assert.equal(projection?.transcript_original_size, Buffer.byteLength(TRANSCRIPT_TEXT));

  const transcript = await request<Record<string, unknown>>(
    ctx,
    'GET',
    `/v1/sessions/${opened.body.id}/transcript`,
  );
  assert.equal(transcript.status, 200, JSON.stringify(transcript.body));
  assert.deepEqual(
    keysOf(transcript.body),
    shape(TRANSCRIPT_KEYS),
    'GET /v1/sessions/:id/transcript changed shape',
  );
  assert.deepEqual(
    keysOf(getSessionTranscript(ctx.db, opened.body.id)),
    shape(TRANSCRIPT_KEYS),
    'the transcript payload is supposed to be the published object now (t286 FR4)',
  );
});
