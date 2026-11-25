/**
 * No runtime child process opens a console window on Windows (t1438).
 *
 * cartografo's services run with no console, and on Windows a console program
 * started by such a process gets a new visible one unless it is spawned with
 * `windowsHide: true`. Node's default is `false`, so every call site has to say
 * so. This is a syntax-tree scan and not a `child_process` spy: it covers sites
 * no test executes, and sites added later.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');

const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
const MODULES = new Set(['node:child_process', 'child_process']);
const SOURCE_FILE = /\.(ts|mts|js|mjs|cjs)$/;

/**
 * The files that pass `spawnSync` around as a test seam. Their calls go through
 * the seam, so the scan cannot see them; `packages/core/test/lock.test.ts` and
 * `packages/runner/test/engine/process-tree-stop.test.ts` pin their options.
 */
const SEAM_FILES = new Set([
  'packages/core/src/db/lock.ts',
  'packages/runner/src/engine/process-lifecycle.ts',
]);

/** The two files that spawn an engine or shell session. */
const SESSION_SPAWN_FILES = [
  'packages/runner/src/engine/process-lifecycle.ts',
  'packages/runner/src/engine/shell-adapter.ts',
];

const isChildProcess = (node) =>
  node !== undefined && ts.isStringLiteralLike(node) && MODULES.has(node.text);

/** The initializer of `name:` in an object literal argument of `call`, if any. */
function optionOf(call, name) {
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
        return property.initializer;
      }
    }
  }
  return undefined;
}

function isTypePosition(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
  }
  return false;
}

/** Whether an identifier is only the NAME of something, not a read of a binding. */
function isName(node) {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent)) return true;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node || parent.name === node;
  // `{ spawn }` reads the binding; every other `name:` position only names.
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  return parent.name === node;
}

/**
 * Reads one source and reports what it does with `child_process`.
 *
 * @returns direct calls of the imported functions, value references that are
 *   not calls, and import forms through which a call would escape the scan.
 */
function scanSource(fileName, text) {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const imported = new Map();
  const calls = [];
  const valueReferences = [];
  const escapes = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !isChildProcess(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    if (clause.name !== undefined) escapes.push(lineOf(statement));
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      escapes.push(lineOf(statement));
      continue;
    }
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (name === 'default') escapes.push(lineOf(statement));
      if (SPAWNERS.has(name) && !element.isTypeOnly) imported.set(element.name.text, name);
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
      escapes.push(lineOf(node));
      return;
    }
    if (
      ts.isExternalModuleReference(node) &&
      isChildProcess(node.expression)
    ) {
      escapes.push(lineOf(node));
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      if (loads && isChildProcess(node.arguments[0])) escapes.push(lineOf(node));

      if (ts.isIdentifier(callee) && imported.has(callee.text)) {
        const detached = optionOf(node, 'detached');
        calls.push({
          line: lineOf(node),
          name: imported.get(callee.text),
          hidden: optionOf(node, 'windowsHide')?.kind === ts.SyntaxKind.TrueKeyword,
          literalDetached: detached?.kind === ts.SyntaxKind.TrueKeyword,
          ownGroupDetached:
            detached !== undefined &&
            ts.isCallExpression(detached) &&
            detached.expression.getText(source) === 'startsOwnGroup',
        });
        node.arguments.forEach(visit);
        return;
      }
    }
    if (
      ts.isIdentifier(node) &&
      imported.has(node.text) &&
      !isName(node) &&
      !isTypePosition(node)
    ) {
      valueReferences.push(lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { calls, valueReferences, escapes };
}

/** Every runtime source of every package but the test helpers. */
function runtimeSources() {
  const files = [];
  const packages = path.join(ROOT, 'packages');
  for (const name of readdirSync(packages)) {
    if (name === 'test-support') continue;
    for (const folder of ['src', 'bin']) {
      const base = path.join(packages, name, folder);
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !SOURCE_FILE.test(entry.name)) continue;
        const absolute = path.join(entry.parentPath, entry.name);
        const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
        if (relative.includes('/node_modules/')) continue;
        files.push(relative);
      }
    }
  }
  return files.sort();
}

const SCANNED = runtimeSources().map((file) => ({
  file,
  ...scanSource(file, readFileSync(path.join(ROOT, file), 'utf8')),
}));

const ALL_CALLS = SCANNED.flatMap(({ file, calls }) => calls.map((call) => ({ file, ...call })));

const at = ({ file, line }) => `${file}:${line}`;

test('t1438 AT1 — every direct child_process call passes windowsHide: true', () => {
  const offenders = ALL_CALLS.filter((call) => !call.hidden).map(at);
  assert.deepEqual(offenders, [], `calls without windowsHide: true:\n${offenders.join('\n')}`);
});

test('t1438 AT2 — the scan is not vacuous', () => {
  assert.ok(ALL_CALLS.length >= 21, `only ${ALL_CALLS.length} direct calls examined`);
});

test('t1438 AT3 — no child_process function is passed around outside the seam files', () => {
  const offenders = SCANNED.filter(({ file }) => !SEAM_FILES.has(file)).flatMap(
    ({ file, valueReferences }) => valueReferences.map((line) => at({ file, line })),
  );
  assert.deepEqual(offenders, [], `value references:\n${offenders.join('\n')}`);

  const sample = scanSource(
    'sample.ts',
    [
      "import { spawnSync, execFile as run } from 'node:child_process';",
      'const a = seams.spawnSync ?? spawnSync;',
      'const b = promisify(run);',
      'let c: typeof spawnSync | undefined;',
      'const d = { spawnSync: undefined };',
    ].join('\n'),
  );
  assert.deepEqual(sample.valueReferences, [2, 3]);
});

test('t1438 AT4 — child_process is only ever imported by name', () => {
  const offenders = SCANNED.flatMap(({ file, escapes }) =>
    escapes.map((line) => at({ file, line })),
  );
  assert.deepEqual(offenders, [], `imports that escape the scan:\n${offenders.join('\n')}`);

  const sample = scanSource(
    'sample.ts',
    [
      "import cp from 'node:child_process';",
      "import * as all from 'child_process';",
      "const later = await import('node:child_process');",
      "const old = require('child_process');",
      "import type { ChildProcess } from 'node:child_process';",
    ].join('\n'),
  );
  assert.deepEqual(sample.escapes, [1, 2, 3, 4]);
});

test('t1438 AT5 — the scanner reports only the call lacking the flag', () => {
  const { calls } = scanSource(
    'sample.ts',
    [
      "import { execFile as run } from 'node:child_process';",
      "run('git', ['status'], { encoding: 'utf8' });",
      "run('git', ['status'], { encoding: 'utf8', windowsHide: true });",
    ].join('\n'),
  );
  assert.deepEqual(
    calls.filter((call) => !call.hidden).map((call) => call.line),
    [2],
  );
});

test('t1438 AT6 — detached is never a literal true, and sessions ask startsOwnGroup', () => {
  const offenders = ALL_CALLS.filter((call) => call.literalDetached).map(at);
  assert.deepEqual(offenders, [], `literal detached: true:\n${offenders.join('\n')}`);

  for (const file of SESSION_SPAWN_FILES) {
    const spawns = ALL_CALLS.filter((call) => call.file === file && call.name === 'spawn');
    assert.ok(spawns.length > 0, `no session spawn found in ${file}`);
    assert.deepEqual(
      spawns.filter((call) => !call.ownGroupDetached).map(at),
      [],
      `session spawns not using startsOwnGroup()`,
    );
  }
});
