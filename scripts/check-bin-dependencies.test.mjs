/**
 * Acceptance tests of the shipped-bin gate (t199, FR2).
 *
 * The bug the gate exists against is invisible in the monorepo and fatal outside
 * it: every `bin/*.mjs` in this repository starts with `import { register } from
 * 'tsx/esm/api'`, so `tsx` is needed at RUNTIME by whoever runs the command.
 * Declared under `devDependencies`, it is there for us (npm installs the whole
 * workspace) and absent for whoever installs the tarball — where the command
 * dies on its first line.
 *
 * Same shape as `check-single-writer.test.mjs`: fixtures written into a
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
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-bin-dependencies.mjs');

let scriptModule = null;

async function loadScript() {
  assert.ok(
    existsSync(SCRIPT_PATH),
    'artifact does not exist yet: scripts/check-bin-dependencies.mjs',
  );
  scriptModule ??= await import(new URL('./check-bin-dependencies.mjs', import.meta.url));
  return scriptModule;
}

function temporaryArea(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t199-bindeps-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, 'utf8');
}

/**
 * Writes a fixture workspace: one package that ships a command, one that does
 * not. `overrides` replaces a manifest to produce each case.
 */
function buildTree(root, { RUNTIME_LOADER }, overrides = {}) {
  const manifests = {
    'packages/core/package.json': {
      name: 'cartografo',
      bin: { cartografo: './bin/cartografo.mjs' },
      dependencies: { [RUNTIME_LOADER]: '^4.23.12' },
    },
    // No `bin`: nobody ever runs this one as a command, so the loader stays a
    // development tool and the gate has nothing to say about it.
    'packages/cost-surveyor/package.json': {
      name: '@cartografo/cost-surveyor',
      devDependencies: { [RUNTIME_LOADER]: '^4.23.12' },
    },
    ...overrides,
  };

  for (const [relative, manifest] of Object.entries(manifests)) {
    write(root, relative, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('AT — a bin whose loader is only a devDependency fails, and passes once it is a dependency', async (t) => {
  const script = await loadScript();
  const { RUNTIME_LOADER } = script;
  const root = temporaryArea(t);

  buildTree(root, script, {
    'packages/screen/package.json': {
      name: '@cartografo/screen',
      bin: { 'cartografo-screen': './bin/screen.mjs' },
      devDependencies: { [RUNTIME_LOADER]: '^4.23.12' },
    },
  });

  const failing = script.check(root);
  assert.equal(failing.valid, false);
  const violation = failing.violations.find((entry) => entry.file === 'packages/screen/package.json');
  assert.ok(violation, 'expected a violation on the package that ships the bin');
  assert.equal(violation.code, script.MISSING_RUNTIME_DEPENDENCY);
  assert.equal(violation.target, RUNTIME_LOADER);
  assert.match(violation.message, /devDependencies/);
  assert.equal(runCli(root).status, 1);

  // The same tree with the single line moved: nothing else changes.
  buildTree(root, script, {
    'packages/screen/package.json': {
      name: '@cartografo/screen',
      bin: { 'cartografo-screen': './bin/screen.mjs' },
      dependencies: { [RUNTIME_LOADER]: '^4.23.12' },
    },
  });

  const passing = script.check(root);
  assert.deepEqual(passing.violations, []);
  assert.equal(passing.valid, true);
  assert.equal(runCli(root).status, 0);
});

test('AT — a bin that declares the loader nowhere fails naming the package', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), script, {
    'packages/runner/package.json': {
      name: '@cartografo/runner',
      bin: { 'cartografo-runner': './bin/cartografo-runner.mjs' },
    },
  });

  const report = script.check(root);
  assert.equal(report.valid, false);
  const violation = report.violations.find(
    (entry) => entry.file === 'packages/runner/package.json',
  );
  assert.ok(violation, 'expected a violation on the package that ships the bin');
  assert.equal(violation.code, script.MISSING_RUNTIME_DEPENDENCY);

  const cli = runCli(root);
  assert.equal(cli.status, 1);
  const output = `${cli.stdout}${cli.stderr}`;
  assert.ok(output.includes('packages/runner/package.json'), 'the CLI names the guilty manifest');
  assert.ok(output.includes(script.RUNTIME_LOADER), 'the CLI names the missing dependency');
});

test('AT — a bin declared as a plain string is read like the object form', async (t) => {
  const script = await loadScript();
  const { RUNTIME_LOADER } = script;
  const root = buildTree(temporaryArea(t), script, {
    'packages/screen/package.json': {
      name: '@cartografo/screen',
      bin: './bin/screen.mjs',
      devDependencies: { [RUNTIME_LOADER]: '^4.23.12' },
    },
  });

  const report = script.check(root);
  assert.equal(report.valid, false, 'npm accepts both spellings of `bin`; so does the gate');
});

test('AT — a malformed manifest is reported, never fatal', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), script);
  write(root, 'packages/broken/package.json', '{ not json at all');

  const report = script.check(root);
  assert.equal(report.valid, true, "broken JSON is another gate's problem, and no crash here");
});

test('AT — the real repository passes the gate', async () => {
  const { check } = await loadScript();
  const report = check(ROOT);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  assert.equal(runCli().status, 0, 'the CLI with no argument sweeps the repo root');
});
