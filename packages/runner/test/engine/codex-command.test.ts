/**
 * Building the `codex exec` command.
 *
 * The normative rule these tests protect is the same one `command.test.ts`
 * protects for the `claude` CLI — "the caller never concatenates the two fields"
 * (`docs/formatos/engine-adapter.md:114-149`) — and the correct reading of it
 * lands on the OPPOSITE mechanism here. `codex exec` has no system-prompt flag
 * (`engine-adapter.md:122, 405`), so the injection that satisfies the rule is
 * the composition the specification itself exports for exactly this case,
 * `composeSingleArgument`. What the rule forbids is the CALLER concatenating;
 * an adapter concatenating internally, with the document's own function, is the
 * path the document drew.
 *
 * That is why the assertion below compares against `composeSingleArgument(spec)`
 * and not against a string spelled out here: a hand-written expectation would
 * pass just the same over a reimplementation of the concatenation, which is the
 * one thing FR2 asks not to happen.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODEX_BINARY,
  ENGINE_STDIO,
  MODEL_FLAG,
  TRIVIAL_MODEL_VARIABLE,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/codex-command.ts';
import { composeSingleArgument, type SessionSpec } from '../../src/engine/types.ts';

const INSTRUCTIONS = 'Você é o nó "fazer". Implemente o ticket com testes primeiro.';
const PROMPT = 'Ticket #119: segundo EngineAdapter.';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/test-worktree',
  instructions: INSTRUCTIONS,
  prompt: PROMPT,
  timeoutSeconds: 600,
  ...extra,
});

test('the binary is codex and the headless subcommand is exec', () => {
  const { command, args } = buildCommand(spec());

  assert.equal(command, CODEX_BINARY);
  assert.equal(CODEX_BINARY, 'codex');
  assert.equal(args[0], 'exec', 'the headless mode of the CLI is the `exec` subcommand');
});

test('the command asks for the JSONL stream', () => {
  // `--json` is what turns the output into frames the listener can hand
  // upwards without parsing ("Print events to stdout as JSONL",
  // `engine-adapter.md:409`).
  assert.ok(buildCommand(spec()).args.includes('--json'));
});

test('--skip-git-repo-check always goes, with no conditional', () => {
  // One code path, not two: the kit's workdirs are not git repositories
  // (`conformance-kit.ts:148-161` initializes none) and the flag is harmless
  // against a real worktree. A conditional here would be a branch nothing
  // exercises in CI.
  for (const workingDir of ['/tmp/not-a-git-repo', '/tmp/a-real-worktree']) {
    assert.ok(
      buildCommand(spec({ workingDir })).args.includes('--skip-git-repo-check'),
      `the flag is missing for ${workingDir}`,
    );
  }
});

test('-C carries the workingDir of the spec', () => {
  const { args } = buildCommand(spec({ workingDir: '/tmp/somewhere-else' }));

  const position = args.indexOf('-C');
  assert.notEqual(position, -1, 'the command does not point the CLI at the working root');
  assert.equal(args[position + 1], '/tmp/somewhere-else');
});

test('instructions and prompt arrive composed in a SINGLE argv element', () => {
  const { args } = buildCommand(spec());

  const carrying = args.filter(
    (argument) => argument.includes(INSTRUCTIONS) && argument.includes(PROMPT),
  );
  assert.equal(
    carrying.length,
    1,
    'exactly one argv element has to carry the two fields composed — ' +
      'the engine has no system-prompt flag to split them across',
  );
});

test('the composition is the specification function, not a local rewrite', () => {
  const subject = spec();
  const { args } = buildCommand(subject);

  assert.equal(
    args.at(-1),
    composeSingleArgument(subject),
    'the composed argument has to be `composeSingleArgument` byte for byte, ' +
      'and it has to be the last positional of the argv',
  );
});

test('nothing goes to the engine through stdin', () => {
  // Invariant 6, and here it is not decoration: `codex exec --help` says that
  // "if stdin is piped and a prompt is also provided, stdin is appended as a
  // `<stdin>` block", and an open pipe nobody writes to hangs the session
  // waiting for EOF (`engine-adapter.md:436-445`).
  assert.equal(ENGINE_STDIO[0], 'ignore');
  assert.deepEqual([...ENGINE_STDIO], ['ignore', 'pipe', 'pipe']);
});

test('buildEnvironment merges envOverrides on top of the base environment', () => {
  const environment = buildEnvironment(spec({ envOverrides: { MY_KEY: 'value' } }), {
    PATH: '/usr/bin',
    MY_KEY: 'old',
  });

  assert.equal(environment.MY_KEY, 'value');
  assert.equal(environment.PATH, '/usr/bin', 'the base environment has to survive the merge');
});

test('buildEnvironment with no envOverrides returns the base environment', () => {
  assert.deepEqual(buildEnvironment(spec(), { PATH: '/usr/bin' }), { PATH: '/usr/bin' });
});

/* --- model selection (t166, FR8) -------------------------------------------- */

test('t166 — -m carries spec.model, and only when the spec declares one', () => {
  // `-m, --model <MODEL>` — measured against `codex exec --help` on
  // codex-cli 0.147.0, the same version the specification cites.
  const { args } = buildCommand(spec({ model: 'gpt-5.6-luna' }));

  const position = args.indexOf('-m');
  assert.notEqual(position, -1, 'the command does not pass the declared model to the CLI');
  assert.equal(args[position + 1], 'gpt-5.6-luna');
  assert.equal(args.filter((argument) => argument === '-m').length, 1, 'the flag goes exactly once');

  assert.ok(
    !buildCommand(spec()).args.includes('-m'),
    'absent model, absent flag: the CLI resolves its own default',
  );
});

test('t166 — a spec with no model produces byte-identical argv to before the field existed', () => {
  assert.deepEqual(buildCommand(spec({ model: undefined })).args, buildCommand(spec()).args);
});

test('t166 — -m comes before the composed positional, which stays last', () => {
  const subject = spec({ model: 'gpt-5.6-luna' });
  const { args } = buildCommand(subject);

  assert.ok(
    args.indexOf('-m') < args.length - 1,
    'the flag has to sit before the trailing positional prompt',
  );
  assert.equal(
    args.at(-1),
    composeSingleArgument(subject),
    'the composed argument stays the LAST positional, whatever else the argv carries',
  );
});

/* --- tier-driven model selection (t175, FR7) -------------------------------- */

/**
 * The documented gap, proven rather than assumed.
 *
 * The first adapter answers "trivial costs `claude-haiku-4-5` here"; this one
 * has no answer to give, because nothing in this repository establishes which
 * OpenAI model is the cheap one, and a guessed identifier would reach the CLI
 * as a session that dies on an unknown model. So the tier is still RECORDED on
 * the job (FR4) and this adapter simply makes no argv change until an operator
 * names the model themselves.
 *
 * That is a real gap and it is tested as one: `CODEX_TRIVIAL_MODEL` unset has
 * to produce the argv a spec with no tier produces — not a `-m` with an empty
 * value, and not a silent no-op dressed up as success.
 */
test('t175 — a trivial tier is a no-op until CODEX_TRIVIAL_MODEL names a model', () => {
  const baseline = buildCommand(spec(), {}).args;

  assert.deepEqual(
    buildCommand(spec({ modelTier: 'trivial' }), {}).args,
    baseline,
    'with the variable unset the adapter changes nothing — the documented gap',
  );
  assert.deepEqual(
    buildCommand(spec({ modelTier: 'trivial' }), { [TRIVIAL_MODEL_VARIABLE]: '   ' }).args,
    baseline,
    'and a blank one is unset: an empty -m would kill the session',
  );
});

test('t175 — with the variable set, a trivial tier pins that model', () => {
  const { args } = buildCommand(spec({ modelTier: 'trivial' }), {
    [TRIVIAL_MODEL_VARIABLE]: 'gpt-5.6-mini',
  });

  const position = args.indexOf(MODEL_FLAG);
  assert.notEqual(position, -1, 'a named trivial model has to reach the CLI');
  assert.equal(args[position + 1], 'gpt-5.6-mini');
  assert.equal(
    args.filter((argument) => argument === MODEL_FLAG).length,
    1,
    'the flag goes exactly once',
  );
  assert.equal(
    args.at(-1),
    composeSingleArgument(spec({ modelTier: 'trivial' })),
    'the composed argument stays the LAST positional',
  );
});

test('t175 — standard and absent both produce byte-identical argv to no modelTier at all', () => {
  const env = { [TRIVIAL_MODEL_VARIABLE]: 'gpt-5.6-mini' };
  const baseline = buildCommand(spec(), env).args;

  assert.deepEqual(buildCommand(spec({ modelTier: 'standard' }), env).args, baseline);
  assert.deepEqual(buildCommand(spec({ modelTier: undefined }), env).args, baseline);
  assert.ok(
    !baseline.includes('gpt-5.6-mini'),
    'the variable alone re-models nothing: it is read only when a tier asked for it',
  );
});

test('t175 — a node that pinned its own model wins over the tier, and -m still goes once', () => {
  const { args } = buildCommand(spec({ model: 'gpt-5.6-luna', modelTier: 'trivial' }), {
    [TRIVIAL_MODEL_VARIABLE]: 'gpt-5.6-mini',
  });

  assert.equal(
    args.filter((argument) => argument === MODEL_FLAG).length,
    1,
    'exactly one -m reaches the CLI, whatever the two fields say',
  );
  assert.equal(args[args.indexOf(MODEL_FLAG) + 1], 'gpt-5.6-luna', "the node's pin is the one");
});
