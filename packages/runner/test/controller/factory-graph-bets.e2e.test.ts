/**
 * The asymmetric-bets factory bundle, crossed LIVE (t260).
 *
 * `factory-graphs/asymmetric-bets` has been contract-proven since t116 —
 * the graph is sound, every one of the seven manifests validates, every pin
 * closes, and `tests/factory-graph-2.test.mjs`'s AT11 walks a real thesis from
 * `triage` to `decide` payload by payload. None of that ever opened a session.
 *
 * t259 found and fixed the same class of bug one bundle over: the manifests
 * named an input vocabulary nobody assembles. The bets bundle was left alone on
 * the premise that its nodes already agree at the top level, which is true from
 * `collect-fundamentals` onward — every later manifest reads
 * `{{input.triaged_thesis.*}}`, and `triage`'s report merges at the top level
 * because no node of this graph declares `contract.produces`. It was false for
 * the entry node itself: `triar-tese` (`triage-thesis` since t293) read
 * `{{input.tese.titulo}}`, `{{input.tese.ativo}}`, `{{input.tese.hipotese}}` and
 * `{{input.criterios_de_triagem}}`, and the projection
 * (`packages/core/src/domain/context.ts`) publishes none of them — `input.job`
 * carries the work's identity, `input.project` the class's static config, and a
 * class field is a flat scalar at the top level. So the first node of this graph
 * could not dispatch at all: `UnresolvedPlaceholderError` before a session ever
 * existed.
 *
 * What this test asserts is the repair, with nothing faked but the engine:
 * `triage` → `collect-fundamentals` crosses on its own, the entry prompt carries
 * the job's own title and body, the asset the class field declares and the
 * criteria the graph's `project` publishes, and the thesis the gate triaged
 * reaches the researcher's prompt where `{{input.triaged_thesis.*}}` used to be.
 *
 * English per D18, and since t293 the bundle's own vocabulary too: node ids,
 * edge labels, skill ids and payload keys are all English here. What is still
 * Portuguese is the thesis itself — title, hypothesis, objections, notes — which
 * is the language this worked example was written in, plus the projection root
 * `perguntas_respondidas` and the reserved routing key `resultado`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
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
const BUNDLE = path.join(REPO_ROOT, 'factory-graphs', 'asymmetric-bets');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 2601;

/** The seven manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze([
  'triage-thesis.json',
  'collect-fundamentals.json',
  'analyze-asymmetry.json',
  'red-team-thesis.json',
  'size-risk.json',
  'escalate-decision.json',
  'record-crossing.json',
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
      return Promise.resolve({ path: dir, branch: `tese-${String(jobId)}` });
    },
    release: (_worktree, outcome) => Promise.resolve({ kept: outcome.keep }),
  };
}

/**
 * The lines a fake session prints to report the object its node's
 * `output_schema` declares.
 *
 * One block and nothing else, which is what the rendered instructions ask for
 * (t259, FR3). The payloads below are the REAL schemas of the real manifests: a
 * report the skill's `output` refuses is stored as `null`
 * (`packages/core/src/repositories/session.ts`), and the node after it would
 * find nothing to resolve against.
 */
function reports(payload: Record<string, unknown>): string {
  return JSON.stringify([
    { stream: 'stdout', text: 'I did what the node asked for.' },
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

/** The asset, which is a class field of this graph and not part of the job. */
const ASSET = 'NVLR3';

/** ...and where the central premise came from, the field `triage` demands. */
const PREMISE_SOURCE = 'fato relevante de 2026-07-30, arquivado no regulador';

/** ...and how big a position is being asked for, the third field it demands (t263). */
const INTENDED_SIZE = 1.5;

const TITLE = 'Navelar Logística (NVLR3) — reprecificação depois da venda do braço rodoviário';
const BODY =
  'O mercado ainda precifica a Navelar como transportadora rodoviária de margem baixa. ' +
  'Vendido o braço rodoviário, sobra uma operação portuária com contrato de longo prazo e ' +
  'caixa líquido; o desconto tende a sumir quando o primeiro trimestre pró-forma for reportado.';

/** What the fake `triage` session hands back — `triage-thesis`'s `output`. */
const TRIAGED_THESIS = {
  id: 'tese-1',
  title: TITLE,
  asset: ASSET,
  hypothesis: BODY,
  research_scope: [
    'termos da venda do braço rodoviário: preço, forma de pagamento e passivos que ficam',
    'contrato portuário: prazo, cláusula de reajuste e concentração de cliente',
    'caixa e dívida pró-forma depois da venda',
  ],
};
const TRIAGED = {
  // The routing label rides INSIDE the report, which is the one block a session
  // prints (t259) — `triage` has two ways out, `advance` and `discard`.
  resultado: 'advance',
  outcome: 'pass',
  triaged_thesis: TRIAGED_THESIS,
  evaluated_criteria: [
    {
      criterion: 'o downside está limitado por caixa líquido ou ativo real, não por narrativa',
      verdict: 'meets',
      evidence: 'A venda está fixada em R$ 1,2 bi à vista contra valor de mercado de R$ 2,1 bi.',
    },
  ],
  rationale: 'A ideia tem piso contratado e evento datado: merece uma rodada de pesquisa.',
  note: 'Escopo restrito a três frentes para a coleta não virar leitura infinita.',
};

/** ...and the fake `collect-fundamentals` session — `collect-fundamentals`'s. */
const COLLECTED = {
  fundamentals: {
    summary: 'Sobra um terminal portuário com contrato take-or-pay até 2032 e caixa líquido.',
    figures: [
      {
        metric: 'caixa líquido pró-forma',
        value: 'R$ 0,9 bi',
        period: 'pró-forma 2T26',
        source: 'release do 2T26, nota 14',
      },
    ],
    known_risks: ['concentração de 71% da receita em um único embarcador'],
  },
  assumptions: [
    {
      assumption: 'o contrato take-or-pay é honrado até 2032',
      source: 'anexo contratual do formulário de referência 2026',
      confidence: 'high',
    },
  ],
  gaps: ['não há documento público com o preço por tonelada do contrato'],
  note: 'Uma premissa com fonte primária; a lacuna de preço fica registrada.',
};

test('t260 — triage → collect-fundamentals crosses the real bets bundle', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t260-fabrica-'));
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

  // `fields` is the class's own vocabulary (t168): `asset`, `premise_source`
  // and `intended_size` are all demanded at `triage`, and the projection
  // spreads them at the TOP level of `input` — beside `input.job`, never inside
  // it.
  const job = await api<Work>(
    baseUrl,
    token,
    'POST',
    '/v1/jobs',
    {
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t260-fabrica', 'the one that crosses the bets bundle');

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(TRIAGED);
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column (`session-spec.ts`). What the model was TOLD
  // is the argv.
  let currentRecord = path.join(root, 'triage.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t260-fabrica',
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

  /**
   * Everything the fake session of one node was told, as it received it.
   *
   * Whole, and not cut at the contract the way the software bundle's crossing
   * has to be: no document of THIS bundle carries a `{{input.…}}` token outside
   * a manifest body, so the "not one placeholder survives" claim can be made
   * over the entire text the session got.
   */
  const toldTo = (nodeId: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
      '\n',
    );

  // --- 1. `triage` dispatches at all, which is the whole of the repair -----
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterTriage = await jobNow();
  assert.equal(afterTriage.blocked, false, afterTriage.block_reason ?? '');
  assert.equal(afterTriage.current_node_id, 'collect-fundamentals');

  const triage = toldTo('triage');
  assert.ok(triage.includes(TITLE), 'the thesis title comes from `input.job.title`');
  assert.ok(triage.includes(BODY), 'and the hypothesis from `input.job.body`');
  assert.ok(triage.includes(ASSET), 'and the asset from the class field at the top level');
  assert.ok(
    triage.includes(JSON.stringify(PROJECT.triage_criteria)),
    "and the investor's criteria from `input.project`",
  );
  assert.ok(!triage.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 2. what `triage` triaged is what `collect-fundamentals` reads ---------
  currentLines = reports(COLLECTED);
  currentRecord = path.join(root, 'collect-fundamentals.json');
  assert.ok(await controller.tick());
  const afterCollect = await jobNow();
  assert.equal(afterCollect.blocked, false, afterCollect.block_reason ?? '');
  assert.equal(afterCollect.current_node_id, 'analyze-asymmetry');

  const collect = toldTo('collect-fundamentals');
  assert.ok(
    collect.includes(TRIAGED_THESIS.hypothesis),
    'the thesis the gate triaged is what `{{input.triaged_thesis.hypothesis}}` resolves to',
  );
  assert.ok(
    collect.includes(JSON.stringify(TRIAGED_THESIS.research_scope)),
    '...and the research scope it defined is what the researcher is pointed at',
  );
  assert.ok(!collect.includes('{{input.'));

  // --- 3. the projection carries the report at the TOP level ---------------
  // No node of this graph declares `contract.produces`, so every report merges
  // where the next node's manifest expects to find it.
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.deepEqual(input.triaged_thesis, TRIAGED_THESIS);
  assert.equal(input.asset, ASSET, 'the class field sits beside `input.job`, not inside it');
  assert.deepEqual(input.project, PROJECT);
});

/* -------------------------------------------------------------------------- */
/* t270 Half A — the shortest crossing of this bundle, end to end.             */
/*                                                                            */
/* `triage` has two ways out and `discard` is the cheap one: it goes          */
/* straight to `record-monitoring`, which is the only final node of the   */
/* graph and the one node that reads the traversal itself. Before this ficha   */
/* that node could not open a session at all — `registrar-travessia` named     */
/* `{{input.nos_executados}}` and `{{input.data_de_registro}}`, nothing        */
/* produced either, and `UnresolvedPlaceholderError` stopped the dispatch      */
/* before a worktree existed. The second real bets crossing was unblocked by a */
/* person patching both into the job's `fields` by hand                        */
/* (`notas/2026-08-17-second-bets-run.md`, gap 5).                       */
/*                                                                            */
/* So the claim here is the repair AND the absence of the workaround: no       */
/* `PATCH /v1/jobs/:id`, no `POST /v1/jobs/:id/unblocks`, anywhere in the      */
/* body of this test.                                                         */
/* -------------------------------------------------------------------------- */

/** The execution the short crossing's telemetry lands in. */
const DISCARD_EXECUTION_ID = 2701;

/** What the fake `triage` session hands back when the idea does not pass. */
const DISCARDED = {
  resultado: 'discard',
  outcome: 'fail',
  triaged_thesis: { ...TRIAGED_THESIS, research_scope: [] },
  evaluated_criteria: [
    {
      criterion: 'o downside está limitado por caixa líquido ou ativo real, não por narrativa',
      verdict: 'does_not_meet',
      evidence: 'O piso alegado é uma projeção de múltiplo, não um ativo contratado.',
    },
  ],
  rationale: 'Sem piso observável, a ideia não merece uma rodada de pesquisa.',
  note: 'Descartada no primeiro filtro; a travessia ainda produz métrica.',
};

/** ...and what `record-monitoring` reports — `record-crossing`'s `output`. */
const RECORDED = {
  process_metrics: {
    red_team_ran: false,
    sourced_assumptions_fraction: 0,
    human_decision_id: null,
    final_outcome: 'archived',
    nodes_executed: ['triage'],
  },
  record: {
    thesis_id: TRIAGED_THESIS.id,
    summary: 'A tese foi descartada na triage por não ter piso observável.',
    monitoring: [],
  },
  note: 'Travessia fechada pelo caminho mais curto do grafo.',
};

test('t270 — triage → record-monitoring closes the bets traversal on its own', async (t) => {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t270-fabrica-'));
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
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: DISCARD_EXECUTION_ID,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t270-fabrica', 'the one that closes the short bets crossing');

  /**
   * Every call the dispatch made, so the claim "no operator touched this" is
   * checked instead of merely intended.
   *
   * The two verbs that unstuck this crossing by hand are the two this records:
   * `PATCH /v1/jobs/:id` (the `fields` amendment that carried `nos_executados`)
   * and `POST /v1/jobs/:id/unblocks`.
   */
  const calls: string[] = [];
  const doFetch: typeof fetch = async (target, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(target).slice(baseUrl.length)}`);
    return await fetch(target, init);
  };

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(DISCARDED);
  let currentRecord = path.join(root, 'triage.json');
  const controller = new Controller({
    client,
    runnerId: 'runner-t270-fabrica',
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput`, and no executor environment either: this bundle needs
    // neither, and the production default is what the crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
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

  const toldTo = (nodeId: string): string =>
    (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
      '\n',
    );

  // --- 1. the gate discards, and the job lands on the final node -----------
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterTriage = await jobNow();
  assert.equal(afterTriage.blocked, false, afterTriage.block_reason ?? '');
  assert.equal(afterTriage.current_node_id, 'record-monitoring');

  // --- 2. ...and the final node OPENS, which is the whole of the repair -----
  currentLines = reports(RECORDED);
  currentRecord = path.join(root, 'record-monitoring.json');
  assert.ok(await controller.tick(), 'the final node was picked up too');

  const closed = await jobNow();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the traversal is over: the report of the final node landed');

  const told = toldTo('record-monitoring');
  assert.ok(
    told.includes(JSON.stringify(['triage'])),
    '`{{input.traversal.nodes_visited}}` resolves to the one node this crossing executed — ' +
      'and NOT to `record-monitoring`, which is where the job is standing',
  );
  assert.ok(!told.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 3. and the projection says the same thing over the API --------------
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  const traversal = input.traversal as Record<string, unknown>;
  assert.deepEqual(traversal.nodes_visited, ['triage']);
  assert.equal(
    typeof traversal.entered_at,
    'string',
    'the date the session registers is a slice of this instant, never a guess',
  );

  // --- 4. and nobody had to touch it by hand ------------------------------
  assert.deepEqual(
    calls.filter((call) => call.endsWith('/unblocks') || /^PATCH \/v1\/jobs\/\d+$/.test(call)),
    [],
    'the crossing that was unblocked by a `PATCH /jobs/1` needs neither verb now',
  );
});

/* -------------------------------------------------------------------------- */
/* t276 — the LONG way across, through the two gates nothing had ever crossed. */
/*                                                                            */
/* `triage` learned in t260 that the routing label rides INSIDE the one block */
/* a session prints (t161, t259), and that a closed `output` which does not    */
/* declare `resultado` therefore refuses the WHOLE report — `PATCH /finish`    */
/* stores `null` and, since t268, the runner blocks the work on its node       */
/* instead of routing it. `red-team-thesis` and `escalate-decision` were left      */
/* exactly as they were, and no test of this repository had ever opened either */
/* node: the crossing above stops at `collect-fundamentals`, and the one after   */
/* it takes the `discard` shortcut. Both gates were broken in the same way    */
/* and nothing could see it.                                                   */
/*                                                                            */
/* So this is the whole graph, node by node: `advance` → the red team the     */
/* thesis survives → the sizing → the human gate, which pauses for a person    */
/* and resumes with the answer → the final node. The two workaround verbs stay */
/* out of it, the same way t270 keeps them out — answering the allocation      */
/* question is the DESIGN of `decide` (D14: the human gate is mandatory,      */
/* always), not an operator unsticking a traversal by hand.                    */
/* -------------------------------------------------------------------------- */

/** The execution the long crossing's telemetry lands in. */
const LONG_EXECUTION_ID = 2760;

/** ...and the one the red team's kill lands in. */
const KILL_EXECUTION_ID = 2761;

/** What the fake `analyze-asymmetry` session hands back. */
const MEASURED = {
  asymmetry: {
    downside_max_pct: 18,
    upside_target_pct: 95,
    asymmetry_ratio: 5.3,
    scenarios: [
      {
        name: 'o pró-forma sai e o desconto de classificação some',
        probability: 0.6,
        return_pct: 95,
        key_assumptions: ['o contrato take-or-pay é honrado até 2032'],
      },
      {
        name: 'o embarcador renegocia o volume mínimo e o piso encolhe',
        probability: 0.4,
        return_pct: -18,
        key_assumptions: ['o contrato take-or-pay é honrado até 2032'],
      },
    ],
  },
  note: 'Piso vem do caixa líquido pró-forma, não da narrativa de reprecificação.',
};

/** ...and the fake `red-team` session, when the thesis answers the objection. */
const SURVIVED = {
  // Same protocol as `triage`: the label of the edge INSIDE the one block the
  // session prints. `red-team` has two ways out, `survives` and `dead`.
  resultado: 'survives',
  outcome: 'pass',
  objections: [
    {
      objection:
        'Com 71% da receita em um único embarcador, o take-or-pay vira risco de contraparte: se ele renegociar, o piso contratual não é piso.',
      severity: 'high',
      thesis_answer:
        'O contrato tem garantia bancária de 18 meses de receita — cláusula 11 do anexo contratual do formulário de referência 2026.',
    },
    {
      objection:
        'A data do gatilho é escolha do agente: nada obriga a reprecificação a acontecer no release do 1T27.',
      severity: 'low',
      thesis_answer: null,
    },
  ],
  researched_counter_evidence: [
    {
      claim_attacked: 'o contrato take-or-pay é honrado até 2032',
      source: 'arbitragem 0021xxx, noticiada em 2025-11-04',
      finding:
        'O mesmo embarcador arbitrou um take-or-pay com outro terminal em 2025 e obteve redução de 12% no volume mínimo.',
    },
  ],
  note: 'A objeção alta tem resposta documental; a baixa não move o piso.',
};

/** ...and the same session when the thesis has no answer to give. */
const KILLED = {
  resultado: 'dead',
  outcome: 'fail',
  objections: [
    {
      objection:
        'As duas vendas anteriores tiveram o caixa reinvestido fora do core em menos de três trimestres: o caixa líquido pode não chegar ao acionista.',
      severity: 'high',
      thesis_answer: null,
    },
  ],
  researched_counter_evidence: [
    {
      claim_attacked: 'o caixa líquido permanece no balanço até o release do 1T27',
      source: 'atas de assembleia de 2023 e 2024',
      finding: 'O padrão histórico da controladora contradiz a premissa, duas vezes seguidas.',
    },
  ],
  note: 'Objeção alta sem resposta: a tese morre aqui, que é a morte mais barata do grafo.',
};

/** ...and the fake `size-risk` session. */
const SIZED = {
  sizing: {
    position_size_pct: 1.2,
    max_accepted_loss_pct: 0.22,
    exit_trigger: 'saída integral se a renovação do contrato portuário não sair até o 3T27',
    horizon: '18 meses, até o release do 1T27',
    portfolio_correlation: 'baixa: nenhuma outra posição em terminal portuário',
  },
  note: 'Pediram 1,5%; a objeção alta sobrevivente puxou o tamanho para 1,2%.',
};

/** The allocation question the `decide` session ends its first turn with. */
const ALLOCATION_QUESTION = {
  question:
    'Alocar 1,2% do capital em NVLR3 a até R$ 18,00, com saída se o contrato portuário não for renovado até o 3T27?',
  context:
    'Piso no caixa líquido pró-forma de R$ 0,9 bi; assimetria de 5,3x; uma objeção alta respondida por garantia bancária de 18 meses e uma baixa sem resposta; uma premissa, com fonte primária.',
  options: ['Aprovar como proposto', 'Recusar'],
  recommendation: 'Aprove 1,2% do capital em NVLR3, com entrada limitada a R$ 18,00.',
  default: 'Aprovar como proposto',
};

/** ...and what the founder answers, which is the only thing that authorizes an edge. */
const FOUNDER_ANSWER =
  'Aprovado: alocar 1,2% do capital, entrada limitada a R$ 18,00, e saída integral se a renovação do contrato portuário não sair até o 3T27.';

/** The lines of a session that pauses for a person instead of deciding. */
const ASKS = JSON.stringify([
  { stream: 'stdout', text: 'Não há decisão registrada para esta tese, então eu pergunto:' },
  { stream: 'stdout', text: '```input-request' },
  { stream: 'stdout', text: JSON.stringify(ALLOCATION_QUESTION) },
  { stream: 'stdout', text: '```' },
]);

/** ...and what the session that RESUMES reports — a transcription, never a judgement. */
const transcribed = (questionId: string): Record<string, unknown> => ({
  resultado: 'approved',
  outcome: 'pass',
  human_decision: { question_id: questionId, literal_answer: FOUNDER_ANSWER },
  note: 'O tamanho que vale é o da resposta (1,2%), e ele coincide com o proposto.',
});

/** One crossing of the real bundle, driven node by node with the fake engine. */
interface Crossing {
  /** The control plane this crossing booted, for the calls the TEST makes. */
  baseUrl: string;
  token: string;
  /** Dispatches whatever node the job is standing on, with the lines it prints. */
  run: (nodeId: string, lines: string) => Promise<void>;
  /** The job as the control plane sees it right now. */
  job: () => Promise<Work>;
  /** Everything the fake session of one node was told, as it received it. */
  toldTo: (nodeId: string) => string;
  /** The `input` the projection publishes for where the job is standing. */
  context: () => Promise<Record<string, unknown>>;
  /** Every call the DISPATCH made — never the ones this test makes itself. */
  calls: string[];
}

/**
 * Boots a control plane, registers the real bundle and opens a thesis on it.
 *
 * The same wiring the two crossings above do inline, in one place because these
 * two walk six and four nodes: what the file already proves is that the
 * production defaults carry a bets job, and repeating fifty lines of setup twice
 * more would bury the only thing that differs — what each session says.
 */
async function startCrossing(
  t: TestContext,
  executionId: number,
  runnerId: string,
): Promise<Crossing> {
  const { url: baseUrl, token } = await bootCore(t);

  const root = mkdtempSync(path.join(tmpdir(), 'cartografo-t276-fabrica-'));
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
      title: TITLE,
      body: BODY,
      entry_node_id: 'triage',
      execution_id: executionId,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        intended_size: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner(runnerId, 'the one that crosses the whole bets bundle');

  const calls: string[] = [];
  const doFetch: typeof fetch = async (target, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(target).slice(baseUrl.length)}`);
    return await fetch(target, init);
  };

  const worktrees = directoryWorktrees(root);
  let currentLines = '[]';
  let currentRecord = path.join(root, 'unused.json');
  const controller = new Controller({
    client,
    runnerId,
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    // No `resolveInput` and no executor environment: this bundle needs neither,
    // and the production default is what the crossing proves.
    dispatch: async (jobId) =>
      createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
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

  return {
    baseUrl,
    token,
    calls,
    run: async (nodeId, lines) => {
      currentLines = lines;
      currentRecord = path.join(root, `${nodeId}.json`);
      assert.ok(await controller.tick(), `"${nodeId}" was not picked up by the runner`);
    },
    job: async () => await api<Work>(baseUrl, token, 'GET', `/v1/jobs/${job.id}`),
    toldTo: (nodeId) =>
      (JSON.parse(readFileSync(path.join(root, `${nodeId}.json`), 'utf8')) as FakeRecord).argv.join(
        '\n',
      ),
    context: async () => {
      const { input } = await api<{ input: Record<string, unknown> }>(
        baseUrl,
        token,
        'GET',
        `/v1/jobs/${job.id}/context`,
      );
      return input;
    },
  };
}

test('t276 — the thesis crosses red-team and the human gate, all seven nodes', async (t) => {
  const crossing = await startCrossing(t, LONG_EXECUTION_ID, 'runner-t276-long');
  const { baseUrl, token } = crossing;

  // --- 1. the three nodes the file already covers, in one breath ------------
  await crossing.run('triage', reports(TRIAGED));
  await crossing.run('collect-fundamentals', reports(COLLECTED));
  await crossing.run('analyze-asymmetry', reports(MEASURED));
  assert.equal((await crossing.job()).current_node_id, 'red-team');

  // --- 2. the red team routes on its own, which no test had ever asked -----
  await crossing.run('red-team', reports(SURVIVED));
  const afterRedTeam = await crossing.job();
  assert.equal(
    afterRedTeam.blocked,
    false,
    `the red team's report was refused: ${afterRedTeam.block_reason ?? ''}`,
  );
  assert.equal(afterRedTeam.current_node_id, 'size-risk');
  assert.deepEqual(
    (await crossing.context()).objections,
    SURVIVED.objections,
    'the objections survived the schema whole — a refused report would be `null` here',
  );

  const redTeam = crossing.toldTo('red-team');
  assert.ok(redTeam.includes(TRIAGED_THESIS.hypothesis), 'the red team is pointed at the real thesis');
  assert.ok(!redTeam.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 3. the sizing feeds the dossier the human gate reads ----------------
  await crossing.run('size-risk', reports(SIZED));
  assert.equal((await crossing.job()).current_node_id, 'decide');

  // --- 4. `decide` pauses for a person instead of deciding ----------------
  await crossing.run('decide', ASKS);
  const asked = await crossing.job();
  assert.equal(asked.current_node_id, 'decide', 'a session that asked cannot also have routed');
  assert.equal(asked.blocked, true, 'the mandatory human gate stops the traversal (D14)');

  const firstTurn = crossing.toldTo('decide');
  assert.ok(
    firstTurn.includes(String(SIZED.sizing.position_size_pct)),
    'the proposed size reaches the gate from `{{input.sizing.position_size_pct}}`',
  );
  assert.ok(firstTurn.includes('[]'), 'and the question queue arrives empty, which is legal');
  assert.ok(!firstTurn.includes('{{input.'));

  const { input_requests: pending } = await api<{ input_requests: { id: number }[] }>(
    baseUrl,
    token,
    'GET',
    '/v1/input-requests?status=pending',
  );
  assert.equal(pending.length, 1, 'exactly one allocation question is waiting on the founder');

  await api(baseUrl, token, 'PATCH', `/v1/input-requests/${pending[0].id}/answer`, {
    answer: FOUNDER_ANSWER,
    answered_by: 'rafael',
  });
  assert.equal((await crossing.job()).blocked, false, 'answering unblocked it');

  // --- 5. ...and the answer is what authorizes the edge --------------------
  const questionId = String(pending[0].id);
  await crossing.run('decide', reports(transcribed(questionId)));
  const decided = await crossing.job();
  assert.equal(
    decided.blocked,
    false,
    `the decision's report was refused: ${decided.block_reason ?? ''}`,
  );
  assert.equal(decided.current_node_id, 'record-monitoring');

  const secondTurn = crossing.toldTo('decide');
  assert.ok(
    secondTurn.includes(FOUNDER_ANSWER),
    'the resumed session reads the founder’s words through `{{input.perguntas_respondidas}}`',
  );

  const beforeTheFinalNode = await crossing.context();
  assert.deepEqual(beforeTheFinalNode.human_decision, transcribed(questionId).human_decision);
  assert.deepEqual(beforeTheFinalNode.sizing, SIZED.sizing);

  // --- 6. the final node runs, and the traversal is over -------------------
  const executed = [
    'triage',
    'collect-fundamentals',
    'analyze-asymmetry',
    'red-team',
    'size-risk',
    'decide',
  ];
  await crossing.run(
    'record-monitoring',
    reports({
      process_metrics: {
        red_team_ran: true,
        sourced_assumptions_fraction: 1,
        human_decision_id: questionId,
        final_outcome: 'monitoring',
        unanswered_high_objections: 0,
        nodes_executed: executed,
      },
      record: {
        thesis_id: TRIAGED_THESIS.id,
        summary:
          'Tese triada, pesquisada, medida, atacada pelo red team, dimensionada em 1,2% e aprovada pelo fundador.',
        monitoring: [
          { trigger: 'renovação do contrato portuário', deadline: '3T27' },
          { trigger: 'release pró-forma do 1T27', deadline: '1T27' },
        ],
      },
      note: 'Travessia longa fechada: os sete nós do grafo rodaram.',
    }),
  );

  const closed = await crossing.job();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the traversal is over: the final node reported');

  const finalPrompt = crossing.toldTo('record-monitoring');
  assert.ok(
    finalPrompt.includes(JSON.stringify(executed)),
    '`{{input.traversal.nodes_visited}}` names the six nodes this crossing executed',
  );
  assert.ok(!finalPrompt.includes('{{input.'));

  // --- 7. and the only human in it answered a question, by design ---------
  assert.deepEqual(
    crossing.calls.filter((call) => call.endsWith('/unblocks') || /^PATCH \/v1\/jobs\/\d+$/.test(call)),
    [],
    'no `PATCH /jobs/:id` and no unblock: the gate paused by design and resumed on an answer',
  );
});

test('t276 — the red team kills the thesis, and the `dead` edge closes the traversal', async (t) => {
  const crossing = await startCrossing(t, KILL_EXECUTION_ID, 'runner-t276-kill');

  await crossing.run('triage', reports(TRIAGED));
  await crossing.run('collect-fundamentals', reports(COLLECTED));
  await crossing.run('analyze-asymmetry', reports(MEASURED));

  await crossing.run('red-team', reports(KILLED));
  const killed = await crossing.job();
  assert.equal(
    killed.blocked,
    false,
    `the kill report was refused: ${killed.block_reason ?? ''}`,
  );
  assert.equal(
    killed.current_node_id,
    'record-monitoring',
    'an unanswered high objection takes the "dead" edge straight to the register',
  );
  assert.deepEqual(
    (await crossing.context()).objections,
    KILLED.objections,
    'and the objections that killed it are what the register gets to read',
  );

  await crossing.run(
    'record-monitoring',
    reports({
      process_metrics: {
        red_team_ran: true,
        sourced_assumptions_fraction: 1,
        human_decision_id: null,
        final_outcome: 'archived',
        unanswered_high_objections: 1,
        nodes_executed: ['triage', 'collect-fundamentals', 'analyze-asymmetry', 'red-team'],
      },
      record: {
        thesis_id: TRIAGED_THESIS.id,
        summary: 'A tese morreu no red team: o caixa líquido não tem histórico de chegar ao acionista.',
        monitoring: [],
      },
      note: 'Travessia fechada sem chegar ao portão humano — desfecho arquivado.',
    }),
  );

  const closed = await crossing.job();
  assert.equal(closed.blocked, false, closed.block_reason ?? '');
  assert.equal(closed.completed, true, 'the death path ends on the same final node as every other');
});
