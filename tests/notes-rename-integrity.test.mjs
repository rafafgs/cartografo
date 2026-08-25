/**
 * D24 gate: the working notes live in `notes/`, and the rename lost nothing
 * (t305, AC3).
 *
 * The folder was `notas/` until this ticket. Two earlier tickets looked at it
 * and left it standing — t282 because renaming it was outside its declared
 * scope, t306 because it read t282's silence as a decision and recorded `notas`
 * as a standing exception in two gates. The founder's ruling on t305 is that the
 * label was his own mistake: D24 allows the brand name `cartografo`, marked
 * verbatim quotations and the frozen migration file names, and a directory of
 * working notes is none of the three.
 *
 * Modelled on `tests/decisions-rename-integrity.test.mjs`, which held the same
 * three claims when the ledger moved, and for the same reason: a rename is the
 * easy half, and the half that breaks a reader silently is a citation left
 * pointing at a path that no longer exists.
 *
 * - **AT3a — every note that was there is still there, under the new prefix.**
 *   The fixture below was read off `git ls-files notas/` before the `git mv`, so
 *   it is a claim about what the rename was handed rather than about what came
 *   out of it. Twenty-six dated notes and one undated prompt.
 * - **AT3b — nothing outside `notes/` still spells `notas/`.** One grep holds
 *   the whole fan-out: ~130 citations across docs, specs, the runtime's own doc
 *   comments, two frozen migration comments, a `.gitignore` comment and eight
 *   gates.
 * - **AT3c — every citation of a note resolves on disk.** The sweep above proves
 *   nothing still says `notas/`; this one proves that what it says instead is
 *   real, and it is the claim that would have caught a `notes/` typo that no
 *   grep for the old name ever could.
 *
 * ## The two things this gate deliberately does NOT claim
 *
 * **That the notes' CONTENTS are untouched.** They are — t305 moved paths and
 * nothing else — but pinning that with a hash per note would hand the very next
 * ticket a fixture to rewrite: the founder split the redaction of sensitive
 * content in eight of these notes into a follow-up sequenced strictly after this
 * one, precisely so that a commit does not both move a file and rewrite it (git's
 * rename detection does not survive the two together). A hash fixture here would
 * make that ticket's honest work look like a broken gate.
 *
 * **That the notes' own prose cites `notes/`.** It cites `notas/` in about
 * forty-six places and is meant to: a note records what was true on the day it
 * was written, and the same discipline that preserves
 * `2026-08-24-bets-assimetricas-closing-note.md` under its retired spelling
 * preserves the sentences inside it. That is why AT3b reads the tree OUTSIDE
 * `notes/`, and why AT3c only asks about targets that already name `notes/`.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The folder's name before this ticket, and the substring AT3b hunts. */
export const OLD_TREE = 'notas/';

/** Its name after it. */
export const TREE = 'notes/';

/** This file, repo-relative: the one place the old name may still be written. */
const SELF = path.join('tests', 'notes-rename-integrity.test.mjs');

/**
 * The notes as `git ls-files notas/` listed them the morning of the rename.
 *
 * Names and dates both, because a note's date is part of its identity — it is
 * how the record is ordered and how every citation of it reads — and a rename
 * that quietly re-dated one would be invisible to a check that only counted
 * files. Twenty-six carry a date; `execution-monitoring-prompt.md` never did.
 *
 * Four of these spell something D24 retired (`bets-assimetricas`, the two
 * `game-feature` notes' subject, `n3-round`) and they are preserved exactly as
 * they are: a rename must not touch a file whose subject IS the old name.
 */
export const NOTES = Object.freeze(
  [
    { name: '2026-08-14-architecture-brain-dump.md', date: '2026-08-14' },
    { name: '2026-08-14-extension-and-quality.md', date: '2026-08-14' },
    { name: '2026-08-14-learning.md', date: '2026-08-14' },
    { name: '2026-08-14-loop-or-graph.md', date: '2026-08-14' },
    { name: '2026-08-14-market.md', date: '2026-08-14' },
    { name: '2026-08-15-closed-learning-loop.md', date: '2026-08-15' },
    { name: '2026-08-15-first-execution.md', date: '2026-08-15' },
    { name: '2026-08-17-english-thread.md', date: '2026-08-17' },
    { name: '2026-08-17-first-bets-run.md', date: '2026-08-17' },
    { name: '2026-08-17-second-bets-run.md', date: '2026-08-17' },
    { name: '2026-08-17-t109-game-feature.md', date: '2026-08-17' },
    { name: '2026-08-18-action-plan.md', date: '2026-08-18' },
    { name: '2026-08-18-game-feature-2.md', date: '2026-08-18' },
    { name: '2026-08-18-n3-round.md', date: '2026-08-18' },
    { name: '2026-08-18-third-bets-run.md', date: '2026-08-18' },
    { name: '2026-08-24-bets-assimetricas-closing-note.md', date: '2026-08-24' },
    { name: '2026-08-24-t280-closing-note.md', date: '2026-08-24' },
    { name: '2026-08-24-t281-closing-note.md', date: '2026-08-24' },
    { name: '2026-08-24-t299-closing-note.md', date: '2026-08-24' },
    { name: '2026-08-25-t282-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t296-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t297-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t298-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t300-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t303-closing-note.md', date: '2026-08-25' },
    { name: '2026-08-25-t306-closing-note.md', date: '2026-08-25' },
    { name: 'execution-monitoring-prompt.md', date: null },
  ].map((entry) => Object.freeze(entry)),
);

/** An inline markdown link, as `[display text](target)`. Same reading as t302's. */
const LINK = /\[(?:[^[\]]|\[[^\]]*\])*\]\(([^()\s]+)\)/g;

/** A bare `notes/…md` path written in prose, backticked or not. */
const BARE_NOTE = /(?:\.\.\/)*notes\/[A-Za-z0-9._-]+\.md/g;

/** Every file git tracks, as repo-relative paths, this file already dropped. */
export function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry !== '')
    .filter((entry) => entry !== SELF);
}

/**
 * Every note path one document points at, target and prose citation alike.
 *
 * Link targets are read relative to the citing file, the way a reader's click
 * resolves them; a bare path written in prose is read from the repository root,
 * the way this project's house style writes one.
 *
 * @param {string} relativePath Repo-relative path of the file to read.
 * @returns {Array<{written: string, resolved: string}>} One entry per citation.
 */
export function noteCitationsIn(relativePath) {
  const contents = readFileSync(path.join(ROOT, relativePath), 'utf8');
  const directory = path.dirname(relativePath);
  const found = [];

  for (const match of contents.matchAll(LINK)) {
    const target = match[1].split('#')[0];
    if (!target.endsWith('.md')) continue;
    const resolved = path.normalize(path.join(directory, target));
    if (!resolved.startsWith(TREE)) continue;
    found.push({ written: match[1], resolved });
  }

  for (const written of contents.match(BARE_NOTE) ?? []) {
    found.push({ written, resolved: path.normalize(written.replace(/^(?:\.\.\/)+/, '')) });
  }

  return found;
}

test('AT3a — every note the rename was handed is under notes/, name and date intact', () => {
  assert.equal(NOTES.length, 27, 'the fixture is not the set `git ls-files notas/` listed');

  const tracked = new Set(trackedFiles());

  for (const note of NOTES) {
    const moved = `${TREE}${note.name}`;

    assert.ok(tracked.has(moved), `${moved} is not tracked: the rename lost a note`);
    assert.ok(existsSync(path.join(ROOT, moved)), `${moved} is not on disk`);

    if (note.date === null) continue;
    assert.equal(
      note.name.slice(0, 10),
      note.date,
      `${note.name} no longer carries the date it was written on`,
    );
  }
});

test('AT3a — the old folder is gone, and nothing was left behind in it', () => {
  assert.equal(
    existsSync(path.join(ROOT, 'notas')),
    false,
    'notas/ is still on disk: the rename left two folders where there should be one',
  );

  const stragglers = trackedFiles().filter((entry) => entry.startsWith(OLD_TREE));

  assert.deepEqual(stragglers, [], `git still tracks files under ${OLD_TREE}`);
});

test('AT3b — no tracked file outside notes/ still spells the folder by its old name', () => {
  const tracked = trackedFiles();

  assert.ok(
    tracked.length >= 400,
    `only ${String(tracked.length)} files listed; the sweep is not reading the tree`,
  );

  const offenders = tracked
    .filter((entry) => !entry.startsWith(TREE))
    .flatMap((relativePath) =>
      readFileSync(path.join(ROOT, relativePath), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter((entry) => entry.line.includes(OLD_TREE))
        .map(
          (entry) => `${relativePath}:${String(entry.number)}: ${entry.line.trim().slice(0, 120)}`,
        ),
    );

  assert.deepEqual(
    offenders,
    [],
    `a citation still points at a folder that does not exist:\n${offenders.join('\n')}`,
  );
});

test('AT3c — every citation of a note resolves to a note that is really there', () => {
  const documents = trackedFiles().filter((entry) => entry.endsWith('.md'));

  const citations = documents.flatMap((relativePath) =>
    noteCitationsIn(relativePath).map((citation) => ({ ...citation, file: relativePath })),
  );

  assert.ok(
    citations.length >= 20,
    `only ${String(citations.length)} note citations found; the reading is not matching`,
  );

  const dead = citations
    .filter((citation) => !existsSync(path.join(ROOT, citation.resolved)))
    .map((citation) => `${citation.file}: "${citation.written}" → ${citation.resolved}`);

  assert.deepEqual(dead, [], `a note citation resolves to nothing:\n${dead.join('\n')}`);
});
