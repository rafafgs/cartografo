/**
 * Acceptance tests for the permission policy of the reference adapter
 * (t125, FR2).
 *
 * The table here IS the specification: one row per combination the ticket
 * enumerates, each with its outcome and — where the policy cannot be expressed
 * by the engine — the exact refusal text. The text matters twice over: it is
 * what a person reads when a session is refused, and
 * `claude-code-adapter.ts` quotes it verbatim behind a stable prefix.
 *
 * What the module may NOT do is name a flag: the CLI vocabulary lives in
 * `command.ts`, and the boundary the specification draws
 * (`docs/formats/engine-adapter.md`, boundary 1) is the reason this file only
 * ever asserts tool names.
 *
 * The module is imported behind an `existsSync` check, the same discipline the
 * rest of the suite uses: on the initial red the failure has to NAME the
 * missing artifact instead of blowing up with a module-resolution error that
 * looks like any other bug.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PolicyModule from '../../src/engine/permission-policy.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/engine/permission-policy.ts';

let cache: typeof PolicyModule | null = null;

async function loadPolicy(): Promise<typeof PolicyModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/engine/permission-policy.ts', import.meta.url).href
  )) as typeof PolicyModule;
  return cache;
}

/** The refusal texts, verbatim from the ticket (FR2). */
const DOMAIN_SCOPED_TEXT =
  'domain-scoped network allow is not supported by the claude-code adapter — ' +
  'declare `rede` without `dominios`, or `rede.permitido: false`';

const NARROW_WRITE_TEXT =
  'write scope narrower than the whole workspace is not supported by the claude-code adapter — ' +
  'declare `escrita: []` or `escrita: ["**"]`';

test('network allowed with no domain list is pass-through', async () => {
  const { resolveNetworkPolicy } = await loadPolicy();

  for (const network of [{ allowed: true }, { allowed: true, domains: [] }]) {
    const decision = resolveNetworkPolicy(network);
    assert.equal(decision.outcome, 'pass-through', JSON.stringify(network));
    assert.deepEqual([...decision.deniedTools], []);
    assert.equal(decision.reason, null);
  }
});

test('network allowed with a domain list is refused, with the exact reason', async () => {
  const { resolveNetworkPolicy, DOMAIN_SCOPED_NETWORK_REASON } = await loadPolicy();

  const decision = resolveNetworkPolicy({ allowed: true, domains: ['api.anthropic.com'] });

  assert.equal(decision.outcome, 'refuse');
  assert.equal(decision.reason, DOMAIN_SCOPED_NETWORK_REASON);
  // An allowlist per domain would need an egress proxy the engine does not
  // have; promising it in the type and dropping it at runtime is the one
  // outcome this ticket refuses to ship.
  assert.equal(DOMAIN_SCOPED_NETWORK_REASON, DOMAIN_SCOPED_TEXT);
});

test('network closed denies the native tools and the usual shell escapes', async () => {
  const { resolveNetworkPolicy } = await loadPolicy();

  const decision = resolveNetworkPolicy({ allowed: false });

  assert.equal(decision.outcome, 'enforce');
  assert.equal(decision.reason, null);
  assert.deepEqual(
    [...decision.deniedTools],
    [
      'WebFetch',
      'WebSearch',
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(nc *)',
      'Bash(netcat *)',
      'Bash(ssh *)',
      'Bash(scp *)',
      'Bash(telnet *)',
    ],
  );
});

test('a closed network ignores a domain list, as the manifest format says', async () => {
  const { resolveNetworkPolicy } = await loadPolicy();

  const decision = resolveNetworkPolicy({ allowed: false, domains: ['api.anthropic.com'] });

  assert.equal(decision.outcome, 'enforce', 'closed is closed: `dominios` is ignored, never a refusal');
});

test('an empty write scope denies every writing tool', async () => {
  const { resolveFilesystemPolicy } = await loadPolicy();

  const decision = resolveFilesystemPolicy({ write: [] });

  assert.equal(decision.outcome, 'enforce');
  assert.equal(decision.reason, null);
  assert.deepEqual([...decision.deniedTools], ['Edit', 'Write', 'NotebookEdit']);
});

test('the whole workspace as write scope is pass-through', async () => {
  const { resolveFilesystemPolicy } = await loadPolicy();

  const decision = resolveFilesystemPolicy({ write: ['**'] });

  assert.equal(decision.outcome, 'pass-through');
  assert.deepEqual([...decision.deniedTools], []);
  assert.equal(decision.reason, null);
});

test('any narrower write scope is refused, with the exact reason', async () => {
  const { resolveFilesystemPolicy, NARROW_WRITE_SCOPE_REASON } = await loadPolicy();

  for (const write of [['src/**'], ['**', 'src/**'], ['/tmp/cartografo/**']]) {
    const decision = resolveFilesystemPolicy({ write });
    assert.equal(decision.outcome, 'refuse', JSON.stringify(write));
    assert.equal(decision.reason, NARROW_WRITE_SCOPE_REASON);
  }

  assert.equal(NARROW_WRITE_SCOPE_REASON, NARROW_WRITE_TEXT);
});

test('an absent policy is the behaviour of today: nothing denied, nothing refused', async () => {
  const { resolvePermissions } = await loadPolicy();

  const resolved = resolvePermissions(undefined);

  assert.deepEqual([...resolved.deniedTools], []);
  assert.deepEqual([...resolved.refusals], []);
});

test('the two axes add up: enforcing one and refusing the other', async () => {
  const { resolvePermissions, NARROW_WRITE_SCOPE_REASON, DOMAIN_SCOPED_NETWORK_REASON } =
    await loadPolicy();

  const enforced = resolvePermissions({
    filesystem: { write: [] },
    network: { allowed: false },
  });
  assert.deepEqual([...enforced.refusals], []);
  assert.deepEqual(
    [...enforced.deniedTools],
    [
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Bash(curl *)',
      'Bash(wget *)',
      'Bash(nc *)',
      'Bash(netcat *)',
      'Bash(ssh *)',
      'Bash(scp *)',
      'Bash(telnet *)',
    ],
  );

  // FR3: the refusal sums the reason of EVERY axis in refuse — a session
  // rejected for one reason and fixed into a rejection for the other is a
  // round trip nobody needs.
  const refused = resolvePermissions({
    filesystem: { write: ['src/**'] },
    network: { allowed: true, domains: ['api.anthropic.com'] },
  });
  assert.deepEqual(
    [...refused.refusals],
    [NARROW_WRITE_SCOPE_REASON, DOMAIN_SCOPED_NETWORK_REASON],
  );
});

test('every denied entry knows which resource it answers for', async () => {
  const { resourceOfDeniedTool } = await loadPolicy();

  assert.equal(resourceOfDeniedTool('WebFetch'), 'rede');
  assert.equal(resourceOfDeniedTool('Bash(curl *)'), 'rede');
  assert.equal(resourceOfDeniedTool('Write'), 'filesystem');
  assert.equal(resourceOfDeniedTool('NotebookEdit'), 'filesystem');
  // Not something this adapter denied: the classification says so instead of
  // guessing, which is what keeps the denial telemetry free of invention.
  assert.equal(resourceOfDeniedTool('Read'), null);
});
