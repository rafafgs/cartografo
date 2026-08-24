/**
 * Gate: the numbers a bundle translation produced are written down, and true
 * (t295, from t280's Definition of Done #8-9).
 *
 * t280 translated `grafos-de-fabrica/desenvolvimento-de-software` and its
 * Definition of Done asked the closing note for three things the next bundle
 * would need in order to plan: the per-file line counts before and after, the
 * full `{old id, old version, old hash} -> {new id, new version, new hash}`
 * table, and any phrase that resisted faithful translation. None of the three
 * were recorded anywhere. The ticket body ends at its refinement log and no
 * stage writes a body outside refinement; the implementation commit explains
 * the four untranslated projection roots but carries no table. The alpha-test
 * round found the gap by looking for the numbers and not finding them — and
 * `tests/no-portuguese-factory-bundles.test.mjs` was already pointing at "the
 * closing note of t280" as if it existed.
 *
 * So the note is a file in the repository now, and this is what keeps it
 * honest. The point is not that a note exists — that much a human can see. The
 * point is that every number in it is checked against the live bundle, because
 * a hash table transcribed by hand is exactly the kind of record that is wrong
 * on the day it is written and believed for months afterwards.
 *
 * ## When this gate goes red because the bundle moved
 *
 * Everything here compares the note's AFTER side with the bundle as it stands
 * now, so the first ticket to bump a skill, add a file or retranslate a line
 * will break it. That is the intended failure, not an accident: the fix is to
 * write your own note and repoint `CLOSING_NOTE` below at it, the way
 * `tests/no-portuguese-factory-bundles.test.mjs`'s `SKIP_DIRS` names the bundle
 * it does not read yet. t280's note is history and is not to be edited to match
 * a bundle it never described.
 *
 * The BEFORE side is checked only for shape. It is a claim about commit
 * `526dec9^`, which no working tree can confirm and no future edit can falsify.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { manifestHash } from '../scripts/validate-factory-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The note under gate, and the bundle whose numbers it claims to record. */
export const CLOSING_NOTE = path.join('notas', '2026-08-24-t280-closing-note.md');

/** The bundle the note describes, relative to the repository root. */
export const BUNDLE = path.join('grafos-de-fabrica', 'desenvolvimento-de-software');

/** The sweep whose docblock cites the note; the citation has to resolve. */
export const CITING_GATE = path.join('tests', 'no-portuguese-factory-bundles.test.mjs');

/** The one span where the Portuguese original is allowed to survive (t280 FR2). */
const GLOSS = /\(literally "[^"]*"\)/g;

/**
 * Reads a repository file as text.
 *
 * @param {string} relativePath Repo-relative path.
 * @returns {string} The file's contents.
 */
function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Line count of a repository file, counted the way `wc -l` counts.
 *
 * The note's numbers came from `wc -l`, and so did the ones t280's own body
 * quoted, so the gate has to count the same way or every row would be off by
 * one on files that end with a newline.
 *
 * @param {string} relativePath Repo-relative path.
 * @returns {number} Newline-terminated lines.
 */
function lineCount(relativePath) {
  const text = read(relativePath);
  const split = text.split('\n');
  return text.endsWith('\n') ? split.length - 1 : split.length;
}

/**
 * Every file of the bundle, recursively, as bundle-relative POSIX paths.
 *
 * @param {string} directory Repo-relative directory to walk.
 * @returns {string[]} Sorted bundle-relative paths, files only.
 */
function bundleFiles(directory = BUNDLE) {
  const found = [];
  for (const entry of readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...bundleFiles(child));
      continue;
    }
    found.push(path.relative(BUNDLE, child).split(path.sep).join('/'));
  }
  return found.sort();
}

/**
 * The rows of the one markdown table under a heading of the note.
 *
 * Reads to the next heading rather than to the end of the file, so a table
 * moved under the wrong heading is a miss instead of a silent match.
 *
 * @param {string} note The note's text.
 * @param {string} heading The exact heading line, `## …` included.
 * @returns {string[][]} One array of trimmed, backtick-stripped cells per row.
 */
function tableUnder(note, heading) {
  const lines = note.split('\n');
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `the closing note has no "${heading}" section`);

  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim().replace(/^`|`$/g, ''));
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    rows.push(cells);
  }

  assert.ok(rows.length >= 2, `the "${heading}" section has no table with rows`);
  return rows;
}

/**
 * The graph's five pinned nodes, keyed by node id.
 *
 * @returns {Map<string, {id: string, version: string, hash: string}>} The pins.
 */
function graphPins() {
  const graph = JSON.parse(read(path.join(BUNDLE, 'grafo.json')));
  return new Map(
    graph.nodes
      .filter((node) => node.skill_ref !== undefined)
      .map((node) => [node.id, node.skill_ref]),
  );
}

test('AT1 — the note records a before and an after line count for every file of the bundle', () => {
  const [header, ...rows] = tableUnder(read(CLOSING_NOTE), '## Line counts');

  assert.deepEqual(header, ['File', 'Old name', 'Before', 'After']);

  assert.deepEqual(
    rows.map((row) => row[0]).sort(),
    bundleFiles(),
    'the note covers a different set of files than the bundle holds: the bundle moved ' +
      'past t280, so record the new counts in a note of your own and repoint CLOSING_NOTE',
  );

  for (const [file, oldName, before, after] of rows) {
    assert.match(before, /^\d+$/, `${file}: "before" is not a line count`);
    assert.ok(Number(before) > 0, `${file}: "before" is zero`);

    assert.equal(
      Number(after),
      lineCount(path.join(BUNDLE, file)),
      `${file}: the note says ${after} lines and the file has ` +
        `${String(lineCount(path.join(BUNDLE, file)))}`,
    );

    if (oldName === '—') continue;
    assert.equal(
      existsSync(path.join(ROOT, BUNDLE, oldName)),
      false,
      `${file}: the note calls "${oldName}" the old name, but that file is still there`,
    );
  }
});

test('AT2 — the note records the full id/version/hash table, and the new side is the live pin', () => {
  const [header, ...rows] = tableUnder(read(CLOSING_NOTE), '## Skill pins');
  const pins = graphPins();

  assert.deepEqual(header, [
    'Node',
    'Old id',
    'Old version',
    'Old hash',
    'New id',
    'New version',
    'New hash',
  ]);

  assert.deepEqual(
    rows.map((row) => row[0]).sort(),
    [...pins.keys()].sort(),
    'the note names different nodes than the graph pins',
  );

  for (const [node, oldId, oldVersion, oldHash, newId, newVersion, newHash] of rows) {
    const manifest = JSON.parse(read(path.join(BUNDLE, 'skills', `${newId}.json`)));

    assert.equal(manifest.id, newId, `${node}: the manifest file and its id disagree`);
    assert.equal(manifest.version, newVersion, `${node}: the note's new version is not the manifest's`);
    assert.equal(
      manifestHash(manifest),
      newHash,
      `${node}: the note's new hash is not what manifestHash() computes for ${newId}`,
    );

    assert.deepEqual(
      pins.get(node),
      { id: newId, version: newVersion, hash: newHash },
      `${node}: the note's new side is not what grafo.json pins`,
    );

    assert.notEqual(oldId, newId, `${node}: the note records no rename`);
    assert.notEqual(oldVersion, newVersion, `${node}: the note records no version bump`);
    assert.notEqual(oldHash, newHash, `${node}: the note records no rehash`);
    assert.match(oldHash, /^sha256:[0-9a-f]{64}$/, `${node}: the old hash is not a hash`);
  }
});

test('AT3 — the note names what resisted translation, and every name is really still there', () => {
  const note = read(CLOSING_NOTE);
  const [header, ...rows] = tableUnder(note, '## What resisted translation');

  assert.deepEqual(header, ['Identifier', 'Survives in', 'Why it was kept']);

  for (const [identifier, where, why] of rows) {
    assert.ok(why.length > 0, `${identifier}: no reason recorded`);

    const files = where.split(',').map((cell) => cell.trim().replace(/^`|`$/g, ''));
    assert.ok(files.length > 0, `${identifier}: no file named`);

    for (const file of files) {
      const inBundle = path.join(BUNDLE, file);
      assert.ok(existsSync(path.join(ROOT, inBundle)), `${identifier}: ${file} does not exist`);
      assert.ok(
        read(inBundle).includes(identifier),
        `${identifier}: the note says it survives in ${file}, and it does not`,
      );
    }
  }
});

test('AT3 — the gloss count the note reports is the bundle\'s real one', () => {
  const declared = /glosses in the bundle: \*\*(\d+)\*\*/.exec(read(CLOSING_NOTE));

  assert.notEqual(declared, null, 'the note does not report how many glosses the translation needed');

  const actual = bundleFiles().reduce(
    (total, file) => total + (read(path.join(BUNDLE, file)).match(GLOSS) ?? []).length,
    0,
  );

  assert.equal(
    Number(declared[1]),
    actual,
    `the note reports ${declared[1]} inline glosses and the bundle carries ${String(actual)}`,
  );
});

test('AT3 — the sweep that cites the closing note cites a note that exists', () => {
  assert.ok(
    read(CITING_GATE).includes(CLOSING_NOTE),
    `${CITING_GATE} points at t280's closing note without naming where it is; a citation ` +
      'nobody can follow is how the note went unwritten in the first place',
  );
});
