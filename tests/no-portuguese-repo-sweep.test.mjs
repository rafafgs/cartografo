/**
 * D24's backstop: every tracked file, path and content, read for Portuguese
 * (t314).
 *
 * The last ticket of the series, and the only one that makes the result stay
 * true. Every sibling removed Portuguese from one place — t280 the factory
 * bundles, t281 the wire glossary, t293/t299 the reader-facing documents, t300
 * the internal record, t282/t303/t305/t306 the path segments, t311 the
 * migration comments, t326 the last document name. None of them stops a NEW
 * Portuguese sentence from landing tomorrow in a tract none of them walks, and
 * there are many: the twenty-eight existing sweeps between them read `docs/`,
 * `notes/`, `schema/`, `specs/`, `factory-graphs/`, the migrations, an explicit
 * per-package file list and the root `tests/` directory. Nothing reads
 * everything.
 *
 * This one does. `git ls-files`, every path, both signals, two exceptions.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/** Generated artefacts this project does not author (FR2). */
export const GENERATED_ARTIFACTS = Object.freeze(['package-lock.json']);

/** The two permanent exceptions (FR5). Not implemented yet. */
export const EXCEPTIONS = Object.freeze([]);

/** Every tracked path this gate walks. Not implemented yet. */
export function trackedPaths() {
  throw new Error('t314: trackedPaths is not implemented yet');
}

/** Every offender of one file, path and content. Not implemented yet. */
export function offendersIn() {
  throw new Error('t314: offendersIn is not implemented yet');
}

/** Every offender of a whole file set. Not implemented yet. */
export function scan() {
  throw new Error('t314: scan is not implemented yet');
}

/** Reads one tracked file off disk, as `scan` wants it. Not implemented yet. */
export function readTracked() {
  throw new Error('t314: readTracked is not implemented yet');
}

test('AT1 — no Portuguese survives anywhere in the tracked tree', () => {
  const paths = trackedPaths();

  assert.ok(
    paths.length >= 400,
    `only ${String(paths.length)} tracked paths walked; the sweep is blind`,
  );

  const offenders = scan(paths.map(readTracked));

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives in the tracked tree:\n${offenders.join('\n')}`,
  );
});

test('AT2 — the gates are spared, whichever of the four shapes names them', () => {
  const gates = [
    'packages/core/test/no-portuguese-wire.test.ts',
    'tests/no-portuguese-document-tree.test.mjs',
    'scripts/no-portuguese-prose.mjs',
    'tests/notes-redaction.test.mjs',
    'tests/no-portuguese-repo-sweep.test.mjs',
  ];

  const portuguese = 'Uma linha que não devia passar, com um acento e uma palavra.';

  assert.deepEqual(
    scan(gates.map((path) => ({ path, contents: portuguese }))),
    [],
    'a gate enumerates what it forbids: a sweep that read one would disarm itself',
  );
});

test('AT3 — the migration exception is a prefix on the directory and nothing wider', () => {
  const name = '0002_grafo_versao_proposta_com_condicao.sql';
  const clean = '-- a migration comment, in English\n';

  assert.deepEqual(
    scan([{ path: `packages/core/migrations/${name}`, contents: clean }]),
    [],
    'a migration filename is `schema_migrations.id`, checksummed and resolved by name (t279)',
  );

  assert.deepEqual(
    scan([{ path: `packages/core/src/${name}`, contents: clean }]),
    [`packages/core/src/${name}: path segment "${name}": stopword "com"`],
    'the same name one directory over is read like any other path',
  );
});

test('AT4 — a bare stopword is reported, and a marked one is not', () => {
  const path = 'packages/core/src/domain/example.ts';
  const bare = '// The report is written para the reviewer, once.\n';

  assert.deepEqual(
    scan([{ path, contents: bare }]),
    [`${path}:1: stopword "para" — // The report is written para the reviewer, once.`],
    'an ordinary Portuguese word in ordinary source is exactly what this gate is for',
  );

  assert.deepEqual(
    scan([{ path, contents: '// The report is written `para` the reviewer, once.\n' }]),
    [],
    'a backtick span is a machine name being quoted, not a word of the sentence',
  );

  assert.deepEqual(
    scan([{ path, contents: '// The report is written (literally "para") the reviewer.\n' }]),
    [],
    'the gloss is the one span where the original is supposed to survive',
  );
});

test('AT5 — the exception list has exactly two entries, each with a reason', () => {
  assert.equal(
    EXCEPTIONS.length,
    2,
    'AC3: the gates, and the frozen migration filenames. A third entry is a hole',
  );

  for (const entry of EXCEPTIONS) {
    assert.ok(entry.name.length > 0, 'an exception with no name is not readable');
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 40,
      `"${entry.name}" has no reason worth reading`,
    );
  }
});
