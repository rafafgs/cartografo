/**
 * Acceptance test of the board (t107, FR5).
 *
 * Criterion 1 of the ticket's original body: "I see the board". Here it is
 * demanded end to end — a real control plane as a process, a real screen
 * reading from it over HTTP only, and real HTML coming out the other side.
 *
 * Grouping by `no_atual` is the reason the screen exists: a board that only
 * lists jobs in id order does not answer "where is work getting stuck?", which
 * is the question D16 wants answered before the PoC is accepted.
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
} from './support.ts';

test('t107 AT4 — GET /board shows jobs grouped by node, with the block reason', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const refining = await createJob(cp, {
    title: 'Minimal observability screen',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  const implementing = await createJob(cp, {
    title: 'Question and resume cycle',
    entry_node_id: 'refinar',
    execution_id: 7,
  });
  const stuck = await createJob(cp, {
    title: 'Factory graph 2',
    entry_node_id: 'refinar',
    execution_id: 7,
  });

  await api(cp, 'POST', `/v1/jobs/${implementing.id}/transitions`, {
    to_node_id: 'implementar',
  });
  await api(cp, 'POST', `/v1/jobs/${stuck.id}/transitions`, { to_node_id: 'implementar' });
  await api(cp, 'POST', `/v1/jobs/${stuck.id}/blocks`, {
    reason: 'waiting on the founder to decide',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/board');

  assert.equal(page.status, 200);
  assert.match(page.contentType ?? '', /text\/html/, 'the screen returns HTML, not JSON');

  // t124: the control plane behind this page denies anonymous requests, and the
  // browser that just rendered it presented none. Both halves of that sentence
  // are asserted here — the unit-level proxy test proves the header is built,
  // this one proves the whole real stack still works once it is required.
  assert.equal(
    (await fetch(`${cp.url}/v1/jobs`)).status,
    401,
    'the real control plane behind the screen requires a credential',
  );

  for (const job of [refining, implementing, stuck]) {
    assert.ok(page.html.includes(job.title), `the board does not show the title "${job.title}"`);
  }

  const groups = blocks(page.html, 'no-atual');
  assert.deepEqual(
    groups.map((group) => group.value),
    ['implementar', 'refinar'],
    'one group per occupied node, in node order',
  );

  const [inImplement, inRefine] = groups;
  assert.ok(
    inImplement.excerpt.includes(implementing.title) &&
      inImplement.excerpt.includes(stuck.title),
    'the two that transitioned are under the "implementar" group',
  );
  assert.ok(
    !inImplement.excerpt.includes(refining.title),
    'whoever did not move cannot show up in the next node group',
  );
  assert.ok(
    inRefine.excerpt.includes(refining.title),
    'whoever did not move stays under the entry node group',
  );

  const cards = blocks(page.html, 'trabalho');
  assert.deepEqual(
    [...cards.map((card) => card.value)].sort(),
    [refining.id, implementing.id, stuck.id].map(String).sort(),
    'one card per job, marked with its id',
  );

  const stuckCard = cards.find((card) => card.value === String(stuck.id));
  assert.ok(stuckCard !== undefined);
  assert.ok(
    stuckCard.excerpt.includes('waiting on the founder to decide'),
    'the blocked card has to say WHY it is blocked',
  );

  const looseCard = cards.find((card) => card.value === String(refining.id));
  assert.ok(looseCard !== undefined);
  assert.ok(
    !looseCard.excerpt.includes('waiting on the founder to decide'),
    'a block reason belongs to the blocked job, not to the page',
  );

  // t310: the page a person actually opens reads in English — the heading it is
  // titled by and the group label it groups under.
  assert.ok(
    page.html.includes('<h2>board · 3 job(s)</h2>'),
    `the board heading is not the English one:\n${page.html}`,
  );
  assert.ok(page.html.includes('<a href="/board">board</a>'), 'the nav link text is still Portuguese');
  assert.ok(page.html.includes('<html lang="en">'), 'the shell still declares another language');

  assert.ok(page.html.includes('href="/executions"'), 'the board leads to the executions list');
  assert.ok(
    page.html.includes(`href="/jobs/${refining.id}"`),
    'each job leads to its own timeline',
  );
});

test('t107 AT4 — the board escapes HTML coming from the control plane', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  // The title is outside data, and the credential the API demands since t124
  // says nothing about what it carries: interpolating it raw would be HTML
  // injection on the project's very first screen.
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

test('t310 — a board with nothing on it says so in English', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/board');

  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('<p class="vazio">No jobs here yet.</p>'),
    `the empty state is missing or still Portuguese:\n${page.html}`,
  );
  // The CSS class name is NOT copy: `vazio` is the DOM contract the founder
  // reserved for himself (t310, AC2), and it stays exactly as it is.
  assert.ok(page.html.includes('class="vazio"'), 'the class name is structure, and structure did not move');
});

test('t310 — the blocked card with no reason declared says it in English', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const job = await createJob(cp, { title: 'Blocked with nothing said', entry_node_id: 'refinar' });
  await api(cp, 'POST', `/v1/jobs/${job.id}/blocks`, {});

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/board');

  assert.equal(page.status, 200);
  const card = blocks(page.html, 'trabalho').find((one) => one.value === String(job.id));
  assert.ok(card !== undefined);
  assert.ok(
    card.excerpt.includes('blocked, with no reason declared'),
    `the fallback block line is not English:\n${card.excerpt}`,
  );
});
