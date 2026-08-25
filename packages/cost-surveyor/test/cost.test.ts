/**
 * Acceptance tests of the cost aggregation (t114, AT1–AT4).
 *
 * The rule that runs through all four: **absence is not zero**. A session with
 * no `uso` does not lower the token average and a session with no
 * `finalizada_em` does not lower the time — they go into the `sessoes_sem_*`
 * counters, which is where the uncertainty stays visible. It is the same
 * convention as `packages/core/src/repositories/session.ts:9-11`, and the reason
 * is the same: collapsing the two destroys the only cost metric the PoC has.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CostModule from '../src/cost.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

let cache: typeof CostModule | null = null;

async function load(): Promise<typeof CostModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'cost.ts')),
    'artifact does not exist yet: packages/cost-surveyor/src/cost.ts',
  );
  cache ??= (await import(new URL('../src/cost.ts', import.meta.url).href)) as typeof CostModule;
  return cache;
}

/** A `uso` with the four subkeys; the total is their sum. */
function usage(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
): CostModule.SessionUsage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreation,
    cache_read_input_tokens: cacheRead,
  };
}

/** A session as `GET /v1/sessions` returns it, in the subset the lens reads. */
function session(partial: Partial<CostModule.ObservedSession>): CostModule.ObservedSession {
  return {
    job_id: 1,
    node_id: 'redigir',
    usage: null,
    opened_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:00:30.000Z',
    ...partial,
  };
}

test('AT1 — sums the four usage subkeys of two sessions of the same pair into a single total', async () => {
  const { aggregateCost } = await load();

  const rows = aggregateCost(
    [
      session({ job_id: 1, node_id: 'redigir', usage: usage(100, 20, 3, 7) }),
      session({ job_id: 1, node_id: 'redigir', usage: usage(1, 2, 3, 4) }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(rows.length, 1, 'two sessions of the same (version, node) are ONE row');
  assert.equal(rows[0].grafo_versao_id, 'sha256:v1');
  assert.equal(rows[0].no_id, 'redigir');
  assert.equal(rows[0].tokens_total, 140, '100+20+3+7 + 1+2+3+4');
  assert.equal(rows[0].sessoes_com_uso, 2);
  assert.equal(rows[0].sessoes_sem_uso, 0);
});

test('AT2 — a session with a null usage does not move tokens_total and counts in sessoes_sem_uso', async () => {
  const { aggregateCost } = await load();

  const rows = aggregateCost(
    [
      session({ job_id: 1, node_id: 'redigir', usage: usage(10, 10, 10, 10) }),
      session({ job_id: 1, node_id: 'redigir', usage: null }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokens_total, 40, 'an absent usage NEVER comes in as zero tokens');
  assert.equal(rows[0].sessoes_com_uso, 1);
  assert.equal(rows[0].sessoes_sem_uso, 1, 'the absence stays visible in a counter of its own');
});

test('AT3 — a session with no finalizada_em stays out of the time and counts in sessoes_sem_tempo', async () => {
  const { aggregateCost } = await load();

  const rows = aggregateCost(
    [
      session({
        job_id: 1,
        node_id: 'redigir',
        opened_at: '2026-08-14T10:00:00.000Z',
        finished_at: '2026-08-14T10:00:30.000Z',
      }),
      session({
        job_id: 1,
        node_id: 'redigir',
        opened_at: '2026-08-14T11:00:00.000Z',
        finished_at: null,
      }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].tempo_total_segundos, 30, 'only the closed session enters the sum');
  assert.equal(rows[0].sessoes_com_tempo, 1);
  assert.equal(rows[0].sessoes_sem_tempo, 1, 'an open session is unknown, not instantaneous');
});

test('AT4 — pairs with a null grafo_versao_id or no_id land in a group apart, last', async () => {
  const { aggregateCost } = await load();

  const rows = aggregateCost(
    [
      // A job with no declared graph version: the version comes out null.
      session({ job_id: 9, node_id: 'redigir', usage: usage(1, 1, 1, 1) }),
      // A discovery session: no node, no job.
      session({ job_id: null, node_id: null, usage: usage(2, 2, 2, 2) }),
      session({ job_id: 1, node_id: 'revisar', usage: usage(3, 3, 3, 3) }),
      session({ job_id: 1, node_id: 'redigir', usage: usage(4, 4, 4, 4) }),
    ],
    new Map<number, string | null>([
      [1, 'sha256:v1'],
      [9, null],
    ]),
  );

  const identified = rows.filter((row) => row.grafo_versao_id !== null && row.no_id !== null);
  const loose = rows.filter((row) => row.grafo_versao_id === null || row.no_id === null);

  assert.equal(identified.length, 2);
  assert.equal(loose.length, 2);
  assert.deepEqual(
    rows.slice(0, identified.length),
    identified,
    'the identified rows come first; the loose group is the tail of the list',
  );
  assert.deepEqual(
    identified.map((row) => row.no_id),
    ['redigir', 'revisar'],
    'within the version, a stable order by node',
  );
  // No row disappears: a report that hides what it cannot classify lies about
  // the total (the same convention as `metricsByVersion`).
  assert.equal(
    rows.reduce((sum, row) => sum + row.tokens_total, 0),
    4 + 8 + 12 + 16,
  );
});
