/**
 * Acceptance tests of the CLI routing (t108, FR1/FR7).
 *
 * What this file protects is compatibility: the command gained subcommands, and
 * the startup — which used to be the only thing it did — is still the default
 * behaviour, with no argument at all. That is why the first two tests reassert
 * t100's AT9 (`test/startup.test.ts`) from outside the router, instead of
 * trusting that it did not touch the old path.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { temporaryArea, runCli, startControlPlane } from './cli-support.ts';

test('AT1 — with no subcommand, the command still starts the control plane and serves /health', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'data', 'cartografo.db'),
  });

  assert.equal(controlPlane.readiness.event, 'cartografo.ready');
  const response = await fetch(`${controlPlane.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
});

test('AT2 — an explicit `up` behaves exactly like the startup with no argument', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'dados', 'cartografo.db'),
    args: ['up'],
  });

  assert.equal(controlPlane.readiness.event, 'cartografo.ready');
  assert.ok(
    controlPlane.readiness.migrationsApplied >= 1,
    'the first startup has to apply at least the initial migration',
  );
  const response = await fetch(`${controlPlane.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
});

test('AT3 — `--help` exits 0 and lists the four subcommands', { timeout: 60_000 }, async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag]);
    assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
    for (const subcommand of ['up', 'import', 'export', 'status']) {
      assert.match(result.stdout, new RegExp(`\\b${subcommand}\\b`), `${flag} has to mention "${subcommand}"`);
    }
  }
});

test('AT4 — an unknown subcommand exits non-zero and prints the usage on stderr', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  const unknown = await runCli(['bogus-command']);

  assert.notEqual(unknown.code, 0, 'an unknown command cannot exit 0');
  assert.equal(unknown.stdout, '', 'on an error, nothing goes to stdout');
  assert.match(unknown.stderr, /bogus-command/);
  for (const subcommand of ['up', 'import', 'export', 'status']) {
    assert.match(
      unknown.stderr,
      new RegExp(`\\b${subcommand}\\b`),
      'the usage printed on stderr is the same one as --help',
    );
  }
  assert.ok(
    unknown.stderr.includes(help.stdout.trim()),
    'the usage printed on stderr has to be literally the same text as --help',
  );
});

/**
 * Where the manifest's field names are actually declared (t178, FR5).
 *
 * The help text is the one place in this package that spells a manifest field
 * out in prose for a person to read, and prose is exactly what a key rename
 * walks past: every fixture and every validator moved to `origin.imported_by`
 * while `--help` kept telling people to fill in `origem.importado_por`, and no
 * test noticed because no test read the help text as a claim about the format.
 * So this one does not hardcode the new names — it pins them to the schema, the
 * same way `domain-manifest-fields.test.ts` pins the domain port.
 */
const ORIGIN_PROPERTIES: readonly string[] = (() => {
  const schemaPath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'specs',
    'formats',
    'skill-manifest.schema.json',
  );
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    $defs?: { origin?: { properties?: Record<string, unknown> } };
  };
  const properties = schema.$defs?.origin?.properties;
  assert.ok(properties !== undefined, 'the manifest schema has to declare $defs.origin.properties');
  return Object.keys(properties);
})();

test('AT5 — `--help` cites the scan-skill options by their schema field names', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, `stderr:\n${help.stderr}`);

  // The two options that carry provenance into the manifest, by the names the
  // schema declares — `--repo` fills `origin.repo`, `--by` fills the field the
  // schema calls `imported_by`.
  assert.ok(ORIGIN_PROPERTIES.includes('repo') && ORIGIN_PROPERTIES.includes('imported_by'));
  assert.match(help.stdout, /--repo <repo>[^\n]*\borigin\.repo\b/);
  assert.match(help.stdout, /--by <name>[^\n]*\borigin\.imported_by\b/);

  // And nothing in the help text names a field of `origin` that the schema does
  // not have: `origem.repo` and `origin.importado_por` both fail here.
  const cited = [...help.stdout.matchAll(/\b(?:origin|origem)\.([A-Za-z_][A-Za-z0-9_]*)/g)];
  const unknownFields = cited
    .filter((match) => !match[0].startsWith('origin.') || !ORIGIN_PROPERTIES.includes(match[1]))
    .map((match) => match[0]);
  assert.deepEqual(
    unknownFields,
    [],
    `--help names fields that $defs.origin does not declare: ${unknownFields.join(', ')}`,
  );
});
