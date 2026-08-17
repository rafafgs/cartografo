/**
 * Skill-registry acceptance tests (t117, AT1–AT7; t135, AT8–AT9; t155, AT10–AT12).
 *
 * The registry is the gate of truth of D4, and that is the whole point of these
 * tests: every rule below is re-checked by the SERVER, independently of the CLI
 * that derived the manifest and of the human who approved it. A human can
 * approve a manifest whose hash no longer matches its content; the registry
 * still refuses it. That is what makes the pin worth anything.
 *
 * The content hash is recomputed HERE, by an implementation of its own, instead
 * of being imported from `src/domain/manifest.ts`. A test that asks the
 * implementation what the right answer is proves only that the implementation
 * agrees with itself — and the hash is precisely the value D4 says nobody should
 * take on trust. The procedure is short enough to write twice:
 * `sha256` of the canonical JSON of `{instructions, input, output, checks, permissions}`
 * (`especificacoes/formatos/manifesto-skill.md`).
 *
 * The manifest field names are English since t178 (the 2026-08-15 D18
 * amendment). What is still Portuguese in the payloads below is free content —
 * a description, an instruction, the prose of a check — which that amendment
 * deliberately did not touch.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  request,
  requireArtifacts,
  startControlPlane,
  type TestContext,
} from './support.ts';

/**
 * The specification's own negative fixture (t135, AT8).
 *
 * It is read from disk, verbatim, instead of being rebuilt here: its whole
 * reason to exist is to be the ONE manifest the format promises is rejected, and
 * a copy of it in a test file would let the fixture and the registry drift apart
 * without either one noticing.
 */
const INVALID_FIXTURE = path.join(
  PACKAGE_ROOT,
  '..',
  '..',
  'especificacoes',
  'formatos',
  'exemplos',
  'manifesto-skill.invalido.fixture.json',
);

/** Artifacts of this ticket; every test names them before touching the API. */
const T117_ARTIFACTS = Object.freeze({
  migration: 'migrations/0005_skill.sql',
  manifestDomain: 'src/domain/manifest.ts',
  repository: 'src/repositories/skill.ts',
  routes: 'src/routes/skills.ts',
});

const ARTIFACTS = Object.values(T117_ARTIFACTS);

/** A registered skill, as the API returns it — the contract this test demands. */
interface Skill {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  preconditions: string[];
  checks: Record<string, unknown>[];
  permissions: Record<string, unknown>;
  instructions: string;
  origin: Record<string, unknown>;
  registered_at: string;
}

/** Error body of the registry. */
interface Rejection {
  error: string;
  details?: string[];
}

/** Sorts keys recursively — the canonicalization the format's hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/** The pin: `sha256:` over the canonical JSON of the five content fields. */
function contentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/** The D4 safe default: read the workspace, write nothing, no network. */
const SAFE_PERMISSIONS = {
  filesystem: { read: ['**'], write: [] },
  network: { allowed: false },
};

const ONE_CHECK = [
  {
    id: 'suite-verde',
    type: 'deterministic',
    description: 'A suíte do projeto passa.',
    command: 'make test',
  },
];

/**
 * A manifest imported from an external repo, valid in every respect, with the
 * hash already computed over whatever the overrides produced.
 *
 * `hash` is applied LAST on purpose: a test that wants a tampered manifest
 * overrides it explicitly, and every other test gets a correct pin for free.
 */
function importedManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id: 'feature-dev',
    version: '0.1.0',
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    role: 'work',
    description: 'Orchestrates new feature development following the full 4-phase protocol',
    input: { type: 'object', properties: { ticket: { type: 'string' } } },
    output: { type: 'object', properties: { nota: { type: 'string' } } },
    preconditions: ['ticket refinado'],
    checks: ONE_CHECK,
    permissions: SAFE_PERMISSIONS,
    instructions: '# Feature Development Orchestrator\n\nSiga o protocolo.',
    origin: {
      type: 'imported',
      repo: 'https://github.com/rafaelgomes/flowpilot',
      ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      imported_by: 'rafael',
      imported_at: '2026-08-14',
      reviewed_by: 'rafael',
    },
    ...overrides,
  };
  if (overrides.hash === undefined) manifest.hash = contentHash(manifest);
  return manifest;
}

/** Every message the registry sent back, as one string to match against. */
function reason(body: Rejection): string {
  return [body.error, ...(body.details ?? [])].join('\n');
}

async function post(ctx: TestContext, manifest: Record<string, unknown>) {
  return await request<Skill & Rejection>(ctx, 'POST', '/v1/skills', manifest);
}

test('AT1 — a valid imported manifest is registered and comes back whole', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const manifest = importedManifest();
  const created = await post(ctx, manifest);
  assert.equal(created.status, 201, `POST /v1/skills returned ${created.status}: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.id, 'feature-dev');
  assert.equal(created.body.hash, manifest.hash);
  assert.ok(
    typeof created.body.registered_at === 'string' && created.body.registered_at.length > 0,
    'the registration has to carry the instant it happened',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 200);
  assert.equal(read.body.hash, manifest.hash);
  assert.equal(read.body.version, '0.1.0');
  assert.equal(read.body.role, 'work');
  assert.deepEqual(read.body.input, manifest.input);
  assert.deepEqual(read.body.output, manifest.output);
  assert.deepEqual(read.body.checks, manifest.checks);
  assert.deepEqual(read.body.permissions, manifest.permissions);
  assert.deepEqual(read.body.preconditions, manifest.preconditions);
  assert.deepEqual(read.body.origin, manifest.origin);
  assert.equal(read.body.instructions, manifest.instructions);

  const listed = await request<{ skills: Skill[] }>(ctx, 'GET', '/v1/skills');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.skills.map((skill) => skill.id),
    ['feature-dev'],
  );
});

test('AT2 — a manifest whose hash does not match its content is refused, naming both hashes', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const declared = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const manifest = importedManifest({ hash: declared });
  const expected = contentHash(manifest);

  const refused = await post(ctx, manifest);
  assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  const message = reason(refused.body);
  assert.match(message, new RegExp(declared), 'the message has to quote the DECLARED hash');
  assert.match(message, new RegExp(expected), 'the message has to quote the RECOMPUTED hash');

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});

test('AT3 — an imported skill with no check does not enter the registry (D4)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(ctx, importedManifest({ checks: [] }));
  assert.ok(
    refused.status >= 400 && refused.status < 500,
    `expected a 4xx, got ${refused.status}`,
  );
  assert.match(reason(refused.body), /no derivable check/i);
});

test('AT4 — a gate whose output does not declare outcome is refused, naming the field', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      role: 'gate',
      output: { type: 'object', properties: { nota: { type: 'string' } } },
    }),
  );
  assert.ok(
    refused.status >= 400 && refused.status < 500,
    `expected a 4xx, got ${refused.status}`,
  );
  assert.match(reason(refused.body), /outcome/);
  assert.match(
    reason(refused.body),
    /escalate_human/,
    'the message has to say which enum is expected',
  );
});

test('AT4 — a gate whose output declares the renamed outcome enum is accepted (t178)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const created = await post(
    ctx,
    importedManifest({
      role: 'gate',
      output: {
        type: 'object',
        required: ['outcome'],
        properties: { outcome: { enum: ['pass', 'fail', 'escalate_human'] } },
      },
    }),
  );
  assert.equal(
    created.status,
    201,
    `the renamed gate vocabulary has to register: ${created.status} ${JSON.stringify(created.body)}`,
  );
});

test('AT5 — an imported skill with unrestricted network is refused (D4)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      permissions: {
        filesystem: { read: ['**'], write: [] },
        network: { allowed: true },
      },
    }),
  );
  assert.ok(
    refused.status >= 400 && refused.status < 500,
    `expected a 4xx, got ${refused.status}`,
  );
  assert.match(reason(refused.body), /unrestricted network/i);
});

test('AT6 — an imported manifest with incomplete provenance is refused', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      origin: {
        type: 'imported',
        repo: 'https://github.com/rafaelgomes/flowpilot',
        ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        imported_by: 'rafael',
        imported_at: '2026-08-14',
      },
    }),
  );
  assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.match(reason(refused.body), /reviewed_by/);
});

test('AT7 — registering the same id twice is a conflict', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const first = await post(ctx, importedManifest());
  assert.equal(first.status, 201);

  const second = await post(ctx, importedManifest({ description: 'outra descrição para o mesmo id' }));
  assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.match(reason(second.body), /feature-dev/);

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 200);
  assert.equal(
    read.body.description,
    'Orchestrates new feature development following the full 4-phase protocol',
    'the conflict cannot have overwritten the registered manifest',
  );
});

test('AT8 — the specification\'s negative fixture is refused, naming the field and the check (t135)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const fixture = JSON.parse(readFileSync(INVALID_FIXTURE, 'utf8')) as Record<string, unknown>;

  const refused = await post(ctx, fixture);
  assert.equal(
    refused.status,
    422,
    `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  const message = reason(refused.body);
  assert.match(message, /required_evidence/, 'the message has to name the missing field');
  assert.match(
    message,
    /criterios-atendidos/,
    'the message has to name the check that broke the rule',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/portao-sem-evidencia');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});

test('AT9 — the same manifest with required_evidence declared registers (t135)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const fixture = JSON.parse(readFileSync(INVALID_FIXTURE, 'utf8')) as Record<string, unknown>;
  const checks = (fixture.checks as Record<string, unknown>[]).map((check) =>
    check.type === 'agentic'
      ? { ...check, required_evidence: ['trecho_citado_do_criterio_de_aceite'] }
      : check,
  );
  const repaired: Record<string, unknown> = { ...fixture, checks };
  repaired.hash = contentHash(repaired);

  const created = await post(ctx, repaired);
  assert.equal(
    created.status,
    201,
    `the rule cannot over-reject: ${created.status} ${JSON.stringify(created.body)}`,
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/portao-sem-evidencia');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.checks, checks);
});

test('AT10 — a deterministic check with no command is refused, naming the field and the check (t155)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      checks: [{ id: 'suite-verde', type: 'deterministic', description: 'A suíte do projeto passa.' }],
    }),
  );
  assert.equal(
    refused.status,
    422,
    `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  const message = reason(refused.body);
  assert.match(message, /command/, 'the message has to name the missing field');
  assert.match(
    message,
    /suite-verde/,
    'the message has to name the check that broke the rule',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});

test('AT11 — a check whose type is not one of the two is refused, naming the value and the enum (t155)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      checks: [{ id: 'x', type: 'nao-existe', description: 'Um check que ninguém sabe executar.' }],
    }),
  );
  assert.equal(
    refused.status,
    422,
    `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  const message = reason(refused.body);
  assert.match(message, /nao-existe/, 'the message has to quote the value it refused');
  assert.match(message, /\bx\b/, 'the message has to name the offending check');
  assert.match(message, /deterministic/, 'the message has to say which types exist');
  assert.match(message, /agentic/, 'the message has to say which types exist');

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});

test('AT12 — a check with no id, type or description is refused, naming all three (t155)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(ctx, importedManifest({ checks: [{}] }));
  assert.equal(
    refused.status,
    422,
    `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  const message = reason(refused.body);
  assert.match(message, /"id"/, 'the message has to name "id" as missing');
  assert.match(message, /"type"/, 'the message has to name "type" as missing');
  assert.match(message, /"description"/, 'the message has to name "description" as missing');

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});
