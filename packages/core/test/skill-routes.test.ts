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
 * (`specs/formats/skill-manifest.md`).
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
  loadEvents,
  request,
  requireArtifacts,
  startControlPlane,
  type Event,
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
  'specs',
  'formats',
  'examples',
  'skill-manifest.invalid.fixture.json',
);

/** Artifacts of this ticket; every test names them before touching the API. */
const T117_ARTIFACTS = Object.freeze({
  migration: 'migrations/0005_skill.sql',
  manifestDomain: 'src/domain/manifest.ts',
  repository: 'src/repositories/skill.ts',
  routes: 'src/routes/skills.ts',
});

const ARTIFACTS = Object.values(T117_ARTIFACTS);

/** The migration that turns the registry into a lineage (t215, FR1). */
const T215_MIGRATION = 'migrations/0019_skill_versao.sql';

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
  /** When this version was retired (t215, FR7); `null` while it is live. */
  deprecated_at: string | null;
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
    description: 'The project suite passes.',
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
      repo: 'https://github.com/octo-org/flowpilot',
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
        repo: 'https://github.com/octo-org/flowpilot',
        ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        imported_by: 'rafael',
        imported_at: '2026-08-14',
      },
    }),
  );
  assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.match(reason(refused.body), /reviewed_by/);
});

/**
 * AT7 used to demand a 409 here, and t215 is why it does not any more.
 *
 * The content hash deliberately excludes `id`, `version` and `description`
 * (`domain/manifest.ts`), so a second POST that only rewords the description is
 * the SAME content under the same `(id, version)` — which FR2 answers `200`
 * with the row that is already there. What the case still measures is the half
 * that never changed: a repeated write is not an UPDATE. The registered
 * description survives, because the registry hands back what it stored instead
 * of taking the newer prose. The 409 moved to where the conflict really is —
 * changed content under an unchanged version, in the t215 block below.
 */
test('AT7 — registering the same id and version again is idempotent, never an update (t215)', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  const first = await post(ctx, importedManifest());
  assert.equal(first.status, 201);

  const second = await post(ctx, importedManifest({ description: 'another description for the same id' }));
  assert.equal(second.status, 200, `expected 200, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.equal(second.body.id, 'feature-dev');
  assert.equal(
    second.body.registered_at,
    first.body.registered_at,
    'an idempotent write does not re-stamp the registration',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 200);
  assert.equal(
    read.body.description,
    'Orchestrates new feature development following the full 4-phase protocol',
    'a repeated registration cannot have overwritten the registered manifest',
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
    /criteria-met/,
    'the message has to name the check that broke the rule',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/gate-without-evidence');
  assert.equal(read.status, 404, 'a refused manifest cannot leave a row behind');
});

test('AT9 — the same manifest with required_evidence declared registers (t135)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const fixture = JSON.parse(readFileSync(INVALID_FIXTURE, 'utf8')) as Record<string, unknown>;
  const checks = (fixture.checks as Record<string, unknown>[]).map((check) =>
    check.type === 'agentic'
      ? { ...check, required_evidence: ['quoted_passage_of_the_acceptance_criterion'] }
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

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/gate-without-evidence');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.checks, checks);
});

test('AT10 — a deterministic check with no command is refused, naming the field and the check (t155)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      checks: [{ id: 'suite-verde', type: 'deterministic', description: 'The project suite passes.' }],
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
      checks: [{ id: 'x', type: 'does-not-exist', description: 'A check nobody knows how to run.' }],
    }),
  );
  assert.equal(
    refused.status,
    422,
    `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  const message = reason(refused.body);
  assert.match(message, /does-not-exist/, 'the message has to quote the value it refused');
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

/* -------------------------------------------------------------------------- */
/* t215 — the registry is a lineage: versions of one skill coexist (D22).      */
/*                                                                            */
/* The registry was one row per id until here, and D22 says it is one row per  */
/* (id, version): "a skill has a stable id and versions (semver plus a content */
/* hash)... a node stays pinned by hash (D4) and never resolves 'the latest    */
/* one'". So the cases below are about the two reads that tell those apart     */
/* — the one that follows the lineage forward, and the one that pins an exact  */
/* row — plus the three writes: a version that is new, a version whose content */
/* moved underneath it, and a version taken out of the lineage's future.       */
/* -------------------------------------------------------------------------- */

/** The two versions every case below registers, told apart by their body. */
const V1 = '1.0.0';
const V2 = '1.1.0';
const V1_TEXT = '# Feature Development Orchestrator\n\nSiga o protocolo.';
const V2_TEXT = '# Feature Development Orchestrator\n\nFollow the protocol, now with phase 5.';

/** Registers one version of `feature-dev`, asserting the status it deserves. */
async function register(
  ctx: TestContext,
  version: string,
  instructions: string,
  expected = 201,
): Promise<Skill> {
  const created = await post(ctx, importedManifest({ version, instructions }));
  assert.equal(
    created.status,
    expected,
    `POST /v1/skills ${version} returned ${created.status}: ${JSON.stringify(created.body)}`,
  );
  return created.body;
}

/** `GET /v1/skills/feature-dev`, with whatever query the case is asking about. */
async function readSkill(ctx: TestContext, query = ''): Promise<{ status: number; body: Skill }> {
  const answer = await request<Skill>(ctx, 'GET', `/v1/skills/feature-dev${query}`);
  return { status: answer.status, body: answer.body };
}

test('t215 AT — two versions of one skill coexist, and only the pinned read is exact', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  const first = await register(ctx, V1, V1_TEXT);
  const second = await register(ctx, V2, V2_TEXT);
  assert.notEqual(first.hash, second.hash, 'the fixture has to give the two versions different content');

  // No query: the latest live version. This is the ONLY read that resolves
  // "forward", and it is deliberately not the one the runner uses (FR4).
  const latest = await readSkill(ctx);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.version, V2);
  assert.equal(latest.body.instructions, V2_TEXT);
  assert.equal(latest.body.deprecated_at, null, 'a live version carries no retirement stamp');

  // `?version=`: the exact row, which is what keeps a map pinned to 1.0.0
  // running after 1.1.0 lands — D22: improving a skill never breaks a map
  // pinned to it.
  const pinned = await readSkill(ctx, `?version=${V1}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.version, V1);
  assert.equal(pinned.body.instructions, V1_TEXT);
  assert.equal(pinned.body.hash, first.hash);

  // `?hash=`: the same row, reached from the pin the graph really carries.
  const byHash = await readSkill(ctx, `?hash=${encodeURIComponent(first.hash)}`);
  assert.equal(byHash.status, 200);
  assert.equal(byHash.body.version, V1);

  const missing = await readSkill(ctx, '?version=9.9.9');
  assert.equal(missing.status, 404, 'a version the lineage does not carry is a 404, not the latest');

  // The list stays FLAT — one entry per (id, version), no lineage envelope —
  // so a capability reader sees no shape change from this ticket (FR3).
  const listed = await request<{ skills: Skill[] }>(ctx, 'GET', '/v1/skills?id=feature-dev');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.skills.map((skill) => `${skill.id}@${skill.version}`),
    [`feature-dev@${V1}`, `feature-dev@${V2}`],
    'the lineage lists every version, in version order',
  );
});

test('t215 AT — the same version with the same content is a 200, with the original stamp', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  const created = await register(ctx, V1, V1_TEXT);
  const again = await register(ctx, V1, V1_TEXT, 200);

  assert.equal(
    again.registered_at,
    created.registered_at,
    'an idempotent reimport does not claim a write that did not happen',
  );
  assert.equal(again.hash, created.hash);

  const listed = await request<{ skills: Skill[] }>(ctx, 'GET', '/v1/skills');
  assert.deepEqual(
    listed.body.skills.map((skill) => `${skill.id}@${skill.version}`),
    [`feature-dev@${V1}`],
    'the second POST did not add a row',
  );
});

test('t215 AT — content that moved under an unchanged version is a 409 that says to bump it', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  const created = await register(ctx, V1, V1_TEXT);

  const refused = await post(ctx, importedManifest({ version: V1, instructions: V2_TEXT }));
  assert.equal(
    refused.status,
    409,
    `expected 409, got ${refused.status}: ${JSON.stringify(refused.body)}`,
  );
  assert.equal(refused.body.error, 'skill_version_conflict');
  const message = reason(refused.body);
  assert.match(message, /feature-dev/, 'the refusal has to name the skill');
  assert.match(message, new RegExp(V1.replace(/\./g, '\\.')), 'and the version that is taken');
  assert.match(message, /bump/i, 'and the way out, which is a new version');

  // Nothing moved: the row is the one that was registered first.
  const stored = await readSkill(ctx, `?version=${V1}`);
  assert.equal(stored.status, 200);
  assert.equal(stored.body.instructions, V1_TEXT, 'a conflict cannot rewrite the registered content');
  assert.equal(stored.body.hash, created.hash);
  assert.equal(stored.body.registered_at, created.registered_at);
});

test('t215 AT — retiring a version takes it out of "latest" and out of nothing else', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  await register(ctx, V1, V1_TEXT);
  const second = await register(ctx, V2, V2_TEXT);

  const retired = await request<Skill>(ctx, 'PATCH', `/v1/skills/feature-dev/${V2}`);
  assert.equal(retired.status, 200, `expected 200, got ${retired.status}: ${JSON.stringify(retired.body)}`);
  assert.ok(
    typeof retired.body.deprecated_at === 'string' && retired.body.deprecated_at.length > 0,
    'retiring a version has to record when it happened',
  );

  // "Latest" skips it...
  const latest = await readSkill(ctx);
  assert.equal(latest.status, 200);
  assert.equal(latest.body.version, V1, 'a deprecated version is not what a fresh graph should pin');

  // ...and every exact read still resolves it, unchanged. A retirement must
  // never look like "this skill stopped existing" to a node pinned to it (D22).
  const pinned = await readSkill(ctx, `?version=${V2}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.instructions, V2_TEXT);
  assert.equal(pinned.body.hash, second.hash);
  assert.equal(pinned.body.deprecated_at, retired.body.deprecated_at);

  const byHash = await readSkill(ctx, `?hash=${encodeURIComponent(second.hash)}`);
  assert.equal(byHash.status, 200);
  assert.equal(byHash.body.version, V2);

  // First write wins, same posture as `registered_at`.
  const twice = await request<Skill>(ctx, 'PATCH', `/v1/skills/feature-dev/${V2}`);
  assert.equal(twice.status, 200);
  assert.equal(
    twice.body.deprecated_at,
    retired.body.deprecated_at,
    'a second retirement does not re-stamp the first',
  );

  const unknown = await request<Skill>(ctx, 'PATCH', '/v1/skills/feature-dev/9.9.9');
  assert.equal(unknown.status, 404, 'retiring a version that does not exist is a 404');
});

test('t215 AT — a lineage whose every version is retired still resolves, never a 404', async (t) => {
  requireArtifacts(...ARTIFACTS, T215_MIGRATION);
  const ctx = await startControlPlane(t);

  await register(ctx, V1, V1_TEXT);
  await register(ctx, V2, V2_TEXT);
  for (const version of [V1, V2]) {
    const retired = await request<Skill>(ctx, 'PATCH', `/v1/skills/feature-dev/${version}`);
    assert.equal(retired.status, 200);
  }

  const latest = await readSkill(ctx);
  assert.equal(latest.status, 200, 'deprecating everything must not make the lineage look unregistered');
  assert.equal(latest.body.version, V2, 'with nothing live, the highest version overall answers');
  assert.ok(typeof latest.body.deprecated_at === 'string');
});

/* -------------------------------------------------------------------------- */
/* t283 — registering a manifest re-judges the versions that were waiting.     */
/*                                                                             */
/* `POST /v1/graphs` stores a document whose pins do not resolve as            */
/* `unchecked`, and `POST /v1/jobs` refuses to run anything against it. That   */
/* is only half a design unless something moves the version afterwards: this   */
/* is that something, and it is the registry's own write that triggers it.     */
/* -------------------------------------------------------------------------- */

/** The one node the fixtures below pin, per skill id — a chain `a → b`. */
function twoNodeGraph(className: string, pins: Array<{ id: string; version: string; hash: string }>) {
  const node = (id: string, pin: { id: string; version: string; hash: string }) => ({
    id,
    role: 'fixture',
    node_type: 'work',
    skill_ref: pin,
    contract: {
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      checks: [
        {
          type: 'agentic',
          instruction: 'Confirm what the node produced.',
          required_evidence: true,
          description: 'the document declares its own check',
        },
      ],
    },
  });

  return {
    problem_class: className,
    lineage: { type: 'base' },
    metadata: { name: className },
    nodes: [node('a', pins[0]), node('b', pins[1])],
    edges: [{ from: 'a', to: 'b', condition: 'sempre' }],
    initial_node: 'a',
    final_nodes: ['b'],
    custom_fields: [],
  };
}

/** A native manifest carrying the two schemas the contract check reads. */
function contractManifest(
  id: string,
  contract: { input?: Record<string, unknown>; output?: Record<string, unknown> },
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id,
    version: '1.0.0',
    hash: '',
    role: 'work',
    description: `fixture skill "${id}" of the t283 re-check cases`,
    input: contract.input ?? { type: 'object' },
    output: contract.output ?? { type: 'object' },
    preconditions: [],
    checks: ONE_CHECK,
    permissions: SAFE_PERMISSIONS,
    instructions: `Fixture skill "${id}".`,
    origin: { type: 'native' },
  };
  manifest.hash = contentHash(manifest);
  return manifest;
}

/** A pin for a manifest that has not been registered (and may never be). */
function pinOf(manifest: Record<string, unknown>): { id: string; version: string; hash: string } {
  return {
    id: manifest.id as string,
    version: manifest.version as string,
    hash: manifest.hash as string,
  };
}

/** The version, as `GET /v1/graph-versions/:id` publishes it (t283). */
interface StoredVersion {
  id: string;
  contracts: {
    state: 'checked' | 'unchecked' | 'failed';
    problems: Array<{ code: string; node_id: string; key?: string; message: string }>;
  };
}

async function readVersion(ctx: TestContext, id: string): Promise<StoredVersion> {
  const response = await request<{ graph_version: StoredVersion }>(
    ctx,
    'GET',
    `/v1/graph-versions/${encodeURIComponent(id)}`,
  );
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.graph_version;
}

/** Every `graph_version.contracts_checked` in the log, oldest first. */
async function recheckEvents(ctx: TestContext): Promise<Event[]> {
  const { listEvents } = await loadEvents();
  return listEvents(ctx.db).filter((event) => event.type === 'graph_version.contracts_checked');
}

test('t283 — registering the last missing manifest moves the version to checked, once', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const producer = contractManifest('produtor-t283', {});
  const consumer = contractManifest('consumidor-t283', {});

  // The graph goes in FIRST, with neither manifest registered: the ordinary
  // case for this route, and the one that used to end there.
  const registered = await request<{ graph_version: StoredVersion }>(ctx, 'POST', '/v1/graphs',
    twoNodeGraph('classe-que-esperava', [pinOf(producer), pinOf(consumer)]));
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const versionId = registered.body.graph_version.id;
  assert.equal(registered.body.graph_version.contracts.state, 'unchecked');

  // The first manifest resolves one pin of two: the version cannot move yet,
  // and the re-check has to say so rather than declaring a partial pass.
  assert.equal((await post(ctx, producer)).status, 201);
  assert.equal((await readVersion(ctx, versionId)).contracts.state, 'unchecked');
  const afterFirst = await recheckEvents(ctx);
  assert.equal(afterFirst.length, 1, 'the version was re-judged, and it stayed where it was');
  assert.deepEqual(afterFirst[0].data, { state: 'unchecked', problem_count: 1 });
  assert.deepEqual(afterFirst[0].entity, { type: 'graph_version', id: versionId });
  assert.deepEqual(afterFirst[0].actor, { type: 'system', ref: 'control-plane' });

  // The second one resolves the last pin, and now the whole document can be
  // judged — which is what `checked` means.
  assert.equal((await post(ctx, consumer)).status, 201);
  const moved = await readVersion(ctx, versionId);
  assert.equal(moved.contracts.state, 'checked');
  assert.deepEqual(moved.contracts.problems, []);

  const events = await recheckEvents(ctx);
  assert.equal(events.length, 2, 'one event per manifest that re-judged this version');
  assert.deepEqual(events[1].data, { state: 'checked', problem_count: 0 });
});

test('t283 — a re-check that resolves the last pin may land on failed', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  // The consumer requires a key the producer places nowhere. While the producer
  // was unregistered that was unknowable — a missing manifest produces nothing,
  // so every descendant looks starved for want of a registry entry. With both
  // registered the finding is real, and the version earns `failed`.
  const producer = contractManifest('produtor-vazio-t283', {});
  const consumer = contractManifest('consumidor-exigente-t283', {
    input: { type: 'object', required: ['tese_triada'], properties: { tese_triada: { type: 'object' } } },
  });

  const registered = await request<{ graph_version: StoredVersion }>(ctx, 'POST', '/v1/graphs',
    twoNodeGraph('classe-que-nao-fecha', [pinOf(producer), pinOf(consumer)]));
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  const versionId = registered.body.graph_version.id;

  assert.equal((await post(ctx, consumer)).status, 201);
  assert.equal((await post(ctx, producer)).status, 201);

  const judged = await readVersion(ctx, versionId);
  assert.equal(judged.contracts.state, 'failed');
  assert.deepEqual(
    judged.contracts.problems.map((problem) => [problem.code, problem.node_id, problem.key]),
    [['unproduced_input', 'b', 'tese_triada']],
  );

  const events = await recheckEvents(ctx);
  assert.equal(events[events.length - 1].data.state, 'failed');
  assert.equal(events[events.length - 1].data.problem_count, 1);
});

test('t283 — a same-hash reimport re-checks nothing and records nothing', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const producer = contractManifest('produtor-idempotente-t283', {});
  const consumer = contractManifest('consumidor-idempotente-t283', {});

  const registered = await request<{ graph_version: StoredVersion }>(ctx, 'POST', '/v1/graphs',
    twoNodeGraph('classe-reimportada', [pinOf(producer), pinOf(consumer)]));
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  assert.equal((await post(ctx, producer)).status, 201);
  assert.equal((await post(ctx, consumer)).status, 201);
  const before = await recheckEvents(ctx);
  assert.equal(before.length, 2);

  // The second `cartografo import` of a bundle: same content, same hash, 200
  // and no row written. Nothing about the registry changed, so no version's
  // answer could have changed either — and a re-check here would stack an
  // identical event on every rerun.
  const reimport = await post(ctx, producer);
  assert.equal(reimport.status, 200, 'a same-hash reimport is not a write');

  assert.deepEqual(
    await recheckEvents(ctx),
    before,
    'no re-check, no event: the log does not grow on a rerun that changed nothing',
  );
});
