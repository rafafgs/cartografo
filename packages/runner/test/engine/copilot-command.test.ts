/**
 * Building the `copilot` command and its environment (t675).
 *
 * Measured against `@github/copilot@1.0.95` on 2026-10-12, with a local stub
 * provider (BYOK) standing in for the model. What these tests protect:
 *
 * - the headless shape is a FLAG, not a subcommand: `copilot -p <text>`, and
 *   the instructions and the prompt travel composed in ONE argv element,
 *   because the CLI has no system-prompt flag;
 * - the adapter CHOOSES the engine ref (`--session-id <uuid>`), because the
 *   stream carries no start frame — the id appears only in the final `result`;
 * - the hygiene flags and variables that keep a runner from changing under its
 *   operator (no auto-update, no builtin MCP servers, no log files);
 * - `COPILOT_ALLOW_ALL` never reaches the engine: exactly `true` on it also
 *   trusts the working directory and loads its hooks, so the flag
 *   `--allow-all-tools` is the only way this adapter says "no prompts".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ARGV_INLINE_LIMIT_BYTES,
  COPILOT_BINARY,
  ENGINE_STDIO,
  TRIVIAL_MODEL_VARIABLE,
  buildCommand,
  buildEnvironment,
  buildProbeCommand,
} from '../../src/engine/copilot-command.ts';
import { composeSingleArgument, type SessionSpec } from '../../src/engine/types.ts';

const INSTRUCTIONS = 'You are node "ingest". Load the file and report the row count.';
const PROMPT = 'Run 4 of the nightly load.';
const ENGINE_REF = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/test-worktree',
  instructions: INSTRUCTIONS,
  prompt: PROMPT,
  timeoutSeconds: 600,
  ...extra,
});

test('the binary is copilot, and the probe is `copilot --version`', () => {
  assert.equal(COPILOT_BINARY, 'copilot');
  assert.equal(buildCommand(spec(), ENGINE_REF).command, 'copilot');
  assert.deepEqual(buildProbeCommand(), { command: 'copilot', args: ['--version'] });
});

test('FR2 — the argv is exactly the measured headless shape', () => {
  const subject = spec();
  const { args } = buildCommand(subject, ENGINE_REF, {});

  assert.deepEqual(args, [
    '-p',
    composeSingleArgument(subject),
    '--output-format',
    'json',
    '--allow-all-tools',
    '--disable-builtin-mcps',
    '--no-custom-instructions',
    '--no-ask-user',
    '--log-level',
    'none',
    '-C',
    '/tmp/test-worktree',
    '--session-id',
    ENGINE_REF,
  ]);
});

test('instructions and prompt arrive composed in ONE argv element', () => {
  const { args } = buildCommand(spec(), ENGINE_REF, {});

  const carrying = args.filter(
    (argument) => argument.includes(INSTRUCTIONS) && argument.includes(PROMPT),
  );
  assert.equal(carrying.length, 1, 'the engine has no system-prompt flag to split them across');
  assert.equal(args[args.indexOf('-p') + 1], composeSingleArgument(spec()));
});

test('stdio keeps stdin on /dev/null (invariant 6) and nothing goes through it below the limit', () => {
  assert.deepEqual([...ENGINE_STDIO], ['ignore', 'pipe', 'pipe']);
  assert.equal(buildCommand(spec(), ENGINE_REF, {}).stdin, undefined);
});

test('--allow-all-tools is a flag, and COPILOT_ALLOW_ALL is never in the environment', () => {
  assert.ok(buildCommand(spec(), ENGINE_REF, {}).args.includes('--allow-all-tools'));

  // Not set by this adapter, and not inherited either: exactly `true` on that
  // variable additionally trusts the working directory and loads its hooks
  // (`copilot help environment`), which is more than this adapter ever asks for.
  assert.ok(!('COPILOT_ALLOW_ALL' in buildEnvironment(spec(), {})));
  assert.ok(!('COPILOT_ALLOW_ALL' in buildEnvironment(spec(), { COPILOT_ALLOW_ALL: 'true' })));
  assert.ok(
    !('COPILOT_ALLOW_ALL' in buildEnvironment(spec({ envOverrides: { COPILOT_ALLOW_ALL: 'true' } }), {})),
    'a node override does not get to widen trust either',
  );
});

test('the hygiene flags are in the argv: no builtin MCP servers, no log files', () => {
  const { args } = buildCommand(spec(), ENGINE_REF, {});

  assert.ok(args.includes('--disable-builtin-mcps'));
  assert.equal(args[args.indexOf('--log-level') + 1], 'none');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.ok(!args.includes('--allow-all'), '--allow-all would also open paths and URLs');
  assert.ok(!args.includes('--yolo'));
  assert.ok(!args.includes('--allow-all-paths'));
});

test('COPILOT_AUTO_UPDATE=false is in the environment, and cannot be turned back on by an override', () => {
  assert.equal(buildEnvironment(spec(), {}).COPILOT_AUTO_UPDATE, 'false');
  assert.equal(
    buildEnvironment(spec({ envOverrides: { COPILOT_AUTO_UPDATE: 'true' } }), {}).COPILOT_AUTO_UPDATE,
    'false',
    'a runner must never change engine version mid-wave',
  );
});

test('credentials pass through untouched, and their values never reach the argv', () => {
  const secrets = {
    COPILOT_GITHUB_TOKEN: 'github_pat_SECRET_ONE',
    GH_TOKEN: 'gho_SECRET_TWO',
    GITHUB_TOKEN: 'ghu_SECRET_THREE',
  };
  const environment = buildEnvironment(spec(), { PATH: '/usr/bin', ...secrets });

  for (const [name, value] of Object.entries(secrets)) {
    assert.equal(environment[name], value, `${name} has to reach the engine as it came`);
  }
  assert.equal(environment.PATH, '/usr/bin', 'the base environment survives the merge');

  const joined = buildCommand(spec(), ENGINE_REF, secrets).args.join('\n');
  for (const value of Object.values(secrets)) {
    assert.ok(!joined.includes(value), 'a token in argv would show up in `ps`');
  }
});

test('envOverrides merge on top, and COPILOT_HOME is left alone unless an override carries it', () => {
  assert.ok(!('COPILOT_HOME' in buildEnvironment(spec(), { PATH: '/usr/bin' })));
  assert.equal(
    buildEnvironment(spec(), { COPILOT_HOME: '/operator/home' }).COPILOT_HOME,
    '/operator/home',
    'the operator\'s own value is inherited, not rewritten',
  );
  assert.equal(
    buildEnvironment(spec({ envOverrides: { COPILOT_HOME: '/node/home' } }), {
      COPILOT_HOME: '/operator/home',
    }).COPILOT_HOME,
    '/node/home',
  );
  assert.equal(buildEnvironment(spec({ envOverrides: { MY_KEY: 'v' } }), {}).MY_KEY, 'v');
});

/* --- model selection ---------------------------------------------------------- */

test('a spec model adds --model <m> after the session id, exactly once', () => {
  const { args } = buildCommand(spec({ model: 'claude-sonnet-4.5' }), ENGINE_REF, {});

  assert.deepEqual(args.slice(-4), ['--session-id', ENGINE_REF, '--model', 'claude-sonnet-4.5']);
  assert.equal(args.filter((argument) => argument === '--model').length, 1);
});

test('--model auto is never a default: absent model, absent flag', () => {
  const { args } = buildCommand(spec(), ENGINE_REF, {});

  assert.ok(!args.includes('--model'), 'the runner could no longer say which model a session ran on');
  assert.ok(!args.includes('auto'));
});

test('a trivial tier changes nothing until COPILOT_TRIVIAL_MODEL names a model', () => {
  const baseline = buildCommand(spec(), ENGINE_REF, {}).args;

  assert.equal(TRIVIAL_MODEL_VARIABLE, 'COPILOT_TRIVIAL_MODEL');
  assert.deepEqual(buildCommand(spec({ modelTier: 'trivial' }), ENGINE_REF, {}).args, baseline);
  assert.deepEqual(
    buildCommand(spec({ modelTier: 'trivial' }), ENGINE_REF, { COPILOT_TRIVIAL_MODEL: '  ' }).args,
    baseline,
    'blank is unset: an empty --model would kill the session',
  );

  const { args } = buildCommand(spec({ modelTier: 'trivial' }), ENGINE_REF, {
    COPILOT_TRIVIAL_MODEL: 'gpt-5-mini',
  });
  assert.deepEqual(args.slice(-2), ['--model', 'gpt-5-mini']);
});

test('the variable alone re-models nothing, and a node pin beats the tier', () => {
  const env = { COPILOT_TRIVIAL_MODEL: 'gpt-5-mini' };
  const baseline = buildCommand(spec(), ENGINE_REF, {}).args;

  assert.deepEqual(buildCommand(spec({ modelTier: 'standard' }), ENGINE_REF, env).args, baseline);
  assert.deepEqual(buildCommand(spec({ modelTier: undefined }), ENGINE_REF, env).args, baseline);

  const { args } = buildCommand(spec({ model: 'pinned', modelTier: 'trivial' }), ENGINE_REF, env);
  assert.equal(args.filter((argument) => argument === '--model').length, 1);
  assert.equal(args[args.indexOf('--model') + 1], 'pinned');
});

/* --- permission flags (spelled by copilot-permission-policy.ts) ---------------- */

const permitting = (
  write: readonly string[],
  network: { allowed: boolean; domains?: readonly string[] },
): Partial<SessionSpec> => ({ permissions: { filesystem: { write }, network } });

test('a spec with no permissions carries no permission flags', () => {
  const { args } = buildCommand(spec(), ENGINE_REF, {});

  for (const flag of ['--deny-tool', '--allow-url', '--deny-url', '--allow-all-urls', '--allow-tool']) {
    assert.ok(!args.includes(flag), `${flag} showed up unasked`);
  }
});

test('the permission flags come last, after --session-id and --model', () => {
  const { args } = buildCommand(
    spec({ model: 'm1', ...permitting(['**'], { allowed: false }) }),
    ENGINE_REF,
    {},
  );

  assert.deepEqual(args.slice(-6), ['--session-id', ENGINE_REF, '--model', 'm1', '--deny-tool', 'url']);
});

test('a refused policy adds no flags here; refusing is the adapter\'s job', () => {
  const { args } = buildCommand(
    spec(permitting(['src/**'], { allowed: true, domains: ['x.example'] })),
    ENGINE_REF,
    {},
  );

  assert.ok(!args.includes('--allow-url') && !args.includes('--deny-tool'));
});

/* --- a prompt that starts with a dash ------------------------------------------ */

test('a composition that starts with `-` stays ONE element, joined to the flag', () => {
  // Measured against 1.0.95: `copilot -p "-1 apples"` answers `error: Invalid
  // command format.` and never opens; `-p=-1 apples` delivers the text intact.
  // Instructions are prose somebody else wrote, and a bullet list or a `---`
  // front-matter line is enough to start with a dash.
  const subject = spec({ instructions: '- first rule\n- second rule' });
  const { args, stdin } = buildCommand(subject, ENGINE_REF, {});

  assert.equal(args[0], `-p=${composeSingleArgument(subject)}`);
  assert.ok(!args.includes('-p'), 'the bare flag would swallow nothing and break the parse');
  assert.equal(stdin, undefined);
});

/* --- oversized content ---------------------------------------------------------- */

const promptBytes = Buffer.byteLength(PROMPT, 'utf8');
/** Instructions sized so that instructions + prompt come to `total` bytes. */
const fillingTo = (total: number): string => 'a'.repeat(total - promptBytes);

test('past 64 KiB the composition leaves the argv for stdin, and -p goes with it', () => {
  assert.equal(ARGV_INLINE_LIMIT_BYTES, 64 * 1024);

  const subject = spec({ instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES + 100) });
  const { args, stdin } = buildCommand(subject, ENGINE_REF, {});

  // Measured against 1.0.95: with no `-p` a piped stdin is the prompt (a
  // 300 KB payload that starts with a dash arrived intact); with `-p` it is
  // ignored. So the two moves are one: omitting `-p` is what makes stdin count.
  assert.equal(stdin, composeSingleArgument(subject));
  assert.ok(!args.includes('-p'));
  assert.ok(!args.some((argument) => argument.includes(PROMPT)), 'nothing may travel twice');
  assert.deepEqual(args.slice(0, 2), ['--output-format', 'json']);
  assert.equal(args[args.indexOf('-C') + 1], '/tmp/test-worktree');
  assert.equal(args[args.indexOf('--session-id') + 1], ENGINE_REF);
});

test('the boundary: one byte below the limit stays inline, the limit itself switches', () => {
  const below = buildCommand(spec({ instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES - 1) }), ENGINE_REF, {});
  assert.equal(below.stdin, undefined);

  const at = buildCommand(spec({ instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES) }), ENGINE_REF, {});
  assert.notEqual(at.stdin, undefined);
});

test('the limit counts UTF-8 bytes, not UTF-16 units', () => {
  const accented = 'á'.repeat(ARGV_INLINE_LIMIT_BYTES - 2_000);
  assert.ok(accented.length < ARGV_INLINE_LIMIT_BYTES);

  const subject = spec({ instructions: accented });
  assert.equal(buildCommand(subject, ENGINE_REF, {}).stdin, composeSingleArgument(subject));
});

test('the model and the permission flags survive the oversized branch', () => {
  const { args } = buildCommand(
    spec({
      instructions: fillingTo(ARGV_INLINE_LIMIT_BYTES + 100),
      model: 'm1',
      ...permitting(['**'], { allowed: true }),
    }),
    ENGINE_REF,
    {},
  );

  assert.ok(args.includes('--allow-all-urls'));
  assert.equal(args[args.indexOf('--model') + 1], 'm1');
});
