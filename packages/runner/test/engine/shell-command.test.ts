/**
 * Building the command and the environment of a `shell` node (t332).
 *
 * The pure seam of the third adapter, and the one place where this engine parts
 * company with the other two on purpose. `command.ts` and `codex-command.ts`
 * both answer "which flags does this CLI take"; there is no CLI here, so this
 * module answers two different questions — what argv the SKILL declared, and
 * which of the runner's own environment variables the child is allowed to see.
 *
 * The second one is the reversal FR4 asks for. `README.md` documents, as a known
 * and accepted risk, that an agent session inherits the operator's whole shell
 * environment through `buildEnvironment`. A shell node has no legacy behaviour to
 * preserve, so it gets the opposite default: nothing is inherited unless the
 * manifest named it. These cases are what make that a property instead of a
 * paragraph.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ENGINE_STDIO,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/shell-command.ts';
import { SessionStartError, type SessionSpec } from '../../src/engine/types.ts';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/test-worktree',
  instructions: 'The manifest body, which documents this command for a human.',
  prompt: 'Ticket #332: a deterministic node inside the trail.',
  timeoutSeconds: 600,
  ...extra,
});

/** A spec carrying a command block, the shape `buildSessionSpec` produces. */
const withCommand = (
  argv: readonly string[],
  envAllowlist?: readonly string[],
  extra: Partial<SessionSpec> = {},
): SessionSpec =>
  spec({
    command: envAllowlist === undefined ? { argv } : { argv, envAllowlist },
    ...extra,
  });

test('argv[0] is the binary and everything after it is an argument, in order', () => {
  const { command, args } = buildCommand(
    withCommand(['/usr/bin/env', 'node', 'promote.mjs', '2026-08-31']),
  );

  assert.equal(command, '/usr/bin/env');
  assert.deepEqual(args, ['node', 'promote.mjs', '2026-08-31']);
});

test('the argv is carried through byte for byte — no shell, no quoting layer', () => {
  // Every element here would be rewritten by a shell: a leading dash, an
  // embedded space, a variable reference, a command substitution, a glob. What
  // this adapter promises is that none of them is interpreted by anybody
  // (`spawn(..., {shell: false})`), so what the seam produces has to be the
  // literal strings the manifest declared.
  const argv = ['/bin/echo', '-n', 'a b', '$HOME', '`id`', '*.md', ''];
  const { command, args } = buildCommand(withCommand(argv));

  assert.equal(command, '/bin/echo');
  assert.deepEqual(args, argv.slice(1));
});

test('an absent command is rejected before any spawn helper runs', () => {
  // The refusal lives HERE, in the pure seam, which is what lets it happen
  // before a process exists at all: `startSession` builds the command first and
  // spawns second. A `shell` node whose skill declares no `command` block has
  // nothing to run, and opening a session for it would be a session that
  // executes the manifest's prose.
  assert.throws(() => buildCommand(spec()), SessionStartError);
  assert.throws(() => buildCommand(spec({ command: undefined })), SessionStartError);
  assert.throws(() => buildCommand(withCommand([])), SessionStartError);
});

test('the refusal names the field to fix, never just "it failed"', () => {
  assert.throws(
    () => buildCommand(spec()),
    (error: unknown) => {
      assert.ok(error instanceof SessionStartError);
      assert.match(error.message, /command/, error.message);
      return true;
    },
  );
});

test('nothing goes to the child through stdin', () => {
  // Invariant 6, inherited whole from the other two adapters. Here it costs
  // nothing to keep and buys the same thing: a command that reads stdin — `cat`,
  // a `while read` loop — waits for an EOF nobody sends, and the session is lost
  // to a library default rather than to anything the node did.
  assert.equal(ENGINE_STDIO[0], 'ignore');
  assert.deepEqual([...ENGINE_STDIO], ['ignore', 'pipe', 'pipe']);
});

/* --- the environment: closed by default (FR4) ------------------------------- */

test('with no allowlist the child inherits nothing at all — not even PATH', () => {
  const environment = buildEnvironment(withCommand(['/bin/true']), {
    PATH: '/usr/bin',
    HOME: '/home/rafael',
    AWS_SECRET_ACCESS_KEY: 'nope',
  });

  assert.deepEqual(
    environment,
    {},
    'the base is EMPTY, which is the opposite of what the agent adapters do — ' +
      'a skill either names an absolute path in argv[0] or allowlists PATH itself',
  );
});

test('an allowlist copies exactly the names it lists, and nothing else', () => {
  const environment = buildEnvironment(withCommand(['/bin/true'], ['PATH', 'HOME']), {
    PATH: '/usr/bin',
    HOME: '/home/rafael',
    AWS_SECRET_ACCESS_KEY: 'nope',
  });

  assert.deepEqual(environment, { PATH: '/usr/bin', HOME: '/home/rafael' });
});

test('an allowlisted name the runner does not carry contributes no key at all', () => {
  const environment = buildEnvironment(withCommand(['/bin/true'], ['PATH', 'NOT_SET']), {
    PATH: '/usr/bin',
  });

  assert.deepEqual(environment, { PATH: '/usr/bin' });
  assert.ok(
    !('NOT_SET' in environment),
    'a present key holding `undefined` is not the same thing as an absent one: ' +
      'child_process spreads it into the environ as an empty value',
  );
});

test('envOverrides wins over an allowlisted value on the same key', () => {
  const environment = buildEnvironment(
    withCommand(['/bin/true'], ['PATH', 'REPORT_DIR'], {
      envOverrides: { REPORT_DIR: '/tmp/session-42' },
    }),
    { PATH: '/usr/bin', REPORT_DIR: '/var/whatever-the-operator-had' },
  );

  assert.equal(
    environment.REPORT_DIR,
    '/tmp/session-42',
    'the dispatch layered this on for THIS session; the operator shell is the fallback',
  );
  assert.equal(environment.PATH, '/usr/bin', 'and the rest of the allowlist survives the merge');
});

test('envOverrides reaches a child whose skill allowlisted nothing', () => {
  // The conformance kit configures its fake engine through `envOverrides` and
  // nothing else, so this is not a corner: it is the shape every kit case runs
  // under.
  const environment = buildEnvironment(
    withCommand(['/bin/true'], undefined, { envOverrides: { FAKE_ENGINE_EXIT_CODE: '0' } }),
    { PATH: '/usr/bin' },
  );

  assert.deepEqual(environment, { FAKE_ENGINE_EXIT_CODE: '0' });
});
