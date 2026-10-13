/**
 * Acceptance tests for `{{input_file.<path>}}` in the interpolation (t689, FR1–FR4).
 *
 * `{{input.<path>}}` puts a value into the text; `{{input_file.<path>}}` puts the
 * absolute path of a file holding that value. The grammar, the own-property walk
 * and the fail-closed rule are the same ones — what is new is the collector the
 * caller hands over, which says where the files will live and receives the plan
 * of what is to be written there. Nothing is written here: the function is pure.
 *
 * What does NOT change is pinned from the other side: a caller that passes no
 * collector (the MCP argument interpolation) gets `{{input_file.…}}` left alone,
 * byte for byte as before.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  interpolate,
  type InputFileCollector,
} from '../../src/dispatch/interpolate-input.ts';

const DIR = path.join(path.sep, 'scratch', 'job-7', '0123456789abcdef');

function collector(dir: string | null = DIR): InputFileCollector {
  return { dir, planned: [] };
}

test('AT1 — a file token resolves to an absolute path ending in the dotted path and plans one entry', () => {
  const files = collector();
  const unresolved: string[] = [];

  const text = interpolate('cat {{input_file.a.b}}', { a: { b: 'hello' } }, unresolved, files);

  const expected = path.join(DIR, 'a.b.json');
  assert.equal(text, `cat ${expected}`);
  assert.ok(path.isAbsolute(expected));
  assert.deepEqual(unresolved, []);
  assert.deepEqual(files.planned, [
    { placeholderPath: 'a.b', filePath: expected, content: 'hello' },
  ]);
});

test('AT1 — a string is the content verbatim, anything else is compact JSON', () => {
  const files = collector();
  const input = {
    s: 'line one\n  "quoted"',
    o: { k: [1, 2], n: null },
    z: null,
    e: '',
    n: 30,
    f: false,
    list: ['a', 'b'],
  };

  interpolate(
    ['s', 'o', 'z', 'e', 'n', 'f', 'list'].map((name) => `{{input_file.${name}}}`).join(' '),
    input,
    [],
    files,
  );

  const contentOf = (name: string): string | undefined =>
    files.planned.find((entry) => entry.placeholderPath === name)?.content;
  assert.equal(contentOf('s'), 'line one\n  "quoted"');
  assert.equal(contentOf('o'), '{"k":[1,2],"n":null}');
  assert.equal(contentOf('z'), 'null');
  assert.equal(contentOf('e'), '', 'an empty string is an empty file');
  assert.equal(contentOf('n'), '30');
  assert.equal(contentOf('f'), 'false');
  assert.equal(contentOf('list'), '["a","b"]');
});

test('AT1 — two tokens for one path share one plan entry and one path text', () => {
  const files = collector();

  const text = interpolate(
    '{{input_file.x}} and again {{input_file.x}}',
    { x: 'once' },
    [],
    files,
  );

  const file = path.join(DIR, 'x.json');
  assert.equal(text, `${file} and again ${file}`);
  assert.equal(files.planned.length, 1);
});

test('AT1 — a path that does not resolve is unresolved as input_file.<path>, and the text keeps the token', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['{{input_file.missing}}', {}],
    ['{{input_file.a.b}}', { a: 'a string, not an object' }],
    ['{{input_file.a.b}}', { a: ['array'] }],
    ['{{input_file.constructor.name}}', {}],
    ['{{input_file.}}', { '': 1 }],
    ['{{input_file.a-b}}', { 'a-b': 1 }],
  ];

  for (const [template, input] of cases) {
    const files = collector();
    const unresolved: string[] = [];

    const text = interpolate(template, input, unresolved, files);

    assert.equal(text, template, `the token stays in the text: ${template}`);
    assert.equal(unresolved.length, 1, `${template} is reported once`);
    assert.ok(
      unresolved[0]?.startsWith('input_file.'),
      `recorded as input_file.<path>: ${String(unresolved[0])}`,
    );
    assert.deepEqual(files.planned, [], `nothing is planned for ${template}`);
  }
});

test('AT1 — the unresolved path is the one written in the token', () => {
  const unresolved: string[] = [];
  interpolate('{{input_file.a.b}}', {}, unresolved, collector());
  assert.deepEqual(unresolved, ['input_file.a.b']);
});

test('AT1 — input and input_file share one string: x is the text, y is the path, both kinds report in first-occurrence order', () => {
  const files = collector();
  const text = interpolate('{{input.x}} -> {{input_file.y}}', { x: 'text', y: 'doc' }, [], files);
  assert.equal(text, `text -> ${path.join(DIR, 'y.json')}`);

  const unresolved: string[] = [];
  interpolate(
    '{{input.gone}} {{input_file.never}} {{input.gone}} {{input.later}} {{input_file.never}}',
    {},
    unresolved,
    collector(),
  );
  assert.deepEqual(unresolved, ['gone', 'input_file.never', 'later']);
});

test('AT1 — without a collector a file token is left alone and nothing is reported', () => {
  const unresolved: string[] = [];

  const text = interpolate('{{input_file.a}} {{input.b}}', { b: 'kept' }, unresolved);

  assert.equal(text, '{{input_file.a}} kept');
  assert.deepEqual(unresolved, []);
});

test('AT1 — with a collector whose directory is null the token is unresolved, never left in the text as a pass', () => {
  const files = collector(null);
  const unresolved: string[] = [];

  const text = interpolate('{{input_file.a}}', { a: 'present' }, unresolved, files);

  assert.equal(text, '{{input_file.a}}');
  assert.deepEqual(unresolved, ['input_file.a']);
  assert.deepEqual(files.planned, []);
});

test('AT1 — {{input.<path>}} renders exactly as before, with or without a collector', () => {
  const input = { a: { b: 'str' }, n: 5, o: { k: 1 }, z: null };
  const template = '{{input.a.b}}|{{input.n}}|{{input.o}}|{{input.z}}';

  assert.equal(interpolate(template, input, []), 'str|5|{"k":1}|null');
  assert.equal(interpolate(template, input, [], collector()), 'str|5|{"k":1}|null');
});
