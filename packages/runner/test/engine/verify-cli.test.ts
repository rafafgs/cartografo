/**
 * The CLI preflight (`verifyCli`), run against the fake binary.
 *
 * `available` is a cheap and honest question: the binary exists and answers
 * `--version`, without spending quota. `authenticated` is another matter — the
 * specification demoted it to **best effort** in writing, after measuring an
 * engine that opens the session normally and only discovers the missing
 * credential in the middle of the stream
 * (`docs/formats/engine-adapter.md:452-461`). These tests pin exactly that: a
 * probe that promises no more than it can deliver.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-104');

const adapterWith = (options: {
  command?: { command: string; args: string[] };
  environment?: Record<string, string>;
  credentials?: string;
}): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter({
    probeCommandBuilder: () => options.command ?? { command: process.execPath, args: [FAKE, '--version'] },
    probeEnvironment: options.environment ?? {},
    credentialsPath: options.credentials ?? join(tmpdir(), 'cartografo-no-credential-104.json'),
  });

test('available is true and the version comes from the binary that answered', async () => {
  const probe = await adapterWith({}).verifyCli();

  assert.equal(probe.available, true);
  assert.equal(probe.version, '9.9.9 (Fake Engine)');
});

test('a missing binary returns available false, without throwing', async () => {
  const probe = await adapterWith({
    command: { command: MISSING_BINARY, args: ['--version'] },
  }).verifyCli();

  assert.equal(probe.available, false);
  assert.equal(probe.version, null);
});

test('a binary that answers with an error does not count as available', async () => {
  const probe = await adapterWith({
    command: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
  }).verifyCli();

  assert.equal(probe.available, false);
});

test('authenticated reflects the credential variable that is present', async () => {
  const withKey = await adapterWith({ environment: { ANTHROPIC_API_KEY: 'sk-for-testing' } }).verifyCli();
  assert.equal(withKey.authenticated, true);

  const withoutKey = await adapterWith({ environment: {} }).verifyCli();
  assert.equal(withoutKey.authenticated, false);
});

test('authenticated also accepts the OAuth account in the credential file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credentials = join(root, '.claude.json');

  try {
    writeFileSync(credentials, JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' } }));
    const withAccount = await adapterWith({ credentials }).verifyCli();
    assert.equal(withAccount.authenticated, true);

    writeFileSync(credentials, JSON.stringify({ somethingElse: true }));
    const withoutAccount = await adapterWith({ credentials }).verifyCli();
    assert.equal(withoutAccount.authenticated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt credential file does not bring the probe down', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credentials = join(root, '.claude.json');

  try {
    writeFileSync(credentials, '{ this is not json');
    const probe = await adapterWith({ credentials }).verifyCli();

    assert.equal(probe.available, true);
    assert.equal(probe.authenticated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
