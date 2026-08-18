/**
 * The surveyor command against the real thing, end to end (t254, FR9).
 *
 * `proposal.test.ts` proves the FLOW — a real control plane, a real event log,
 * a real session, a real `POST /v1/proposals` — by calling
 * `proposeFlowImprovement` in this process. Everything it does not cover is in
 * the eleven lines `cli.mjs` runs around it, and until this file existed no test
 * in `test/surveyor/` spawned that command at all: `command-line.test.ts` reads
 * argv in process, `proposal.test.ts` skips the entry point entirely.
 *
 * That gap had a bug sitting in it since t226 renamed the wire. The report the
 * command prints read `result.proposta.grafo_id` and `.versao_alvo` off a
 * `Proposta` that carries `graph_id` and `target_version`, so the two lines a
 * person runs this command FOR — which graph, which version — both printed the
 * literal string `undefined`, on every successful run, with an exit code of 0
 * and a green suite behind it.
 *
 * So this file removes the last fake: the command is spawned as a child process
 * and nothing in this process can reach into it. Two consequences shape
 * everything below:
 *
 * - the engine is swapped through `PATH`, not through a seam. `cli.mjs` builds
 *   its own `ClaudeCodeAdapter` with no injection point, deliberately — needing
 *   a real process is why that file exists — so the `claude` it finds is a shim
 *   that execs the fake engine (`test/bin.e2e.test.ts`'s device);
 * - the credential travels on the command line, because `globalThis.fetch` is
 *   untouched here. A child process cannot inherit a patched global, which is
 *   exactly what makes the assertion honest: the only token that reaches the API
 *   is the one the command presented itself.
 *
 * The telemetry is seeded the same way `proposal.test.ts` seeds it — real
 * timestamps from the control plane's own clock, never fabricated ones — because
 * what has to exist for this command to print anything is a bottleneck it
 * measured, not one a fixture asserted.
 *
 * English per D18; route segments, payload keys and the fixture's node ids stay
 * in Portuguese.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import type * as ProposalModule from '../../src/surveyor/proposal.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CLI_PATH = path.join(PACKAGE_ROOT, 'src', 'surveyor', 'cli.mjs');
const PROPOSAL_MODULE = 'src/surveyor/proposal.ts';
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const MINIMAL_GRAPH = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

/** The run this command is pointed at. */
const EXECUTION_ID = 2540;

/**
 * Slack between two timestamps of the seeded telemetry.
 *
 * `occurred_at` has millisecond resolution, so two writes in the same tick would
 * produce a zero interval and a run with no signal at all — which is the case
 * where this command prints nothing and exits 0 for the other reason.
 */
const GAP_MS = 25;

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** A control plane of this test's own, and the credential it minted. */
interface ControlPlane {
  baseUrl: string;
  token: string;
}

interface GraphVersion {
  id: string;
  graph_id: string;
}

interface Work {
  id: number;
}

interface Session {
  id: number;
}

interface Question {
  id: number;
}

interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  status: string;
}

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** Talks JSON with the control plane, presenting the credential and asserting the status. */
async function api<T>(
  plane: ControlPlane,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${plane.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${plane.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** A scratch directory that cleans itself up. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t254-${label}-`));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * A directory holding a `claude` that is really the fake engine.
 *
 * @param base Directory to put the shim in.
 * @returns The directory to prepend to `PATH`.
 */
function fakeEngineOnPath(base: string): string {
  const shim = path.join(base, 'claude');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ENGINE)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return base;
}

/**
 * Seeds one execution whose `revisar` node is unmistakably the bottleneck.
 *
 * The same shape `proposal.test.ts` seeds: queued, then busy, then blocked on a
 * question, plus the question itself. Every number comes from the control
 * plane's own clock.
 */
async function seedBottleneck(plane: ControlPlane, versionId: string): Promise<void> {
  const work = await api<Work>(
    plane,
    'POST',
    '/v1/jobs',
    {
      title: 'travessia com gargalo',
      entry_node_id: 'redigir',
      execution_id: EXECUTION_ID,
      graph_version_id: versionId,
    },
    201,
  );

  await api(plane, 'POST', `/v1/jobs/${work.id}/transitions`, { to_node_id: 'revisar' });
  await delay(GAP_MS);

  const session = await api<Session>(
    plane,
    'POST',
    '/v1/sessions',
    {
      job_id: work.id,
      node_id: 'revisar',
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'revise a nota',
    },
    201,
  );

  const question = await api<Question>(
    plane,
    'POST',
    '/v1/input-requests',
    {
      job_id: work.id,
      session_id: session.id,
      kind: 'question',
      question: 'a nota responde ao tema?',
      auto_approvable: true,
    },
    201,
  );
  await delay(GAP_MS);

  await api(plane, 'PATCH', `/v1/input-requests/${question.id}/answer`, {
    answer: 'responde, siga',
    answered_by: 'rafael',
  });
  await api(plane, 'PATCH', `/v1/sessions/${session.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    usage: null,
  });
}

/** A well-formed semantic diff over the minimal graph, as `proposal.test.ts` writes it. */
const VALID_OPERATIONS = [
  {
    type: 'change_node_field',
    node_id: 'revisar',
    field: 'description',
    from: 'Confere a nota contra o tema declarado e encerra a travessia.',
    to: 'Confere a nota contra o tema declarado, com um checklist de três itens.',
    inverse: {
      type: 'change_node_field',
      node_id: 'revisar',
      field: 'description',
      from: 'Confere a nota contra o tema declarado, com um checklist de três itens.',
      to: 'Confere a nota contra o tema declarado e encerra a travessia.',
    },
  },
];

/** Runs the real entrypoint and gives back what a shell would see. */
function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(CLI_PATH), 'artifact does not exist yet: packages/runner/src/surveyor/cli.mjs');

  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    // A credential exported by whoever runs the suite must not decide the
    // outcome of a test about what this command presents.
    env: { ...process.env, CARTOGRAFO_TOKEN: '', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('t254 — the spawned surveyor reports the graph and version it really proposed against', async (t) => {
  const { OUTPUT_FILE } = await loadModule<typeof ProposalModule>(PROPOSAL_MODULE);

  const { url: baseUrl, token } = await bootCore(t);
  const plane: ControlPlane = { baseUrl, token };

  // A resolvable capability per node, or the version is stored `unchecked` and
  // the travellers this scenario needs could not be created at all (t283).
  const document = await resolvePins(
    plane.baseUrl,
    plane.token,
    JSON.parse(readFileSync(MINIMAL_GRAPH, 'utf8')) as Record<string, unknown>,
  );
  const { graph_version: version } = await api<{ graph_version: GraphVersion }>(
    plane,
    'POST',
    '/v1/graphs',
    document,
    201,
  );
  await seedBottleneck(plane, version.id);

  const workingDir = scratch(t, 'surveyor-workdir');
  const result = runCli([String(EXECUTION_ID), plane.baseUrl, workingDir, '--token', plane.token], {
    PATH: `${fakeEngineOnPath(scratch(t, 'surveyor-bin'))}${path.delimiter}${process.env.PATH ?? ''}`,
    FAKE_ENGINE_WRITE_FILES: JSON.stringify({
      [OUTPUT_FILE]: JSON.stringify({ operations: VALID_OPERATIONS }, null, 2),
    }),
  });

  assert.equal(
    result.status,
    0,
    `a proposal that landed is a 0:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  // The proposal really is in the book — otherwise the report below would be
  // asserting about a run that failed quietly.
  const { proposals } = await api<{ proposals: Proposal[] }>(plane, 'GET', '/v1/proposals');
  assert.equal(proposals.length, 1, `exactly one proposal was posted: ${JSON.stringify(proposals)}`);
  assert.equal(proposals[0].status, 'pending', 'and it only ever reaches pending (README, princípio 5)');
  assert.equal(proposals[0].graph_id, version.graph_id);
  assert.equal(proposals[0].target_version, version.id);

  // ...and the report names it. These two lines are what a person runs this
  // command to read, and both of them printed `undefined` until t254.
  //
  // Asserted over the REPORT BLOCK and not over the whole of stdout, because
  // the evidence line below it carries `graph_version_id` too: a search of the
  // whole output would find the version id whether or not the line that is
  // supposed to print it does.
  const marker = '===== proposal =====';
  const start = result.stdout.indexOf(marker);
  assert.notEqual(start, -1, `the command printed no report at all:\n${result.stdout}`);
  const report = result.stdout.slice(start, result.stdout.indexOf('====================', start));

  assert.ok(
    report.includes(version.graph_id),
    `the report has to name the graph it proposed against:\n${report}`,
  );
  assert.ok(
    report.includes(version.id),
    `...and the version the proposal targets:\n${report}`,
  );
  assert.ok(
    !result.stdout.includes('undefined'),
    `a field the answer does not carry reads as "undefined":\n${result.stdout}`,
  );
});
