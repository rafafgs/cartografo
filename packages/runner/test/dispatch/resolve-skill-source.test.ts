/**
 * Acceptance tests for the skill source a person points the interview at (t440).
 *
 * Most people already have prompts or skills for the kind of work they are
 * describing. RF-14's extension is that the interview may point at what they
 * already have — a folder, or a git repository of `SKILL.md` files — and adapt
 * drafts derived from it instead of starting from nothing. This module is the
 * half that touches the machine: it reads (or clones, read-only) the source and
 * derives one draft manifest per file through the ported `deriveSkillDraft`
 * (t439).
 *
 * Three rules the cases below exist to pin, and each one is a decision:
 *
 * - **Nothing from the source is ever executed.** A clone is `git clone
 *   --depth 1` and a read is `readFile`; the drafts it produces are proposals a
 *   session adapts, and D4's human gate stays the only door into the registry.
 * - **It never throws.** Every filesystem or git failure resolves as
 *   `{drafts: [], error}` — this is context for an interview, and an interview
 *   that could not open because a folder was misspelled would have broken the
 *   thing the folder was meant to help with. Same posture
 *   `createClassPrecedentsResolver` already has for a `GET /v1/classes` that
 *   refuses.
 * - **One bad file does not sink the others.** A `SKILL.md` with no `name` in
 *   its frontmatter has no id to derive (`skill-draft.ts`), so it is skipped in
 *   silence while its siblings still produce drafts.
 *
 * Against a REAL filesystem and a REAL `git`, in the spirit of
 * `resolve-executor-environment.test.ts`: what is under test is what the clone
 * and the walk actually do, and a faked `git` would only prove this module's
 * opinion of git.
 *
 * English per D24.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as SkillSourceModule from '../../src/dispatch/resolve-skill-source.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/resolve-skill-source.ts';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom this directory already uses: in the red phase the failure has to
 * read as "the implementation is missing", never as a module resolution stack
 * trace.
 */
async function loadModule(): Promise<typeof SkillSourceModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL(`../../${MODULE_PATH}`, import.meta.url).href
  )) as typeof SkillSourceModule;
}

/** A disposable directory that does not outlive the test that asked for it. */
function scratch(t: TestHook, label: string): string {
  const base = mkdtempSync(path.join(tmpdir(), `cartografo-t440-${label}-`));
  t.after(() => {
    try {
      execFileSync('rm', ['-rf', base], { stdio: 'ignore' });
    } catch {
      /* the temp directory outlives the process; nothing here depends on it */
    }
  });
  return base;
}

/** One `SKILL.md`, in the shape a public skill really has: flat frontmatter. */
function writeSkill(
  directory: string,
  name: string | null,
  description = 'What this skill does, in one line.',
): void {
  mkdirSync(directory, { recursive: true });
  const frontmatter =
    name === null ? `description: ${description}` : `name: ${name}\ndescription: ${description}`;
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\n${frontmatter}\n---\n\n# ${name ?? 'unnamed'}\n\nRun the suite:\n\n\`\`\`\nnpm test\n\`\`\`\n`,
  );
}

/** Runs git in a directory and gives back its stdout, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/**
 * A bare repository with one commit carrying one `SKILL.md`.
 *
 * Bare, and local, on purpose: the clone under test has to talk to something
 * that behaves like a remote, and a bare repository on the same disk is the
 * only remote a test suite may depend on.
 *
 * @param base Directory both the bare repository and its seed live under.
 * @returns Path of the bare repository — the `location` of a `git` source.
 */
function bareRepository(base: string): string {
  const bare = path.join(base, 'origin.git');
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '--quiet', '--initial-branch', 'main');

  const seed = path.join(base, 'seed');
  mkdirSync(seed, { recursive: true });
  git(seed, 'init', '--quiet', '--initial-branch', 'main');
  git(seed, 'config', 'user.email', 'fixture@cartografo.local');
  git(seed, 'config', 'user.name', 'Fixture t440');
  writeSkill(path.join(seed, 'review'), 'code review');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'the skill somebody already had');
  git(seed, 'push', '--quiet', bare, 'main');

  return bare;
}

/**
 * Puts a recording `git` in front of the real one, for the length of one test.
 *
 * The only way to assert `--depth 1` from the outside: the clone is REMOVED as
 * soon as the drafts are derived (FR4), so there is no `.git/shallow` left to
 * read afterwards. Node's `execFile('git', …)` resolves the name through the
 * process environment, so a shim first on `PATH` sees the command as it was
 * issued, logs it, and hands it to the real binary unchanged.
 *
 * @param t The running test, for the restore.
 * @param base Directory the shim and its log live in.
 * @returns A reader of every git command line issued while the shim is in front.
 */
function recordingGit(t: TestHook, base: string): () => string[] {
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shimDir = path.join(base, 'shim');
  const log = path.join(base, 'git-commands.log');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    path.join(shimDir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );

  const original = process.env.PATH ?? '';
  process.env.PATH = `${shimDir}${path.delimiter}${original}`;
  t.after(() => {
    process.env.PATH = original;
  });

  return () =>
    existsSync(log)
      ? execFileSync('cat', [log], { encoding: 'utf8' }).split('\n').filter((line) => line !== '')
      : [];
}

test('t440 AT — a local path with two SKILL.md files derives two drafts', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'path');
  const source = path.join(base, 'skills');
  writeSkill(path.join(source, 'alpha'), 'alpha review');
  writeSkill(path.join(source, 'beta'), 'beta triage');

  const resolveSkillSource = createSkillSourceResolver({
    allowGitClone: false,
    scratchRoot: path.join(base, 'scratch'),
  });

  const answered = await resolveSkillSource({ kind: 'path', location: source });

  assert.equal(answered.error, null, `a readable folder is not an error: ${String(answered.error)}`);
  assert.deepEqual(
    answered.drafts.map((draft) => draft.id),
    ['alpha-review', 'beta-triage'],
    'one draft per SKILL.md found, with the id derived from the frontmatter name',
  );
  for (const draft of answered.drafts) {
    const origin = draft.origin as Record<string, unknown>;
    assert.equal(origin.repo, source, 'the origin names the source the person gave');
    assert.equal(origin.ref, 'local', 'a folder has no revision: `local` is what it is');
    assert.equal(origin.type, 'imported', 'nothing derived from a SKILL.md is native');
    assert.match(
      String(origin.imported_at),
      /^\d{4}-\d{2}-\d{2}T/,
      'the import instant is the caller`s to supply, and this caller supplies it',
    );
    assert.deepEqual(
      draft.permissions,
      { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
      'a draft is born with the format`s safe default and nothing wider (D4)',
    );
  }
});

test('t440 AT — a path that does not exist is an error naming it, never a throw', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'missing');
  const missing = path.join(base, 'there-is-no-such-folder');

  const resolveSkillSource = createSkillSourceResolver({
    allowGitClone: true,
    scratchRoot: path.join(base, 'scratch'),
  });

  const answered = await resolveSkillSource({ kind: 'path', location: missing });

  assert.deepEqual(answered.drafts, [], 'a source that could not be read derives nothing');
  assert.ok(
    answered.error !== null && answered.error.includes(missing),
    `the error names the path, so the person can fix their own answer: ${String(answered.error)}`,
  );

  // ...and a path that exists but is a FILE is the same refusal: the interview
  // asked for a folder or a URL, and a file is neither.
  const file = path.join(base, 'SKILL.md');
  writeFileSync(file, '---\nname: lonely\n---\n\nbody\n');
  const onAFile = await resolveSkillSource({ kind: 'path', location: file });
  assert.deepEqual(onAFile.drafts, []);
  assert.ok(onAFile.error !== null && onAFile.error.includes(file));
});

test('t440 AT — a git source with cloning switched off refuses, and writes nothing', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'no-clone');
  const scratchRoot = path.join(base, 'scratch');

  const resolveSkillSource = createSkillSourceResolver({ allowGitClone: false, scratchRoot });

  const answered = await resolveSkillSource({
    kind: 'git',
    location: 'https://github.com/org/skills',
  });

  assert.deepEqual(answered.drafts, []);
  assert.ok(
    answered.error !== null && answered.error.includes('allow_git_clone'),
    `the refusal names the setting that would allow it: ${String(answered.error)}`,
  );
  assert.equal(
    existsSync(scratchRoot),
    false,
    'a refused clone leaves nothing on disk at all — not even the directory it would have used',
  );
});

test('t440 AT — a git source is cloned shallow, read, and thrown away', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'clone');
  const source = bareRepository(base);
  const scratchRoot = path.join(base, 'scratch');
  const commands = recordingGit(t, base);

  const resolveSkillSource = createSkillSourceResolver({ allowGitClone: true, scratchRoot });

  const answered = await resolveSkillSource({ kind: 'git', location: source });

  assert.equal(answered.error, null, `the clone failed: ${String(answered.error)}`);
  assert.deepEqual(
    answered.drafts.map((draft) => draft.id),
    ['code-review'],
    'the one SKILL.md in the repository is the one draft that comes back',
  );
  assert.equal(
    (answered.drafts[0].origin as Record<string, unknown>).ref,
    'HEAD',
    'a clone has a revision, and `HEAD` is the one --depth 1 brought',
  );

  assert.ok(
    commands().some((line) => line.startsWith(`clone --depth 1 ${source} `)),
    `the clone is shallow and read-only: ${JSON.stringify(commands())}`,
  );

  // Thrown away: the drafts are derived and the clone has no further use, so
  // nothing of the source survives the call that read it.
  assert.deepEqual(
    existsSync(scratchRoot) ? readdirSync(scratchRoot) : [],
    [],
    'the clone subdirectory is removed once the drafts are derived',
  );
});

test('t440 AT — a SKILL.md with no name is skipped, and its siblings still derive', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'skipped');
  const source = path.join(base, 'skills');
  writeSkill(path.join(source, 'anonymous'), null);
  writeSkill(path.join(source, 'named'), 'named skill');

  const resolveSkillSource = createSkillSourceResolver({
    allowGitClone: false,
    scratchRoot: path.join(base, 'scratch'),
  });

  const answered = await resolveSkillSource({ kind: 'path', location: source });

  assert.equal(answered.error, null, 'one unusable file is not a failure of the source');
  assert.deepEqual(
    answered.drafts.map((draft) => draft.id),
    ['named-skill'],
    'a file with no id to derive is skipped in silence; the rest of the folder still counts',
  );
});

test('t440 AT — more sources than the ceiling yields the ceiling, in the order found', async (t) => {
  const { createSkillSourceResolver } = await loadModule();
  const base = scratch(t, 'ceiling');
  const source = path.join(base, 'skills');
  for (const name of ['a', 'b', 'c', 'd']) writeSkill(path.join(source, name), `${name} skill`);

  const resolveSkillSource = createSkillSourceResolver({
    allowGitClone: false,
    scratchRoot: path.join(base, 'scratch'),
    maxDrafts: 3,
  });

  const answered = await resolveSkillSource({ kind: 'path', location: source });

  assert.equal(answered.error, null, 'a folder with more skills than the ceiling is not an error');
  assert.deepEqual(
    answered.drafts.map((draft) => draft.id),
    ['a-skill', 'b-skill', 'c-skill'],
    'this is a suggestion and not an index: the first `maxDrafts` found, in that order',
  );
});
