/**
 * The neutral capability, resolved by each adapter to a pinned model and an
 * effort from ITS OWN environment (t1282, FR6/FR7/FR8).
 *
 * One parametrised block per adapter, because the three have to behave the same
 * way and only their spelling differs:
 *
 * - precedence is `model`, then `capability`, then `modelTier`, and exactly one
 *   model flag is ever assembled;
 * - `<PREFIX>_MODEL_<LEVEL>` is required (there is NO default model in code, which
 *   is where this field parts company with `modelTier`) and
 *   `<PREFIX>_EFFORT_<LEVEL>` is optional, where the engine has an effort flag;
 * - an unmapped level is refused with a `SessionStartError` before any spawn;
 * - no capability, no change: the argv is byte-identical to what it was.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand as buildClaude } from '../../src/engine/command.ts';
import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { buildCommand as buildCodex } from '../../src/engine/codex-command.ts';
import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import { buildCommand as buildCopilot } from '../../src/engine/copilot-command.ts';
import { SessionStartError, type EngineAdapter, type SessionSpec } from '../../src/engine/types.ts';

const ENGINE_REF = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';

const baseSpec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/wt',
  instructions: 'Be brief.',
  prompt: 'Say hi.',
  timeoutSeconds: 60,
  ...extra,
});

interface Subject {
  engine: 'claude-code' | 'codex' | 'copilot';
  prefix: 'CLAUDE' | 'CODEX' | 'COPILOT';
  modelFlag: string;
  /** The argv elements of the effort flag for a value, or `null` when the engine has none. */
  effort: ((value: string) => string[]) | null;
  build: (spec: SessionSpec, env: NodeJS.ProcessEnv) => string[];
  adapter: () => EngineAdapter;
  /** The argv of `baseSpec()` with no capability, as it was before the field existed. */
  golden: string[];
}

const SUBJECTS: Subject[] = [
  {
    engine: 'claude-code',
    prefix: 'CLAUDE',
    modelFlag: '--model',
    effort: (value) => ['--effort', value],
    build: (spec, env) => buildClaude(spec, env, 'linux').args,
    adapter: () => new ClaudeCodeAdapter(),
    golden: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--system-prompt',
      'Be brief.',
      '--',
      'Say hi.',
    ],
  },
  {
    engine: 'codex',
    prefix: 'CODEX',
    modelFlag: '-m',
    effort: (value) => ['-c', `model_reasoning_effort="${value}"`],
    build: (spec, env) => buildCodex(spec, env, 'linux').args,
    adapter: () => new CodexAdapter(),
    golden: [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      '/tmp/wt',
      '--',
      'Be brief.\n\n---\n\nSay hi.',
    ],
  },
  {
    engine: 'copilot',
    prefix: 'COPILOT',
    modelFlag: '--model',
    effort: null,
    build: (spec, env) => buildCopilot(spec, ENGINE_REF, env, 'linux').args,
    adapter: () => new CopilotAdapter(),
    golden: [
      '-p',
      'Be brief.\n\n---\n\nSay hi.',
      '--output-format',
      'json',
      '--allow-all-tools',
      '--disable-builtin-mcps',
      '--no-custom-instructions',
      '--no-ask-user',
      '--log-level',
      'none',
      '-C',
      '/tmp/wt',
      '--session-id',
      ENGINE_REF,
    ],
  },
];

const countOf = (args: readonly string[], flag: string): number =>
  args.filter((argument) => argument === flag).length;

/** Every `*_MODEL_*`, `*_EFFORT_*` and `*_TRIVIAL_MODEL` variable of one adapter, all set. */
function everythingSet(prefix: string): NodeJS.ProcessEnv {
  return {
    [`${prefix}_MODEL_GENERAL`]: 'general-model',
    [`${prefix}_MODEL_ADVANCED`]: 'advanced-model',
    [`${prefix}_EFFORT_GENERAL`]: 'low',
    [`${prefix}_EFFORT_ADVANCED`]: 'high',
    [`${prefix}_TRIVIAL_MODEL`]: 'trivial-model',
  };
}

for (const subject of SUBJECTS) {
  const { engine, prefix, modelFlag, effort, build } = subject;

  test(`t1282 AT15 — ${engine}: a mapped general level assembles one model flag, and the effort where there is one`, () => {
    const withModelOnly = build(baseSpec({ capability: 'general' }), {
      [`${prefix}_MODEL_GENERAL`]: 'general-model',
    });
    assert.equal(countOf(withModelOnly, modelFlag), 1, 'exactly one model flag');
    assert.equal(withModelOnly[withModelOnly.indexOf(modelFlag) + 1], 'general-model');

    const withEffort = build(baseSpec({ capability: 'general' }), {
      [`${prefix}_MODEL_GENERAL`]: 'general-model',
      [`${prefix}_EFFORT_GENERAL`]: 'medium',
    });
    assert.equal(countOf(withEffort, modelFlag), 1);
    if (effort === null) {
      // No effort flag known to this repository: the variable is not even read.
      assert.deepEqual(withEffort, withModelOnly, 'COPILOT_EFFORT_* adds no flag at all');
    } else {
      const [flag, value] = effort('medium');
      assert.equal(countOf(withEffort, flag), 1, 'exactly one effort flag');
      assert.equal(withEffort[withEffort.indexOf(flag) + 1], value);
    }
  });

  test(`t1282 AT15 — ${engine}: a trimmed value is passed through untouched otherwise`, () => {
    const args = build(baseSpec({ capability: 'general' }), {
      [`${prefix}_MODEL_GENERAL`]: '  spaced-model  ',
      [`${prefix}_EFFORT_GENERAL`]: ' Whatever-It-Says ',
    });
    assert.equal(args[args.indexOf(modelFlag) + 1], 'spaced-model');
    if (effort !== null) {
      const [flag, value] = effort('Whatever-It-Says');
      assert.equal(args[args.indexOf(flag) + 1], value, 'the effort is not interpreted or validated');
    }
  });

  test(`t1282 AT16 — ${engine}: each level reads its own variables and ignores the other's`, () => {
    const env = everythingSet(prefix);
    const advanced = build(baseSpec({ capability: 'advanced' }), env);
    assert.equal(advanced[advanced.indexOf(modelFlag) + 1], 'advanced-model');
    assert.ok(!advanced.includes('general-model'));

    const general = build(baseSpec({ capability: 'general' }), env);
    assert.equal(general[general.indexOf(modelFlag) + 1], 'general-model');
    assert.ok(!general.includes('advanced-model'));

    if (effort !== null) {
      assert.deepEqual(
        advanced.slice(advanced.indexOf(effort('high')[0]), advanced.indexOf(effort('high')[0]) + 2),
        effort('high'),
      );
      assert.ok(!general.includes(effort('high')[1]), 'the general level never takes the advanced effort');
    }
  });

  test(`t1282 AT17 — ${engine}: an unset or blank effort gives the model flag and no effort flag`, () => {
    for (const blank of [undefined, '', '  ']) {
      const env: NodeJS.ProcessEnv = { [`${prefix}_MODEL_ADVANCED`]: 'advanced-model' };
      if (blank !== undefined) env[`${prefix}_EFFORT_ADVANCED`] = blank;
      const args = build(baseSpec({ capability: 'advanced' }), env);
      assert.equal(args[args.indexOf(modelFlag) + 1], 'advanced-model');
      assert.ok(!args.includes('--effort'), 'no claude effort flag');
      assert.ok(
        !args.some((argument) => argument.startsWith('model_reasoning_effort')),
        'no codex effort override',
      );
    }
  });

  test(`t1282 AT18 — ${engine}: an unmapped level is refused with the capability prefix`, () => {
    for (const unmapped of [undefined, '', '   ']) {
      for (const level of ['general', 'advanced'] as const) {
        const env: NodeJS.ProcessEnv = {};
        // The OTHER level is mapped: a mapped neighbour must not rescue this one.
        env[`${prefix}_MODEL_${level === 'general' ? 'ADVANCED' : 'GENERAL'}`] = 'neighbour';
        if (unmapped !== undefined) env[`${prefix}_MODEL_${level.toUpperCase()}`] = unmapped;

        assert.throws(
          () => build(baseSpec({ capability: level }), env),
          (error: unknown) => {
            assert.ok(error instanceof SessionStartError, 'a SessionStartError');
            assert.ok(
              error.message.startsWith(`capability unmapped: ${engine} ${level}`),
              error.message,
            );
            assert.ok(
              error.message.includes(`${prefix}_MODEL_${level.toUpperCase()}`),
              `names the variable to set: ${error.message}`,
            );
            return true;
          },
        );
      }
    }
  });

  test(`t1282 AT19 — ${engine}: startSession rejects with the refusal before any spawn`, async () => {
    const names = [`${prefix}_MODEL_GENERAL`, `${prefix}_MODEL_ADVANCED`];
    const saved = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    try {
      const lines: string[] = [];
      let exited = false;
      await assert.rejects(
        subject.adapter().startSession(baseSpec({ capability: 'general' }), {
          onOutput: (line) => lines.push(line),
          onFinished: () => {
            exited = true;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof SessionStartError);
          assert.ok(
            error.message.startsWith(`capability unmapped: ${engine} general`),
            error.message,
          );
          assert.ok(!error.message.includes('could not start'), 'not a spawn failure');
          return true;
        },
      );
      assert.deepEqual(lines, [], 'the listener was never called');
      assert.equal(exited, false, 'and never told the session ended');
    } finally {
      names.forEach((name, index) => {
        if (saved[index] === undefined) delete process.env[name];
        else process.env[name] = saved[index];
      });
    }
  });

  test(`t1282 AT20 — ${engine}: model wins entirely, with no effort flag and no refusal`, () => {
    const mapped = build(baseSpec({ model: 'pinned-model', capability: 'advanced' }), everythingSet(prefix));
    assert.equal(countOf(mapped, modelFlag), 1);
    assert.equal(mapped[mapped.indexOf(modelFlag) + 1], 'pinned-model');
    assert.ok(!mapped.includes('advanced-model'));
    assert.ok(!mapped.includes('--effort'));
    assert.ok(!mapped.some((argument) => argument.startsWith('model_reasoning_effort')));
    assert.ok(!mapped.includes('high'), 'the effort of the capability is not consulted');

    // ...and an unmapped level does not throw when a model is pinned.
    const unmapped = build(baseSpec({ model: 'pinned-model', capability: 'advanced' }), {});
    assert.equal(unmapped[unmapped.indexOf(modelFlag) + 1], 'pinned-model');
  });

  test(`t1282 AT21 — ${engine}: capability beats modelTier, and a tier alone behaves as before`, () => {
    const env = everythingSet(prefix);
    const both = build(baseSpec({ capability: 'general', modelTier: 'trivial' }), env);
    assert.equal(countOf(both, modelFlag), 1);
    assert.equal(both[both.indexOf(modelFlag) + 1], 'general-model');
    assert.ok(!both.includes('trivial-model'), 'the tier variable is not read');

    // Unmapped capability plus a tier: the refusal is the capability's, the
    // tier does not rescue it.
    assert.throws(() => build(baseSpec({ capability: 'general', modelTier: 'trivial' }), {
      [`${prefix}_TRIVIAL_MODEL`]: 'trivial-model',
    }), SessionStartError);

    // The tier alone: exactly today's behaviour.
    const tier = build(baseSpec({ modelTier: 'trivial' }), env);
    assert.equal(tier[tier.indexOf(modelFlag) + 1], 'trivial-model');
    assert.ok(!tier.includes('general-model') && !tier.includes('--effort'));
  });

  test(`t1282 AT22 — ${engine}: with no capability the argv is the fixed golden one, whatever the environment holds`, () => {
    const loaded = build(baseSpec(), everythingSet(prefix));
    const bare = build(baseSpec(), {});
    // `*_TRIVIAL_MODEL` is the one variable that legitimately changes a tier
    // session, and no tier is set here: it must change nothing either.
    assert.deepEqual(bare, subject.golden, 'the golden array, written out literally');
    assert.deepEqual(loaded, subject.golden, 'and the same with every capability variable set');
    assert.deepEqual(loaded, bare);
  });
}

test('t1282 AT23 — a refused permission policy wins over an unmapped capability (claude-code)', async () => {
  const saved = process.env.CLAUDE_MODEL_GENERAL;
  delete process.env.CLAUDE_MODEL_GENERAL;
  try {
    await assert.rejects(
      new ClaudeCodeAdapter().startSession(
        baseSpec({
          capability: 'general',
          // A network scoped by domain is a policy this engine cannot express.
          permissions: {
            filesystem: { write: [] },
            network: { allowed: true, domains: ['example.com'] },
          },
        }),
        { onOutput: () => undefined, onFinished: () => undefined },
      ),
      (error: unknown) => {
        assert.ok(error instanceof SessionStartError);
        assert.ok(error.message.startsWith('permission policy unsupported: '), error.message);
        assert.ok(!error.message.includes('capability unmapped'));
        return true;
      },
    );
  } finally {
    if (saved !== undefined) process.env.CLAUDE_MODEL_GENERAL = saved;
  }
});
