/**
 * D24 gate: the decision ledger is `DECISIONS.md`, and nothing still points at
 * the name it had (t299, AT2–AT4).
 *
 * Renaming the ledger is the one edit of this ticket that can break a reader
 * silently. A translated paragraph that came out clumsy is visible to whoever
 * reads it; a citation left pointing at a file that no longer exists is visible
 * to nobody until somebody clicks it, and by then the sentence around it reads
 * as though the project never recorded the decision at all.
 *
 * So three separate claims are held here, and each of them is the kind that only
 * a machine keeps honest:
 *
 * - **AT2 — the ledger moved, and nothing inside it moved with it.** The rename
 *   is the easy half. The hard half is that a translation pass over 23 dated
 *   entries must not merge two of them, drop one, reorder a pair or "clarify" a
 *   date. The numbering and the dates are the record, so they are pinned here as
 *   a fixture read off the file before the translation started.
 * - **AT3 — no tracked file still spells the old name.** The rename fans out to
 *   nineteen files: a `.gitignore` comment, a frozen migration's comment, two
 *   doc comments in the runtime, a factory bundle's `project.ledger_files`, five
 *   notes and ten specifications. A grep is the only thing that holds all of
 *   them at once.
 * - **AT4 — the specifications carry the names the rename table gave them.**
 *   Fourteen of the sixteen documents under `docs/spec/` were named in
 *   Portuguese; the table in this ticket says what each becomes, and the two
 *   that keep their names (`intake.md`, and the wire glossary t281 owns) are
 *   named here so that "unchanged" is a decision rather than an omission. The
 *   glossary kept its name for two days only: t326 renamed it once t281 was
 *   done with its contents, and the list below carries the name it has now.
 *
 * ## The one place the old name is allowed to survive
 *
 * This file. AT3 cannot ask for a substring that its own assertion has to spell,
 * so it skips itself by path and says so out loud. Every other tracked file is
 * read, including the notes and the closing note of this very ticket — which is
 * why that note refers to the ledger's old name without its extension.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The ledger's name before this ticket, and the substring AT3 hunts. */
export const OLD_LEDGER = 'DECISOES.md';

/** The ledger's name after it. */
export const LEDGER = 'DECISIONS.md';

/** This file, repo-relative: the one place the old name may still be written. */
const SELF = path.join('tests', 'decisions-rename-integrity.test.mjs');

/** `## D7 (2026-08-14) — Publication strategy` → `7`, `2026-08-14`. */
const ENTRY_HEADING = /^## D(\d+) \((\d{4}-\d{2}-\d{2})\)/;

/**
 * The 23 entries the translation found, numbers and dates both.
 *
 * Read off the file before a word of it was translated. A translation may
 * rewrite every sentence of an entry and must not touch either of these: the
 * number is how the rest of the repository cites the decision, and the date is
 * when it was taken, which no later edit can change.
 *
 * This is a PREFIX, not a total (t121 follow-up, 2026-08-25). As t299 wrote it,
 * AT2 compared the whole heading list against this one and so refused any new
 * decision - D24 was the first to trip it. But recording a decision is not
 * translating one: the property this guard exists for is that a rewrite cannot
 * renumber or redate what was already there, and that is about the entries this
 * list names. Entries appended after them are somebody exercising the ledger,
 * which is what a ledger is for.
 */
export const ENTRIES = Object.freeze([
  ...Array.from({ length: 18 }, (unused, index) => ({ number: index + 1, date: '2026-08-14' })),
  { number: 19, date: '2026-08-15' },
  ...Array.from({ length: 4 }, (unused, index) => ({ number: index + 20, date: '2026-08-16' })),
].map((entry) => Object.freeze(entry)));

/**
 * The documents under `docs/spec/` after the rename table of FR5.
 *
 * `intake.md` was already English and does not move; the wire glossary was
 * t281's and did not move with this table either.
 *
 * Three names moved again after this ticket: t303 renamed `topografo-cost.md`
 * and `topografo-flow.md` to `surveyor-cost.md` and `surveyor-flow.md` when it
 * gave the evaluator's two packages English identities, and t326 renamed the
 * wire glossary to `glossary-wire.md` once t281 had finished translating it.
 * They are listed here under the names they carry now, because this assertion is
 * a claim about what is on disk today — the record of what t299's own table said
 * is `RETIRED_SPEC_DOCUMENTS` below, and that list is untouched. The glossary is
 * not added to it for the same reason `topografo-cost.md` is not: t299's table
 * never named it, and a frozen record does not grow.
 */
export const SPEC_DOCUMENTS = Object.freeze([
  'entities-versioning.md',
  'events-stream.md',
  'glossary-wire.md',
  'graph.md',
  'human-escalation.md',
  'intake-generation.md',
  'intake.md',
  'runner-and-controller.md',
  'screen-graph-editor.md',
  'screen-proposal-inbox.md',
  'screen.md',
  'surveyor-cost.md',
  'surveyor-flow.md',
  'synthesizer.md',
  'transition-hooks.md',
  'webhooks-events.md',
]);

/** The documents under `docs/formats/`, both of which were already English. */
export const FORMAT_DOCUMENTS = Object.freeze(['atlas-bundle.md', 'engine-adapter.md']);

/** The Portuguese names the rename retires, none of which may come back. */
export const RETIRED_SPEC_DOCUMENTS = Object.freeze([
  'entidades-versionamento.md',
  'escalacao-humana.md',
  'eventos-stream.md',
  'ganchos-de-transicao.md',
  'grafo.md',
  'intake-geracao.md',
  'runner-e-controller.md',
  'sintetizador.md',
  'tela-editor-grafo.md',
  'tela-inbox-propostas.md',
  'tela.md',
  'topografo-custo.md',
  'topografo-fluxo.md',
  'webhooks-eventos.md',
]);

/** Every file git tracks, as repo-relative paths, this file already dropped. */
export function trackedFiles() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });

  return listed
    .split('\0')
    .filter((entry) => entry !== '')
    .filter((entry) => entry !== SELF)
    .filter((entry) => !entry.includes('node_modules/'));
}

test('AT2 — the ledger is DECISIONS.md, and the old name is gone from the root', () => {
  assert.equal(
    existsSync(path.join(ROOT, OLD_LEDGER)),
    false,
    `${OLD_LEDGER} is still at the repository root; FR6 renames it`,
  );
  assert.ok(existsSync(path.join(ROOT, LEDGER)), `${LEDGER} does not exist`);
});

test('AT2 — the entries the translation found keep their numbering, their dates and their order', () => {
  const ledger = path.join(ROOT, LEDGER);
  assert.ok(existsSync(ledger), `${LEDGER} does not exist`);

  const headings = readFileSync(ledger, 'utf8')
    .split('\n')
    .map((line) => ENTRY_HEADING.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ number: Number(match[1]), date: match[2] }));

  assert.ok(
    headings.length >= ENTRIES.length,
    `the ledger records ${headings.length} entries; the ${ENTRIES.length} the translation found cannot be removed`,
  );

  assert.deepEqual(
    headings.slice(0, ENTRIES.length),
    ENTRIES.map((entry) => ({ number: entry.number, date: entry.date })),
    'the ledger no longer records the same entries, in the same order, with the same dates',
  );
});

test('AT3 — no tracked file still cites the ledger by the name it had', () => {
  const tracked = trackedFiles();

  assert.ok(
    tracked.length >= 100,
    `only ${String(tracked.length)} files listed; the sweep is not reading the tree`,
  );

  const offenders = tracked.flatMap((relativePath) => {
    const absolute = path.join(ROOT, relativePath);
    if (!existsSync(absolute)) return [];

    return readFileSync(absolute, 'utf8')
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes(OLD_LEDGER))
      .map((entry) => `${relativePath}:${String(entry.index + 1)}: ${entry.line.trim().slice(0, 120)}`);
  });

  assert.deepEqual(
    offenders,
    [],
    `a citation still points at a file that does not exist:\n${offenders.join('\n')}`,
  );
});

test('AT4 — the specifications carry the names the rename table gave them', () => {
  const present = readdirSync(path.join(ROOT, 'docs', 'spec'))
    .filter((entry) => entry.endsWith('.md'))
    .sort();

  assert.deepEqual(present, [...SPEC_DOCUMENTS], 'docs/spec/ is not the set FR5 declares');

  for (const retired of RETIRED_SPEC_DOCUMENTS) {
    assert.equal(
      present.includes(retired),
      false,
      `${retired} is still there: the rename left two documents where there should be one`,
    );
  }
});

test('AT4 — the format documents keep the English names they were born with', () => {
  const present = readdirSync(path.join(ROOT, 'docs', 'formats'))
    .filter((entry) => entry.endsWith('.md'))
    .sort();

  assert.deepEqual(present, [...FORMAT_DOCUMENTS], 'docs/formats/ is not the set FR3 declares');
});
