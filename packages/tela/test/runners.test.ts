/**
 * Acceptance tests of the runner health page (t164, FR3).
 *
 * The screen gains its first fleet-facing view: which runners are paired, how
 * much work each is holding right now, when each was last heard from, and which
 * job the last dead one lost. All of it comes from ONE new read of the public
 * API (`GET /v1/runners`) — the screen invents no liveness of its own and keeps
 * no state, exactly like the other five views (D11).
 *
 * Two levels, on purpose:
 *
 * - the MARKUP is pinned against a fake `fetch`, because a hostile `nome` and a
 *   runner that never held a lease are cheap to write and impossible to seed
 *   through a real control plane without wall-clock waits;
 * - the ROUTE is exercised end to end against a real control plane and a real
 *   screen, because "the page exists at `/runners` and the nav leads to it" is
 *   a claim about the wiring, and a fake client would prove none of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiClient } from '../src/client.ts';
import type * as PagesModule from '../src/pages.ts';
import {
  T107_ARTIFACTS,
  api,
  blocks,
  openPage,
  requireArtifacts,
  startControlPlane,
  startScreen,
} from './support.ts';

const BASE_URL = 'http://127.0.0.1:4317';

/** A runner's health, as `GET /v1/runners` returns it. */
interface RunnerHealth {
  id: string;
  name: string | null;
  registered_at: string;
  active_leases: number;
  last_heartbeat: string | null;
  last_expiration: {
    job_id: number;
    expires_at: string;
    expiration_reason: string | null;
  } | null;
}

/**
 * Loads `pages.ts` and fails naming the missing export, instead of letting the
 * link of a static import blow up with no diagnosis.
 */
async function loadPages(): Promise<typeof PagesModule> {
  requireArtifacts(T107_ARTIFACTS.pages);
  const pages = (await import(new URL('../src/pages.ts', import.meta.url).href)) as typeof PagesModule;
  assert.equal(
    typeof pages.runnersPage,
    'function',
    'artifact does not exist yet: runnersPage in packages/tela/src/pages.ts',
  );
  return pages;
}

/** A client whose control plane answers `GET /v1/runners` with this fleet. */
function clientAnswering(fleet: RunnerHealth[]): ApiClient {
  return new ApiClient({
    baseUrl: BASE_URL,
    doFetch: async (input) => {
      assert.ok(
        String(input).endsWith('/v1/runners'),
        `the page read ${String(input)}; the fleet lives at GET /v1/runners`,
      );
      return new Response(JSON.stringify({ runners: fleet }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

test('t164 AT — /runners renders one row per runner, with the four fields and nothing unescaped', async () => {
  const { runnersPage } = await loadPages();

  const page = await runnersPage(
    clientAnswering([
      {
        id: 'runner-a',
        name: '<script>alert(1)</script>',
        registered_at: '2026-08-15T10:00:00.000Z',
        active_leases: 2,
        last_heartbeat: '2026-08-15T10:20:00.000Z',
        last_expiration: {
          job_id: 42,
          expires_at: '2026-08-15T10:07:00.000Z',
          expiration_reason: 'heartbeat_lost',
        },
      },
      {
        id: 'runner-b',
        name: null,
        registered_at: '2026-08-15T10:01:00.000Z',
        active_leases: 0,
        last_heartbeat: null,
        last_expiration: null,
      },
    ]),
  );

  assert.equal(page.status, 200);

  const rows = blocks(page.html, 'runner');
  assert.deepEqual(
    rows.map((row) => row.value),
    ['runner-a', 'runner-b'],
    'one row per runner, in the order the API sent them',
  );

  const [busy, idle] = rows;
  assert.match(busy.excerpt, /data-campo="leases_ativas">\s*2\s*</, 'the live lease count is shown');
  assert.match(
    busy.excerpt,
    /data-campo="ultimo_heartbeat">\s*2026-08-15T10:20:00.000Z\s*</,
    'the raw instant of the last heartbeat, with no relative-time arithmetic',
  );
  assert.ok(
    busy.excerpt.includes('data-campo="ultima_expiracao"'),
    'the stale-sweep signal has a cell of its own',
  );
  assert.match(
    busy.excerpt,
    /trabalho #42 \(heartbeat_lost\) às 2026-08-15T10:07:00.000Z/,
    'the last expiration names the job it lost, why, and when',
  );

  assert.ok(
    busy.excerpt.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
    'the runner name is operator-written text and goes through escapeHtml',
  );
  assert.ok(!page.html.includes('<script>alert(1)</script>'), 'no name reaches the browser raw');

  assert.match(idle.excerpt, /data-campo="leases_ativas">\s*0\s*</);
  for (const field of ['nome', 'ultimo_heartbeat', 'ultima_expiracao']) {
    assert.match(
      idle.excerpt,
      new RegExp(`data-campo="${field}">\\s*<span class="vazio">`),
      `a runner with no ${field} shows the vazio placeholder, not an empty cell`,
    );
  }
});

test('t164 AT — /runners with nobody paired is the empty state, not an empty table', async () => {
  const { runnersPage } = await loadPages();

  const page = await runnersPage(clientAnswering([]));

  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes('<p class="vazio">Nenhum runner pareado ainda.</p>'),
    `the empty state is missing:\n${page.html}`,
  );
  assert.deepEqual(blocks(page.html, 'runner'), []);
});

test('t164 AT — GET /runners is served against a real control plane, and the nav leads to it', async (t) => {
  requireArtifacts(T107_ARTIFACTS.client, T107_ARTIFACTS.pages, T107_ARTIFACTS.router);
  const cp = await startControlPlane(t);

  await api(cp, 'POST', '/v1/runners', { id: 'runner-a', name: 'laptop do fundador' });
  await api(cp, 'POST', '/v1/runners', { id: 'runner-b' });
  const lease = await api<{ lease: { job_id: number } }>(cp, 'POST', '/v1/leases', {
    runner_id: 'runner-a',
    project_id: 3,
    job_id: 77,
    runner_cap: 4,
    project_cap: 4,
    ttl_seconds: 600,
  });
  assert.equal(lease.status, 201, 'the fixture lease is what gives the page something to show');

  const screen = await startScreen(t, cp);
  const page = await openPage(screen, '/runners');

  assert.equal(page.status, 200);
  const rows = blocks(page.html, 'runner');
  assert.deepEqual(
    rows.map((row) => row.value),
    ['runner-a', 'runner-b'],
    'both paired runners, in pairing order, read off the real API',
  );
  assert.match(rows[0].excerpt, /data-campo="leases_ativas">\s*1\s*</, 'runner-a holds one lease');
  assert.match(rows[1].excerpt, /data-campo="leases_ativas">\s*0\s*</, 'runner-b holds none');
  assert.ok(
    rows[0].excerpt.includes('laptop do fundador'),
    'the row shows the name the operator paired with',
  );

  // The nav is the shared shell: a page nobody can reach from another page is a
  // page nobody opens.
  for (const route of ['/runners', '/quadro', '/execucoes', '/perguntas']) {
    const other = await openPage(screen, route);
    assert.ok(
      other.html.includes('href="/runners"'),
      `${route} does not link the runners page in the nav`,
    );
  }
});
