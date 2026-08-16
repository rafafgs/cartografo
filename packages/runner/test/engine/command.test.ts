/**
 * Building the `claude` CLI command.
 *
 * What these tests protect is the specification's normative rule: "the caller
 * never concatenates the two fields"
 * (`docs/formatos/engine-adapter.md:114-149`). Claude Code has a native
 * `--system-prompt`, so the correct injection here is the flag — concatenating
 * would be adopting, unreviewed, the path of whoever does *not* have the flag,
 * and erasing the difference precisely on the engine that does it better.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAUDE_BINARY,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_TRIVIAL_MODEL,
  ENGINE_STDIO,
  PERMISSION_MODE_VARIABLE,
  TRIVIAL_MODEL_VARIABLE,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/command.ts';
import type { SessionSpec } from '../../src/engine/types.ts';

const INSTRUCTIONS = 'Você é o nó "fazer". Implemente o ticket com testes primeiro.';
const PROMPT = 'Ticket #104: EngineAdapter do Claude Code.';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/test-worktree',
  instructions: INSTRUCTIONS,
  prompt: PROMPT,
  timeoutSeconds: 600,
  ...extra,
});

test('instructions never arrives concatenated to the prompt', () => {
  const { args } = buildCommand(spec(), {});

  for (const argument of args) {
    assert.ok(
      !(argument.includes(INSTRUCTIONS) && argument.includes(PROMPT)),
      `the argument ${JSON.stringify(argument)} carries instructions AND prompt in the same value`,
    );
  }
});

test('--system-prompt carries instructions verbatim', () => {
  const { args } = buildCommand(spec(), {});

  const position = args.indexOf('--system-prompt');
  assert.notEqual(position, -1, 'the command does not use the native system-prompt flag');
  assert.equal(
    args[position + 1],
    INSTRUCTIONS,
    'the node instructions have to go verbatim, with no prefix, suffix or reformatting',
  );
});

test('prompt is the last element of the argv', () => {
  const { command, args } = buildCommand(spec(), {});

  assert.equal(command, CLAUDE_BINARY);
  assert.equal(args.at(-1), PROMPT);
});

test('the command runs headless with structured output', () => {
  const { args } = buildCommand(spec(), {});

  assert.ok(args.includes('--print'), 'without --print the CLI opens an interactive session');
  assert.ok(args.includes('--verbose'));

  const format = args.indexOf('--output-format');
  assert.notEqual(format, -1);
  assert.equal(args[format + 1], 'stream-json');
});

test('with no explicit --permission-mode the default is bypassPermissions', () => {
  const { args } = buildCommand(spec(), {});

  const position = args.indexOf('--permission-mode');
  assert.notEqual(position, -1);
  assert.equal(args[position + 1], 'bypassPermissions');
  assert.equal(DEFAULT_PERMISSION_MODE, 'bypassPermissions');
});

test('CLAUDE_PERMISSION_MODE overrides the default, and only it', () => {
  const { args } = buildCommand(spec(), { [PERMISSION_MODE_VARIABLE]: 'plan' });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('envOverrides of the spec does not change the permission mode', () => {
  // Permission policy is the adapter's business, not the caller's: while D4's
  // tension is unresolved (`engine-adapter.md:515-532`), no engine
  // configuration crosses the boundary from above.
  const { args } = buildCommand(
    spec({ envOverrides: { [PERMISSION_MODE_VARIABLE]: 'acceptEdits' } }),
    {},
  );

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
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
  const environment = buildEnvironment(spec(), { PATH: '/usr/bin' });

  assert.deepEqual(environment, { PATH: '/usr/bin' });
});

test('stdin of the engine process is closed by default', () => {
  // Invariant 6 of the specification: an open pipe nobody writes to hangs the
  // session forever, waiting for EOF.
  assert.equal(ENGINE_STDIO[0], 'ignore');
  assert.deepEqual([...ENGINE_STDIO], ['ignore', 'pipe', 'pipe']);
});

/* --- permission enforcement (t125, FR4/FR5) -------------------------------- */

/** The network entries the closed-network policy resolves to. */
const NETWORK_DENIED = [
  'WebFetch',
  'WebSearch',
  'Bash(curl *)',
  'Bash(wget *)',
  'Bash(nc *)',
  'Bash(netcat *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(telnet *)',
];

/** ...and the writing ones. */
const WRITE_DENIED = ['Edit', 'Write', 'NotebookEdit'];

/** The values between `--disallowedTools` and the next flag. */
function disallowedTools(args: string[]): string[] {
  const position = args.indexOf('--disallowedTools');
  if (position === -1) return [];
  const rest = args.slice(position + 1);
  const end = rest.findIndex((argument) => argument.startsWith('--'));
  return end === -1 ? rest : rest.slice(0, end);
}

test('a session with no permissions produces exactly the argv of today', () => {
  // The regression that matters most in this ticket: enforcement is opt-in per
  // session, and a caller that says nothing has to keep getting the command it
  // was getting before the field existed.
  const { args } = buildCommand(spec(), {});

  assert.deepEqual(args, [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--system-prompt',
    INSTRUCTIONS,
    PROMPT,
  ]);
});

test('a closed network becomes --disallowedTools with the network entries', () => {
  const { args } = buildCommand(
    spec({ permissions: { filesystem: { write: ['**'] }, network: { allowed: false } } }),
    {},
  );

  const denied = disallowedTools(args);
  for (const tool of NETWORK_DENIED) {
    assert.ok(denied.includes(tool), `--disallowedTools does not carry ${JSON.stringify(tool)}`);
  }
  for (const tool of WRITE_DENIED) {
    assert.ok(!denied.includes(tool), `the whole workspace is writable: ${tool} must not be denied`);
  }
});

test('an empty write scope becomes --disallowedTools with the writing entries', () => {
  const { args } = buildCommand(
    spec({ permissions: { filesystem: { write: [] }, network: { allowed: true } } }),
    {},
  );

  const denied = disallowedTools(args);
  for (const tool of WRITE_DENIED) {
    assert.ok(denied.includes(tool), `--disallowedTools does not carry ${JSON.stringify(tool)}`);
  }
  assert.ok(!denied.includes('WebFetch'), 'the network was allowed: WebFetch must not be denied');
});

test('each denied entry is one argv element, whole', () => {
  // `--disallowedTools <tools...>` is variadic, and the help itself uses
  // `"Bash(git *) Edit"` — an entry that carries a space. One element per entry
  // is what keeps `Bash(curl *)` from arriving split in half.
  const { args } = buildCommand(
    spec({ permissions: { filesystem: { write: [] }, network: { allowed: false } } }),
    {},
  );

  assert.ok(args.includes('Bash(curl *)'), 'the pattern did not survive as a single argument');
  assert.equal(args.indexOf('--disallowedTools') + 1, args.indexOf('Edit'));
  assert.ok(
    args.indexOf('--system-prompt') > args.indexOf('--disallowedTools'),
    'the denied list has to end before the system prompt, or the variadic swallows it',
  );
  assert.equal(args.at(-1), PROMPT, 'the prompt stays the last element of the argv');
});

/* --- session continuation (t173, FR3/FR4) ---------------------------------- */

/** An engine ref in the shape `onEngineRef` reports for this engine. */
const ENGINE_REF = 'engine-session-ref-abc123';

test('--resume carries the engine ref of the session being continued', () => {
  const { args } = buildCommand(spec({ resumeFrom: ENGINE_REF }), {});

  const position = args.indexOf('--resume');
  assert.notEqual(position, -1, 'a spec with resumeFrom has to ask the CLI to resume');
  assert.equal(
    args[position + 1],
    ENGINE_REF,
    'the engine ref goes verbatim: it is opaque, and reformatting it is inventing an id',
  );
});

test('--resume is placed where neither variadic can swallow it', () => {
  // Two things in this argv eat what follows them: the `--disallowedTools
  // <tools...>` list and the `--system-prompt <prompt> <prompt>` trailer. The
  // ref landing inside either one would arrive as a denied tool or as part of
  // the prompt, and the CLI would open a fresh session without saying so.
  const { args } = buildCommand(
    spec({
      resumeFrom: ENGINE_REF,
      permissions: { filesystem: { write: [] }, network: { allowed: false } },
    }),
    {},
  );

  const position = args.indexOf('--resume');
  assert.equal(args[position + 1], ENGINE_REF);
  assert.ok(
    position < args.indexOf('--disallowedTools'),
    'the ref falls inside the denied list, which is variadic and swallows it',
  );
  assert.ok(
    position < args.indexOf('--system-prompt'),
    'the ref falls after the system-prompt flag, which is the trailer of the argv',
  );
  assert.deepEqual(
    disallowedTools(args),
    [...WRITE_DENIED, ...NETWORK_DENIED],
    'the denied list changed shape because of the resume flag',
  );
  assert.equal(args.at(-1), PROMPT, 'the prompt stays the last element of the argv');
});

test('a session with no resumeFrom produces exactly the argv of before the field existed', () => {
  // FR4, the regression pin: continuation is opt-in per session, and a caller
  // that says nothing has to keep getting the command it was getting before.
  assert.deepEqual(buildCommand(spec(), {}).args, [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--system-prompt',
    INSTRUCTIONS,
    PROMPT,
  ]);

  // ...and the same with a policy declared, which is the argv that has the two
  // variadics the flag had to be placed around.
  assert.deepEqual(
    buildCommand(spec({ permissions: { filesystem: { write: [] }, network: { allowed: false } } }), {})
      .args,
    [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--disallowedTools',
      ...WRITE_DENIED,
      ...NETWORK_DENIED,
      '--system-prompt',
      INSTRUCTIONS,
      PROMPT,
    ],
  );
});

test('no command ever carries --add-dir', () => {
  // Invariant 7: the session sees `workingDir` and nothing else. An extra
  // directory here would hand back, in one flag, the write scope the policy
  // above just closed.
  const specs = [
    spec(),
    spec({ permissions: { filesystem: { write: [] }, network: { allowed: false } } }),
    spec({ permissions: { filesystem: { write: ['**'] }, network: { allowed: true } } }),
  ];

  for (const candidate of specs) {
    const { args } = buildCommand(candidate, {});
    assert.ok(
      !args.some((argument) => argument === '--add-dir' || argument.startsWith('--add-dir=')),
      `the command carries --add-dir: ${JSON.stringify(args)}`,
    );
  }
});

/* --- model selection (t166, FR7) -------------------------------------------- */

test('t166 — --model carries spec.model, and only when the spec declares one', () => {
  const { args } = buildCommand(spec({ model: 'claude-haiku-4-5' }), {});

  const position = args.indexOf('--model');
  assert.notEqual(position, -1, 'the command does not pass the declared model to the CLI');
  assert.equal(args[position + 1], 'claude-haiku-4-5');
  assert.equal(
    args.filter((argument) => argument === '--model').length,
    1,
    'the flag goes exactly once',
  );

  assert.ok(
    !buildCommand(spec(), {}).args.includes('--model'),
    'absent model, absent flag: the CLI resolves its own default',
  );
});

test('t166 — a spec with no model produces byte-identical argv to before the field existed', () => {
  // The regression that matters: `model` is opt-in per node, and a dispatch
  // that says nothing has to keep getting the command it was getting.
  assert.deepEqual(buildCommand(spec({ model: undefined }), {}).args, buildCommand(spec(), {}).args);
});

test('t166 — --model neither swallows the denied list nor gets swallowed by the prompt', () => {
  const { args } = buildCommand(
    spec({
      model: 'claude-haiku-4-5',
      permissions: { filesystem: { write: [] }, network: { allowed: false } },
    }),
    {},
  );

  // `--disallowedTools` is variadic: the model flag has to close before it
  // starts, or `--model` and its value end up inside the tool list.
  assert.ok(
    args.indexOf('--model') < args.indexOf('--disallowedTools'),
    'the model flag has to come before the variadic denied list',
  );

  const denied = disallowedTools(args);
  assert.ok(!denied.includes('--model'), 'the denied list swallowed the model flag');
  assert.ok(!denied.includes('claude-haiku-4-5'), 'the denied list swallowed the model value');
  for (const tool of [...NETWORK_DENIED, ...WRITE_DENIED]) {
    assert.ok(denied.includes(tool), `the denied list lost ${JSON.stringify(tool)}`);
  }

  // ...and the trailing positionals stay trailing.
  assert.equal(args.at(-1), PROMPT, 'the prompt stays the last element of the argv');
  assert.equal(args.at(-2), INSTRUCTIONS);
  assert.ok(args.indexOf('--model') < args.indexOf('--system-prompt'));
});

/* --- tier-driven model selection (t175, FR6) -------------------------------- */

/**
 * `modelTier` is the interface's word; `claude-haiku-4-5` is this CLI's.
 *
 * That split is the whole reason the tier crosses boundary 1 instead of the
 * model id: the runner has no business knowing which model is the cheap one for
 * `claude`, and the dispatch that sets `modelTier` routes to whichever engine
 * the node resolved to. Each adapter answers "what does trivial cost HERE" in
 * its own vocabulary — and the Codex one answers "I have no default", which is
 * why the two files disagree on purpose.
 */
test('t175 — a trivial tier pins the documented cheap model when nothing overrides it', () => {
  const { args } = buildCommand(spec({ modelTier: 'trivial' }), {});

  const position = args.indexOf('--model');
  assert.notEqual(position, -1, 'a trivial tier has to reach the CLI as a model flag');
  assert.equal(args[position + 1], DEFAULT_TRIVIAL_MODEL);
  assert.equal(
    args.filter((argument) => argument === '--model').length,
    1,
    'the flag goes exactly once',
  );
});

test('t175 — CLAUDE_TRIVIAL_MODEL overrides the default, same posture as the permission mode', () => {
  const { args } = buildCommand(spec({ modelTier: 'trivial' }), {
    [TRIVIAL_MODEL_VARIABLE]: 'claude-sonnet-5',
  });

  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5');

  // Blank is not an identifier: it would reach the CLI as an empty `--model`
  // and kill the session on a flag nobody typed — the same guard `resolveModel`
  // has on the dispatch side.
  assert.equal(
    buildCommand(spec({ modelTier: 'trivial' }), { [TRIVIAL_MODEL_VARIABLE]: '   ' }).args[
      buildCommand(spec({ modelTier: 'trivial' }), { [TRIVIAL_MODEL_VARIABLE]: '   ' }).args.indexOf(
        '--model',
      ) + 1
    ],
    DEFAULT_TRIVIAL_MODEL,
    'a blank override falls back to the default instead of emitting an empty flag',
  );
});

test('t175 — standard and absent both produce byte-identical argv to no modelTier at all', () => {
  const baseline = buildCommand(spec(), {}).args;

  assert.deepEqual(
    buildCommand(spec({ modelTier: 'standard' }), {}).args,
    baseline,
    'standard is "the engine default", not a second model to pin',
  );
  assert.deepEqual(
    buildCommand(spec({ modelTier: undefined }), {}).args,
    baseline,
    'and a spec that says nothing gets the command it got before the field existed',
  );

  // The variable alone changes nothing: it is read only when a tier asked for it.
  assert.deepEqual(
    buildCommand(spec(), { [TRIVIAL_MODEL_VARIABLE]: 'claude-sonnet-5' }).args,
    baseline,
    'an operator who exported the variable did not thereby re-model every session',
  );
});

test('t175 — a node that pinned its own model wins over the tier, and --model still goes once', () => {
  // The precedence the two fichas together create, and it only has one honest
  // answer: `spec.model` is what the GRAPH declared for this node (t166), and a
  // triage heuristic does not get to overrule a decision somebody wrote down.
  // Getting this wrong is not a preference — two `--model` flags in one argv is
  // a broken command.
  const { args } = buildCommand(spec({ model: 'claude-opus-5', modelTier: 'trivial' }), {});

  assert.equal(
    args.filter((argument) => argument === '--model').length,
    1,
    'exactly one --model reaches the CLI, whatever the two fields say',
  );
  assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5', "the node's pin is the one");
});

test('t175 — the tier flag obeys the same ordering discipline as every other flag', () => {
  const { args } = buildCommand(
    spec({
      modelTier: 'trivial',
      permissions: { filesystem: { write: [] }, network: { allowed: false } },
    }),
    {},
  );

  assert.ok(
    args.indexOf('--model') < args.indexOf('--disallowedTools'),
    'the model flag has to close before the variadic denied list starts',
  );
  const denied = disallowedTools(args);
  assert.ok(!denied.includes(DEFAULT_TRIVIAL_MODEL), 'the denied list swallowed the model value');
  assert.equal(args.at(-1), PROMPT, 'the prompt stays the last element of the argv');
  assert.ok(args.indexOf('--model') < args.indexOf('--system-prompt'));
});
