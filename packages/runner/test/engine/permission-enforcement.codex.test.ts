/**
 * Permission enforcement in the `CodexAdapter` (t195, FR6/FR7).
 *
 * Same shape as `permission-enforcement.claude-code.test.ts` and for the same
 * reason: the seam is the command construction, the fake engine stands in for
 * the real binary, and what is asserted is **what the process received** —
 * never what was assembled into the `SessionSpec`, which would be testing the
 * test (`docs/formats/engine-adapter.md`, case C2's forbidden assertion).
 *
 * The two halves of the claim:
 *
 * - a policy the engine cannot express is refused BEFORE the spawn, so no
 *   process exists and no line is ever reported;
 * - a policy it can express reaches the engine's argv, whole.
 *
 * What no automated test here can prove is that the real CLI honours the flags.
 * That needs the real binary, and for this engine it was measured by hand
 * against `codex-cli 0.147.0` on 2026-08-16 with `codex sandbox` — which
 * resolves the same config the `exec` subcommand does — one row per
 * combination:
 *
 * | `sandbox_mode`    | `network_access` | write   | network |
 * |-------------------|------------------|---------|---------|
 * | `read-only`       | `false`          | blocked | blocked |
 * | `read-only`       | `true`           | blocked | blocked |
 * | `workspace-write` | `false`          | allowed | blocked |
 * | `workspace-write` | `true`           | allowed | allowed |
 *
 * Row two is the one that decides this ficha: the override has NO effect under
 * `read-only`, which is why closed writes with an open network are refused
 * rather than approximated.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { buildCommand } from '../../src/engine/codex-command.ts';
import { SessionStartError, type SessionSpec, type SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for a session that is expected to come up and end. */
const DEADLINE_MS = 15_000;

/** The stable prefix every refusal message carries (FR6). */
const REFUSAL_PREFIX = 'permission policy unsupported: ';

/** The `-c` override the workspace-write rows carry. */
const NETWORK_KEY = 'sandbox_workspace_write.network_access';

interface Scenario {
  readonly workingDir: string;
  readonly recordPath: string;
  readonly cleanup: () => void;
}

function buildScenario(): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t195-'));
  const workingDir = join(root, 'workdir');
  mkdirSync(workingDir);
  return {
    workingDir,
    // Outside the workdir: inside, the sidecar would list itself.
    recordPath: join(root, 'record.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The adapter under test, seamed onto the fake engine. */
function newAdapter(): CodexAdapter {
  return new CodexAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

function specFor(scenario: Scenario, permissions: unknown): SessionSpec {
  return {
    workingDir: scenario.workingDir,
    instructions: 'node instructions, coming from the database',
    prompt: 'the work of this turn',
    timeoutSeconds: 30,
    envOverrides: {
      FAKE_ENGINE_RECORD: scenario.recordPath,
      FAKE_ENGINE_EXIT_CODE: '0',
    },
    ...(permissions as Record<string, unknown>),
  } as SessionSpec;
}

/** Everything a session reported, plus a promise that settles on the end. */
function collector(): {
  lines: string[];
  endings: Array<{ status: SessionStatus; exitCode: number | null }>;
  onOutput: (line: string) => void;
  onFinished: (status: SessionStatus, exitCode: number | null) => void;
  end: Promise<void>;
} {
  const lines: string[] = [];
  const endings: Array<{ status: SessionStatus; exitCode: number | null }> = [];
  let announce: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const end = Promise.race([
    settled,
    new Promise<void>((_, reject) => {
      const clock = setTimeout(() => {
        reject(new Error(`the session did not end within ${DEADLINE_MS}ms`));
      }, DEADLINE_MS);
      clock.unref();
    }),
  ]);

  return {
    lines,
    endings,
    onOutput: (line) => {
      lines.push(line);
    },
    onFinished: (status, exitCode) => {
      endings.push({ status, exitCode });
      announce();
    },
    end,
  };
}

/** The argv the fake engine recorded — what the PROCESS received. */
function recordedArgv(scenario: Scenario): string[] {
  const record = JSON.parse(readFileSync(scenario.recordPath, 'utf8')) as { argv: string[] };
  return record.argv;
}

for (const refused of [
  {
    label: 'closed writes with an open network',
    permissions: {
      permissions: { filesystem: { write: [] }, network: { allowed: true } },
    },
    quote: 'no codex sandbox mode',
  },
  {
    label: 'a domain-scoped network allow',
    permissions: {
      permissions: {
        filesystem: { write: ['**'] },
        network: { allowed: true, domains: ['api.openai.com'] },
      },
    },
    quote: 'dominios',
  },
  {
    label: 'a write scope narrower than the workspace',
    permissions: {
      permissions: { filesystem: { write: ['src/**'] }, network: { allowed: false } },
    },
    quote: 'escrita',
  },
]) {
  test(`${refused.label} is refused before any process exists`, async () => {
    const scenario = buildScenario();
    const listener = collector();

    try {
      await assert.rejects(
        () => newAdapter().startSession(specFor(scenario, refused.permissions), listener),
        (error: unknown) => {
          assert.ok(
            error instanceof SessionStartError,
            `expected SessionStartError, got ${String(error)}`,
          );
          assert.ok(
            error.message.startsWith(REFUSAL_PREFIX),
            `the message has to carry the stable prefix: ${error.message}`,
          );
          assert.ok(
            error.message.includes(refused.quote),
            `the message has to name the field to fix: ${error.message}`,
          );
          return true;
        },
      );

      assert.ok(
        !existsSync(scenario.recordPath),
        'the engine process was spawned: a refused policy must not reach the spawn',
      );
      assert.deepEqual(listener.lines, [], 'a refused session reports no output');
      assert.deepEqual(listener.endings, [], 'a refused session never reaches onFinished');
    } finally {
      scenario.cleanup();
    }
  });
}

test('the derrubar-tese policy — no writes, no network — reaches the engine as read-only', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    // `factory-graphs/bets-assimetricas/skills/red-team-thesis.json` — the skill
    // this test still calls by the name t280 retired, `derrubar-tese` — declares
    // exactly this: `filesystem.write: []` and `network.allowed: false`. It is
    // the acceptance criterion of the ficha made concrete — a real factory
    // skill dispatched to a `codex` node.
    await newAdapter().startSession(
      specFor(scenario, {
        permissions: { filesystem: { write: [] }, network: { allowed: false } },
      }),
      listener,
    );
    await listener.end;

    const argv = recordedArgv(scenario);
    const position = argv.indexOf('-s');
    assert.notEqual(position, -1, `the sandbox flag never reached the process: ${argv.join(' ')}`);
    assert.equal(argv[position + 1], 'read-only');
    assert.ok(
      !argv.some((argument) => argument.startsWith(NETWORK_KEY)),
      'nothing opens the network under read-only: the override would be a lie in the argv',
    );
  } finally {
    scenario.cleanup();
  }
});

test('an open policy reaches the engine as workspace-write with the network override', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    await newAdapter().startSession(
      specFor(scenario, {
        permissions: { filesystem: { write: ['**'] }, network: { allowed: true } },
      }),
      listener,
    );
    await listener.end;

    const argv = recordedArgv(scenario);
    const position = argv.indexOf('-s');
    assert.notEqual(position, -1, `the sandbox flag never reached the process: ${argv.join(' ')}`);
    assert.equal(argv[position + 1], 'workspace-write');
    assert.ok(
      argv.includes(`${NETWORK_KEY}=true`),
      `the network override never reached the process: ${argv.join(' ')}`,
    );
    assert.ok(!argv.includes('danger-full-access'), 'FR8: the dangerous tier is out of reach');
  } finally {
    scenario.cleanup();
  }
});

test('a session with no policy reaches the engine with no sandbox flags at all', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    await newAdapter().startSession(specFor(scenario, {}), listener);
    await listener.end;

    const argv = recordedArgv(scenario);
    assert.ok(!argv.includes('-s'), `the sandbox flag showed up unasked: ${argv.join(' ')}`);
    assert.ok(!argv.includes('-c'), `the config override showed up unasked: ${argv.join(' ')}`);
    assert.ok(
      !argv.some((argument) => argument.startsWith('sandbox_workspace_write')),
      'a session that declared nothing keeps the CLI default it always had',
    );
  } finally {
    scenario.cleanup();
  }
});
