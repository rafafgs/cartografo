/**
 * Static gate: gate 3 (FlowPilot's test stage) can only validate acceptance
 * criteria against a running application if the Profile actually declares
 * one (t472, FR5).
 *
 * `.flowpilot/profile.yml`'s `commands.run` used to be `null` with no
 * `app_url` key at all, which degrades gate 3 to re-validating the checkout
 * rather than a live instance — recorded in words, on `stage_runs` #2124.
 * This gate pins the fix (FR1-FR3) so it cannot silently regress:
 *
 * - `run_missing` — `commands.run` is `null` or absent.
 * - `app_url_missing` — the top-level `app_url` key is `null` or absent.
 * - `port_mismatch` — both are present, but the port `CARTOGRAFO_SCREEN_PORT=`
 *   sets inside `commands.run` disagrees with the port in `app_url`.
 *
 * Same shape as `scripts/check-single-writer.mjs` and
 * `scripts/check-readme-disclosure.mjs`: exported functions plus a thin CLI,
 * zero dependencies. `.flowpilot/profile.yml` has no other consumer in this
 * repository, so a text/regex read of its two relevant lines is used instead
 * of a full YAML parser — same reasoning as those two gates.
 *
 * CLI use: `node scripts/check-test-bench-profile.mjs [root...]`
 * (with no argument, it checks the repository root).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** This gate's diagnostic vocabulary. */
export const RUN_MISSING = 'run_missing';
export const APP_URL_MISSING = 'app_url_missing';
export const PORT_MISMATCH = 'port_mismatch';
export const FILE_UNREADABLE = 'profile_unreadable';

/** Path of the Profile, relative to the checked root. */
export const PROFILE_FILE = '.flowpilot/profile.yml';

/** Env var `commands.run` sets to pick the screen's port (`up.ts`). */
export const SCREEN_PORT_ENV = 'CARTOGRAFO_SCREEN_PORT';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Matches an indented `run:` scalar line, inside whatever block it sits in. */
const RUN_LINE_RE = /^[ \t]+run:[ \t]*(.*)$/;

/** Matches the top-level `app_url:` scalar (zero indentation). */
const APP_URL_LINE_RE = /^app_url:[ \t]*(.*)$/;

const SCREEN_PORT_ASSIGNMENT_RE = new RegExp(`\\b${SCREEN_PORT_ENV}=(\\d+)`);

/**
 * Reduces a raw YAML scalar to its value, or `null` for absent/`null`.
 *
 * Handles the two quoting styles this file already uses elsewhere
 * (`'...'`/`"..."`) and trims trailing comments are NOT stripped — neither
 * line this gate reads carries one in practice, and stripping `#` blindly
 * would break a URL query string if one were ever added.
 */
function parseScalar(raw) {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Extracts `commands.run`'s raw value, or `null` if absent/unset.
 *
 * Line-based, not a single multi-line regex: the `commands:` block ends at
 * the next zero-indentation line, which may be the last line in the file —
 * a lookahead anchored on "another top-level key or end of string" is exactly
 * the case JS regex has no built-in end-of-string atom for outside `$` (which
 * `m` mode also matches at every line end), so the block is walked line by
 * line instead.
 */
export function extractRunCommand(content) {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => /^commands:\s*$/.test(line));
  if (start === -1) return null;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (!/^[ \t]/.test(line)) break; // back to zero indentation: block is over
    const match = line.match(RUN_LINE_RE);
    if (match) return parseScalar(match[1]);
  }
  return null;
}

/** Extracts the top-level `app_url`, or `null` if absent/unset. */
export function extractAppUrl(content) {
  for (const line of content.split('\n')) {
    const match = line.match(APP_URL_LINE_RE);
    if (match) return parseScalar(match[1]);
  }
  return null;
}

/** The port `CARTOGRAFO_SCREEN_PORT=` sets inside a `run` command, or `null`. */
export function extractRunPort(runCommand) {
  const match = runCommand?.match(SCREEN_PORT_ASSIGNMENT_RE);
  return match ? match[1] : null;
}

/** The port an `app_url` binds, or `null` if it cannot be parsed as a URL. */
export function extractAppUrlPort(appUrl) {
  try {
    const url = new URL(appUrl);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return null;
  }
}

/**
 * Checks the Profile's `commands.run` and `app_url` against FR1-FR3.
 *
 * @param root Directory to check. Default: the repository root.
 * @returns `{valid, violations}`; each violation carries `code`, `file`
 *   (relative to the checked root), `message` and `target`.
 */
export function check(root = REPO_ROOT) {
  const absoluteRoot = path.resolve(root);
  const file = PROFILE_FILE;
  const filePath = path.join(absoluteRoot, file);

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return {
      valid: false,
      violations: [
        {
          code: FILE_UNREADABLE,
          file,
          message: `"${file}" could not be read; the test-bench gate cannot be verified`,
          target: file,
        },
      ],
    };
  }

  const violations = [];
  const runCommand = extractRunCommand(content);
  const appUrl = extractAppUrl(content);

  if (runCommand === null) {
    violations.push({
      code: RUN_MISSING,
      file,
      message:
        '"commands.run" is null or absent; gate 3 has no way to start a running application',
      target: 'commands.run',
    });
  }

  if (appUrl === null) {
    violations.push({
      code: APP_URL_MISSING,
      file,
      message: '"app_url" is null or absent; gate 3 has nothing to poll once it starts "run"',
      target: 'app_url',
    });
  }

  if (runCommand !== null && appUrl !== null) {
    const runPort = extractRunPort(runCommand);
    const appUrlPort = extractAppUrlPort(appUrl);
    if (runPort !== appUrlPort) {
      violations.push({
        code: PORT_MISMATCH,
        file,
        message: `"commands.run" sets ${SCREEN_PORT_ENV}=${runPort ?? '(none)'} but "app_url" binds port ${appUrlPort ?? '(unparseable)'}; gate 3 would poll the wrong instance`,
        target: 'app_url',
      });
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
      console.error(`  ${violation.code}: "${violation.file}" ${violation.message}`);
    }
  }

  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
