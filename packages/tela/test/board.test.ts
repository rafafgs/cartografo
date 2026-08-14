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

test('t107 AT4 — GET /quadro shows jobs grouped by node, with the block reason', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  const refining = await createJob(cp, {
    titulo: 'Tela mínima de observabilidade',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const implementing = await createJob(cp, {
    titulo: 'Ciclo de pergunta e retomada',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const stuck = await createJob(cp, {
    titulo: 'Grafo de fábrica 2',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });

  await api(cp, 'POST', `/v1/jobs/${implementing.id}/transitions`, {
    para_no_id: 'implementar',
  });
  await api(cp, 'POST', `/v1/jobs/${stuck.id}/transitions`, { para_no_id: 'implementar' });
  await api(cp, 'POST', `/v1/jobs/${stuck.id}/blocks`, {
    motivo: 'esperando decisão do fundador',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/quadro');

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
    assert.ok(page.html.includes(job.titulo), `the board does not show the title "${job.titulo}"`);
  }

  const groups = blocks(page.html, 'no-atual');
  assert.deepEqual(
    groups.map((group) => group.value),
    ['implementar', 'refinar'],
    'one group per occupied node, in node order',
  );

  const [inImplement, inRefine] = groups;
  assert.ok(
    inImplement.excerpt.includes(implementing.titulo) &&
      inImplement.excerpt.includes(stuck.titulo),
    'the two that transitioned are under the "implementar" group',
  );
  assert.ok(
    !inImplement.excerpt.includes(refining.titulo),
    'whoever did not move cannot show up in the next node group',
  );
  assert.ok(
    inRefine.excerpt.includes(refining.titulo),
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
    stuckCard.excerpt.includes('esperando decisão do fundador'),
    'the blocked card has to say WHY it is blocked',
  );

  const looseCard = cards.find((card) => card.value === String(refining.id));
  assert.ok(looseCard !== undefined);
  assert.ok(
    !looseCard.excerpt.includes('esperando decisão do fundador'),
    'a block reason belongs to the blocked job, not to the page',
  );

  assert.ok(page.html.includes('href="/execucoes"'), 'the board leads to the executions list');
  assert.ok(
    page.html.includes(`href="/trabalhos/${refining.id}"`),
    'each job leads to its own timeline',
  );
});

test('t107 AT4 — the board escapes HTML coming from the control plane', async (t) => {
  requireArtifacts(T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  // The title is user data and arrives through an API with no authentication
  // (t124 is another ticket): interpolating it raw would be HTML injection on
  // the project's very first screen.
  await createJob(cp, {
    titulo: '<script>alert("xss")</script> & cia',
    no_entrada_id: 'refinar',
  });

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/quadro');

  assert.equal(page.status, 200);
  assert.ok(!page.html.includes('<script>alert'), 'a job title must not become a script');
  assert.ok(
    page.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; cia'),
    'the title shows up escaped, and whole',
  );
});
