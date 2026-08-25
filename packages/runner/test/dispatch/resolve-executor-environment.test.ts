/**
 * Acceptance tests for the executor environment the runner alone knows (t270).
 *
 * Two of the four values `software-development` asks for are facts about
 * the MACHINE running the session and not about the graph: the path of the test
 * bench (`banco_de_testes.caminho`) and the commit the verification is made
 * against (`referencia.commit`). Neither can live in the control plane's
 * database — a filesystem path and a live `HEAD` are not versioned graph data
 * (D1) — and until this ticket neither had any source at all, so `testar` and
 * `implantar` failed closed on `UnresolvedPlaceholderError`. The t109 game run
 * worked around it by stuffing all four into the graph's static `project`, and
 * wrote down that this was a stopgap.
 *
 * Against a REAL git repository, on purpose and in the spirit of
 * `session-worktree.test.ts`: what is under test is what `git rev-parse`
 * answers as the repository moves under it, and a fake `git` would only prove
 * this module's opinion of git.
 *
 * The whole subject is the difference between the two modes, which the
 * `implantar-release` manifest itself already spells out:
 *
 * - `instalacao_em_uso` is a statement about THIS PROCESS — "the commit the
 *   running installation was started from" — so it is read once and memoized.
 *   Re-reading it later would assert something about a process that no longer
 *   exists.
 * - `ponta_do_principal` is a statement about the REPOSITORY, and the tip of the
 *   main line advances with every integration. So it is read live, every call.
 *
 * English per D18; the keys it produces are the manifest format's, which is why
 * they are Portuguese.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ExecutorEnvironmentModule from '../../src/dispatch/resolve-executor-environment.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/resolve-executor-environment.ts';

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
async function loadModule(): Promise<typeof ExecutorEnvironmentModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  return (await import(
    new URL(`../../${MODULE_PATH}`, import.meta.url).href
  )) as typeof ExecutorEnvironmentModule;
}

/** Runs git in a directory and gives back its stdout, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A disposable repository on `main`, with one commit in it. */
function fixture(t: TestHook, label: string): string {
  const base = mkdtempSync(path.join(tmpdir(), `cartografo-t270-${label}-`));
  t.after(() => {
    // Best effort: what matters to the suite is that nothing survives the run.
    try {
      execFileSync('rm', ['-rf', base], { stdio: 'ignore' });
    } catch {
      /* the temp directory outlives the process; nothing here depends on it */
    }
  });

  const repoRoot = path.join(base, 'bench');
  mkdirSync(repoRoot);
  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t270');
  commit(repoRoot, 'initial');
  return repoRoot;
}

/** Adds one commit to the repository and answers its sha. */
function commit(repoRoot: string, message: string): string {
  writeFileSync(path.join(repoRoot, 'README.md'), `# ${message}\n`);
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', message);
  return git(repoRoot, 'rev-parse', 'HEAD');
}

/** The job and the node, in the slice this module reads: neither. */
const JOB = Object.freeze({ id: 270, title: 'atravessar o bundle de software', current_node_id: 'testar', blocked: false, execution_id: null });
const RESOLVED = Object.freeze({ node: { id: 'testar' }, edges: [] });

/** Calls the built function with the two arguments the dispatch would hand it. */
async function resolve(
  readEnvironment: (job: never, node: never) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return await readEnvironment(JOB as never, RESOLVED as never);
}

test('t270 AT — instalacao_em_uso reads the commit once and never again', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'em-uso');

  const started = git(repoRoot, 'rev-parse', 'HEAD');
  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'instalacao_em_uso',
  });

  const first = await resolve(readEnvironment);
  assert.deepEqual(
    (first.banco_de_testes as Record<string, unknown>).caminho,
    repoRoot,
    'the bench path is configuration, handed over as it was given',
  );
  const reference = first.referencia as Record<string, unknown>;
  assert.equal(reference.commit, started);
  assert.equal(reference.modo, 'instalacao_em_uso');
  assert.equal(typeof reference.lido_em, 'string', 'when it was read is part of the answer');

  // The repository moves under it, which is exactly the situation the
  // mode exists for: an installation started from `started` is still running
  // that code, whatever the tip does afterwards.
  const moved = commit(repoRoot, 'second delivery');
  assert.notEqual(moved, started, 'the fixture has to actually move for this to prove anything');

  const second = await resolve(readEnvironment);
  assert.equal(
    (second.referencia as Record<string, unknown>).commit,
    started,
    're-reading it would assert something about a process that no longer exists',
  );
});

test('t270 AT — ponta_do_principal is read live, on every call', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'ponta');

  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    mainBranch: 'main',
  });

  const first = await resolve(readEnvironment);
  const before = (first.referencia as Record<string, unknown>).commit;
  assert.equal(before, git(repoRoot, 'rev-parse', 'main'));

  const advanced = commit(repoRoot, 'the main line moved');

  const second = await resolve(readEnvironment);
  assert.equal(
    (second.referencia as Record<string, unknown>).commit,
    advanced,
    'the tip of the main line is a fact about the repository, and it advances with every integration',
  );
  assert.notEqual(before, advanced);
});

test('t270 AT — a path that is not a repository blocks, naming the command', async (t) => {
  const { createExecutorEnvironmentResolver, ExecutorEnvironmentError } = await loadModule();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t270-not-a-repo-'));
  t.after(() => {
    execFileSync('rm', ['-rf', base], { stdio: 'ignore' });
  });

  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: base,
    referenceMode: 'ponta_do_principal',
  });

  await assert.rejects(
    async () => await resolve(readEnvironment),
    (error: unknown) => {
      assert.ok(
        error instanceof ExecutorEnvironmentError,
        `a misconfigured bench is its own refusal, not a resolved placeholder: ${String(error)}`,
      );
      assert.match(
        error.message,
        /git -C/,
        'the message names the command that failed, so the operator can run it themselves',
      );
      assert.ok(error.command.includes(base), `the command names the bench: ${error.command}`);
      return true;
    },
  );
});
