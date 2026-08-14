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
import path from 'node:path';
import test from 'node:test';

import { temporaryArea, runCli, startControlPlane } from './cli-support.ts';

test('AT1 — with no subcommand, the command still starts the control plane and serves /health', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'dados', 'cartografo.db'),
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
