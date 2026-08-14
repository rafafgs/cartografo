/**
 * Proposal route acceptance tests (t101, FR7/FR8/FR9).
 *
 * This is where the whole D15 cycle is proven — apply ops → validate soundness
 * on the result → write the new version → move the pointer, and rollback moving
 * the pointer back without erasing anything. The four rejection cases (AT14–AT17)
 * reproduce, through semantic operations, exactly the four counterexamples of
 * t96: the soundness gate has to reject the proposal BEFORE the new version
 * exists.
 *
 * The JSON field names stay in Portuguese: they mirror the untouched migration
 * columns (t127, FR8). Only the route paths and the code identifiers are in
 * English.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ConnectionModule from '../src/db/connection.ts';
import type { GraphDocument, GraphNode } from '../src/domain/graph.ts';
import type * as HashModule from '../src/domain/hash.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as OperationsModule from '../src/domain/operations.ts';
import type * as ServerModule from '../src/server.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'migrations');
const MINIMAL_EXAMPLE = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface GraphRow {
  id: string;
  classe: string;
  versao_corrente_id: string | null;
}

interface VersionRow {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

interface ProposalRow {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: unknown[];
  evidencia: unknown;
  metrica_esperada: unknown;
  status: string;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  resultado: unknown;
}

interface ApplyResponse {
  erro?: string;
  proposta: ProposalRow;
  grafo?: GraphRow;
  grafo_versao?: VersionRow;
  soundness?: { valido: boolean; violacoes: Array<{ regra: string; alvo: unknown }> };
  estrutura?: { valido: boolean; erros: Array<{ codigo: string; alvo: unknown }> };
}

let connectionCache: typeof ConnectionModule | null = null;
let migrateCache: typeof MigrateModule | null = null;
let serverCache: typeof ServerModule | null = null;
let hashCache: typeof HashModule | null = null;
let operationsCache: typeof OperationsModule | null = null;

async function loadConnection(): Promise<typeof ConnectionModule> {
  connectionCache ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ConnectionModule;
  return connectionCache;
}

async function loadMigrate(): Promise<typeof MigrateModule> {
  migrateCache ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof MigrateModule;
  return migrateCache;
}

async function loadServer(): Promise<typeof ServerModule> {
  serverCache ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ServerModule;
  return serverCache;
}

async function loadHash(): Promise<typeof HashModule> {
  hashCache ??= (await import(
    new URL('../src/domain/hash.ts', import.meta.url).href
  )) as typeof HashModule;
  return hashCache;
}

async function loadOperations(): Promise<typeof OperationsModule> {
  operationsCache ??= (await import(
    new URL('../src/domain/operations.ts', import.meta.url).href
  )) as typeof OperationsModule;
  return operationsCache;
}

async function startApp(t: TestHook): Promise<string> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'routes', 'proposals.ts')),
    'artifact does not exist yet: packages/core/src/routes/proposals.ts',
  );
  assert.ok(
    existsSync(path.join(MIGRATIONS_DIR, '0002_grafo_versao_proposta.sql')),
    'artifact does not exist yet: packages/core/migrations/0002_grafo_versao_proposta.sql',
  );

  const { openDatabase, applyPragmas } = await loadConnection();
  const { migrate } = await loadMigrate();
  const { createApp } = await loadServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t101-'));
  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);

  const app = createApp({ db });
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return address;
}

async function post(address: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${address}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function jsonBody<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function minimalGraph(): GraphDocument {
  return JSON.parse(readFileSync(MINIMAL_EXAMPLE, 'utf8')) as GraphDocument;
}

function requireNode(doc: GraphDocument, id: string): GraphNode {
  const node = doc.nos.find((candidate) => candidate.id === id);
  if (node === undefined) throw new Error(`the fixture changed: node "${id}" is gone`);
  return node;
}

/** Registers the minimal base graph and returns the freshly created lineage. */
async function registerBase(
  address: string,
): Promise<{ document: GraphDocument; graph: GraphRow; version: VersionRow }> {
  const document = minimalGraph();
  const response = await post(address, '/v1/graphs', document);
  const body = await jsonBody<{ grafo: GraphRow; grafo_versao: VersionRow }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return { document, graph: body.grafo, version: body.grafo_versao };
}

async function getGraph(address: string, id: string): Promise<GraphRow> {
  const response = await fetch(`${address}/v1/graphs/${id}`);
  assert.equal(response.status, 200);
  return (await jsonBody<{ grafo: GraphRow }>(response)).grafo;
}

const EVIDENCE = {
  fonte: 'telemetria',
  observacao: 'duas travessias com retrabalho depois da revisão',
};
const EXPECTED_METRIC = { nome: 'retrabalho_por_travessia', direcao: 'cai', de: 0.4, para: 0.1 };

async function createProposal(
  address: string,
  graphId: string,
  targetVersion: string,
  operations: OperationsModule.Operation[],
): Promise<ProposalRow> {
  const response = await post(address, '/v1/proposals', {
    grafo_id: graphId,
    versao_alvo: targetVersion,
    operacoes: operations,
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  const body = await jsonBody<{ proposta: ProposalRow }>(response);
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.proposta;
}

/** A new node, complete enough to pass `no_com_contrato`. */
function newNode(): GraphNode {
  return {
    id: 'checar_fatos',
    papel: 'revisor',
    tipo_no: 'trabalho',
    descricao: 'Confere cada afirmação da nota contra a fonte citada.',
    skill_ref: {
      id: 'cartografo/checar-fatos',
      versao: '1.0.0',
      hash: `sha256:${'0'.repeat(64)}`,
    },
    contrato: {
      entrada_schema: {
        type: 'object',
        required: ['texto'],
        properties: { texto: { type: 'string', minLength: 1 } },
      },
      saida_schema: {
        type: 'object',
        required: ['aprovado'],
        properties: { aprovado: { type: 'boolean' } },
      },
      verificacoes: [
        {
          tipo: 'deterministico',
          comando: 'test -s checagem.md',
          descricao: 'O relatório de checagem existe e não está vazio.',
        },
      ],
    },
  };
}

/**
 * Inserts `checar_fatos` BETWEEN redigir and revisar: one incoming edge (so it is
 * reachable) and one outgoing edge (so it terminates). Those are the two
 * conditions soundness demands of any new node — hence the two edges.
 */
function passingOperations(): OperationsModule.Operation[] {
  const node = newNode();
  return [
    {
      tipo: 'adicionar_no',
      no: node,
      inversa: { tipo: 'remover_no', no_id: node.id },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'redigir', para: node.id, condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: node.id } },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: node.id, para: 'revisar', condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: node.id, para: 'revisar' } },
    },
  ];
}

test('AT11 — applying a proposal creates a new version with the right parent and hash, and moves the pointer', async (t) => {
  const address = await startApp(t);
  const { hashSnapshot } = await loadHash();
  const { applyOperations } = await loadOperations();

  const { document, graph, version } = await registerBase(address);
  const operations = passingOperations();
  const proposal = await createProposal(address, graph.id, version.id, operations);
  assert.equal(proposal.status, 'pendente', 'every proposal is born pending');

  const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  const body = await jsonBody<ApplyResponse>(response);
  assert.equal(response.status, 200, JSON.stringify(body));

  const expected = hashSnapshot(applyOperations(document, operations));
  assert.ok(body.grafo_versao !== undefined);
  assert.equal(body.grafo_versao.id, expected, 'the version id is the hash of the resulting document');
  assert.equal(body.grafo_versao.versao_pai, version.id, 'the new version points at the previous one');
  assert.equal(body.grafo_versao.origem, 'proposta');
  assert.equal(body.grafo_versao.proposta_id, proposal.id);

  assert.equal(body.proposta.status, 'aplicada');
  assert.equal(body.proposta.versao_aplicada_id, expected);

  const after = await getGraph(address, graph.id);
  assert.equal(after.versao_corrente_id, expected, 'the pointer has to have moved');

  // The new snapshot is the document with the operations applied — not a diff.
  const newVersion = await fetch(`${address}/v1/graph-versions/${encodeURIComponent(expected)}`);
  const versionBody = await jsonBody<{ grafo_versao: { snapshot: GraphDocument } }>(newVersion);
  assert.deepEqual(versionBody.grafo_versao.snapshot, applyOperations(document, operations));
});

test('AT12 — reverting restores the pointer and the history stays whole', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const application = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(application.status, 200);
  const newVersion = (await jsonBody<ApplyResponse>(application)).grafo_versao;
  assert.ok(newVersion !== undefined);

  const reversion = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    motivo: 'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  });
  const body = await jsonBody<ApplyResponse>(reversion);
  assert.equal(reversion.status, 200, JSON.stringify(body));
  assert.equal(body.proposta.status, 'revertida');
  assert.equal(
    body.proposta.motivo_reversao,
    'o nó novo dobrou o tempo de travessia sem mexer no retrabalho',
  );

  const after = await getGraph(address, graph.id);
  assert.equal(after.versao_corrente_id, version.id, 'the pointer goes back to the target version');

  const versions = await jsonBody<{ versoes: VersionRow[] }>(
    await fetch(`${address}/v1/graphs/${graph.id}/versions`),
  );
  assert.deepEqual(
    versions.versoes.map((row) => row.id).sort(),
    [version.id, newVersion.id].sort(),
    'append-only: the abandoned version stays in the history',
  );

  // And it stays recoverable in full, not merely listed.
  const abandoned = await fetch(`${address}/v1/graph-versions/${encodeURIComponent(newVersion.id)}`);
  assert.equal(abandoned.status, 200);
});

test('AT13 — reverting without a reason returns 400; reverting a pending proposal returns 409', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  const withoutReason = await post(address, `/v1/proposals/${proposal.id}/revert`, {});
  assert.equal(withoutReason.status, 400);
  assert.equal((await jsonBody<{ erro: string }>(withoutReason)).erro, 'motivo_obrigatorio');

  const blankReason = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    motivo: '   ',
  });
  assert.equal(blankReason.status, 400, 'a blank reason is not evidence');

  const pending = await post(address, `/v1/proposals/${proposal.id}/revert`, {
    motivo: 'mudei de ideia',
  });
  assert.equal(pending.status, 409);
  assert.equal((await jsonBody<{ erro: string }>(pending)).erro, 'proposta_nao_aplicada');

  const graphAfter = await getGraph(address, graph.id);
  assert.equal(graphAfter.versao_corrente_id, version.id);
});

/**
 * AT14–AT17: one case per soundness rule, each reproducing through semantic
 * operations the counterexample of the same name in `schema/exemplos/` (t96).
 */
const REJECTION_CASES: Array<{
  at: string;
  counterexample: string;
  violations: Array<{ regra: string; alvo: unknown }>;
  operations: (document: GraphDocument) => OperationsModule.Operation[];
}> = [
  {
    at: 'AT14',
    counterexample: 'grafo-invalido-no-inalcancavel.json',
    violations: [{ regra: 'alcançável', alvo: 'checar_fatos' }],
    operations: () => {
      const node = newNode();
      // Only the OUTGOING edge: the node terminates, but nobody reaches it.
      return [
        { tipo: 'adicionar_no', no: node, inversa: { tipo: 'remover_no', no_id: node.id } },
        {
          tipo: 'adicionar_aresta',
          aresta: { de: node.id, para: 'revisar', condicao: 'sempre' },
          inversa: { tipo: 'remover_aresta', aresta: { de: node.id, para: 'revisar' } },
        },
      ];
    },
  },
  {
    at: 'AT15',
    counterexample: 'grafo-invalido-sem-terminacao.json',
    violations: [{ regra: 'termina', alvo: 'checar_fatos' }],
    operations: () => {
      const node = newNode();
      // Only the INCOMING edge: the node is reached, but there is no way out.
      return [
        { tipo: 'adicionar_no', no: node, inversa: { tipo: 'remover_no', no_id: node.id } },
        {
          tipo: 'adicionar_aresta',
          aresta: { de: 'redigir', para: node.id, condicao: 'sempre' },
          inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: node.id } },
        },
      ];
    },
  },
  {
    at: 'AT16',
    counterexample: 'grafo-invalido-aresta-sem-condicao.json',
    violations: [{ regra: 'aresta_com_condicao', alvo: { de: 'revisar', para: 'redigir' } }],
    // A legitimate rework cycle, but with no label on the transition.
    operations: () => [
      {
        tipo: 'adicionar_aresta',
        aresta: { de: 'revisar', para: 'redigir', condicao: '' },
        inversa: { tipo: 'remover_aresta', aresta: { de: 'revisar', para: 'redigir' } },
      },
    ],
  },
  {
    at: 'AT17',
    counterexample: 'grafo-invalido-no-sem-contrato.json',
    violations: [{ regra: 'no_com_contrato', alvo: 'revisar' }],
    // An emptied contract: with no checks, the gate verifies nothing.
    operations: (document) => [
      {
        tipo: 'alterar_campo_no',
        no_id: 'revisar',
        campo: 'contrato',
        de: structuredClone(requireNode(document, 'revisar').contrato),
        para: {},
        inversa: {
          tipo: 'alterar_campo_no',
          no_id: 'revisar',
          campo: 'contrato',
          de: {},
          para: structuredClone(requireNode(document, 'revisar').contrato),
        },
      },
    ],
  },
];

for (const rejectionCase of REJECTION_CASES) {
  test(`${rejectionCase.at} — a proposal reproducing ${rejectionCase.counterexample} is rejected with 422`, async (t) => {
    const address = await startApp(t);

    const { document, graph, version } = await registerBase(address);
    const proposal = await createProposal(
      address,
      graph.id,
      version.id,
      rejectionCase.operations(document),
    );

    const response = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
    const body = await jsonBody<ApplyResponse>(response);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.equal(body.erro, 'grafo_invalido');
    assert.deepEqual(body.soundness?.violacoes, rejectionCase.violations);
    assert.equal(body.proposta.status, 'rejeitada');
    assert.deepEqual(
      (body.proposta.resultado as { soundness?: { violacoes: unknown } } | null)?.soundness
        ?.violacoes,
      rejectionCase.violations,
      'the report stays recorded in proposta.resultado',
    );

    const after = await getGraph(address, graph.id);
    assert.equal(after.versao_corrente_id, version.id, 'the pointer must not have moved');

    const versions = await jsonBody<{ versoes: VersionRow[] }>(
      await fetch(`${address}/v1/graphs/${graph.id}/versions`),
    );
    assert.equal(versions.versoes.length, 1, 'no new version can have been written');
  });
}

test('AT18 — a proposal whose target version stopped being the current one returns 409', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const first = await createProposal(address, graph.id, version.id, passingOperations());
  const second = await createProposal(address, graph.id, version.id, [
    {
      tipo: 'alterar_campo_no',
      no_id: 'redigir',
      campo: 'papel',
      de: 'redator',
      para: 'red-team',
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'redigir',
        campo: 'papel',
        de: 'red-team',
        para: 'redator',
      },
    },
  ]);

  assert.equal((await post(address, `/v1/proposals/${first.id}/apply`, {})).status, 200);

  const outdated = await post(address, `/v1/proposals/${second.id}/apply`, {});
  assert.equal(outdated.status, 409);
  assert.equal(
    (await jsonBody<{ erro: string }>(outdated)).erro,
    'proposta_desatualizada',
    'the base moved under the proposal; solving that belongs to the topographer (t118)',
  );
});

test('AT19 — applying the same proposal twice returns 409 on the second', async (t) => {
  const address = await startApp(t);

  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  assert.equal((await post(address, `/v1/proposals/${proposal.id}/apply`, {})).status, 200);

  const second = await post(address, `/v1/proposals/${proposal.id}/apply`, {});
  assert.equal(second.status, 409);
  assert.equal((await jsonBody<{ erro: string }>(second)).erro, 'proposta_nao_pendente');
});

test('FR7 — a target version foreign to the graph and a malformed operation return 400', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);

  const missingTarget = await post(address, '/v1/proposals', {
    grafo_id: graph.id,
    versao_alvo: `sha256:${'1'.repeat(64)}`,
    operacoes: passingOperations(),
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(missingTarget.status, 400);
  assert.equal((await jsonBody<{ erro: string }>(missingTarget)).erro, 'versao_alvo_desconhecida');

  const withoutInverse = await post(address, '/v1/proposals', {
    grafo_id: graph.id,
    versao_alvo: version.id,
    operacoes: [{ tipo: 'adicionar_no', no: newNode() }],
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(withoutInverse.status, 400);
  assert.equal((await jsonBody<{ erro: string }>(withoutInverse)).erro, 'operacoes_invalidas');

  const unknownType = await post(address, '/v1/proposals', {
    grafo_id: graph.id,
    versao_alvo: version.id,
    operacoes: [{ tipo: 'renomear_no', no_id: 'redigir', inversa: { tipo: 'renomear_no' } }],
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(unknownType.status, 400);

  const unknownGraph = await post(address, '/v1/proposals', {
    grafo_id: 'nao-existe',
    versao_alvo: version.id,
    operacoes: passingOperations(),
    evidencia: EVIDENCE,
    metrica_esperada: EXPECTED_METRIC,
  });
  assert.equal(unknownGraph.status, 400);

  assert.equal((await post(address, '/v1/proposals/999/apply', {})).status, 404);
  assert.equal((await post(address, '/v1/proposals/999/revert', { motivo: 'x' })).status, 404);
});

test('t127 — the old Portuguese proposal paths no longer exist', async (t) => {
  const address = await startApp(t);
  const { graph, version } = await registerBase(address);
  const proposal = await createProposal(address, graph.id, version.id, passingOperations());

  assert.equal(
    (
      await post(address, '/v1/propostas', {
        grafo_id: graph.id,
        versao_alvo: version.id,
        operacoes: passingOperations(),
        evidencia: EVIDENCE,
        metrica_esperada: EXPECTED_METRIC,
      })
    ).status,
    404,
  );
  assert.equal((await post(address, `/v1/propostas/${proposal.id}/aplicar`, {})).status, 404);
  assert.equal(
    (await post(address, `/v1/proposals/${proposal.id}/reverter`, { motivo: 'x' })).status,
    404,
  );
});
