/**
 * Acceptance tests of the subgraph node's placeholder resolution (t638,
 * AT12–AT15).
 *
 * Pure, no I/O: `subgraph-map.ts` turns a node's `input_map` into the creation
 * payload of a child job, reads the list a `fan_out` walks, and assembles the
 * node's own output from what the children hand back through `output_map`. The
 * grammar is `docs/spec/graph.md`'s: a value that is exactly one token keeps
 * the resolved type, a token inside text is stringified, a value with no token
 * is a literal — and every unresolved path is reported, not just the first.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as MapModule from '../../src/dispatch/subgraph-map.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/subgraph-map.ts';

/** Imports the module under test, failing with its path while it does not exist. */
async function loadModule(): Promise<typeof MapModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(new URL(`../../${MODULE_PATH}`, import.meta.url).href)) as typeof MapModule;
}

/** The input a parent node is projected, in the part these tests read. */
const INPUT = Object.freeze({
  job: { id: 7, title: 'Weekly digest', body: 'Three notes, in order.' },
  n: 3,
  plan: { items: [{ title: 'first' }, { title: 'second' }], label: 'not a list' },
});

/** The problems a mapping error carries, or a failure when nothing was thrown. */
function problemsOf(run: () => unknown, map: typeof MapModule): readonly string[] {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof map.SubgraphMappingError, `unexpected error: ${String(error)}`);
    return error.problems;
  }
  assert.fail('the mapping resolved, and it was expected to fail closed');
}

test('t638 AT12 — tokens in text are stringified, a lone token keeps its type, a literal stays', async () => {
  const map = await loadModule();

  const payload = map.childPayload(
    {
      class: 'nota-curta',
      input_map: {
        title: 'Note about {{input.job.title}} ({{input.n}} of them)',
        body: '{{input.job.body}}',
        fields: { count: '{{input.n}}', kind: 'digest', heading: '{{item.title}}' },
      },
      output_map: {},
      fan_out: { over: 'plan.items' },
    },
    INPUT,
    { title: 'first' },
  );
  assert.deepEqual(payload, {
    title: 'Note about Weekly digest (3 of them)',
    body: 'Three notes, in order.',
    fields: { count: 3, kind: 'digest', heading: 'first' },
  });

  const bare = map.childPayload(
    { class: 'nota-curta', input_map: { title: '{{item}}' }, output_map: {}, fan_out: { over: 'x' } },
    INPUT,
    'a plain string element',
  );
  assert.deepEqual(bare, { title: 'a plain string element' });
});

test('t638 AT13 — every unresolved path is reported at once, and the payload types are enforced', async () => {
  const map = await loadModule();

  const problems = problemsOf(
    () =>
      map.childPayload(
        {
          class: 'nota-curta',
          input_map: {
            title: '{{input.job.missing}}',
            body: 'About {{input.nowhere.at_all}}',
            fields: { topic: '{{input.plan.ghost}}' },
          },
          output_map: {},
        },
        INPUT,
      ),
    map,
  );
  assert.equal(problems.length, 3, `all three are reported: ${problems.join(' | ')}`);
  assert.ok(problems.some((problem) => problem.includes('input.job.missing')));
  assert.ok(problems.some((problem) => problem.includes('input.nowhere.at_all')));
  assert.ok(problems.some((problem) => problem.includes('input.plan.ghost')));

  const notText = problemsOf(
    () =>
      map.childPayload(
        { class: 'nota-curta', input_map: { title: '{{input.n}}' }, output_map: {} },
        INPUT,
      ),
    map,
  );
  assert.ok(notText.some((problem) => problem.includes('title')), notText.join(' | '));

  const empty = problemsOf(
    () => map.childPayload({ class: 'nota-curta', input_map: { title: '' }, output_map: {} }, INPUT),
    map,
  );
  assert.ok(empty.some((problem) => problem.includes('title')), empty.join(' | '));

  const objectField = problemsOf(
    () =>
      map.childPayload(
        {
          class: 'nota-curta',
          input_map: { title: 'ok', fields: { whole: '{{input.job}}' } },
          output_map: {},
        },
        INPUT,
      ),
    map,
  );
  assert.ok(objectField.some((problem) => problem.includes('whole')), objectField.join(' | '));
});

test('t638 AT14 — the output is the single child value, or an array in sibling order', async () => {
  const map = await loadModule();

  const single = map.assembleOutput(
    { class: 'nota-curta', input_map: { title: 'x' }, output_map: { texts: '{{child.texto}}' } },
    [{ jobId: 12, position: 1, input: { texto: 'the only note' } }],
  );
  assert.deepEqual(single, { texts: 'the only note' });

  const fanned = map.assembleOutput(
    {
      class: 'nota-curta',
      input_map: { title: '{{item}}' },
      output_map: { texts: '{{child.texto}}', label: 'note {{child.n}}' },
      fan_out: { over: 'plan.items', ordered: true },
    },
    [
      { jobId: 22, position: 2, input: { texto: 'second', n: 2 } },
      { jobId: 21, position: 1, input: { texto: 'first', n: 1 } },
      { jobId: 23, position: 3, input: { texto: 'third', n: 3 } },
    ],
  );
  assert.deepEqual(fanned, {
    texts: ['first', 'second', 'third'],
    label: ['note 1', 'note 2', 'note 3'],
  });

  const problems = problemsOf(
    () =>
      map.assembleOutput(
        {
          class: 'nota-curta',
          input_map: { title: '{{item}}' },
          output_map: { texts: '{{child.texto}}' },
          fan_out: { over: 'plan.items' },
        },
        [
          { jobId: 31, position: 1, input: { texto: 'fine' } },
          { jobId: 32, position: 2, input: {} },
        ],
      ),
    map,
  );
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.ok(problems[0].includes('32'), `names the child job: ${problems[0]}`);
  assert.ok(problems[0].includes('child.texto'), `names the path: ${problems[0]}`);
});

test('t638 AT15 — a fan_out.over that is not a list is refused', async () => {
  const map = await loadModule();

  assert.equal(
    map.fanOutItems({ class: 'nota-curta', input_map: { title: 'x' }, output_map: {} }, INPUT),
    null,
    'no fan_out means one child, not a list',
  );
  assert.deepEqual(
    map.fanOutItems(
      { class: 'nota-curta', input_map: { title: 'x' }, output_map: {}, fan_out: { over: 'plan.items' } },
      INPUT,
    ),
    [{ title: 'first' }, { title: 'second' }],
  );

  for (const over of ['plan.label', 'plan', 'plan.nowhere']) {
    const problems = problemsOf(
      () =>
        map.fanOutItems(
          { class: 'nota-curta', input_map: { title: 'x' }, output_map: {}, fan_out: { over } },
          INPUT,
        ),
      map,
    );
    assert.ok(problems.some((problem) => problem.includes(over)), `${over}: ${problems.join(' | ')}`);
  }
});
