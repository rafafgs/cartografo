/**
 * Acceptance test of the runner's local skill-draft port (t439, FR7).
 *
 * The derivation is the core's — `packages/core/src/domain/skill-draft.ts` — and
 * this is a PORT, not an import. Same reason `src/synthesizer/similarity.ts`
 * ports `domain/similarity.ts` instead of reaching across the package boundary:
 * the runner is an ordinary API client (D1/D11), and a compile-time dependency
 * on the control plane's internals is exactly the coupling
 * `test/no-privileged-access.test.ts` exists to forbid.
 *
 * A port only earns its keep if it cannot drift, so this file runs the SAME
 * fixtures as `packages/core/test/skill-draft-domain.test.ts` against the copy:
 * the same frontmatter split, the same kebab ids, the same fenced-only checks,
 * the same assembled draft, and — the part that is easiest to let rot — the same
 * two failure MESSAGES, character for character. Change the derivation on one
 * side and the other side's suite says so.
 *
 * The last test is the boundary itself: the sweep that proves the runner keeps
 * no privileged access, re-run here so a port that quietly imported the core
 * would fail in the file that introduced it, not three tickets later.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as SkillDraftModule from '../../src/dispatch/skill-draft.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MODULE_PATH = 'src/dispatch/skill-draft.ts';

let cache: typeof SkillDraftModule | null = null;

/** Loads on demand: on the initial red the failure NAMES the missing artifact. */
async function loadSkillDraft(): Promise<typeof SkillDraftModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/skill-draft.ts', import.meta.url).href
  )) as typeof SkillDraftModule;
  return cache;
}

/** The same well-formed `SKILL.md` the core's suite derives from. */
const WELL_FORMED = [
  '---',
  'name: A Skill',
  'description: does a thing',
  '---',
  '',
  'Run the suite (`npm test`) and confirm the failures.',
  '',
  '```bash',
  '# a comment is not a command',
  'npm test',
  'npm test!',
  'npm test',
  'git commit -m "none of that"',
  'pytest -q',
  '```',
  '',
  'npm run build',
  '',
].join('\n');

/** The same provenance; the port reads no clock either. */
const ORIGIN = Object.freeze({
  repo: 'https://github.com/example/skills',
  ref: 'a1b2c3d',
  importedBy: 'rafael',
  importedAt: '2026-09-07',
});

test('t439 AT6 — splitFrontmatter is the core\'s, down to the two refusal messages', async () => {
  const { splitFrontmatter } = await loadSkillDraft();

  const read = splitFrontmatter(
    '---\nname: a-skill\ndescription: "with quotes"\n\nno_colon\n: no key\n---\n\n\nThe body.\n',
  );
  assert.deepEqual(read.frontmatter, { name: 'a-skill', description: 'with quotes' });
  assert.equal(read.body, 'The body.\n');

  assert.throws(
    () => splitFrontmatter('# No frontmatter\n'),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor === Error &&
      error.message === 'the SKILL.md does not start with a --- frontmatter block',
  );
  assert.throws(
    () => splitFrontmatter('---\nname: a-skill\n'),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor === Error &&
      error.message === 'the SKILL.md frontmatter block is never closed',
  );
});

test('t439 AT6 — kebabCase and deriveChecks answer exactly what the core answers', async () => {
  const { kebabCase, deriveChecks } = await loadSkillDraft();

  // Escapes, not literals (t314): the accents are the INPUT being stripped.
  assert.equal(kebabCase('R\u00e9sum\u00e9 Review'), 'resume-review');
  assert.equal(kebabCase('  --npm run test!!  '), 'npm-run-test');
  assert.equal(kebabCase('na\u00efve-already'), 'naive-already');
  assert.equal(kebabCase('!!!'), '');

  const checks = deriveChecks(
    [
      'Run the suite (`npm test`) and confirm the failures.',
      '',
      '```bash',
      '# a comment is not a command',
      '',
      'npm test',
      'npm test!',
      'npm test',
      'git commit -m "none of that"',
      'cd /tmp',
      'pytest -q',
      '```',
      '',
      'npm run build',
    ].join('\n'),
  );
  assert.deepEqual(
    checks.map((check) => check.command),
    ['npm test', 'npm test!', 'pytest -q'],
  );
  assert.deepEqual(
    checks.map((check) => check.id),
    ['npm-test', 'npm-test-2', 'pytest-q'],
  );
  assert.deepEqual(
    [...new Set(checks.map((check) => check.type))],
    ['deterministic'],
  );
  assert.deepEqual(deriveChecks('no fence at all\n'), []);
});

test('t439 AT6 — deriveSkillDraft assembles the same draft, hash empty and origin verbatim', async () => {
  const {
    deriveSkillDraft,
    deriveChecks,
    splitFrontmatter,
    SAFE_PERMISSIONS,
    SCHEMA_PLACEHOLDER,
    IMPORT_VERSION,
  } = await loadSkillDraft();

  const result = deriveSkillDraft(WELL_FORMED, { role: 'gate', origin: { ...ORIGIN } });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const draft = result.draft;

  assert.equal(draft.id, 'a-skill');
  assert.equal(draft.version, IMPORT_VERSION);
  assert.equal(draft.hash, '', 'the runner never hashes: manifestHash is not ported (FR6)');
  assert.equal(draft.role, 'gate');
  assert.equal(draft.description, 'does a thing');
  assert.deepEqual(draft.input, SCHEMA_PLACEHOLDER);
  assert.deepEqual(draft.output, SCHEMA_PLACEHOLDER);
  assert.deepEqual(draft.preconditions, []);
  assert.deepEqual(draft.permissions, SAFE_PERMISSIONS);

  const { body } = splitFrontmatter(WELL_FORMED);
  assert.equal(draft.instructions, body);
  assert.deepEqual(draft.checks, deriveChecks(body));

  assert.deepEqual(draft.origin, {
    type: 'imported',
    repo: ORIGIN.repo,
    ref: ORIGIN.ref,
    imported_by: ORIGIN.importedBy,
    imported_at: ORIGIN.importedAt,
  });
  assert.equal(Object.hasOwn(draft, 'reviewed_by'), false);
});

test('t439 AT6 — with no role the port leaves the same placeholder, and reports the same failures', async () => {
  const { deriveSkillDraft, ROLE_PLACEHOLDER } = await loadSkillDraft();

  const bare = deriveSkillDraft(WELL_FORMED);
  assert.equal(bare.ok, true);
  if (!bare.ok) return;
  assert.equal(bare.draft.role, ROLE_PLACEHOLDER, 'D4: a role is never inferred, here either');
  assert.deepEqual(bare.draft.origin, {
    type: 'imported',
    repo: '',
    ref: '',
    imported_by: '',
    imported_at: '',
  });
  assert.deepEqual(deriveSkillDraft(WELL_FORMED), bare, 'pure: same input, same answer');

  const noName = deriveSkillDraft('---\ndescription: no name\n---\n\nThe body.\n');
  assert.equal(noName.ok, false);
  assert.match(noName.ok ? '' : noName.error, /has no "name"/);

  const unusableName = deriveSkillDraft('---\nname: "!!!"\n---\n\nThe body.\n');
  assert.equal(unusableName.ok, false);
  assert.match(unusableName.ok ? '' : unusableName.error, /does not yield a kebab-case id/);

  const noFrontmatter = deriveSkillDraft('# No frontmatter\n');
  assert.equal(noFrontmatter.ok, false);
  assert.equal(
    noFrontmatter.ok ? '' : noFrontmatter.error,
    'the SKILL.md does not start with a --- frontmatter block',
  );

  const neverClosed = deriveSkillDraft('---\nname: a-skill\n');
  assert.equal(neverClosed.ok, false);
  assert.equal(
    neverClosed.ok ? '' : neverClosed.error,
    'the SKILL.md frontmatter block is never closed',
  );
});

test('t439 AT6 — the port is a port: no reach into packages/core, and the boundary sweep still flags nothing', () => {
  const source = readFileSync(path.join(PACKAGE_ROOT, MODULE_PATH), 'utf8');
  assert.equal(
    /from\s+['"][^'"]*packages\/core/.test(source) || /@cartografo\/core/.test(source),
    false,
    'a copy that imports the original is not a port — it is the coupling D1/D11 forbids',
  );

  const gate = path.join(REPO_ROOT, 'scripts', 'check-single-writer.mjs');
  assert.ok(existsSync(gate), 'artifact does not exist yet: scripts/check-single-writer.mjs');
  const result = spawnSync(process.execPath, [gate, PACKAGE_ROOT], { encoding: 'utf8' });
  assert.equal(
    result.status,
    0,
    `the gate rejected the runner:\n${result.stdout ?? ''}${result.stderr ?? ''}`,
  );
});
