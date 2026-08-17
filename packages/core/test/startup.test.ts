/**
 * Acceptance test of the one-command startup (t100, FR2/FR3).
 *
 * Runs `packages/core/bin/cartografo.mjs` as a real child process, in a
 * temporary directory with no database: it is the only way to prove that the
 * single command creates the file, applies the migrations and brings HTTP up
 * with no manual setup step. The second startup against the same database proves
 * idempotence.
 *
 * Since t197 it also owns the log-level configuration (`CARTOGRAFO_LOG_LEVEL`),
 * which belongs here for the same reason `CARTOGRAFO_PORT` does: it is a
 * decision of the startup, resolved out of the environment before `createApp`
 * ever sees it, and the failure of a bad value is a process that refuses to come
 * up instead of one that quietly logs at a level nobody chose.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import test from 'node:test';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type * as IndexModule from '../src/index.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cartografo.mjs');

/** Readiness line the command prints on stdout when the server comes up. */
interface ReadinessLine {
  event: string;
  database: string;
  migrationsApplied: number;
  url: string;
  /**
   * The operator credential, printed the ONE time it is minted (t124, FR4).
   * `null` on every later startup against the same database: the raw value is
   * not recoverable from the table, so there is nothing left to print.
   */
  bootstrapToken: string | null;
}

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, stdout/stderr read. */
type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

interface Startup {
  child: CommandChild;
  readiness: ReadinessLine;
  shutdown: () => Promise<void>;
}

let indexCache: typeof IndexModule | null = null;

/**
 * Loads `src/index.ts` on demand, so the initial red NAMES what is missing.
 *
 * Same convention as `test/health.test.ts` and `test/lease-cap-config.test.ts`:
 * a module-resolution blow-up in a file whose other tests spawn a child process
 * reads like any other bug.
 */
async function loadIndex(): Promise<typeof IndexModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'index.ts')),
    'artifact does not exist yet: packages/core/src/index.ts',
  );
  indexCache ??= (await import(
    new URL('../src/index.ts', import.meta.url).href
  )) as typeof IndexModule;
  return indexCache;
}

/** Reserves a free port by asking the OS for port 0 and returning the number. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** Starts the command and resolves when the readiness line appears on stdout. */
async function start(options: {
  cwd: string;
  databasePath: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}): Promise<Startup> {
  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: options.cwd,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: options.databasePath,
      CARTOGRAFO_PORT: String(options.port),
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const shutdown = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await sleep(100);
    }
    child.kill('SIGKILL');
  };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the command died before becoming ready (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const line = stdout
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      return { child, readiness: JSON.parse(line) as ReadinessLine, shutdown };
    }
    await sleep(100);
  }

  await shutdown();
  throw new Error(`the command did not become ready in 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

test(
  'AT9 — one-command startup creates the database, migrates and answers /health; the second startup does not re-migrate',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-partida-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    // A subdirectory that does NOT exist: proves the command creates the database path.
    const databasePath = path.join(base, 'dados', 'cartografo.db');
    assert.equal(existsSync(path.dirname(databasePath)), false);

    const port = await freePort();

    const first = await start({ cwd: base, databasePath, port });
    try {
      assert.equal(first.readiness.event, 'cartografo.ready');
      assert.equal(first.readiness.database, databasePath);
      // The exact count, not `>= 1`: t235 deleted `0019_wire_database_rename.sql`
      // and rewrote `0001`–`0018` so the schema is born English, and this line
      // is what makes a rename migration for a database nobody has fail on the
      // way up if it quietly reappears (D20). t215 added `0019_skill_versao.sql`,
      // which is not that — it turns the registry into a lineage (D22) — so the
      // count moved with it, deliberately and in the same commit. t253 added
      // `0020_sessao_saida.sql`, which is not that either — it gives the session
      // somewhere to keep the node's structured report — and moved it again.
      assert.equal(
        first.readiness.migrationsApplied,
        20,
        'a brand-new database applies the twenty migrations the package ships',
      );
      assert.equal(typeof first.readiness.url, 'string');
      assert.equal(
        first.readiness.url,
        `http://127.0.0.1:${port}`,
        'with CARTOGRAFO_HOST unset, the control plane stays on loopback (t124, FR5)',
      );
      assert.deepEqual(
        Object.keys(first.readiness).sort(),
        ['bootstrapToken', 'database', 'event', 'migrationsApplied', 'url'],
        'the readiness line carries exactly the five English keys (D18, t127 FR6; t124 FR4)',
      );
      assert.ok(existsSync(databasePath), 'the database file has to exist at the configured path');

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });

      // The token is the only thing this line prints that cannot be recovered
      // later: if it does not authenticate right now, it never will (t124, FR4).
      assert.equal(typeof first.readiness.bootstrapToken, 'string');
      assert.ok(
        (first.readiness.bootstrapToken ?? '').length > 0,
        'the first startup against a brand-new database mints an operator credential',
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/v1/jobs`)).status,
        401,
        'without the token the API denies everything (t124, Goal)',
      );
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
            headers: { authorization: `Bearer ${first.readiness.bootstrapToken ?? ''}` },
          })
        ).status,
        200,
        'the token printed on the readiness line authenticates a /v1 call',
      );
    } finally {
      await first.shutdown();
    }

    // Same port, same database: it only comes back up if the first one really stopped.
    const second = await start({ cwd: base, databasePath, port });
    try {
      assert.equal(
        second.readiness.migrationsApplied,
        0,
        'idempotent startup: an already migrated database reapplies no migration',
      );
      assert.equal(
        second.readiness.bootstrapToken,
        null,
        'a database that already has an operator credential mints no second one',
      );
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });

      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
            headers: { authorization: `Bearer ${first.readiness.bootstrapToken ?? ''}` },
          })
        ).status,
        200,
        'the credential survives the restart: it lives in the database, not in the process',
      );
    } finally {
      await second.shutdown();
    }
  },
);

test(
  't124 AT — a startup that cannot listen does not burn the bootstrap token',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t124-busy-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const databasePath = path.join(base, 'cartografo.db');

    // Somebody else is already on the port. This is not an exotic case: it is
    // the first `npx cartografo` of anyone who left another one running, and it
    // happens BEFORE the operator has ever seen a token.
    const squatter = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      squatter.on('error', reject);
      squatter.listen(0, '127.0.0.1', () => {
        const address = squatter.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('could not hold a port'));
          return;
        }
        resolve(address.port);
      });
    });

    const failed = spawn(process.execPath, [BIN_PATH], {
      cwd: base,
      env: { ...process.env, CARTOGRAFO_DB_PATH: databasePath, CARTOGRAFO_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise<number | null>((resolve) => failed.on('close', resolve));
    assert.notEqual(code, 0, 'a control plane that cannot listen has to fail');

    await new Promise<void>((resolve) => squatter.close(() => resolve()));

    // The database survived that attempt — migrated. The credential must NOT
    // have: a token minted and never printed is a token nobody can ever use, and
    // it would make this second startup announce `null` with no way back.
    const startup = await start({ cwd: base, databasePath, port });
    try {
      assert.equal(
        typeof startup.readiness.bootstrapToken,
        'string',
        'the first startup that actually serves is the one that mints the credential',
      );
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
            headers: { authorization: `Bearer ${startup.readiness.bootstrapToken ?? ''}` },
          })
        ).status,
        200,
      );
    } finally {
      await startup.shutdown();
    }
  },
);

/** The pid the `<db>.lock` sidecar names (t209, FR2). */
function lockOwner(databasePath: string): number {
  const contents = JSON.parse(readFileSync(`${databasePath}.lock`, 'utf8')) as { pid?: unknown };
  assert.equal(typeof contents.pid, 'number', 'the lock file has to name a pid');
  return contents.pid as number;
}

/** A pid that is certainly not running: a child already exited AND reaped. */
function deadPid(): number {
  const finished = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = finished.pid;
  assert.ok(typeof pid === 'number' && pid > 0, 'the short-lived child had no pid');
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    'fixture broken: the child spawnSync already reaped is still alive',
  );
  return pid;
}

test(
  't209 AT — a second control plane against the same database is refused before touching it',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t209-segundo-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const databasePath = path.join(base, 'cartografo.db');
    const port = await freePort();

    const first = await start({ cwd: base, databasePath, port });
    try {
      assert.equal(lockOwner(databasePath), first.child.pid, 'a live control plane owns the lock');

      // A DIFFERENT free port on purpose: on the same one the refusal would be
      // "the address is busy" — the case t124's test already covers — and
      // nothing would be proven about the database. What has to fail here is
      // the second process's claim over the FILE.
      const otherPort = await freePort();
      const refused = spawn(process.execPath, [BIN_PATH], {
        cwd: base,
        env: {
          ...process.env,
          CARTOGRAFO_DB_PATH: databasePath,
          CARTOGRAFO_PORT: String(otherPort),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      refused.stdout.setEncoding('utf8');
      refused.stderr.setEncoding('utf8');
      refused.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      refused.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      const code = await new Promise<number | null>((resolve) => {
        const giveUp = setTimeout(() => refused.kill('SIGKILL'), 30_000);
        refused.on('close', (exitCode) => {
          clearTimeout(giveUp);
          resolve(exitCode);
        });
      });

      assert.equal(code, 1, `the second control plane has to die\nstdout:\n${stdout}\nstderr:\n${stderr}`);
      assert.ok(
        stderr.includes(String(first.child.pid)),
        `the refusal has to name the pid already running:\n${stderr}`,
      );
      assert.ok(
        stderr.includes(`${databasePath}.lock`),
        `the refusal has to name the lock file:\n${stderr}`,
      );
      assert.ok(
        !stderr.includes('startup failed'),
        `a held lock is one line, not the generic dump (FR4):\n${stderr}`,
      );
      assert.equal(stdout.trim(), '', 'a startup that was refused announces nothing');

      // The proof that it stopped BEFORE the database: the first control plane
      // is intact, and its credential — the one thing a second minting would
      // have made ambiguous — still authenticates.
      assert.equal(lockOwner(databasePath), first.child.pid, 'the refused attempt took no lock');
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok', db: 'ok' });
      assert.equal(
        (
          await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
            headers: { authorization: `Bearer ${first.readiness.bootstrapToken ?? ''}` },
          })
        ).status,
        200,
        'the credential of the first startup is still the only one there is',
      );
    } finally {
      await first.shutdown();
    }

    assert.equal(
      existsSync(`${databasePath}.lock`),
      false,
      'the shutdown gives the lock back: the next startup finds nothing to take over',
    );
  },
);

test(
  't209 AT — a startup over a lock naming a dead process takes it over and comes up',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t209-orfao-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const databasePath = path.join(base, 'cartografo.db');
    const port = await freePort();

    // What a `kill -9` leaves behind. Refusing to start over it would turn one
    // hard kill into a manual cleanup step — the opposite of a one-command
    // start, and for no gain: nobody is holding anything.
    writeFileSync(
      `${databasePath}.lock`,
      `${JSON.stringify({ pid: deadPid(), since: '2026-08-16T12:00:00.000Z' })}\n`,
      'utf8',
    );

    const startup = await start({ cwd: base, databasePath, port });
    try {
      assert.equal(startup.readiness.event, 'cartografo.ready');
      assert.ok(
        startup.readiness.migrationsApplied >= 1,
        'the abandoned lock did not stop the migrations of a brand-new database',
      );
      assert.equal(lockOwner(databasePath), startup.child.pid, 'the lock now names the live process');
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
    } finally {
      await startup.shutdown();
    }
  },
);

test('t197 FR1 — logLevel() defaults to info, accepts a pino level and refuses anything else', async () => {
  const { ENV_LOG_LEVEL, logLevel } = await loadIndex();

  assert.equal(typeof logLevel, 'function', 'artifact does not exist yet: logLevel in src/index.ts');
  assert.equal(ENV_LOG_LEVEL, 'CARTOGRAFO_LOG_LEVEL');

  // The environment is passed in and never read off `process.env`: a config test
  // that mutates the real one leaks into every other test in the process (the
  // same rule `lease-cap-config.test.ts` states).
  assert.equal(logLevel({}), 'info', 'an unset variable logs at info, never silently off');
  assert.equal(logLevel({ [ENV_LOG_LEVEL]: '' }), 'info', 'a blank value is an unset value');
  assert.equal(logLevel({ [ENV_LOG_LEVEL]: '   ' }), 'info', 'whitespace is a blank value');

  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']) {
    assert.equal(
      logLevel({ [ENV_LOG_LEVEL]: level }),
      level,
      `${level} is one of pino's own levels and has to come through`,
    );
    assert.equal(
      logLevel({ [ENV_LOG_LEVEL]: `  ${level}  ` }),
      level,
      'the value is trimmed, like every other variable of this file',
    );
  }

  // And it dies naming both, exactly like `leaseCap`: a level nobody chose is
  // worse than no server, because the operator goes on believing the one they
  // typed is the one in force.
  assert.throws(
    () => logLevel({ [ENV_LOG_LEVEL]: 'verboso' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('CARTOGRAFO_LOG_LEVEL'), `does not name the variable: ${error.message}`);
      assert.ok(error.message.includes('verboso'), `does not name the value: ${error.message}`);
      return true;
    },
  );
});

test(
  't197 FR2 — the configured level reaches the running app, and the command still comes up',
  { timeout: 180_000 },
  async (t) => {
    // Renamed on the way in: `start` is already this file's spawn helper, and
    // both are used below — one in process, to read `app.log`, one as the real
    // command, to prove the readiness line survived.
    const { start: startInProcess } = await loadIndex();

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t197-nivel-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    // `warn` and not `debug`: what has to be proven is that the value travels
    // from the environment into `app.log`, and a level below `info` would spray
    // Fastify's own startup lines across the test reporter's output.
    const controlPlane = await startInProcess({
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: String(await freePort()),
      CARTOGRAFO_LOG_LEVEL: 'warn',
    });
    try {
      assert.equal(
        controlPlane.app.log.level,
        'warn',
        'start() has to hand createApp the level it resolved, or the variable configures nothing',
      );
    } finally {
      await controlPlane.shutdown();
    }

    // And end to end: a startup with the variable set announces itself as it
    // always did — turning logging on is not allowed to cost the readiness line.
    const spawned = await start({
      cwd: base,
      databasePath: path.join(base, 'spawned.db'),
      port: await freePort(),
      env: { CARTOGRAFO_LOG_LEVEL: 'info' },
    });
    try {
      assert.equal(spawned.readiness.event, 'cartografo.ready');
      assert.equal((await fetch(`${spawned.readiness.url}/health`)).status, 200);
      assert.equal(spawned.child.exitCode, null, 'the process with logging on did not stay up');
    } finally {
      await spawned.shutdown();
    }
  },
);

test(
  't124 AT — CARTOGRAFO_HOST decides the bind address, and the announced url says so',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(BIN_PATH), 'artifact does not exist yet: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t124-host-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    const databasePath = path.join(base, 'cartografo.db');
    const port = await freePort();

    // `localhost` and not an external interface: what FR5 asks is that the
    // address stops being hardcoded, and a test that binds 0.0.0.0 would expose
    // the only writer of the system on whatever machine runs the suite.
    const startup = await start({
      cwd: base,
      databasePath,
      port,
      env: { CARTOGRAFO_HOST: 'localhost' },
    });
    try {
      assert.equal(startup.readiness.url, `http://localhost:${port}`);
      assert.equal((await fetch(`http://localhost:${port}/health`)).status, 200);
    } finally {
      await startup.shutdown();
    }
  },
);
