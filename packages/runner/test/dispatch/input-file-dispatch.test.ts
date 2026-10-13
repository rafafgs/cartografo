/**
 * Acceptance tests for `{{input_file.<path>}}` through a REAL dispatch (t689,
 * FR5–FR9), against a real control plane and a real process.
 *
 * Three things are proven that no unit test can: the files exist when the
 * process starts and are never inside the worktree; they are gone on every way a
 * dispatch can end; and a command line the platform cannot spawn is refused
 * before a worktree is cut, a process is spawned or a session row is written.
 *
 * One control plane for the whole file, for the reason `dispatch.test.ts` gives:
 * a boot per case is what made the neighbouring timing tests miss their window.
 * Every case registers its own graph class and creates its own job.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { DispatchError } from '../../src/dispatch/outcome.ts';
import { decodeShellSessionText } from '../../src/dispatch/session-text.ts';
import type {
  WorktreeManager,
} from '../../src/dispatch/session-worktree.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const NODE = fileURLToPath(new URL('../fixtures/shell-node-input-files.mjs', import.meta.url));

interface Work {
  id: number;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
}

interface Recorded {
  argv: string[];
  files: Array<{ arg: string; content: string }>;
  cwd: string;
}

async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${String(response.status)}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, canonical(source[key])]));
  }
  return value;
}

/** The registry recomputes this pin at `POST /v1/skills` (D4), `command` included. */
function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

function fixture(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'test', 'fixtures', file), 'utf8')) as Record<string, unknown>;
}

function shellSkill(id: string, argv: string[]): Record<string, unknown> {
  const skill: Record<string, unknown> = {
    ...fixture('skill-check-crossing.json'),
    id,
    description: 'Runs the check as a command.',
    command: { argv },
  };
  skill.hash = manifestHash(skill);
  return skill;
}

function shellGraph(className: string, skill: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const document = fixture('graph-traversal.json');
  const nodes = (document.nodes as Array<Record<string, unknown>>).map((node) =>
    node.id === 'conferir'
      ? { ...node, engine: 'shell', skill_ref: { id: skill.id, version: skill.version, hash: skill.hash } }
      : node,
  );
  return { ...document, problem_class: className, nodes, ...extra };
}

interface FakeWorktrees extends WorktreeManager {
  readonly acquisitions: number[];
}

/** One real git checkout the test owns, so `git status --porcelain` means something. */
function gitWorktrees(dir: string): FakeWorktrees {
  const acquisitions: number[] = [];
  return {
    acquisitions,
    acquire: (jobId) => {
      acquisitions.push(jobId);
      if (!existsSync(path.join(dir, '.git'))) {
        mkdirSync(dir, { recursive: true });
        const git = (...args: string[]): void => {
          execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
        };
        git('init', '-q');
        writeFileSync(path.join(dir, 'README.md'), 'seed\n');
        git('add', '.');
        git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'seed');
      }
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: () => Promise.resolve({ kept: true }),
  };
}

test('t689 — {{input_file.<path>}} through a real dispatch', async (parent) => {
  const { url: baseUrl, token: bootToken } = await bootCore(parent);
  const token = bootToken ?? '';
  let sequence = 700;

  const skillDoc = shellSkill('shell-file-doc', [process.execPath, NODE, '{{input_file.doc}}']);
  const skillFileBig = shellSkill('shell-file-big', [process.execPath, NODE, '{{input_file.big}}']);
  const skillInlineBig = shellSkill('shell-inline-big', [process.execPath, NODE, '{{input.big}}']);
  await api(baseUrl, token, 'POST', '/v1/skills', fixture('skill-do-crossing.json'), 201);
  for (const skill of [skillDoc, skillFileBig, skillInlineBig]) {
    await api(baseUrl, token, 'POST', '/v1/skills', skill, 201);
  }

  const DOC = { title: 'é 😀', rows: [1, 2, 3] };

  async function jobOn(
    skill: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<Work> {
    sequence += 1;
    const document = shellGraph(`input-file-${String(sequence)}`, skill, extra);
    await resolvePins(baseUrl, token, document);
    const registered = await api<{ graph_version: { id: string } }>(baseUrl, token, 'POST', '/v1/graphs', document, 201);
    return await api<Work>(
      baseUrl,
      token,
      'POST',
      '/v1/jobs',
      {
        title: 'a shell node handed its input by file',
        entry_node_id: 'conferir',
        execution_id: sequence,
        graph_version_id: registered.graph_version.id,
      },
      201,
    );
  }

  const sessionsOf = async (jobId: number): Promise<unknown[]> =>
    (await api<{ sessions: unknown[] }>(baseUrl, token, 'GET', `/v1/sessions?job_id=${String(jobId)}`)).sessions;

  /** A scratch area: the worktree, the input-files root and the sidecars. */
  function area(t: { after: (fn: () => void) => void }): { work: string; root: string; record: (name: string) => string } {
    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t689-'));
    t.after(() => {
      rmSync(base, { recursive: true, force: true });
    });
    return {
      work: path.join(base, 'worktree'),
      root: path.join(base, 'input-files'),
      record: (name) => path.join(base, `${name}.json`),
    };
  }

  function dispatcher(
    worktrees: WorktreeManager,
    input: Record<string, unknown>,
    env: Record<string, string>,
    extra: Record<string, unknown> = {},
  ): (jobId: number) => Promise<{ blocked: boolean; reason?: string }> {
    return createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      engines: {
        shell: { adapter: new ShellAdapter({ graceMs: 300 }), decodeSessionText: decodeShellSessionText },
      },
      worktrees,
      timeoutSeconds: 60,
      resolveInput: () => Promise.resolve({ producao: { nota: 'ready' }, ...input }),
      envOverrides: env,
      ...extra,
    }) as (jobId: number) => Promise<{ blocked: boolean; reason?: string }>;
  }

  const read = (file: string): Recorded => JSON.parse(readFileSync(file, 'utf8')) as Recorded;

  await parent.test('AT5 — the file exists with the expected content when the process starts, outside the worktree, which stays clean', async (t) => {
    const { work, root, record } = area(t);
    const worktrees = gitWorktrees(work);
    const job = await jobOn(skillDoc);

    const outcome = await dispatcher(worktrees, { doc: DOC }, { SHELL_NODE_RECORD: record('a') }, { inputFilesRoot: root })(job.id);

    assert.deepEqual(outcome, { blocked: false });
    const seen = read(record('a'));
    assert.equal(seen.files.length, 1, 'the process could read the file it was handed');
    const [file] = seen.files;
    assert.ok(file !== undefined);
    assert.equal(file.content, JSON.stringify(DOC));
    assert.ok(path.isAbsolute(file.arg));
    assert.ok(file.arg.endsWith(`${path.sep}doc.json`));
    assert.ok(file.arg.startsWith(path.join(root, `job-${String(job.id)}`) + path.sep));
    assert.ok(!file.arg.startsWith(work), 'never inside the worktree');
    assert.equal(execFileSync('git', ['-C', work, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  });

  await parent.test('AT5 — with no inputFilesRoot the default is under the system temporary directory', async (t) => {
    const { work, record } = area(t);
    const job = await jobOn(skillDoc);

    await dispatcher(gitWorktrees(work), { doc: DOC }, { SHELL_NODE_RECORD: record('d') })(job.id);

    const [file] = read(record('d')).files;
    assert.ok(file !== undefined);
    assert.ok(file.arg.startsWith(path.join(tmpdir(), 'cartografo-input-files') + path.sep), file.arg);
  });

  await parent.test('AT5 — after the dispatch settles the directory is gone: completed, failed, cancelled and a control-plane throw', async (t) => {
    const { work, root, record } = area(t);
    const gone = (job: Work): void => {
      assert.equal(existsSync(path.join(root, `job-${String(job.id)}`)), false, 'job-<id> is gone with the attempt');
    };

    const completed = await jobOn(skillDoc);
    await dispatcher(gitWorktrees(work), { doc: DOC }, { SHELL_NODE_RECORD: record('c1') }, { inputFilesRoot: root })(completed.id);
    assert.equal(read(record('c1')).files.length, 1);
    gone(completed);

    const failing = await jobOn(skillDoc, { max_consecutive_failures: 5 });
    await assert.rejects(
      () => dispatcher(gitWorktrees(work), { doc: DOC }, { SHELL_NODE_RECORD: record('c2'), SHELL_NODE_EXIT_CODE: '7' }, { inputFilesRoot: root })(failing.id),
      DispatchError,
    );
    assert.equal(read(record('c2')).files.length, 1, 'the process did see the file');
    gone(failing);

    const cancelled = await jobOn(skillDoc, { max_consecutive_failures: 5 });
    await assert.rejects(
      () =>
        dispatcher(
          gitWorktrees(work),
          { doc: DOC },
          { SHELL_NODE_RECORD: record('c3'), SHELL_NODE_HOLD: '1' },
          {
            inputFilesRoot: root,
            onSessionStarted: (cancel: () => Promise<void>) => {
              void cancel();
            },
          },
        )(cancelled.id),
      DispatchError,
    );
    gone(cancelled);

    const thrown = await jobOn(skillDoc, { max_consecutive_failures: 5 });
    await assert.rejects(
      () =>
        dispatcher(
          gitWorktrees(work),
          { doc: DOC },
          { SHELL_NODE_RECORD: record('c4') },
          {
            inputFilesRoot: root,
            doFetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
              /\/finish/.test(String(input)) ? Promise.reject(new TypeError('the control plane went away')) : fetch(input, init),
          },
        )(thrown.id),
      /went away|fetch failed|control plane/i,
    );
    assert.ok(existsSync(record('c4')), 'the process came up before the throw');
    gone(thrown);
  });

  await parent.test('AT5 — two dispatches of one job saw two different paths, and a stale directory is neither reused nor swept', async (t) => {
    const { work, root, record } = area(t);
    const job = await jobOn(skillDoc, { max_consecutive_failures: 5 });
    const stale = path.join(root, `job-${String(job.id)}`, '0000000000000000');
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'doc.json'), 'left by a crashed runner');

    await assert.rejects(
      () => dispatcher(gitWorktrees(work), { doc: DOC }, { SHELL_NODE_RECORD: record('r1'), SHELL_NODE_EXIT_CODE: '3' }, { inputFilesRoot: root })(job.id),
      DispatchError,
    );
    await dispatcher(gitWorktrees(work), { doc: DOC }, { SHELL_NODE_RECORD: record('r2') }, { inputFilesRoot: root })(job.id);

    const first = read(record('r1')).files[0]?.arg;
    const second = read(record('r2')).files[0]?.arg;
    assert.ok(first !== undefined && second !== undefined);
    assert.notEqual(first, second, 'a retry never shares the directory of the attempt before it');
    assert.notEqual(path.dirname(first), stale);
    assert.notEqual(path.dirname(second), stale);
    assert.equal(readFileSync(path.join(stale, 'doc.json'), 'utf8'), 'left by a crashed runner');
    assert.deepEqual(readdirSync(path.join(root, `job-${String(job.id)}`)), ['0000000000000000']);
  });

  await parent.test('AT5 — on win32 an argv over 32,000 characters is refused before anything is cut or spawned', async (t) => {
    const { work, root, record } = area(t);
    const worktrees = gitWorktrees(work);
    const big = 'b'.repeat(32_900);
    const job = await jobOn(skillInlineBig);

    const outcome = await dispatcher(worktrees, { big }, { SHELL_NODE_RECORD: record('w') }, { inputFilesRoot: root, platform: 'win32' })(job.id);

    assert.equal(outcome.blocked, true);
    const measured = process.execPath.length + NODE.length + big.length + 3;
    const reason = outcome.reason ?? '';
    for (const fact of ['conferir', String(measured), '32000', 'position 2', 'big', '{{input_file.big}}']) {
      assert.ok(reason.includes(fact), `the reason names ${fact}: ${reason}`);
    }
    assert.ok(String(measured).startsWith('33'));
    assert.deepEqual(worktrees.acquisitions, [], 'no worktree was acquired');
    assert.equal(existsSync(record('w')), false, 'no process ran');
    assert.deepEqual(await sessionsOf(job.id), [], 'no POST /v1/sessions happened');
    assert.equal(existsSync(root), false, 'nothing was written');
  });

  await parent.test('AT5 — the same input through {{input_file.big}} dispatches on win32', async (t) => {
    const { work, root, record } = area(t);
    const job = await jobOn(skillFileBig);

    const outcome = await dispatcher(
      gitWorktrees(work),
      { big: 'b'.repeat(32_900) },
      { SHELL_NODE_RECORD: record('f') },
      { inputFilesRoot: root, platform: 'win32' },
    )(job.id);

    assert.deepEqual(outcome, { blocked: false });
    assert.equal(read(record('f')).files[0]?.content.length, 32_900);
  });

  await parent.test('AT5 — on linux one 140,000-byte element is blocked and 100,000 dispatches', async (t) => {
    const { work, root, record } = area(t);

    const over = await jobOn(skillInlineBig);
    const blocked = await dispatcher(gitWorktrees(work), { big: 'x'.repeat(140_000) }, { SHELL_NODE_RECORD: record('l1') }, { inputFilesRoot: root, platform: 'linux' })(over.id);
    assert.equal(blocked.blocked, true);
    assert.ok((blocked.reason ?? '').includes('140000'));
    assert.equal(existsSync(record('l1')), false);

    const under = await jobOn(skillInlineBig);
    const ran = await dispatcher(gitWorktrees(work), { big: 'x'.repeat(100_000) }, { SHELL_NODE_RECORD: record('l2') }, { inputFilesRoot: root, platform: 'linux' })(under.id);
    assert.deepEqual(ran, { blocked: false });
    assert.equal(read(record('l2')).argv[0]?.length, 100_000);
  });
});
