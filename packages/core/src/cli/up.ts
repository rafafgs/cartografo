/**
 * The one command: control plane, screen and a local runner, in one `npx`
 * (t405, RF-07/RF-08/RNF-15).
 *
 * Until this file existed `npx cartografo` was the control plane and nothing
 * else, and a working installation took three terminals — the server here, the
 * screen there, a runner in a third, each with the token pasted into it by
 * hand. That is three chances to get it wrong before anybody has seen the
 * product work once, and time-to-first-graph is a quality non-negotiable
 * (`notes/2026-08-14-extension-and-quality.md`).
 *
 * What makes it legal is D23 rather than anything here: the D1/D11 boundaries
 * are PROCESS boundaries, not package ones, and `packages/core/package.json`
 * already ships all six binaries in one tarball. So the screen and the runner
 * this file starts are still separate processes with no privilege over the
 * control plane, reached the same way any operator reaches them — by name, off
 * `PATH`, with a credential in their environment. Nothing below imports
 * `@cartografo/screen` or `@cartografo/runner`, and nothing below knows where
 * on disk either of them lives.
 *
 * Four decisions worth stating, because each has a plausible opposite:
 *
 * - **A fresh credential per startup, never the printed one.** The bootstrap
 *   token is minted and printed exactly once, ever (`hasLiveCredential`,
 *   `src/index.ts:283-293`), so the second `up` against a database has nothing
 *   of its own to hand the children it is about to spawn. Minting one per
 *   startup — kept in this process's memory, never printed, revoked when both
 *   children are gone — is what makes the second startup work as well as the
 *   first, and leaves nothing behind that outlives the process that used it.
 * - **The default workspace is provisioned, and only ever the default one.**
 *   `seedDefaultSettings` records a path; nothing creates it, and a runner
 *   cannot cut a worktree from a directory that is not a git repository. So
 *   `up` creates it — but only when the setting still says exactly what the
 *   seed said, and only when nothing is there. An operator who repointed
 *   `workspace_root` at their own checkout gets nothing written under it.
 * - **`runUp` duplicates `main()`'s readiness line instead of calling it.**
 *   `src/index.ts` is deliberately outside this ficha's surface, and the shape
 *   of `main` is wrong for us anyway: its signal handlers close the control
 *   plane and exit, and this command has to forward the signal to two children
 *   and wait for them FIRST. Five keys in two places is the cheaper of the two
 *   costs.
 * - **The screen's port is redeclared here.** `DEFAULT_SCREEN_PORT` is
 *   `packages/screen/src/router.ts:143`'s, restated as a local constant — the
 *   same "constant in two places" trade `packages/runner/src/cli/index.ts`
 *   already makes for the control plane's own URL, and for the same reason: the
 *   core imports nothing from the screen (D1, D11).
 *
 * Everything a test would otherwise need a real browser, a real second binary
 * or a real signal for is a seam ({@link UpSeams}); production passes none of
 * them.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from '../db/connection.ts';
import { READY_EVENT, start } from '../index.ts';
import { DEFAULT_PROJECT } from '../repositories/common.ts';
import { issueCredential, revokeCredential } from '../repositories/credentials.ts';
import { getSettings } from '../repositories/settings.ts';
import { UsageError } from './url.ts';

/**
 * The screen's default port, restated (`packages/screen/src/router.ts:143`).
 *
 * See the header for why it is copied rather than imported.
 */
export const DEFAULT_SCREEN_PORT = 4318;

/** Environment variable the screen reads its port from, and this command with it. */
export const SCREEN_PORT_ENV = 'CARTOGRAFO_SCREEN_PORT';

/** Environment variable that points a child at this control plane. */
export const URL_ENV = 'CARTOGRAFO_URL';

/** Environment variable that carries a child's credential. */
export const TOKEN_ENV = 'CARTOGRAFO_TOKEN';

/** The screen's binary, resolved off `PATH` and never by a path of ours. */
export const SCREEN_BINARY = 'cartografo-screen';

/** The runner's binary, likewise. */
export const RUNNER_BINARY = 'cartografo-runner';

/** The two signals that ask this command to stop. */
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Identity the provisioning commit carries, on its own command line.
 *
 * Passed with `-c` and never read from a config file: this runs on a machine
 * whose only stated prerequisites are Node and `git`, and a global
 * `user.email` is not one of them. A `git commit` with no identity anywhere
 * fails, which would turn the very first `npx cartografo` of a clean machine
 * into an error about somebody's git configuration.
 */
const COMMIT_IDENTITY = Object.freeze([
  '-c',
  'user.name=cartografo',
  '-c',
  'user.email=cartografo@localhost',
  // Same reasoning one step further: an operator with `commit.gpgsign=true`
  // globally would have this commit ask for a passphrase nobody is there to
  // type. What is being created is an empty commit in a scratch repository —
  // there is nothing here for a signature to attest.
  '-c',
  'commit.gpgsign=false',
]);

/** Message of the empty commit that gives the default workspace a HEAD. */
const FIRST_COMMIT_MESSAGE =
  'chore: the empty first commit of the default workspace, so a session can branch from it';

/** The three booleans a command line of `up` can carry. */
export interface UpFlags {
  /** Open the browser on the screen once everything is up. */
  browser: boolean;
  /** Start a local runner. */
  runner: boolean;
  /** Start the screen. */
  screen: boolean;
}

/** Long name of each flag, and the field it turns off. */
const FLAGS: Readonly<Record<string, keyof UpFlags>> = Object.freeze({
  '--no-browser': 'browser',
  '--no-runner': 'runner',
  '--no-screen': 'screen',
});

/**
 * Reads `up`'s own command line.
 *
 * Everything is on by default, because the whole point of the command is that
 * a person who types `npx cartografo` and nothing else ends up looking at a
 * working product. The three flags subtract from that; nothing adds to it.
 *
 * Anything else — a flag nobody declared, a stray positional — is a usage
 * error rather than a silent ignore, the same discipline every other
 * subcommand keeps: somebody who typed `--no-brwoser` meant something, and a
 * command that quietly opened a browser anyway would take a whole startup to
 * disagree with them.
 *
 * @param args Arguments of the subcommand (the command line after `up`, or the
 *   whole of it when `up` was left implicit).
 * @returns Which of the three parts come up.
 * @throws {UsageError} On anything this command cannot read.
 */
export function parseUpFlags(args: string[]): UpFlags {
  const flags: UpFlags = { browser: true, runner: true, screen: true };

  for (const argument of args) {
    const field = FLAGS[argument];
    if (field === undefined) {
      throw new UsageError(
        `up does not understand "${argument}" (it takes ${Object.keys(FLAGS).join(', ')})`,
      );
    }
    flags[field] = false;
  }

  return flags;
}

/**
 * The workspace path `seedDefaultSettings` seeds, computed the same way.
 *
 * The same expression as `src/index.ts:250-254`, and it has to stay the same:
 * what {@link ensureDefaultWorkspace} compares against is whether the setting
 * is still the seeded default, and two different spellings of "the default"
 * would make that comparison always false.
 *
 * @param home Home directory; the process's own unless a test says otherwise.
 * @returns Absolute path of the default workspace.
 */
export function defaultWorkspaceRoot(home: string = os.homedir()): string {
  return path.join(home, '.cartografo', 'workspace');
}

/**
 * Creates the default workspace as a git repository, if that is what it is
 * (t405, FR5).
 *
 * BOTH conditions, and neither is optional. The setting still has to be the
 * seeded default, or an operator who repointed `workspace_root` at a checkout
 * of their own would have this command writing into it. And the directory has
 * to be missing, or a second startup would `git init` over whatever the first
 * one — or the operator — left there. What is left after both is the one case
 * this exists for: a machine where nobody has ever run the product.
 *
 * It runs on EVERY startup and not only the first, because the state it
 * repairs is on disk rather than in the database: an operator who deleted the
 * directory gets it back next time round, without having to know that the
 * setting pointing at it was never the thing that created it.
 *
 * The empty commit is not ceremony. `git worktree add` needs a commit to
 * branch from, and a repository with no `HEAD` gives the first session of the
 * first job a failure about `git` instead of about the work.
 *
 * @param workspaceRoot What the project's `workspace_root` setting says, if it
 *   says anything.
 * @param home Home directory the default is computed from.
 * @returns `true` when THIS call provisioned it; `false` when there was
 *   nothing to do.
 */
export function ensureDefaultWorkspace(
  workspaceRoot: string | undefined,
  home: string = os.homedir(),
): boolean {
  if (workspaceRoot === undefined) return false;
  if (path.resolve(workspaceRoot) !== path.resolve(defaultWorkspaceRoot(home))) return false;
  if (existsSync(workspaceRoot)) return false;

  mkdirSync(workspaceRoot, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync(
    'git',
    [...COMMIT_IDENTITY, 'commit', '--allow-empty', '--quiet', '--message', FIRST_COMMIT_MESSAGE],
    { cwd: workspaceRoot, stdio: 'ignore' },
  );

  return true;
}

/**
 * Where the browser is sent, and where the screen will be listening.
 *
 * `127.0.0.1` and not the control plane's own host: the screen binds loopback
 * and this is a browser on this machine. The port is the operator's
 * `CARTOGRAFO_SCREEN_PORT` if they set one — the same variable reaches the
 * spawned screen through ordinary environment inheritance, so the two cannot
 * disagree — and the screen's own default otherwise.
 *
 * A value that is not a port is passed through verbatim rather than
 * second-guessed: the screen is the one that parses it, and refusing here would
 * only produce a second, worse error message for the same typo.
 *
 * @param env Environment to read the port from.
 * @returns Base URL of the screen.
 */
export function screenUrl(env: NodeJS.ProcessEnv): string {
  const configured = env[SCREEN_PORT_ENV]?.trim();
  const port = configured === undefined || configured === '' ? String(DEFAULT_SCREEN_PORT) : configured;
  return `http://127.0.0.1:${port}`;
}

/** The slice of a running control plane this command uses. */
export interface UpControlPlane {
  db: Database;
  databasePath: string;
  migrationsApplied: string[];
  url: string;
  bootstrapToken: string | null;
  shutdown: () => Promise<void>;
}

/** The slice of a spawned child this command holds on to. */
export interface ChildHandle {
  /** Asks the child to stop. A child that never started ignores it. */
  kill: (signal: NodeJS.Signals) => void;
  /** Resolves once it is gone — immediately, for one that never started. */
  exited: Promise<void>;
}

/** Starts one of the sibling binaries, by name. */
export type SpawnChild = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildHandle;

/** Opens a URL in whatever the operating system considers the browser. */
export type OpenBrowser = (url: string) => void;

/**
 * Registers interest in a stop request, and hands back the way to stop
 * listening.
 *
 * `onStop` is called ONCE PER REQUEST and not once in total: the second signal
 * is what stops the teardown waiting, so a listener that fired only once would
 * leave `^C ^C` doing nothing.
 */
export type ListenForStop = (onStop: () => void) => () => void;

/** Test seams. Production passes none of them. */
export interface UpSeams {
  /** Environment `up` reads and the children inherit. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** What brings the control plane up. Default: `start` of `src/index.ts`. */
  start?: (env: NodeJS.ProcessEnv) => Promise<UpControlPlane>;
  /** What starts a child. Default: `child_process.spawn`, by name, off `PATH`. */
  spawnChild?: SpawnChild;
  /** What opens the browser. Default: the platform's own opener. */
  openBrowser?: OpenBrowser;
  /** How a stop is heard. Default: `SIGINT`/`SIGTERM` on this process. */
  listenForStop?: ListenForStop;
}

/**
 * Starts a sibling binary by name, inheriting this process's stdio.
 *
 * By NAME, resolved off `PATH` by the operating system, and never by a path
 * relative to this package's `bin/`: the same line has to work out of this
 * monorepo, where the binaries are workspace links under `node_modules/.bin`,
 * and out of an installed tarball, where `bundledDependencies` put them
 * somewhere else entirely (t248, D23). Neither case knows about the other.
 *
 * A binary that is not on `PATH` at all is reported by name and nothing more
 * (FR10): the parent must not die of it, and — since `exited` resolves anyway —
 * the shutdown must not end up waiting for a process that never existed.
 *
 * @param command Binary name.
 * @param args Its command line.
 * @param env Its environment.
 * @returns The handle the teardown uses.
 */
function spawnByName(command: string, args: string[], env: NodeJS.ProcessEnv): ChildHandle {
  const child = spawn(command, args, { env, stdio: 'inherit' });

  let settle: () => void = () => undefined;
  const exited = new Promise<void>((resolve) => {
    settle = resolve;
  });

  child.on('exit', () => settle());
  child.on('error', (error: Error) => {
    process.stderr.write(`cartografo: could not start ${command} — ${error.message}\n`);
    settle();
  });

  return {
    kill: (signal) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // `pid === undefined` is a child that failed to spawn; killing it would
      // be signalling nothing, and its `exited` has already settled.
      if (child.pid === undefined) return;
      child.kill(signal);
    },
    exited,
  };
}

/**
 * Opens a URL in the operating system's browser.
 *
 * Fire and forget, detached and unref'd: the opener is a third-party process
 * whose lifetime has nothing to do with this one's, and a browser someone
 * leaves open must not be something `npx cartografo` is waiting for. A failure
 * is one line — the URL is on stdout in the readiness line either way, and a
 * headless machine with no opener is a legitimate place to run this.
 *
 * macOS and Linux only, which is where the rest of this CLI is developed and
 * tested.
 *
 * @param url Address to open.
 */
function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [url], { stdio: 'ignore', detached: true });
  child.on('error', (error: Error) => {
    process.stderr.write(`cartografo: could not open ${url} — ${error.message}\n`);
  });
  child.unref();
}

/**
 * Listens for `SIGINT` and `SIGTERM` on this process.
 *
 * `on` and not `once`, and the listeners are removed on the way out: the
 * second signal is the one that stops the teardown waiting, and a handler left
 * behind would go on answering for a command that has already finished.
 *
 * @param onStop Called on every stop request.
 * @returns The way to stop listening.
 */
function listenForSignals(onStop: () => void): () => void {
  const handler = (): void => onStop();
  for (const signal of STOP_SIGNALS) process.on(signal, handler);
  return () => {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, handler);
  };
}

/**
 * Brings the whole product up, and takes it down again on a stop.
 *
 * The order of the startup is the order of the dependencies, and each step
 * needs the one before it: the control plane exists before there is anything
 * to hand a credential for; the credential exists before there is a child to
 * hand it to; the workspace exists before the runner is asked to cut a
 * worktree from it; the browser opens last, because a browser that arrives
 * before the screen is listening shows an error page.
 *
 * It returns only when the command is asked to stop, which is what makes it
 * the body of a foreground process rather than a setup routine.
 *
 * @param flags Which of the three parts come up.
 * @param seams Test seams; production passes nothing.
 * @returns Once everything it started is down and the control plane is closed.
 */
export async function runUp(flags: UpFlags, seams: UpSeams = {}): Promise<void> {
  const env = seams.env ?? process.env;
  const startControlPlane = seams.start ?? start;
  const spawnChild = seams.spawnChild ?? spawnByName;
  const openBrowser = seams.openBrowser ?? openInBrowser;
  const listenForStop = seams.listenForStop ?? listenForSignals;

  const controlPlane = await startControlPlane(env);

  // The same five keys `main()` prints, and deliberately the same five: a
  // supervisor, or `startup.test.ts`, reads this line to know the control plane
  // is up, and the command growing two children is not a reason for it to
  // change shape (see the header for why this is a copy).
  process.stdout.write(
    `${JSON.stringify({
      event: READY_EVENT,
      database: controlPlane.databasePath,
      migrationsApplied: controlPlane.migrationsApplied.length,
      url: controlPlane.url,
      bootstrapToken: controlPlane.bootstrapToken,
    })}\n`,
  );

  // Listening starts HERE, before the first child exists: a ^C during the
  // setup below is a stop like any other, and a command that only started
  // listening once everything was up would ignore it for as long as the setup
  // took — which is exactly when an operator who mistyped something presses it.
  let requests = 0;
  let announceFirst: () => void = () => undefined;
  let announceSecond: () => void = () => undefined;
  const firstStop = new Promise<void>((resolve) => {
    announceFirst = resolve;
  });
  const secondStop = new Promise<void>((resolve) => {
    announceSecond = resolve;
  });
  const unlisten = listenForStop(() => {
    requests += 1;
    if (requests === 1) announceFirst();
    else announceSecond();
  });

  const children: ChildHandle[] = [];
  let credential: { id: number; token: string } | null = null;

  try {
    // Nobody to hand it to is nobody to mint it for: `--no-runner --no-screen`
    // is the control plane on its own, and it needs no credential of ours.
    if (flags.screen || flags.runner) {
      credential = issueCredential(controlPlane.db, { type: 'user' });

      // Straight off the open handle, with no HTTP round trip: this process IS
      // the single writer (D1), and asking itself over the network for a row it
      // is holding would be ceremony.
      if (flags.runner) {
        ensureDefaultWorkspace(getSettings(controlPlane.db, DEFAULT_PROJECT).workspace_root);
      }

      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        [URL_ENV]: controlPlane.url,
        [TOKEN_ENV]: credential.token,
      };

      // No arguments for either, and that is the whole of FR6: the runner takes
      // its two paths and its engine from this project's settings (t404), and
      // neither child is scoped to a project, so both land on project 1 like
      // every other unscoped command. An operator who wants a differently
      // configured runner starts one by hand and passes `--no-runner`.
      if (flags.screen) children.push(spawnChild(SCREEN_BINARY, [], childEnv));
      if (flags.runner) children.push(spawnChild(RUNNER_BINARY, [], childEnv));
    }

    if (flags.browser) openBrowser(screenUrl(env));
  } catch (error) {
    // A startup that broke halfway leaves nothing running and nothing live: the
    // credential it may have minted has no holder, and a control plane nobody
    // announced would hold the lock forever.
    for (const child of children) child.kill('SIGTERM');
    if (credential !== null) revokeCredential(controlPlane.db, credential.id);
    await controlPlane.shutdown();
    unlisten();
    throw error;
  }

  await firstStop;

  // The children first, and all the way: the control plane is the only writer
  // of the database, and closing it under a runner that is mid-lease would take
  // its answer away from it. There is no timeout of ours on top — the runner
  // already applies its own grace (`--shutdown-grace-seconds`, 120s by default)
  // and a second, shorter clock here would just make that flag a lie.
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([
    Promise.all(children.map((child) => child.exited)),
    // ...unless a second signal says otherwise. Somebody pressing ^C twice is
    // saying they are not waiting any more, which is the same convention the
    // runner itself keeps for its own session in flight.
    secondStop.then(() => {
      for (const child of children) child.kill('SIGKILL');
    }),
  ]);

  // Only now, and in this order: the credential dies while the database is
  // still open, and the database closes last of all.
  if (credential !== null) revokeCredential(controlPlane.db, credential.id);
  await controlPlane.shutdown();
  unlisten();
}
