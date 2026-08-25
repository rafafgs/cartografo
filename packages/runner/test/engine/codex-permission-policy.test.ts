/**
 * Acceptance tests for the permission policy of the `codex` adapter (t195).
 *
 * The table here IS the specification, exactly as `permission-policy.test.ts`
 * is for the first adapter: one row per combination the ticket enumerates, each
 * with its outcome and — where the policy cannot be expressed by the engine —
 * the exact refusal text. The text matters twice over: it is what a person
 * reads when a session is refused, and `codex-adapter.ts` quotes it verbatim
 * behind a stable prefix.
 *
 * **What is different from the first adapter, and why it is a different
 * module.** `permission-policy.ts` names TOOLS because `claude-code` has no OS
 * sandbox and gates by tool name; this engine has `-s, --sandbox` and gates by
 * a real sandbox tier. The two vocabularies do not meet, which is why there is
 * no sharing between the modules and why this file asserts sandbox flags where
 * the other one asserts tool names. The pairing mirrors `command.ts` /
 * `codex-command.ts`, the repository's own precedent for splitting by engine.
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

import type * as CodexPolicyModule from '../../src/engine/codex-permission-policy.ts';
import type { SessionPermissions } from '../../src/engine/types.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/engine/codex-permission-policy.ts';

let cache: typeof CodexPolicyModule | null = null;

async function loadPolicy(): Promise<typeof CodexPolicyModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/engine/codex-permission-policy.ts', import.meta.url).href
  )) as typeof CodexPolicyModule;
  return cache;
}

/** The refusal texts, verbatim from the ticket (FR3/FR4). */
const NARROW_WRITE_TEXT =
  'write scope narrower than the whole workspace is not supported by the codex adapter — ' +
  'declare `escrita: []` or `escrita: ["**"]`';

const DOMAIN_SCOPED_TEXT =
  'domain-scoped network allow is not supported by the codex adapter — ' +
  'declare `rede` without `dominios`, or `rede.permitido: false`';

const CLOSED_WRITE_OPEN_NETWORK_TEXT =
  'no codex sandbox mode combines closed writes with an open network — ' +
  'declare `escrita: ["**"]`, or `rede.permitido: false`';

const policy = (
  write: readonly string[],
  network: SessionPermissions['network'],
): SessionPermissions => ({ filesystem: { write }, network });

/* --- pass-through (FR2) ------------------------------------------------------ */

test('an absent policy is pass-through: nothing to enforce, nothing to refuse', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  const decision = resolveCodexPermissions(undefined);

  assert.equal(decision.outcome, 'pass-through');
  assert.deepEqual([...decision.sandboxArgs], []);
  assert.deepEqual([...decision.refusals], []);
});

/* --- enforce (FR5) ----------------------------------------------------------- */

test('closed writes and a closed network resolve to the read-only sandbox', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  const decision = resolveCodexPermissions(policy([], { allowed: false }));

  assert.equal(decision.outcome, 'enforce');
  assert.deepEqual([...decision.sandboxArgs], ['-s', 'read-only']);
  assert.deepEqual([...decision.refusals], []);
});

test('open writes and a closed network pin workspace-write with the network shut', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  const decision = resolveCodexPermissions(policy(['**'], { allowed: false }));

  assert.equal(decision.outcome, 'enforce');
  assert.deepEqual(
    [...decision.sandboxArgs],
    ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'],
  );
  assert.deepEqual([...decision.refusals], []);
});

test('open writes and an open network pin workspace-write with the network opened', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  for (const network of [{ allowed: true }, { allowed: true, domains: [] }]) {
    const decision = resolveCodexPermissions(policy(['**'], network));

    assert.equal(decision.outcome, 'enforce', JSON.stringify(network));
    assert.deepEqual(
      [...decision.sandboxArgs],
      ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
      'an empty `dominios` is the same declaration as no `dominios` at all',
    );
    assert.deepEqual([...decision.refusals], []);
  }
});

/* --- refuse (FR3/FR4) -------------------------------------------------------- */

test('closed writes with an open network are refused: no sandbox mode combines them', async () => {
  const { resolveCodexPermissions, CLOSED_WRITE_OPEN_NETWORK_REASON } = await loadPolicy();

  // The real case from `coletar-fundamentos.json`: `escrita: []` with
  // `rede.permitido: true`. Measured against codex-cli 0.147.0 on 2026-08-16 —
  // `sandbox_workspace_write.network_access` has NO effect under `read-only`,
  // so honouring both halves at once is not something this CLI can be asked
  // for. Refusing is the interface's own safe answer.
  const decision = resolveCodexPermissions(policy([], { allowed: true }));

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.sandboxArgs], [], 'a refused policy hands out no flags');
  assert.equal(CLOSED_WRITE_OPEN_NETWORK_REASON, CLOSED_WRITE_OPEN_NETWORK_TEXT);
  assert.deepEqual([...decision.refusals], [CLOSED_WRITE_OPEN_NETWORK_TEXT]);
});

test('a write scope narrower than the workspace is refused, with the exact reason', async () => {
  const { resolveCodexPermissions, NARROW_WRITE_SCOPE_REASON } = await loadPolicy();

  const decision = resolveCodexPermissions(policy(['src/**'], { allowed: false }));

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.sandboxArgs], []);
  assert.equal(NARROW_WRITE_SCOPE_REASON, NARROW_WRITE_TEXT);
  assert.deepEqual([...decision.refusals], [NARROW_WRITE_TEXT]);
  assert.ok(
    decision.refusals[0]?.includes('escrita'),
    'the message has to name the manifest field a founder would fix',
  );
});

test('a domain-scoped network allow is refused, with the exact reason', async () => {
  const { resolveCodexPermissions, DOMAIN_SCOPED_NETWORK_REASON } = await loadPolicy();

  const decision = resolveCodexPermissions(
    policy(['**'], { allowed: true, domains: ['api.openai.com'] }),
  );

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.sandboxArgs], []);
  assert.equal(DOMAIN_SCOPED_NETWORK_REASON, DOMAIN_SCOPED_TEXT);
  assert.deepEqual([...decision.refusals], [DOMAIN_SCOPED_TEXT]);
  assert.ok(
    decision.refusals[0]?.includes('dominios'),
    'the message has to name the manifest field a founder would fix',
  );
});

test('a closed network ignores `dominios` instead of refusing over it', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  // The manifest format's own rule: "`rede.permitido: false` closes the
  // network; `dominios` is ignored in that case". Refusing here would turn the
  // SAFEST declaration a founder can write into an error.
  const decision = resolveCodexPermissions(
    policy(['**'], { allowed: false, domains: ['api.openai.com'] }),
  );

  assert.equal(decision.outcome, 'enforce');
  assert.deepEqual(
    [...decision.sandboxArgs],
    ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'],
  );
});

test('both axes refusing add up: two reasons, filesystem before network', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  // FR3, and it is the whole reason the axes are read independently first: a
  // session rejected for one reason, fixed, and rejected again for the other
  // is a round trip that helps nobody.
  const decision = resolveCodexPermissions(
    policy(['src/**'], { allowed: true, domains: ['x'] }),
  );

  assert.equal(decision.outcome, 'refuse');
  assert.deepEqual([...decision.refusals], [NARROW_WRITE_TEXT, DOMAIN_SCOPED_TEXT]);
  assert.deepEqual([...decision.sandboxArgs], []);
});

/* --- the invariants that hold across every row ------------------------------- */

test('the refusal prefix is the same literal the first adapter exports', async () => {
  const { PERMISSION_REFUSAL_PREFIX } = await loadPolicy();

  // Redeclared, never imported across the two adapter modules: the string is
  // part of each adapter's own contract with its callers, and an import would
  // couple two engines that share nothing else.
  assert.equal(PERMISSION_REFUSAL_PREFIX, 'permission policy unsupported: ');
});

test('no policy whatsoever selects danger-full-access', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  // FR8. The tier is out of reach of every combination by construction, and
  // this pins it so a later edit cannot reach it by accident.
  const everyCombination: Array<SessionPermissions | undefined> = [undefined];
  for (const write of [[], ['**'], ['src/**'], ['**', 'docs/**']]) {
    for (const network of [
      { allowed: false },
      { allowed: true },
      { allowed: true, domains: ['x'] },
      { allowed: false, domains: ['x'] },
    ]) {
      everyCombination.push(policy(write, network));
    }
  }

  for (const permissions of everyCombination) {
    const { sandboxArgs } = resolveCodexPermissions(permissions);
    assert.ok(
      !sandboxArgs.includes('danger-full-access'),
      `danger-full-access was selected by ${JSON.stringify(permissions)}`,
    );
  }
});

test('a refused decision never hands out flags, and an enforced one never a reason', async () => {
  const { resolveCodexPermissions } = await loadPolicy();

  for (const write of [[], ['**'], ['src/**']]) {
    for (const network of [{ allowed: false }, { allowed: true }, { allowed: true, domains: ['x'] }]) {
      const decision = resolveCodexPermissions(policy(write, network));
      const label = JSON.stringify({ write, network });

      if (decision.outcome === 'refuse') {
        assert.ok(decision.refusals.length > 0, `refuse with no reason: ${label}`);
        assert.deepEqual([...decision.sandboxArgs], [], `refuse with flags: ${label}`);
      } else {
        assert.deepEqual([...decision.refusals], [], `${decision.outcome} with a reason: ${label}`);
      }
    }
  }
});
