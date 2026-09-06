/**
 * Acceptance tests for the ONE publishable package (t248, FR4/FR5/FR6/FR10; D23).
 *
 * D23 settled that `cartografo` ships as a single npm package carrying every
 * command, because the D1/D11 boundaries are boundaries of PROCESS and not of
 * package. Until this ticket that was a decision and not an artifact: `npm
 * pack` on `packages/core` produced a tarball with exactly one command in it,
 * and the other five resolved only through npm workspace hoisting inside this
 * checkout — which is to say, only on the machine of whoever had cloned the
 * repository.
 *
 * So nothing here is asserted from inside the monorepo. The suite builds a real
 * tarball, installs it into a throwaway global prefix, and then runs the
 * commands the way a stranger would: from an EMPTY directory, with `PATH`
 * carrying the prefix and the system only. No `node_modules` of this repository
 * is reachable, no `NODE_OPTIONS` is inherited, and no sibling checkout is on
 * disk — the three things that made the old arrangement look like it worked.
 *
 * This is the slowest file in the suite by a wide margin, and deliberately so:
 * `npm install -g` resolves and fetches the control plane's real dependency
 * tree (Fastify, better-sqlite3 and the rest). The deadlines below are sized for
 * a cold-ish npm cache, and `--prefer-offline` keeps a warm one from going to
 * the network at all.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/**
 * What asks `up` for the control plane and nothing else (t405).
 *
 * Since t405 the installed `cartografo` with no argument is the whole product:
 * it also spawns the screen and a local runner and opens a browser. That is
 * right for a stranger and wrong for this suite, which runs on the machine of
 * whoever typed `npm test` — with the real `HOME`, since `strangerEnv` rewrites
 * `PATH` and nothing else. Without these three flags one case would open a
 * browser window, bind the screen's default port next to whatever is already on
 * it, and create `~/.cartografo/workspace` as a git repository under that home.
 *
 * Spelled out rather than imported from `cli-support.ts`, for this file's own
 * reason: nothing here comes from inside the monorepo (see the header).
 *
 * The case below still asserts exactly what it asserted before — readiness, the
 * database beside the working directory, a clean stop on `SIGTERM`. That the
 * other five binaries are on the installed `PATH` is the case above's job, and
 * it checks all six by name.
 */
const CONTROL_PLANE_ONLY = Object.freeze(['--no-browser', '--no-runner', '--no-screen']);

/** The six commands D23 says one package ships. */
const COMMANDS = Object.freeze([
  'cartografo',
  'cartografo-runner',
  'cartografo-screen',
  'cartografo-surveyor',
  'cost-surveyor',
  'cartografo-mcp',
]);

/**
 * The five sibling packages, by the path their own bin takes inside the
 * tarball once `bundledDependencies` has inlined them.
 */
const BUNDLED_BINS = Object.freeze([
  'package/node_modules/@cartografo/runner/bin/cartografo-runner.mjs',
  'package/node_modules/@cartografo/screen/bin/screen.mjs',
  'package/node_modules/@cartografo/surveyor/bin/surveyor.mjs',
  'package/node_modules/@cartografo/cost-surveyor/bin/cost-surveyor.mjs',
  'package/node_modules/@cartografo/mcp/bin/mcp.mjs',
]);

/** Packing and installing a real dependency tree is minutes, not seconds. */
const INSTALL_DEADLINE_MS = 600_000;

/** Once installed, a command that only prints its usage is fast. */
const HELP_DEADLINE_MS = 60_000;

/** The same numbers `@cartografo/test-support` uses for the control plane. */
const READINESS_DEADLINE_MS = 30_000;
const SHUTDOWN_DEADLINE_MS = 5_000;

/**
 * The environment a stranger has: no `NODE_OPTIONS` smuggling a loader in, and
 * a `PATH` that reaches the installed commands and the system, and nothing of
 * this repository.
 *
 * `node` itself has to stay reachable — every one of these commands is a
 * `#!/usr/bin/env node` shell — so the directory holding the running
 * interpreter is appended. That is the machine's node, not the repo's.
 */
function strangerEnv(binDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  env.PATH = [binDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
  return env;
}

test('t248 — one tarball installs all six commands, with no checkout on disk', async (parent) => {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t248-pack-'));
  parent.after(() => rmSync(base, { recursive: true, force: true }));

  const packDir = path.join(base, 'tarball');
  const prefix = path.join(base, 'prefix');
  const empty = path.join(base, 'empty');
  for (const dir of [packDir, prefix, empty]) {
    execFileSync('mkdir', ['-p', dir]);
  }

  const binDir = path.join(prefix, 'bin');
  let tarball = '';

  await parent.test('AT — `npm pack` bundles the five siblings, and no loader', () => {
    execFileSync('npm', ['pack', '--workspace', 'cartografo', '--pack-destination', packDir], {
      cwd: REPO_ROOT,
      stdio: 'pipe',
      timeout: INSTALL_DEADLINE_MS,
    });

    const produced = readdirSync(packDir).filter((entry) => entry.endsWith('.tgz'));
    assert.equal(produced.length, 1, `expected exactly one tarball, got: ${produced.join(', ')}`);
    tarball = path.join(packDir, produced[0] as string);

    const listing = execFileSync('tar', ['tf', tarball], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    for (const bundled of BUNDLED_BINS) {
      assert.ok(
        listing.includes(bundled),
        `the tarball ships only its own command: "${bundled}" is missing.\n` +
          `That is D23 undone — the other five would resolve only inside this checkout.`,
      );
    }

    const loader = listing.filter((entry) => entry.includes('tsx'));
    assert.deepEqual(
      loader,
      [],
      'nothing named after the TypeScript loader belongs inside the published tarball',
    );
  });

  await parent.test('AT — installed globally, every command answers --help', () => {
    assert.notEqual(tarball, '', 'the pack case has to have run first');

    execFileSync(
      'npm',
      [
        'install',
        '-g',
        tarball,
        '--prefix',
        prefix,
        '--prefer-offline',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: empty, stdio: 'pipe', timeout: INSTALL_DEADLINE_MS },
    );

    const env = strangerEnv(binDir);

    for (const command of COMMANDS) {
      assert.ok(
        existsSync(path.join(binDir, command)),
        `"${command}" is not on the installed PATH: the package's \`bin\` map does not carry it`,
      );

      // `cartografo-mcp` keeps its stdout for the JSON-RPC protocol and writes
      // everything a human reads to stderr — see its own bin header. So the
      // stream the usage text is expected on differs for exactly that one.
      const onStderr = command === 'cartografo-mcp';

      // `spawnSync` and not `execFileSync`: the latter hands back stdout alone
      // on success, and the stream this case has to read for `cartografo-mcp`
      // is precisely the other one.
      const result = spawnSync(command, ['--help'], {
        cwd: empty,
        env,
        encoding: 'utf8',
        timeout: HELP_DEADLINE_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';
      const status = result.error ? null : result.status;
      const both = `${stdout}${stderr}`;
      assert.equal(
        status,
        0,
        `\`${command} --help\` exited ${String(status)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      assert.doesNotMatch(
        both,
        /ERR_MODULE_NOT_FOUND/,
        `\`${command}\` cannot find something the tarball was supposed to carry:\n${both}`,
      );
      assert.doesNotMatch(
        stderr,
        /tsx/,
        `\`${command}\` still complains about the loader that was removed:\n${stderr}`,
      );
      assert.notEqual(
        (onStderr ? stderr : stdout).trim(),
        '',
        `\`${command} --help\` printed nothing where its usage text belongs`,
      );
    }
  });

  await parent.test('AT — the installed `cartografo` starts a control plane where it is run', async (t) => {
    assert.ok(existsSync(path.join(binDir, 'cartografo')), 'the install case has to have run first');

    const workdir = path.join(base, 'workdir');
    execFileSync('mkdir', ['-p', workdir]);
    const env = strangerEnv(binDir);
    // Port 0 so the kernel picks one: this suite must never collide with a
    // control plane a person happens to have running on the default port.
    env.CARTOGRAFO_PORT = '0';

    const child = spawn(path.join(binDir, 'cartografo'), [...CONTROL_PLANE_ONLY], {
      cwd: workdir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });

    const deadline = Date.now() + READINESS_DEADLINE_MS;
    while (Date.now() < deadline && !out.includes('"event":"cartografo.ready"')) {
      assert.equal(
        child.exitCode,
        null,
        `the control plane died before it was ready (code ${String(child.exitCode)})\n` +
          `stdout:\n${out}\nstderr:\n${err}`,
      );
      await delay(50);
    }

    assert.match(
      out,
      /"event":"cartografo\.ready"/,
      `the installed command never announced readiness within ${READINESS_DEADLINE_MS}ms\n` +
        `stdout:\n${out}\nstderr:\n${err}`,
    );
    assert.ok(
      existsSync(path.join(workdir, '.cartografo', 'cartografo.db')),
      'the database is created in the directory the command was run from, not in the package',
    );

    child.kill('SIGTERM');
    const outcome = await Promise.race([exited, delay(SHUTDOWN_DEADLINE_MS).then(() => null)]);

    assert.notEqual(
      outcome,
      null,
      `the control plane did not stop within ${SHUTDOWN_DEADLINE_MS}ms of SIGTERM\nstderr:\n${err}`,
    );
    assert.equal(
      (outcome as { code: number | null }).code,
      0,
      `asking the control plane to stop is not an error\nstderr:\n${err}`,
    );
  });
});
