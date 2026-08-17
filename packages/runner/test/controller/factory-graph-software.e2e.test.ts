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
 * the engine: `refinar` → `desenvolver` → `integrar` crosses on its own, each
 * node's structured report reaches `PATCH /sessions/:id/finish`, and the NEXT
 * node's prompt carries the value where the placeholder used to be — the
 * specification `refinar` wrote, then the branch `desenvolver` left behind.
 *
 * And it asserts the honest limit too. `testar` reads `{{input.aplicacao.*}}`
 * and `{{input.banco_de_testes.*}}` — a running staging app and a shared test
 * bench, neither of which has a projection source, a runner-side mechanism or
 * a design sketch anywhere in this repository. That node still blocks, and the
 * last case here pins that it blocks GRACEFULLY: a reason a person can read,
 * not a retry loop (t252).
 *
 * English per D18; route segments, node ids and the bundle's own keys stay in
 * Portuguese.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ClienteControle } from '../../src/controller/cliente-controle.ts';
import { Controller } from '../../src/controller/controller.ts';
import { createClaudeCodeDispatch } from '../../src/dispatch/dispatch.ts';
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
  'refinar-ticket.json',
  'desenvolver-ticket.json',
  'integrar-branch.json',
  'testar-alpha.json',
  'implantar-release.json',
]);

interface Work {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
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

/** What the fake `refinar` session hands back — `refinar-ticket`'s `output`. */
const ESPECIFICACAO = '## Objetivo\n\nFazer a travessia real acontecer, ponta a ponta.';
const REFINADO = {
  especificacao: ESPECIFICACAO,
  criterios_de_aceite: ['AT1: o nó seguinte lê a especificação deste'],
  arquivos_tocados: ['packages/runner/src/dispatch/dispatch.ts'],
  nota: 'refinei sem tomar default nenhum',
};

/** ...and the fake `desenvolver` session — `desenvolver-ticket`'s `output`. */
const BRANCH = 'ticket-259-travessia-real';
const DESENVOLVIDO = {
  branch: BRANCH,
  commits: ['a1b2c3d'],
  gates: { testes: 'passou' },
  nota: 'implementei contra a especificação que chegou no prompt',
};

/** ...and the fake `integrar` session — `integrar-branch`'s `output`. */
const MERGE_COMMIT = 'feedfacecafe123';
const INTEGRADO = {
  merge_commit: MERGE_COMMIT,
  conflitos_resolvidos: [],
  gates: { testes: 'passou' },
  nota: 'reconciliei sem conflito',
};

test('t259 AT6 — refinar → desenvolver → integrar crosses the real software bundle', async (t) => {
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
      entry_node_id: 'refinar',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t259-fabrica', 'o que atravessa o bundle de software');

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(REFINADO);
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column — `buildCommand` puts them there, and what
  // the control plane stores as `prompt` is `buildPrompt`'s envelope
  // (`session-spec.ts`). What the model was TOLD is the argv.
  let currentRecord = path.join(root, 'refinar.json');
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

  // --- 1. `refinar` dispatches at all, which is the whole of the repair -----
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterRefino = await jobNow();
  assert.equal(afterRefino.blocked, false, afterRefino.block_reason ?? '');
  assert.equal(afterRefino.current_node_id, 'desenvolver');

  const refino = bodyOf('refinar');
  assert.ok(refino.includes(job.title), 'the job identity comes from `input.job`');
  assert.ok(
    refino.includes(String(PROJECT.convencoes)),
    'and the class config from `input.project`',
  );
  assert.ok(!refino.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 2. what `refinar` produced is what `desenvolver` reads ---------------
  currentLines = reports(DESENVOLVIDO);
  currentRecord = path.join(root, 'desenvolver.json');
  assert.ok(await controller.tick());
  const afterDev = await jobNow();
  assert.equal(afterDev.blocked, false, afterDev.block_reason ?? '');
  assert.equal(afterDev.current_node_id, 'integrar');

  const dev = bodyOf('desenvolver');
  assert.ok(
    dev.includes(ESPECIFICACAO),
    'the specification the previous node reported is what `{{input.ticket.especificacao}}` resolves to',
  );
  assert.ok(!dev.includes('{{input.'));

  // --- 3. ...and what `desenvolver` produced is what `integrar` reads -------
  currentLines = reports(INTEGRADO);
  currentRecord = path.join(root, 'integrar.json');
  assert.ok(await controller.tick());
  const afterIntegra = await jobNow();
  assert.equal(afterIntegra.blocked, false, afterIntegra.block_reason ?? '');
  assert.equal(afterIntegra.current_node_id, 'testar');

  const integra = bodyOf('integrar');
  assert.ok(
    integra.includes(BRANCH),
    'the branch the previous node reported is what `{{input.artefato.branch}}` resolves to',
  );
  assert.ok(!integra.includes('{{input.'));

  // --- 4. the projection carries both buckets, side by side ----------------
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.equal((input.ticket as Record<string, unknown>).especificacao, ESPECIFICACAO);
  assert.deepEqual(
    input.artefato,
    { ...DESENVOLVIDO, ...INTEGRADO },
    '`desenvolver` and `integrar` declare the SAME bucket, so `merge_commit` lands beside `branch`',
  );

  // --- 5. and `testar` blocks gracefully, which is the declared limit ------
  currentLines = reports({ resultado: 'aprovado', outcome: 'aprovado', vereditos: [] });
  currentRecord = path.join(root, 'testar.json');
  // `null`, and that IS the block: a dispatch that stopped the work resolves
  // normally and `tick()` treats it as one candidate fewer (`controller.ts`).
  assert.equal(await controller.tick(), null);

  const stuck = await jobNow();
  assert.equal(stuck.current_node_id, 'testar', 'it did not move');
  assert.equal(stuck.blocked, true, 'and it stopped with a reason instead of retrying forever');
  const reason = stuck.block_reason ?? '';
  assert.ok(reason.includes('testar') && reason.includes('aplicacao'), reason);
});
