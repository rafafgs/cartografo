/**
 * Acceptance tests for the screen's command line (t248, FR7).
 *
 * The other five commands of the product all short-circuit `-h`/`--help`
 * before doing any work — `packages/core/src/cli/index.ts`,
 * `packages/runner/src/cli/index.ts`, `packages/surveyor/src/cli.ts`,
 * `packages/cost-surveyor/src/cli.ts` and `packages/mcp/src/index.ts` each
 * answer and return. `runScreenCli` had no `--help` handling at all: it read
 * the flag as "no `--url`", started the whole server on the real port, printed
 * its readiness line and then sat on `SIGINT`/`SIGTERM` forever. A person
 * asking a command what it does does not expect to have to kill it.
 *
 * Two cases, because they fail differently. The first pins the FUNCTION: the
 * promise settles, and the port the screen would have taken is still free
 * afterwards — which is what "no server was started" looks like from outside,
 * with no seam injected into production code to observe it. The second pins the
 * ARTIFACT: `bin/screen.mjs --help` as a real subprocess, which is the only
 * thing that proves the shell around the function does not hang either.
 *
 * The free port is picked by binding to `0` and letting go, the same trick
 * `server-proxy.test.ts` uses. A racing process could take it in between, which
 * would turn a pass into a failure and never a failure into a pass.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import type * as RouterModule from '../src/router.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const ROUTER_PATH = path.join(PACKAGE_ROOT, 'src', 'router.ts');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'screen.mjs');

/**
 * Short on purpose: what is being measured is that the command RETURNS, and a
 * generous deadline would only make a hang take longer to report.
 */
const DEADLINE_MS = 10_000;

/** A port nobody is listening on, as of the moment this resolves. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Can this test bind the port? Yes means nothing else is listening on it. */
async function isFree(port: number): Promise<boolean> {
  const server = net.createServer();
  const bound = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => resolve(true));
  });
  if (bound) await new Promise<void>((resolve) => server.close(() => resolve()));
  return bound;
}

test('t248 AT — `runScreenCli` answers --help without ever listening', async (t) => {
  assert.ok(existsSync(ROUTER_PATH), `artifact does not exist yet: ${ROUTER_PATH}`);
  const { runScreenCli } = (await import('../src/router.ts')) as typeof RouterModule;

  for (const flag of ['--help', '-h']) {
    const port = await freePort();
    // The screen's own port, handed in through the environment exactly as the
    // command reads it. If `--help` fell through to `startScreenRouter`, THIS
    // is the port it would be holding when the assertion below runs.
    const env = { ...process.env, CARTOGRAFO_SCREEN_PORT: String(port) };

    // The writer is injected rather than captured off `process.stdout`: this
    // test runs inside `node --test`, whose own reporter is writing to that
    // same stream, so a global capture would interleave the runner's protocol
    // bytes with the command's answer. It is the seam `runCli` already takes in
    // `packages/surveyor/src/cli.ts` and `packages/cost-surveyor/src/cli.ts`.
    let printed = '';
    const write = (text: string): void => {
      printed += text;
    };

    const settled = await Promise.race([
      runScreenCli([flag], env, { write }).then(() => 'returned'),
      wait(DEADLINE_MS).then(() => null),
    ]);

    assert.equal(
      settled,
      'returned',
      `\`${flag}\` did not return within ${DEADLINE_MS}ms — it started the server instead of answering`,
    );
    assert.match(printed, /cartografo-screen/, `\`${flag}\` names the command it documents`);
    assert.match(printed, /--url/, `\`${flag}\` documents the one flag the command takes`);
    assert.doesNotMatch(
      printed,
      /cartografo\.tela\.ready/,
      `\`${flag}\` is a question, not a start`,
    );

    assert.equal(
      await isFree(port),
      true,
      `\`${flag}\` left something listening on ${port}: it started the screen to print its usage`,
    );
  }

  t.diagnostic('both spellings answered and neither opened a port');
});

test('t248 AT — `bin/screen.mjs --help` exits 0 and never announces readiness', async () => {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const port = await freePort();
  const child = spawn(process.execPath, [BIN_PATH, '--help'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CARTOGRAFO_SCREEN_PORT: String(port) },
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    err += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const outcome = await Promise.race([exited, wait(DEADLINE_MS).then(() => null)]);

  if (outcome === null) {
    child.kill('SIGKILL');
    assert.fail(
      `the command did not exit within ${DEADLINE_MS}ms of \`--help\`\nstdout:\n${out}\nstderr:\n${err}`,
    );
  }

  assert.equal(outcome.signal, null, 'answering --help is an exit, not a death by signal');
  assert.equal(outcome.code, 0, `--help is not an error\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(out, /cartografo-screen/, 'the usage text reaches stdout');
  assert.doesNotMatch(out, /cartografo\.tela\.ready/, 'nothing was started to print a usage text');
});
