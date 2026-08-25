/**
 * D24 gate: no Portuguese prose survives inside a factory bundle (t280, FR9).
 *
 * D18's 2026-08-15 amendment moved "the content of the factory bundles" to
 * English, and t178 translated the graph-document and skill-manifest FORMAT
 * keys. What neither of them reached was the content sitting inside those
 * English-keyed containers: the `instructions` prose of every skill, the node
 * and edge vocabulary, the domain-specific schema property names and the
 * bundle's own README. D24 closes that, one bundle per ticket, and this sweep is
 * what keeps it closed.
 *
 * Complement, not substitute, of `tests/no-portuguese-identifiers.test.mjs`:
 * that one guards identifier POSITIONS in this directory's `.mjs` sources and
 * deliberately masks literals. A factory bundle is nothing but literals — JSON
 * values and Markdown — so it needs a gate that reads exactly what the other one
 * masks.
 *
 * ## Two cheap signals, and why they are enough
 *
 * The sweep does not try to detect Portuguese. It looks for two things that
 * cannot survive an honest translation:
 *
 * - a Portuguese diacritic, which no English word in this repository carries;
 * - a short list of function words that are common enough in Portuguese prose
 *   that a paragraph left behind is certain to contain one, and rare enough as
 *   English tokens that a translated bundle never trips them.
 *
 * Both expressions and the gloss cut live in `scripts/no-portuguese-prose.mjs`
 * since t300, which would otherwise have made a third verbatim copy of them.
 * The raw-line reading below stays here: it is this gate's own answer to a file
 * shape that has no fence, and merging it with the markdown-aware one would be
 * the mistake t287 recorded for the seventeen per-package sweeps.
 *
 * A folded identifier (`banco_de_testes`, `perguntas_respondidas`) carries
 * neither, and that is deliberate: those are cross-package projection keys that
 * this ticket cannot rename on its own — all fourteen of them are listed, with
 * their publisher, in t280's closing note
 * (`notes/2026-08-24-t280-closing-note.md`) — and a gate that flagged them would
 * be red for a reason no bundle edit could fix.
 *
 * ## The gloss exception
 *
 * FR2 asks for the original inline as `(literally "<phrase>")` wherever an
 * English rendering would flatten a nuance the Portuguese carried. Those spans
 * are the one place Portuguese is supposed to survive, so they are cut before
 * the scan rather than exempted per file.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, GLOSS, STOPWORD } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLES_DIR = path.join(ROOT, 'factory-graphs');

/**
 * The bundles this gate does not read yet, each with the ticket that lifts it.
 *
 * The convention is `tests/no-portuguese-identifiers.test.mjs`'s: a carve-out
 * names its subject and its owner, because one with no named owner is how a
 * carve-out becomes permanent. t280 translated `software-development`
 * first, deliberately — the smaller bundle, where the glossary and the
 * hash-recompute procedure got established at lower risk.
 *
 * **The list is empty, and that is the point.** `asymmetric-bets` was the one
 * entry here, held for the second half of D24's series 1; t293 translated it and
 * lifted the skip, so this gate now reads every bundle the repository ships. A
 * new bundle that arrives half-translated does not get an entry — it gets
 * finished before it lands.
 */
export const SKIP_DIRS = Object.freeze([]);

/**
 * Every file under a bundle directory, recursively, as repo-relative paths.
 *
 * @param {string} directory Absolute path to walk.
 * @returns {string[]} Repo-relative paths, files only.
 */
function filesUnder(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      found.push(...filesUnder(absolute));
      continue;
    }
    found.push(path.relative(ROOT, absolute));
  }
  return found;
}

/** The bundle directories this gate reads, skipped ones already removed. */
function bundlesInScope() {
  return readdirSync(BUNDLES_DIR).filter(
    (entry) =>
      statSync(path.join(BUNDLES_DIR, entry)).isDirectory() && !SKIP_DIRS.includes(entry),
  );
}

/**
 * Every offending line of one file, with its number and what tripped it.
 *
 * Reported whole rather than stopping at the first: a half-translated file has
 * dozens, and a gate that named one per run would take dozens of runs to finish.
 *
 * @param {string} relativePath Repo-relative path of the file to read.
 * @returns {string[]} One entry per offending line.
 */
function offendersIn(relativePath) {
  const lines = readFileSync(path.join(ROOT, relativePath), 'utf8').split('\n');
  const found = [];

  lines.forEach((line, index) => {
    const scanned = line.replace(GLOSS, '');
    const diacritic = DIACRITIC.exec(scanned);
    const stopword = STOPWORD.exec(scanned);
    if (diacritic === null && stopword === null) return;

    const why = diacritic === null ? `stopword "${stopword[0]}"` : `diacritic "${diacritic[0]}"`;
    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

test('AT3 — no Portuguese survives in any factory bundle this gate reads', () => {
  const scanned = bundlesInScope().flatMap((bundle) =>
    filesUnder(path.join(BUNDLES_DIR, bundle)),
  );

  assert.ok(
    scanned.length >= 7,
    `only ${String(scanned.length)} files read under factory-graphs/; the sweep is blind`,
  );

  const offenders = scanned.flatMap(offendersIn);

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives inside a factory bundle:\n${offenders.join('\n')}`,
  );
});

test('AT3 — every carve-out still names a bundle that exists', () => {
  const present = readdirSync(BUNDLES_DIR).filter((entry) =>
    statSync(path.join(BUNDLES_DIR, entry)).isDirectory(),
  );

  for (const skipped of SKIP_DIRS) {
    assert.ok(
      present.includes(skipped),
      `SKIP_DIRS names "${skipped}", which is not a bundle any more: a carve-out that ` +
        'outlives its subject is a hole nobody is watching',
    );
  }
});

test('AT3 — the gate really reads both bundles, neither of them skipped', () => {
  const inScope = bundlesInScope();

  for (const bundle of ['software-development', 'asymmetric-bets']) {
    assert.ok(
      inScope.includes(bundle),
      `"${bundle}" cannot be skipped: holding both translated bundles is what this gate exists for`,
    );
  }

  assert.deepEqual(
    [...SKIP_DIRS],
    [],
    'D24 series 1 is closed on both bundles: a carve-out here would reopen half of it',
  );
});
