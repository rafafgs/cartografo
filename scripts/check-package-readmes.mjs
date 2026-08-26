/**
 * Static gate: every workspace under `packages/` carries a page of its own
 * (t330, FR5).
 *
 * One rule, checked by looking at the filesystem and running nothing:
 *
 * - `package_missing_readme` — every directory directly under `packages/` has a
 *   `README.md` with something in it.
 *
 * The failure it exists against is not a defect and breaks no test, which is
 * exactly why it survived seven hundred commits: six workspaces, each with a
 * one-line `description` in its manifest, and not one `README.md` between them.
 * A repository with a single reader does not need them — that reader knows which
 * of `surveyor` and `cost-surveyor` opens the session. GitHub's file view is the
 * first thing a stranger meets, and there the six directories are
 * indistinguishable without opening source. t330 wrote the six pages; this gate
 * is what makes the seventh package arrive with one.
 *
 * A blank file is read as no file. That is the same rule and not a second one:
 * an empty `README.md` makes the claim this gate checks and does not keep it,
 * and letting it pass would turn the gate into a check that a filename exists.
 * What it deliberately does NOT judge is content — whether a page says anything
 * specific about ITS package is the review gate's agentic check, with its own
 * evidence, because that is not a deterministic property (t330, AC3).
 *
 * Same shape as `scripts/check-bin-dependencies.mjs`: exported function plus a
 * thin CLI, zero dependencies, and an unreadable entry is skipped rather than
 * fatal — the report comes out whole, not at the first problem.
 *
 * The rule code is this gate's diagnostic vocabulary, like the one of the
 * shipped-bin gate; everything else here reads as English (D24).
 *
 * CLI use: `node scripts/check-package-readmes.mjs [root...]`
 * (with no argument, it sweeps the repository root).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Directory the workspaces live in. */
export const PACKAGES_DIR = 'packages';

/** The page every workspace owes its readers. */
export const README_FILENAME = 'README.md';

/** The one rule code this gate reports. */
export const MISSING_PACKAGE_README = 'package_missing_readme';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Every directory directly under `packages/`, by name and sorted.
 *
 * Directories and not manifests: a workspace that lost its `package.json` is
 * another gate's problem, and a directory sitting in `packages/` with no page is
 * this one's whether or not npm considers it a package.
 */
function listPackageDirectories(root) {
  let entries;
  try {
    entries = readdirSync(path.join(root, PACKAGES_DIR), { withFileTypes: true });
  } catch {
    return []; // no `packages/` here: nothing this gate has an opinion about
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Does this path hold a page with something in it? */
function holdsPage(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return false; // absent, a directory, or unreadable: no page either way
  }
  return content.trim() !== '';
}

/**
 * Runs the rule over a workspace tree.
 *
 * @param root Directory to sweep. Default: the repository root.
 * @returns `{valid, violations}`; each violation carries `code`, `file` (the
 *   package directory, relative to the swept root), `message` and `target` (the
 *   page it wanted).
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const violations = [];

  for (const name of listPackageDirectories(absoluteRoot)) {
    const directory = `${PACKAGES_DIR}/${name}`;
    const expected = `${directory}/${README_FILENAME}`;
    if (holdsPage(path.join(absoluteRoot, PACKAGES_DIR, name, README_FILENAME))) continue;

    violations.push({
      code: MISSING_PACKAGE_README,
      file: directory,
      message: `has no ${README_FILENAME} worth reading; a stranger browsing the file view learns what this package does from it or from nothing`,
      target: expected,
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
