/**
 * Acceptance test for t1340 AT28: `cartografo-runner prune` leaves the artifact
 * spool alone.
 *
 * `cli/run.ts` puts the spool beside the session worktrees, as
 * `<worktreesRoot>/.artifact-spool`, the way `.input-files` already sits there.
 * What it holds is the only copy of a completed session's declared file until
 * the store accepts it, so the sweep that collects finished worktrees must never
 * take it — even when the job it belongs to is the one being collected.
 *
 * Real git, a faked control plane through the `fetchImpl` seam, exactly as
 * `prune.test.ts` does it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runPruneCli } from '../../src/cli/prune.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

test('AT28 — prune over a worktrees root holding .artifact-spool leaves the spool untouched', async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1340-prune-'));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const repoRoot = path.join(base, 'repo');
  const worktreesRoot = path.join(base, 'worktrees');
  mkdirSync(repoRoot);
  mkdirSync(worktreesRoot);
  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t1340');
  writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo of t1340\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'initial');

  // A concluded job 1, with a session tree the prune really collects...
  const tree = path.join(worktreesRoot, 'ticket-1-00000001');
  git(repoRoot, 'worktree', 'add', '--force', '-b', 'ticket-1', tree, 'HEAD');

  // ...and the spool of that same job, beside it.
  const sessionDir = path.join(worktreesRoot, '.artifact-spool', 'job-1', 'session-1');
  mkdirSync(path.join(sessionDir, 'files'), { recursive: true });
  const state = JSON.stringify({ version: 1, job_id: 1, session_id: 1, names: ['relatorio'] });
  writeFileSync(path.join(sessionDir, 'state.json'), state);
  writeFileSync(path.join(sessionDir, 'files', '72656c61746f72696f'), 'bytes');

  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ id: 1, title: 'fixture', current_node_id: 'n', blocked: false, completed: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  const lines: string[] = [];
  const code = await runPruneCli(
    ['--url', 'http://127.0.0.1:4317', '--working-dir', repoRoot, '--worktrees-root', worktreesRoot],
    {},
    { fetchImpl, out: (line) => lines.push(line), err: (line) => lines.push(line) },
  );

  assert.equal(code, 0, lines.join('\n'));
  assert.equal(existsSync(tree), false, `the concluded tree was collected:\n${lines.join('\n')}`);
  assert.equal(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'), state, 'the spool marker is untouched');
  assert.equal(readFileSync(path.join(sessionDir, 'files', '72656c61746f72696f'), 'utf8'), 'bytes');
});
