/**
 * Skill-registry acceptance tests (t117, AT1–AT7).
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
 * `sha256` of the canonical JSON of `{instrucoes, entrada, saida, checks, permissoes}`
 * (`especificacoes/formatos/manifesto-skill.md`).
 *
 * The manifest field names stay in Portuguese: they are the skill-manifest
 * format's own vocabulary, which the D18 rename explicitly leaves out
 * (`DECISOES.md:153-155`).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { request, requireArtifacts, startControlPlane, type TestContext } from './support.ts';

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
  versao: string;
  hash: string;
  papel: string;
  descricao: string;
  entrada: Record<string, unknown>;
  saida: Record<string, unknown>;
  pre_condicoes: string[];
  checks: Record<string, unknown>[];
  permissoes: Record<string, unknown>;
  instrucoes: string;
  origem: Record<string, unknown>;
  registrado_em: string;
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
    instrucoes: manifest.instrucoes,
    entrada: manifest.entrada,
    saida: manifest.saida,
    checks: manifest.checks,
    permissoes: manifest.permissoes,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/** The D4 safe default: read the workspace, write nothing, no network. */
const SAFE_PERMISSIONS = {
  filesystem: { leitura: ['**'], escrita: [] },
  rede: { permitido: false },
};

const ONE_CHECK = [
  {
    id: 'suite-verde',
    tipo: 'deterministico',
    descricao: 'A suíte do projeto passa.',
    comando: 'make test',
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
    versao: '0.1.0',
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    papel: 'fazer',
    descricao: 'Orchestrates new feature development following the full 4-phase protocol',
    entrada: { type: 'object', properties: { ticket: { type: 'string' } } },
    saida: { type: 'object', properties: { nota: { type: 'string' } } },
    pre_condicoes: ['ticket refinado'],
    checks: ONE_CHECK,
    permissoes: SAFE_PERMISSIONS,
    instrucoes: '# Feature Development Orchestrator\n\nSiga o protocolo.',
    origem: {
      tipo: 'importada',
      repo: 'https://github.com/rafaelgomes/flowpilot',
      ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      importado_por: 'rafael',
      importado_em: '2026-08-14',
      revisado_por: 'rafael',
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
    typeof created.body.registrado_em === 'string' && created.body.registrado_em.length > 0,
    'the registration has to carry the instant it happened',
  );

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 200);
  assert.equal(read.body.hash, manifest.hash);
  assert.equal(read.body.versao, '0.1.0');
  assert.equal(read.body.papel, 'fazer');
  assert.deepEqual(read.body.entrada, manifest.entrada);
  assert.deepEqual(read.body.saida, manifest.saida);
  assert.deepEqual(read.body.checks, manifest.checks);
  assert.deepEqual(read.body.permissoes, manifest.permissoes);
  assert.deepEqual(read.body.pre_condicoes, manifest.pre_condicoes);
  assert.deepEqual(read.body.origem, manifest.origem);
  assert.equal(read.body.instrucoes, manifest.instrucoes);

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

test('AT4 — a gate whose saida does not declare resultado is refused, naming the field', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      papel: 'portao',
      saida: { type: 'object', properties: { nota: { type: 'string' } } },
    }),
  );
  assert.ok(
    refused.status >= 400 && refused.status < 500,
    `expected a 4xx, got ${refused.status}`,
  );
  assert.match(reason(refused.body), /resultado/);
  assert.match(reason(refused.body), /passou/, 'the message has to say which enum is expected');
});

test('AT5 — an imported skill with unrestricted network is refused (D4)', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const refused = await post(
    ctx,
    importedManifest({
      permissoes: {
        filesystem: { leitura: ['**'], escrita: [] },
        rede: { permitido: true },
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
      origem: {
        tipo: 'importada',
        repo: 'https://github.com/rafaelgomes/flowpilot',
        ref: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        importado_por: 'rafael',
        importado_em: '2026-08-14',
      },
    }),
  );
  assert.equal(refused.status, 422, `expected 422, got ${refused.status}: ${JSON.stringify(refused.body)}`);
  assert.match(reason(refused.body), /revisado_por/);
});

test('AT7 — registering the same id twice is a conflict', async (t) => {
  requireArtifacts(...ARTIFACTS);
  const ctx = await startControlPlane(t);

  const first = await post(ctx, importedManifest());
  assert.equal(first.status, 201);

  const second = await post(ctx, importedManifest({ descricao: 'outra descrição para o mesmo id' }));
  assert.equal(second.status, 409, `expected 409, got ${second.status}: ${JSON.stringify(second.body)}`);
  assert.match(reason(second.body), /feature-dev/);

  const read = await request<Skill>(ctx, 'GET', '/v1/skills/feature-dev');
  assert.equal(read.status, 200);
  assert.equal(
    read.body.descricao,
    'Orchestrates new feature development following the full 4-phase protocol',
    'the conflict cannot have overwritten the registered manifest',
  );
});
