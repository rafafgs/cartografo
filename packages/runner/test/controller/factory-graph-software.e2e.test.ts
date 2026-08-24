/**
 * The software factory bundle, crossed LIVE (t259, AT6).
 *
 * `grafos-de-fabrica/desenvolvimento-de-software` has been contract-proven
 * since t176 — the graph is sound, every manifest validates, every pin closes —
 * and it had never been dispatched. The first thing that tried found that not
 * one of its five nodes could open a session: the manifests read
 * `{{input.ticket.*}}`, `{{input.projeto.*}}`, `{{input.workspace.*}}` and
 * `{{input.contexto_falha}}`, and the projection t253 built publishes
 * `input.job`, `input.project`, the `contract.produces` buckets and
 * `input.perguntas_respondidas`. Every dispatch ended in
 * `UnresolvedPlaceholderError`, including the entry node.
 *
 * What this test asserts is the repair, end to end and with nothing faked but
 * the engine: `refine` → `develop` → `integrate` crosses on its own, each
 * node's structured report reaches `PATCH /sessions/:id/finish`, and the NEXT
 * node's prompt carries the value where the placeholder used to be — the
 * specification `refine` wrote, then the branch `develop` left behind.
 *
 * And since t270 it crosses ALL FIVE. `test` used to read
 * `{{input.aplicacao.*}}` and `{{input.banco_de_testes.*}}` with no source for
 * either, and this file's last case pinned the honest limit: the node blocked
 * gracefully and the bundle stopped there. The two halves of that gap turned
 * out to be different kinds of fact, and they are answered from different
 * places — the application is static and moved into the graph's own `project`,
 * while `banco_de_testes.caminho` and `referencia.commit` are facts about the
 * MACHINE running the session and come from the runner's executor environment
 * (`resolve-executor-environment.ts`), which the control plane's database
 * could not hold without lying (D1).
 *
 * And since t273 the crossing needs no operator BETWEEN the nodes either. The
 * `integrate` session's `merge_commit` used to be a literal nobody could act on,
 * and this file said so where it was faked: `deploy` was handed the bench's
 * untouched head, because nothing advanced the bench. Now the executor
 * fast-forwards the bench onto the reported commit — and prepares it — before
 * the work is allowed off the node, so what the last two nodes observe is the
 * integrated commit, and `deploy` closes the traversal with `published`.
 *
 * English per D18, and since t280 (D24) so is the bundle this crosses: node ids,
 * bucket names and report keys alike. Three things stay Portuguese here because
 * they are NOT the bundle's to spell — the reserved routing key `resultado` and
 * its fence (`parse-node-result.ts`), and the executor-environment roots
 * `banco_de_testes`/`referencia` the runner itself publishes
 * (`resolve-executor-environment.ts`).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ClienteControle } from '../../src/controller/cliente-controle.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createMainLineAdvancer } from '../../src/dispatch/advance-main-line.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
import { createExecutorEnvironmentResolver } from '../../src/dispatch/resolve-executor-environment.ts';
import { decodeClaudeCodeSessionText } from '../../src/dispatch/session-text.ts';
import type { WorktreeManager } from '../../src/dispatch/session-worktree.ts';
import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUNDLE = path.join(REPO_ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 2596;

/** The five manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze([
  'refine-ticket.json',
  'develop-ticket.json',
  'integrate-branch.json',
  'alpha-test.json',
  'verify-release.json',
]);

interface Work {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  /** The traveller arrived: its node is a final node of the version (t152, t262). */
  completed: boolean;
}

/** A session, in the two fields this crossing reads off `GET /v1/sessions`. */
interface Reported {
  node_id: string | null;
  output: Record<string, unknown> | null;
}

/** The sidecar the fake engine writes with everything the process received. */
interface FakeRecord {
  argv: string[];
}

/** Talks JSON with the control plane, asserting the status on the way. */
async function api<T>(
  baseUrl: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Reads one committed file of the bundle. */
function bundleFile(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(BUNDLE, ...segments), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** One directory per session, the isolation every e2e in this package uses. */
function directoryWorktrees(root: string): WorktreeManager {
  let serial = 0;
  return {
    acquire: (jobId) => {
      serial += 1;
      const dir = path.join(root, `sessao-${String(jobId)}-${String(serial)}`);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/**
 * The lines a fake session prints to report the object its node's
 * `output_schema` declares.
 *
 * One block and nothing else, which is exactly what the rendered instructions
 * now ask for (t259, FR3). The payloads below are the REAL schemas of the real
 * manifests — a report that did not match would be refused by the control plane
 * and stored as `null`, and the node after it would find nothing to resolve
 * against.
 */
function reports(payload: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'Fiz o que o nó pedia.' },
    { stream: 'stdout', text: '```resultado' },
    { stream: 'stdout', text: JSON.stringify(payload) },
    { stream: 'stdout', text: '```' },
  ]);
}

/**
 * The class's static config, read off the graph itself.
 *
 * Read and never retyped: `input.project` IS this object, and a copy in the
 * test would keep passing the day the bundle's own config moved.
 */
const PROJECT = bundleFile('grafo.json').project as Record<string, unknown>;

/** What the fake `refine` session hands back — `refine-ticket`'s `output`. */
const ESPECIFICACAO = '## Goal\n\nMake the real traversal happen, end to end.';
const REFINADO = {
  specification: ESPECIFICACAO,
  acceptance_criteria: ['AT1: the next node reads the specification of this one'],
  touched_files: ['packages/runner/src/dispatch/dispatch.ts'],
  note: 'refined without taking a single default',
};

/** ...and the fake `develop` session — `develop-ticket`'s `output`. */
const BRANCH = 'ticket-259-travessia-real';
const DESENVOLVIDO = {
  branch: BRANCH,
  commits: ['a1b2c3d'],
  gates: { tests: 'passed' },
  note: 'implemented against the specification that arrived in the prompt',
};

/**
 * ...and the fake `integrate` session — `integrate-branch`'s `output`.
 *
 * A REAL commit since t273, and no longer the literal `feedfacecafe123` this
 * file used to carry with a comment calling it fictional: the executor now
 * fast-forwards the bench onto whatever an accepted report names, and a commit
 * no repository has is a commit no bench can be advanced to.
 */
const INTEGRADO = (mergeCommit: string): Record<string, unknown> => ({
  merge_commit: mergeCommit,
  resolved_conflicts: [],
  gates: { tests: 'passed' },
  note: 'reconciled with no conflict',
});

/** ...and what the fake `test` session REPORTS — `alpha-test`'s `output`. */
const TESTADO_REPORT = {
  outcome: 'pass',
  verdicts: [
    {
      ref: 'AT1',
      verdict: 'not_exercised',
      evidence: 'No application is standing this round; the reason came in project.application.',
    },
  ],
  note: 'Validated what the test bench allowed.',
};

/**
 * ...and the block it prints: that report with the edge label inside it.
 *
 * `resultado` rides inside the one block a session prints, which is how a gate
 * with two ways out names the one it took (`parse-node-result.ts`). The KEY is
 * the protocol's, which is why t280 left it spelled this way; the VALUE is the
 * GRAPH's vocabulary — `approved` is the `condition` of the edge to `deploy` —
 * and the control plane takes it out of the object before holding the rest
 * against the pinned skill's `output`, which is why that schema does not
 * declare it (t269, `docs/spec/grafo.md`). Since t275 the bundle says the same
 * thing on both sides: the `test` node declares the label in its own
 * `output_schema`, and the manifest's instructions ask for `outcome` and
 * `resultado` as the two different things they are.
 */
const TESTADO = { resultado: 'approved', ...TESTADO_REPORT };

/**
 * ...and the fake `deploy` session — `verify-release`'s `output`.
 *
 * `published` since t273, and that word IS the ticket's own bar: the commit
 * `integrate` reported is really in the bench's main line by the time this node
 * opens, because the executor put it there between the two ticks. While nothing
 * advanced the bench this fixture answered `not_yet` and was fed the bench's
 * untouched head — the honest reading of a checkout nobody had moved.
 *
 * `mode` is the key this bundle owns and translated; its VALUE stays
 * `ponta_do_principal` because that is what the runner publishes at
 * `input.referencia.modo` and what `--reference-mode` takes.
 */
const IMPLANTADO = (commit: string): Record<string, unknown> => ({
  verdict: 'published',
  checked_reference: { commit, mode: 'ponta_do_principal' },
  release: commit,
  deployed_at: new Date().toISOString(),
  note: 'The merge commit is contained in the reference: the executor advanced the bench.',
});

/** One git command in one checkout, run to completion, with its output trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** What the integrated commit brings with it, so the install step can read it. */
const INTEGRATED_FILE = 'INTEGRATED.md';
const INTEGRATED_TEXT = 'what the integration reconciled\n';

/**
 * The disposable PAIR of repositories a real deployment has, both on `main`.
 *
 * Real ones, and not paths that merely exist: what
 * `createExecutorEnvironmentResolver` answers with is `git rev-parse`'s own
 * output, what t273 does to the bench is a real fast-forward, and a fake `git`
 * would only prove this package's opinion of git.
 *
 * Two directories since t273, because that is what a runner is configured with
 * — `--working-dir` and `--test-bench-path` — and because the commit an
 * integration reports is born in the first one and has to REACH the second.
 * `main` in the main repository is deliberately left behind on the base commit:
 * `integrate-branch`'s own manifest says `merge_commit` is NOT a claim that the
 * main line already points there, and a fixture whose main had already moved
 * would prove nothing about who advances it.
 */
function benchRepository(root: string): {
  /** The bench the last two nodes observe, and what the executor advances. */
  path: string;
  /** The repository the work is cut from, where the merge commit was born. */
  repoRoot: string;
  /** Where the bench's `main` starts, before anything advances it. */
  head: string;
  /** The commit the fake `integrate` session reports, on a branch of `repoRoot`. */
  integrated: string;
} {
  const repoRoot = path.join(root, 'principal');
  mkdirSync(repoRoot, { recursive: true });

  git(repoRoot, 'init', '--quiet', '--initial-branch', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@cartografo.local');
  git(repoRoot, 'config', 'user.name', 'Fixture t270');
  writeFileSync(path.join(repoRoot, 'README.md'), '# checkout do integrado\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'integrado');
  const head = git(repoRoot, 'rev-parse', 'main');

  const benchPath = path.join(root, 'banco-de-testes');
  git(root, 'clone', '--quiet', repoRoot, benchPath);

  git(repoRoot, 'checkout', '--quiet', '-b', 'ticket-259');
  writeFileSync(path.join(repoRoot, INTEGRATED_FILE), INTEGRATED_TEXT);
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '--quiet', '-m', 'what the integration reconciled');
  const integrated = git(repoRoot, 'rev-parse', 'HEAD');
  git(repoRoot, 'checkout', '--quiet', 'main');

  return { path: benchPath, repoRoot, head, integrated };
}

/**
 * The command the executor runs in the bench once it has advanced it.
 *
 * NOT `project.comando_instalacao` verbatim, and the difference is the
 * fixture's and not the product's: the bundle declares `npm ci`, which is the
 * right answer for the repository this class describes and a guaranteed failure
 * in a scratch clone with no lockfile in it. What this command proves is what
 * the ficha claims — that something runs, in the bench, AFTER the fast-forward
 * — and it proves it by reading a file that only exists once the merge landed.
 * That the bundle really declares the key is asserted separately, off the real
 * document.
 */
const BENCH_INSTALL_COMMAND = `cat ${INTEGRATED_FILE} > .bench-prepared`;

test('t259 AT6 — refine → develop → integrate crosses the real software bundle', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t259-fabrica-'));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const file of MANIFESTS) {
    await api(baseUrl, token, 'POST', '/v1/skills', bundleFile('skills', file), 201);
  }

  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    baseUrl,
    token,
    'POST',
    '/v1/graphs',
    bundleFile('grafo.json'),
    201,
  );

  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: 'atravessar o grafo de fábrica de software de verdade',
      body: 'O runner tem que despachar este grafo sem nenhum placeholder sobrando.',
      entry_node_id: 'refine',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t259-fabrica', 'o que atravessa o bundle de software');

  const bench = benchRepository(root);

  /**
   * Every call the dispatch made, so "no operator touched this" is checked
   * instead of merely intended.
   *
   * The two verbs t109's game run reached for by hand are the two recorded
   * here: `PATCH /v1/jobs/:id` (the `fields` amendment) and
   * `POST /v1/jobs/:id/unblocks`.
   */
  const calls: string[] = [];
  const doFetch: typeof fetch = async (target, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(target).slice(baseUrl.length)}`);
    return await fetch(target, init);
  };

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(REFINADO);
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column — `buildCommand` puts them there, and what
  // the control plane stores as `prompt` is `buildPrompt`'s envelope
  // (`session-spec.ts`). What the model was TOLD is the argv.
  let currentRecord = path.join(root, 'refine.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t259-fabrica',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput`: the production default is what this crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        // The seam this ficha opened: the path of the bench and the commit the
        // verification runs against are facts about THIS machine, and the
        // control plane could not hold either without lying (D1, t270).
        executorEnvironment: createExecutorEnvironmentResolver({
          testBenchPath: bench.path,
          referenceMode: 'ponta_do_principal',
          mainBranch: 'main',
        }),
        // ...and the half t273 added: the bench is not only READ on every
        // dispatch, it is MOVED — onto the commit an accepted report named,
        // before the work is allowed off the node that named it. Until this
        // ficha the two nodes after `integrate` observed a checkout that had
        // stayed exactly where it was.
        advanceMainLine: createMainLineAdvancer({
          testBenchPath: bench.path,
          repoRoot: bench.repoRoot,
          mainBranch: 'main',
          installCommand: BENCH_INSTALL_COMMAND,
        }),
        engines: {
          'claude-code': {
            adapter: new ClaudeCodeAdapter({
              commandBuilder: (spec) => ({
                command: process.execPath,
                args: [FAKE_ENGINE, ...buildCommand(spec).args],
              }),
              graceMs: 300,
            }),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
        },
        worktrees,
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: currentLines, FAKE_ENGINE_RECORD: currentRecord },
      })(jobId),
  });

  const jobNow = async (): Promise<Work> =>
    await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`);

  /** Everything the fake session of one node was told, as it received it. */
  const toldTo = (nodeId: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
      '\n',
    );

  /**
   * ...up to the point where the node's own contract is quoted.
   *
   * `renderSkillInstructions` interpolates the MANIFEST body and then appends
   * the node's `contract` as fenced JSON, verbatim — and this bundle's contract
   * carries `{{input.project.comando_testes}}` in its deterministic checks, on
   * purpose: those are templates for whoever RUNS the check, and nothing in the
   * runner runs one yet (t176). So the "no placeholder survives" claim is made
   * where it is a claim: the text the manifest wrote.
   */
  const bodyOf = (nodeId: string): string => toldTo(nodeId).split('## O contrato do nó')[0];

  // --- 1. `refine` dispatches at all, which is the whole of the repair ------
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterRefino = await jobNow();
  assert.equal(afterRefino.blocked, false, afterRefino.block_reason ?? '');
  assert.equal(afterRefino.current_node_id, 'develop');

  const refino = bodyOf('refine');
  assert.ok(refino.includes(job.title), 'the job identity comes from `input.job`');
  assert.ok(
    refino.includes(String(PROJECT.conventions)),
    'and the class config from `input.project`',
  );
  assert.ok(!refino.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 2. what `refine` produced is what `develop` reads --------------------
  currentLines = reports(DESENVOLVIDO);
  currentRecord = path.join(root, 'develop.json');
  assert.ok(await controller.tick());
  const afterDev = await jobNow();
  assert.equal(afterDev.blocked, false, afterDev.block_reason ?? '');
  assert.equal(afterDev.current_node_id, 'integrate');

  const dev = bodyOf('develop');
  assert.ok(
    dev.includes(ESPECIFICACAO),
    'the specification the previous node reported is what `{{input.ticket.specification}}` resolves to',
  );
  assert.ok(!dev.includes('{{input.'));

  // --- 3. ...and what `develop` produced is what `integrate` reads ----------
  currentLines = reports(INTEGRADO(bench.integrated));
  currentRecord = path.join(root, 'integrate.json');
  assert.ok(await controller.tick());
  const afterIntegra = await jobNow();
  assert.equal(afterIntegra.blocked, false, afterIntegra.block_reason ?? '');
  assert.equal(afterIntegra.current_node_id, 'test');

  const integra = bodyOf('integrate');
  assert.ok(
    integra.includes(BRANCH),
    'the branch the previous node reported is what `{{input.artifact.branch}}` resolves to',
  );
  assert.ok(!integra.includes('{{input.'));

  // --- 3.1 ...and the bench moved, which is what nobody used to do (t273) ---
  assert.equal(
    git(bench.path, 'rev-parse', 'main'),
    bench.integrated,
    'the executor fast-forwarded the bench onto the reported merge commit, with no operator',
  );
  assert.equal(
    readFileSync(path.join(bench.path, '.bench-prepared'), 'utf8'),
    INTEGRATED_TEXT,
    'and prepared it afterwards, on the ALREADY advanced tree',
  );
  assert.equal(
    typeof PROJECT.install_command,
    'string',
    'the class declares the command that prepares its bench, beside `test_command`',
  );

  // --- 4. the projection carries both buckets, side by side ----------------
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.equal((input.ticket as Record<string, unknown>).specification, ESPECIFICACAO);
  assert.deepEqual(
    input.artifact,
    { ...DESENVOLVIDO, ...INTEGRADO(bench.integrated) },
    '`develop` and `integrate` declare the SAME bucket, so `merge_commit` lands beside `branch`',
  );

  // --- 5. `test` opens, which used to be this bundle's declared limit ------
  currentLines = reports(TESTADO);
  currentRecord = path.join(root, 'test.json');
  assert.ok(await controller.tick(), 'the gate that used to block was picked up');
  const afterGate = await jobNow();
  assert.equal(afterGate.blocked, false, afterGate.block_reason ?? '');
  assert.equal(afterGate.current_node_id, 'deploy');

  const gate = bodyOf('test');
  const application = PROJECT.application as Record<string, unknown>;
  assert.ok(
    gate.includes(String(application.absence_reason)),
    'the app is STATIC and comes from the graph\'s own `project`, at `input.project.application`',
  );
  assert.ok(
    gate.includes(bench.path),
    'and the bench path is RUNTIME: it comes from the runner, and names this machine',
  );
  assert.ok(!gate.includes('{{input.'));

  const { sessions } = await api<{ sessions: Reported[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/sessions?job_id=${String(job.id)}`,
  );
  assert.deepEqual(
    sessions.find((session) => session.node_id === 'test')?.output,
    TESTADO_REPORT,
    "the gate's report was taken whole, and only the routing key was taken out of it",
  );

  // --- 6. ...and `deploy` reads the commit the runner really looked up -----
  currentLines = reports(IMPLANTADO(bench.integrated));
  currentRecord = path.join(root, 'deploy.json');
  assert.ok(await controller.tick(), 'the final node was picked up too');

  const arrived = await jobNow();
  assert.equal(arrived.blocked, false, arrived.block_reason ?? '');
  assert.equal(arrived.completed, true, 'the traversal is over: the final node reported');

  const implanta = bodyOf('deploy');
  assert.notEqual(bench.integrated, bench.head, 'the bench really had somewhere to move');
  assert.ok(
    implanta.includes(bench.integrated),
    '`{{input.referencia.commit}}` is the real tip of the bench — the commit t273 advanced it to',
  );
  assert.ok(implanta.includes('ponta_do_principal'), '...and the mode it was read under');
  assert.ok(!implanta.includes('{{input.'));

  const { sessions: closed } = await api<{ sessions: Reported[] }>(
    baseUrl,
    token,
    'GET',
    `/v1/sessions?job_id=${String(job.id)}`,
  );
  assert.equal(
    closed.find((session) => session.node_id === 'deploy')?.output?.verdict,
    'published',
    "the five-node traversal closes CONTAINED, which is this ticket's own bar",
  );

  // --- 7. and nobody had to touch it by hand -------------------------------
  assert.deepEqual(
    calls.filter((call) => call.endsWith('/unblocks') || /^PATCH \/v1\/jobs\/\d+$/.test(call)),
    [],
    'the two workarounds this ficha replaces are neither of them used here',
  );
});
