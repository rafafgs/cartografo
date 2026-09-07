/**
 * Acceptance test of the board (t107, t416).
 *
 * Split in two halves, the same way the ticket itself is: tests 1-8 drive
 * `boardPage` against a FAKE `ApiClient` (canned JSON), because orchestrating
 * real sessions/leases for all six derived states end to end is t415's own
 * `jobs.test.ts` (AT9-17) and is not re-proven here — this file only proves
 * the SCREEN reads `state`/`state_since` correctly once they exist on the
 * wire. Tests 9, 11, 12 and 13 stay end to end against a real control plane,
 * for the states reachable through existing screen-visible writes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as ClientModule from '../src/client.ts';
import type * as PagesModule from '../src/pages.ts';
import {
  T107_ARTIFACTS,
  api,
  blocks,
  createJob,
  openPage,
  requireArtifacts,
  startControlPlane,
  startScreen,
} from './support.ts';

/** One board.test.ts-local factory, since a fake job here needs the full wire shape. */
async function loadPagesAndClient(): Promise<{
  boardPage: typeof PagesModule.boardPage;
  ApiClient: typeof ClientModule.ApiClient;
}> {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages);
  const { boardPage } = (await import(
    new URL('../src/pages.ts', import.meta.url).href
  )) as typeof PagesModule;
  const { ApiClient } = (await import(
    new URL('../src/client.ts', import.meta.url).href
  )) as typeof ClientModule;
  return { boardPage, ApiClient };
}

/** A full `Job`, as the wire sends it, with sensible defaults for what a test does not care about. */
function fakeJob(overrides: Partial<ClientModule.Job> & { id: number }): ClientModule.Job {
  return {
    execution_id: null,
    title: `job #${overrides.id}`,
    entry_node_id: 'refinar',
    current_node_id: 'refinar',
    blocked: false,
    block_reason: null,
    graph_version_id: null,
    completed: false,
    state: 'queued',
    state_since: '2026-09-06T00:00:00.000Z',
    fields: null,
    created_at: '2026-09-06T00:00:00.000Z',
    updated_at: '2026-09-06T00:00:00.000Z',
    ...overrides,
  };
}

/** A client whose one call answers with exactly these jobs. */
function fakeBoardClient(ApiClient: typeof ClientModule.ApiClient, jobs: ClientModule.Job[]): ClientModule.ApiClient {
  return new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    doFetch: async () =>
      new Response(JSON.stringify({ jobs }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
}

/** Five plain nodes, `node-1` swapped for whatever the caller wants to test the step label against. */
function fiveNodeSnapshot(nodeOne: Record<string, unknown> = {}): { nodes: unknown[] } {
  return {
    nodes: [
      { id: 'node-0' },
      { id: 'node-1', ...nodeOne },
      { id: 'node-2' },
      { id: 'node-3' },
      { id: 'node-4' },
    ],
  };
}

/**
 * A client whose `GET /v1/jobs` answers with `jobs`, and whose
 * `GET /v1/graph-versions/:id` answers out of `versions` (keyed by id) — an id
 * absent from `versions` 404s, exactly the "nothing usable" case FR5 asks for.
 * `calls`, when given, is incremented per id on every graph-version fetch, so
 * a test can assert on it after the render (AT6).
 */
function fakeBoardClientWithVersions(
  ApiClient: typeof ClientModule.ApiClient,
  jobs: ClientModule.Job[],
  versions: Record<string, { nodes: unknown[] }>,
  calls: Record<string, number> = {},
): ClientModule.ApiClient {
  return new ApiClient({
    baseUrl: 'http://127.0.0.1:4317',
    doFetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : String(input));
      const match = /^\/v1\/graph-versions\/([^/]+)$/.exec(url.pathname);
      if (match !== null) {
        const id = decodeURIComponent(match[1]);
        calls[id] = (calls[id] ?? 0) + 1;
        const snapshot = versions[id];
        if (snapshot === undefined) return new Response('not found', { status: 404 });
        return new Response(
          JSON.stringify({
            graph_version: {
              id,
              graph_id: 'g',
              parent_version: null,
              created_at: '2026-09-06T00:00:00.000Z',
              snapshot,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ jobs }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('t416 AT1 — GET /board renders the six state bands, in attention order, each carrying its own jobs', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Ask me something', state: 'awaiting_you', state_since: '2026-09-01T00:00:00.000Z' }),
    fakeJob({
      id: 2,
      title: 'Blocked, nobody asked',
      state: 'blocked_unasked',
      blocked: true,
      block_reason: 'waiting on a decision',
      state_since: '2026-09-02T00:00:00.000Z',
    }),
    fakeJob({ id: 3, title: 'Actively running', state: 'running', state_since: '2026-09-03T00:00:00.000Z' }),
    fakeJob({ id: 4, title: 'Lease past its deadline', state: 'unowned', state_since: '2026-09-04T00:00:00.000Z' }),
    fakeJob({ id: 5, title: 'Arrived', state: 'completed', state_since: '2026-09-05T00:00:00.000Z' }),
    fakeJob({ id: 6, title: 'Sitting in the queue', state: 'queued', state_since: '2026-09-06T00:00:00.000Z' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const bands = blocks(page.html, 'state');
  assert.deepEqual(
    bands.map((band) => band.value),
    ['awaiting_you', 'blocked_unasked', 'running', 'unowned', 'completed', 'queued'],
    'the bands are not in attention-priority order',
  );

  for (const job of jobs) {
    const band = bands.find((one) => one.value === job.state);
    assert.ok(band !== undefined, `no band found for state "${job.state}"`);
    assert.ok(band.excerpt.includes(job.title), `job "${job.title}" is not inside its own band`);
  }
});

test('t416 AT2 — a state with no job in it renders no band at all', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Queued job', state: 'queued', state_since: '2026-09-06T00:00:00.000Z' }),
    fakeJob({ id: 2, title: 'Waiting on me', state: 'awaiting_you', state_since: '2026-09-01T00:00:00.000Z' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const bands = blocks(page.html, 'state');
  assert.deepEqual(
    bands.map((band) => band.value),
    ['awaiting_you', 'queued'],
    'an empty state must not draw a band at all',
  );
});

test('t416 AT3 — within a band, jobs sort by state_since ascending — the oldest wait first', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  // Fed out of order on purpose: the fake client answers in whatever order the
  // fixture lists them, and the board is what has to put them straight.
  const jobs = [
    fakeJob({ id: 1, title: 'Newest wait', state: 'queued', state_since: '2026-09-06T00:00:00.000Z' }),
    fakeJob({ id: 2, title: 'Oldest wait', state: 'queued', state_since: '2026-09-01T00:00:00.000Z' }),
    fakeJob({ id: 3, title: 'Middle wait', state: 'queued', state_since: '2026-09-03T00:00:00.000Z' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const band = blocks(page.html, 'state').find((one) => one.value === 'queued');
  assert.ok(band !== undefined);
  const order = ['Oldest wait', 'Middle wait', 'Newest wait'].map((title) => band.excerpt.indexOf(title));
  assert.ok(
    order[0] < order[1] && order[1] < order[2],
    `expected ascending state_since order, got positions ${order.join(', ')}`,
  );
});

test('t416 AT4 — a shared state_since ties break by ascending job id', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 5, title: 'Higher id', state: 'queued', state_since: '2026-09-06T00:00:00.000Z' }),
    fakeJob({ id: 2, title: 'Lower id', state: 'queued', state_since: '2026-09-06T00:00:00.000Z' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const band = blocks(page.html, 'state').find((one) => one.value === 'queued');
  assert.ok(band !== undefined);
  assert.ok(
    band.excerpt.indexOf('Lower id') < band.excerpt.indexOf('Higher id'),
    'the lower id must sort first when state_since is shared',
  );
});

test('t416 AT5 — twelve jobs board-wide still render as cards, grouped by node inside each band', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = Array.from({ length: 12 }, (_, index) =>
    fakeJob({
      id: index + 1,
      title: `Job ${index + 1}`,
      state: index % 2 === 0 ? 'queued' : 'running',
      current_node_id: index < 4 ? 'refinar' : 'implementar',
      state_since: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  assert.ok(!page.html.includes('<table>'), 'twelve jobs must stay in card mode — no table anywhere');
  const nodeGroups = blocks(page.html, 'no-atual');
  assert.ok(nodeGroups.length >= 2, 'the per-node grouping has to nest inside the state bands');
});

test('t416 AT6 — thirteen jobs board-wide render every band as a flat table, sorted by state_since', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = Array.from({ length: 13 }, (_, index) =>
    fakeJob({
      id: index + 1,
      // Zero-padded so no title is a prefix of another ("Job 01" vs "Job 12"),
      // which `indexOf` below would otherwise find inside the wrong one.
      title: `Job ${String(index + 1).padStart(2, '0')}`,
      state: 'queued',
      current_node_id: index % 2 === 0 ? 'refinar' : 'implementar',
      state_since: `2026-09-${String(13 - index).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  assert.ok(page.html.includes('<table>'), 'thirteen jobs must switch to row mode');
  assert.deepEqual(blocks(page.html, 'no-atual'), [], 'row mode is flat — no per-node grouping');

  const band = blocks(page.html, 'state').find((one) => one.value === 'queued');
  assert.ok(band !== undefined);
  // state_since descended as `index` grows, so titles must appear in REVERSE
  // index order (job 13 has the oldest state_since and sorts first).
  const positions = jobs.map((job) => band.excerpt.indexOf(job.title));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i - 1] > positions[i], `job ${i} is not in state_since order`);
  }
  jobs.forEach((job) => {
    assert.ok(band.excerpt.includes(job.current_node_id), `row for ${job.title} is missing its node`);
  });
});

test('t416 AT7 — the same grammar shows on a card and on a row, and every job on the page shares one render instant', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const cardBoard = Array.from({ length: 12 }, (_, index) =>
    fakeJob({
      id: index + 1,
      title: index === 0 ? 'Fixture job' : `Filler ${index}`,
      state: 'awaiting_you',
      current_node_id: 'refinar',
      state_since: '2026-09-01T00:00:00.000Z',
    }),
  );
  const rowBoard = Array.from({ length: 13 }, (_, index) =>
    fakeJob({
      id: index + 1,
      title: index === 0 ? 'Fixture job' : `Filler ${index}`,
      state: 'awaiting_you',
      current_node_id: 'refinar',
      state_since: '2026-09-01T00:00:00.000Z',
    }),
  );

  const cardPage = await boardPage(fakeBoardClient(ApiClient, cardBoard));
  const rowPage = await boardPage(fakeBoardClient(ApiClient, rowBoard));

  for (const page of [cardPage, rowPage]) {
    const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
    assert.ok(card !== undefined);
    assert.ok(card.excerpt.includes('Fixture job'), 'the title is missing');
    assert.ok(card.excerpt.includes('awaiting you'), 'the state must read with spaces, not underscores');
    assert.ok(card.excerpt.includes('refinar'), 'the current node id is missing');
    assert.match(card.excerpt, /for [^<\n]+/, 'the duration ("for …") is missing');
    assert.match(card.excerpt, /as of [^<\n]+/, 'the anchor ("as of …") is missing');
  }

  // The same page, two different jobs: their anchors must be byte-identical.
  const anchors = [...rowPage.html.matchAll(/as of ([^<\n]+)/g)].map((match) => match[1]);
  assert.ok(anchors.length >= 2, 'expected at least two anchors to compare');
  assert.ok(
    anchors.every((anchor) => anchor === anchors[0]),
    `every job on the page must share one render instant, got: ${anchors.join(' | ')}`,
  );
});

test('t416 AT8 — awaiting_you and blocked_unasked cards carry the attention class; a running card does not', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Waiting on me', state: 'awaiting_you', state_since: '2026-09-01T00:00:00.000Z' }),
    fakeJob({
      id: 2,
      title: 'Blocked, nobody asked',
      state: 'blocked_unasked',
      blocked: true,
      block_reason: 'because',
      state_since: '2026-09-02T00:00:00.000Z',
    }),
    fakeJob({ id: 3, title: 'Running along', state: 'running', state_since: '2026-09-03T00:00:00.000Z' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const cards = blocks(page.html, 'trabalho');
  const waiting = cards.find((one) => one.value === '1');
  const blocked = cards.find((one) => one.value === '2');
  const running = cards.find((one) => one.value === '3');
  assert.ok(waiting !== undefined && blocked !== undefined && running !== undefined);

  assert.match(waiting.excerpt, /class="[^"]*\battention\b[^"]*"/, 'awaiting_you must carry .attention');
  assert.match(blocked.excerpt, /class="[^"]*\battention\b[^"]*"/, 'blocked_unasked must carry .attention');
  assert.doesNotMatch(running.excerpt, /class="[^"]*\battention\b[^"]*"/, 'running must not carry .attention');
});

test('t416 AT9 — a job with fields.demo truthy shows the demo badge; one without does not', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const demoJob = await createJob(cp, {
    title: 'Demo job',
    entry_node_id: 'refinar',
    fields: { demo: true },
  });
  const plainJob = await createJob(cp, {
    title: 'Ordinary job',
    entry_node_id: 'refinar',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/board');

  const demoCard = blocks(page.html, 'trabalho').find((one) => one.value === String(demoJob.id));
  const plainCard = blocks(page.html, 'trabalho').find((one) => one.value === String(plainJob.id));
  assert.ok(demoCard !== undefined && plainCard !== undefined);

  assert.ok(demoCard.excerpt.includes('demo-badge'), 'the demo job must show the demo badge');
  assert.ok(!plainCard.excerpt.includes('demo-badge'), 'a job with no fields.demo must not show the badge');
});

test('t416 AT10 — the auto-refresh meta tag is scoped to /board alone', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const board = await openPage(screen, '/board');
  assert.ok(
    board.html.includes('<meta http-equiv="refresh" content="30">'),
    '/board must carry the 30s auto-refresh',
  );

  for (const path of ['/', '/input-requests', '/executions', '/runners']) {
    const page = await openPage(screen, path);
    assert.ok(
      !page.html.includes('<meta http-equiv="refresh"'),
      `${path} must not auto-refresh`,
    );
  }
});

test('t416 AT11 — a job blocked with no pending question lands in blocked_unasked, and still shows why', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, { title: 'Stuck job', entry_node_id: 'refinar' });
  await api(cp, 'POST', `/v1/jobs/${job.id}/blocks`, {
    reason: 'waiting on the founder to decide',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/board');

  const band = blocks(page.html, 'state').find((one) => one.value === 'blocked_unasked');
  assert.ok(band !== undefined, 'no blocked_unasked band was rendered');
  assert.ok(band.excerpt.includes(job.title), 'the blocked job is not inside its band');
  assert.ok(
    band.excerpt.includes('waiting on the founder to decide'),
    'the block reason did not survive the split',
  );
});

test('t416 AT12 — the board still escapes HTML coming from the control plane', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  await createJob(cp, {
    title: '<script>alert("xss")</script> & co',
    entry_node_id: 'refinar',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/board');

  assert.equal(page.status, 200);
  assert.ok(!page.html.includes('<script>alert'), 'a job title must not become a script');
  assert.ok(
    page.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; co'),
    'the title shows up escaped, and whole',
  );
});

test('t459 AT1 — a job whose entry_node_id is interview links to /interview/<id>, not /jobs/<id>', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'An interview in progress', entry_node_id: 'interview', state: 'queued' }),
  ];

  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(card.excerpt.includes('href="/interview/1"'), `the card links to /interview/1:\n${card.excerpt}`);
  assert.ok(!card.excerpt.includes('href="/jobs/1"'), `the card must not also link to /jobs/1:\n${card.excerpt}`);
});

test('t459 AT2 — an ordinary job still links to /jobs/<id>, in both card mode and row mode', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const cardBoard = [fakeJob({ id: 1, title: 'An ordinary job', entry_node_id: 'refinar', state: 'queued' })];
  const cardPage = await boardPage(fakeBoardClient(ApiClient, cardBoard));
  const card = blocks(cardPage.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(card.excerpt.includes('href="/jobs/1"'), `the card links to /jobs/1:\n${card.excerpt}`);

  const rowBoard = Array.from({ length: 13 }, (_, index) =>
    fakeJob({
      id: index + 1,
      title: `Job ${index + 1}`,
      entry_node_id: 'refinar',
      state: 'queued',
      state_since: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );
  const rowPage = await boardPage(fakeBoardClient(ApiClient, rowBoard));
  assert.ok(rowPage.html.includes('<table>'), 'thirteen jobs must be in row mode');
  const row = blocks(rowPage.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(row !== undefined);
  assert.ok(row.excerpt.includes('href="/jobs/1"'), `the row links to /jobs/1:\n${row.excerpt}`);
});

test('t230 — the Portuguese paths D20 renamed are gone, with no redirect behind them', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  // Nothing is public yet (D20), so the old spelling is not an alias and not a
  // 303 either: it is an address that never existed. A redirect here would be
  // the migration keeping both vocabularies alive, which is the one outcome the
  // glossary exists to prevent.
  for (const gone of ['/quadro', '/execucoes', '/execucoes/7', '/perguntas', '/trabalhos/1']) {
    const page = await openPage(screen, gone);
    assert.equal(page.status, 404, `${gone} still answers; D20 §5.1 renamed it`);
  }
});

test('t463 AT1 — card mode shows the step line', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Traveling', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
  ];
  const versions = { v1: fiveNodeSnapshot({ role: 'Draft the proposal' }) };
  const client = fakeBoardClientWithVersions(ApiClient, jobs, versions);

  const page = await boardPage(client);

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(
    card.excerpt.includes('step 2/5 · Draft the proposal'),
    `expected the step line in:\n${card.excerpt}`,
  );
});

test('t463 AT2 — row mode shows the step line, and keeps the raw node id', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = Array.from({ length: 13 }, (_, index) =>
    fakeJob({
      id: index + 1,
      title: `Job ${String(index + 1).padStart(2, '0')}`,
      current_node_id: 'node-1',
      graph_version_id: 'v1',
      state: 'running',
      state_since: `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
    }),
  );
  const versions = { v1: fiveNodeSnapshot({ role: 'Draft the proposal' }) };
  const client = fakeBoardClientWithVersions(ApiClient, jobs, versions);

  const page = await boardPage(client);

  assert.ok(page.html.includes('<table>'), 'thirteen jobs must render in row mode');
  const row = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(row !== undefined);
  assert.ok(row.excerpt.includes('node-1'), 'the raw node id must survive, verbatim');
  assert.ok(
    row.excerpt.includes('step 2/5 · Draft the proposal'),
    `expected the step line in:\n${row.excerpt}`,
  );
});

test('t463 AT3 — graph_version_id: null renders no step line', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [fakeJob({ id: 1, title: 'No map pinned', state: 'running' })];
  const page = await boardPage(fakeBoardClient(ApiClient, jobs));

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(!card.excerpt.includes('step '), `expected no step line in:\n${card.excerpt}`);
});

test('t463 AT4 — a resolvable version whose snapshot has no matching node renders no step line', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Off the map', current_node_id: 'ghost-node', graph_version_id: 'v1', state: 'running' }),
  ];
  const versions = { v1: fiveNodeSnapshot() };
  const client = fakeBoardClientWithVersions(ApiClient, jobs, versions);

  const page = await boardPage(client);

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(!card.excerpt.includes('step '), `expected no step line in:\n${card.excerpt}`);
  assert.ok(card.excerpt.includes('Off the map'), 'the rest of the card must render unchanged');
});

test('t463 AT5 — a graph_version_id that fails to resolve renders no step line', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Dangling pin', current_node_id: 'node-1', graph_version_id: 'gone', state: 'running' }),
  ];
  const client = fakeBoardClientWithVersions(ApiClient, jobs, {});

  const page = await boardPage(client);

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  assert.ok(!card.excerpt.includes('step '), `expected no step line in:\n${card.excerpt}`);
  assert.ok(card.excerpt.includes('Dangling pin'), 'the rest of the card must render unchanged');
});

test('t463 AT6 — one fetch per distinct version, not per job', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'First', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
    fakeJob({ id: 2, title: 'Second', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
  ];
  const versions = { v1: fiveNodeSnapshot({ role: 'Draft the proposal' }) };
  const calls: Record<string, number> = {};
  const client = fakeBoardClientWithVersions(ApiClient, jobs, versions, calls);

  await boardPage(client);

  assert.equal(calls.v1, 1, `expected exactly one fetch of "v1", got ${calls.v1 ?? 0}`);
});

test('t463 AT7 — the §7.1 fallback rule matches exactly', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const roleOnlyJobs = [
    fakeJob({ id: 1, title: 'Role only', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
  ];
  const roleOnlyClient = fakeBoardClientWithVersions(ApiClient, roleOnlyJobs, {
    v1: fiveNodeSnapshot({ role: 'Draft the proposal' }),
  });
  const roleOnlyPage = await boardPage(roleOnlyClient);
  const roleOnlyCard = blocks(roleOnlyPage.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(roleOnlyCard !== undefined);
  assert.ok(
    roleOnlyCard.excerpt.includes('step 2/5 · Draft the proposal'),
    `expected no dangling separator in:\n${roleOnlyCard.excerpt}`,
  );

  const bareIdJobs = [
    fakeJob({ id: 1, title: 'Bare id', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
  ];
  const bareIdClient = fakeBoardClientWithVersions(ApiClient, bareIdJobs, { v1: fiveNodeSnapshot() });
  const bareIdPage = await boardPage(bareIdClient);
  const bareIdCard = blocks(bareIdPage.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(bareIdCard !== undefined);
  assert.ok(
    bareIdCard.excerpt.includes('step 2/5 · node-1'),
    `expected the bare node id, never "to be defined", in:\n${bareIdCard.excerpt}`,
  );
});

test('t463 AT8 — no double-escaping of the role/description label', async () => {
  const { boardPage, ApiClient } = await loadPagesAndClient();

  const jobs = [
    fakeJob({ id: 1, title: 'Escaped role', current_node_id: 'node-1', graph_version_id: 'v1', state: 'running' }),
  ];
  const versions = { v1: fiveNodeSnapshot({ role: 'Draft <the> proposal & ship it' }) };
  const client = fakeBoardClientWithVersions(ApiClient, jobs, versions);

  const page = await boardPage(client);

  const card = blocks(page.html, 'trabalho').find((one) => one.value === '1');
  assert.ok(card !== undefined);
  const escaped = 'Draft &lt;the&gt; proposal &amp; ship it';
  assert.ok(card.excerpt.includes(`step 2/5 · ${escaped}`), `expected exactly-once escaping in:\n${card.excerpt}`);
  assert.ok(!card.excerpt.includes('&amp;amp;'), 'the ampersand must not be escaped twice');
});
