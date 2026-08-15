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
 * That parity is also why the report keys, codes and messages stay in
 * Portuguese: the reference validator is outside the D18 rename scope (t127,
 * FR8), and this test compares the two reports with `deepEqual`.
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
  return doc.nos as Array<Record<string, unknown>>;
}

/** Edge list of a parsed fixture, same reason. */
function edgesOf(doc: Record<string, unknown>): Array<Record<string, unknown>> {
  return doc.arestas as Array<Record<string, unknown>>;
}

/**
 * An id that is PRESENT but is not a filled string, at each of the four places
 * the document names a node: the node itself, an edge endpoint, `no_inicial`
 * and an entry of `nos_finais` (t153).
 *
 * `targets` are the `alvo`s of the expected `id_invalido` errors, in order:
 * the node's index, `{de, para}` for an edge, the field name for `no_inicial`,
 * the entry's index for `nos_finais`. `quoted` is the offending value as the
 * message has to show it, and `absent` is the code that must NOT fire in its
 * place.
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
    name: 'no_inicial = 1 (numeric), every node id still a valid string',
    mutate: (doc) => {
      doc.no_inicial = 1;
    },
    targets: ['no_inicial'],
    quoted: '1',
    // An invalid id is not an id pointing at a missing node: only ONE of the
    // two fires.
    absent: 'no_inicial_inexistente',
  },
  {
    name: 'nos_finais = [null] (null inside the array)',
    mutate: (doc) => {
      doc.nos_finais = [null];
    },
    targets: [0],
    quoted: 'null',
    absent: 'no_final_inexistente',
  },
  {
    name: 'nos_finais = [1] (numeric inside the array)',
    mutate: (doc) => {
      doc.nos_finais = [1];
    },
    targets: [0],
    quoted: '1',
    absent: 'no_final_inexistente',
  },
  {
    name: 'edge "de" = true (boolean)',
    mutate: (doc) => {
      edgesOf(doc)[0].de = true;
    },
    targets: [{ de: true, para: 'revisar' }],
    quoted: 'true',
    absent: 'aresta_no_inexistente',
  },
  {
    name: 'edge "para" = 1 (numeric)',
    mutate: (doc) => {
      edgesOf(doc)[0].para = 1;
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
  assert.ok(codes.includes('no_inicial_inexistente'), 'no_inicial referencing it has to dangle');
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
