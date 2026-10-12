/**
 * The Copilot CLI preflight (`verifyCli`), run against the fake binary (t675).
 *
 * `available` is a cheap and honest question — the binary answers `--version`
 * with no network and no quota (`copilot --version` was measured offline).
 * `authenticated` is best effort, and for this engine it is ENV-ONLY:
 *
 * - `copilot login --help` says the token is stored "securely in the system
 *   credential store" and only falls back to "a plain text config file under
 *   ~/.copilot/" when no store works, without naming the file or its layout;
 * - a fresh `COPILOT_HOME` after the very first headless run already holds a
 *   `config.json` (`{"firstLaunchAt": …}`), with nobody logged in. A presence
 *   check on that file would answer "authenticated" for a CLI that never was.
 *
 * So the only signal read is the three variables the CLI documents, in its own
 * precedence order. A stored login is not seen by this probe, and the probe
 * says so rather than guessing at a file nobody measured.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPILOT_CREDENTIAL_VARIABLES, CopilotAdapter } from '../../src/engine/copilot-adapter.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** A path guaranteed not to exist, for the missing-binary case. */
const MISSING_BINARY = join(tmpdir(), 'cartografo-binary-that-does-not-exist-675');

const adapterWith = (options: {
  command?: { command: string; args: string[] };
  environment?: Record<string, string>;
}): CopilotAdapter =>
  new CopilotAdapter({
    probeCommandBuilder: () =>
      options.command ?? { command: process.execPath, args: [FAKE, '--version'] },
    probeEnvironment: options.environment ?? {},
  });

test('available is true and the version comes from the binary that answered', async () => {
  const probe = await adapterWith({}).verifyCli();

  assert.equal(probe.available, true);
  assert.equal(probe.version, '9.9.9 (Fake Engine)');
});

test('a multi-line --version answer is reduced to its first line', async () => {
  // Measured against 1.0.95: `copilot --version` prints the version AND a hint
  // ("Run 'copilot update' to check for updates."). The probe reports the
  // version, not the hint.
  const probe = await adapterWith({
    command: {
      command: process.execPath,
      args: ['-e', 'console.log("GitHub Copilot CLI 1.0.95.\\nRun \'copilot update\' to check for updates.")'],
    },
  }).verifyCli();

  assert.equal(probe.available, true);
  assert.equal(probe.version, 'GitHub Copilot CLI 1.0.95.');
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

test('authenticated is true for each of the three credential variables', async () => {
  // In the CLI's own precedence order (`copilot help environment`).
  assert.deepEqual(
    [...COPILOT_CREDENTIAL_VARIABLES],
    ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  );

  for (const name of COPILOT_CREDENTIAL_VARIABLES) {
    const probe = await adapterWith({ environment: { [name]: 'token-for-testing' } }).verifyCli();
    assert.equal(probe.authenticated, true, `${name} is a credential the CLI recognizes`);
  }
});

test('authenticated is false with none of them, blank ones, or another engine\'s credential', async () => {
  assert.equal((await adapterWith({ environment: {} }).verifyCli()).authenticated, false);

  for (const name of COPILOT_CREDENTIAL_VARIABLES) {
    assert.equal(
      (await adapterWith({ environment: { [name]: '   ' } }).verifyCli()).authenticated,
      false,
      `a blank ${name} is no credential`,
    );
  }

  const other = await adapterWith({
    environment: { OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x', CODEX_API_KEY: 'x' },
  }).verifyCli();
  assert.equal(other.authenticated, false);
});

test('a config.json under COPILOT_HOME is NOT a credential: a fresh one exists with nobody logged in', async () => {
  const home = mkdtempSync(join(tmpdir(), 'cartografo-copilot-home-'));
  try {
    // Byte for byte what the CLI wrote on its first headless run (1.0.95).
    writeFileSync(
      join(home, 'config.json'),
      '// User settings belong in settings.json.\n// This file is managed automatically.\n' +
        '{\n  "firstLaunchAt": "2026-10-12T09:47:40.531Z"\n}\n',
    );

    const probe = await adapterWith({ environment: { COPILOT_HOME: home } }).verifyCli();

    assert.equal(probe.available, true);
    assert.equal(probe.authenticated, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
