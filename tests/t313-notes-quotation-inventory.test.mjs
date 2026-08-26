/**
 * t313: the Portuguese under `notes/` is quotation, and stays.
 *
 * This gate exists to make a NEGATIVE result readable. Twenty-six lines across
 * ten notes carry a Portuguese diacritic, and a sweep counting characters reads
 * that as twenty-six violations. It is zero. Every one of them is a verbatim
 * quotation of pre-existing Portuguese — a column name a decision retired, a
 * phrase the founder actually said, a literal string some code splits on — or a
 * `(literally "…")` gloss, which is D24's own escape hatch for the case where an
 * English rendering would flatten the nuance the original carried.
 *
 * The founder's instruction on this ticket was to LIST them rather than leave
 * them out quietly, because the ticket that finally gates fenced content has to
 * tell a sanctioned quotation from a leftover, and re-deriving that judgment
 * from twenty-six lines of prose is how the judgment gets made differently the
 * second time. The inventory below is that list, and this gate is what keeps it
 * honest: an entry naming a line that stopped carrying Portuguese is a stale
 * carve-out, and it fails here rather than silently protecting nothing.
 *
 * ## What "still marked" means, and why it is checked separately
 *
 * Being present is not enough. The document-tree sweep only spares a quotation
 * it can SEE is marked, and its `SPAN` matcher is line-scoped on purpose (see
 * the comment on `SPAN` in `tests/no-portuguese-document-tree.test.mjs`:
 * widening it was tried and reverted, because one unbalanced backtick above
 * inverts every pairing after it). So a correctly marked quotation that wraps
 * across a line break trips the gate anyway. Rather than re-implement that
 * reading here, this gate runs the real one — `contentOffendersIn` — and demands
 * silence on every inventoried line.
 *
 * Zero edits to `notes/` are this ticket's requirement, and AC3's rule is the
 * one it cannot trade: translate the language of the notes, never their facts.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC } from '../scripts/no-portuguese-prose.mjs';
import { contentOffendersIn } from './no-portuguese-document-tree.test.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Every Portuguese diacritic, which is WIDER than the one the D24 gates hunt by.
 *
 * `scripts/no-portuguese-prose.mjs`'s `DIACRITIC` is `[çãõáéíóúê]`, and that
 * class does not cover `â`, `à`, `ô` or `ü`. The inventory below was measured
 * with the full set, so two of its twenty-six lines — both spelling
 * `parâmetros` — carry a character the gates are blind to. Measuring the
 * inventory with the gate's own narrower class would silently drop those two and
 * report a complete list that was missing exactly the lines nothing else watches.
 *
 * The gap is real and it is NOT this ticket's to close: widening the detector is
 * a change to `no-portuguese-prose.mjs`, which FR10 freezes because its literals
 * are the mechanism every gate in this family runs on. It is pinned below
 * instead, so the ticket that does widen it finds this note first.
 */
const ANY_DIACRITIC = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/;

/**
 * Every surviving diacritic under `notes/`, by file and line, with its reason.
 *
 * Measured 2026-08-26. Ten files, twenty-six lines, zero violations.
 */
const SANCTIONED = Object.freeze([
  Object.freeze({
    file: 'notes/2026-08-17-second-bets-run.md',
    lines: [125],
    why: 'a quoted `respondido_por` field value, from before the field was renamed',
  }),
  Object.freeze({
    file: 'notes/2026-08-18-n3-round.md',
    lines: [29],
    why: "the `(literally \"…\")` gloss pattern itself — D24's own escape hatch",
  }),
  Object.freeze({
    file: 'notes/2026-08-24-t280-closing-note.md',
    lines: [91, 93],
    why: 'quoted Portuguese source terms the note is reasoning about',
  }),
  Object.freeze({
    file: 'notes/2026-08-24-t281-closing-note.md',
    lines: [73, 77, 78, 79, 109, 113, 121, 122, 158],
    why: 'quoted column names and D20 source text: the retired names ARE the subject',
  }),
  Object.freeze({
    file: 'notes/2026-08-24-t293-closing-note.md',
    lines: [147],
    why: 'a quoted source phrase',
  }),
  Object.freeze({
    file: 'notes/2026-08-24-t299-closing-note.md',
    lines: [46, 49, 70, 85, 111, 117],
    why: 'quoted D20/D22 source text and a field-name mention',
  }),
  Object.freeze({
    file: 'notes/2026-08-25-t298-closing-note.md',
    lines: [34],
    why: 'a quoted job description, as it was submitted',
  }),
  Object.freeze({
    file: 'notes/2026-08-25-t304-closing-note.md',
    lines: [21],
    why: 'a quoted document header',
  }),
  Object.freeze({
    file: 'notes/2026-08-25-t308-closing-note.md',
    lines: [137],
    why: 'the note discusses the character itself, not a word',
  }),
  Object.freeze({
    file: 'notes/2026-08-25-t309-closing-note.md',
    lines: [94, 100, 194],
    why: 'quoted source text, and a fenced block citing the literal string split on',
  }),
]);

/** One repo-relative file, as its lines. */
function linesOf(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8').split('\n');
}

/** Every inventoried entry flattened to one `{file, line, why}` per line. */
function inventory() {
  return SANCTIONED.flatMap((entry) =>
    entry.lines.map((line) => ({ file: entry.file, line, why: entry.why })),
  );
}

test('AT12 — every inventoried line is there, still Portuguese, and still marked', () => {
  const missing = [];
  const flagged = [];

  for (const entry of inventory()) {
    const lines = linesOf(entry.file);
    const text = lines[entry.line - 1];

    if (text === undefined || !ANY_DIACRITIC.test(text)) {
      missing.push(`${entry.file}:${String(entry.line)} — ${entry.why}`);
      continue;
    }

    // The real gate's reading, not a copy of it: a line it stays silent on is a
    // line it can see is inside a backtick span, a fenced block or a gloss.
    const offenders = contentOffendersIn(entry.file, lines.join('\n')).filter((offender) =>
      offender.startsWith(`${entry.file}:${String(entry.line)}:`),
    );

    if (offenders.length > 0) flagged.push(...offenders);
  }

  assert.deepEqual(
    missing,
    [],
    'an inventoried line stopped carrying Portuguese. A carve-out that outlives its subject ' +
      `is a hole nobody is watching — delete the entry:\n${missing.join('\n')}`,
  );

  assert.deepEqual(
    flagged,
    [],
    'a sanctioned quotation is no longer MARKED as one. Most likely it wrapped across a line ' +
      "break: the document-tree sweep's `SPAN` matcher is line-scoped on purpose, so a " +
      `quotation has to stay on one line to be seen as quoted:\n${flagged.join('\n')}`,
  );
});

test('AT12 — the inventory is complete: no diacritic under notes/ is unaccounted for', () => {
  // The half that matters most. Without it the list above could go stale in the
  // other direction — a new untranslated line appearing under `notes/` and being
  // read as "not in the inventory, therefore not this gate's problem".
  const known = new Set(inventory().map((entry) => `${entry.file}:${String(entry.line)}`));
  const found = [];

  for (const entry of SANCTIONED) {
    linesOf(entry.file).forEach((text, index) => {
      if (ANY_DIACRITIC.test(text)) found.push(`${entry.file}:${String(index + 1)}`);
    });
  }

  const unlisted = found.filter((entry) => !known.has(entry));

  assert.deepEqual(
    unlisted,
    [],
    `a line under notes/ carries Portuguese and is not in the inventory:\n${unlisted.join('\n')}`,
  );

  assert.equal(found.length, 26, `the inventory measured 26 lines and now finds ${String(found.length)}`);
});

test('AT12 — the D24 detector is narrower than this inventory, and that is written down', () => {
  // Found while building the inventory: `parâmetros` passes every D24 prose gate
  // in the repository, because `â` is not in `DIACRITIC`'s class. Nothing here
  // fixes it — `no-portuguese-prose.mjs` is frozen by FR10, and widening the
  // class is a change to the mechanism, not to prose. What this pins is the
  // KNOWLEDGE: if a later ticket widens the class, this assertion fails and
  // points at the two lines that were only ever caught by hand.
  const blind = ['à', 'â', 'ô', 'ü'].filter((character) => !DIACRITIC.test(character));

  assert.deepEqual(
    blind,
    ['à', 'â', 'ô', 'ü'],
    'the D24 detector grew a wider character class. Good — but re-measure this inventory: it ' +
      'was built with the full set, and the gates were not.',
  );

  for (const entry of [
    { file: 'notes/2026-08-24-t281-closing-note.md', line: 122 },
    { file: 'notes/2026-08-24-t299-closing-note.md', line: 46 },
  ]) {
    const text = linesOf(entry.file)[entry.line - 1];
    assert.ok(ANY_DIACRITIC.test(text), `${entry.file}:${String(entry.line)} lost its diacritic`);
    assert.equal(
      DIACRITIC.test(text),
      false,
      `${entry.file}:${String(entry.line)} is now visible to the D24 gates; the blind spot moved`,
    );
  }
});

test('AT13 — the n=3 note still says the round was stopped and measured nothing', () => {
  const note = readFileSync(path.join(ROOT, 'notes/2026-08-18-n3-round.md'), 'utf8');

  // AC3's specific pin: this note's facts are the ones a translation is likeliest
  // to soften. The round did not finish, it produced no comparison, and the note
  // has to keep saying so in those words.
  assert.ok(note.includes('n=1'), 'the note has to keep saying the round completed n=1');
  assert.ok(note.includes('no A/B measurement exists'), 'the note has to keep saying nothing was measured');
  assert.ok(/stopped/.test(note), 'the note has to keep saying the round was stopped');
  assert.ok(/round/.test(note), 'the note has to keep calling it a round');

  // ...and the gloss that carries what the founder actually said stays whole.
  assert.ok(
    note.includes('(literally "já fizemos o suficiente")'),
    'the gloss is the fact, not decoration: an English rendering alone loses who said what',
  );
});
