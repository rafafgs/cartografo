/**
 * Acceptance tests for the screen-retired gate (t549, FR12 / AT6).
 *
 * D27 deletes the screen. What this gate pins is that its command name does not
 * come back in a current-tense file: a pasted command line in a new doc, a
 * stale example, a test fixture. The historical record — `DECISIONS.md`,
 * `CHANGELOG.md` and `notes/**` — is exempt, because rewriting history after
 * the fact is exactly what this project does not do.
 *
 * The two names are built by concatenation everywhere in this file, and in the
 * gate itself: a literal would be a leak the gate reports about its own tests.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RETIRED_NAMES, SCREEN_NAME_LEAKED, check, checkContent, isExempt } from './check-screen-retired.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-screen-retired.mjs');

const SCREEN_NAME = ['cartografo', 'screen'].join('-');
const OLD_SCREEN_NAME = ['cartografo', 'tela'].join('-');

/** A throwaway git repository holding exactly the given files, all tracked. */
function fixtureRepository(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t549-retired-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  for (const [file, content] of Object.entries(files)) {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  execFileSync('git', ['add', '--all'], { cwd: root });
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('t549 AT6 — the gate looks for both names the screen ever shipped under', () => {
  assert.deepEqual([...RETIRED_NAMES].sort(), [OLD_SCREEN_NAME, SCREEN_NAME].sort());
});

test('t549 AT6 — a name in a current-tense file is a leak, reported with file and line', (t) => {
  const root = fixtureRepository(t, {
    'README.md': `# readme\n\nRun it:\n\n    npx ${SCREEN_NAME}\n`,
    'docs/old.md': `line one\n${OLD_SCREEN_NAME} was the first name\n`,
    'src/fine.ts': 'export const nothing = 1;\n',
  });

  const report = check(root);
  assert.equal(report.valid, false);
  const found = report.violations
    .map((violation) => `${violation.code} ${violation.file}:${String(violation.line)}`)
    .sort();
  assert.deepEqual(found, [`${SCREEN_NAME_LEAKED} README.md:5`, `${SCREEN_NAME_LEAKED} docs/old.md:2`]);
});

test('t549 AT6 — DECISIONS.md, CHANGELOG.md and notes/** are the historical record, and pass', (t) => {
  const root = fixtureRepository(t, {
    'DECISIONS.md': `D23 shipped ${SCREEN_NAME}.\n`,
    'CHANGELOG.md': `- removed ${SCREEN_NAME}\n`,
    'notes/anything.md': `renamed ${OLD_SCREEN_NAME} to ${SCREEN_NAME}\n`,
    'notes/deeper/closing.md': `${SCREEN_NAME}\n`,
  });

  assert.deepEqual(check(root), { valid: true, violations: [] });
});

test('t549 AT6 — the exemption is exact: a nested DECISIONS.md or a notes-like path is not history', () => {
  assert.equal(isExempt('DECISIONS.md'), true);
  assert.equal(isExempt('CHANGELOG.md'), true);
  assert.equal(isExempt('notes/2026-08-25-t303-closing-note.md'), true);
  assert.equal(isExempt('docs/DECISIONS.md'), false);
  assert.equal(isExempt('packages/core/CHANGELOG.md'), false);
  assert.equal(isExempt('notesmore/x.md'), false);
  assert.equal(isExempt('docs/notes/x.md'), false);
});

test('t549 AT6 — checkContent finds every occurrence line by line', () => {
  const violations = checkContent('a.md', `ok\n${SCREEN_NAME} and ${OLD_SCREEN_NAME}\nok\n${SCREEN_NAME}\n`);
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [2, 4],
    'one violation per line that leaks, whichever name it leaks',
  );
  assert.ok(violations.every((violation) => violation.code === SCREEN_NAME_LEAKED));
});

test('t549 AT6 — an untracked file is not swept, and a binary file is skipped', (t) => {
  const root = fixtureRepository(t, {
    'image.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), Buffer.from(SCREEN_NAME)]),
  });
  writeFileSync(path.join(root, 'untracked.md'), `${SCREEN_NAME}\n`);

  assert.deepEqual(check(root), { valid: true, violations: [] });
});

test('t549 AT6 — the real repository, with the screen gone, passes with zero violations', () => {
  const report = check(ROOT);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);
});

test('t549 AT6 — the CLI exits 0 on the repository and 1 on a leaking fixture', (t) => {
  assert.equal(runCli(ROOT).status, 0);

  const root = fixtureRepository(t, { 'README.md': `${SCREEN_NAME}\n` });
  const cli = runCli(root);
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, new RegExp(SCREEN_NAME_LEAKED));
  assert.match(cli.stderr, /README\.md:1/);
});
