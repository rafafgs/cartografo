/**
 * Acceptance tests of `cartografo-runner prune` (t207-C).
 *
 * `session-worktree.ts` names this command in its own header — "Kept trees...
 * accumulate until a human or a later ficha prunes them — this module only
 * decides that they are kept, never how they eventually go away" — and since
 * t207-B there is one more way for a tree to be kept, so the pile grows faster
 * than it used to.
 *
 * Against REAL git, like `session-worktree.test.ts` and for the same reason:
 * what is being asserted is what git does — a registration that disappears from
 * `worktree list`, a `branch -d` that refuses a branch nobody merged, a branch
 * that cannot be deleted while a worktree still has it checked out. A fake git
 * would only prove this module's opinion of git.
 *
 * The control plane is the one thing that IS faked, through the `fetchImpl`
 * seam: what this command asks it is a single `GET /v1/jobs/:id` per candidate
 * (D1 — the runner asks, it never guesses), and booting a real server per case
 * would pay for a round trip that proves nothing about the pruning.
 *
 * English per D18; the fixture content is Portuguese, like every other fixture
 * in this package.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as PruneModule from '../../src/cli/prune.ts';
import type * as CliModule from '../../src/cli/index.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PRUNE_MODULE = 'src/cli/prune.ts';
const CLI_MODULE = 'src/cli/index.ts';

/** The tracked file every fixture repository carries. */
const TRACKED_FILE = 'README.md';

/** An address nothing in these cases actually dials — the fetch is a seam. */
const SOME_URL = 'http://127.0.0.1:4317';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Runs git in a directory and gives back its stdout, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** `true` when the branch exists in the repository. */
function branchExists(repoRoot: string, branch: string): boolean {
  try {
    git(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/** The worktrees git itself reports, by directory basename. */
function registeredWorktrees(repoRoot: string): string[] {
  return git(repoRoot, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.basename(line.slice('worktree '.length)));
}

interface Fixture {
  repoRoot: string;
  worktreesRoot: string;
  /**
   * Cuts a worktree for a job, exactly as `GitWorktreeManager.acquire` names it.
   *
   * @param jobId The work the tree belongs to.
   * @param extraCommit A commit made inside the tree, which is what makes the
   *   branch unmergeable into the default one.
   * @returns The absolute path of the directory.
   */
  worktreeFor: (jobId: number, extraCommit?: boolean) => string;
}

/** A disposable repository plus the root its session worktrees live under. */
function fixture(t: TestHook, label: string): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), `cartografo-t207c-${label}-`));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const repoRoot = path.join(base, 'repo');
  const worktreesRoot = path.join(base, 'worktrees');
  mkdirSync(repoRoot);
  mkdirSync(worktreesRoot);
  git(repoRoot, 'init', '--quiet');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t207');
  writeFileSync(path.join(repoRoot, TRACKED_FILE), '# Repo de fixture da t207-C\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');

  let serial = 0;
  return {
    repoRoot,
    worktreesRoot,
    worktreeFor: (jobId, extraCommit = false) => {
      serial += 1;
      // The same shape `acquire` mints: `ticket-<id>-<hex>`.
      const target = path.join(worktreesRoot, `ticket-${jobId}-${serial.toString(16).padStart(8, '0')}`);
      git(repoRoot, 'worktree', 'add', '--force', '-b', `ticket-${jobId}`, target, 'HEAD');
      if (extraCommit) {
        writeFileSync(path.join(target, 'trabalho.md'), 'commit que ninguém mergeou\n');
        git(target, 'add', '.');
        git(target, 'commit', '--quiet', '-m', `trabalho do ticket ${jobId}`);
      }
      return target;
    },
  };
}

/** How the fake control plane answers about one job. */
type JobAnswer =
  | { bloqueado: boolean; concluido: boolean }
  | 'not-found'
  | 'network-error';

/**
 * A `fetch` that answers `GET /v1/jobs/:id` from a table and nothing else.
 *
 * Anything the command asks for that is not in the table is a `404`: a job id
 * this command invented is exactly the case FR4 says to skip and report.
 */
function controlPlane(jobs: Record<number, JobAnswer>): {
  fetchImpl: typeof fetch;
  routes: string[];
} {
  const routes: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    routes.push(url);
    const match = /\/v1\/jobs\/(\d+)$/.exec(url);
    const answer = match === null ? 'not-found' : (jobs[Number(match[1])] ?? 'not-found');

    if (answer === 'network-error') throw new TypeError('fetch failed');
    if (answer === 'not-found') {
      return new Response(JSON.stringify({ erro: 'nao_encontrado' }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        id: Number(match?.[1] ?? 0),
        titulo: 'ficha de fixture',
        no_atual: 'implementar',
        bloqueado: answer.bloqueado,
        concluido: answer.concluido,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, routes };
}

/** Everything written to a standard stream, while it is armed. */
interface Capture {
  written: () => string;
  restore: () => void;
}

/** Swallows and records what the command writes on a standard stream. */
function captureStream(name: 'stdout' | 'stderr'): Capture {
  const stream = process[name];
  const original = stream.write.bind(stream);
  let written = '';

  stream.write = ((chunk: string | Uint8Array): boolean => {
    written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof stream.write;

  return {
    written: () => written,
    restore: () => {
      stream.write = original;
    },
  };
}

/** Runs the command with both streams captured. */
async function run(
  args: string[],
  seams: PruneModule.PruneSeams,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { runPruneCli } = await loadModule<typeof PruneModule>(PRUNE_MODULE);
  const out = captureStream('stdout');
  const err = captureStream('stderr');
  try {
    const code = await runPruneCli(args, {}, seams);
    return { code, stdout: out.written(), stderr: err.written() };
  } finally {
    out.restore();
    err.restore();
  }
}

test('AT1 — a prune with no --worktrees-root dies with a 2 before it dials anything', async (t) => {
  const { repoRoot } = fixture(t, 'at1');
  const plane = controlPlane({});

  const { code, stderr } = await run(['--working-dir', repoRoot], {
    fetchImpl: plane.fetchImpl,
  });

  assert.equal(code, 2, 'a command line this command cannot read is a 2');
  assert.match(
    stderr,
    /cartografo-runner: --worktrees-root is required/,
    `the line has to name the missing flag:\n${stderr}`,
  );
  assert.match(stderr, /--help/, 'the line has to carry the way out');
  assert.deepEqual(plane.routes, [], 'a wrong command line must cost no round trip');
});

test('AT2 — --dry-run lists only the concluded job and touches nothing', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at2');

  const doneTree = worktreeFor(1);
  const blockedTree = worktreeFor(2);
  const plane = controlPlane({
    1: { bloqueado: false, concluido: true },
    2: { bloqueado: true, concluido: false },
  });

  const { code, stdout } = await run(
    ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot, '--dry-run'],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(code, 0, `a dry run that ran is a 0:\n${stdout}`);
  assert.ok(
    stdout.includes(`would remove worktree: ${doneTree} (job 1)`),
    `the concluded job's tree has to be listed:\n${stdout}`,
  );
  assert.ok(
    stdout.includes('would delete branch: ticket-1'),
    `the concluded job's branch has to be listed:\n${stdout}`,
  );
  assert.ok(
    !stdout.includes(`would remove worktree: ${blockedTree}`),
    `a blocked job is still in flight and must never be listed for removal:\n${stdout}`,
  );
  assert.ok(
    !stdout.includes('would delete branch: ticket-2'),
    `a blocked job's branch must never be listed for deletion:\n${stdout}`,
  );

  // The whole point of a dry run: the disk and git are exactly as they were.
  assert.ok(existsSync(doneTree), 'a dry run removed a directory');
  assert.ok(existsSync(blockedTree), 'a dry run removed a directory');
  assert.deepEqual(
    registeredWorktrees(repoRoot).sort(),
    [path.basename(repoRoot), path.basename(doneTree), path.basename(blockedTree)].sort(),
    'a dry run changed git`s registration',
  );
  assert.ok(branchExists(repoRoot, 'ticket-1'), 'a dry run deleted a branch');
  assert.ok(branchExists(repoRoot, 'ticket-2'), 'a dry run deleted a branch');
});

test('AT3 — a real run removes the concluded tree and branch, and leaves the in-flight one', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at3');

  const doneTree = worktreeFor(1);
  const blockedTree = worktreeFor(2);
  const plane = controlPlane({
    1: { bloqueado: false, concluido: true },
    2: { bloqueado: true, concluido: false },
  });

  const { code, stdout } = await run(
    ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(code, 0, `a run that did what it was asked is a 0:\n${stdout}`);

  assert.ok(!existsSync(doneTree), 'the concluded job kept its directory');
  assert.ok(
    !registeredWorktrees(repoRoot).includes(path.basename(doneTree)),
    'git still registers the removed worktree: the next `worktree add` inherits a stale entry',
  );
  assert.ok(
    !branchExists(repoRoot, 'ticket-1'),
    'the concluded job kept its branch, which is the other half of the GC',
  );

  assert.ok(existsSync(blockedTree), 'a blocked job lost the tree its next dispatch diagnoses from');
  assert.ok(
    registeredWorktrees(repoRoot).includes(path.basename(blockedTree)),
    'git stopped registering the worktree of a job that is still in flight',
  );
  assert.ok(branchExists(repoRoot, 'ticket-2'), 'a blocked job lost the branch its work lives on');
});

test('AT4 — a concluded job whose branch nobody merged loses the tree and keeps the branch', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at4');

  // A commit inside the tree is what makes the branch unmergeable into the
  // default one — and `concluido` says the traversal reached a final node, which
  // says nothing at all about whether those commits landed anywhere.
  const tree = worktreeFor(1, true);
  const plane = controlPlane({ 1: { bloqueado: false, concluido: true } });

  const { code, stdout } = await run(
    ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(
    code,
    0,
    `a refusal to delete an unmerged branch is an ordinary result, never a failure:\n${stdout}`,
  );
  assert.ok(!existsSync(tree), 'the tree of a concluded job was not removed');
  assert.ok(
    branchExists(repoRoot, 'ticket-1'),
    'an unmerged branch was deleted: `-D` would discard real history, which is why this command only ever uses `-d`',
  );
  assert.match(
    stdout,
    /ticket-1.*not fully merged/,
    `the refusal has to be reported, not swallowed:\n${stdout}`,
  );
});

test('AT5 — a directory this command does not recognize is reported and left alone', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at5');

  worktreeFor(1);

  // Two ways of not being a session worktree, and neither of them may be
  // removed: a name that does not parse, and a name that parses while git has
  // never heard of the directory.
  const stranger = path.join(worktreesRoot, 'anotacoes-do-operador');
  mkdirSync(stranger);
  writeFileSync(path.join(stranger, 'nota.md'), 'nada a ver com sessão nenhuma\n');
  const impostor = path.join(worktreesRoot, 'ticket-99-deadbeef');
  mkdirSync(impostor);
  writeFileSync(path.join(impostor, 'nota.md'), 'parece uma worktree e não é\n');

  const plane = controlPlane({ 1: { bloqueado: false, concluido: true } });

  const { code, stdout } = await run(
    ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(code, 0, `an unrecognized directory is not a failure:\n${stdout}`);
  assert.ok(existsSync(stranger), 'a directory nobody in this system created was removed');
  assert.ok(existsSync(impostor), 'a directory git does not register as a worktree was removed');
  assert.ok(
    stdout.includes(stranger) && stdout.includes(impostor),
    `both have to be reported — a silent skip reads as "there was nothing there":\n${stdout}`,
  );
  assert.ok(
    !plane.routes.some((route) => route.endsWith('/v1/jobs/99')),
    'a directory git does not register must not even become a question for the control plane',
  );
});

test('AT6 — a control plane nobody can reach ends the run with a 1 and touches nothing', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at6');

  const tree = worktreeFor(1);
  const plane = controlPlane({ 1: 'network-error' });

  const { code, stderr } = await run(
    ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(code, 1, 'a run that could not ask anybody anything is not a successful run');
  assert.match(stderr, /control plane/, `the line has to name what could not be reached:\n${stderr}`);
  assert.ok(existsSync(tree), 'a run that could not ask still removed something');
  assert.ok(branchExists(repoRoot, 'ticket-1'), 'a run that could not ask still deleted a branch');
});

test('AT7 — --older-than leaves a tree younger than the window exactly where it is', async (t) => {
  const { repoRoot, worktreesRoot, worktreeFor } = fixture(t, 'at7');

  const fresh = worktreeFor(1);
  const old = worktreeFor(2);
  // Backdated by hand: the age gate reads the directory's mtime, and a fixture
  // cannot wait a week.
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);

  const plane = controlPlane({
    1: { bloqueado: false, concluido: true },
    2: { bloqueado: false, concluido: true },
  });

  const { code, stdout } = await run(
    [
      '--url',
      SOME_URL,
      '--working-dir',
      repoRoot,
      '--worktrees-root',
      worktreesRoot,
      '--older-than',
      '7',
    ],
    { fetchImpl: plane.fetchImpl },
  );

  assert.equal(code, 0, `a run with an age filter is still a run:\n${stdout}`);
  assert.ok(existsSync(fresh), 'a tree younger than --older-than was removed');
  assert.ok(!existsSync(old), 'a tree older than --older-than survived');
  assert.ok(
    readdirSync(worktreesRoot).includes(path.basename(fresh)),
    'the fresh tree left the worktrees root',
  );
});

test('AT8 — `prune` is a subcommand of the runner binary, and every other line still runs a runner', async () => {
  const { runRunnerCli } = await loadModule<typeof CliModule>(CLI_MODULE);

  // The router has to reach the prune module rather than choking on a bare
  // positional — `readOptions` refuses "a flag nobody declared, a stray
  // positional", and `prune` is neither once this ficha lands.
  const stderr = captureStream('stderr');
  let code: number;
  try {
    code = await runRunnerCli(['prune'], {}, { run: async () => undefined });
  } finally {
    stderr.restore();
  }

  assert.equal(code, 2, 'a prune with no --worktrees-root is a usage error, not an unknown option');
  assert.match(
    stderr.written(),
    /--worktrees-root is required/,
    `the router reached the prune parser, not the runner one:\n${stderr.written()}`,
  );

  // ...and the flags-only invocation this binary has always taken is untouched.
  const seen: unknown[] = [];
  const stdout = captureStream('stdout');
  try {
    code = await runRunnerCli(
      ['--worktrees-root', path.join(tmpdir(), 'cartografo-t207c-elsewhere')],
      {},
      {
        run: async (options) => {
          seen.push(options);
        },
      },
    );
  } finally {
    stdout.restore();
  }

  assert.equal(code, 0, 'the ordinary runner invocation stopped working');
  assert.equal(seen.length, 1, 'the ordinary runner invocation did not start a runner');
});
