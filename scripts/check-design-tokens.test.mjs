/**
 * Acceptance tests of the design-token gate (t458).
 *
 * Same pattern `scripts/check-single-writer.test.mjs` uses: fixtures written
 * into a temporary directory, both the exported rule functions and the CLI
 * exercised. Every fixture but the base one starts from {@link GOOD_CSS} and
 * changes exactly one thing, so a failing assertion points at one rule.
 *
 * Run with: `npm test` at the root.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-design-tokens.mjs');
const REAL_STYLESHEET = path.join(ROOT, 'packages/screen/src/public/style.css');

let scriptModule = null;

async function loadScript() {
  assert.ok(existsSync(SCRIPT_PATH), 'artifact does not exist yet: scripts/check-design-tokens.mjs');
  scriptModule ??= await import(new URL('./check-design-tokens.mjs', import.meta.url));
  return scriptModule;
}

function temporaryArea(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t458-tokens-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/** Writes one CSS fixture into its own temp directory and returns that directory. */
function writeFixture(t, content) {
  const dir = temporaryArea(t);
  writeFileSync(path.join(dir, 'style.css'), content, 'utf8');
  return dir;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * A fixture that conforms to all six rules: tokens only, `var(--radius)`, no
 * `opacity`, no `box-shadow`, and the one `:focus-visible` rule §3 asks for.
 */
const GOOD_CSS = `
:root {
  --ink: hsl(240 6% 10%);
  --line: hsl(240 6% 90%);
  --soft: hsl(240 4% 46%);
  --radius: 8px;
}

.card {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--soft);
}

:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 2px;
}
`;

test('AT1 — a fixture that only uses tokens, var(--radius) and a conforming focus rule passes', async (t) => {
  const { check } = await loadScript();
  const dir = writeFixture(t, GOOD_CSS);

  const report = check(dir);
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  const cli = runCli(dir);
  assert.equal(cli.status, 0, `the CLI should have exited 0:\n${cli.stdout}${cli.stderr}`);
});

test('AT2 — a hex literal outside :root fails, naming the rule and the line', async (t) => {
  const { check, COLOR_LITERAL_OUTSIDE_ROOT } = await loadScript();
  const content = `${GOOD_CSS}\n.bad {\n  color: #ff0000;\n}\n`;
  const dir = writeFixture(t, content);

  const report = check(dir);
  assert.equal(report.valid, false);
  const violation = report.violations.find((v) => v.code === COLOR_LITERAL_OUTSIDE_ROOT);
  assert.ok(violation, 'expected violation: color_literal_outside_root');
  assert.equal(violation.line, content.slice(0, content.indexOf('#ff0000')).split('\n').length);
  assert.equal(violation.file, 'style.css');

  const cli = runCli(dir);
  assert.equal(cli.status, 1);
  assert.ok(`${cli.stdout}${cli.stderr}`.includes(COLOR_LITERAL_OUTSIDE_ROOT));
});

test('AT3 — currentColor fails', async (t) => {
  const { check, CURRENT_COLOR_USED } = await loadScript();
  const content = `${GOOD_CSS}\n.bad {\n  border-color: currentColor;\n}\n`;
  const dir = writeFixture(t, content);

  const report = check(dir);
  assert.equal(report.valid, false);
  assert.ok(report.violations.some((v) => v.code === CURRENT_COLOR_USED));
  assert.equal(runCli(dir).status, 1);
});

test('AT4 — a non-var(--radius) border-radius value fails', async (t) => {
  const { check, NON_TOKEN_RADIUS } = await loadScript();
  const content = `${GOOD_CSS}\n.bad {\n  border-radius: 4px;\n}\n`;
  const dir = writeFixture(t, content);

  const report = check(dir);
  assert.equal(report.valid, false);
  const violation = report.violations.find((v) => v.code === NON_TOKEN_RADIUS);
  assert.ok(violation, 'expected violation: non_token_radius');
  assert.equal(violation.target, '4px');
  assert.equal(runCli(dir).status, 1);
});

test('AT5 — any opacity declaration fails', async (t) => {
  const { check, OPACITY_DECLARED } = await loadScript();
  const content = `${GOOD_CSS}\n.bad {\n  opacity: .5;\n}\n`;
  const dir = writeFixture(t, content);

  const report = check(dir);
  assert.equal(report.valid, false);
  assert.ok(report.violations.some((v) => v.code === OPACITY_DECLARED));
  assert.equal(runCli(dir).status, 1);
});

test('AT6 — box-shadow on a selector naming none of dropdown/popover/dialog fails, and passes when it does', async (t) => {
  const { check, BOX_SHADOW_OUTSIDE_FLOATING } = await loadScript();

  const bad = `${GOOD_CSS}\n.card {\n  box-shadow: 0 1px 2px var(--line);\n}\n`;
  const badDir = writeFixture(t, bad);
  const badReport = check(badDir);
  assert.equal(badReport.valid, false);
  const violation = badReport.violations.find((v) => v.code === BOX_SHADOW_OUTSIDE_FLOATING);
  assert.ok(violation, 'expected violation: box_shadow_outside_floating');
  assert.equal(runCli(badDir).status, 1);

  const good = `${GOOD_CSS}\n.dropdown {\n  box-shadow: 0 1px 2px var(--line);\n}\n`;
  const goodDir = writeFixture(t, good);
  const goodReport = check(goodDir);
  assert.equal(
    goodReport.violations.some((v) => v.code === BOX_SHADOW_OUTSIDE_FLOATING),
    false,
    'a selector naming "dropdown" may carry a box-shadow',
  );
  assert.equal(runCli(goodDir).status, 0);
});

test('AT7 — a missing :focus-visible rule fails', async (t) => {
  const { check, FOCUS_VISIBLE_MISSING } = await loadScript();
  const content = GOOD_CSS.replace(/:focus-visible[\s\S]*$/, '');
  const dir = writeFixture(t, content);

  const report = check(dir);
  assert.equal(report.valid, false);
  assert.ok(report.violations.some((v) => v.code === FOCUS_VISIBLE_MISSING));
  assert.equal(runCli(dir).status, 1);
});

test('AT8 — the real, post-fix packages/screen/src/public/style.css passes the gate', async () => {
  assert.ok(existsSync(REAL_STYLESHEET), 'packages/screen/src/public/style.css does not exist');
  const { check } = await loadScript();

  const report = check(path.dirname(REAL_STYLESHEET));
  assert.deepEqual(report.violations, []);
  assert.equal(report.valid, true);

  const cli = runCli(path.dirname(REAL_STYLESHEET));
  assert.equal(cli.status, 0, `the CLI should have exited 0:\n${cli.stdout}${cli.stderr}`);
});
