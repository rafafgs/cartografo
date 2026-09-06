/**
 * Puts the bundled siblings where `npm pack` can actually find them (t248, D23).
 *
 * D23 ships `cartografo` as ONE package carrying every command, and FR4 does it
 * with `bundledDependencies`: the five sibling workspace packages are inlined
 * into the tarball under `package/node_modules/@cartografo/*`, so a stranger who
 * installs it gets all six commands and no checkout is involved.
 *
 * The problem this script exists against is a plain layout mismatch, and it is
 * silent — which is the dangerous part. npm decides what to bundle by walking
 * the packed package's OWN `node_modules` directory. In a workspace install
 * every dependency is hoisted to the repository root instead, so
 * `packages/core/node_modules` does not exist at all: `npm pack --workspace
 * cartografo` then finds nothing to bundle, says nothing about it, and produces
 * a perfectly valid tarball with exactly one command in it. That tarball only
 * fails later, on somebody else's machine, with `ERR_MODULE_NOT_FOUND`.
 *
 * So this runs as `packages/core`'s `prepack`, which npm runs before `pack` AND
 * before `publish` — the two moments, and the only two, where the layout has to
 * be right. It creates one symlink per sibling, pointing at the workspace
 * directory the root already resolves to; npm dereferences them while packing
 * and writes the real files into the tarball, honouring each sibling's own
 * `files` field.
 *
 * Nothing here is a build step: no file is generated, compiled or moved, and the
 * links are inside `node_modules/`, which is gitignored at any depth — the CI
 * step that fails on any write inside the checkout stays green.
 *
 * Idempotent: an existing correct link is left alone, and anything else in its
 * place is replaced.
 *
 * CLI use: `node scripts/link-bundled-siblings.mjs` (this is `prepack`).
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** The package whose tarball carries the others. */
export const HOST_PACKAGE = path.join(REPO_ROOT, 'packages', 'core');

/** Scope every sibling is published under. */
const SCOPE = '@cartografo';

/**
 * Where a scoped workspace package lives, by name.
 *
 * The directory is NOT always the part after the scope — `@cartografo/screen`
 * lives in `packages/screen`, and assuming that everywhere is how a sixth
 * package would quietly fail to bundle one day. So the mapping is read from the
 * manifests themselves.
 */
function workspaceDirectories() {
  const found = new Map();
  const packagesDir = path.join(REPO_ROOT, 'packages');

  for (const entry of readdirSyncSafe(packagesDir)) {
    const manifestPath = path.join(packagesDir, entry, 'package.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest?.name === 'string') {
        found.set(manifest.name, path.join(packagesDir, entry));
      }
    } catch {
      // Broken JSON is another gate's problem; a missing entry fails loudly below.
    }
  }

  return found;
}

/** The entries of `dir`, or none at all when there is no such directory. */
function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Creates the links `npm pack` needs, and reports what it did.
 *
 * @param hostPackage Directory of the package being packed.
 * @returns One `{name, target, action}` per sibling.
 */
export function linkBundledSiblings(hostPackage = HOST_PACKAGE) {
  const manifest = JSON.parse(readFileSync(path.join(hostPackage, 'package.json'), 'utf8'));
  const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  const directories = workspaceDirectories();
  const results = [];

  for (const name of bundled) {
    if (!name.startsWith(`${SCOPE}/`)) continue; // only this repo's own packages are linked
    const target = directories.get(name);
    if (target === undefined) {
      throw new Error(
        `"${name}" is listed under bundledDependencies but no package under packages/ declares that name`,
      );
    }

    const linkPath = path.join(hostPackage, 'node_modules', name);
    mkdirSync(path.dirname(linkPath), { recursive: true });

    const relative = path.relative(path.dirname(linkPath), target);
    let action = 'created';

    if (existsSync(linkPath) || isSymlink(linkPath)) {
      if (isSymlink(linkPath) && readlinkSync(linkPath) === relative) {
        results.push({ name, target: relative, action: 'kept' });
        continue;
      }
      rmSync(linkPath, { recursive: true, force: true });
      action = 'replaced';
    }

    symlinkSync(relative, linkPath, 'dir');
    results.push({ name, target: relative, action });
  }

  return results;
}

/** `existsSync` follows links, so a broken one needs asking about differently. */
function isSymlink(target) {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

if (import.meta.filename === process.argv[1]) {
  for (const { name, target, action } of linkBundledSiblings()) {
    console.log(`${action}: ${name} -> ${target}`);
  }
}
