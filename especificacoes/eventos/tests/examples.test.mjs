// Validation of the example log against the schemas (t98, acceptance test 2).
//
// No ajv and no package.json: the repository is still pre-implementation, and
// the project's first dependency does not arrive through a specification ficha.
// The validation here is structural — required keys present, enums respected,
// no `data` key outside the contract — which is enough to prove that the example
// and the schemas are talking about the same format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));
const LOG = fileURLToPath(new URL('../exemplos/example-log.jsonl', import.meta.url));

const ENVELOPE = 'envelope.schema.json';
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function readSchemas() {
  const envelope = JSON.parse(readFileSync(join(SCHEMAS_DIR, ENVELOPE), 'utf8'));
  const byType = new Map();
  for (const name of readdirSync(SCHEMAS_DIR)) {
    if (!name.endsWith('.schema.json') || name === ENVELOPE) continue;
    const schema = JSON.parse(readFileSync(join(SCHEMAS_DIR, name), 'utf8'));
    byType.set(schema.properties.type.const, schema);
  }
  return { envelope, byType };
}

function readLog() {
  return readFileSync(LOG, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.length > 0)
    .map(({ line, number }) => {
      try {
        return { event: JSON.parse(line), number };
      } catch (error) {
        assert.fail(`line ${number} is not valid JSON: ${error.message}`);
      }
    });
}

const { envelope, byType } = readSchemas();
const lines = readLog();

test('the example log is not empty', () => {
  assert.ok(lines.length > 0, 'example-log.jsonl has no event at all');
});

for (const { event, number } of lines) {
  const label = `line ${number} (${event.type})`;

  test(`${label}: complete and well-typed envelope`, () => {
    for (const key of envelope.required) {
      assert.ok(key in event, `${label}: the required field "${key}" is missing`);
    }
    assert.equal(typeof event.id, 'number');
    assert.ok(Number.isInteger(event.id), `${label}: id has to be an integer`);
    assert.equal(typeof event.project_id, 'number');
    assert.ok(
      event.execution_id === null || Number.isInteger(event.execution_id),
      `${label}: execution_id has to be an integer or null`,
    );
    assert.match(event.occurred_at, ISO_8601, `${label}: occurred_at is not an ISO 8601 date-time`);

    assert.ok(
      envelope.properties.entity.properties.type.enum.includes(event.entity.type),
      `${label}: entity.type "${event.entity.type}" is outside the enum`,
    );
    assert.ok(
      ['number', 'string'].includes(typeof event.entity.id),
      `${label}: entity.id has to be an integer or a string`,
    );
    assert.ok(
      envelope.properties.actor.properties.type.enum.includes(event.actor.type),
      `${label}: actor.type "${event.actor.type}" is outside the enum`,
    );
    assert.equal(typeof event.actor.ref, 'string');
    assert.equal(typeof event.data, 'object');
    assert.ok(event.data !== null, `${label}: data cannot be null`);

    // The envelope closes `additionalProperties`, and without ajv this is where
    // that is charged. Since t227 the check has a second job: a surviving key of
    // the old vocabulary (`tipo`, `entidade`, `ator`, `dados`) is not just any
    // extra field — it is the half-done translation, and it disappears through
    // exactly this assertion.
    const declared = Object.keys(envelope.properties);
    for (const key of Object.keys(event)) {
      assert.ok(
        declared.includes(key),
        `${label}: ${key} does not exist in the envelope (declared: ${declared.join(', ')})`,
      );
    }
    for (const sub of [
      { name: 'entity', value: event.entity, keys: ['type', 'id'] },
      { name: 'actor', value: event.actor, keys: ['type', 'ref'] },
    ]) {
      assert.deepEqual(
        Object.keys(sub.value).sort(),
        [...sub.keys].sort(),
        `${label}: ${sub.name} has to carry exactly ${sub.keys.join(' and ')}`,
      );
    }
  });

  test(`${label}: matches the schema of its own type`, () => {
    const schema = byType.get(event.type);
    assert.ok(schema, `${label}: no schema declares the type "${event.type}"`);

    assert.equal(
      event.entity.type,
      schema.properties.entity.properties.type.const,
      `${label}: entity.type diverges from the schema`,
    );

    const data = schema.properties.data;
    for (const key of data.required) {
      assert.ok(key in event.data, `${label}: data.${key} is missing`);
    }
    const declared = Object.keys(data.properties ?? {});
    for (const key of Object.keys(event.data)) {
      assert.ok(declared.includes(key), `${label}: data.${key} is not declared in the schema`);
    }
  });
}

test('every event type appears at least once', () => {
  const present = new Set(lines.map(({ event }) => event.type));
  const missing = [...byType.keys()].filter((type) => !present.has(type)).sort();
  assert.deepEqual(missing, [], `types absent from the example log: ${missing.join(', ')}`);
});

test('the ids are monotonic — the order of the log', () => {
  const ids = lines.map(({ event }) => event.id);
  for (let i = 1; i < ids.length; i += 1) {
    assert.ok(ids[i] > ids[i - 1], `id ${ids[i]} is not greater than the previous ${ids[i - 1]}`);
  }
});

test('the log describes a single end-to-end execution', () => {
  const executions = new Set(
    lines.map(({ event }) => event.execution_id).filter((id) => id !== null),
  );
  assert.equal(executions.size, 1, `expected a single execution, found ${[...executions].join(', ')}`);

  const projects = new Set(lines.map(({ event }) => event.project_id));
  assert.equal(projects.size, 1, `expected a single project, found ${[...projects].join(', ')}`);
});
