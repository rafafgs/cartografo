/**
 * Acceptance tests for the size budget of `src/dispatch/` (t223, FR9 of t202).
 *
 * t202's DoD carried a line nobody could run: "no file under
 * `packages/runner/src/dispatch/` over ~600 lines, or an exception recorded in
 * Gotchas". It was a soft target enforced by whoever remembered to type
 * `wc -l`, and the ticket that wrote it shipped with `dispatch.ts` at 930 and
 * the Gotchas section still an empty placeholder — which is how the alpha round
 * found it. A criterion that is only checked by hand is a criterion that is only
 * checked when somebody is already suspicious.
 *
 * So the budget is a test now, and the "~" is gone: {@link LINE_BUDGET} is a
 * number, the sweep is over the whole directory rather than over the one file
 * that happened to be flagged, and an exception is a change to this file — which
 * is exactly what "recorded" was supposed to mean and what a placeholder in a
 * ticket never achieved.
 *
 * **What this does NOT claim.** A line count is not a complexity metric, and in
 * this package it is barely even a size metric: `dispatch.ts` was 63%
 * documentation when it was measured (582 comment lines out of 930), and the
 * files here are written that way on purpose. The budget is worth having anyway,
 * for the reason t202 gave it: a module nobody can hold in their head is a module
 * every ticket edits, and every ticket editing the same file is the conflict
 * surface this project schedules around. Splitting it moves the prose too —
 * each piece carries the part of the argument that belongs to it.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DISPATCH_DIR = path.join(PACKAGE_ROOT, 'src', 'dispatch');

/**
 * The ceiling, in lines, of any module under `src/dispatch/`.
 *
 * 600 is t202's own number, with the tilde resolved downwards: a budget that
 * reads "~600" is a budget whose breach is arguable, and the alpha round found
 * a 930-line file sitting behind that argument.
 */
const LINE_BUDGET = 600;

/**
 * Modules allowed over {@link LINE_BUDGET}, each with the reason, in the file
 * the gate reads.
 *
 * It was empty from t223 to t423, and the point of it was that it was empty in
 * the repository rather than in a ticket field: the DoD always allowed an
 * exception, and this is where one gets recorded. Adding an entry costs a diff
 * somebody reviews, which is the whole difference between an exception and an
 * oversight.
 */
const RECORDED_EXCEPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'dispatch.ts':
    't423. The module sat at EXACTLY 600 for several fichas, which is a budget ' +
    'met by nobody having room left rather than by the file being small. t423 had ' +
    'to add the one thing that cannot live anywhere else: the artifact upload runs ' +
    'BETWEEN the decode of the session text and `tree.release()`, because the ' +
    'release discards the very directory the declared file is in — so the ordering ' +
    'IS the feature, and a helper module can hold the upload (it does: ' +
    '`upload-artifacts.ts`) but not the position of the call. The split that would ' +
    'actually buy room back is the orchestration itself, which is a ficha of its ' +
    'own and not a line this one could smuggle in.',
});

/**
 * Lines in a file, counted the way the ticket's own reproduction counted them.
 *
 * `wc -l` counts newline characters, so a file with a trailing newline — every
 * file here — gives the same number both ways. The trailing-newline guard is
 * what keeps a file without one from being reported as one line short.
 */
function countLines(filePath: string): number {
  const content = readFileSync(filePath, 'utf8');
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Every TypeScript module of the directory, by file name. */
function dispatchModules(): string[] {
  return readdirSync(DISPATCH_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

test('AT1 — the sweep actually reads the directory it claims to guard', () => {
  const modules = dispatchModules();

  assert.ok(
    modules.includes('dispatch.ts'),
    `the sweep over ${DISPATCH_DIR} did not find dispatch.ts — a gate that matches ` +
      'nothing passes for the wrong reason',
  );
  assert.ok(
    modules.length >= 10,
    `only ${String(modules.length)} module(s) found under src/dispatch/; the directory ` +
      'had a dozen when this gate was written',
  );
});

test('AT2 — no module under src/dispatch/ is over the budget', () => {
  const offenders = dispatchModules()
    .filter((name) => !(name in RECORDED_EXCEPTIONS))
    .map((name) => ({ name, lines: countLines(path.join(DISPATCH_DIR, name)) }))
    .filter((module) => module.lines > LINE_BUDGET);

  assert.deepEqual(
    offenders,
    [],
    `over the ${String(LINE_BUDGET)}-line budget: ` +
      offenders.map((module) => `${module.name} (${String(module.lines)})`).join(', ') +
      '. Split it, or record an exception in RECORDED_EXCEPTIONS with the reason.',
  );
});

test('AT3 — dispatch.ts, the module the alpha round flagged, is within it', () => {
  const lines = countLines(path.join(DISPATCH_DIR, 'dispatch.ts'));

  // Reads RECORDED_EXCEPTIONS since t423, exactly as AT2 does. It did not
  // before, and the two therefore disagreed about what a recorded exception
  // MEANS: the one file this case names by hand was the one file for which
  // recording an exception changed nothing, so the mechanism t223 built was a
  // no-op precisely where it was most likely to be needed. What this case is
  // for survives the change — an un-recorded breach still fails here, with the
  // module named, which is what "the module the alpha round flagged" earned.
  assert.ok(
    lines <= LINE_BUDGET || 'dispatch.ts' in RECORDED_EXCEPTIONS,
    `dispatch.ts is ${String(lines)} lines, over the ${String(LINE_BUDGET)}-line budget ` +
      '(it was 930 when t223 was opened). Split it, or record an exception in ' +
      'RECORDED_EXCEPTIONS with the reason.',
  );
});

test('AT4 — every recorded exception names a module that exists', () => {
  const modules = new Set(dispatchModules());

  for (const [name, reason] of Object.entries(RECORDED_EXCEPTIONS)) {
    assert.ok(
      modules.has(name),
      `RECORDED_EXCEPTIONS names "${name}", which is not a module of src/dispatch/ — ` +
        'a stale exemption silently widens the budget',
    );
    assert.ok(
      reason.trim().length > 0,
      `the exception for "${name}" records no reason, which is the state t223 was opened over`,
    );
  }
});
