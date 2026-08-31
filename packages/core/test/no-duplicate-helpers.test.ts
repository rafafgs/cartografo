/**
 * t210's gate: the helpers this package copied into every file have ONE home.
 *
 * Same shape as the D18 identifier sweeps: a
 * deterministic, re-runnable walk of `src/` instead of a convention a reviewer
 * has to remember. The problem it freezes is the one t210 measured — seventeen
 * private copies of `isObject`, two of `now()`, and two hand-written copies of
 * the same polling loop — and the reason to freeze it is that every copy is a
 * place the next bug has to be fixed again.
 *
 * The detector is deliberately narrow: a DEFINITION at the start of a line,
 * with at most an `export` in front of it. That is what a top-level helper looks
 * like in this package, and it is what a JSDoc line (` * function isObject`) and
 * a line comment (`// const now = …`) cannot look like — so no masking pass is
 * needed here, and the last test below proves the sweep still bites.
 *
 * Importing the name is not defining it: a file that says
 * `import { isObject } from '../util/is-object.ts'` never matches, which is the
 * whole point — sixteen files do exactly that now.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { requireArtifacts } from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_DIR = 'src';

/** The one home of each deduplicated helper, relative to `packages/core`. */
const SINGLE_HOME = Object.freeze({
  isObject: 'src/util/is-object.ts',
  now: 'src/repositories/common.ts',
});

/** The shared polling loop both dispatchers run on. */
const POLLING_MODULE = 'src/util/polling-dispatcher.ts';

/** The two daemons that used to carry a copy of that loop each. */
const DISPATCHERS = Object.freeze(['src/webhooks/dispatcher.ts', 'src/hooks/dispatcher.ts']);

/** Every `.ts` file under `packages/core/src`, relative to the package root. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (absolute: string): void => {
    for (const entry of readdirSync(absolute)) {
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.endsWith('.ts')) found.push(path.relative(PACKAGE_ROOT, child));
    }
  };
  walk(path.join(PACKAGE_ROOT, SOURCE_DIR));
  return found.sort();
}

/**
 * Does this source DEFINE a top-level helper with that name?
 *
 * The three spellings the package actually uses: a function declaration, an
 * arrow bound to a `const`, and either of those exported. Anchored at the start
 * of a line, so a mention inside prose or inside a nested scope is not a
 * definition.
 *
 * @param source File contents.
 * @param name Helper name.
 * @returns Whether a definition of that name starts a line.
 */
export function definesHelper(source: string, name: string): boolean {
  const declaration = new RegExp(`^(export )?(async )?function \\*?${name}\\s*[(<]`, 'm');
  const binding = new RegExp(`^(export )?(const|let|var) ${name}\\s*[:=]`, 'm');
  return declaration.test(source) || binding.test(source);
}

/** Every file under `src` that defines a helper with that name. */
function definitionsOf(name: string): string[] {
  return sourceFiles().filter((relative) =>
    definesHelper(readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8'), name),
  );
}

/** The module a file imports a given name from, or `undefined`. */
function importSourceOf(relative: string, name: string): string | undefined {
  const source = readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const bound = match[1].split(',').map((entry) => entry.trim());
    if (!bound.includes(name)) continue;
    return path.relative(PACKAGE_ROOT, path.resolve(PACKAGE_ROOT, path.dirname(relative), match[2]));
  }
  return undefined;
}

test('t210 — isObject is defined exactly once, in src/util/is-object.ts', () => {
  requireArtifacts(SINGLE_HOME.isObject);

  const files = sourceFiles();
  assert.ok(files.length > 30, `the sweep found only ${files.length} files; it is not walking the tree`);

  assert.deepEqual(
    definitionsOf('isObject'),
    [SINGLE_HOME.isObject],
    'isObject belongs to one module; every other file imports it',
  );
});

test('t210 — now() is defined exactly once, in src/repositories/common.ts', () => {
  assert.deepEqual(
    definitionsOf('now'),
    [SINGLE_HOME.now],
    'the clock of a write has one definition; a second one is a second answer to "what time is it"',
  );
});

test('t210 — both dispatchers run on the same polling loop', () => {
  requireArtifacts(POLLING_MODULE, ...DISPATCHERS);

  for (const dispatcher of DISPATCHERS) {
    assert.equal(
      importSourceOf(dispatcher, 'createPollingDispatcher'),
      POLLING_MODULE,
      `${dispatcher} has to take its tick loop from ${POLLING_MODULE}`,
    );
  }
});

test('t210 — no dispatcher keeps a scheduler of its own', () => {
  for (const dispatcher of DISPATCHERS) {
    const source = readFileSync(path.join(PACKAGE_ROOT, dispatcher), 'utf8');
    assert.ok(
      !source.includes('setInterval('),
      `${dispatcher} still arms its own timer: two copies of the loop is two places to fix the same bug`,
    );
  }

  assert.deepEqual(
    definitionsOf('createPollingDispatcher'),
    [POLLING_MODULE],
    'the loop itself is not exempt from the rule it exists to enforce',
  );
});

test('t210 — the sweep bites on a re-introduced copy', () => {
  const caught = [
    'function isObject(value: unknown): value is Record<string, unknown> {',
    'export function isObject(value: unknown): value is PlainObject {',
    'const isObject = (value: unknown): value is Record<string, unknown> =>',
    'export const now = (): string => new Date().toISOString();',
    'export function now(): string {',
  ];
  for (const source of caught) {
    const name = source.includes('isObject') ? 'isObject' : 'now';
    assert.ok(definesHelper(source, name), `the sweep missed a copy: ${source}`);
  }
});

test('t210 — the sweep does NOT bite on a mention or an import', () => {
  const allowed = [
    "import { isObject } from '../util/is-object.ts';",
    "import { now } from './common.ts';",
    ' * The `isObject` of this package lives in one module now.',
    '// const now = () => fake; — how the tests used to fake the clock',
    '  const moment = now();',
    'const clock = { now: options.now ?? now };',
  ];
  for (const source of allowed) {
    for (const name of ['isObject', 'now']) {
      assert.equal(definesHelper(source, name), false, `the sweep flagged a mention: ${source}`);
    }
  }
});
