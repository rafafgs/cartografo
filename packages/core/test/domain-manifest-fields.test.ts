/**
 * The rename map, pinned against the two schemas that define it (t178, AT8).
 *
 * `packages/core/src/domain/{manifest,graph}.ts` is a hand-written port of two
 * JSON Schemas that live outside this package —
 * `specs/formats/skill-manifest.schema.json` and
 * `schema/grafo.schema.json`. Nothing compiles the port against the schema, so
 * until this file existed the only thing keeping the two in step was that
 * whoever edited one remembered the other. That is exactly the failure mode a
 * key rename produces: a field renamed in the schema and not in the port passes
 * every other test in the suite, because the fixtures were renamed with the
 * schema and the port simply stops finding a key it never asked about.
 *
 * So the claim here is deliberately narrow and total: the field NAMES the domain
 * code knows are, exactly and in order, the field names the schemas declare
 * `required`. Not a subset, not a superset.
 *
 * The hash subset (FR4) gets the same treatment, but behaviourally: the covered
 * fields are not a constant anybody can read, they are whatever `manifestHash`
 * actually serializes. Touching each one has to move the pin, and touching a
 * catalogue field must not — which is the property D4 depends on and the one a
 * rename can silently break by leaving an old key name in the subset literal,
 * where it would serialize as `undefined` and simply vanish.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  REQUIRED_DOCUMENT_FIELDS,
  REQUIRED_EDGE_FIELDS,
  REQUIRED_HOOK_FIELDS,
  REQUIRED_NODE_FIELDS,
} from '../src/domain/graph.ts';
import { MANIFEST_FIELDS, MANIFEST_ROLES, manifestHash } from '../src/domain/manifest.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

const MANIFEST_SCHEMA_PATH = path.join(
  REPO_ROOT,
  'specs',
  'formats',
  'skill-manifest.schema.json',
);
const GRAPH_SCHEMA_PATH = path.join(REPO_ROOT, 'schema', 'grafo.schema.json');

interface JsonSchema {
  required?: string[];
  properties?: Record<string, JsonSchema>;
  enum?: string[];
  $defs?: Record<string, JsonSchema>;
}

function readSchema(filePath: string): JsonSchema {
  return JSON.parse(readFileSync(filePath, 'utf8')) as JsonSchema;
}

/** A `$defs` entry, asserted present before anything reads into it. */
function definition(schema: JsonSchema, name: string): JsonSchema {
  const found = schema.$defs?.[name];
  assert.ok(found !== undefined, `the schema no longer declares $defs.${name}`);
  return found;
}

test('AT8 — MANIFEST_FIELDS is exactly the manifest schema\'s required list', () => {
  const schema = readSchema(MANIFEST_SCHEMA_PATH);

  assert.deepEqual(MANIFEST_FIELDS, schema.required);
  for (const field of MANIFEST_FIELDS) {
    assert.ok(
      Object.hasOwn(schema.properties ?? {}, field),
      `the schema declares "${field}" required but never declares the property`,
    );
  }
});

test('AT8 — MANIFEST_ROLES is exactly the schema\'s role enum', () => {
  const schema = readSchema(MANIFEST_SCHEMA_PATH);

  assert.deepEqual(MANIFEST_ROLES, schema.properties?.role?.enum);
});

/**
 * Top-level keys the document declares but never requires.
 *
 * Until t169 this list was empty, and the assertion below could simply demand
 * that `required` and `properties` be the same set. `hooks` broke that by
 * design: it is optional so that every graph written before it stays valid
 * untouched, the same non-breaking posture `engine` already had on the node.
 * `project` joined it with t253, under exactly the same rule: it is the class's
 * static configuration, read by the node input projection, and a document that
 * declares none projects `{}` instead of refusing. `max_consecutive_failures`
 * joined with t265, again under it: absent means the default of 3, resolved when
 * a session closes and never at validation time.
 *
 * Naming it here instead of loosening the check to a subset keeps the claim
 * total — a top-level key that is neither required nor listed here still fails,
 * which is the property that catches a rename or a stray addition.
 */
const OPTIONAL_DOCUMENT_FIELDS = ['hooks', 'project', 'max_consecutive_failures'];

test('AT8 — the document, node, edge and hook field sets are exactly the graph schema\'s', () => {
  const schema = readSchema(GRAPH_SCHEMA_PATH);

  assert.deepEqual(REQUIRED_DOCUMENT_FIELDS, schema.required);
  assert.deepEqual(
    [...REQUIRED_DOCUMENT_FIELDS, ...OPTIONAL_DOCUMENT_FIELDS].sort(),
    Object.keys(schema.properties ?? {}).sort(),
    'every top-level key is either required or a declared optional one',
  );

  assert.deepEqual(REQUIRED_NODE_FIELDS, definition(schema, 'node').required);
  assert.deepEqual(REQUIRED_EDGE_FIELDS, definition(schema, 'edge').required);
  assert.deepEqual(REQUIRED_HOOK_FIELDS, definition(schema, 'hook').required);

  for (const [fields, name] of [
    [REQUIRED_NODE_FIELDS, 'node'],
    [REQUIRED_EDGE_FIELDS, 'edge'],
    [REQUIRED_HOOK_FIELDS, 'hook'],
  ] as const) {
    const declared = Object.keys(definition(schema, name).properties ?? {});
    for (const field of fields) {
      assert.ok(declared.includes(field), `$defs.${name} requires "${field}" but never declares it`);
    }
  }
});

/** A manifest with every field the pin covers, plus the catalogue fields it does not. */
function pinnableManifest(): Record<string, unknown> {
  return {
    id: 'exemplo',
    version: '1.0.0',
    hash: `sha256:${'0'.repeat(64)}`,
    role: 'work',
    description: 'Uma skill de exemplo.',
    input: { type: 'object' },
    output: { type: 'object' },
    preconditions: [],
    checks: [
      { id: 'suite', type: 'deterministic', description: 'A suíte passa.', command: 'make test' },
    ],
    permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
    budgets: { timeout_s: 1800 },
    instructions: '# Exemplo',
    origin: { type: 'native' },
  };
}

test('AT8 — the hash covers the six content fields by their new names, and nothing else', () => {
  const baseline = manifestHash(pinnableManifest());

  // Covered: touching any one of the six has to move the pin. A field left in
  // the subset under its OLD name would serialize to nothing and the mutation
  // below would come back with the same hash.
  const covered: Array<[string, unknown]> = [
    ['instructions', '# Outro corpo'],
    ['input', { type: 'string' }],
    ['output', { type: 'string' }],
    ['checks', []],
    ['permissions', { filesystem: { read: [], write: [] }, network: { allowed: false } }],
    ['budgets', { timeout_s: 60 }],
  ];
  for (const [field, value] of covered) {
    const manifest = pinnableManifest();
    manifest[field] = value;
    assert.notEqual(
      manifestHash(manifest),
      baseline,
      `"${field}" is inside the pinned subset: changing it has to change the hash (D4)`,
    );
  }

  // Not covered: catalogue metadata. Renaming a skill or signing its import
  // cannot invalidate the pin the reviewer just approved.
  const catalogue: Array<[string, unknown]> = [
    ['id', 'outro-id'],
    ['version', '2.0.0'],
    ['description', 'outra descrição'],
    ['role', 'gate'],
    ['origin', { type: 'imported', reviewed_by: 'rafael' }],
  ];
  for (const [field, value] of catalogue) {
    const manifest = pinnableManifest();
    manifest[field] = value;
    assert.equal(
      manifestHash(manifest),
      baseline,
      `"${field}" is catalogue metadata: changing it cannot move the pin`,
    );
  }
});
