/**
 * Acceptance test of the one-command startup (t100, FR2/FR3).
 *
 * Runs `packages/core/bin/cartografo.mjs` as a real child process, in a
 * temporary directory with no database: it is the only way to prove that the
 * single command creates the file, applies the migrations and brings HTTP up
 * with no manual setup step. The second startup against the same database proves
 * idempotence.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import test from 'node:test';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cartografo.mjs');

/** Readiness line the command prints on stdout when the server comes up. */
interface ReadinessLine {
  event: string;
  database: string;
  migrationsApplied: number;
  url: string;
}

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, stdout/stderr read. */
type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

interface Startup {
  child: CommandChild;
  readiness: ReadinessLine;
  shutdown: () => Promise<void>;
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
}): Promise<Startup> {
  const child = spawn(process.execPath, [BIN_PATH], {
    cwd: options.cwd,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: options.databasePath,
      CARTOGRAFO_PORT: String(options.port),
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
      assert.ok(
        first.readiness.migrationsApplied >= 1,
        'the first startup has to apply at least the initial migration',
      );
      assert.equal(typeof first.readiness.url, 'string');
      assert.deepEqual(
        Object.keys(first.readiness).sort(),
        ['database', 'event', 'migrationsApplied', 'url'],
        'the readiness line carries exactly the four English keys (D18, t127 FR6)',
      );
      assert.ok(existsSync(databasePath), 'the database file has to exist at the configured path');

      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
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
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok', db: 'ok' });
    } finally {
      await second.shutdown();
    }
  },
);
