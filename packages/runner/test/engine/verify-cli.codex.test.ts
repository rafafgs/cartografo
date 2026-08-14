/**
 * The Codex CLI preflight (`verifyCli`), run against the fake binary.
 *
 * Same division of promises as the Claude Code probe: `available` is a cheap
 * and honest question — the binary exists and answers `--version` without
 * spending quota — and `authenticated` is **best effort by a recorded decision**
 * of the specification, which measured this very engine opening the session
 * normally and only discovering the missing credential in the middle of the
 * stream (`docs/formatos/engine-adapter.md:452-461`).
 *
 * What the credential list is worth is not taste: it is the measurement FR8
 * demanded, run here against `codex-cli 0.147.0` and transcribed in
 * `codex-adapter.ts`. The negative case below (a credential of the OTHER
 * engine) is the control of that measurement — it is what keeps the list from
 * quietly growing into "any key-looking variable".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_CREDENTIAL_VARIABLES, CodexAdapter } from '../../src/engine/codex-adapter.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-119');

const adapterWith = (options: {
  command?: { command: string; args: string[] };
  environment?: Record<string, string>;
  credentials?: string;
}): CodexAdapter =>
  new CodexAdapter({
    probeCommandBuilder: () =>
      options.command ?? { command: process.execPath, args: [FAKE, '--version'] },
    probeEnvironment: options.environment ?? {},
    credentialsPath: options.credentials ?? join(tmpdir(), 'cartografo-no-credential-119.json'),
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

test('authenticated reflects every credential variable the CLI confirmed', async () => {
  // The three names `codex doctor` answered "auth is provided by environment"
  // to, one at a time. `OPENAI_API_KEY` is the one FR8 demanded at minimum; the
  // other two came out of the same measurement.
  assert.deepEqual(
    [...CODEX_CREDENTIAL_VARIABLES],
    ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
  );

  for (const name of CODEX_CREDENTIAL_VARIABLES) {
    const probe = await adapterWith({ environment: { [name]: 'sk-for-testing' } }).verifyCli();
    assert.equal(probe.authenticated, true, `${name} is a credential the CLI recognizes`);
  }

  const empty = await adapterWith({ environment: {} }).verifyCli();
  assert.equal(empty.authenticated, false);
});

test('a credential of the OTHER engine does not authenticate this one', async () => {
  // The control of the measurement: with `ANTHROPIC_API_KEY` set and nothing
  // else, `codex doctor` still answered "no Codex credentials were found".
  const probe = await adapterWith({ environment: { ANTHROPIC_API_KEY: 'sk-ant-for-testing' } }).verifyCli();

  assert.equal(probe.authenticated, false);
});

test('authenticated also accepts the credential file the CLI writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credentials = join(root, 'auth.json');

  try {
    // `codex login` with an API key: "it will be stored locally in auth.json".
    writeFileSync(credentials, JSON.stringify({ OPENAI_API_KEY: 'sk-stored-by-the-cli' }));
    assert.equal((await adapterWith({ credentials }).verifyCli()).authenticated, true);

    // `codex login` through the browser: the OAuth tokens land in the same file.
    writeFileSync(
      credentials,
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'x', account_id: 'y' } }),
    );
    assert.equal((await adapterWith({ credentials }).verifyCli()).authenticated, true);

    writeFileSync(credentials, JSON.stringify({ somethingElse: true }));
    assert.equal((await adapterWith({ credentials }).verifyCli()).authenticated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a corrupt credential file does not bring the probe down', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credentials = join(root, 'auth.json');

  try {
    writeFileSync(credentials, '{ this is not json');
    const probe = await adapterWith({ credentials }).verifyCli();

    assert.equal(probe.available, true);
    assert.equal(probe.authenticated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
