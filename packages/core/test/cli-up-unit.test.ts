/**
 * The one-command startup, decided in process (t405, FR2/FR3/FR5–FR8).
 *
 * `startup.test.ts` spawns the real binary, which is the only honest way to
 * prove that `npx cartografo` brings three processes up and takes all three
 * down again. It is also a real control plane, a real screen and a real runner
 * per case, and what `up` actually DECIDES — which children to spawn, with
 * which environment, which URL the browser gets — is a small combinatorial
 * surface that has no business costing three processes per assertion.
 *
 * So this file calls `runUp` as a function, over the seams `cli/up.ts`
 * publishes: the control plane, the spawner, the browser opener and the wait
 * for a stop signal. Nothing here starts a process, opens a port or opens a
 * browser; what it does start is a real, migrated database, because the
 * credential `up` hands its children is a row in it and a fake would prove
 * nothing about that.
 *
 * Naming convention of `cli-router-unit.test.ts`; artifacts are loaded behind
 * `requireArtifacts` so the initial red NAMES the file that is missing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as UpModule from '../src/cli/up.ts';
import type { ChildHandle, UpControlPlane, UpFlags } from '../src/cli/up.ts';
import { UsageError } from '../src/cli/url.ts';
import { capture } from './cli-unit-support.ts';
import { MIGRATIONS_DIR, requireArtifacts } from './support.ts';

/** The module under test, relative to the root of `packages/core`. */
const UP_MODULE = 'src/cli/up.ts';

/** The slice of `node:test`'s context this file uses. */
interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function load<T>(relative: string): Promise<T> {
  requireArtifacts(relative);
  return (await import(new URL(`../${relative}`, import.meta.url).href)) as T;
}

async function loadUp(): Promise<typeof UpModule> {
  return await load<typeof UpModule>(UP_MODULE);
}

/** A throwaway directory, removed when the test ends. */
function temporaryArea(t: TestHook, prefix: string): string {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/** A migrated, throwaway database — no HTTP: the credential is what matters. */
async function openMigrated(t: TestHook, base: string): Promise<Database> {
  const { openDatabase, applyPragmas } = await load<typeof ConnectionModule>('src/db/connection.ts');
  const { migrate } = await load<typeof MigrateModule>('src/db/migrate.ts');

  const db = openDatabase(path.join(base, 'cartografo.db'));
  applyPragmas(db);
  migrate(db, MIGRATIONS_DIR);
  t.after(() => db.close());
  return db;
}

/** One call to the spawn seam, as the test reads it back. */
interface SpawnCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Everything one seamed `runUp` did. */
interface Run {
  spawned: SpawnCall[];
  opened: string[];
  db: Database;
  controlPlaneUrl: string;
  shutdowns: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `runUp` end to end over the seams, and returns what it did.
 *
 * The stop is announced the moment `up` starts listening for it, so the whole
 * startup runs and the teardown follows immediately: what this file checks is
 * the DECISIONS of the startup, and a test that had to wait for a real signal
 * would be a test about `process.on`.
 *
 * @param t Test context, for the temporary database.
 * @param flags The three booleans of the command line.
 * @param env Environment `up` reads and the children inherit.
 * @returns The spawn calls, the opened URLs and the database it minted into.
 */
async function runSeamed(
  t: TestHook,
  flags: UpFlags,
  env: NodeJS.ProcessEnv = {},
): Promise<Run> {
  const { runUp } = await loadUp();

  const base = temporaryArea(t, 'cartografo-t405-unit-');
  const db = await openMigrated(t, base);

  const spawned: SpawnCall[] = [];
  const opened: string[] = [];
  const controlPlaneUrl = 'http://127.0.0.1:4317';
  let shutdowns = 0;

  const controlPlane: UpControlPlane = {
    db,
    databasePath: path.join(base, 'cartografo.db'),
    migrationsApplied: [],
    url: controlPlaneUrl,
    bootstrapToken: null,
    shutdown: async () => {
      shutdowns += 1;
    },
  };

  const child = (): ChildHandle => ({
    kill: () => undefined,
    exited: Promise.resolve(),
  });

  const run = await capture(async () => {
    await runUp(flags, {
      env,
      start: async () => controlPlane,
      spawnChild: (command, args, childEnv) => {
        spawned.push({ command, args, env: childEnv });
        return child();
      },
      openBrowser: (url) => {
        opened.push(url);
      },
      listenForStop: (onStop) => {
        onStop();
        return () => undefined;
      },
    });
    return 0;
  });

  return {
    spawned,
    opened,
    db,
    controlPlaneUrl,
    shutdowns,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

test('t405 AT2 — parseUpFlags starts with all three on, and each flag flips exactly its own', async () => {
  const { parseUpFlags } = await loadUp();

  assert.deepEqual(
    parseUpFlags([]),
    { browser: true, runner: true, screen: true },
    'the command with no flag is the whole product coming up',
  );

  assert.deepEqual(parseUpFlags(['--no-browser']), { browser: false, runner: true, screen: true });
  assert.deepEqual(parseUpFlags(['--no-runner']), { browser: true, runner: false, screen: true });
  assert.deepEqual(parseUpFlags(['--no-screen']), { browser: true, runner: true, screen: false });

  assert.deepEqual(
    parseUpFlags(['--no-browser', '--no-runner', '--no-screen']),
    { browser: false, runner: false, screen: false },
    'all three together is a control-plane-only startup',
  );

  // Order is not a meaning, and a flag repeated is still that flag.
  assert.deepEqual(parseUpFlags(['--no-screen', '--no-browser']), {
    browser: false,
    runner: true,
    screen: false,
  });
  assert.deepEqual(parseUpFlags(['--no-runner', '--no-runner']), {
    browser: true,
    runner: false,
    screen: true,
  });
});

test('t405 AT2 — a flag `up` does not know, and a stray positional, are wrong command lines', async () => {
  const { parseUpFlags } = await loadUp();

  for (const line of [['--no-brwoser'], ['--project', '2'], ['--url=http://x'], ['--no-browser', '--verbose']]) {
    assert.throws(
      () => parseUpFlags(line),
      (error: unknown) => {
        assert.ok(error instanceof UsageError, `not a UsageError: ${String(error)}`);
        return true;
      },
      line.join(' '),
    );
  }

  for (const line of [['import'], ['--no-runner', 'extra']]) {
    assert.throws(
      () => parseUpFlags(line),
      (error: unknown) => {
        assert.ok(error instanceof UsageError, `not a UsageError: ${String(error)}`);
        return true;
      },
      line.join(' '),
    );
  }
});

test('t405 AT3 — ensureDefaultWorkspace provisions the seeded default, once, and nothing else', async (t) => {
  const { defaultWorkspaceRoot, ensureDefaultWorkspace } = await loadUp();

  const home = temporaryArea(t, 'cartografo-t405-home-');
  const workspace = defaultWorkspaceRoot(home);

  assert.equal(
    workspace,
    path.join(home, '.cartografo', 'workspace'),
    'the same path `seedDefaultSettings` seeds, computed the same way',
  );
  assert.equal(existsSync(workspace), false, 'fixture broken: the home already had a workspace');

  assert.equal(ensureDefaultWorkspace(workspace, home), true, 'a missing default is provisioned');
  assert.ok(existsSync(path.join(workspace, '.git')), 'and it is provisioned as a git repository');
  assert.equal(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    '1',
    'with exactly one commit — a repository with no HEAD has nothing to cut a worktree from',
  );

  // Every startup runs this check, not only the first: the second one must find
  // the repository it left and add nothing to it.
  assert.equal(ensureDefaultWorkspace(workspace, home), false, 'an existing directory is left alone');
  assert.equal(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(),
    '1',
    'no second empty commit',
  );

  // A directory that exists and is NOT a repository is still somebody's
  // directory: `git init` over it would be this command deciding what is in it.
  const plain = path.join(home, 'not-a-repository');
  mkdirSync(plain, { recursive: true });
  assert.equal(ensureDefaultWorkspace(plain, home), false);
  assert.equal(existsSync(path.join(plain, '.git')), false, 'a plain directory is not initialised');

  // And the case this guard exists for: an operator who repointed
  // `workspace_root` somewhere of their own gets nothing created under it.
  const elsewhere = path.join(home, 'my-own-checkout');
  assert.equal(ensureDefaultWorkspace(elsewhere, home), false);
  assert.equal(existsSync(elsewhere), false, 'a workspace_root away from the default is untouched');

  assert.equal(ensureDefaultWorkspace(undefined, home), false, 'no setting at all is nothing to do');
});

test('t405 AT4 — the browser is opened once, on the screen, and only when it was asked for', async (t) => {
  const { DEFAULT_SCREEN_PORT, SCREEN_PORT_ENV } = await loadUp();

  const all = await runSeamed(t, { browser: true, runner: true, screen: true });
  assert.deepEqual(
    all.opened,
    [`http://127.0.0.1:${String(DEFAULT_SCREEN_PORT)}`],
    'the browser lands on the screen, on its own default port, exactly once',
  );

  const none = await runSeamed(t, { browser: false, runner: true, screen: true });
  assert.deepEqual(none.opened, [], '--no-browser opens nothing');

  const configured = await runSeamed(
    t,
    { browser: true, runner: true, screen: true },
    { [SCREEN_PORT_ENV]: '4999' },
  );
  assert.deepEqual(
    configured.opened,
    ['http://127.0.0.1:4999'],
    'an operator who set CARTOGRAFO_SCREEN_PORT gets the browser on that port — the same variable reaches the spawned screen',
  );
});

test('t405 AT5 — both children are spawned by name, credentialed, and with no path flags', async (t) => {
  const { RUNNER_BINARY, SCREEN_BINARY } = await loadUp();
  const { verifyToken } = await import(
    new URL('../src/repositories/credentials.ts', import.meta.url).href
  );

  const both = await runSeamed(t, { browser: false, runner: true, screen: true });

  assert.deepEqual(
    both.spawned.map((call) => call.command).sort(),
    [RUNNER_BINARY, SCREEN_BINARY].sort(),
    'one screen and one runner, each spawned by binary name and never by a path',
  );

  const runner = both.spawned.find((call) => call.command === RUNNER_BINARY);
  assert.ok(runner !== undefined);
  assert.deepEqual(
    runner.args,
    [],
    'the runner is given nothing: --working-dir/--worktrees-root/--engine are the settings fallback\'s (t404)',
  );
  for (const flag of ['--working-dir', '--worktrees-root', '--engine', '--project']) {
    assert.ok(!runner.args.includes(flag), `the runner must not be given ${flag}`);
  }

  const screen = both.spawned.find((call) => call.command === SCREEN_BINARY);
  assert.ok(screen !== undefined);
  assert.deepEqual(screen.args, [], 'and neither is the screen');

  // One credential for both, minted for this startup and never printed.
  const tokens = new Set<string>();
  for (const call of both.spawned) {
    assert.equal(call.env.CARTOGRAFO_URL, both.controlPlaneUrl, `${call.command} was not told where the control plane is`);
    const token = call.env.CARTOGRAFO_TOKEN;
    assert.equal(typeof token, 'string');
    assert.ok((token ?? '').length > 0, `${call.command} was handed no credential`);
    tokens.add(token ?? '');
  }
  assert.equal(tokens.size, 1, 'one credential per startup, handed to both children');

  const token = [...tokens][0];
  assert.ok(!both.stdout.includes(token), 'the internal credential is never printed on stdout');
  assert.ok(!both.stderr.includes(token), 'nor on stderr');
  assert.equal(
    verifyToken(both.db, token),
    null,
    'and a clean shutdown revokes it: it authenticates nothing once `up` is gone',
  );

  const withoutRunner = await runSeamed(t, { browser: false, runner: false, screen: true });
  assert.deepEqual(
    withoutRunner.spawned.map((call) => call.command),
    [SCREEN_BINARY],
    '--no-runner spawns no runner',
  );

  const withoutScreen = await runSeamed(t, { browser: false, runner: true, screen: false });
  assert.deepEqual(
    withoutScreen.spawned.map((call) => call.command),
    [RUNNER_BINARY],
    '--no-screen spawns no screen',
  );

  // Nobody to hand a credential to is nobody to mint one for (FR3).
  const neither = await runSeamed(t, { browser: false, runner: false, screen: false });
  assert.deepEqual(neither.spawned, [], 'control-plane-only startup spawns nothing');
  assert.equal(
    (neither.db.prepare('SELECT COUNT(*) AS total FROM credential').get() as { total: number }).total,
    0,
    '--no-runner --no-screen mints no internal credential: there is nobody to hand it to',
  );
});

test('t405 FR1 — the readiness line `up` prints carries the same five keys as before', async (t) => {
  const run = await runSeamed(t, { browser: false, runner: false, screen: false });

  const line = run.stdout
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith('{'));
  assert.ok(line !== undefined, `no readiness line on stdout:\n${run.stdout}`);

  const readiness = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(readiness).sort(),
    ['bootstrapToken', 'database', 'event', 'migrationsApplied', 'url'],
    'the five keys of `cartografo.ready`, unchanged (t127 FR6, t124 FR4)',
  );
  assert.equal(readiness.event, 'cartografo.ready');
  assert.equal(run.shutdowns, 1, 'the stop shuts the control plane down exactly once');
});
