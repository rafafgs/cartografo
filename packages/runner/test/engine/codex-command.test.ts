/**
 * Building the `codex exec` command.
 *
 * The normative rule these tests protect is the same one `command.test.ts`
 * protects for the `claude` CLI — "the caller never concatenates the two fields"
 * (`docs/formats/engine-adapter.md:114-149`) — and the correct reading of it
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
  ARGV_INLINE_LIMIT_BYTES,
  CODEX_BINARY,
  ENGINE_STDIO,
  MODEL_FLAG,
  TRIVIAL_MODEL_VARIABLE,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/codex-command.ts';
import { composeSingleArgument, type SessionSpec } from '../../src/engine/types.ts';

const INSTRUCTIONS = 'You are node "fazer". Implement the ticket with tests first.';
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

/* --- sandbox flags from the declared policy (t195, FR7) ---------------------- */

/**
 * Where the policy meets the argv.
 *
 * The classification lives in `codex-permission-policy.ts` and is tested there
 * against outcomes and reasons; what these cases pin is the OTHER half of the
 * boundary — the spelling and the POSITION of the flags. `-s` and `-c` are
 * engine vocabulary, they belong to this module, and the one invariant they
 * must never disturb is the composed prompt staying the last positional.
 */
const permitting = (
  write: readonly string[],
  network: { allowed: boolean; domains?: readonly string[] },
): Partial<SessionSpec> => ({ permissions: { filesystem: { write }, network } });

test('t195 — a spec with no permissions produces the argv it produced before the field was read', () => {
  const { args } = buildCommand(spec());

  assert.ok(!args.includes('-s'), `the sandbox flag showed up unasked: ${args.join(' ')}`);
  assert.ok(!args.includes('-c'), `the config override showed up unasked: ${args.join(' ')}`);
  assert.ok(
    !args.some((argument) => argument.startsWith('sandbox_workspace_write')),
    'a session that declared nothing keeps the CLI default it always had',
  );
  assert.deepEqual(
    buildCommand(spec({ permissions: undefined })).args,
    args,
    'an explicit `undefined` is the same declaration as an absent field',
  );
});

test('t195 — closed writes and a closed network put -s read-only in the argv', () => {
  const { args } = buildCommand(spec(permitting([], { allowed: false })));

  const position = args.indexOf('-s');
  assert.notEqual(position, -1, 'the sandbox tier never reached the argv');
  assert.equal(args[position + 1], 'read-only');
});

test('t195 — the sandbox flags sit after --skip-git-repo-check and before -C', () => {
  const { args } = buildCommand(spec(permitting([], { allowed: false })));

  assert.ok(
    args.indexOf('--skip-git-repo-check') < args.indexOf('-s'),
    `the tier has to follow the git check flag: ${args.join(' ')}`,
  );
  assert.ok(
    args.indexOf('-s') < args.indexOf('-C'),
    `the tier has to precede the working root: ${args.join(' ')}`,
  );
});

test('t195 — an open policy carries workspace-write plus the network override', () => {
  const { args } = buildCommand(spec(permitting(['**'], { allowed: true })));

  const position = args.indexOf('-s');
  assert.notEqual(position, -1, 'the sandbox tier never reached the argv');
  assert.equal(args[position + 1], 'workspace-write');

  const override = args.indexOf('-c');
  assert.notEqual(override, -1, 'the config override never reached the argv');
  assert.equal(args[override + 1], 'sandbox_workspace_write.network_access=true');
});

test('t195 — open writes with a closed network say so explicitly, never by omission', () => {
  // Determinism over an external default: the CLI's own default for this key
  // is already `false`, and the flag goes anyway. One code path, not two.
  const { args } = buildCommand(spec(permitting(['**'], { allowed: false })));

  assert.equal(args[args.indexOf('-s') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('-c') + 1], 'sandbox_workspace_write.network_access=false');
});

test('t195 — the composed prompt stays the LAST positional under every policy', () => {
  for (const permissions of [
    {},
    permitting([], { allowed: false }),
    permitting(['**'], { allowed: false }),
    permitting(['**'], { allowed: true }),
  ]) {
    const subject = spec(permissions);

    assert.equal(
      buildCommand(subject).args.at(-1),
      composeSingleArgument(subject),
      `the composed argument left last place for ${JSON.stringify(permissions)}`,
    );
  }
});

/* --- oversized content and the end-of-options guard (t203) ------------------ */

/**
 * The same two bugs `command.test.ts` pins for the other engine, measured
 * against `codex-cli 0.147.0`:
 *
 * - `codex exec "-1 apples"` → `error: unexpected argument '-1' found`, and
 *   `codex exec ... -- "-1 apples"` succeeds;
 * - the composed argument is `instructions` + `prompt` in ONE argv element, so
 *   it is the element that hits `MAX_ARG_STRLEN` first of anything this adapter
 *   builds.
 *
 * The channel above the limit is stdin, and this is the engine whose `<stdin>`
 * block made invariant 6 normative in the first place — so the branch is only
 * safe because the positional goes away with it: `codex exec --help` appends
 * that block only "if stdin is piped **and a prompt is also provided**".
 * Omitting the positional entirely was measured here to read the prompt clean.
 */
const promptBytes = Buffer.byteLength(PROMPT, 'utf8');

/** Instructions sized so that the composed argument crosses `total` bytes. */
const fillingTo = (total: number): string => 'a'.repeat(total - promptBytes);

test('t203 — the inline limit is 64 KiB, the same margin the other adapter takes', () => {
  assert.equal(ARGV_INLINE_LIMIT_BYTES, 64 * 1024);
});

test('t203 — below the limit the composed argument is preceded by `--`', () => {
  const subject = spec();
  const { args, stdin } = buildCommand(subject);

  assert.equal(args.at(-1), composeSingleArgument(subject), 'the positional stays last');
  assert.equal(args.at(-2), '--', 'the end-of-options marker sits immediately before it');
  assert.equal(stdin, undefined, 'below the limit nothing goes through stdin — invariant 6');
});

test('t203 — a prompt starting with `-` survives as the last argument, verbatim', () => {
  const subject = spec({ prompt: '-1 apples remain; --json is not a flag here' });
  const { args } = buildCommand(subject);

  assert.equal(args.at(-1), composeSingleArgument(subject));
  assert.equal(
    args.at(-2),
    '--',
    'without the marker the CLI answers `unexpected argument` and the session never opens',
  );
});

test('t203 — at the limit the composed argument moves to stdin and leaves the argv', () => {
  const instructions = fillingTo(ARGV_INLINE_LIMIT_BYTES);
  const subject = spec({ instructions });
  const { args, stdin } = buildCommand(subject);

  assert.equal(
    stdin,
    composeSingleArgument(subject),
    'the composition is still `composeSingleArgument` byte for byte — only its destination changed',
  );
  assert.ok(
    !args.some((argument) => argument.includes(instructions) || argument.includes(PROMPT)),
    'no argv element may still carry the content stdin now carries',
  );

  // The argv above the limit is the argv below it minus the two trailing
  // elements: the guard has nothing left to guard once the positional is gone.
  assert.deepEqual(args, buildCommand(spec()).args.slice(0, -2));
});

test('t203 — the boundary: one byte below stays inline, the limit itself switches', () => {
  const below = buildCommand(spec({ instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES - 1) }));
  assert.equal(below.stdin, undefined, 'one byte under the limit is still an inline argv');

  const at = buildCommand(spec({ instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES) }));
  assert.notEqual(at.stdin, undefined, 'at the limit the content leaves the argv');
});

test('t203 — the decision counts UTF-8 bytes, not UTF-16 units', () => {
  const accented = 'á'.repeat(ARGV_INLINE_LIMIT_BYTES - 2_000);
  assert.ok(accented.length < ARGV_INLINE_LIMIT_BYTES, 'the fixture is under the limit by .length');
  assert.ok(
    Buffer.byteLength(accented, 'utf8') > ARGV_INLINE_LIMIT_BYTES,
    'the fixture is over the limit by byte length',
  );

  const subject = spec({ instructions: accented });
  assert.equal(
    buildCommand(subject).stdin,
    composeSingleArgument(subject),
    'a `.length`-based check would have left this content in the argv',
  );
});

test('t203 — the flags of the argv are untouched by the branch', () => {
  // Everything `-C`, `-m` and `-s` do is decided before the size question, and
  // the oversized branch may not silently drop any of it.
  const subject = spec({
    instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES),
    model: 'gpt-5.6-luna',
    permissions: { filesystem: { write: [] }, network: { allowed: false } },
  });
  const { args } = buildCommand(subject);

  assert.equal(args[args.indexOf('-C') + 1], subject.workingDir);
  assert.equal(args[args.indexOf(MODEL_FLAG) + 1], 'gpt-5.6-luna');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
});

test('t195 — a refused policy adds no flags here; refusing is the adapter\'s job', () => {
  // `buildCommand` is pure and has no way to fail a session: the refusal lives
  // in `startSession`, before this is ever called
  // (`permission-enforcement.codex.test.ts`). What this pins is that a refused
  // policy never leaks a HALF-applied sandbox into the argv if the two ever
  // get out of step.
  const { args } = buildCommand(spec(permitting(['src/**'], { allowed: true, domains: ['x'] })));

  assert.ok(!args.includes('-s'), `a refused policy handed out a tier: ${args.join(' ')}`);
  assert.ok(!args.includes('-c'), `a refused policy handed out an override: ${args.join(' ')}`);
});
