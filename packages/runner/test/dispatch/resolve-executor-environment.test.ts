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

/**
 * Calls the built function with the three arguments the dispatch hands it.
 *
 * Three since t440: `createMergedInputResolver` computes the control plane's
 * projection first and passes it through, so this seam can read a fact that
 * only exists inside it — `input.interview.skill_source`, which the interview
 * itself reported on an earlier turn. The default is `{}`, which is what every
 * case written before that ticket means by "the projection is not the subject
 * here".
 */
async function resolve(
  readEnvironment: (
    job: never,
    node: never,
    projection: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
  projection: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return await readEnvironment(JOB as never, RESOLVED as never, projection);
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

/* -------------------------------------------------------------------------- */
/* What the machine knows about MCP and about precedent classes (t360, FR4)   */
/* -------------------------------------------------------------------------- */

/**
 * The two keys the interview reads, and the honesty rule they are written
 * under.
 *
 * `mcp_servers` is `null` — never `[]` — for an engine whose adapter never
 * implemented discovery, which is t400's own discipline restated one layer out:
 * an engine that cannot answer knows no more about this machine's MCP servers
 * than one with no discovery at all, and collapsing the two tells the person
 * being interviewed a lie about their own machine (RF-20).
 *
 * `similar_classes` comes from a FUNCTION and not a value, because it depends on
 * the job's own title and body: the precedent that reads like THIS declaration
 * is what D8 asks the interview to suggest, never decide.
 */
test('t360 AT3 — a supported discovery lands verbatim at environment.mcp_servers', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'mcp-supported');

  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    mcpDiscovery: { supported: true, servers: ['cartografo', 'flowpilot'] },
  });

  const resolved = await resolve(readEnvironment);
  const environment = resolved.environment as Record<string, unknown>;
  assert.deepEqual(
    environment.mcp_servers,
    ['cartografo', 'flowpilot'],
    'what the runner discovered once is what the session is told, name for name',
  );
  assert.deepEqual(
    environment.similar_classes,
    [],
    'no precedent resolver configured is an empty list, which is a real answer',
  );

  // The bench keys are untouched: this seam grew, it did not change.
  assert.equal((resolved.banco_de_testes as Record<string, unknown>).caminho, repoRoot);
});

test('t360 AT3 — an engine with no discovery reports null, never an empty list', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'mcp-unsupported');

  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    mcpDiscovery: { supported: false },
  });

  const environment = (await resolve(readEnvironment)).environment as Record<string, unknown>;
  assert.equal(
    environment.mcp_servers,
    null,
    '`null` is "this engine`s MCP discovery is not implemented"; `[]` would claim it found none',
  );

  // And a runner that was told nothing at all reads the same way: absent is not
  // an empty list either.
  const silent = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
  });
  assert.equal((( await resolve(silent)).environment as Record<string, unknown>).mcp_servers, null);
});

test('t360 AT3 — the class precedents are resolved per job, and sorted by score', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'precedents');

  const asked: number[] = [];
  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    mcpDiscovery: { supported: false },
    classPrecedents: (job) => {
      asked.push(job.id);
      return Promise.resolve([
        { class: 'b3-flow-radar', name: 'B3 flow radar', description: 'daily flow', score: 0.1 },
        {
          class: 'software-development',
          name: 'Software delivery',
          description: 'the flowpilot flow, ported',
          score: 0.42,
        },
      ]);
    },
  });

  const environment = (await resolve(readEnvironment)).environment as Record<string, unknown>;
  assert.deepEqual(
    (environment.similar_classes as { class: string }[]).map((entry) => entry.class),
    ['software-development', 'b3-flow-radar'],
    'best first: the interview suggests the closest precedent and never decides (D8)',
  );

  // Per dispatch, not per process: the score is about THIS job`s own words.
  await resolve(readEnvironment);
  assert.deepEqual(asked, [270, 270], 'the resolver is asked again on the next dispatch');
});

/* -------------------------------------------------------------------------- */
/* The skills the person already has (t440, FR5; RF-14 extension)             */
/* -------------------------------------------------------------------------- */

/**
 * `environment.skill_drafts`, and the third argument that makes it possible.
 *
 * The fact this seam needs — "what path or URL did the person name" — is not on
 * the `Job` row. It exists only inside the control plane's own projection, at
 * `input.interview.skill_source`, because the interview REPORTED it on an
 * earlier turn. So the resolver takes the projection the merge already fetched
 * rather than fetching the same route a second time.
 *
 * The hook is memoized per job for the life of the runner, mirroring
 * `instalacao_em_uso`'s single read: a twenty-question interview must not
 * re-clone the same repository on every turn.
 */
test('t440 AT — a reported skill_source reaches the hook, and its drafts reach the session', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'skill-drafts');

  const asked: { kind: string; location: string }[] = [];
  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    resolveSkillSource: (source) => {
      asked.push({ ...source });
      return Promise.resolve({ drafts: [{ id: 'code-review' }, { id: 'triage' }], error: null });
    },
  });

  const projection = {
    interview: { done: false, skill_source: { kind: 'path', location: '/Users/rafael/skills' } },
  };
  const environment = (await resolve(readEnvironment, projection)).environment as Record<
    string,
    unknown
  >;

  assert.deepEqual(
    environment.skill_drafts,
    [{ id: 'code-review' }, { id: 'triage' }],
    'what the source derived is what the session is shown, draft for draft',
  );
  assert.equal(environment.skill_drafts_error, null, 'a source that read is not an error');
  assert.deepEqual(asked, [{ kind: 'path', location: '/Users/rafael/skills' }]);

  // Memoized per job: the interview asks twenty questions, and re-reading the
  // same folder — or re-cloning the same repository — on every one of them is
  // twenty reads of an answer that did not change.
  await resolve(readEnvironment, projection);
  assert.equal(asked.length, 1, 'the same job`s source is resolved once, for the life of the runner');
});

test('t440 AT — no skill_source is an empty list, and the hook is never called', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'no-skill-source');

  let calls = 0;
  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    resolveSkillSource: () => {
      calls += 1;
      return Promise.resolve({ drafts: [{ id: 'never' }], error: null });
    },
  });

  for (const projection of [{}, { interview: { done: false } }, { interview: null }]) {
    const environment = (await resolve(readEnvironment, projection)).environment as Record<
      string,
      unknown
    >;
    assert.deepEqual(
      environment.skill_drafts,
      [],
      'a person who has no skills to point at is shown none, not a failure',
    );
    assert.equal(environment.skill_drafts_error, null);
  }
  assert.equal(calls, 0, 'nothing is read, cloned or walked until somebody names a source');

  // ...and a runner with no hook wired at all reads exactly the same way.
  const silent = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
  });
  const environment = (
    await resolve(silent, { interview: { skill_source: { kind: 'path', location: '/tmp/x' } } })
  ).environment as Record<string, unknown>;
  assert.deepEqual(environment.skill_drafts, []);
  assert.equal(environment.skill_drafts_error, null);
});

test('t440 AT — a source that could not be read travels as a message, verbatim', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'skill-drafts-error');

  const message = 'the skill source /Users/rafael/skils is not a directory';
  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    resolveSkillSource: () => Promise.resolve({ drafts: [], error: message }),
  });

  const environment = (
    await resolve(readEnvironment, {
      interview: { skill_source: { kind: 'path', location: '/Users/rafael/skils' } },
    })
  ).environment as Record<string, unknown>;

  assert.deepEqual(environment.skill_drafts, [], 'an error derives no drafts');
  assert.equal(
    environment.skill_drafts_error,
    message,
    'the interview relays it to the person in its next question, so it arrives unedited',
  );
});

test('t440 AT — the two t360 keys are untouched by the third argument', async (t) => {
  const { createExecutorEnvironmentResolver } = await loadModule();
  const repoRoot = fixture(t, 'no-regression');

  const readEnvironment = createExecutorEnvironmentResolver({
    testBenchPath: repoRoot,
    referenceMode: 'ponta_do_principal',
    mcpDiscovery: { supported: true, servers: ['cartografo'] },
    classPrecedents: () =>
      Promise.resolve([{ class: 'map-design', name: 'Map design', description: '', score: 0.3 }]),
  });

  const environment = (
    await resolve(readEnvironment, {
      interview: { skill_source: null },
      job: { id: 270 },
    })
  ).environment as Record<string, unknown>;

  assert.deepEqual(environment.mcp_servers, ['cartografo']);
  assert.deepEqual(
    (environment.similar_classes as { class: string }[]).map((entry) => entry.class),
    ['map-design'],
  );
  assert.deepEqual(environment.skill_drafts, [], 'a reported `null` source is no source at all');
  assert.equal(environment.skill_drafts_error, null);
});
