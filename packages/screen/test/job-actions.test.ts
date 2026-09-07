/**
 * Acceptance tests of the two job actions the screen writes (t339, AT1–AT7).
 *
 * Until this ticket the screen had exactly one write — answering a question —
 * and a blocked job on `/board` could only be released from a terminal. The
 * standing consumer is b3-radar's D21 promotion gate, whose whole human step is
 * one unblock; the board showed the flag and the reason and offered no door.
 *
 * Everything below is demanded end to end, the same way `questions.test.ts`
 * demands the answer form: a REAL control plane as a process, the screen up
 * against it over HTTP only, and every state check read back from the control
 * plane DIRECTLY — never through the screen that has just written it. A page
 * that hid a card would pass a test that asked the screen; it fails one that
 * asks the API.
 *
 * The two halves are deliberately asymmetric (the ticket's Out of Scope):
 * Unblock lives on `/board`'s cards, because releasing a queue of held jobs is
 * done from the queue view; Block lives on `/jobs/:id`, because stopping a
 * healthy job is a deliberate, one-at-a-time act.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  T107_ARTIFACTS,
  api,
  blocks,
  createJob,
  openPage,
  requireArtifacts,
  startControlPlane,
  startScreen,
  submitForm,
  type Job,
  type RunningControlPlane,
  type ScreenUnderTest,
} from './support.ts';

const ARTIFACTS = [T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router];

/** One event of the log, as `GET /v1/jobs/:id/events` returns it. */
interface JobEvent {
  type: string;
  data: Record<string, unknown>;
  actor: { type: string; ref: string };
}

/** Raises the flag through the public API, so the screen writes nothing here. */
async function blockThroughApi(
  cp: RunningControlPlane,
  jobId: number,
  reason: string,
): Promise<void> {
  const response = await api<Job>(cp, 'POST', `/v1/jobs/${jobId}/blocks`, { reason });
  assert.equal(response.status, 200, `POST /v1/jobs/${jobId}/blocks returned ${response.status}`);
}

/** Reads the job straight from the control plane, bypassing the screen. */
async function readJob(cp: RunningControlPlane, jobId: number): Promise<Job> {
  const response = await api<Job>(cp, 'GET', `/v1/jobs/${jobId}`);
  assert.equal(response.status, 200);
  return response.body;
}

/** Reads the job's log straight from the control plane, bypassing the screen. */
async function readEvents(cp: RunningControlPlane, jobId: number): Promise<JobEvent[]> {
  const response = await api<{ events: JobEvent[] }>(cp, 'GET', `/v1/jobs/${jobId}/events`);
  assert.equal(response.status, 200);
  return response.body.events;
}

/** The card of one job on the board, sliced out by its `data-trabalho` marker. */
function card(html: string, jobId: number): string {
  const found = blocks(html, 'trabalho').find((block) => block.value === String(jobId));
  assert.ok(found !== undefined, `the board has no card for job #${jobId}`);
  return found.excerpt;
}

/** Starts a control plane with the screen already pointed at it. */
async function boot(t: Parameters<typeof startControlPlane>[0]): Promise<{
  cp: RunningControlPlane;
  screen: ScreenUnderTest;
}> {
  requireArtifacts(...ARTIFACTS);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  return { cp, screen };
}

test('t339 AT1 — a blocked card offers the unblock form; a healthy one offers nothing', async (t) => {
  const { cp, screen } = await boot(t);

  const held = await createJob(cp, { title: 'promote the reversal rule', entry_node_id: 'refinar' });
  const healthy = await createJob(cp, { title: 'ordinary work', entry_node_id: 'refinar' });
  await blockThroughApi(cp, held.id, 'a promotion is a proposal until a human releases it');

  const page = await openPage(screen, '/board');
  assert.equal(page.status, 200);

  const blockedCard = card(page.html, held.id);
  assert.match(
    blockedCard,
    new RegExp(`<form[^>]*action="/jobs/${held.id}/unblock"`),
    `the blocked card carries no unblock form:\n${blockedCard}`,
  );
  assert.match(blockedCard, /<form[^>]*method="post"/, 'the unblock form is a POST');
  assert.match(
    blockedCard,
    /<textarea[^>]*name="reason"[^>]*>/,
    'the reason is a textarea, and it is named `reason`',
  );
  assert.match(
    /<textarea[^>]*name="reason"[^>]*>/.exec(blockedCard)?.[0] ?? '',
    /\brequired\b/,
    'the reason field is required in the markup too, and not only on the server',
  );
  assert.match(blockedCard, /<input[^>]*name="actor_ref"/, 'and a "who is doing this" input');
  assert.match(blockedCard, /<button[^>]*type="submit"[^>]*>unblock<\/button>/, 'the button reads "unblock"');

  const healthyCard = card(page.html, healthy.id);
  assert.doesNotMatch(healthyCard, /<form/, `a card that is not blocked carries no form:\n${healthyCard}`);
  assert.doesNotMatch(healthyCard, /unblock/, 'nor the word for an action it cannot take');
});

test('t339 AT2 — /jobs/:id offers the block form only while the job is NOT blocked', async (t) => {
  const { cp, screen } = await boot(t);

  const healthy = await createJob(cp, { title: 'running fine', entry_node_id: 'refinar' });
  const held = await createJob(cp, { title: 'already held', entry_node_id: 'refinar' });
  await blockThroughApi(cp, held.id, 'waiting on a human');

  const open = await openPage(screen, `/jobs/${healthy.id}`);
  assert.equal(open.status, 200);
  assert.match(
    open.html,
    new RegExp(`<form[^>]*method="post"[^>]*action="/jobs/${healthy.id}/block"`),
    `the job page carries no block form:\n${open.html}`,
  );
  assert.match(open.html, /<textarea[^>]*name="reason"[^>]*required/, 'the reason is required');
  assert.match(open.html, /<input[^>]*name="actor_ref"/, 'and a "who is doing this" input');
  assert.match(open.html, /<button[^>]*type="submit"[^>]*>block<\/button>/, 'the button reads "block"');

  const blockedPage = await openPage(screen, `/jobs/${held.id}`);
  assert.equal(blockedPage.status, 200);
  assert.doesNotMatch(
    blockedPage.html,
    /<form[^>]*action="\/jobs\/\d+\/block"/,
    'a job that is already blocked is not offered the block form',
  );
});

test('t339 AT3 — submitting the unblock form is a REAL write, recorded as a person', async (t) => {
  const { cp, screen } = await boot(t);

  const job = await createJob(cp, { title: 'promote the reversal rule', entry_node_id: 'refinar' });
  await blockThroughApi(cp, job.id, 'a promotion is a proposal until a human releases it');

  const submission = await submitForm(screen, `/jobs/${job.id}/unblock`, {
    reason: 'three weeks of real trades back it; releasing',
    actor_ref: 'rafael',
  });
  assert.equal(submission.status, 303, 'a POST that writes answers with a redirect');
  assert.equal(submission.location, '/board', 'and lands back on the board, reread from the API');

  // The proof is the state, read back through the public API without going
  // through the screen at all.
  const after = await readJob(cp, job.id);
  assert.equal(after.blocked, false, 'the flag actually came down');
  assert.equal(after.block_reason, null);

  const unblocks = (await readEvents(cp, job.id)).filter((event) => event.type === 'job.unblocked');
  assert.equal(unblocks.length, 1);
  assert.equal(unblocks[0].data.reason, 'three weeks of real trades back it; releasing');
  assert.deepEqual(
    unblocks[0].actor,
    { type: 'user', ref: 'rafael' },
    'the audit says a PERSON released it, and never the control plane',
  );
});

test('t339 AT4 — submitting the block form is a REAL write, recorded as a person', async (t) => {
  const { cp, screen } = await boot(t);

  const job = await createJob(cp, { title: 'running fine', entry_node_id: 'refinar' });

  const submission = await submitForm(screen, `/jobs/${job.id}/block`, {
    reason: 'the upstream feed is stale; hold it until the vendor answers',
    actor_ref: 'rafael',
  });
  assert.equal(submission.status, 303);
  assert.equal(submission.location, `/jobs/${job.id}`, 'and lands back on the job, reread from the API');

  const after = await readJob(cp, job.id);
  assert.equal(after.blocked, true);
  assert.equal(after.block_reason, 'the upstream feed is stale; hold it until the vendor answers');

  const raised = (await readEvents(cp, job.id)).filter((event) => event.type === 'job.blocked');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].data.reason, 'the upstream feed is stale; hold it until the vendor answers');
  assert.deepEqual(raised[0].actor, { type: 'user', ref: 'rafael' });
});

test('t339 AT5 — a blank reason is refused with 400, before the control plane hears about it', async (t) => {
  const { cp, screen } = await boot(t);

  const held = await createJob(cp, { title: 'held', entry_node_id: 'refinar' });
  await blockThroughApi(cp, held.id, 'the original reason, which must survive');
  const healthy = await createJob(cp, { title: 'healthy', entry_node_id: 'refinar' });

  for (const reason of ['', '   \t\n  ']) {
    const refusedUnblock = await submitForm(screen, `/jobs/${held.id}/unblock`, {
      reason,
      actor_ref: 'rafael',
    });
    assert.equal(refusedUnblock.status, 400, `a blank unblock reason (${JSON.stringify(reason)}) is refused`);

    const refusedBlock = await submitForm(screen, `/jobs/${healthy.id}/block`, {
      reason,
      actor_ref: 'rafael',
    });
    assert.equal(refusedBlock.status, 400, `a blank block reason (${JSON.stringify(reason)}) is refused`);
  }

  const stillHeld = await readJob(cp, held.id);
  assert.equal(stillHeld.blocked, true, 'nothing was written');
  assert.equal(stillHeld.block_reason, 'the original reason, which must survive');

  const stillHealthy = await readJob(cp, healthy.id);
  assert.equal(stillHealthy.blocked, false, 'nothing was written');

  const flags = (await readEvents(cp, healthy.id)).filter((event) =>
    ['job.blocked', 'job.unblocked'].includes(event.type),
  );
  assert.deepEqual(flags, [], 'the control plane never heard about the blank submissions');
});

test("t339 AT6 — an id the control plane does not know propagates its 404", async (t) => {
  const { screen } = await boot(t);

  for (const path of ['/jobs/424242/unblock', '/jobs/424242/block']) {
    const submission = await fetch(`${screen.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ reason: 'anything', actor_ref: 'rafael' }).toString(),
      redirect: 'manual',
    });
    assert.equal(submission.status, 404, `${path} should propagate the control plane's 404`);

    // And it is the CONTROL PLANE's 404, not the router's "there is no such
    // page": the route exists, the job does not. Without this the test would
    // pass against a screen that never learned the route at all.
    const page = await submission.text();
    assert.ok(
      page.includes('<h2>not found</h2>') &&
        page.includes('The control plane does not know this address.'),
      `${path} answered its own 404 instead of propagating the API's:\n${page}`,
    );
  }
});

test('t339 AT7 — omitting who is doing this falls back to the same default the answer form uses', async (t) => {
  const { cp, screen } = await boot(t);
  const { DEFAULT_ANSWERED_BY } = (await import(
    new URL('../src/pages.ts', import.meta.url).href
  )) as typeof import('../src/pages.ts');

  const job = await createJob(cp, { title: 'held', entry_node_id: 'refinar' });
  await blockThroughApi(cp, job.id, 'held for a human');

  const submission = await submitForm(screen, `/jobs/${job.id}/unblock`, { reason: 'releasing' });
  assert.equal(submission.status, 303);

  const unblocks = (await readEvents(cp, job.id)).filter((event) => event.type === 'job.unblocked');
  assert.equal(unblocks.length, 1);
  assert.deepEqual(unblocks[0].actor, { type: 'user', ref: DEFAULT_ANSWERED_BY });
  assert.equal(DEFAULT_ANSWERED_BY, 'tela', 'the door the write came through, honestly recorded');
});
