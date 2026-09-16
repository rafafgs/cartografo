/**
 * The one-command startup, decided in process (t405, FR2/FR3/FR5–FR8).
 *
 * `startup.test.ts` spawns the real binary, which is the only honest way to
 * prove that `npx cartografo` brings its processes up and takes them down
 * again. It is also a real control plane and a real runner per case, and what
 * `up` actually DECIDES — whether to spawn the runner, with which environment —
 * is a small surface that has no business costing two processes per assertion.
 *
 * So this file calls `runUp` as a function, over the seams `cli/up.ts`
 * publishes: the control plane, the spawner and the wait for a stop signal.
 * Nothing here starts a process or opens a port; what it does start is a real,
 * migrated database, because the credential `up` hands its child is a row in it
 * and a fake would prove nothing about that.
 *
 * Since t549 (D27) there is no screen and no browser: `--no-runner` is the one
 * flag `up` takes, and `--no-screen`/`--no-browser` are typos like any other.
 *
 * Naming convention of `cli-router-unit.test.ts`; artifacts are loaded behind
 * `requireArtifacts` so the initial red NAMES the file that is missing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Database } from '../src/db/connection.ts';
import type * as ConnectionModule from '../src/db/connection.ts';
import type * as MigrateModule from '../src/db/migrate.ts';
import type * as UpModule from '../src/cli/up.ts';
import type { ChildHandle, UpControlPlane, UpFlags } from '../src/cli/up.ts';
import { UsageError } from '../src/cli/url.ts';
import { verifyToken } from '../src/repositories/credentials.ts';
import { CONTROL_PLANE_ONLY as TEST_SUPPORT_CONTROL_PLANE_ONLY } from '@cartografo/test-support';

import { CONTROL_PLANE_ONLY as CLI_SUPPORT_CONTROL_PLANE_ONLY } from './cli-support.ts';
import { capture } from './cli-unit-support.ts';
import { MIGRATIONS_DIR, requireArtifacts, startControlPlane } from './support.ts';

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
  t.after(() => {
    db.close();
  });
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
 * @param flags The one boolean of the command line.
 * @param env Environment `up` reads and the child inherits.
 * @returns The spawn calls and the database it minted into.
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
      listenForStop: (onStop) => {
        onStop();
        return () => undefined;
      },
    });
    return 0;
  });

  return {
    spawned,
    db,
    controlPlaneUrl,
    shutdowns,
    stdout: run.stdout,
    stderr: run.stderr,
  };
}

test('t405 AT2 — parseUpFlags starts with the runner on, and --no-runner turns it off', async () => {
  const { parseUpFlags } = await loadUp();

  const none = parseUpFlags([]);
  assert.deepEqual(none, { runner: true }, 'the command with no flag is the whole product coming up');
  assert.equal('screen' in none, false, 'there is no screen to start or skip (t549)');
  assert.equal('browser' in none, false, 'and no browser to open (t549)');

  assert.deepEqual(parseUpFlags(['--no-runner']), { runner: false });

  // A flag repeated is still that flag.
  assert.deepEqual(parseUpFlags(['--no-runner', '--no-runner']), { runner: false });
});

test('t405 AT2 — a flag `up` does not know, and a stray positional, are wrong command lines', async () => {
  const { parseUpFlags } = await loadUp();

  for (const line of [
    ['--no-runnr'],
    ['--project', '2'],
    ['--url=http://x'],
    ['--no-runner', '--verbose'],
    ['import'],
    ['--no-runner', 'extra'],
  ]) {
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

test('t549 AT3 — --no-screen and --no-browser are gone, and fail like any other typo', async () => {
  const { parseUpFlags } = await loadUp();

  for (const line of [
    ['--no-screen'],
    ['--no-browser'],
    ['--no-runner', '--no-screen'],
    ['--no-browser', '--no-runner'],
  ]) {
    assert.throws(
      () => parseUpFlags(line),
      (error: unknown) => {
        assert.ok(error instanceof UsageError, `not a UsageError: ${String(error)}`);
        assert.match(error.message, /up does not understand/);
        assert.doesNotMatch(
          error.message,
          /takes[^)]*--no-(screen|browser)/,
          'the usage hint no longer offers a removed flag',
        );
        return true;
      },
      line.join(' '),
    );
  }
});

test('t549 AT5 — CONTROL_PLANE_ONLY carries only the flag `up` still knows, in both shared helpers', () => {
  assert.deepEqual([...TEST_SUPPORT_CONTROL_PLANE_ONLY], ['--no-runner'], '@cartografo/test-support');
  assert.deepEqual([...CLI_SUPPORT_CONTROL_PLANE_ONLY], ['--no-runner'], 'packages/core/test/cli-support.ts');
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

test('t549 AT4 — `up` has no screen to spawn and no browser to open', async (t) => {
  const up = (await loadUp()) as unknown as Record<string, unknown>;

  for (const retired of [
    'SCREEN_BINARY',
    'SCREEN_PORT_ENV',
    'DEFAULT_SCREEN_PORT',
    'screenUrl',
    'openInBrowser',
  ]) {
    assert.equal(retired in up, false, `cli/up.ts still exports ${retired}`);
  }

  const run = await runSeamed(t, { runner: true });
  assert.deepEqual(
    run.spawned.map((call) => call.command),
    [up.RUNNER_BINARY],
    'the only child `up` spawns is the runner',
  );
});

test('t405 AT5 — the runner is spawned by name, credentialed, and with no path flags', async (t) => {
  const { RUNNER_BINARY } = await loadUp();

  const run = await runSeamed(t, { runner: true });

  assert.deepEqual(
    run.spawned.map((call) => call.command),
    [RUNNER_BINARY],
    'one runner, spawned by binary name and never by a path',
  );

  const runner = run.spawned[0];
  assert.ok(runner !== undefined);
  for (const flag of ['--working-dir', '--worktrees-root', '--engine', '--project']) {
    assert.ok(!runner.args.includes(flag), `the runner must not be given ${flag}`);
  }
  assert.deepEqual(
    runner.args,
    [],
    'the runner is given nothing at all: those three are the settings fallback\'s (t404)',
  );

  // One credential, minted for this startup and never printed.
  assert.equal(runner.env.CARTOGRAFO_URL, run.controlPlaneUrl, 'the runner was not told where the control plane is');
  const token = runner.env.CARTOGRAFO_TOKEN;
  assert.equal(typeof token, 'string');
  assert.ok((token ?? '').length > 0, 'the runner was handed no credential');

  assert.ok(!run.stdout.includes(token ?? ''), 'the internal credential is never printed on stdout');
  assert.ok(!run.stderr.includes(token ?? ''), 'nor on stderr');
  assert.equal(
    verifyToken(run.db, token ?? ''),
    null,
    'and a clean shutdown revokes it: it authenticates nothing once `up` is gone',
  );

  // A control-plane-only startup spawns nothing — and, since t360, still mints
  // a credential, because the auto-import of the interview bundle is a client
  // of this control plane like any other and is not gated by the flag (FR1).
  // What is protected is that nothing outlives the process.
  const neither = await runSeamed(t, { runner: false });
  assert.deepEqual(neither.spawned, [], 'control-plane-only startup spawns nothing');
  assert.equal(
    (
      neither.db
        .prepare('SELECT COUNT(*) AS total FROM credential WHERE revoked_at IS NULL')
        .get() as { total: number }
    ).total,
    0,
    'and it leaves no live credential behind: whatever the import used died with the startup',
  );
});

test('t449 AT1 — resolveSibling finds the runner\'s delegator script in `up`\'s own package, never on `PATH`', async () => {
  const { RUNNER_BINARY, resolveSibling } = await loadUp();

  // A caller-supplied directory is used verbatim: the mapping this function
  // owns is command name -> script file name, and nothing else.
  const elsewhere = path.join(path.sep, 'opt', 'cartografo', 'bin');
  assert.equal(
    resolveSibling(RUNNER_BINARY, elsewhere),
    path.join(elsewhere, 'cartografo-runner.mjs'),
    'the runner is its delegator script inside the given bin/',
  );

  // With no directory it is `packages/core/bin/`, at the fixed offset from
  // `up.ts` itself — the same relative-offset trick `mapDesignBundle` plays for
  // `factory-graphs/`, and the whole reason a bare-path invocation works.
  const shipped = path.resolve(import.meta.dirname, '..', 'bin');
  const resolved = resolveSibling(RUNNER_BINARY);
  assert.ok(path.isAbsolute(resolved), `${RUNNER_BINARY} has to resolve to an absolute path`);
  assert.equal(path.dirname(resolved), shipped, `${RUNNER_BINARY} is looked for in this package's own bin/`);
  assert.ok(existsSync(resolved), `artifact does not exist yet: ${resolved}`);

  // Anything else is a caller's mistake, and the message has to say which —
  // including the screen's old name, which is no child of `up` any more (t549).
  const retiredScreen = ['cartografo', 'screen'].join('-');
  for (const command of ['cartografo-mcp', retiredScreen]) {
    assert.throws(
      () => resolveSibling(command),
      new RegExp(command),
      `${command} has no delegator of ours: it throws, naming it`,
    );
  }
  assert.equal(
    existsSync(path.join(shipped, `${retiredScreen}.mjs`)),
    false,
    'the screen\'s delegator script is gone from bin/ (t549)',
  );
});

test('t449 AT2 — a child that could not start names the command AND the path that was tried', async () => {
  const { MISSING_SIBLING, RUNNER_BINARY, spawnFailureLine } = await loadUp();

  const tried = path.join(path.sep, 'opt', 'cartografo', 'bin', 'cartografo-runner.mjs');

  // The two failures a reader must be able to tell apart: nothing at the path,
  // and something there that `spawn` refused.
  for (const reason of [MISSING_SIBLING, 'EACCES: permission denied']) {
    const line = spawnFailureLine(RUNNER_BINARY, tried, reason);
    assert.ok(line.includes(RUNNER_BINARY), `the command is missing from: ${line}`);
    assert.ok(line.includes(tried), `the resolved path is missing from: ${line}`);
    assert.ok(line.includes(reason), `the reason is missing from: ${line}`);
    assert.ok(line.endsWith('\n'), 'one line, terminated');
    assert.equal(line.trimEnd().split('\n').length, 1, `one line and not a dump: ${line}`);
  }
});

test('t405 FR1 — the readiness line `up` prints carries the same five keys as before', async (t) => {
  const run = await runSeamed(t, { runner: false });

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

test('t405 FR2 — a leading `--…` is `up`\'s own flag, and a bad one is exit 2 either way', async () => {
  const { runCli } = await import(new URL('../src/cli/index.ts', import.meta.url).href) as {
    runCli: (args: string[], env?: NodeJS.ProcessEnv) => Promise<number>;
  };

  // Both spellings reach the same parser, and both fail the same way. Without
  // the router's leading-`--` detection the first line below would die with
  // `unknown subcommand: "--no-runnr"`, which says nothing about the typo.
  for (const line of [
    ['--no-runnr'],
    ['up', '--no-runnr'],
    ['--no-runner', 'extra'],
    ['--no-screen'],
    ['up', '--no-browser'],
  ]) {
    const run = await capture(async () => await runCli(line, {}));

    assert.equal(run.code, 2, `${line.join(' ')}: a wrong command line is exit 2`);
    assert.match(run.stderr, /up does not understand/, line.join(' '));
    assert.doesNotMatch(
      run.stderr,
      /unknown subcommand/,
      'a flag of `up` is not a subcommand nobody declared',
    );
    assert.equal(run.stdout, '', 'nothing was started, so nothing announced itself');
  }
});

/* -------------------------------------------------------------------------- */
/* The interview bundle, imported at the first start (t360, FR1 / AT5)        */
/* -------------------------------------------------------------------------- */

/**
 * The same startup, but against a control plane that really answers.
 *
 * The seamed helper above hands `runUp` a URL nobody is listening on, which is
 * exactly right for the decisions it measures — which children, with which
 * environment — and useless for the one thing this ficha adds: an import that
 * goes out over HTTP, through the very pipeline `cartografo import` uses (D1).
 * So these cases start a real server over a real database and hand `runUp` the
 * two facts it needs about it.
 *
 * @param t Test context.
 * @param ctx A control plane already listening.
 * @param env Environment `up` reads; the bundle root travels in it.
 * @returns What the startup printed, and how often it shut down.
 */
async function runAgainstServer(
  t: TestHook,
  ctx: { db: Database; url: string },
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; shutdowns: number }> {
  const { runUp } = await loadUp();
  const base = temporaryArea(t, 'cartografo-t360-up-');

  let shutdowns = 0;
  const controlPlane: UpControlPlane = {
    db: ctx.db,
    databasePath: path.join(base, 'cartografo.db'),
    migrationsApplied: [],
    url: ctx.url,
    bootstrapToken: null,
    shutdown: async () => {
      shutdowns += 1;
    },
  };

  const run = await capture(async () => {
    await runUp(
      { runner: false },
      {
        env,
        start: async () => controlPlane,
        spawnChild: () => ({ kill: () => undefined, exited: Promise.resolve() }),
        listenForStop: (onStop) => {
          onStop();
          return () => undefined;
        },
      },
    );
    return 0;
  });

  return { stdout: run.stdout, stderr: run.stderr, shutdowns };
}

/** How many versions of one lineage the database holds. */
function versionsOf(db: Database, graphId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM graph_version WHERE graph_id = ?')
    .get(graphId) as { total: number };
  return row.total;
}

test('t360 AT5 — the first start imports map-design, and the second imports nothing', async (t) => {
  const { MAP_DESIGN_CLASS, mapDesignBundle } = await loadUp();
  const ctx = await startControlPlane(t);

  assert.equal(MAP_DESIGN_CLASS, 'map-design', 'the class the interview travels on');
  assert.ok(
    existsSync(path.join(mapDesignBundle({}), 'graph.json')),
    `artifact does not exist yet: ${path.join(mapDesignBundle({}), 'graph.json')}`,
  );
  assert.equal(versionsOf(ctx.db, MAP_DESIGN_CLASS), 0, 'a brand-new database knows no map');

  const first = await runAgainstServer(t, ctx, {});
  assert.equal(
    versionsOf(ctx.db, MAP_DESIGN_CLASS),
    1,
    `the interview has to be there before anybody can start one: ${first.stderr}`,
  );
  assert.equal(first.shutdowns, 1, 'and the startup still finished cleanly');

  const skills = ctx.db
    .prepare('SELECT COUNT(*) AS total FROM skill WHERE id IN (?, ?)')
    .get('interview', 'deliver-bundle') as { total: number };
  assert.ok(skills.total >= 2, 'the bundle`s manifests are registered by the same import');

  // Second startup, same database: the check is `getGraph`, so there is nothing
  // to do and nothing is sent.
  const second = await runAgainstServer(t, ctx, {});
  assert.equal(
    versionsOf(ctx.db, MAP_DESIGN_CLASS),
    1,
    `a second start must not fork a second version of the same map: ${second.stderr}`,
  );
});

test('t360 AT5 — a bundle `up` cannot read is a line on stderr, never a failed startup', async (t) => {
  const { EXAMPLES_ROOT_ENV, MAP_DESIGN_CLASS } = await loadUp();
  const ctx = await startControlPlane(t);

  const root = temporaryArea(t, 'cartografo-t360-broken-');
  mkdirSync(path.join(root, MAP_DESIGN_CLASS), { recursive: true });
  writeFileSync(path.join(root, MAP_DESIGN_CLASS, 'graph.json'), '{ this is not json');

  const run = await runAgainstServer(t, ctx, { [EXAMPLES_ROOT_ENV]: root });

  assert.equal(run.shutdowns, 1, 'a broken bundle in a future release may not stop the product');
  assert.match(
    run.stderr,
    /map-design/,
    `the failure is reported, and it names the bundle: ${run.stderr}`,
  );
  assert.equal(versionsOf(ctx.db, MAP_DESIGN_CLASS), 0, 'and nothing was registered');
});
