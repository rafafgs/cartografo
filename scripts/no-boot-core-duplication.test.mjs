/**
 * Gate: exactly one copy of the "boot the real core" helper (t201, FR7).
 *
 * The pattern this sweep hunts is always the same four moves — spawn
 * `packages/core/bin/cartografo.mjs`, capture stdout, wait for the JSON line
 * carrying `cartografo.ready`, tear the child down with SIGTERM then SIGKILL —
 * and before t201 it existed, near enough verbatim, in eleven test files across
 * three packages. Eleven copies of a readiness wait means eleven places a race
 * has to be fixed, and eleven chances to fix ten of them.
 *
 * So the helper has an owner now, `packages/test-support`, and this gate is what
 * keeps it the only one. Two rules, both read off the source, running nothing:
 *
 * - `helper_redefinido` — the four reserved names may be DEFINED only under
 *   `packages/test-support/src/`. Importing them, or re-exporting one under
 *   another name (`export { bootCore as startControlPlane } from …`), is not a
 *   definition and is exactly how a consumer is supposed to reach them.
 * - `evento_de_prontidao_solto` — no test file spells the readiness event out
 *   as a string literal of its own. Naming it in prose is fine; a literal is a
 *   second copy of the announcement contract.
 *
 * Same shape as `scripts/no-portuguese-identifiers.test.mjs` and
 * `scripts/check-single-writer.mjs`: exported functions plus a CLI, zero
 * dependencies, and a report that comes out whole instead of stopping at the
 * first offender. It runs inside the root `node --test scripts/**\/*.test.mjs`
 * group (`scripts/run-all-tests.mjs`), so no wiring was needed there.
 *
 * ## Why four files under `packages/core/test/` are exempt
 *
 * t201's declared scope is the eleven duplicated copies, and core's own test
 * directory is not among them — for three different reasons, each recorded
 * against the file it applies to in {@link EXEMPT_FILES}. Two of them are tests
 * OF the readiness announcement (the literal is their subject, not a copy of
 * somebody else's plumbing); one is an in-process boot that never spawns
 * anything and shares only the name; one is a genuinely different spawn helper
 * — explicit port, subcommand arguments, an exposed `shutdown` — that a later
 * ticket may or may not want to fold in. The exemption is per file and never
 * per directory, so a NEW copy landing in `packages/core/test/` is still caught.
 *
 * CLI use: `node scripts/no-boot-core-duplication.test.mjs`
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

/** The workspace that owns the helper; its `src/` is the one legal home. */
export const OWNER_PACKAGE = 'test-support';

/** The specifier a consumer reaches the helper through. */
export const OWNER_SPECIFIER = '@cartografo/test-support';

/** The readiness event the control plane announces on stdout. */
export const READY_EVENT = 'cartografo.ready';

/** Names only `packages/test-support/src/**` may define. */
export const RESERVED_NAMES = Object.freeze([
  'startControlPlane',
  'bootCore',
  'spawnWatched',
  'awaitReadiness',
]);

/**
 * Files pinned from outside t201's scope, each with the reason it is pinned.
 *
 * Keys are repository-relative paths, so the exemption is one exact file and
 * never a directory. See this file's header.
 */
export const EXEMPT_FILES = Object.freeze({
  'packages/core/test/startup.test.ts':
    'the acceptance test OF the readiness announcement: the literal is its subject',
  'packages/core/test/cli-dispatch.test.ts':
    'asserts the announced event name itself, which is the contract this gate protects',
  'packages/core/test/support.ts':
    'boots the app IN PROCESS and spawns nothing; it shares the name and none of the plumbing',
  'packages/core/test/cli-support.ts':
    'a different spawn helper — explicit port, subcommand arguments, exposed shutdown — outside t201\'s eleven',
});

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

/** Words after which a `/` opens a regular expression instead of dividing. */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
  'delete',
  'void',
  'new',
]);

/** Characters after which a `/` opens a regular expression. */
const REGEX_PRECEDERS = new Set([
  '',
  '=',
  '(',
  ',',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
]);

/**
 * One left-to-right pass that blanks comments, and optionally string bodies.
 *
 * Both rules need comments gone, for opposite reasons: a doc block that says
 * "`{@link startControlPlane}`" is not a definition, and a doc block that
 * explains what `cartografo.ready` is is not a second copy of it. Only the
 * definition rule wants the strings gone as well — the literal rule is looking
 * for precisely what is inside them.
 *
 * Regular-expression literals are read as literals and not as division, because
 * a `/…/` carrying a quote (`/["']/`) would otherwise open a string that never
 * closes and silently blank the rest of the file — which is how a sweep stops
 * biting without anybody noticing.
 *
 * @param {string} source File contents.
 * @param {{strings?: boolean}} [options] `strings: true` blanks string bodies too.
 * @returns {string} The same text, same length, with those spans blanked.
 */
export function mask(source, { strings = false } = {}) {
  const out = [];
  let index = 0;
  let lastMeaningful = '';
  let lastWord = '';

  const readQuoted = (quote) => {
    out.push(source[index]);
    index += 1;
    const start = index;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) break;
      if (char === '\n' && quote !== '`') break;
      index += 1;
    }
    const body = source.slice(start, Math.min(index, source.length));
    out.push(strings ? blank(body) : body);
    if (index < source.length) {
      out.push(source[index]);
      index += 1;
    }
  };

  const readRegex = () => {
    out.push(source[index]);
    index += 1;
    const start = index;
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '\n') break;
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) break;
      index += 1;
    }
    out.push(blank(source.slice(start, Math.min(index, source.length))));
    if (index < source.length) {
      out.push(source[index]);
      index += 1;
    }
  };

  const readComment = (end) => {
    const stop = source.indexOf(end, index + 2);
    const finish = stop === -1 ? source.length : stop + end.length;
    out.push(blank(source.slice(index, finish)));
    index = finish;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      readComment('\n');
      continue;
    }
    if (char === '/' && next === '*') {
      readComment('*/');
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      readQuoted(char);
      lastMeaningful = char;
      lastWord = '';
      continue;
    }
    if (char === '/' && (REGEX_PRECEDERS.has(lastMeaningful) || REGEX_KEYWORDS.has(lastWord))) {
      readRegex();
      lastMeaningful = '/';
      lastWord = '';
      continue;
    }

    out.push(char);
    if (/[A-Za-z0-9_$]/.test(char)) {
      lastWord += char;
    } else if (!/\s/.test(char)) {
      lastWord = '';
    }
    if (!/\s/.test(char)) lastMeaningful = char;
    index += 1;
  }

  return out.join('');
}

/**
 * Every violation in one source text, as `{line, code, message}`.
 *
 * @param {string} source File contents.
 * @returns {Array<{line: number, code: string, message: string}>}
 */
export function hitsInSource(source) {
  const hits = [];

  const declarations = mask(source, { strings: true }).split('\n');
  declarations.forEach((line, index) => {
    for (const name of RESERVED_NAMES) {
      const defined =
        new RegExp(`(^|[^.\\w$])(?:async\\s+)?function\\s+${name}\\b`).test(line) ||
        new RegExp(`(^|[^.\\w$])(?:const|let|var)\\s+${name}\\s*[=:]`).test(line);
      if (defined) {
        hits.push({
          line: index + 1,
          code: 'helper_redefinido',
          message: `${name} is defined here; import it from ${OWNER_SPECIFIER} instead`,
        });
      }
    }
  });

  const literals = mask(source).split('\n');
  literals.forEach((line, index) => {
    // Only inside a string: the masking above already removed the comments, so
    // whatever survives here is code, and a bare occurrence in code is a literal.
    if (new RegExp(`['"\`]${READY_EVENT.replace('.', '\\.')}['"\`]`).test(line)) {
      hits.push({
        line: index + 1,
        code: 'evento_de_prontidao_solto',
        message: `the readiness event is spelled out here; ${OWNER_SPECIFIER} owns it`,
      });
    }
  });

  return hits.sort((a, b) => a.line - b.line);
}

/** Every `.ts` file under `dir`, recursively, as repository-relative paths. */
function typescriptFilesUnder(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFilesUnder(full);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return [path.relative(REPO_ROOT, full)];
  });
}

/**
 * The swept set: `packages/*\/test/**\/*.ts`, minus the owning package.
 *
 * @returns {string[]} Repository-relative paths, sorted.
 */
export function sweptFiles() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== OWNER_PACKAGE)
    .flatMap((entry) => typescriptFilesUnder(path.join(PACKAGES_DIR, entry.name, 'test')))
    .sort();
}

/**
 * Sweeps every test file of every package but the owner.
 *
 * @returns {{valid: boolean, violations: Array<{file: string, line: number, code: string, message: string}>}}
 */
export function check() {
  const violations = sweptFiles()
    .filter((file) => !(file in EXEMPT_FILES))
    .flatMap((file) =>
      hitsInSource(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map((hit) => ({
        file,
        ...hit,
      })),
    );

  return { valid: violations.length === 0, violations };
}

test('FR7 — the boot helper is defined in exactly one place', () => {
  const swept = sweptFiles();
  assert.ok(
    swept.length >= 20,
    `the sweep found only ${swept.length} test files; it is not reading the packages`,
  );

  const { violations } = check();
  const report = violations.map((hit) => `${hit.file}:${hit.line} — ${hit.code}: ${hit.message}`);

  assert.deepEqual(report, [], `the boot helper is duplicated (t201, FR7):\n${report.join('\n')}`);
});

test('FR7 — every exempt file still exists, and still needs its exemption', () => {
  for (const [file, reason] of Object.entries(EXEMPT_FILES)) {
    const full = path.join(REPO_ROOT, file);
    assert.ok(existsSync(full), `${file} is exempt but no longer exists; drop the exemption`);
    assert.ok(reason.length > 0, `${file} is exempt with no reason recorded`);
    assert.ok(
      hitsInSource(readFileSync(full, 'utf8')).length > 0,
      `${file} no longer trips the sweep; its exemption is dead code`,
    );
  }
});

test('FR7 — the sweep bites on a re-introduced copy', () => {
  const caught = [
    'async function startControlPlane(t) { return boot(t); }',
    'function spawnWatched(t, args, options) { return spawn(args); }',
    'export async function awaitReadiness(watched, event) { return {}; }',
    'const bootCore = async (t) => ({ url: "", token: "" });',
    "  .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));",
    'assert.equal(readiness.event, "cartografo.ready");',
  ];
  for (const source of caught) {
    assert.ok(hitsInSource(source).length > 0, `the sweep missed a copy: ${source}`);
  }
});

test('FR7 — the sweep does NOT bite on importing or re-exporting the helper', () => {
  const allowed = [
    `import { bootCore, spawnWatched, awaitReadiness } from '${OWNER_SPECIFIER}';`,
    `export { bootCore as startControlPlane } from '${OWNER_SPECIFIER}';`,
    `export { type RunningControlPlane } from '${OWNER_SPECIFIER}';`,
    'const { url, token } = await bootCore(t);',
    'const plane = await spawnWatched(t, [BIN_PATH], { cwd, env });',
    "await awaitReadiness(runner, 'cartografo.runner.ready');",
    // prose, in a comment, is how the plumbing gets explained to the next reader
    '/** Waits for the `cartografo.ready` line, the way `startControlPlane` used to. */',
    '// spawnWatched captures both streams; awaitReadiness parses cartografo.ready',
    // a member named like the helper is not a definition of it
    'await support.startControlPlane(t);',
    // a regex carrying a quote must not swallow the rest of the file
    'const quoted = text.replace(/["\']/g, ""); const ok = true;',
  ];
  for (const source of allowed) {
    assert.deepEqual(hitsInSource(source), [], `the sweep flagged a legal use: ${source}`);
  }
});

function main() {
  const { valid, violations } = check();

  if (valid) {
    console.log(`✔ one boot helper, in packages/${OWNER_PACKAGE}/src`);
    return 0;
  }

  console.error('✖ the boot helper is duplicated (t201, FR7)');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} ${violation.code}: ${violation.message}`);
  }
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main();
}
