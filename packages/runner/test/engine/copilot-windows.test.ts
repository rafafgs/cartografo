/**
 * The Copilot adapter on native Windows (t684, AT7–AT10, AT13).
 *
 * Windows `CreateProcess` caps the whole command line at 32,767 UTF-16 units,
 * and the control-plane credential must never reach a worker. Everything here
 * is driven by an injected `platform` and the fake engine, so it runs on POSIX.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import {
  ARGV_INLINE_LIMIT_BYTES,
  ARGV_INLINE_LIMIT_POSIX_BYTES,
  ARGV_INLINE_LIMIT_WIN32_BYTES,
  argvInlineLimitBytes,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/copilot-command.ts';
import { composeSingleArgument, type SessionSpec } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const ENGINE_REF = '0cb916db-26aa-40f2-86b5-1ba81b225fd2';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/test-worktree',
  instructions: 'You are node "ingest".',
  prompt: 'Run 4.',
  timeoutSeconds: 600,
  ...extra,
});

test('t684 AT7 — the inline limit per platform', () => {
  assert.equal(ARGV_INLINE_LIMIT_WIN32_BYTES, 12 * 1024);
  assert.equal(ARGV_INLINE_LIMIT_POSIX_BYTES, 64 * 1024);
  assert.equal(argvInlineLimitBytes('win32'), 12 * 1024);
  for (const platform of ['linux', 'darwin', 'freebsd'] as const) {
    assert.equal(argvInlineLimitBytes(platform), 64 * 1024, platform);
  }
  assert.equal(ARGV_INLINE_LIMIT_BYTES, argvInlineLimitBytes(process.platform));
});

test('t684 AT8 — the stdin decision follows the platform, in bytes', () => {
  const big = spec({ instructions: 'a'.repeat(13 * 1024) });
  const onWindows = buildCommand(big, ENGINE_REF, {}, 'win32');
  assert.equal(onWindows.stdin, composeSingleArgument(big));
  assert.ok(!onWindows.args.includes('-p'));
  assert.ok(!onWindows.args.some((argument) => argument.startsWith('-p=')));

  const onLinux = buildCommand(big, ENGINE_REF, {}, 'linux');
  assert.equal(onLinux.stdin, undefined);
  assert.ok(onLinux.args.includes('-p'));

  // Exact boundary: the limit counts instructions + prompt, and `<` keeps inline.
  const promptBytes = Buffer.byteLength('Run 4.', 'utf8');
  const filling = (total: number): SessionSpec =>
    spec({ instructions: 'a'.repeat(total - promptBytes) });
  const limit = 12 * 1024;
  assert.equal(buildCommand(filling(limit - 1), ENGINE_REF, {}, 'win32').stdin, undefined);
  assert.notEqual(buildCommand(filling(limit), ENGINE_REF, {}, 'win32').stdin, undefined);

  // Accented text: two bytes each, one UTF-16 unit each.
  const accentedAtLimit = spec({ instructions: 'é'.repeat((limit - promptBytes) / 2) });
  assert.notEqual(
    buildCommand(accentedAtLimit, ENGINE_REF, {}, 'win32').stdin,
    undefined,
    'the bytes, not the characters, reach the limit',
  );
});

test('t684 AT9 — the worker never sees the control-plane token', () => {
  const base = { CARTOGRAFO_TOKEN: 'ct_x', PATH: '/usr/bin', GH_TOKEN: 'g' };
  const environment = buildEnvironment(spec(), base);
  assert.ok(!('CARTOGRAFO_TOKEN' in environment));
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.GH_TOKEN, 'g');

  const overridden = buildEnvironment(spec({ envOverrides: { CARTOGRAFO_TOKEN: 'ct_y' } }), base);
  assert.ok(!('CARTOGRAFO_TOKEN' in overridden), 'an override does not bring it back');

  const argv = buildCommand(spec({ envOverrides: { CARTOGRAFO_TOKEN: 'ct_y' } }), ENGINE_REF, base)
    .args.join('\n');
  assert.ok(!argv.includes('ct_x') && !argv.includes('ct_y'));
});

test('t684 AT10 — the isolation flags are in every argv, in place', () => {
  const permitting = (write: string[]): Partial<SessionSpec> => ({
    permissions: { filesystem: { write }, network: { allowed: false } },
  });
  for (const extra of [{}, permitting(['**']), permitting([])]) {
    const subject = spec({ model: 'm1', ...extra });
    const { args } = buildCommand(subject, ENGINE_REF, {});

    for (const flag of ['--no-custom-instructions', '--no-ask-user']) {
      assert.equal(args.filter((argument) => argument === flag).length, 1, flag);
    }
    const after = args.indexOf('--disable-builtin-mcps');
    const before = args.indexOf('--log-level');
    assert.ok(after >= 0 && before > after);
    assert.ok(args.indexOf('--no-custom-instructions') > after);
    assert.ok(args.indexOf('--no-ask-user') > after);
    assert.ok(args.indexOf('--no-custom-instructions') < before);
    assert.ok(args.indexOf('--no-ask-user') < before);

    const tail = args.slice(before);
    assert.deepEqual(tail.slice(0, 6), [
      '--log-level',
      'none',
      '-C',
      '/tmp/test-worktree',
      '--session-id',
      ENGINE_REF,
    ]);
    assert.deepEqual(tail.slice(6, 8), ['--model', 'm1']);
  }
});

/** One `CopilotAdapter` session against the fake engine; returns the argv it received. */
async function argvOf(write: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), 'cartografo-t684-'));
  const recordPath = join(root, 'record.json');
  const workingDir = join(root, 'work');
  mkdirSync(workingDir);
  const adapter = new CopilotAdapter({
    commandBuilder: (subject, engineRef) => {
      const built = buildCommand(subject, engineRef);
      return { ...built, command: process.execPath, args: [FAKE_ENGINE, ...built.args] };
    },
    graceMs: 300,
  });
  let announce: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    announce = resolve;
  });
  try {
    await adapter.startSession(
      {
        workingDir,
        instructions: 'node instructions',
        prompt: 'the work of this turn',
        timeoutSeconds: 30,
        permissions: { filesystem: { write }, network: { allowed: false } },
        envOverrides: { FAKE_ENGINE_RECORD: recordPath },
      },
      { onOutput() {}, onFinished: () => announce() },
    );
    await done;
    return (JSON.parse(readFileSync(recordPath, 'utf8')) as { argv: string[] }).argv;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('t684 AT13 — an input-only node opens tool-free instead of being refused', async () => {
  const empty = await argvOf([]);
  assert.equal(empty.filter((argument) => argument === '--available-tools=none').length, 1);
  assert.ok(
    !empty.some((argument) => argument.startsWith('--available-tools') && argument !== '--available-tools=none'),
  );

  const whole = await argvOf(['**']);
  assert.ok(!whole.some((argument) => argument.startsWith('--available-tools')));
});
