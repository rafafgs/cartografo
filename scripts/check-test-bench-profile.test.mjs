/**
 * Acceptance tests for the test-bench-profile gate (t472, FR1-FR5).
 *
 * Gate 3 (FlowPilot's test stage) validates a ticket's acceptance criteria
 * against a *running application*, and it can only do that if the Profile's
 * `commands.run` and top-level `app_url` are both present and agree on a
 * port. This gate pins that structurally so the config can never regress to
 * `run: null` (`stage_runs` #2124) without `npm run lint` catching it.
 *
 * Fixtures are strings, not files copied from the repo: each one differs from
 * the valid fixture by exactly the thing its test names, same pattern as
 * `check-readme-disclosure.test.mjs`.
 *
 * Run with: `npm test` at the root, or `node --test scripts/`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  APP_URL_MISSING,
  PORT_MISMATCH,
  RUN_MISSING,
  check,
} from './check-test-bench-profile.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'check-test-bench-profile.mjs');

const PROFILE_NO_RUN_NO_APP_URL = [
  'commands:',
  '  build: npm run build',
  '  lint: npm run lint',
  '  migration_heads: null',
  '  run: null',
  '  setup: npm install --no-audit --no-fund',
  '  test: npm test',
  '  typecheck: npm run typecheck',
].join('\n');

const PROFILE_RUN_SET_NO_APP_URL = [
  'commands:',
  '  build: npm run build',
  '  lint: npm run lint',
  '  migration_heads: null',
  '  run: CARTOGRAFO_PORT=4517 CARTOGRAFO_SCREEN_PORT=4518 node ./node_modules/.bin/cartografo up --no-browser --no-runner',
  '  setup: npm install --no-audit --no-fund',
  '  test: npm test',
  '  typecheck: npm run typecheck',
].join('\n');

const PROFILE_PORT_MISMATCH = [
  'commands:',
  '  build: npm run build',
  '  lint: npm run lint',
  '  migration_heads: null',
  '  run: CARTOGRAFO_PORT=4517 CARTOGRAFO_SCREEN_PORT=4518 node ./node_modules/.bin/cartografo up --no-browser --no-runner',
  '  setup: npm install --no-audit --no-fund',
  '  test: npm test',
  '  typecheck: npm run typecheck',
  'app_url: http://127.0.0.1:4519/',
].join('\n');

const PROFILE_VALID = [
  'commands:',
  '  build: npm run build',
  '  lint: npm run lint',
  '  migration_heads: null',
  '  run: CARTOGRAFO_PORT=4517 CARTOGRAFO_SCREEN_PORT=4518 node ./node_modules/.bin/cartografo up --no-browser --no-runner',
  '  setup: npm install --no-audit --no-fund',
  '  test: npm test',
  '  typecheck: npm run typecheck',
  'app_url: http://127.0.0.1:4518/',
].join('\n');

const codesOf = (report) => report.violations.map((violation) => violation.code);

function temporaryArea(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t472-bench-profile-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function writeProfile(root, content) {
  const destination = path.join(root, '.flowpilot', 'profile.yml');
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content, 'utf8');
  return root;
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('run: null and no app_url reports both violations', (t) => {
  const root = writeProfile(temporaryArea(t), PROFILE_NO_RUN_NO_APP_URL);

  const report = check(root);
  assert.equal(report.valid, false);
  assert.deepEqual(codesOf(report).sort(), [APP_URL_MISSING, RUN_MISSING].sort());
});

test('run set but app_url absent reports only the app_url violation', (t) => {
  const root = writeProfile(temporaryArea(t), PROFILE_RUN_SET_NO_APP_URL);

  const report = check(root);
  assert.equal(report.valid, false);
  assert.deepEqual(codesOf(report), [APP_URL_MISSING]);
});

test('run and app_url disagreeing on port reports a port-mismatch violation', (t) => {
  const root = writeProfile(temporaryArea(t), PROFILE_PORT_MISMATCH);

  const report = check(root);
  assert.equal(report.valid, false);
  assert.deepEqual(codesOf(report), [PORT_MISMATCH]);
});

test('matching, present run and app_url pass with no violations', (t) => {
  const root = writeProfile(temporaryArea(t), PROFILE_VALID);

  const report = check(root);
  assert.deepEqual(report, { valid: true, violations: [] });
});

test('the real repository profile passes its own gate (regression pin for FR1-FR3)', () => {
  const report = check(ROOT);
  assert.deepEqual(report, { valid: true, violations: [] });
});

test('CLI exits 0 against the repo root, exits 1 against a temp dir with run: null', (t) => {
  assert.equal(runCli(ROOT).status, 0);

  const root = writeProfile(temporaryArea(t), PROFILE_NO_RUN_NO_APP_URL);
  const cli = runCli(root);
  assert.equal(cli.status, 1);
  const output = `${cli.stdout}${cli.stderr}`;
  assert.ok(output.includes(RUN_MISSING), 'the CLI has to print the violation code');
});
