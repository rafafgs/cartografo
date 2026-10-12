/**
 * The permission policy of the `copilot` adapter (t675).
 *
 * The table here is the specification, as `codex-permission-policy.test.ts` is
 * for the second adapter. What is different is that this engine has NO sandbox:
 * `copilot` gates by tool, path and URL rules, so every outcome below is
 * tool-level gating and none of it is OS isolation. A program run by `shell`
 * writes anywhere and reaches any host; the measurements that decide the table
 * are transcribed in `copilot-permission-policy.ts`.
 *
 * The decisive rows, measured against `@github/copilot@1.0.95` on 2026-10-12:
 *
 * - `--deny-url '*'` is ACCEPTED and DENIES NOTHING, so the closed network is
 *   spelled `--deny-tool url` instead;
 * - `--allow-url` alone restricts nothing under `--allow-all-tools`, and a deny
 *   always beats an allow, so a domain allowlist has no spelling and is refused.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import {
  CLOSED_NETWORK_FLAGS,
  DOMAIN_SCOPED_NETWORK_REASON,
  EMPTY_WRITE_SCOPE_REASON,
  NARROW_WRITE_SCOPE_REASON,
  PERMISSION_REFUSAL_PREFIX,
  WHOLE_WORKSPACE,
  resolveCopilotPermissions,
} from '../../src/engine/copilot-permission-policy.ts';
import {
  SessionStartError,
  type SessionPermissions,
  type SessionSpec,
} from '../../src/engine/types.ts';

const policy = (
  write: readonly string[],
  network: SessionPermissions['network'],
): SessionPermissions => ({ filesystem: { write }, network });

const WHOLE = [WHOLE_WORKSPACE];

test('the constants: the refusal prefix and the whole-workspace glob', () => {
  assert.equal(PERMISSION_REFUSAL_PREFIX, 'permission policy unsupported: ');
  assert.equal(WHOLE_WORKSPACE, '**');
});

test('an absent policy is pass-through: no flags, no refusals', () => {
  const decision = resolveCopilotPermissions(undefined);

  assert.equal(decision.outcome, 'pass-through');
  assert.deepEqual([...decision.permissionArgs], []);
  assert.deepEqual([...decision.refusals], []);
});

test('whole-workspace write with a closed network denies every URL, by tool rule', () => {
  const decision = resolveCopilotPermissions(policy(WHOLE, { allowed: false }));

  assert.equal(decision.outcome, 'enforce');
  // `--deny-tool url` (kind `url`, argument omitted = "matches all URLs") was
  // measured to block both `web_fetch` and a shell `curl`; `--deny-url '*'`
  // was measured to block neither. Pin the spelling that works.
  assert.deepEqual([...decision.permissionArgs], ['--deny-tool', 'url']);
  assert.deepEqual([...CLOSED_NETWORK_FLAGS], ['--deny-tool', 'url']);
  assert.ok(!decision.permissionArgs.includes('--deny-url'), "`--deny-url '*'` denies nothing");
  assert.deepEqual([...decision.refusals], []);
});

test('a closed network ignores `dominios` instead of refusing over it', () => {
  // The manifest format's own rule: "`rede.permitido: false` closes the
  // network; `dominios` is ignored in that case".
  const decision = resolveCopilotPermissions(policy(WHOLE, { allowed: false, domains: ['a.example'] }));

  assert.equal(decision.outcome, 'enforce');
  assert.deepEqual([...decision.permissionArgs], ['--deny-tool', 'url']);
});

test('whole-workspace write with an open network is --allow-all-urls and no path flag', () => {
  for (const network of [{ allowed: true }, { allowed: true, domains: [] }]) {
    const decision = resolveCopilotPermissions(policy(WHOLE, network));

    assert.equal(decision.outcome, 'enforce', JSON.stringify(network));
    assert.deepEqual([...decision.permissionArgs], ['--allow-all-urls']);
    assert.deepEqual([...decision.refusals], []);
  }
});

test('a domain-scoped network is refused: no spelling confines a session to a list of hosts', () => {
  const decision = resolveCopilotPermissions(
    policy(WHOLE, { allowed: true, domains: ['api.example.com', 'data.example.org'] }),
  );

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.permissionArgs], []);
  assert.deepEqual([...decision.refusals], [DOMAIN_SCOPED_NETWORK_REASON]);
  assert.ok(DOMAIN_SCOPED_NETWORK_REASON.length > 0);
  assert.ok(
    DOMAIN_SCOPED_NETWORK_REASON.includes('dominios'),
    'the message names the manifest field a founder would fix',
  );
  assert.ok(!decision.permissionArgs.includes('--allow-url'), '--allow-url alone restricts nothing');
});

test('a write scope narrower than the workspace is refused, with a reason', () => {
  const decision = resolveCopilotPermissions(policy(['src/**'], { allowed: false }));

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.permissionArgs], []);
  assert.deepEqual([...decision.refusals], [NARROW_WRITE_SCOPE_REASON]);
  assert.ok(NARROW_WRITE_SCOPE_REASON.includes('escrita'));

  const several = resolveCopilotPermissions(policy(['**', 'docs/**'], { allowed: false }));
  assert.equal(several.outcome, 'refuse', 'a list that is not exactly the whole workspace is narrower');
});

test('an EMPTY write scope is refused too: shell writes regardless of any tool deny', () => {
  const decision = resolveCopilotPermissions(policy([], { allowed: false }));

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.permissionArgs], []);
  assert.deepEqual([...decision.refusals], [EMPTY_WRITE_SCOPE_REASON]);
  assert.match(EMPTY_WRITE_SCOPE_REASON, /shell/);
  assert.ok(EMPTY_WRITE_SCOPE_REASON.includes('escrita'));
});

test('both axes refusing add up: filesystem before network', () => {
  const decision = resolveCopilotPermissions(policy(['src/**'], { allowed: true, domains: ['x.example'] }));

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.refusals], [NARROW_WRITE_SCOPE_REASON, DOMAIN_SCOPED_NETWORK_REASON]);
});

test('--allow-all-paths and --allow-all never appear in ANY outcome', () => {
  const everyCombination: Array<SessionPermissions | undefined> = [undefined];
  for (const write of [[], WHOLE, ['src/**'], ['**', 'docs/**']]) {
    for (const network of [
      { allowed: false },
      { allowed: true },
      { allowed: true, domains: ['x.example'] },
      { allowed: false, domains: ['x.example'] },
    ]) {
      everyCombination.push(policy(write, network));
    }
  }

  for (const permissions of everyCombination) {
    const label = JSON.stringify(permissions);
    const decision = resolveCopilotPermissions(permissions);

    for (const forbidden of ['--allow-all-paths', '--allow-all', '--yolo', '--add-dir']) {
      assert.ok(!decision.permissionArgs.includes(forbidden), `${forbidden} was emitted for ${label}`);
    }
    if (decision.outcome === 'refuse') {
      assert.ok(decision.refusals.length > 0, `refuse with no reason: ${label}`);
      assert.deepEqual([...decision.permissionArgs], [], `refuse with flags: ${label}`);
    } else {
      assert.deepEqual([...decision.refusals], [], `${decision.outcome} with a reason: ${label}`);
    }
  }
});

test('a refusal happens before any spawn, asserted through CopilotAdapter', async () => {
  let built = 0;
  const adapter = new CopilotAdapter({
    commandBuilder: () => {
      built += 1;
      throw new Error('the command builder must not run for a refused policy');
    },
  });
  const spec = (permissions: SessionPermissions): SessionSpec => ({
    workingDir: fileURLToPath(new URL('.', import.meta.url)),
    instructions: 'i',
    prompt: 'p',
    timeoutSeconds: 30,
    permissions,
  });
  const listener = {
    onOutput() {
      assert.fail('a refused session must never report a line');
    },
    onFinished() {
      assert.fail('a refused session must never report an outcome');
    },
  };

  for (const refused of [
    policy(['src/**'], { allowed: false }),
    policy([], { allowed: false }),
    policy(WHOLE, { allowed: true, domains: ['x.example'] }),
  ]) {
    await assert.rejects(
      () => adapter.startSession(spec(refused), listener),
      (error: unknown) => {
        assert.ok(error instanceof SessionStartError, `expected SessionStartError: ${String(error)}`);
        assert.ok(error.message.startsWith(PERMISSION_REFUSAL_PREFIX), error.message);
        assert.ok(error.message.length > PERMISSION_REFUSAL_PREFIX.length);
        return true;
      },
    );
  }
  assert.equal(built, 0);
  assert.equal(adapter.liveSessionCount, 0);
});
