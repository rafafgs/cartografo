/**
 * Acceptance tests of t176 — the bundle validator's cross-check between a
 * node's `contract.checks` and the `checks` of the manifest its `skill_ref`
 * pins.
 *
 * The rule under test is structural, and only structural: same item count,
 * same sequence of `type` position by position, and a byte-identical `command`
 * on every `deterministic` item. The prose of an `agentic` item is
 * deliberately NOT compared. The two are distinct FORMATS for the same
 * verification, not the same field duplicated — `required_evidence` is a
 * list of artifacts in the manifest and the literal `true` in the graph — and
 * `packages/runner/src/synthesizer/prompt.ts` instructs the synthesizer to
 * REWRITE the verification on each side rather than copy it. A rule that
 * demanded identical prose would reject `asymmetric-bets`, which lines up
 * today and has no bug reported against it.
 *
 * Every fixture is a COPY of the real bundle in a temp dir, mutated on the
 * graph side only: editing a manifest would change its content hash, and the
 * bundle would then be rejected for the pin instead of for the divergence
 * under test.
 *
 * The keys read below (`nodes`, `contract`, `checks`, `type`, `command`,
 * `skill_ref`) are the graph-bundle and skill-manifest JSON Schema, English
 * since t178, and the node ids are English since t280: these tests read that
 * bundle, they do not own it.
 *
 * Run with: `node --test scripts/`
 */

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateBundle } from './validate-factory-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_BUNDLE = path.join(ROOT, 'factory-graphs', 'software-development');

/** A throwaway copy of the real bundle, ready to be mutated. */
function bundleCopy() {
  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-t176-')), 'bundle');
  cpSync(SOURCE_BUNDLE, copy, { recursive: true });
  return copy;
}

/**
 * Rewrites the copied graph after `mutate` has changed one node's list of
 * verifications in place.
 *
 * @param {string} bundle Directory of the copy.
 * @param {string} id Id of the node to touch.
 * @param {(list: Array<object>) => void} mutate What to do to the list.
 * @returns {string} The same directory, for chaining into `validateBundle`.
 */
function editGraph(bundle, id, mutate) {
  const target = path.join(bundle, 'grafo.json');
  const doc = JSON.parse(readFileSync(target, 'utf8'));
  const found = doc.nodes.find((candidate) => candidate.id === id);
  assert.ok(found, `the bundle no longer has a node "${id}"`);
  mutate(found.contract.checks);
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  return bundle;
}

/** Everything the report filed against a pin, flattened into one list. */
const problemsOf = (report) => report.pins.flatMap((pin) => pin.problems);

/** The whole report, for an assertion message that says why it failed. */
const explain = (report) =>
  JSON.stringify({ errors: report.errors, pins: report.pins }, null, 2);

test('AT1 — a bundle whose verifications line up with the pinned checks is valid', () => {
  const report = validateBundle(bundleCopy());

  assert.deepEqual(problemsOf(report), [], 'no pin should have a problem');
  assert.equal(report.valid, true, explain(report));
});

test('AT2 — a deterministic command that diverges from the check fails the bundle', () => {
  const bundle = editGraph(bundleCopy(), 'integrate', (list) => {
    list[0].command = 'make check';
  });

  const report = validateBundle(bundle);

  assert.equal(report.valid, false, 'a diverging command has to fail the bundle');
  const pin = report.pins.find((candidate) => candidate.node === 'integrate');
  assert.equal(pin.ok, false, 'the pin of the affected node has to carry the problem');
  assert.ok(
    pin.problems.some((problem) => problem.includes('make check')),
    `the report has to name the divergence:\n${explain(report)}`,
  );
});

test('AT3 — one item too few or one too many fails the bundle', () => {
  const short = validateBundle(
    editGraph(bundleCopy(), 'develop', (list) => {
      list.pop();
    }),
  );
  assert.equal(short.valid, false, 'one verification short has to fail the bundle');
  assert.ok(
    short.pins.find((candidate) => candidate.node === 'develop')?.ok === false,
    `the pin of the affected node has to carry the problem:\n${explain(short)}`,
  );

  const long = validateBundle(
    editGraph(bundleCopy(), 'develop', (list) => {
      list.push(structuredClone(list[0]));
    }),
  );
  assert.equal(long.valid, false, 'one verification too many has to fail the bundle');
  assert.ok(
    long.pins.find((candidate) => candidate.node === 'develop')?.ok === false,
    `the pin of the affected node has to carry the problem:\n${explain(long)}`,
  );
});

test('AT3b — the same items in another order fail the bundle', () => {
  const bundle = editGraph(bundleCopy(), 'develop', (list) => {
    list.reverse();
  });

  const report = validateBundle(bundle);

  assert.equal(report.valid, false, 'the sequence is compared position by position');
  assert.ok(
    report.pins.find((candidate) => candidate.node === 'develop')?.ok === false,
    `the pin of the affected node has to carry the problem:\n${explain(report)}`,
  );
});

test('AT3c — the prose of an agentic item is free to differ from the check', () => {
  const bundle = editGraph(bundleCopy(), 'refine', (list) => {
    list[0].instruction = 'Pergunta reescrita neste formato, com outras palavras.';
    list[0].description = 'Outra redação da mesma prova.';
  });

  const report = validateBundle(bundle);

  assert.deepEqual(problemsOf(report), [], 'rewriting agentic prose is the documented discipline');
  assert.equal(report.valid, true, explain(report));
});
