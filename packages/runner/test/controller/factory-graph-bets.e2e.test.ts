/**
 * The asymmetric-bets factory bundle, crossed LIVE (t260).
 *
 * `grafos-de-fabrica/bets-assimetricas` has been contract-proven since t116 —
 * the graph is sound, every one of the seven manifests validates, every pin
 * closes, and `tests/factory-graph-2.test.mjs`'s AT11 walks a real thesis from
 * `triagem` to `decisao` payload by payload. None of that ever opened a session.
 *
 * t259 found and fixed the same class of bug one bundle over: the manifests
 * named an input vocabulary nobody assembles. The bets bundle was left alone on
 * the premise that its nodes already agree at the top level, which is true from
 * `coleta-fundamentos` onward — every later manifest reads
 * `{{input.tese_triada.*}}`, and `triagem`'s report merges at the top level
 * because no node of this graph declares `contract.produces`. It was false for
 * the entry node itself: `triar-tese` read `{{input.tese.titulo}}`,
 * `{{input.tese.ativo}}`, `{{input.tese.hipotese}}` and
 * `{{input.criterios_de_triagem}}`, and the projection
 * (`packages/core/src/domain/context.ts`) publishes none of them — `input.job`
 * carries the work's identity, `input.project` the class's static config, and a
 * class field is a flat scalar at the top level. So the first node of this graph
 * could not dispatch at all: `UnresolvedPlaceholderError` before a session ever
 * existed.
 *
 * What this test asserts is the repair, with nothing faked but the engine:
 * `triagem` → `coleta-fundamentos` crosses on its own, the entry prompt carries
 * the job's own title and body, the asset the class field declares and the
 * criteria the graph's `project` publishes, and the thesis the gate triaged
 * reaches the researcher's prompt where `{{input.tese_triada.*}}` used to be.
 *
 * English per D18; node ids, edge labels and the bundle's own keys stay in
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
const BUNDLE = path.join(REPO_ROOT, 'grafos-de-fabrica', 'bets-assimetricas');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** The execution this crossing's telemetry lands in. */
const EXECUTION_ID = 2601;

/** The seven manifests the graph's nodes pin, in document order. */
const MANIFESTS = Object.freeze([
  'triar-tese.json',
  'coletar-fundamentos.json',
  'analisar-assimetria.json',
  'derrubar-tese.json',
  'dimensionar-risco.json',
  'escalar-decisao.json',
  'registrar-travessia.json',
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

/** The asset, which is a class field of this graph and not part of the job. */
const ASSET = 'NVLR3';

/** ...and where the central premise came from, the field `triagem` demands. */
const PREMISE_SOURCE = 'fato relevante de 2026-07-30, arquivado no regulador';

/** ...and how big a position is being asked for, the third field it demands (t263). */
const INTENDED_SIZE = 1.5;

const TITLE = 'Navelar Logística (NVLR3) — reprecificação depois da venda do braço rodoviário';
const BODY =
  'O mercado ainda precifica a Navelar como transportadora rodoviária de margem baixa. ' +
  'Vendido o braço rodoviário, sobra uma operação portuária com contrato de longo prazo e ' +
  'caixa líquido; o desconto tende a sumir quando o primeiro trimestre pró-forma for reportado.';

/** What the fake `triagem` session hands back — `triar-tese`'s `output`. */
const TESE_TRIADA = {
  id: 'tese-1',
  titulo: TITLE,
  ativo: ASSET,
  hipotese: BODY,
  escopo_de_pesquisa: [
    'termos da venda do braço rodoviário: preço, forma de pagamento e passivos que ficam',
    'contrato portuário: prazo, cláusula de reajuste e concentração de cliente',
    'caixa e dívida pró-forma depois da venda',
  ],
};
const TRIADO = {
  // The routing label rides INSIDE the report, which is the one block a session
  // prints (t259) — `triagem` has two ways out, `aprofundar` and `descartar`.
  resultado: 'aprofundar',
  outcome: 'pass',
  tese_triada: TESE_TRIADA,
  criterios_avaliados: [
    {
      criterio: 'o downside está limitado por caixa líquido ou ativo real, não por narrativa',
      veredito: 'atende',
      evidencia: 'A venda está fixada em R$ 1,2 bi à vista contra valor de mercado de R$ 2,1 bi.',
    },
  ],
  justificativa: 'A ideia tem piso contratado e evento datado: merece uma rodada de pesquisa.',
  nota: 'Escopo restrito a três frentes para a coleta não virar leitura infinita.',
};

/** ...and the fake `coleta-fundamentos` session — `coletar-fundamentos`'s. */
const COLETADO = {
  fundamentos: {
    resumo: 'Sobra um terminal portuário com contrato take-or-pay até 2032 e caixa líquido.',
    numeros: [
      {
        metrica: 'caixa líquido pró-forma',
        valor: 'R$ 0,9 bi',
        periodo: 'pró-forma 2T26',
        fonte: 'release do 2T26, nota 14',
      },
    ],
    riscos_conhecidos: ['concentração de 71% da receita em um único embarcador'],
  },
  premissas: [
    {
      premissa: 'o contrato take-or-pay é honrado até 2032',
      fonte: 'anexo contratual do formulário de referência 2026',
      confianca: 'alta',
    },
  ],
  lacunas: ['não há documento público com o preço por tonelada do contrato'],
  nota: 'Uma premissa com fonte primária; a lacuna de preço fica registrada.',
};

test('t260 — triagem → coleta-fundamentos crosses the real bets bundle', async (t) => {
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
  // and `tamanho_pretendido` are all demanded at `triagem`, and the projection
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
      entry_node_id: 'triagem',
      execution_id: EXECUTION_ID,
      graph_version_id: version.id,
      fields: {
        asset: ASSET,
        premise_source: PREMISE_SOURCE,
        tamanho_pretendido: INTENDED_SIZE,
      },
    },
    201,
  );

  const client = new ClienteControle({ urlBase: baseUrl, token });
  await client.registrarRunner('runner-t260-fabrica', 'o que atravessa o bundle de bets');

  const worktrees = directoryWorktrees(root);
  let currentLines = reports(TRIADO);
  // One sidecar per node: the rendered instructions travel on the ARGV, not in
  // the session's `prompt` column (`session-spec.ts`). What the model was TOLD
  // is the argv.
  let currentRecord = path.join(root, 'triagem.json');
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

  // --- 1. `triagem` dispatches at all, which is the whole of the repair -----
  assert.ok(await controller.tick(), 'the entry node was picked up');
  const afterTriagem = await jobNow();
  assert.equal(afterTriagem.blocked, false, afterTriagem.block_reason ?? '');
  assert.equal(afterTriagem.current_node_id, 'coleta-fundamentos');

  const triagem = toldTo('triagem');
  assert.ok(triagem.includes(TITLE), 'the thesis title comes from `input.job.title`');
  assert.ok(triagem.includes(BODY), 'and the hypothesis from `input.job.body`');
  assert.ok(triagem.includes(ASSET), 'and the asset from the class field at the top level');
  assert.ok(
    triagem.includes(JSON.stringify(PROJECT.criterios_de_triagem)),
    "and the investor's criteria from `input.project`",
  );
  assert.ok(!triagem.includes('{{input.'), 'not one placeholder may survive into a prompt');

  // --- 2. what `triagem` triaged is what `coleta-fundamentos` reads ---------
  currentLines = reports(COLETADO);
  currentRecord = path.join(root, 'coleta-fundamentos.json');
  assert.ok(await controller.tick());
  const afterColeta = await jobNow();
  assert.equal(afterColeta.blocked, false, afterColeta.block_reason ?? '');
  assert.equal(afterColeta.current_node_id, 'analise-assimetria');

  const coleta = toldTo('coleta-fundamentos');
  assert.ok(
    coleta.includes(TESE_TRIADA.hipotese),
    'the thesis the gate triaged is what `{{input.tese_triada.hipotese}}` resolves to',
  );
  assert.ok(
    coleta.includes(JSON.stringify(TESE_TRIADA.escopo_de_pesquisa)),
    '...and the research scope it defined is what the researcher is pointed at',
  );
  assert.ok(!coleta.includes('{{input.'));

  // --- 3. the projection carries the report at the TOP level ---------------
  // No node of this graph declares `contract.produces`, so every report merges
  // where the next node's manifest expects to find it.
  const { input } = await api<{ input: Record<string, unknown> }>(
    baseUrl,
    token,
    'GET',
    `/v1/jobs/${job.id}/context`,
  );
  assert.deepEqual(input.tese_triada, TESE_TRIADA);
  assert.equal(input.asset, ASSET, 'the class field sits beside `input.job`, not inside it');
  assert.deepEqual(input.project, PROJECT);
});
