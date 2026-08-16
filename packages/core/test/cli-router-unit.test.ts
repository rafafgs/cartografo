/**
 * Argument extraction and error mapping of the router, in process (t212).
 *
 * The `cli-*.test.ts` files spawn the binary, which is the only honest way to
 * check the CLI's real contract. It is also a second or so per case, and the
 * router's surface is a combinatorial one — every subcommand times every way a
 * command line can be wrong — so what got spawned was a sample and the rest
 * stayed unchecked: `cli/index.ts` read 60 % of branches.
 *
 * Calling `runCli` directly costs nothing per case and still exercises the same
 * three decisions this module owns:
 *
 * - **extraction**: `--name value` and `--name=value` are the same option, an
 *   option with no value is refused, and what is left over on the line is
 *   refused instead of ignored;
 * - **the exit codes**: `0` did what it promised, `1` ran and the answer was
 *   negative, `2` the command line is wrong — the convention the module header
 *   declares and the one thing a script calling this CLI depends on;
 * - **mapping**: the two failures no subcommand can do anything with — the
 *   control plane not being there and the credential being refused — become ONE
 *   actionable line each, never a `TypeError: fetch failed` and never the wire
 *   body of a 401.
 *
 * `up` is deliberately never routed here: it starts a server that outlives the
 * call, and that is what the spawn suites are for.
 *
 * English per D18; `CARTOGRAFO_URL` and `CARTOGRAFO_TOKEN` are the frozen names
 * of the environment.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli/index.ts';
import { ENV_TOKEN, ENV_URL, useToken } from '../src/cli/url.ts';
import { freePort, temporaryArea } from './cli-support.ts';
import { capture, startFakeControlPlane, type FakeAnswer } from './cli-unit-support.ts';

/**
 * An environment with nothing of this CLI's in it.
 *
 * Explicit, and not `process.env`: a `CARTOGRAFO_TOKEN` exported in whoever runs
 * the suite's own shell must not decide the result of a test about not having
 * one (the same rule `cli-support.ts` keeps for the spawned runs).
 */
const CLEAN_ENV: NodeJS.ProcessEnv = {};

/** A control plane that answers a lineage and its version — enough for `export`. */
function exporting(): (request: { path: string }) => FakeAnswer {
  return (request) =>
    request.path.startsWith('/v1/graph-versions/')
      ? { status: 200, body: { grafo_versao: { snapshot: { problem_class: 'uma-classe' } } } }
      : { status: 200, body: { grafo: { versao_corrente_id: 'sha256:abc' } } };
}

test('--help is the usage text and a clean exit, in each of its three spellings', async () => {
  for (const spelling of ['--help', '-h', 'help']) {
    const run = await capture(() => runCli([spelling], CLEAN_ENV));

    assert.equal(run.code, 0, spelling);
    assert.match(run.stdout, /usage: cartografo \[subcommand\] \[options\]/);
  }
});

test('an unknown subcommand is a wrong command line, not a failed run', async () => {
  const run = await capture(() => runCli(['exportar'], CLEAN_ENV));

  assert.equal(run.code, 2, 'exit 2 is "the command line is wrong"');
  assert.match(run.stderr, /unknown subcommand: "exportar"/);
  assert.match(run.stderr, /usage: cartografo/, 'and it says what the right ones are');
});

test('an option with no value is refused, in both of its spellings', async () => {
  for (const line of [
    ['export', 'uma-classe', '--url'],
    ['export', 'uma-classe', '--url='],
    ['export', 'uma-classe', '--url', '--out'],
    ['scan-skill', 'SKILL.md', '--repo'],
  ]) {
    const run = await capture(() => runCli(line, CLEAN_ENV));

    assert.equal(run.code, 2, line.join(' '));
    assert.match(run.stderr, /needs a value/);
    assert.match(run.stderr, /run `cartografo --help` for usage/);
  }
});

test('a subcommand missing what it cannot work without is refused before any request', async () => {
  const lines: [string[], RegExp][] = [
    [['import'], /import needs a path/],
    [['export'], /export needs the graph class/],
    [['scan-skill'], /scan-skill needs the path of a SKILL\.md/],
    [['scan-skill', 'SKILL.md'], /scan-skill needs --repo/],
    [['scan-skill', 'SKILL.md', '--repo', 'r'], /scan-skill needs --ref/],
    [['scan-skill', 'SKILL.md', '--repo', 'r', '--ref', 'a1b2'], /scan-skill needs --role/],
    [['scan-skill', 'SKILL.md', '--repo', 'r', '--ref', 'a1b2', '--role', 'work'], /scan-skill needs --by/],
    [['propose-skill'], /propose-skill needs the path of a completed manifest/],
    [['register-skill'], /register-skill needs --job/],
    [['register-skill', '--job', 'setenta'], /--job has to be an integer \(got: "setenta"\)/],
  ];

  for (const [line, expected] of lines) {
    const run = await capture(() => runCli(line, CLEAN_ENV));

    assert.equal(run.code, 2, line.join(' '));
    assert.match(run.stderr, expected);
  }
});

test('what is left over on the command line is refused instead of ignored', async () => {
  const lines: [string[], RegExp][] = [
    [['status', 'sobrando'], /status does not understand: "sobrando"/],
    [['import', 'grafo.json', 'sobrando'], /import does not understand: "sobrando"/],
    [['export', 'classe', 'sobrando', 'mais'], /export does not understand: "sobrando", "mais"/],
    [['register-skill', '--job', '7', 'sobrando'], /register-skill does not understand: "sobrando"/],
  ];

  for (const [line, expected] of lines) {
    const run = await capture(() => runCli(line, CLEAN_ENV));

    assert.equal(run.code, 2, line.join(' '));
    assert.match(run.stderr, expected);
  }
});

test('--name value and --name=value are the same option', async (t) => {
  const plane = await startFakeControlPlane(t, exporting());
  const area = temporaryArea(t, 'cartografo-t212-router-');

  const spaced = path.join(area, 'espacado.json');
  const spacedRun = await capture(() =>
    runCli(['export', 'uma-classe', '--url', plane.url, '--out', spaced], CLEAN_ENV),
  );
  assert.equal(spacedRun.code, 0);

  const glued = path.join(area, 'colado.json');
  const gluedRun = await capture(() =>
    runCli(['export', `--url=${plane.url}`, `--out=${glued}`, 'uma-classe'], CLEAN_ENV),
  );
  assert.equal(gluedRun.code, 0, 'and the options may come before the positional');

  assert.equal(existsSync(spaced), true);
  assert.equal(existsSync(glued), true);
});

test('an address that is not one is a wrong command line', async () => {
  for (const url of ['nem-url', 'ftp://127.0.0.1:4317']) {
    const run = await capture(() => runCli(['status', '--url', url], CLEAN_ENV));

    assert.equal(run.code, 2, url);
    assert.match(run.stderr, /the URL has to be http or https|invalid URL/);
  }
});

test('the address comes from --url, then from the environment', async (t) => {
  const plane = await startFakeControlPlane(t, exporting());
  const area = temporaryArea(t, 'cartografo-t212-router-');
  const output = path.join(area, 'do-ambiente.json');

  const run = await capture(() =>
    runCli(['export', 'uma-classe', '--out', output], { [ENV_URL]: `${plane.url}/` }),
  );

  assert.equal(run.code, 0);
  assert.equal(existsSync(output), true, 'the trailing slash of the environment is dropped, not sent');
});

test('a control plane that is not there becomes one actionable line', async (t) => {
  // A port the OS just handed back: nothing is listening on it.
  const port = await freePort();
  t.after(() => useToken(undefined));

  const run = await capture(() => runCli(['status', '--url', `http://127.0.0.1:${port}`], CLEAN_ENV));

  assert.equal(run.code, 1, 'the command was right and the world was not: a negative result, not a usage error');
  assert.match(run.stderr, /could not talk to the control plane at http:\/\/127\.0\.0\.1/);
  assert.match(run.stderr, /run `cartografo up` first/);
  assert.doesNotMatch(run.stderr, /TypeError/, 'never a stack trace of fetch');
});

test('a refused credential becomes one actionable line, and the token travels', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({
    status: 401,
    body: { erro: 'nao_autorizado', mensagem: 'token inválido' },
  }));
  t.after(() => useToken(undefined));

  const fromFlag = await capture(() =>
    runCli(['status', '--url', plane.url, '--token', 'do-flag'], CLEAN_ENV),
  );
  assert.equal(fromFlag.code, 1);
  assert.match(fromFlag.stderr, /request denied \(401\)/);
  assert.match(fromFlag.stderr, new RegExp(`set ${ENV_TOKEN} or pass --token`));
  assert.doesNotMatch(fromFlag.stderr, /nao_autorizado/, 'the wire body describes the server, not the person');
  assert.equal(plane.requests[0].authorization, 'Bearer do-flag');

  const fromEnv = await capture(() =>
    runCli(['status', '--url', plane.url], { [ENV_TOKEN]: '  do-ambiente  ' }),
  );
  assert.equal(fromEnv.code, 1);
  assert.equal(
    plane.requests[1].authorization,
    'Bearer do-ambiente',
    'the credential is trimmed before it goes on the wire',
  );
});
