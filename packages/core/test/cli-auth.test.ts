/**
 * Acceptance tests of the CLI's half of the credential (t124, FR6).
 *
 * The CLI is an HTTP client like any other (D1, D11), so the day the API starts
 * denying anonymous requests every subcommand starts failing — and the only
 * thing that decides whether that is a two-second fix or a half-hour of
 * confusion is what lands on stderr. A raw `{"erro":"credencial_ausente"}` dump
 * says the server refused; it does not say the reader has a token printed on
 * their own terminal from step 2 of the quickstart.
 *
 * `status` is the subcommand under test because it is the cheapest round trip
 * that touches `/v1`; `import` appears once to prove the translation lives in
 * `cli/url.ts`'s single request function and not in one subcommand.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  FACTORY_BUNDLE,
  looksLikeStackTrace,
  runCli,
  startControlPlane,
  temporaryArea,
} from './cli-support.ts';

test('t124 AT — a subcommand with no token fails with an actionable message, not a JSON dump', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t124-cli-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });

  const denied = await runCli(['status', '--url', controlPlane.url]);

  assert.notEqual(denied.code, 0, 'a request the control plane refuses cannot exit 0');
  assert.match(denied.stderr, /401/, 'the message says what the server answered');
  assert.match(denied.stderr, /CARTOGRAFO_TOKEN/, 'and where to put the token');
  assert.match(denied.stderr, /--token/, 'and the flag that overrides it');
  assert.doesNotMatch(
    denied.stderr,
    /credencial_ausente|\{"erro"/,
    'the wire error code is not a message for a person',
  );
  assert.equal(looksLikeStackTrace(denied.stderr), false, 'no stack trace leaks to the user');

  // Same translation for a different subcommand: it lives in `requestJson`.
  const importDenied = await runCli(['import', FACTORY_BUNDLE, '--url', controlPlane.url]);
  assert.notEqual(importDenied.code, 0);
  assert.match(importDenied.stderr, /CARTOGRAFO_TOKEN/);
});

test('t124 AT — --token and CARTOGRAFO_TOKEN both authenticate, with --token winning', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t, 'cartografo-t124-cli-');
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });
  const { token } = controlPlane;
  assert.equal(typeof token, 'string', 'the readiness line carries the bootstrap token');

  const withFlag = await runCli(['status', '--json', '--url', controlPlane.url, '--token', token]);
  assert.equal(withFlag.code, 0, `stderr:\n${withFlag.stderr}`);
  // The two counts are `0` and not `null` since t199 (FR1): the control plane is
  // brand new, so the honest answer is "queried, and empty". What this test is
  // about is the credential, and the whole report is compared only because an
  // authenticated `status` has to come back complete.
  assert.deepEqual(JSON.parse(withFlag.stdout.trim()), {
    server: 'ok',
    projects: [],
    jobs: 0,
    pendingInputRequests: 0,
  });

  const withEnv = await runCli(['status', '--json', '--url', controlPlane.url], {
    env: { CARTOGRAFO_TOKEN: token },
  });
  assert.equal(withEnv.code, 0, `stderr:\n${withEnv.stderr}`);
  assert.equal(withEnv.stdout, withFlag.stdout, 'the two ways of passing it are the same request');

  // Precedence: the flag is what someone types to override a shell that is
  // already exporting the wrong token, so it has to win.
  const flagOverEnv = await runCli(
    ['status', '--json', '--url', controlPlane.url, '--token', token],
    { env: { CARTOGRAFO_TOKEN: 'nao-e-um-token-valido' } },
  );
  assert.equal(flagOverEnv.code, 0, `stderr:\n${flagOverEnv.stderr}`);

  const badEnv = await runCli(['status', '--json', '--url', controlPlane.url], {
    env: { CARTOGRAFO_TOKEN: 'nao-e-um-token-valido' },
  });
  assert.notEqual(badEnv.code, 0, 'a token that does not resolve is not a token');
  assert.match(badEnv.stderr, /401/);
});

test('t124 AT — --help documents the token option next to --url', { timeout: 60_000 }, async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0, `stderr:\n${help.stderr}`);
  assert.match(help.stdout, /--token/);
  assert.match(help.stdout, /CARTOGRAFO_TOKEN/);
});
