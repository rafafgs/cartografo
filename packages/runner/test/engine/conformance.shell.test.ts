/**
 * The `ShellAdapter` running the conformance kit, plus the cases that are this
 * engine's alone (t332).
 *
 * The third adapter, and the first one that runs no model. Everything the kit
 * certifies about a session's LIFECYCLE — one `onFinished`, no line after it, no
 * orphaned process, the first stop winning the race, two independent watchdogs —
 * is engine-agnostic by construction, which is exactly the claim this file
 * tests: the same `runConformanceKit` the other two adapters run, imported and
 * not copied, against an adapter that spawns a command instead of a CLI.
 *
 * Two cases do not run, and both are declared rather than quietly absent:
 *
 * - **C2 (skill injection)** asks whether `instructions` and `prompt` reached the
 *   process. On this engine they must NOT: what runs is `command.argv`, and the
 *   manifest's body is documentation for whoever reads the registry
 *   (`specs/formats/skill-manifest.md`). Injecting the rendered prose into a
 *   subprocess's environment to satisfy the case would put the whole prompt where
 *   FR4 just spent a ticket closing the door. It is replaced by the argv case
 *   below, which asks the same question — did what the skill declared reach the
 *   process — in this engine's own vocabulary.
 * - **C11 (oversized prompt)** is out of scope by the ticket's own decision: the
 *   argv/env ceiling (`E2BIG`) is real, the two known first consumers are dates
 *   and file paths, and dodging it is a ticket of its own.
 *
 * The kit reports both as skipped WITH the reason, so a reader of the test output
 * sees nine cases and two written-down exemptions, instead of nine cases and a
 * silence.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runConformanceKit } from '../../src/engine/conformance-kit.ts';
import { ShellAdapter } from '../../src/engine/shell-adapter.ts';
import {
  BASELINE_CAPABILITIES,
  SessionStartError,
  type EngineAdapter,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
} from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

runConformanceKit(
  (fakeEnginePath) =>
    new ShellAdapter({
      // The kit's seam. Its specs carry no `command` block — they cannot: the
      // kit speaks `SessionSpec` and knows nothing about which engine is under
      // test — so this is where the fake engine becomes the command this node
      // runs. Only the argv is supplied; everything else about the session, the
      // environment included, still goes through the adapter's own path.
      commandBuilder: () => ({ command: process.execPath, args: [fakeEnginePath] }),
      // Short grace: C4 waits for the escalation to SIGKILL inside its own
      // deadline.
      graceMs: 300,
    }),
  FAKE_ENGINE,
  {
    skip: {
      C2:
        'the instructions of a shell node are documentation, never the thing that runs — ' +
        'replaced by the argv case of conformance.shell.test.ts',
      C11: 'oversized content inside command.argv is out of scope for t332',
    },
  },
);

test('engineName is the stable identifier persisted on the session row', () => {
  assert.equal(new ShellAdapter().engineName, 'shell');
});

test('capabilities is the baseline, whole — this engine does nothing extra', () => {
  // Not "declares nothing": the baseline is three explicit falses, and a shell
  // node has no resume, no structured frames and no token accounting to report.
  // Lighting any of them up would be a capability with no consumer, which is how
  // a published format rots (`types.ts`).
  assert.deepEqual(new ShellAdapter().capabilities(), BASELINE_CAPABILITIES);
});

test('verifyCli answers for a subprocess this adapter spawns itself', async () => {
  // There is no external binary to probe. `available: true` because the ability
  // to spawn belongs to this process; `version: null` because inventing one
  // would report a fact about a CLI that does not exist; `authenticated: true`
  // because the field means "I found no reason to fail", and there is no
  // credential in this engine to have found a reason in.
  assert.deepEqual(await new ShellAdapter().verifyCli(), {
    available: true,
    version: null,
    authenticated: true,
  });
});

test('listModels is not implemented: there is no engine here to have a catalog', () => {
  // Read through the interface on purpose: `listModels?()` is optional ON THE
  // MEMBER, and a consumer checks for it before calling it (`run.ts`'s
  // `reportModels` does exactly that). An adapter without one is a legitimate
  // adapter, and this one has nothing to list — a command is not a model.
  const adapter: EngineAdapter = new ShellAdapter();
  assert.equal(adapter.listModels, undefined);
});

/* -------------------------------------------------------------------------- */
/* The cases that are this engine's own                                        */
/* -------------------------------------------------------------------------- */

/** What the fake engine recorded about what the process received. */
interface FakeRecord {
  readonly argv: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
  readonly stdin: string;
}

/** Collects one session's lines and its single outcome. */
class Ending implements SessionListener {
  readonly lines: string[] = [];
  readonly reached: Promise<{ status: SessionStatus; exitCode: number | null }>;
  #settle: ((outcome: { status: SessionStatus; exitCode: number | null }) => void) | null = null;

  constructor() {
    this.reached = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  onOutput(line: string): void {
    this.lines.push(line);
  }

  onFinished(status: SessionStatus, exitCode: number | null): void {
    this.#settle?.({ status, exitCode });
  }
}

interface Run {
  readonly received: FakeRecord;
  readonly workingDir: string;
}

/** Runs one session to its end and hands back what the fake engine recorded. */
async function run(
  t: { after: (fn: () => void) => void },
  command: NonNullable<SessionSpec['command']>,
  envOverrides: Record<string, string> = {},
): Promise<Run> {
  const workingDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'cartografo-shell-')));
  t.after(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });
  const recordPath = path.join(workingDir, 'record.json');

  const ending = new Ending();
  await new ShellAdapter({ graceMs: 300 }).startSession(
    {
      workingDir,
      instructions: 'documentation for whoever reads the registry',
      prompt: 'the work of this turn',
      timeoutSeconds: 30,
      command,
      envOverrides: { ...envOverrides, FAKE_ENGINE_RECORD: recordPath, FAKE_ENGINE_EXIT_CODE: '0' },
    },
    ending,
  );

  const outcome = await ending.reached;
  assert.equal(
    outcome.status,
    'completed',
    `the fixture session did not run: ${ending.lines.join('\n')}`,
  );

  return { received: JSON.parse(readFileSync(recordPath, 'utf8')) as FakeRecord, workingDir };
}

test('the declared argv reaches spawn byte for byte — no shell, no quoting layer', async (t) => {
  // The elements a shell would have rewritten, all of them at once: a leading
  // dash, an embedded space, a variable reference, a command substitution, a
  // glob, a quote. `spawn(..., {shell: false})` is what makes them arrive as
  // themselves — and the fake engine's sidecar is what the PROCESS received,
  // which is the only channel that can prove it.
  const declared = ['-n', 'two words', '$HOME', '`id`', '*.md', 'a"b'];

  const { received } = await run(t, { argv: [process.execPath, FAKE_ENGINE, ...declared] });

  assert.deepEqual(
    received.argv,
    declared,
    'every argument arrived as the literal string the skill declared',
  );
  assert.equal(received.stdin, '', 'and nothing was written to its stdin — invariant 6');
});

test('the command runs in spec.workingDir, and nowhere else', async (t) => {
  const { received, workingDir } = await run(t, { argv: [process.execPath, FAKE_ENGINE] });

  assert.equal(received.cwd, workingDir, 'invariant 7: the session directory is the write scope');
});

test('the env allowlist copies what it names and leaves the rest behind', async (t) => {
  // The whole of FR4, measured through a real process: the runner carries both
  // variables, the skill named one of them, and only that one may cross.
  process.env.CARTOGRAFO_SHELL_ALLOWED = 'bar';
  process.env.CARTOGRAFO_SHELL_SECRET = 'nope';
  t.after(() => {
    delete process.env.CARTOGRAFO_SHELL_ALLOWED;
    delete process.env.CARTOGRAFO_SHELL_SECRET;
  });

  const { received } = await run(t, {
    argv: [process.execPath, FAKE_ENGINE],
    envAllowlist: ['CARTOGRAFO_SHELL_ALLOWED'],
  });

  assert.equal(received.env.CARTOGRAFO_SHELL_ALLOWED, 'bar');
  assert.ok(
    !('CARTOGRAFO_SHELL_SECRET' in received.env),
    `a variable nobody allowlisted reached the child: ${Object.keys(received.env).join(', ')}`,
  );
});

/**
 * Names the operating system puts in a child's environ whatever we pass.
 *
 * Measured, not assumed: on macOS, CoreFoundation injects
 * `__CF_USER_TEXT_ENCODING` into every spawned process — `spawn(node, …, {env:
 * {FOO: '1'}})` comes back with two keys, not one. It is the platform writing
 * into the child AFTER the environment this adapter built, so it is neither an
 * inheritance nor something an allowlist could close, and the honest thing is to
 * name it here rather than to loosen the assertion into "contains".
 */
const PLATFORM_INJECTED = ['__CF_USER_TEXT_ENCODING'];

test('with no allowlist the child sees nothing but envOverrides', async (t) => {
  process.env.CARTOGRAFO_SHELL_SECRET = 'nope';
  t.after(() => {
    delete process.env.CARTOGRAFO_SHELL_SECRET;
  });

  const { received } = await run(
    t,
    { argv: [process.execPath, FAKE_ENGINE] },
    { REPORT_DIR: '/tmp/x' },
  );

  assert.deepEqual(
    Object.keys(received.env)
      .filter((name) => !PLATFORM_INJECTED.includes(name))
      .sort(),
    ['FAKE_ENGINE_EXIT_CODE', 'FAKE_ENGINE_RECORD', 'REPORT_DIR'],
    'the child environment is exactly what the dispatch layered on, and nothing inherited — ' +
      'no PATH, no HOME, no credential the operator happened to be carrying',
  );
});

test('a spec with no command block refuses the session before any process exists', async () => {
  const ending = new Ending();

  await assert.rejects(
    () =>
      new ShellAdapter().startSession(
        {
          workingDir: tmpdir(),
          instructions: 'prose, which is not a command',
          prompt: 'the work of this turn',
          timeoutSeconds: 30,
        },
        ending,
      ),
    SessionStartError,
    'a shell node with nothing to run has to refuse, never run its own documentation',
  );

  assert.deepEqual(ending.lines, [], 'a session that never opened reports nothing');
});
