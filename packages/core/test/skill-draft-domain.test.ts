/**
 * Acceptance tests of the pure skill-draft derivation (t439, FR1–FR4/FR6).
 *
 * The derivation used to live inline inside `cli/skill-import.ts`, tangled with
 * a `--role` flag somebody has to type, an HTTP call to the registry and a file
 * write. None of that is reachable from a runner session, which has no terminal
 * and — by D1/D11 — no access to core's modules at all. So the part a machine
 * can do with no judgement moves down into `domain/`, where it is pure: no CLI,
 * no network, no filesystem, no clock.
 *
 * What this file pins is exactly that purity, and the refusals that come with
 * it. `deriveSkillDraft` never throws — it answers with a result, the same
 * convention `domain/graph.ts` and `domain/manifest.ts` already follow — and it
 * never guesses: no role becomes {@link SkillDraftModule.ROLE_PLACEHOLDER}, not
 * `work`; `hash` stays empty, because hashing is the caller's job (FR6); and
 * `imported_at` is whatever the caller passed, because a domain function that
 * reads the wall clock is a function whose output nobody can reproduce.
 *
 * The module is loaded on demand, behind an `existsSync`, like
 * `test/settings.test.ts`: on the initial red the failure NAMES the missing
 * artifact instead of blowing up with a module resolution error.
 *
 * `packages/runner/test/dispatch/skill-draft.test.ts` runs these same fixtures
 * against the runner's port. A copy that can drift is worse than no copy, so
 * the parity is a test rather than a promise.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as SkillDraftModule from '../src/domain/skill-draft.ts';
import { requireArtifacts } from './support.ts';

/** The artifact this suite exercises. */
const MODULE_PATH = 'src/domain/skill-draft.ts';

let cache: typeof SkillDraftModule | null = null;

/** Loads on demand: on the initial red the failure NAMES the missing artifact. */
async function loadSkillDraft(): Promise<typeof SkillDraftModule> {
  requireArtifacts(MODULE_PATH);
  cache ??= (await import(
    new URL('../src/domain/skill-draft.ts', import.meta.url).href
  )) as typeof SkillDraftModule;
  return cache;
}

/**
 * A well-formed `SKILL.md`, shared with the runner's parity test verbatim.
 *
 * Two commands in a fence, one named in prose, one repeat and one `git commit`
 * that is not a check — the same shape `cli-skill-import-unit.test.ts` already
 * pins, so the two files cannot disagree about what a fence means.
 */
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

/** The provenance a caller supplies; the function reads no clock of its own. */
const ORIGIN = Object.freeze({
  repo: 'https://github.com/example/skills',
  ref: 'a1b2c3d',
  importedBy: 'rafael',
  importedAt: '2026-09-07',
});

test('t439 AT1 — splitFrontmatter reads a flat frontmatter and refuses a malformed one with a plain Error', async () => {
  const { splitFrontmatter } = await loadSkillDraft();

  const read = splitFrontmatter(
    '---\nname: a-skill\ndescription: "with quotes"\n\nno_colon\n: no key\n---\n\n\nThe body.\n',
  );
  assert.deepEqual(read.frontmatter, { name: 'a-skill', description: 'with quotes' });
  assert.equal(read.body, 'The body.\n', 'the blank lines after the block belong to the block');

  assert.throws(
    () => splitFrontmatter('# No frontmatter\n'),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor === Error &&
      error.message === 'the SKILL.md does not start with a --- frontmatter block',
    'a plain Error: the domain layer does not know what a UsageError is',
  );
  assert.throws(
    () => splitFrontmatter('---\nname: a-skill\n'),
    (error: unknown) =>
      error instanceof Error &&
      error.constructor === Error &&
      error.message === 'the SKILL.md frontmatter block is never closed',
  );
});

test('t439 AT2 — kebabCase behaves exactly as the CLI already pins it', async () => {
  const { kebabCase } = await loadSkillDraft();

  // Written as escapes, not as literals (t314): the accented characters are the
  // INPUT this function strips, and a repo-wide diacritic sweep cannot tell that
  // from a paragraph nobody translated.
  assert.equal(kebabCase('R\u00e9sum\u00e9 Review'), 'resume-review');
  assert.equal(kebabCase('  --npm run test!!  '), 'npm-run-test');
  assert.equal(kebabCase('na\u00efve-already'), 'naive-already');
  assert.equal(kebabCase('!!!'), '', 'a name that yields nothing yields nothing, not a guess');
});

test('t439 AT2 — deriveChecks recognizes only fenced commands, and dedups with numeric suffixes', async () => {
  const { deriveChecks } = await loadSkillDraft();

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
    'prose names a command, a fence prescribes one — and a repeat is not a second check',
  );
  assert.deepEqual(
    checks.map((check) => check.id),
    ['npm-test', 'npm-test-2', 'pytest-q'],
    'two commands with the same kebab id do not become one check',
  );
  assert.deepEqual(
    [...new Set(checks.map((check) => check.type))],
    ['deterministic'],
    'a derived check is always the deterministic kind',
  );
  assert.deepEqual(deriveChecks('no fence at all\n'), []);
});

test('t439 AT3 — deriveSkillDraft assembles the draft, with hash empty and origin verbatim', async () => {
  const { deriveSkillDraft, deriveChecks, splitFrontmatter, SAFE_PERMISSIONS, SCHEMA_PLACEHOLDER, IMPORT_VERSION } =
    await loadSkillDraft();

  const result = deriveSkillDraft(WELL_FORMED, { role: 'gate', origin: { ...ORIGIN } });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const draft = result.draft;

  assert.equal(draft.id, 'a-skill');
  assert.equal(draft.version, IMPORT_VERSION);
  assert.equal(draft.hash, '', 'FR6: filling the hash is the caller\'s job, on both ports');
  assert.equal(draft.role, 'gate', 'the role is what the caller supplied, verbatim');
  assert.equal(draft.description, 'does a thing');
  assert.deepEqual(draft.input, SCHEMA_PLACEHOLDER);
  assert.deepEqual(draft.output, SCHEMA_PLACEHOLDER);
  assert.deepEqual(draft.preconditions, []);
  assert.deepEqual(draft.permissions, SAFE_PERMISSIONS);

  const { body } = splitFrontmatter(WELL_FORMED);
  assert.equal(draft.instructions, body, 'the body is the instructions, untouched');
  assert.deepEqual(draft.checks, deriveChecks(body), 'the checks are deriveChecks of the body');

  assert.deepEqual(draft.origin, {
    type: 'imported',
    repo: ORIGIN.repo,
    ref: ORIGIN.ref,
    imported_by: ORIGIN.importedBy,
    imported_at: ORIGIN.importedAt,
  });
  assert.equal(
    Object.hasOwn(draft, 'reviewed_by'),
    false,
    'a draft nobody reviewed may not claim a reviewer',
  );
});

test('t439 AT4 — with no role and no origin nothing is guessed: the placeholder stands and the clock is never read', async () => {
  const { deriveSkillDraft, ROLE_PLACEHOLDER } = await loadSkillDraft();

  const result = deriveSkillDraft(WELL_FORMED);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.draft.role, ROLE_PLACEHOLDER, 'D4: a role is never inferred');
  assert.notEqual(ROLE_PLACEHOLDER, 'work');
  assert.notEqual(ROLE_PLACEHOLDER, 'gate');
  assert.deepEqual(result.draft.origin, {
    type: 'imported',
    repo: '',
    ref: '',
    imported_by: '',
    imported_at: '',
  }, 'no caller-supplied date means no date — the function takes no wall-clock reading');

  // Pure: the same input answers the same thing, whenever it is called.
  assert.deepEqual(deriveSkillDraft(WELL_FORMED), result);
});

test('t439 AT5 — deriveSkillDraft reports a failure instead of throwing it', async () => {
  const { deriveSkillDraft } = await loadSkillDraft();

  const noName = deriveSkillDraft('---\ndescription: no name\n---\n\nThe body.\n');
  assert.equal(noName.ok, false);
  assert.match(noName.ok ? '' : noName.error, /has no "name"/);

  const emptyName = deriveSkillDraft('---\nname: ""\n---\n\nThe body.\n');
  assert.equal(emptyName.ok, false);
  assert.match(emptyName.ok ? '' : emptyName.error, /has no "name"/);

  const unusableName = deriveSkillDraft('---\nname: "!!!"\n---\n\nThe body.\n');
  assert.equal(unusableName.ok, false);
  assert.match(unusableName.ok ? '' : unusableName.error, /does not yield a kebab-case id/);

  const noFrontmatter = deriveSkillDraft('# No frontmatter\n');
  assert.equal(noFrontmatter.ok, false);
  assert.equal(
    noFrontmatter.ok ? '' : noFrontmatter.error,
    'the SKILL.md does not start with a --- frontmatter block',
    'a thrown Error becomes the reported error, message intact',
  );

  const neverClosed = deriveSkillDraft('---\nname: a-skill\n');
  assert.equal(neverClosed.ok, false);
  assert.equal(
    neverClosed.ok ? '' : neverClosed.error,
    'the SKILL.md frontmatter block is never closed',
  );
});
