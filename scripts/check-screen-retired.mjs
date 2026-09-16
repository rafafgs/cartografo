/**
 * Static gate: the screen stays retired (t549, FR12; D27).
 *
 * D27 deleted the screen — its package, its command, its container and its
 * specifications. What a deletion cannot stop by itself is the name coming
 * back: a command line pasted from an old terminal into a new doc, an example
 * nobody re-read, a fixture copied from a file that predates the removal. So
 * every tracked, non-binary file is swept for both names the screen ever
 * shipped under, and a match is reported with its file and line:
 *
 * - `screen_name_leaked` — a retired name in a current-tense file.
 *
 * The historical record is exempt, and only it: `DECISIONS.md` and
 * `CHANGELOG.md` at the repository root, and everything under `notes/`. Those
 * are append-only accounts of what happened, and a decision or a closing note
 * that names the command it was about is telling the truth about its day.
 *
 * The names are assembled at load time rather than written out, in this file
 * and in its test: a literal here would be a leak this gate reports about
 * itself.
 *
 * Same shape as `scripts/check-single-writer.mjs` and
 * `scripts/check-readme-disclosure.mjs`: exported functions plus a thin CLI,
 * zero dependencies. The file list is `git ls-files`, so an untracked scratch
 * file never fails the gate and a tracked one never escapes it.
 *
 * CLI use: `node scripts/check-screen-retired.mjs [root...]`
 * (with no argument, it checks the repository root).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** This gate's diagnostic vocabulary. */
export const SCREEN_NAME_LEAKED = 'screen_name_leaked';

/** Both names the screen's command ever had: the Portuguese original and its rename. */
export const RETIRED_NAMES = Object.freeze([
  ['cartografo', 'tela'].join('-'),
  ['cartografo', 'screen'].join('-'),
]);

/** Root-level files that are the project's own historical record. */
const EXEMPT_FILES = Object.freeze(['DECISIONS.md', 'CHANGELOG.md']);

/** Directory whose every file is a frozen historical note. */
const EXEMPT_PREFIX = 'notes/';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Whether a tracked path is part of the historical record.
 *
 * @param {string} file Path relative to the repository root, `/`-separated.
 * @returns {boolean}
 */
export function isExempt(file) {
  return EXEMPT_FILES.includes(file) || file.startsWith(EXEMPT_PREFIX);
}

/**
 * One violation per line of `content` that carries a retired name.
 *
 * @param {string} file Path to report, relative to the checked root.
 * @param {string} content The file's text.
 * @returns {Array<{code: string, file: string, line: number, name: string, message: string}>}
 */
export function checkContent(file, content) {
  const violations = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const name = RETIRED_NAMES.find((retired) => text.includes(retired));
    if (name === undefined) continue;
    violations.push({
      code: SCREEN_NAME_LEAKED,
      file,
      line: index + 1,
      name,
      message: `names "${name}", which D27 retired; only DECISIONS.md, CHANGELOG.md and notes/ may`,
    });
  }
  return violations;
}

/** A NUL byte in the first few kilobytes is what git itself calls binary. */
function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/**
 * Sweeps every tracked file under `root` for the retired names.
 *
 * A tracked path that cannot be read (deleted in the working tree but not yet
 * staged) is skipped: there is nothing in it to leak.
 *
 * @param {string} root Git working tree to check. Default: the repository root.
 * @returns {{valid: boolean, violations: ReturnType<typeof checkContent>}}
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: absoluteRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  const violations = [];
  for (const file of listing.split('\0')) {
    if (file === '' || isExempt(file)) continue;

    let buffer;
    try {
      buffer = readFileSync(path.join(absoluteRoot, file));
    } catch {
      continue;
    }
    if (isBinary(buffer)) continue;

    violations.push(...checkContent(file, buffer.toString('utf8')));
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
      console.error(`  ${violation.code}: ${violation.file}:${String(violation.line)} ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
