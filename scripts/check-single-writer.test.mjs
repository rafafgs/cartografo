/**
 * Acceptance tests of the single-writer gate (t100, FR6/FR7).
 *
 * They cover the exported function and the CLI of
 * `scripts/check-single-writer.mjs`, with a positive and several negative
 * fixtures written into a temporary directory.
 *
 * CAREFUL when writing a fixture here: this file is swept by the script itself
 * when `npm run lint` runs at the root. That is why NO line below writes a
 * driver name, or the path `packages/core/src/db`, literally inside an
 * `import ... from '...'` — everything comes in by interpolating the constants
 * the script exports. A literal here would become a real lint violation.
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
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-single-writer.mjs');

let scriptModule = null;

async function loadScript() {
  assert.ok(existsSync(SCRIPT_PATH), 'artifact does not exist yet: scripts/check-single-writer.mjs');
  scriptModule ??= await import(new URL('./check-single-writer.mjs', import.meta.url));
  return scriptModule;
}

function temporaryArea(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-swriter-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function write(root, relative, content) {
  const destination = path.join(root, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, 'utf8');
}

/**
 * Builds the base fixture tree: a core with the driver in the right place, a
 * screen with no privilege at all. `overrides` replaces files to produce each
 * negative case.
 */
function buildTree(root, { SQLITE_DRIVERS, DB_OWNER_SEGMENT }, overrides = {}) {
  const files = {
    'packages/core/package.json': JSON.stringify(
      { name: 'cartografo', dependencies: { [SQLITE_DRIVERS[0]]: '^13.0.0' } },
      null,
      2,
    ),
    'packages/core/src/db/connection.ts':
      `import Database from '${SQLITE_DRIVERS[0]}';\n` +
      `export const open = () => new Database(':memory:');\n`,
    'packages/core/src/server.ts':
      `import { open } from './db/connection.ts';\nexport const app = open;\n`,
    // The core's own test reaching the database module: legitimate, because
    // what is private is the package, not the `src/` folder.
    'packages/core/test/connection.test.ts':
      `import { open } from '../${DB_OWNER_SEGMENT.split('/').slice(1).join('/')}/connection.ts';\n` +
      `export const target = open;\n`,
    'packages/screen/package.json': JSON.stringify(
      { name: '@cartografo/screen', dependencies: {} },
      null,
      2,
    ),
    'packages/screen/src/index.ts': `export const health = (url) => fetch(url + '/health');\n`,
    ...overrides,
  };
  for (const [relative, content] of Object.entries(files)) {
    write(root, relative, content);
  }
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('AT10 — extractImports catches import, export-from, import() and require()', async () => {
  const { extractImports } = await loadScript();

  const code = [
    "import fs from 'node:fs';",
    'import { a, b } from "./module-a.ts";',
    "import './side-effect.ts';",
    "export { c } from './module-c.ts';",
    "export * from './module-d.ts';",
    "const lazy = await import('./module-e.ts');",
    "const old = require('cjs-package');",
    "const notAnImport = 'package-that-only-shows-up-in-a-string';",
  ].join('\n');

  const found = extractImports(code);
  for (const expected of [
    'node:fs',
    './module-a.ts',
    './side-effect.ts',
    './module-c.ts',
    './module-d.ts',
    './module-e.ts',
    'cjs-package',
  ]) {
    assert.ok(found.includes(expected), `extractImports has to find "${expected}"`);
  }
  assert.ok(
    !found.includes('package-that-only-shows-up-in-a-string'),
    'a loose string is not an import: only a specifier position counts',
  );
});

test('AT11 — a tree with the driver only under the allowed path exits 0', async (t) => {
  const script = await loadScript();
  const root = buildTree(temporaryArea(t), script);

  const report = script.check(root);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  const cli = runCli(root);
  assert.equal(cli.status, 0, `the CLI should have exited 0:\n${cli.stdout}${cli.stderr}`);
});

test('AT12 — a driver import outside the owner exits 1 and names the file', async (t) => {
  const script = await loadScript();
  const { SQLITE_DRIVERS } = script;
  const root = buildTree(temporaryArea(t), script, {
    'packages/core/src/server.ts':
      `import Database from '${SQLITE_DRIVERS[0]}';\nexport const app = () => new Database(':memory:');\n`,
  });

  const report = script.check(root);
  assert.equal(report.valid, false);

  const violation = report.violations.find((v) => v.code === 'driver_fora_do_dono');
  assert.ok(violation, 'expected violation: driver_fora_do_dono');
  assert.equal(violation.file, 'packages/core/src/server.ts');
  assert.equal(violation.target, SQLITE_DRIVERS[0]);

  const cli = runCli(root);
  assert.equal(cli.status, 1);
  const output = `${cli.stdout}${cli.stderr}`;
  assert.ok(output.includes('packages/core/src/server.ts'), 'the CLI has to name the guilty file');
  assert.ok(output.includes(SQLITE_DRIVERS[0]), 'the CLI has to name the imported driver');
});

test('AT13 — a module outside the core importing the private database exits 1', async (t) => {
  const script = await loadScript();
  const { DB_OWNER_SEGMENT } = script;
  const root = buildTree(temporaryArea(t), script, {
    'packages/screen/src/index.ts':
      `import { open } from '../../${DB_OWNER_SEGMENT}/connection.ts';\n` +
      `export const health = open;\n`,
  });

  const report = script.check(root);
  assert.equal(report.valid, false);
  const violation = report.violations.find((v) => v.code === 'db_privado_importado');
  assert.ok(violation, 'expected violation: db_privado_importado');
  assert.equal(violation.file, 'packages/screen/src/index.ts');

  assert.equal(runCli(root).status, 1);

  // The same sweep, now with the root pointing only at the screen (FR7).
  const screenOnly = script.check(path.join(root, 'packages', 'screen'));
  assert.equal(screenOnly.valid, false);
  assert.ok(screenOnly.violations.some((v) => v.code === 'db_privado_importado'));
  assert.equal(runCli(path.join(root, 'packages', 'screen')).status, 1);
});

test('AT14 — a package outside the core declaring the driver as a dependency exits 1', async (t) => {
  const script = await loadScript();
  const { SQLITE_DRIVERS } = script;
  const root = buildTree(temporaryArea(t), script, {
    'packages/screen/package.json': JSON.stringify(
      { name: '@cartografo/screen', dependencies: { [SQLITE_DRIVERS[0]]: '^13.0.0' } },
      null,
      2,
    ),
  });

  const report = script.check(root);
  assert.equal(report.valid, false);
  const violation = report.violations.find((v) => v.code === 'driver_declarado_fora_do_core');
  assert.ok(violation, 'expected violation: driver_declarado_fora_do_core');
  assert.equal(violation.file, 'packages/screen/package.json');

  assert.equal(runCli(root).status, 1);
});

test('AT15 — the real repository passes the gate', async () => {
  const { check } = await loadScript();
  const report = check(ROOT);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  assert.equal(runCli().status, 0, 'the CLI with no argument sweeps the repo root');
});
