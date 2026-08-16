/**
 * Acceptance tests of the graph validator ported to TypeScript (t101, FR2).
 *
 * The control plane cannot import `scripts/validar-grafo.mjs`: the script lives
 * outside the package's publishable tree (`files` in `packages/core/package.json`).
 * That is why the two functions were ported — and why this file is the only
 * place in the package that imports the reference validator: to lock parity
 * between the two, fixture by fixture, instead of trusting the copy stays
 * faithful.
 *
 * That parity is also why the report keys, codes and rule labels stay in
 * Portuguese: the reference validator is outside the D18 rename scope (t127,
 * FR8), and this test compares the two reports with `deepEqual`. The DOCUMENT's
 * own keys are English since t178 — the 2026-08-15 D18 amendment lifted that
 * carve-out — which is why the fixtures below are read with `nodes`/`edges` and
 * the report is still read with `erros`/`violacoes`.
 *
 * Repo convention (the same as `migrate.test.ts`): the module under test is
 * imported on demand, after an explicit `existsSync`, so that the initial red
 * says which artifact is missing instead of blowing up with a raw
 * ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type * as GraphModule from '../src/domain/graph.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'exemplos');
const REFERENCE_VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validar-grafo.mjs');

/** Shape of the reference validator, which is JavaScript with no declared types. */
interface ReferenceValidator {
  validarEstrutura: (doc: unknown) => { valido: boolean; erros: unknown[] };
  validarSoundness: (doc: unknown) => { valido: boolean; violacoes: unknown[] };
}

let graphCache: typeof GraphModule | null = null;
let referenceCache: ReferenceValidator | null = null;

async function loadDomainGraph(): Promise<typeof GraphModule> {
  const modulePath = path.join(PACKAGE_ROOT, 'src', 'domain', 'graph.ts');
  assert.ok(existsSync(modulePath), 'artifact does not exist yet: packages/core/src/domain/graph.ts');
  graphCache ??= (await import(
    new URL('../src/domain/graph.ts', import.meta.url).href
  )) as typeof GraphModule;
  return graphCache;
}

async function loadReference(): Promise<ReferenceValidator> {
  assert.ok(existsSync(REFERENCE_VALIDATOR), 'the reference validator is gone from the repository');
  referenceCache ??= (await import(
    pathToFileURL(REFERENCE_VALIDATOR).href
  )) as ReferenceValidator;
  return referenceCache;
}

/** Every t96 fixture, in a stable order. */
function examples(): string[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

function readExample(name: string): unknown {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
}

/** The minimal fixture, freshly parsed so every case mutates its own copy. */
function minimalGraph(): Record<string, unknown> {
  return readExample('grafo-valido-minimo.json') as Record<string, unknown>;
}

/** Node list of a parsed fixture, typed loosely because the cases put junk in it. */
function nodesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.nodes as Array<Record<string, unknown>>;
}

/** Edge list of a parsed fixture, same reason. */
function edgesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.edges as Array<Record<string, unknown>>;
}

/**
 * An id that is PRESENT but is not a filled string, at each of the four places
 * the document names a node: the node itself, an edge endpoint, `initial_node`
 * and an entry of `final_nodes` (t153).
 *
 * `targets` are the `alvo`s of the expected `id_invalido` errors, in order:
 * the node's index, `{de, para}` for an edge, the field name for `initial_node`,
 * the entry's index for `final_nodes`. The `alvo` of an edge keeps the report's
 * own `de`/`para` spelling even now that the document says `from`/`to`: the
 * report is the frozen 422 wire format, and only the document moved (t178).
 * `quoted` is the offending value as the message has to show it, and `absent` is
 * the code that must NOT fire in its place.
 */
const INVALID_ID_CASES: Array<{
  name: string;
  mutate: (doc: Record<string, unknown>) => void;
  targets: unknown[];
  quoted: string;
  absent?: string;
}> = [
  {
    name: 'node id = 1 (numeric)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = 1;
    },
    targets: [0],
    quoted: '1',
  },
  {
    name: 'node id = true (boolean)',
    mutate: (doc) => {
      nodesOf(doc)[1].id = true;
    },
    targets: [1],
    quoted: 'true',
  },
  {
    name: 'node id = "" (empty string)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = '';
    },
    targets: [0],
    quoted: '""',
  },
  {
    name: 'node id = "   " (whitespace only)',
    mutate: (doc) => {
      nodesOf(doc)[0].id = '   ';
    },
    targets: [0],
    quoted: '"   "',
  },
  {
    name: 'initial_node = 1 (numeric), every node id still a valid string',
    mutate: (doc) => {
      doc.initial_node = 1;
    },
    targets: ['initial_node'],
    quoted: '1',
    // An invalid id is not an id pointing at a missing node: only ONE of the
    // two fires.
    absent: 'no_inicial_inexistente',
  },
  {
    name: 'final_nodes = [null] (null inside the array)',
    mutate: (doc) => {
      doc.final_nodes = [null];
    },
    targets: [0],
    quoted: 'null',
    absent: 'no_final_inexistente',
  },
  {
    name: 'final_nodes = [1] (numeric inside the array)',
    mutate: (doc) => {
      doc.final_nodes = [1];
    },
    targets: [0],
    quoted: '1',
    absent: 'no_final_inexistente',
  },
  {
    name: 'edge "from" = true (boolean)',
    mutate: (doc) => {
      edgesOf(doc)[0].from = true;
    },
    targets: [{ de: true, para: 'revisar' }],
    quoted: 'true',
    absent: 'aresta_no_inexistente',
  },
  {
    name: 'edge "to" = 1 (numeric)',
    mutate: (doc) => {
      edgesOf(doc)[0].to = 1;
    },
    targets: [{ de: 'redigir', para: 1 }],
    quoted: '1',
    absent: 'aresta_no_inexistente',
  },
];

test('AT1 — the TS module agrees with scripts/validar-grafo.mjs on every fixture', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const files = examples();
  assert.ok(files.length >= 6, 'the t96 fixtures have to be in place');

  for (const file of files) {
    const doc = readExample(file);

    assert.deepEqual(
      ported.validateStructure(doc),
      reference.validarEstrutura(doc),
      `structure diverged on ${file}`,
    );
    assert.deepEqual(
      ported.validateSoundness(doc),
      reference.validarSoundness(doc),
      `soundness diverged on ${file}`,
    );
  }
});

test('AT2 — the four counterexamples fail with the expected rule, one each', async () => {
  const { validateSoundness, RULES } = await loadDomainGraph();

  const expected: Array<[string, { regra: string; alvo: unknown }]> = [
    ['grafo-invalido-no-inalcancavel.json', { regra: RULES.REACHABLE, alvo: 'revisar_lote' }],
    ['grafo-invalido-sem-terminacao.json', { regra: RULES.TERMINATES, alvo: 'reprocessar_item' }],
    [
      'grafo-invalido-aresta-sem-condicao.json',
      {
        regra: RULES.EDGE_WITH_CONDITION,
        alvo: { de: 'coletar_fontes', para: 'resumir_fontes' },
      },
    ],
    ['grafo-invalido-no-sem-contrato.json', { regra: RULES.NODE_WITH_CONTRACT, alvo: 'publicar_texto' }],
  ];

  for (const [file, violation] of expected) {
    const report = validateSoundness(readExample(file));
    assert.equal(report.valido, false, `${file} has to keep failing`);
    // Each t96 counterexample violates exactly ONE rule — that is what makes
    // each rule demonstrable in isolation (`docs/spec/grafo.md` §6).
    assert.deepEqual(report.violacoes, [violation], `wrong rule on ${file}`);
  }
});

test('t153 — an id that is present but is not a filled string is a structure error', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  for (const scenario of INVALID_ID_CASES) {
    const document = minimalGraph();
    scenario.mutate(document);

    const report = ported.validateStructure(document);

    // Parity first: a rule that only one of the two validators applies is a
    // rule the reference validator no longer documents (AT1's contract).
    assert.deepEqual(
      report,
      reference.validarEstrutura(document),
      `structure diverged on: ${scenario.name}`,
    );
    assert.equal(report.valido, false, `has to be refused: ${scenario.name}`);

    const flagged = report.erros.filter((item) => item.codigo === 'id_invalido');
    assert.deepEqual(
      flagged.map((item) => item.alvo),
      scenario.targets,
      `wrong id_invalido targets on: ${scenario.name}`,
    );
    for (const item of flagged) {
      assert.ok(
        item.mensagem.includes(scenario.quoted),
        `the message has to quote the offending value on: ${scenario.name}`,
      );
    }

    if (scenario.absent !== undefined) {
      assert.ok(
        !report.erros.some((item) => item.codigo === scenario.absent),
        `${scenario.absent} must not fire in place of id_invalido on: ${scenario.name}`,
      );
    }
  }
});

test('t153 — a node whose id is invalid never enters the known ids', async () => {
  const { validateStructure } = await loadDomainGraph();

  const document = minimalGraph();
  nodesOf(document)[0].id = 1;
  const codes = validateStructure(document).erros.map((item) => item.codigo);

  assert.ok(codes.includes('id_invalido'), 'the invalid id has to be reported');
  // And it is not registered either: every reference to "redigir" now dangles,
  // which is exactly what used to be swallowed in silence.
  assert.ok(codes.includes('aresta_no_inexistente'), 'the edge referencing it has to dangle');
  assert.ok(codes.includes('no_inicial_inexistente'), 'initial_node referencing it has to dangle');
});

test('AT2 — the two valid graphs keep passing both validations', async () => {
  const { validateGraph } = await loadDomainGraph();

  for (const file of ['grafo-valido-minimo.json', 'grafo-valido-flowpilot.json']) {
    const report = validateGraph(readExample(file));
    assert.equal(report.valido, true, `${file} has to stay valid`);
    assert.deepEqual(report.estrutura.erros, []);
    assert.deepEqual(report.soundness.violacoes, []);
  }
});

/**
 * t169 — a hook is graph DATA, so a hook that points nowhere is a shape defect.
 *
 * It lands in the structural pass and not among the four soundness rules on
 * purpose: soundness is a property of the workflow net (reachable, terminates,
 * labelled edges, contracted nodes), and a dangling `node_id` in a reaction says
 * nothing about the net. The two assertions below are that decision, written
 * down: the structure report names the problem, and `violacoes` stays empty.
 */
test('t169 — a hook pointing at a node that does not exist is a structure error', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = readExample('grafo-invalido-gancho-no-desconhecido.json');
  const report = ported.validateStructure(document);

  assert.deepEqual(
    report,
    reference.validarEstrutura(document),
    'structure diverged on the dangling-hook fixture',
  );
  assert.equal(report.valido, false, 'a hook that points nowhere refuses the document');

  const dangling = report.erros.filter((item) => item.codigo === 'gancho_no_inexistente');
  assert.equal(dangling.length, 1, 'exactly one hook of the fixture dangles');
  assert.ok(
    dangling[0].mensagem.includes('no_que_nao_existe'),
    `the message has to name the missing node: ${dangling[0].mensagem}`,
  );

  assert.deepEqual(
    ported.validateSoundness(document).violacoes,
    [],
    'the net itself is sound: a dangling hook is shape, never a workflow-net rule',
  );
});

test('t169 — a duplicate hook id is a structure error, and the valid fixture has none', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = readExample('grafo-valido-com-ganchos.json') as Record<string, unknown>;
  assert.deepEqual(
    ported.validateGraph(document),
    { valido: true, estrutura: { valido: true, erros: [] }, soundness: { valido: true, violacoes: [] } },
    'the fixture that declares hooks has to pass both validations whole',
  );

  const hooks = document.hooks as Array<Record<string, unknown>>;
  assert.ok(hooks.length >= 1, 'the fixture has to declare at least one hook');

  const repeated = structuredClone(document);
  const repeatedHooks = repeated.hooks as Array<Record<string, unknown>>;
  repeatedHooks.push(structuredClone(repeatedHooks[0]));

  const report = ported.validateStructure(repeated);
  assert.deepEqual(
    report,
    reference.validarEstrutura(repeated),
    'structure diverged on the duplicate-hook-id case',
  );
  assert.equal(report.valido, false);

  const duplicated = report.erros.filter((item) => item.codigo === 'id_gancho_duplicado');
  assert.equal(duplicated.length, 1, 'a repeated id is reported once, not once per repetition');
  assert.equal(duplicated[0].alvo, hooks[0].id);
  assert.ok(
    duplicated[0].mensagem.includes(hooks[0].id as string),
    'the message has to name the duplicated id',
  );
});

/**
 * t180 — the report's PROSE is English; its keys, codes and rule names are not.
 *
 * The parity of AT1 is what makes this a two-file claim: the same sentence has
 * to come out of `scripts/validar-grafo.mjs`, or `deepEqual` says so above.
 */
test('t180 — a structure message is English, and the frozen vocabulary around it is not', async () => {
  const ported = await loadDomainGraph();
  const reference = await loadReference();

  const document = minimalGraph();
  document.nodes = 'nem lista nem nada';
  const report = ported.validateStructure(document);

  assert.deepEqual(report, reference.validarEstrutura(document), 'the two validators still agree');

  const listProblem = report.erros.find((item) => item.alvo === 'nodes');
  assert.ok(listProblem !== undefined, 'a "nodes" that is not a list has to be reported');
  assert.equal(listProblem.codigo, 'campo_invalido', 'the machine-readable code is frozen (FR2)');
  assert.equal(listProblem.mensagem, '"nodes" has to be a list');

  // The rule labels are data two validators compare on, not prose (FR2).
  assert.equal(ported.RULES.REACHABLE, 'alcançável');
});
