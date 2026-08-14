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
  ENGINE_STDIO,
  PERMISSION_MODE_VARIABLE,
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
