/**
 * Acceptance tests of the custom-field rules (t168).
 *
 * The module is pure — no `Database`, no clock, no HTTP — in the same spirit as
 * `domain/graph.ts` and `domain/intake.ts`: "is this ticket allowed to leave
 * this node?" is a structural question over two pieces of data (what the class
 * declared, what the ticket carries), and answering it here is what lets the
 * transition route enforce a gate without a session, a runner or a template
 * engine (D9: deterministic wherever possible).
 *
 * The field NAMES it returns are wire vocabulary — they come from the class's
 * graph document and go into the 400's `details` — so they are whatever the
 * class wrote. The code around them is English.
 *
 * Repo convention (the same as `domain-intake.test.ts`): the module under test
 * is imported on demand, after an explicit `existsSync`, so the initial red says
 * which artifact is missing instead of blowing up with ERR_MODULE_NOT_FOUND.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as CustomFieldsModule from '../src/domain/custom-fields.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const MODULE_RELATIVE = 'src/domain/custom-fields.ts';

let moduleCache: typeof CustomFieldsModule | null = null;

async function loadCustomFields(): Promise<typeof CustomFieldsModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_RELATIVE)),
    `artifact does not exist yet: packages/core/${MODULE_RELATIVE}`,
  );
  moduleCache ??= (await import(
    new URL(`../${MODULE_RELATIVE}`, import.meta.url).href
  )) as typeof CustomFieldsModule;
  return moduleCache;
}

/** What `grafos-de-fabrica/bets-assimetricas/grafo.json` declares (FR2). */
const DECLARATIONS: CustomFieldsModule.CustomFieldDefinition[] = [
  { name: 'premise_source', type: 'string', required_at: 'triagem' },
  { name: 'downside', type: 'number', required_at: null },
  { name: 'upside', type: 'number', required_at: null },
];

test('AT — no definition targeting the node means nothing to demand', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(missingRequiredFields(DECLARATIONS, 'coleta-fundamentos', null), []);
  assert.deepEqual(missingRequiredFields([], 'triagem', null), []);
  assert.deepEqual(
    missingRequiredFields(DECLARATIONS, 'red-team', { downside: 12 }),
    [],
    'a field declared without a required_at never blocks a crossing anywhere',
  );
});

test('AT — a required field the ticket does not carry is named', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(missingRequiredFields(DECLARATIONS, 'triagem', null), ['premise_source']);
  assert.deepEqual(missingRequiredFields(DECLARATIONS, 'triagem', {}), ['premise_source']);
  assert.deepEqual(
    missingRequiredFields(DECLARATIONS, 'triagem', { downside: -12, upside: 40 }),
    ['premise_source'],
    'other fields being filled does not answer for the one that was demanded',
  );
});

test('AT — a field present but explicitly null is missing, not filled', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(
    missingRequiredFields(DECLARATIONS, 'triagem', { premise_source: null }),
    ['premise_source'],
    '"the key exists and holds nothing" is the same fact as "nobody wrote it"',
  );
});

test('AT — once filled, the node lets the ticket through', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(
    missingRequiredFields(DECLARATIONS, 'triagem', {
      premise_source: 'relatório trimestral 2026Q2, página 12',
    }),
    [],
  );
  // A false and a zero are FILLED values. A truthiness test here would demand
  // the field again from whoever answered "no" or "nothing", which is the
  // classic way a gate like this starts lying.
  assert.deepEqual(
    missingRequiredFields(
      [{ name: 'reviewed', type: 'boolean', required_at: 'triagem' }],
      'triagem',
      { reviewed: false },
    ),
    [],
  );
  assert.deepEqual(
    missingRequiredFields(
      [{ name: 'downside', type: 'number', required_at: 'triagem' }],
      'triagem',
      { downside: 0 },
    ),
    [],
  );
});

test('AT — a definition required at another node never shows up here', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(
    missingRequiredFields(
      [
        { name: 'premise_source', type: 'string', required_at: 'triagem' },
        { name: 'sizing_note', type: 'string', required_at: 'dimensionamento-risco' },
      ],
      'triagem',
      {},
    ),
    ['premise_source'],
    'only the node the ticket is leaving gets to demand anything',
  );
});

test('AT — an absent declaration list is a class that declares nothing', async () => {
  const { missingRequiredFields } = await loadCustomFields();

  assert.deepEqual(missingRequiredFields(undefined, 'triagem', null), []);
  assert.deepEqual(
    missingRequiredFields(undefined, 'triagem', { premise_source: 'x' }),
    [],
    'a job whose graph version predates this feature crosses as it always did',
  );
});

test('AT — isScalarMap accepts an object of scalars and refuses everything else', async () => {
  const { isScalarMap } = await loadCustomFields();

  assert.equal(isScalarMap({}), true, 'an empty map is a well-shaped map');
  assert.equal(isScalarMap({ premise_source: 'x', downside: -12.5, reviewed: true }), true);

  for (const refused of [
    null,
    undefined,
    'x',
    7,
    true,
    [],
    ['premise_source'],
    { premise_source: { page: 12 } },
    { downside: [12] },
    { premise_source: null },
  ]) {
    assert.equal(isScalarMap(refused), false, `${JSON.stringify(refused)} is not a scalar map`);
  }
});
