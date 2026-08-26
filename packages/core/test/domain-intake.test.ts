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
 * The report's own keys and codes are English since t255: this report IS the body
 * of the 400 the intake route answers, and D20 puts the fields of the API's JSON
 * on the English wire — the same move the graph report made in t230. Two codes
 * went away with the rename instead of being translated: a missing or malformed
 * field now answers `missing_required_field`/`invalid_field`, which is what the
 * route beside it already spells (`routes/intake.ts:100`), so one item never
 * comes back with two spellings of the same problem.
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
  return report.problems.map((problem) => problem.code);
}

/** The whole report as text — used to prove a message names the refs involved. */
function asText(report: IntakeModule.ItemsReport): string {
  return JSON.stringify(report.problems);
}

test('AT1 — a batch with unique refs and no dependency validates clean', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    {
      ref: 'a',
      title: 'Migration 0005',
      body: 'New columns on the job table and the two intake tables.',
      acceptance_criteria: ['the migration runs from scratch'],
    },
    { ref: 'b', title: 'Confirmation route' },
  ]);

  assert.equal(report.valid, true, asText(report));
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.items, [
    {
      ref: 'a',
      title: 'Migration 0005',
      body: 'New columns on the job table and the two intake tables.',
      acceptance_criteria: ['the migration runs from scratch'],
      fields: null,
      tier: null,
      depends_on: [],
    },
    {
      ref: 'b',
      title: 'Confirmation route',
      // The optional ones are normalized, and `null` is not `[]`: "no acceptance
      // criteria yet" and "declared as none" are different statements, and the
      // node that refines is the one that turns the first into the second.
      body: null,
      acceptance_criteria: null,
      fields: null,
      // And the triage (t175) normalizes the same way, for a sharper reason:
      // `null` and `'trivial'` differ by which model the work ends up running.
      tier: null,
      depends_on: [],
    },
  ]);
});

/**
 * t168 — the fields the class declared, filled in at intake.
 *
 * Shape-checked exactly like `acceptance_criteria` beside it, and for the same
 * reason: this validator judges FORM, never whether the class actually declares
 * a field by that name. Cross-checking a value against the class's
 * `custom_fields` is the transition gate's business, one layer down and one
 * decision later.
 */
test('t168 — fields is accepted when well shaped, and an absent one normalizes to null', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    {
      ref: 'thesis',
      title: 'Buy the copper thesis',
      fields: { premise_source: 'quarterly report', downside: -12.5, upside: 40 },
    },
    { ref: 'other', title: 'No field at all' },
  ]);

  assert.equal(report.valid, true, asText(report));
  assert.deepEqual(report.items[0].fields, {
    premise_source: 'quarterly report',
    downside: -12.5,
    upside: 40,
  });
  assert.equal(
    report.items[1].fields,
    null,
    'an item that declares no field carries null, never an empty map',
  );
});

test('t168 — an item whose fields is not a map of scalars is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'valor aninhado', fields: { downside: { valor: 12 } } },
    { ref: 'b', title: 'a list where a map goes', fields: ['downside'] },
    { ref: 'c', title: 'text where a map goes', fields: 'downside=12' },
    { ref: 'd', title: 'this one is fine', fields: { downside: 12 } },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['invalid_field', 'invalid_field', 'invalid_field']);
  assert.deepEqual(
    report.problems.map((problem) => problem.target),
    ['a', 'b', 'c'],
    'each problem names the item it came from, and the well-formed one is silent',
  );
});

/*
 * t175 — the triage the intake session does for free.
 *
 * `tier` is the narrowest possible instance of a policy surface: it says what a
 * work item costs to RUN, never which edge it takes. The graph stays frozen
 * (README principle 2), and `docs/spec/graph.md:401-403`'s deliberate omission
 * of flowpilot's topology shortcuts is not reopened by it.
 *
 * The rule that matters most here is the one the absent case pins: absence is
 * "nobody classified this", never "trivial". Reading the two as the same thing
 * would silently downgrade the model of every ticket born before this field
 * existed — which is the same discipline `body`, `acceptance_criteria` and
 * `fields` already follow, for the same reason.
 */
test('t175 — tier accepts the two declared values, and an absent one normalizes to null', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'rename', title: 'Rename a variable', tier: 'trivial' },
    { ref: 'feature', title: 'The whole feature, from zero', tier: 'standard' },
    { ref: 'no-triage', title: 'Nobody triaged this one' },
  ]);

  assert.equal(report.valid, true, asText(report));
  assert.equal(report.items[0].tier, 'trivial');
  assert.equal(report.items[1].tier, 'standard');
  assert.equal(
    report.items[2].tier,
    null,
    'an item nobody classified carries null — absence is never "trivial"',
  );
});

test('t175 — a tier outside the two declared values is invalid_field', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'urgency is not a tier', tier: 'urgent' },
    { ref: 'b', title: 'not a number either', tier: 2 },
    { ref: 'c', title: 'not an empty string either', tier: '' },
    { ref: 'd', title: 'this one is fine', tier: 'standard' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['invalid_field', 'invalid_field', 'invalid_field']);
  assert.deepEqual(
    report.problems.map((problem) => problem.target),
    ['a', 'b', 'c'],
    'each problem names the item it came from, and the well-formed one is silent',
  );
  assert.ok(asText(report).includes('tier'), 'the message names the offending field');
});

test('AT2 — a ref repeated between two items is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'first' },
    { ref: 'a', title: 'second' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['duplicate_ref']);
  assert.match(asText(report), /"a"/, 'the report names the repeated ref');
});

test('AT3 — an item without a title (absent or empty) is rejected, and both show up', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a' },
    { ref: 'b', title: '   ' },
    { ref: 'c', title: 'this one is fine' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(
    codes(report),
    ['missing_required_field', 'missing_required_field'],
    'the WHOLE list of problems, never only the first',
  );
  assert.deepEqual(
    report.problems.map((problem) => problem.target),
    ['a', 'b'],
    'each problem names the item it came from',
  );
});

test('AT3 — an item without a ref, or not an object at all, is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([{ title: 'no ref' }, 'I am not an object']);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['missing_required_field', 'invalid_item']);
  assert.deepEqual(
    report.problems.map((problem) => problem.target),
    [0, 1],
    'with no usable ref the target falls back to the position in the list',
  );
});

test('AT3 — items has to be a non-empty list', async () => {
  const { validateItems } = await loadIntake();

  for (const raw of [undefined, null, {}, 'a,b', []]) {
    const report = validateItems(raw);
    assert.equal(report.valid, false, `${JSON.stringify(raw)} should not validate`);
    assert.deepEqual(codes(report), ['invalid_list']);
    assert.deepEqual(report.items, []);
  }
});

test('AT3 — body, acceptance_criteria and depends_on are checked when present', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'body errado', body: 42 },
    { ref: 'b', title: 'empty criterion', acceptance_criteria: ['fine', '  '] },
    { ref: 'c', title: 'criteria are not a list', acceptance_criteria: 'just some text' },
    { ref: 'd', title: 'dependency is not a list', depends_on: 'a' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), [
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
  ]);
  assert.deepEqual(
    report.problems.map((problem) => problem.target),
    ['a', 'b', 'c', 'd'],
  );
});

test('AT4 — depends_on citing a ref that is not in the batch is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'first', depends_on: ['b', 'ghost'] },
    { ref: 'b', title: 'second' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['unknown_dependency']);
  assert.match(asText(report), /ghost/, 'the report names the unknown ref');
  assert.doesNotMatch(
    asText(report),
    /"b"/,
    'the sibling dependency that DOES exist is not a problem',
  );
});

test('AT5 — an item whose depends_on cites its own ref is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([{ ref: 'a', title: 'alone', depends_on: ['a'] }]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['self_dependency']);
  assert.equal(report.problems[0].target, 'a');
});

test('AT6 — a cycle of size 2 is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'a', depends_on: ['b'] },
    { ref: 'b', title: 'b', depends_on: ['a'] },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['dependency_cycle']);
  const cycle = report.problems[0].target as string[];
  assert.ok(Array.isArray(cycle), 'the target of a cycle is the list of refs in it');
  assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b']);
});

test('AT6 — a cycle of size 3 is rejected', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'a', depends_on: ['b'] },
    { ref: 'b', title: 'b', depends_on: ['c'] },
    { ref: 'c', title: 'c', depends_on: ['a'] },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(codes(report), ['dependency_cycle']);
  const cycle = report.problems[0].target as string[];
  assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b', 'c']);
});

test('AT6 — a valid DAG of 3+ levels is accepted', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'migration', title: 'the migration' },
    { ref: 'domain', title: 'the validator', depends_on: ['migration'] },
    { ref: 'repository', title: 'the repository', depends_on: ['migration', 'domain'] },
    { ref: 'routes', title: 'the routes', depends_on: ['repository'] },
    { ref: 'doc', title: 'the spec', depends_on: ['routes', 'domain'] },
  ]);

  assert.equal(report.valid, true, asText(report));
  assert.equal(report.items.length, 5);
  assert.deepEqual(report.items[2].depends_on, ['migration', 'domain']);
});

test('AT6 — a diamond is a DAG, not a cycle', async () => {
  const { validateItems } = await loadIntake();

  // `d` is reached twice from `a`. A walk that mistakes "already visited" for
  // "cycle" fails exactly here, and this is the shape a real batch has.
  const report = validateItems([
    { ref: 'a', title: 'a', depends_on: ['b', 'c'] },
    { ref: 'b', title: 'b', depends_on: ['d'] },
    { ref: 'c', title: 'c', depends_on: ['d'] },
    { ref: 'd', title: 'd' },
  ]);

  assert.equal(report.valid, true, asText(report));
});

test('AT6 — a cycle in one component does not hide the problems of another', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([
    { ref: 'a', title: 'a', depends_on: ['b'] },
    { ref: 'b', title: 'b', depends_on: ['a'] },
    { ref: 'c', title: '' },
  ]);

  assert.equal(report.valid, false);
  assert.deepEqual(
    codes(report).sort(),
    ['dependency_cycle', 'missing_required_field'],
    'shape problems and graph problems come back in the same report',
  );
});

test('t180 — the cycle and missing-field problems are reported in English', async () => {
  const { validateItems } = await loadIntake();

  const cycle = validateItems([
    { ref: 'a', title: 'a', depends_on: ['b'] },
    { ref: 'b', title: 'b', depends_on: ['a'] },
  ]);
  const closed = cycle.problems.find((problem) => problem.code === 'dependency_cycle');
  assert.ok(closed !== undefined, 'the cycle has to be reported');
  assert.equal(closed.message, 'the dependencies close a cycle: a → b → a');

  const missing = validateItems([{ ref: 'a' }]);
  const field = missing.problems.find((problem) => problem.code === 'missing_required_field');
  assert.ok(field !== undefined, 'a missing title has to be reported');
  assert.equal(
    field.message,
    'required field missing from item "a": "title"',
    'the message names the wire key, which is English since t255',
  );
});

/* -------------------------------------------------------------------------- */
/* t255 — the item and its report are the API's JSON, so D20 reaches them.     */
/*                                                                            */
/* Until this ticket, `repositories/intake.ts:122-126` and `routes/intake.ts`  */
/* claimed the item's own keys were a format the glossary maps nowhere. D20's  */
/* text says otherwise — "the fields and query parameters of the API's JSON" — */
/* and these keys travel in the body of `POST /v1/intake` and back out of      */
/* `GET /v1/intake/:id`. So they are the wire, and they are English.           */
/* -------------------------------------------------------------------------- */

test('t255 — the codes and the problem shape are the English of glossary-wire.md §1.4', async () => {
  const { PROBLEM_CODES, validateItems } = await loadIntake();

  assert.deepEqual(
    { ...PROBLEM_CODES },
    {
      LIST: 'invalid_list',
      ITEM: 'invalid_item',
      MISSING_FIELD: 'missing_required_field',
      INVALID_FIELD: 'invalid_field',
      DUPLICATE_REF: 'duplicate_ref',
      UNKNOWN_DEPENDENCY: 'unknown_dependency',
      SELF_DEPENDENCY: 'self_dependency',
      CYCLE: 'dependency_cycle',
    },
    'the two dropped codes are the route’s own missing_required_field/invalid_field',
  );

  const [problem] = validateItems([{ ref: 'a' }]).problems;
  assert.deepEqual(
    Object.keys(problem).sort(),
    ['code', 'message', 'target'],
    'a problem is {code, message, target} — the graph report’s shape since t230',
  );
});

test('t255 — the empty-list message names the wire key the route reads', async () => {
  const { validateItems } = await loadIntake();

  const [problem] = validateItems([]).problems;
  assert.equal(
    problem.message,
    '"items" has to be a non-empty list: intake breaks work down into tickets',
    'the route reads `body.items`; a message that says "itens" names a key nobody sends',
  );
});

test('t255 — an item written with the retired Portuguese keys is refused, never read', async () => {
  const { validateItems } = await loadIntake();

  // The whole batch in the pre-t255 spelling. `titulo` is not `title`, so the
  // item has no title at all; the rest are unknown keys the validator ignores,
  // which is exactly what makes the refusal honest instead of silent.
  const report = validateItems([
    {
      ref: 'migration',
      titulo: 'Migration 0005',
      corpo: 'The two tables.',
      criterios_de_aceite: ['runs from zero'],
      depende_de: [],
    },
  ]);

  assert.equal(report.valid, false, 'the old spelling cannot keep working as a synonym');
  assert.deepEqual(codes(report), ['missing_required_field']);
  assert.ok(
    report.problems[0].message.includes('"title"'),
    `the refusal names the key that is missing: ${asText(report)}`,
  );

  // And the same item, spelled the way the wire spells it now, goes through with
  // every optional field read rather than dropped.
  const renamed = validateItems([
    {
      ref: 'migration',
      title: 'Migration 0005',
      body: 'The two tables.',
      acceptance_criteria: ['runs from zero'],
      fields: { area: 'intake' },
      tier: 'standard',
      depends_on: [],
    },
  ]);

  assert.equal(renamed.valid, true, asText(renamed));
  assert.deepEqual(renamed.items, [
    {
      ref: 'migration',
      title: 'Migration 0005',
      body: 'The two tables.',
      acceptance_criteria: ['runs from zero'],
      fields: { area: 'intake' },
      tier: 'standard',
      depends_on: [],
    },
  ]);
});

test('t255 — an unknown dependency points at the offending item with the renamed key', async () => {
  const { validateItems } = await loadIntake();

  const report = validateItems([{ ref: 'a', title: 'first', depends_on: ['ghost'] }]);

  assert.deepEqual(codes(report), ['unknown_dependency']);
  assert.deepEqual(
    report.problems[0].target,
    { ref: 'a', depends_on: 'ghost' },
    'the target is published inside the 400, so its own keys are the wire’s too',
  );
});
