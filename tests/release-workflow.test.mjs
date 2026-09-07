/**
 * Acceptance tests of t251 — the release job (D23 4/4).
 *
 * t216 (D23) split into four children; this is the last one, still under
 * t216's founder gate: publishing to npm is Rafael's own act, never the
 * plantão's. What this file pins down is that the workflow can only ever
 * publish for real on a tag push, never on a manual trigger, and that it
 * never runs before the same four gates CI runs.
 *
 * Everything here is a deterministic content check over the checked-in text —
 * none of it executes the workflow. See the ticket's TDD Exceptions for what
 * is deliberately left to a real GitHub Actions run and to the first real
 * release.
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'release.yml');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const PACKAGE_JSON_PATH = path.join(ROOT, 'packages', 'core', 'package.json');
const README_PATH = path.join(ROOT, 'README.md');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

test('release.yml triggers on v* tags and on workflow_dispatch', () => {
  assert.match(workflow, /push:\s*[\s\S]*?tags:\s*[\s\S]*?-\s*['"]v\*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
});

test('release.yml declares id-token: write', () => {
  assert.match(workflow, /id-token:\s*write/);
});

test('release.yml runs the same gates CI runs, before any publish step', () => {
  const lint = workflow.indexOf('npm run lint');
  const typecheck = workflow.indexOf('npm run typecheck');
  const suite = workflow.indexOf('npm test');
  const publish = workflow.indexOf('npm publish');

  for (const [label, index] of [
    ['npm run lint', lint],
    ['npm run typecheck', typecheck],
    ['npm test', suite],
  ]) {
    assert.notEqual(index, -1, `"${label}" is missing from release.yml`);
    assert.ok(publish !== -1, 'no "npm publish" step found at all');
    assert.ok(index < publish, `"${label}" (at ${index}) must run before "npm publish" (at ${publish})`);
  }
});

test("release.yml packs the same way t248's own test does", () => {
  assert.ok(
    workflow.includes('npm pack --workspace cartografo --pack-destination'),
    'release.yml must reuse the exact pack invocation packages/core/test/pack-install.e2e.test.ts proved bundles all six commands',
  );
});

test("release.yml's manual trigger is always a dry run", () => {
  assert.ok(workflow.includes('--dry-run'), 'no "--dry-run" found in release.yml');

  const stepBoundaries = [...workflow.matchAll(/^\s*-\s*(?:name|run):/gm)].map((m) => m.index ?? -1);

  const dispatchStepStart = (() => {
    const marker = "if: github.event_name == 'workflow_dispatch'";
    const markerIndex = workflow.indexOf(marker);
    assert.notEqual(markerIndex, -1, 'no step conditioned on workflow_dispatch found');
    // The step this condition belongs to starts at the nearest preceding
    // `- name:`/`- run:` boundary.
    const starts = stepBoundaries.filter((index) => index !== -1 && index <= markerIndex);
    return starts[starts.length - 1] ?? markerIndex;
  })();

  const nextBoundary = stepBoundaries.find((index) => index > dispatchStepStart) ?? workflow.length;
  const block = workflow.slice(dispatchStepStart, nextBoundary);

  assert.ok(
    block.includes('--dry-run'),
    'the workflow_dispatch-conditioned step does not contain "--dry-run"',
  );
});

test('release.yml\'s tag publish uses provenance and reads the package version', () => {
  assert.ok(workflow.includes('--provenance'), 'no "--provenance" found in release.yml');
  assert.ok(
    workflow.includes('packages/core/package.json'),
    'release.yml must read packages/core/package.json to compare against the tag',
  );
});

test('release.yml authenticates from the NPM_TOKEN secret, never a literal token', () => {
  assert.ok(workflow.includes('secrets.NPM_TOKEN'), 'no "secrets.NPM_TOKEN" found in release.yml');
  assert.doesNotMatch(workflow, /npm_[A-Za-z0-9]{30,}/, 'a real-looking npm token is pasted into release.yml');
});

test('CHANGELOG.md exists in Keep a Changelog shape', () => {
  const changelog = readFileSync(CHANGELOG_PATH, 'utf8');
  assert.ok(changelog.includes('# Changelog'), 'CHANGELOG.md is missing its "# Changelog" heading');
  assert.ok(changelog.includes('Keep a Changelog'), 'CHANGELOG.md does not name the Keep a Changelog format');
  assert.ok(changelog.includes('## [Unreleased]'), 'CHANGELOG.md is missing an "## [Unreleased]" section');
});

test('packages/core/package.json carries release metadata and an unchanged version', () => {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  assert.equal(manifest.repository?.url, 'git+https://github.com/rafafgs/cartografo.git');
  assert.equal(manifest.repository?.directory, 'packages/core');
  assert.equal(manifest.homepage, 'https://github.com/rafafgs/cartografo#readme');
  assert.equal(manifest.bugs?.url, 'https://github.com/rafafgs/cartografo/issues');
  assert.equal(manifest.version, '0.1.0');
});

test('README.md documents releasing and links the changelog', () => {
  const readme = readFileSync(README_PATH, 'utf8');
  assert.ok(readme.includes('## Releasing'), 'README.md is missing a "## Releasing" heading');
  assert.match(readme, /\]\(CHANGELOG\.md\)/, 'README.md has no markdown link targeting CHANGELOG.md');
});
