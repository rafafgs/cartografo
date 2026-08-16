/**
 * Static gate: a package that ships a command declares what that command needs
 * to RUN, not only what this repository needs to develop it (t199, FR2).
 *
 * One rule, checked by reading manifests and running nothing:
 *
 * - `bin_missing_runtime_loader` — every `packages/<name>/package.json` with a
 *   `bin` field lists `tsx` under `dependencies`.
 *
 * The failure it exists against is invisible from inside the monorepo. Each
 * `bin/*.mjs` here opens with `import { register } from 'tsx/esm/api'` — that is
 * the whole point of the `.mjs` shell, so nobody has to remember `--import tsx`
 * — which makes the loader a RUNTIME dependency of whoever types the command. In
 * a workspace install every dependency of every kind is on disk, so a `tsx`
 * misfiled under `devDependencies` behaves perfectly. Install the tarball
 * instead, the way `npx cartografo-tela` does, and the command dies on its first
 * line with `ERR_MODULE_NOT_FOUND`.
 *
 * Same shape as `scripts/check-single-writer.mjs`: exported function plus a thin
 * CLI, zero dependencies, and a malformed manifest is skipped rather than fatal —
 * the report comes out whole, not at the first problem.
 *
 * The rule code is this gate's diagnostic vocabulary, like the three of the
 * single-writer gate; everything else here reads as English (D18).
 *
 * CLI use: `node scripts/check-bin-dependencies.mjs [root...]`
 * (with no argument, it sweeps the repository root).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** The loader every `bin/*.mjs` in this repository registers before anything else. */
export const RUNTIME_LOADER = 'tsx';

/** Directory the workspaces live in. */
export const PACKAGES_DIR = 'packages';

/** The one rule code this gate reports. */
export const MISSING_RUNTIME_DEPENDENCY = 'bin_missing_runtime_loader';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Reads and parses a manifest; `null` when it is unreadable or not JSON. */
function readManifest(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(content);
  } catch {
    return null; // broken JSON is another gate's problem
  }
}

/** Does this manifest declare a command? `bin` is a string OR an object. */
function shipsCommand(manifest) {
  const declared = manifest?.bin;
  if (typeof declared === 'string') return declared.trim() !== '';
  return (
    typeof declared === 'object' && declared !== null && Object.keys(declared).length > 0
  );
}

/** Which dependency fields of this manifest mention the loader. */
function fieldsDeclaring(manifest, name) {
  const fields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  return fields.filter((field) => Object.keys(manifest?.[field] ?? {}).includes(name));
}

/** Every `packages/<name>/package.json` under `root`, absolute and sorted. */
function listManifests(root) {
  let entries;
  try {
    entries = readdirSync(path.join(root, PACKAGES_DIR), { withFileTypes: true });
  } catch {
    return []; // no `packages/` here: nothing this gate has an opinion about
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, PACKAGES_DIR, entry.name, 'package.json'))
    .sort();
}

/**
 * Runs the rule over a workspace tree.
 *
 * @param root Directory to sweep. Default: the repository root.
 * @returns `{valid, violations}`; each violation carries `code`, `file`
 *   (relative to the swept root), `message` and `target`.
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const violations = [];

  for (const filePath of listManifests(absoluteRoot)) {
    const manifest = readManifest(filePath);
    if (manifest === null || !shipsCommand(manifest)) continue;

    const declaredIn = fieldsDeclaring(manifest, RUNTIME_LOADER);
    if (declaredIn.includes('dependencies')) continue;

    const where =
      declaredIn.length === 0
        ? 'nowhere in the manifest'
        : `only under ${declaredIn.join(' and ')}`;

    violations.push({
      code: MISSING_RUNTIME_DEPENDENCY,
      file: path.relative(absoluteRoot, filePath).split(path.sep).join('/'),
      message: `declares a "bin" but lists "${RUNTIME_LOADER}" ${where}; the command imports it at startup, so it belongs in dependencies`,
      target: RUNTIME_LOADER,
    });
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
      console.error(`  ${violation.code}: "${violation.file}" ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
