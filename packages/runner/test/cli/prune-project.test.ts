/**
 * Acceptance test of `cartografo-runner prune --project` (t1112, AT30).
 *
 * `GET /v1/jobs/:id` reads inside one project, so a prune of a project other
 * than the default one used to be told every job did not exist. `--project`
 * scopes the read; without it, the request is exactly what it always was.
 *
 * The same seam `prune.test.ts` uses: a real repository with real `ticket-<id>`
 * branches, and a fake `fetch` standing in for the control plane.
 *
 * English only.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PRUNE_USAGE, runPruneCli } from '../../src/cli/prune.ts';

const SOME_URL = 'http://127.0.0.1:4317';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** A repository with two `ticket-<id>` branches and a sibling worktrees root. */
function fixture(t: TestHook): { repoRoot: string; worktreesRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t1112-prune-'));
  t.after(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const repoRoot = path.join(base, 'repo');
  const worktreesRoot = path.join(base, 'worktrees');
  mkdirSync(repoRoot);
  mkdirSync(worktreesRoot);
  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t1112');
  writeFileSync(path.join(repoRoot, 'README.md'), '# Fixture repo of t1112\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'initial');
  git(repoRoot, 'branch', 'ticket-11');
  git(repoRoot, 'branch', 'ticket-12');
  return { repoRoot, worktreesRoot };
}

/** A `fetch` that records each URL and answers every job as still running. */
function recordingFetch(): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ blocked: false, completed: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, urls };
}

test('AT30 — prune --project scopes every job read; without it the URL carries no query', async (t) => {
  const { repoRoot, worktreesRoot } = fixture(t);
  const base = ['--url', SOME_URL, '--working-dir', repoRoot, '--worktrees-root', worktreesRoot];
  const quiet = { out: () => undefined, err: () => undefined };

  const scoped = recordingFetch();
  assert.equal(
    await runPruneCli([...base, '--project', '4'], {}, { ...quiet, fetchImpl: scoped.fetchImpl }),
    0,
  );
  assert.deepEqual(scoped.urls, [
    `${SOME_URL}/v1/jobs/11?project_id=4`,
    `${SOME_URL}/v1/jobs/12?project_id=4`,
  ]);

  const unscoped = recordingFetch();
  assert.equal(await runPruneCli(base, {}, { ...quiet, fetchImpl: unscoped.fetchImpl }), 0);
  assert.deepEqual(unscoped.urls, [`${SOME_URL}/v1/jobs/11`, `${SOME_URL}/v1/jobs/12`]);
  for (const url of unscoped.urls) assert.equal(new URL(url).search, '');

  const errors: string[] = [];
  const refused = recordingFetch();
  assert.equal(
    await runPruneCli([...base, '--project', 'abc'], {}, {
      out: () => undefined,
      err: (line) => errors.push(line),
      fetchImpl: refused.fetchImpl,
    }),
    2,
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--project/);
  assert.deepEqual(refused.urls, [], 'a usage error asks the control plane nothing');

  assert.match(PRUNE_USAGE, /--project <id>/);
});
