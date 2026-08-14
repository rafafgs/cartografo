/**
 * Acceptance tests of the intake item validator (t122, AT1–AT6).
 *
 * The validator is pure — no `Database`, no clock, no HTTP — for the same reason
 * `domain/graph.ts` and `domain/operations.ts` are: the judgement of "is this
 * batch of tickets well formed?" has to be testable without a server, and it has
 * to give the WHOLE report instead of the first problem. Whoever submits a
 * batch of eight tickets with three broken references wants three lines back,
 * not three round trips.
 *
 * The report's own keys and codes stay in Portuguese: this report IS the body of
 * the 400 the intake route answers, the same convention as the graph report
 * (t127, FR8).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as IntakeModule from '../src/domain/intake.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_RELATIVE = 'src/domain/intake.ts';

let intakeCache: typeof IntakeModule | null = null;

/**
 * Loads the validator on demand, naming the missing artifact on the initial red.
 *
 * Same reason as `test/support.ts`: a module-resolution error at import time
 * looks like any other bug, and the first red of a ticket has to say which file
 * does not exist yet.
 */
async function loadIntake(): Promise<typeof IntakeModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_RELATIVE)),
    `artifact does not exist yet: packages/core/${MODULE_RELATIVE}`,
  );
  intakeCache ??= (await import(
    new URL(`../${MODULE_RELATIVE}`, import.meta.url).href
  )) as typeof IntakeModule;
  return intakeCache;
}

/** The codes found in a report, in the order they were reported. */
function codes(report: IntakeModule.ItemsReport): string[] {
  return report.problemas.map((problem) => problem.codigo);
}

/** The whole report as text — used to prove a message names the refs involved. */
function asText(report: IntakeModule.ItemsReport): string {
  return JSON.stringify(report.problemas);
}

test('AT1 — a batch with unique refs and no dependency validates clean', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    {
      ref: 'a',
      titulo: 'Migração 0005',
      corpo: 'Cria as duas tabelas do intake.',
      criterios_de_aceite: ['a migração roda do zero'],
    },
    { ref: 'b', titulo: 'Rota de confirmação' },
  ]);

  assert.equal(report.valido, true, asText(report));
  assert.deepEqual(report.problemas, []);
  assert.deepEqual(report.itens, [
    {
      ref: 'a',
      titulo: 'Migração 0005',
      corpo: 'Cria as duas tabelas do intake.',
      criterios_de_aceite: ['a migração roda do zero'],
      depende_de: [],
    },
    {
      ref: 'b',
      titulo: 'Rota de confirmação',
      // The optional ones are normalized, and `null` is not `[]`: "no acceptance
      // criteria yet" and "declared as none" are different statements, and the
      // node that refines is the one that turns the first into the second.
      corpo: null,
      criterios_de_aceite: null,
      depende_de: [],
    },
  ]);
});

test('AT2 — a ref repeated between two items is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'primeiro' },
    { ref: 'a', titulo: 'segundo' },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['ref_duplicado']);
  assert.match(asText(report), /"a"/, 'the report names the repeated ref');
});

test('AT3 — an item without a titulo (absent or empty) is rejected, and both show up', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a' },
    { ref: 'b', titulo: '   ' },
    { ref: 'c', titulo: 'este está bom' },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(
    codes(report),
    ['campo_obrigatorio_ausente', 'campo_obrigatorio_ausente'],
    'the WHOLE list of problems, never only the first',
  );
  assert.deepEqual(
    report.problemas.map((problem) => problem.alvo),
    ['a', 'b'],
    'each problem names the item it came from',
  );
});

test('AT3 — an item without a ref, or not an object at all, is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([{ titulo: 'sem ref' }, 'não sou um objeto']);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['campo_obrigatorio_ausente', 'item_invalido']);
  assert.deepEqual(
    report.problemas.map((problem) => problem.alvo),
    [0, 1],
    'with no usable ref the target falls back to the position in the list',
  );
});

test('AT3 — itens has to be a non-empty list', async () => {
  const { validateItems } = await loadIntake();

  for (const raw of [undefined, null, {}, 'a,b', []]) {
    const report = validateItems(raw);
    assert.equal(report.valido, false, `${JSON.stringify(raw)} should not validate`);
    assert.deepEqual(codes(report), ['lista_invalida']);
    assert.deepEqual(report.itens, []);
  }
});

test('AT3 — corpo, criterios_de_aceite and depende_de are checked when present', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'corpo errado', corpo: 42 },
    { ref: 'b', titulo: 'critério vazio', criterios_de_aceite: ['bom', '  '] },
    { ref: 'c', titulo: 'critérios não são lista', criterios_de_aceite: 'um texto só' },
    { ref: 'd', titulo: 'dependência não é lista', depende_de: 'a' },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), [
    'campo_invalido',
    'campo_invalido',
    'campo_invalido',
    'campo_invalido',
  ]);
  assert.deepEqual(
    report.problemas.map((problem) => problem.alvo),
    ['a', 'b', 'c', 'd'],
  );
});

test('AT4 — depende_de citing a ref that is not in the batch is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'primeiro', depende_de: ['b', 'fantasma'] },
    { ref: 'b', titulo: 'segundo' },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['dependencia_desconhecida']);
  assert.match(asText(report), /fantasma/, 'the report names the unknown ref');
  assert.doesNotMatch(
    asText(report),
    /"b"/,
    'the sibling dependency that DOES exist is not a problem',
  );
});

test('AT5 — an item whose depende_de cites its own ref is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([{ ref: 'a', titulo: 'sozinho', depende_de: ['a'] }]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['dependencia_de_si_mesmo']);
  assert.equal(report.problemas[0].alvo, 'a');
});

test('AT6 — a cycle of size 2 is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'a', depende_de: ['b'] },
    { ref: 'b', titulo: 'b', depende_de: ['a'] },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['ciclo_de_dependencia']);
  const cycle = report.problemas[0].alvo as string[];
  assert.ok(Array.isArray(cycle), 'the target of a cycle is the list of refs in it');
  assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b']);
});

test('AT6 — a cycle of size 3 is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'a', depende_de: ['b'] },
    { ref: 'b', titulo: 'b', depende_de: ['c'] },
    { ref: 'c', titulo: 'c', depende_de: ['a'] },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(codes(report), ['ciclo_de_dependencia']);
  const cycle = report.problemas[0].alvo as string[];
  assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b', 'c']);
});

test('AT6 — a valid DAG of 3+ levels is accepted', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'migracao', titulo: 'a migração' },
    { ref: 'dominio', titulo: 'o validador', depende_de: ['migracao'] },
    { ref: 'repositorio', titulo: 'o repositório', depende_de: ['migracao', 'dominio'] },
    { ref: 'rotas', titulo: 'as rotas', depende_de: ['repositorio'] },
    { ref: 'doc', titulo: 'a especificação', depende_de: ['rotas', 'dominio'] },
  ]);

  assert.equal(report.valido, true, asText(report));
  assert.equal(report.itens.length, 5);
  assert.deepEqual(report.itens[2].depende_de, ['migracao', 'dominio']);
});

test('AT6 — a diamond is a DAG, not a cycle', async () => {
  const { validateItems } = await loadIntake();

  // `d` is reached twice from `a`. A walk that mistakes "already visited" for
  // "cycle" fails exactly here, and this is the shape a real batch has.
  const report = validateItems([
    { ref: 'a', titulo: 'a', depende_de: ['b', 'c'] },
    { ref: 'b', titulo: 'b', depende_de: ['d'] },
    { ref: 'c', titulo: 'c', depende_de: ['d'] },
    { ref: 'd', titulo: 'd' },
  ]);

  assert.equal(report.valido, true, asText(report));
});

test('AT6 — a cycle in one component does not hide the problems of another', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', titulo: 'a', depende_de: ['b'] },
    { ref: 'b', titulo: 'b', depende_de: ['a'] },
    { ref: 'c', titulo: '' },
  ]);

  assert.equal(report.valido, false);
  assert.deepEqual(
    codes(report).sort(),
    ['campo_obrigatorio_ausente', 'ciclo_de_dependencia'],
    'shape problems and graph problems come back in the same report',
  );
});
