/**
 * Acceptance test of t399 — the loader D23 removed is named nowhere in what the
 * packages ship as a manifest or as a command shell.
 *
 * t248 replaced the old TypeScript loader with `amaro` and deleted
 * `scripts/check-bin-dependencies.mjs`, the gate that used to REQUIRE the old
 * one in every manifest shipping a command. The definition of done for that
 * work was a literal sweep:
 *
 *     grep -rn tsx packages/*\/package.json packages/*\/bin/*.mjs
 *
 * and it returned three lines — a doc comment in
 * `packages/core/bin/register-typescript.mjs` that narrated the choice by name.
 * No dependency, no import, no flag: the code was right and the sweep still
 * failed, which is a criterion nothing could hold green by accident.
 *
 * So the sweep becomes a test, and the name it looks for keeps its one home in
 * prose — `packages/core/README.md`, where a rejected alternative is normal to
 * write down. What `packages/` publishes stays clean: a manifest that declares
 * the old loader, a shell that imports it, and a comment that merely mentions it
 * all fail here, and the first two are the regression this exists against.
 *
 * The forbidden name appears in THIS file, which is the point: it lives under
 * `tests/`, outside the swept surface, so the gate can name what it forbids
 * without tripping over itself.
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Directory the workspaces live in. */
const PACKAGES_DIR = 'packages';

/** The loader t248 removed, as the literal string the sweep looks for. */
const REMOVED_LOADER = 'tsx';

/** Where the name is still allowed — and expected — to be written down. */
const RATIONALE_DOCUMENT = path.join('packages', 'core', 'README.md');

/** Every `packages/<name>/`, sorted, as directory entries. */
function packageDirectories() {
  return readdirSync(path.join(ROOT, PACKAGES_DIR), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The swept surface: each package's manifest and each of its command shells.
 *
 * Paths are relative to the repository root, so a failure reads like the `grep`
 * it stands in for. A package with no `bin/` contributes only its manifest.
 */
function sweptFiles() {
  const files = [];

  for (const name of packageDirectories()) {
    files.push(path.join(PACKAGES_DIR, name, 'package.json'));

    let shells;
    try {
      shells = readdirSync(path.join(ROOT, PACKAGES_DIR, name, 'bin'));
    } catch {
      continue; // no `bin/`: this package ships no command
    }

    for (const shell of shells.sort()) {
      if (shell.endsWith('.mjs')) files.push(path.join(PACKAGES_DIR, name, 'bin', shell));
    }
  }

  return files;
}

/** Every `file:line: text` in the swept surface that names the removed loader. */
function occurrences() {
  const found = [];

  for (const file of sweptFiles()) {
    let content;
    try {
      content = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue; // a manifest that is not there is another gate's problem
    }

    content.split('\n').forEach((line, index) => {
      if (line.includes(REMOVED_LOADER)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }

  return found;
}

test('AT — no manifest and no command shell names the removed loader', () => {
  assert.deepEqual(
    occurrences(),
    [],
    'the definition of done of t248 sweeps every `packages/*/package.json` and\n' +
      `\`packages/*/bin/*.mjs\` for "${REMOVED_LOADER}" and expects nothing.\n` +
      'A dependency or an import there is D23 undone; a mention in a comment is\n' +
      `the same sweep failing on prose — move that prose to ${RATIONALE_DOCUMENT}.`,
  );
});

test('AT — the rationale for the replacement survives, in prose', () => {
  const rationale = readFileSync(path.join(ROOT, RATIONALE_DOCUMENT), 'utf8');

  assert.ok(
    rationale.includes(REMOVED_LOADER),
    `${RATIONALE_DOCUMENT} is where the name of the replaced loader lives now. ` +
      'Emptying the swept surface must not cost the reason the swap was made.',
  );
  assert.ok(
    rationale.includes('amaro'),
    `${RATIONALE_DOCUMENT} names what replaced it, or the comparison has one side.`,
  );
});
