/**
 * Booting the real control plane, in one place (t201, FR1).
 *
 * Twelve acceptance suites across three packages need the same four moves
 * before they can test anything: spawn `packages/core/bin/cartografo.mjs`,
 * capture both streams, wait for the JSON line that announces readiness, and
 * take the process down again when the test ends. Until t201 each of them
 * carried its own copy of those four moves, and the copies had already started
 * to drift — `urlBase` here, `url` there, `env` overridable in one and fixed in
 * the next. Eleven of the twelve would have gone on being right by accident; the
 * twelfth is where a readiness race gets fixed once and stays broken.
 *
 * So this file owns the plumbing and the suites own their assertions. It is
 * split in three deliberately, because the suites do not all want the same
 * thing:
 *
 * - {@link spawnWatched} is the general one — ANY command, with its streams
 *   captured and its teardown registered. `packages/runner/test/bin.e2e.test.ts`
 *   uses it for the runner's own process, which is not a control plane at all.
 * - {@link awaitReadiness} is the general wait — ANY readiness event, which is
 *   what lets the same file wait for `cartografo.runner.ready` through the same
 *   code path as the core's.
 * - {@link bootCore} is the convenience the other eleven wanted: the two above,
 *   plus the throwaway database, plus the credential check.
 *
 * ## What this package is NOT allowed to touch
 *
 * Nothing here imports `packages/core/src/**`, and least of all
 * `packages/core/src/db/**` — this is a test-side HTTP/process client, the same
 * kind of unprivileged consumer the runner and the screen are (D1, D11), and
 * `scripts/check-single-writer.mjs` is what holds that line. The readiness event
 * name is spelled out below rather than imported from
 * `packages/core/src/index.ts` for the same reason: importing it would pull
 * Fastify and the whole server graph into every test process that only wants to
 * read one line of stdout.
 *
 * English per D18.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The command every `bootCore` spawns. */
export const CORE_BIN = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');

/** The readiness event the control plane announces on stdout. */
export const READY_EVENT = 'cartografo.ready';

/**
 * Deadline for a startup. Wide slack, on purpose.
 *
 * It is a ceiling and never a wait: the readiness loop below returns the instant
 * the line shows up. A tight number here buys nothing and costs a red suite on a
 * loaded machine.
 */
export const READINESS_DEADLINE_MS = 30_000;

/** How long a SIGTERM is given before the teardown escalates to SIGKILL. */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * The slice of `node:test`'s `TestContext` this file uses.
 *
 * Declared structurally rather than imported so any of the three packages can
 * hand in its own context — and so the helper is callable from a plain script.
 */
export interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** A spawned command with both of its streams piped. */
export type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

/** A child process whose output is being watched for one line. */
export interface WatchedChild {
  child: CommandChild;
  /** Everything it wrote on stdout so far. */
  out: () => string;
  /** Everything it wrote on stderr so far. */
  err: () => string;
}

/** The control plane, up, as seen by someone who only speaks HTTP with it. */
export interface RunningControlPlane {
  /** Base URL announced by the command itself. */
  url: string;
  /**
   * Operator credential, read off the same readiness line (t124).
   *
   * Every caller here boots a database that never existed, so the control plane
   * always mints one and always prints it.
   */
  token: string;
}

/** What `bootCore` lets a caller decide for itself. */
export interface BootCoreOptions {
  /**
   * Working directory of the process. Default: a fresh `mkdtemp`, removed at
   * the end of the test along with the database inside it.
   */
  cwd?: string;
  /**
   * Environment merged ON TOP of the defaults, so a suite can add what it needs
   * (`CARTOGRAFO_HOST`, a feature flag) without restating the database path.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns a command, collects both streams, and takes it down when the test ends.
 *
 * The teardown is the one the twelve copies agreed on: SIGTERM first, then up to
 * {@link SHUTDOWN_GRACE_MS} of polling, then SIGKILL. A process that already
 * exited is left alone.
 *
 * @param t Test context, used to register the shutdown.
 * @param args Arguments for `process.execPath` — the script and its own flags.
 * @param options Working directory and environment of the child.
 * @returns The child, plus readers for what it has written so far.
 */
export function spawnWatched(
  t: TestHook,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): WatchedChild {
  const child: CommandChild = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
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

  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    for (let waited = 0; waited < SHUTDOWN_GRACE_MS; waited += 100) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await delay(100);
    }
    child.kill('SIGKILL');
  });

  return { child, out: () => out, err: () => err };
}

/**
 * Waits for the JSON line on stdout that carries the given event name.
 *
 * The two failure modes both come back with everything the process said, which
 * is the whole reason the streams are captured: a readiness wait that times out
 * with no output attached tells the reader nothing about WHY.
 *
 * @param watched The child, as {@link spawnWatched} returned it.
 * @param event Event name to look for, e.g. `cartografo.ready`.
 * @param deadlineMs Ceiling on the wait. Default {@link READINESS_DEADLINE_MS}.
 * @returns The parsed readiness line.
 */
export async function awaitReadiness(
  watched: WatchedChild,
  event: string,
  deadlineMs: number = READINESS_DEADLINE_MS,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (watched.child.exitCode !== null) {
      throw new Error(
        `the process died before announcing "${event}" (code ${watched.child.exitCode})\n` +
          `stdout:\n${watched.out()}\nstderr:\n${watched.err()}`,
      );
    }
    const line = watched
      .out()
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes(event));
    if (line !== undefined) return JSON.parse(line) as Record<string, unknown>;
    await delay(50);
  }

  throw new Error(
    `"${event}" was not announced within ${deadlineMs}ms\n` +
      `stdout:\n${watched.out()}\nstderr:\n${watched.err()}`,
  );
}

/**
 * Boots the real control plane on a throwaway database and waits for it.
 *
 * The defaults are what eleven of the twelve suites wanted verbatim: a fresh
 * temporary directory, the database inside it, and port 0 so the kernel picks
 * one and the URL comes back off the readiness line. `options.env` is merged on
 * top rather than replacing them, so a suite that needs `CARTOGRAFO_HOST` says
 * only that.
 *
 * The temporary directory's removal is registered AFTER `spawnWatched`'s
 * teardown on purpose: `node:test` runs `after` hooks in registration order, so
 * the process is already gone by the time its database is deleted.
 *
 * @param t Test context, used to register the shutdown and the cleanup.
 * @param options Working directory and extra environment.
 * @returns The address the control plane announced, and the credential it minted.
 */
export async function bootCore(
  t: TestHook,
  options: BootCoreOptions = {},
): Promise<RunningControlPlane> {
  assert.ok(existsSync(CORE_BIN), `artifact does not exist yet: ${CORE_BIN}`);

  const owned = options.cwd === undefined;
  const base = options.cwd ?? mkdtempSync(path.join(tmpdir(), 'cartografo-core-'));

  const watched = spawnWatched(t, [CORE_BIN], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
      ...options.env,
    },
  });

  // Registered after the child's teardown, never before: see the note above.
  if (owned) t.after(() => rmSync(base, { recursive: true, force: true }));

  const readiness = await awaitReadiness(watched, READY_EVENT);
  const url = readiness.url;
  const token = readiness.bootstrapToken;

  assert.equal(typeof url, 'string', `the readiness line carries no url: ${JSON.stringify(readiness)}`);
  assert.equal(
    typeof token,
    'string',
    'a brand-new database announces the credential these tests authenticate with',
  );

  return { url: url as string, token: token as string };
}

/* -------------------------------------------------------------------------- */
/* Making a document's pins resolvable (t283)                                  */
/* -------------------------------------------------------------------------- */

/** Sorts keys recursively — the canonicalization the manifest hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The pin: `sha256:` over the canonical JSON of the five content fields.
 *
 * Reimplemented here rather than imported from `packages/core/src/domain`, for
 * the two reasons this package's header already gives — nothing here reaches
 * into the core's source, and a test that asks the implementation what the right
 * answer is proves only that the implementation agrees with itself.
 */
function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/**
 * Registers a stand-in capability for every pin of a document that resolves to
 * nothing, rewriting those pins in place.
 *
 * Since t283 a graph version whose pins do not all resolve is stored
 * `unchecked`, and `POST /v1/jobs` refuses to create a job against one. Every
 * suite that registers a graph AND then puts work on it therefore has to say
 * which capability each node stands for — and the committed fixtures cannot say
 * it themselves: they pin ids like `cartografo/redigir-nota`, and the registry's
 * kebab-case `id` can never accept a slash.
 *
 * A pin that ALREADY resolves is left untouched: a suite that registered its own
 * manifest has answered for that node on its own terms, and this stepping over
 * it would swap a meaningful contract for an empty one. The ids invented here
 * carry a `-fixture` suffix so they can never collide with one.
 *
 * The manifests are empty schemas on purpose. This exists so a version can be
 * `checked`, not so it can be interesting.
 *
 * @param baseUrl Base URL of a running control plane.
 * @param token Operator credential.
 * @param document Graph document, mutated in place.
 * @returns The same document, with every pin resolvable.
 */
export async function resolvePins(
  baseUrl: string,
  token: string,
  document: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const headers = { authorization: `Bearer ${token}` };
  const nodes = Array.isArray(document.nodes) ? document.nodes : [];

  for (const raw of nodes) {
    const node = raw as Record<string, unknown>;
    const pin = node.skill_ref as { id?: unknown; version?: unknown } | undefined;
    if (pin === undefined || typeof pin.id !== 'string') continue;
    const version = typeof pin.version === 'string' ? pin.version : '1.0.0';

    const known = await fetch(
      `${baseUrl}/v1/skills/${encodeURIComponent(pin.id)}?version=${encodeURIComponent(version)}`,
      { headers },
    );
    if (known.status === 200) continue;

    const id = `${pin.id.split('/').pop() ?? pin.id}-fixture`;
    const manifest: Record<string, unknown> = {
      id,
      version,
      hash: '',
      role: 'work',
      description: `fixture capability standing in for the pin "${pin.id}"`,
      input: { type: 'object' },
      output: { type: 'object' },
      preconditions: [],
      checks: [
        {
          id: 'fixture-check',
          type: 'deterministic',
          description: 'The fixture declares a check, because every manifest owes one.',
          command: 'true',
        },
      ],
      permissions: { filesystem: { read: [], write: [] }, network: { allowed: false } },
      instructions: `Fixture capability for "${pin.id}".`,
      origin: { type: 'native' },
    };
    manifest.hash = manifestHash(manifest);

    const registered = await fetch(`${baseUrl}/v1/skills`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(manifest),
    });
    assert.ok(
      registered.status === 201 || registered.status === 200,
      `registering the fixture manifest "${id}" answered ${registered.status}`,
    );

    node.skill_ref = { id, version, hash: manifest.hash };
  }

  return document;
}

/* -------------------------------------------------------------------------- */
/* Reading the wire glossary, in one place (t287)                              */
/* -------------------------------------------------------------------------- */

export * from './glossary.ts';
