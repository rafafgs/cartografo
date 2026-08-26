/**
 * t316: the fixture prose of the two small test packages and the root suite.
 *
 * The tail of the t312 split. Six files carried the last sixteen Portuguese
 * diacritics outside the surfaces t313 and t315 owned, and only four of them
 * are prose a sweep may touch. The other two sites are content that has to stay
 * exactly as written, and telling the two groups apart is the whole job:
 *
 * - `packages/cost-surveyor/test/client.test.ts` builds an `expected_metric`
 *   whose `{nome, direcao, de, para}` is the frozen hypothesis shape of t255,
 *   documented at `docs/spec/surveyor-cost.md` §5.5 and
 *   `docs/spec/glossary-wire.md`. The candidate's own keys read English; what
 *   the field CARRIES is wire, and translating wire would desynchronize the
 *   test from the contract it exercises.
 * - `tests/factory-graph-1.test.mjs` quotes, inside a comment, the retired
 *   sentence its assertion below refuses. It is a verbatim quotation of
 *   pre-existing text, which the language convention allows by name, and the
 *   comment already says so.
 *
 * Both are pinned here as content that must NOT move, so the next sweep to
 * reach for them fails on this file first and reads why.
 *
 * ## Why this is not a `no-portuguese-*` gate
 *
 * t314 made the language gates a permanent exception: they are the only files
 * allowed to spell the Portuguese they hunt, and this ticket may not edit or
 * extend any of them. None of them reads these six files' string literals
 * either — the two per-package sweeps read `src/*.ts`, and
 * `tests/no-portuguese-identifiers.test.mjs` reads identifier positions with
 * every literal and comment quote blanked. So this is an ordinary acceptance
 * suite, named without the prefix so it is never mistaken for one of them.
 *
 * ## What AT7 pins, and what it does not
 *
 * AT7 asks that no suite lose a test case to a translation. It counts the test
 * declarations of each file against the count measured before the first edit
 * landed, rather than spawning the six suites: `npm test` already RUNS all six
 * — four in the workspaces group, two in this very group — so what is missing
 * from a green run is not the execution but the comparison against the earlier
 * number, and a count is exactly that comparison. The counts below were each
 * confirmed to equal what `node --test` reports for the file, so a drift here
 * is a drift in the suite and not in the regular expression.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The six files, by the short name the tests below call each one. */
const FILES = Object.freeze({
  cli: 'packages/cost-surveyor/test/cli.test.ts',
  client: 'packages/cost-surveyor/test/client.test.ts',
  policy: 'packages/cost-surveyor/test/policy.test.ts',
  watch: 'packages/surveyor/test/watch.e2e.test.ts',
  factoryGraph1: 'tests/factory-graph-1.test.mjs',
  factoryGraph2: 'tests/factory-graph-2.test.mjs',
});

/**
 * Test declarations per file, measured on the pre-ticket tree and equal, file
 * by file, to the `tests` line `node --test` printed for it.
 */
const BASELINE_DECLARATIONS = Object.freeze({
  cli: 8,
  client: 9,
  policy: 8,
  watch: 1,
  factoryGraph1: 31,
  factoryGraph2: 23,
});

/** A top-level test declaration, `await`ed or not. */
const DECLARATION = /^[ \t]*(?:await[ \t]+)?test\(/gm;

/** The stale citation both root suites carried, and what the spec reads today. */
const CITATION = '(`specs/formats/skill-manifest.md`, "Identification" section)';

/** @param {keyof FILES} key @returns {string} The file, as text. */
function read(key) {
  return readFileSync(path.join(ROOT, FILES[key]), 'utf8');
}

/** Every 1-based line of `source` carrying a Portuguese diacritic. */
function diacriticLines(source) {
  return source
    .split('\n')
    .flatMap((line, index) => (DIACRITIC.test(line) ? [index + 1] : []));
}

/** One comment span, rejoined into the sentence a reader sees. */
function commentProse(lines) {
  return lines
    .join(' ')
    .replace(/\s*\/\/\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('AT1 — the cost-surveyor CLI seeds its sessions with an English prompt', () => {
  const source = read('cli');

  assert.ok(
    source.includes('prompt: `work node ${nodeId}`'),
    'seedSession has to post the translated prompt: it is opaque fixture input, asserted nowhere',
  );
  assert.deepEqual(diacriticLines(source), [], `${FILES.cli} still carries Portuguese`);
});

test('AT2 — the frozen t255 expected_metric shape is untouched, and is the only Portuguese left', () => {
  const source = read('client');
  const lines = source.split('\n');
  const marked = diacriticLines(source);

  assert.deepEqual(
    marked.length,
    1,
    `${FILES.client} should carry Portuguese on exactly one line, found ${marked.length}`,
  );

  const frozen = lines[marked[0] - 1];
  assert.match(frozen, /expected_metric:/, 'the one Portuguese line has to be the wire shape');
  for (const fragment of ['nome:', 'direcao:', 'de: 5000', 'para: 1000']) {
    assert.ok(
      frozen.includes(fragment),
      `expected_metric lost \`${fragment}\`: it is t255's frozen hypothesis shape, not prose`,
    );
  }
});

test('AT3 — the policy fixtures describe their nodes in English', () => {
  const source = read('policy');

  assert.ok(
    source.includes('`description of ${nodeId} at ${graphVersionId}`'),
    'the currentDescription fixture has to read English',
  );
  assert.ok(
    source.includes('`description of ${candidate.node_id} at sha256:v1`'),
    'the assertion has to stay in step with the fixture it reads back',
  );
  assert.ok(
    source.includes("'current description'"),
    "the t234 fixture's current description has to read English",
  );
  assert.deepEqual(diacriticLines(source), [], `${FILES.policy} still carries Portuguese`);
});

test('AT4 — the watcher e2e submits an English semantic diff, in both directions', () => {
  const source = read('watch');
  const before = 'Checks the note against the declared theme and closes the crossing.';
  const after = 'Checks the note against the declared theme, with a three-item checklist.';

  for (const sentence of [before, after]) {
    const occurrences = source.split(`'${sentence}'`).length - 1;
    assert.equal(
      occurrences,
      2,
      `"${sentence}" should appear twice — once in the operation, once in its inverse — found ${occurrences}`,
    );
  }
  assert.deepEqual(diacriticLines(source), [], `${FILES.watch} still carries Portuguese`);
});

test('AT5 — factory graph 1 cites the heading the spec really has, and keeps its quotation', () => {
  const source = read('factoryGraph1');
  const lines = source.split('\n');

  assert.ok(
    source.includes(CITATION),
    'the citation has to name the English heading `specs/formats/skill-manifest.md` emits today',
  );

  const marked = diacriticLines(source);
  assert.equal(
    marked.length,
    2,
    `${FILES.factoryGraph1} should carry Portuguese on exactly two lines, found ${marked.length}`,
  );
  assert.ok(
    commentProse(marked.map((line) => lines[line - 1])).includes(
      'aberta só para o endereço de loopback',
    ),
    'the two Portuguese lines have to be the verbatim quotation of the sentence AT10 refuses',
  );
});

test('AT6 — factory graph 2 cites the heading the spec really has, and nothing else is Portuguese', () => {
  const source = read('factoryGraph2');

  assert.ok(source.includes(CITATION), 'the citation has to name the English heading of the spec');
  assert.deepEqual(
    diacriticLines(source),
    [],
    `${FILES.factoryGraph2} still carries Portuguese`,
  );
});

test('AT7 — no suite lost a test case to the translation', () => {
  const counted = Object.fromEntries(
    Object.keys(FILES).map((key) => [key, (read(key).match(DECLARATION) ?? []).length]),
  );

  assert.deepEqual(
    counted,
    { ...BASELINE_DECLARATIONS },
    'a suite declares a different number of tests than it did before this ticket',
  );
});
