/**
 * t313: the prose under `scripts/`, and the comments of `.gitignore`.
 *
 * Neither surface had a gate. `tests/no-portuguese-identifiers.test.mjs` reads
 * the root `tests/` directory and only it; the document-tree sweep walks
 * `docs/`, `notes/`, `schema/` and `specs/`. `scripts/` and the root dotfiles
 * fall between the two, which is why five files there still carried Portuguese
 * through every green run of the suite.
 *
 * Three of those five are the reason this gate is careful rather than eager.
 *
 * ## The frozen three (AT10)
 *
 * `scripts/no-portuguese-prose.mjs` IS the detector: its `DIACRITIC` and
 * `STOPWORD` literals are the Portuguese every D24 gate hunts by. Its test
 * feeds it Portuguese to prove it bites. And
 * `scripts/no-portuguese-identifiers.test.mjs` carries a fixture of Portuguese
 * schema keys and wire vocabulary whose whole job is to prove the sweep does
 * NOT bite the frozen D18 carve-out.
 *
 * In all three the Portuguese is the subject under test, not leftover prose. A
 * sweep that "finished the job" on them would delete the mechanism that enforces
 * this entire ticket family — and it would look like progress while doing it. So
 * they are pinned by content hash: the next sweep that reaches for them fails
 * here first, and reads this docblock.
 *
 * A deliberate change to any of the three is still possible; it updates the hash
 * in the same commit, on purpose, having read why the hash was there.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, STOPWORD } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The three files whose Portuguese is the mechanism, pinned byte for byte.
 *
 * Hashes taken at this ticket's base commit (`dc4e70b`), over the file as
 * tracked. Each entry says what would break if the file were swept, because a
 * hash with no reason beside it is a wall nobody can decide to climb.
 */
const FROZEN_SCRIPTS = Object.freeze([
  Object.freeze({
    file: 'scripts/no-portuguese-prose.mjs',
    sha256: '90f2d2fe5cf650f4bd745d811f96cceb90b311dcab01c82d0636e8655e065c7a',
    // Rehashed by t314, deliberately and in the same commit, which is what the
    // failure message above asks for: FR3 extracted the fence and backtick
    // blanking into this module rather than let a fourth gate transcribe it.
    // Neither literal was touched, and `no-portuguese-prose.test.mjs` still
    // compares both by `toString()` against the text the first two sweeps
    // declared.
    why: 'the `DIACRITIC` and `STOPWORD` literals every D24 gate hunts by',
  }),
  Object.freeze({
    file: 'scripts/no-portuguese-prose.test.mjs',
    sha256: 'd385cf6206b2f660443c8ac0a3fb57ef9c771b9716f2a2eb9641bc0b3e9bfdce',
    why: 'the Portuguese it feeds the detector to prove the detector bites',
  }),
  Object.freeze({
    file: 'scripts/no-portuguese-identifiers.test.mjs',
    sha256: '2e45cdf4f3552f830e4ac78198c469f71b7277325d2c68846d995c03103d55c3',
    why: 'the fixture proving the sweep spares the frozen D18 carve-out',
  }),
]);

/** The `.gitignore` lines that are patterns, in order, unchanged by this ticket. */
const IGNORED_PATTERNS = Object.freeze([
  'node_modules/',
  '.cartografo/',
  '*.db',
  '*.db-shm',
  '*.db-wal',
  'dist/',
  '*.tsbuildinfo',
  '.eslintcache',
  '.flowpilot/',
  '.DS_Store',
]);

/** One repo-relative file, whole. */
function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** The first Portuguese signal a piece of text trips, as a phrase, or `null`. */
function signalIn(text) {
  const diacritic = DIACRITIC.exec(text);
  if (diacritic !== null) return `diacritic "${diacritic[0]}"`;

  const stopword = STOPWORD.exec(text);
  if (stopword !== null) return `stopword "${stopword[0]}"`;

  return null;
}

test('AT8 — validate-graph.mjs cites the glossary in English, section intact', () => {
  const source = read('scripts/validate-graph.mjs');

  assert.ok(source.includes('glossary §5.4'), 'the citation has to read `glossary §5.4`');
  // Escaped, not literal (t314): the needle is a token being searched for, not a
  // sentence, so it costs nothing to spell it in a way the repo-wide sweep can
  // walk past. Same string, same bytes.
  assert.equal(
    source.includes('gloss\u00e1rio'),
    false,
    'the comment still spells the word in Portuguese',
  );

  // The section number is the citation. Translating the word around it and
  // losing the pointer would trade one defect for a worse one.
  assert.ok(source.includes('§5.4'), 'the section pointer of the citation is gone');
  assert.ok(source.includes('t230'), 'the ticket the citation hangs on is gone');

  const offenders = source
    .split('\n')
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter((entry) => DIACRITIC.test(entry.text.replace('§', '')))
    .map((entry) => `scripts/validate-graph.mjs:${String(entry.number)}: ${entry.text.trim()}`);

  assert.deepEqual(offenders, [], `Portuguese survives in the validator:\n${offenders.join('\n')}`);
});

test('AT9 — the AT3c fixture rewrites agentic prose in English, and still rewrites it', () => {
  const source = read('scripts/validate-factory-bundle.test.mjs');

  const start = source.indexOf("test('AT3c");
  assert.ok(start !== -1, 'AT3c is not in `validate-factory-bundle.test.mjs` any more');

  const body = source.slice(start, source.indexOf('\n});', start));
  const instruction = /list\[0\]\.instruction = '([^']*)'/.exec(body)?.[1];
  const description = /list\[0\]\.description = '([^']*)'/.exec(body)?.[1];

  assert.ok(instruction !== undefined, 'AT3c no longer rewrites the instruction');
  assert.ok(description !== undefined, 'AT3c no longer rewrites the description');

  for (const [name, value] of [
    ['instruction', instruction],
    ['description', description],
  ]) {
    const why = signalIn(value);
    assert.equal(why, null, `the AT3c ${name} fixture is still Portuguese: ${why ?? ''} — ${value}`);
  }

  // The point of AT3c is that agentic prose is free to differ from the check it
  // accompanies. A translation that happened to land on the bundle's own wording
  // would still pass AT3c while proving nothing, so the difference is asserted
  // here rather than assumed.
  assert.notEqual(instruction, description, 'the two rewrites have to differ from each other');

  const bundle = JSON.parse(read('factory-graphs/software-development/graph.json'));
  const refine = bundle.nodes.find((node) => node.id === 'refine');
  const check = refine.contract.checks[0];

  assert.equal(check.type, 'agentic', 'AT3c rewrites an agentic check; `refine`’s first one is not');
  assert.notEqual(instruction, check.instruction, "the rewrite has to differ from the check's own");
  assert.notEqual(description, check.description, "the rewrite has to differ from the check's own");
});

test('AT10 — the three frozen scripts are byte-identical to their base-commit content', () => {
  for (const entry of FROZEN_SCRIPTS) {
    const actual = createHash('sha256').update(readFileSync(path.join(ROOT, entry.file))).digest('hex');

    assert.equal(
      actual,
      entry.sha256,
      `${entry.file} changed. Its Portuguese is the subject under test, not leftover prose — ` +
        `it carries ${entry.why}. If the change is deliberate, update the hash in the same ` +
        'commit; if it came from a prose sweep, revert it.',
    );
  }
});

test('AT10 — the frozen three really do carry the Portuguese they are frozen for', () => {
  // Without this, the hashes above would keep passing over three files that had
  // quietly lost their teeth — a pin proves a file did not change, never that it
  // is still worth pinning.
  const detector = read('scripts/no-portuguese-prose.mjs');
  // Escaped for the reason above. These two needles are the sharpest teeth in
  // this file — they are what says the detector still detects — and spelling
  // them as escapes changes neither of them by a byte.
  assert.ok(
    detector.includes('n\u00e3o'),
    'the `STOPWORD` list lost the commonest Portuguese word',
  );
  assert.ok(
    /DIACRITIC = \/\[[^\]]*\u00e7/.test(detector),
    'the `DIACRITIC` class lost its cedilla',
  );

  const carveOut = read('scripts/no-portuguese-identifiers.test.mjs');
  assert.ok(carveOut.includes('doc.nos'), 'the frozen D18 schema-key fixture is gone');
  assert.ok(carveOut.includes('validarGrafo'), 'the pinned export name of the validator is gone');
});

test('AT11 — .gitignore comments read English and every pattern is unchanged', () => {
  const lines = read('.gitignore').split('\n');

  const comments = lines.filter((line) => line.trimStart().startsWith('#'));
  assert.ok(comments.length >= 4, `only ${String(comments.length)} comments; the file lost a section`);

  const offenders = comments
    .map((line) => ({ line, why: signalIn(line) }))
    .filter((entry) => entry.why !== null)
    .map((entry) => `${entry.why ?? ''} — ${entry.line.trim()}`);

  assert.deepEqual(offenders, [], `Portuguese survives in .gitignore:\n${offenders.join('\n')}`);

  const patterns = lines.filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

  assert.deepEqual(
    patterns,
    [...IGNORED_PATTERNS],
    'a pattern line changed. This ticket translates comments; a translated ignore rule is a ' +
      'behaviour change wearing a translation’s clothes.',
  );
});
