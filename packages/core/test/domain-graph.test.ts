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

test('AT2 — the two valid graphs keep passing both validations', async () => {
  const { validateGraph } = await loadDomainGraph();

  for (const file of ['grafo-valido-minimo.json', 'grafo-valido-flowpilot.json']) {
    const report = validateGraph(readExample(file));
    assert.equal(report.valido, true, `${file} has to stay valid`);
    assert.deepEqual(report.estrutura.erros, []);
    assert.deepEqual(report.soundness.violacoes, []);
  }
});
