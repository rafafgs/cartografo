/**
 * Static gate for D1 — "only the server writes to the database" (t100, FR6/FR7).
 *
 * Three rules, checked by reading the source, running nothing:
 *
 * - `driver_fora_do_dono` — the SQLite driver may only be imported by modules
 *   under `packages/core/src/db/`. That directory IS the database's owner;
 *   everything else in the core receives an already-open handle.
 * - `db_privado_importado` — `packages/core/src/db/**` is private to the core
 *   package. Nobody outside it (starting with the screen, D11) reaches those
 *   modules.
 * - `driver_declarado_fora_do_core` — no `package.json` outside
 *   `packages/core` declares the driver as a dependency. A package that may not
 *   import the driver has no reason to install it either.
 *
 * Same shape as `scripts/validate-graph.mjs`: exported function plus a CLI, zero
 * dependencies, no fatal error on a malformed file — the report comes out
 * whole, not at the first problem.
 *
 * The file NAME is frozen even though its insides are not: three packages'
 * `no-privileged-access.test.ts` spawn it by path and read its exit code
 * (t133, exception 6). Nothing imports a name out of it, so everything below is
 * free to read as English. The three rule codes stay as they are: they are this
 * gate's diagnostic vocabulary, the same way the validator's codes are.
 *
 * CLI use: `node scripts/check-single-writer.mjs [root...]`
 * (with no argument, it sweeps the repository root).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** SQLite driver packages this gate recognizes. */
export const SQLITE_DRIVERS = Object.freeze([
  'better-sqlite3',
  'sqlite3',
  'node:sqlite',
  'libsql',
  '@libsql/client',
]);

/** The package that owns the database (D1). */
export const DB_OWNER_PACKAGE = 'packages/core';

/** Directory, inside the owning package, that may touch the driver. */
export const DB_OWNER_PREFIX = 'packages/core/src/db';

/**
 * Suffix of the owner's path, used to recognize a reach into the private
 * database even when the sweep starts outside the repo root (e.g. sweeping only
 * `packages/tela/`, where the import target falls outside the swept tree).
 */
export const DB_OWNER_SEGMENT = 'core/src/db';

/** Code extensions the gate reads. */
export const EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);

/** Directories the sweep never enters. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cartografo',
]);

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** Patterns that capture a module specifier in an import position. */
const IMPORT_PATTERNS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g, // import ... from 'x' | export ... from 'x'
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // import('x')
  /\bimport\s+['"]([^'"\n]+)['"]/g, // import 'x'
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, // require('x')
];

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const toPosix = (filePath) => filePath.split(path.sep).join('/');

const isUnder = (relative, prefix) => relative === prefix || relative.startsWith(`${prefix}/`);

/**
 * Extracts the module specifiers a file imports.
 *
 * Textual reading, no parser: the goal is a small gate with no dependency, and
 * a specifier only exists in a fixed syntactic position. A loose occurrence of
 * the driver's name in a string or a comment does NOT count.
 *
 * @param code File contents.
 * @returns The specifiers found, without repetition.
 */
export function extractImports(code) {
  const found = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      found.add(match[1]);
    }
  }
  return [...found];
}

/** Recursively lists the relevant files under `root` (absolute paths). */
function listFiles(root) {
  const found = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // an unreadable directory does not bring the gate down
    }

    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(filePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'package.json' || EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(filePath);
      }
    }
  }

  return found.sort();
}

/** Resolves a relative specifier; returns `null` for a bare specifier. */
function resolveRelative(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  return path.resolve(path.dirname(file), specifier);
}

/** Does an import reach the private database? */
function reachesPrivateDb(file, specifier, root) {
  const resolved = resolveRelative(file, specifier);
  const target = resolved === null ? specifier : toPosix(path.relative(root, resolved));
  const posix = toPosix(target);
  return posix.includes(`${DB_OWNER_SEGMENT}/`) || posix.endsWith(DB_OWNER_SEGMENT);
}

function checkPackageJson(relative, content, annotate) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    return; // broken JSON is another gate's problem
  }
  if (relative === `${DB_OWNER_PACKAGE}/package.json`) return;

  for (const field of DEPENDENCY_FIELDS) {
    const declared = Object.keys(manifest?.[field] ?? {});
    for (const driver of SQLITE_DRIVERS) {
      if (!declared.includes(driver)) continue;
      annotate(
        'driver_declarado_fora_do_core',
        `"${relative}" declares the driver "${driver}" in ${field}; only ${DB_OWNER_PACKAGE} may (D1)`,
        driver,
        relative,
      );
    }
  }
}

/**
 * Runs the three rules over a file tree.
 *
 * @param root Directory to sweep. Default: the repository root.
 * @returns `{valid, violations}`; each violation carries `code`, `file`
 *   (relative to the swept root), `message` and `target`.
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const violations = [];
  const annotate = (code, message, target, file) =>
    violations.push({ code, file, message, target });

  for (const file of listFiles(absoluteRoot)) {
    const relative = toPosix(path.relative(absoluteRoot, file));

    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    if (path.basename(file) === 'package.json') {
      checkPackageJson(relative, content, annotate);
      continue;
    }

    const mayUseDriver = isUnder(relative, DB_OWNER_PREFIX);
    const isOwnerPackage = isUnder(relative, DB_OWNER_PACKAGE);

    for (const specifier of extractImports(content)) {
      if (SQLITE_DRIVERS.includes(specifier) && !mayUseDriver) {
        annotate(
          'driver_fora_do_dono',
          `"${relative}" imports the driver "${specifier}"; only ${DB_OWNER_PREFIX}/ may (D1)`,
          specifier,
          relative,
        );
      }
      if (!isOwnerPackage && reachesPrivateDb(file, specifier, absoluteRoot)) {
        annotate(
          'db_privado_importado',
          `"${relative}" imports "${specifier}", a private module of ${DB_OWNER_PACKAGE} (D1/D11)`,
          specifier,
          relative,
        );
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

function main(roots) {
  const targets = roots.length > 0 ? roots : [REPO_ROOT];
  let failed = false;

  for (const root of targets) {
    const report = check(root);
    if (report.valid) {
      console.log(`✔ ${root}`);
      continue;
    }
    failed = true;
    console.error(`✖ ${root}`);
    for (const violation of report.violations) {
      console.error(`  ${violation.code}: ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
