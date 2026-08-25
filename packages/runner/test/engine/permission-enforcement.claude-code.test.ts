/**
 * Permission enforcement in the `ClaudeCodeAdapter` (t125, FR3/FR4).
 *
 * Same shape as `conformance.claude-code.test.ts` and for the same reason: the
 * seam is the command construction, the fake engine stands in for the real
 * binary, and what is asserted is **what the process received** — never what
 * was assembled into the `SessionSpec`, which would be testing the test
 * (`docs/formats/engine-adapter.md`, case C2's forbidden assertion).
 *
 * The two halves of the claim:
 *
 * - a policy the engine cannot express is refused BEFORE the spawn, so no
 *   process exists and no line is ever reported;
 * - a policy it can express reaches the engine's argv, whole.
 *
 * What no automated test here can prove is that the real CLI honours the flag —
 * that needs a real, authenticated binary and lives in
 * `scripts/spike-permission-enforcement.mjs`, the same division of labour t104
 * set up.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { SessionStartError, type SessionSpec, type SessionStatus } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Deadline for a session that is expected to come up and end. */
const DEADLINE_MS = 15_000;

/** The stable prefix every refusal message carries (FR3). */
const REFUSAL_PREFIX = 'permission policy unsupported: ';

interface Scenario {
  readonly workingDir: string;
  readonly recordPath: string;
  readonly cleanup: () => void;
}

function buildScenario(): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t125-'));
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
function newAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
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
    label: 'a domain-scoped network allow',
    permissions: {
      permissions: {
        filesystem: { write: ['**'] },
        network: { allowed: true, domains: ['api.anthropic.com'] },
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
          assert.ok(error instanceof SessionStartError, `expected SessionStartError, got ${String(error)}`);
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

test('a closed network reaches the engine argv as denied tools', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    await newAdapter().startSession(
      specFor(scenario, {
        permissions: { filesystem: { write: ['**'] }, network: { allowed: false } },
      }),
      listener,
    );
    await listener.end;

    const argv = recordedArgv(scenario);
    assert.ok(argv.includes('--disallowedTools'), `the flag never reached the process: ${argv.join(' ')}`);
    for (const tool of ['WebFetch', 'WebSearch', 'Bash(curl *)', 'Bash(wget *)']) {
      assert.ok(argv.includes(tool), `the process did not receive ${JSON.stringify(tool)}`);
    }
    assert.ok(!argv.includes('Write'), 'the whole workspace was writable: Write must not be denied');
  } finally {
    scenario.cleanup();
  }
});

test('an empty write scope reaches the engine argv as denied tools', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    await newAdapter().startSession(
      specFor(scenario, {
        permissions: { filesystem: { write: [] }, network: { allowed: true } },
      }),
      listener,
    );
    await listener.end;

    const argv = recordedArgv(scenario);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      assert.ok(argv.includes(tool), `the process did not receive ${JSON.stringify(tool)}`);
    }
    assert.ok(!argv.includes('WebFetch'), 'the network was allowed: WebFetch must not be denied');
  } finally {
    scenario.cleanup();
  }
});

test('a session with no policy reaches the engine with no denied tools at all', async () => {
  const scenario = buildScenario();
  const listener = collector();

  try {
    await newAdapter().startSession(specFor(scenario, {}), listener);
    await listener.end;

    const argv = recordedArgv(scenario);
    assert.ok(!argv.includes('--disallowedTools'), `the flag showed up unasked: ${argv.join(' ')}`);
    assert.ok(!argv.includes('--add-dir'), 'invariant 7: never a directory beyond workingDir');
  } finally {
    scenario.cleanup();
  }
});
