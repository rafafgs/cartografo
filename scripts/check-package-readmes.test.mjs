/**
 * Acceptance tests of the package-README gate (t330, AT1).
 *
 * The failure the gate exists against is the one this ticket cleans up: six
 * workspaces, six `package.json` descriptions, and not one `README.md` between
 * them. Nothing breaks — the monorepo has only ever had one reader, and that
 * reader knows what `packages/surveyor` is. A stranger browsing the file view on
 * GitHub sees six directories and has to open source to tell them apart, and a
 * seventh package added tomorrow would land in exactly the same state with
 * nothing to say so.
 *
 * Same shape as `check-bin-dependencies.test.mjs`: fixtures written into a
 * temporary directory, the exported function checked next to the CLI's exit
 * code, and the real repository swept at the end.
 *
 * Run with: `npm test` at the root.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-package-readmes.mjs');

/** The six workspaces this repository has, and the six pages t330 owes them. */
const WORKSPACES = ['core', 'cost-surveyor', 'runner', 'screen', 'surveyor', 'test-support'];

let scriptModule = null;

async function loadScript() {
  assert.ok(
    existsSync(SCRIPT_PATH),
    'artifact does not exist yet: scripts/check-package-readmes.mjs',
  );
  scriptModule ??= await import(new URL('./check-package-readmes.mjs', import.meta.url));
  return scriptModule;
}

function temporaryArea(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t330-readmes-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, 'utf8');
}

/**
 * Writes a fixture workspace tree: one package that carries its page, plus
 * whatever `extra` describes. Each entry of `extra` is a package name mapped to
 * the README content it gets, or `null` for a package directory with no README
 * at all.
 */
function buildTree(root, extra = {}) {
  write(root, 'packages/core/package.json', '{ "name": "cartografo" }\n');
  write(root, 'packages/core/README.md', '# cartografo\n\nThe control plane.\n');

  for (const [name, readme] of Object.entries(extra)) {
    write(root, `packages/${name}/package.json`, `{ "name": "@cartografo/${name}" }\n`);
    if (readme !== null) write(root, `packages/${name}/README.md`, readme);
  }
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('AT1a — a package directory with no README is reported, and named', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), { screen: null });

  const report = script.check(root);
  assert.equal(report.valid, false);

  const violation = report.violations.find((entry) => entry.file === 'packages/screen');
  assert.ok(violation, 'expected a violation on the package with no README');
  assert.equal(violation.code, script.MISSING_PACKAGE_README);
  assert.equal(violation.target, 'packages/screen/README.md');

  const cli = runCli(root);
  assert.equal(cli.status, 1);
  const output = `${cli.stdout}${cli.stderr}`;
  assert.ok(output.includes('packages/screen'), 'the CLI names the package that owes a page');
  assert.ok(output.includes(script.README_FILENAME), 'the CLI names the file it wanted');
});

test('AT1b — the same tree with the file added passes, and nothing else changed', async (t) => {
  const script = await loadScript();
  const root = temporaryArea(t);

  buildTree(root, { screen: null });
  assert.equal(script.check(root).valid, false);

  // The same fixture, one file added: that is the whole difference.
  buildTree(root, { screen: '# @cartografo/screen\n\nOne more client of the API.\n' });

  const report = script.check(root);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);
  assert.equal(runCli(root).status, 0);
});

test('AT1b — an empty README is not a page, and is reported like an absent one', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), { surveyor: '   \n\n' });

  const report = script.check(root);
  assert.equal(report.valid, false, 'a whitespace-only file makes the same claim it cannot keep');
  const violation = report.violations.find((entry) => entry.file === 'packages/surveyor');
  assert.ok(violation, 'expected a violation on the package whose README is blank');
  assert.equal(violation.code, script.MISSING_PACKAGE_README);
});

test('AT1 — every package directory is swept, not only the first one missing a page', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), { runner: null, screen: null, surveyor: null });

  const report = script.check(root);
  assert.deepEqual(
    report.violations.map((entry) => entry.file),
    ['packages/runner', 'packages/screen', 'packages/surveyor'],
    'all three, in a stable order, so the report comes out whole',
  );
});

test('AT1 — a tree with no `packages/` directory is not this gate business', async (t) => {
  const script = await loadScript();
  const root = temporaryArea(t);
  write(root, 'package.json', '{ "name": "somebody-else" }\n');

  const report = script.check(root);
  assert.equal(report.valid, true);
  assert.deepEqual(report.violations, []);
});

test('AT1c — the real repository passes: all six workspaces carry a README', async () => {
  const script = await loadScript();
  const report = script.check(ROOT);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  for (const name of WORKSPACES) {
    assert.ok(
      existsSync(path.join(ROOT, 'packages', name, script.README_FILENAME)),
      `packages/${name} has no README.md`,
    );
  }

  assert.equal(runCli().status, 0, 'the CLI with no argument sweeps the repo root');
});
