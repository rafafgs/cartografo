/**
 * Support for the CLI acceptance tests (t108).
 *
 * Not a test file (`test/*.test.ts` is the runner glob): it is only what the
 * three `cli-*.test.ts` files share in order to run the command as a real child
 * process. A child process and not an in-process call because the CLI contract
 * IS the process: exit code, stdout and stderr — none of which exists when the
 * function is called directly.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { authorizeGlobalFetch } from './authorized-fetch.ts';

/** Root of the `cartografo` package (packages/core). */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Repository root — where the graph fixtures and the factory bundle come from. */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The executable under test. */
export const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'cartografo.mjs');

/** Factory bundle 1 (D14), the input of the README's three-command path. */
export const FACTORY_BUNDLE = path.join(REPO_ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');

/** Factory bundle 2 (D14) — the second class, which makes the atlas multi-map (t120). */
export const BETS_BUNDLE = path.join(REPO_ROOT, 'grafos-de-fabrica', 'bets-assimetricas');

/** Test context, in the part this support file uses. */
export interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** Full output of one run of the command. */
export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Readiness line that `up` prints on stdout. */
export interface ReadinessLine {
  event: string;
  database: string;
  migrationsApplied: number;
  url: string;
  /** Operator credential, printed only on the boot that mints it (t124, FR4). */
  bootstrapToken: string | null;
}

/** Control plane running, from the point of view of an HTTP-only client. */
export interface RunningControlPlane {
  url: string;
  port: number;
  readiness: ReadinessLine;
  /**
   * The credential this control plane announced. Every database here is brand
   * new, so there is always one — and it is what the subcommands and the direct
   * `fetch`es of these suites authenticate with (t124).
   */
  token: string;
  shutdown: () => Promise<void>;
}

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, stdout/stderr read. */
type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

/** Reserves a free port by asking the OS for port 0 and returning the number. */
export async function freePort(): Promise<number> {
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

/** Temporary directory that disappears at the end of the test. */
export function temporaryArea(t: TestHook, label = 'cartografo-t108-'): string {
  const base = mkdtempSync(path.join(tmpdir(), label));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/**
 * Default deadline of a subcommand run.
 *
 * It exists because the characteristic failure of this CLI is precisely NOT
 * terminating: a subcommand that falls into the startup path keeps serving HTTP
 * forever, and without a deadline the red test would hang the whole suite
 * instead of failing. Past the deadline the child is killed and the result comes
 * back with `code: null`.
 */
export const COMMAND_TIMEOUT_MS = 30_000;

/**
 * Runs the command and waits for it to finish.
 *
 * The default database points at a temporary area of its own: if a subcommand
 * starts a server by mistake, it does not write `.cartografo/` at the repo root.
 *
 * @param args Arguments after the command name.
 * @param options Working directory, credential, extra environment and deadline.
 * @returns Exit code, stdout and stderr.
 */
export async function runCli(
  args: string[],
  options: {
    cwd?: string;
    /** Credential of the control plane the subcommand will talk to (t124). */
    token?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CARTOGRAFO_DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-t108-cli-')), 'cartografo.db'),
  };
  // A `CARTOGRAFO_TOKEN` exported in whoever runs the suite's own shell must not
  // decide the result of a test about NOT having a credential (t124).
  delete env.CARTOGRAFO_TOKEN;
  if (options.token !== undefined) env.CARTOGRAFO_TOKEN = options.token;
  Object.assign(env, options.env);

  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as CommandChild;

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

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stderr += `\n[support] the command did not finish in ${options.timeoutMs ?? COMMAND_TIMEOUT_MS}ms and was killed\n`;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
    timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/**
 * Starts a control plane through the command itself and waits for the readiness line.
 *
 * The credential it announces is presented on every direct `fetch` this test
 * makes at it (t124) — these suites check the RESULT of a subcommand against the
 * server, and re-proving the gate on each of those checks would say nothing that
 * `test/auth.test.ts` does not already say. The subcommands themselves get the
 * token through `runCli`'s `token` option, as a person would.
 *
 * @param t Test context, used to shut the process down at the end.
 * @param options Database and arguments (`[]` = implicit start, `['up']` = explicit).
 * @returns The control plane running.
 */
export async function startControlPlane(
  t: TestHook,
  options: { databasePath: string; args?: string[]; cwd?: string },
): Promise<RunningControlPlane> {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN_PATH, ...(options.args ?? [])], {
    cwd: options.cwd ?? REPO_ROOT,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: options.databasePath,
      CARTOGRAFO_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as CommandChild;

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
  t.after(shutdown);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before becoming ready (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const line = stdout
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as ReadinessLine;
      const token = readiness.bootstrapToken ?? '';
      authorizeGlobalFetch(t, { baseUrl: readiness.url, token });
      return { url: readiness.url, port, readiness, token, shutdown };
    }
    await sleep(100);
  }

  await shutdown();
  throw new Error(`the control plane did not become ready in 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

/** Extracts the first `sha256:<64 hex>` appearing in the text. */
export function firstHash(text: string): string {
  const match = /sha256:[0-9a-f]{64}/.exec(text);
  if (match === null) throw new Error(`no version hash in the output:\n${text}`);
  return match[0];
}

/** Does the text look like a leaked stack trace? */
export function looksLikeStackTrace(text: string): boolean {
  return /\n\s+at\s+\S+/.test(text) || text.includes('TypeError:');
}
