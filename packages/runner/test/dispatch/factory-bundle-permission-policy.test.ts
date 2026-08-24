/**
 * Acceptance test for t271: what the software factory bundle DECLARES has to be
 * a policy a shipped adapter can actually open a session under.
 *
 * The first real crossing of `desenvolvimento-de-software` against a live
 * repository (t109, `notas/2026-08-17-t109-feature-do-jogo.md`) died on the
 * `test` node without spending a single token: `alpha-test` declared
 * `network: {allowed: true, domains: [...]}`, and a per-domain allowlist is a
 * policy neither shipped adapter can express, so `startSession` refused it up
 * front with `permission policy unsupported: …`. That refusal is correct and is
 * not what this ficha changes — a session that quietly enforced less than what
 * was declared is the one outcome a permission system may never produce
 * (`src/engine/permission-policy.ts`). What was wrong was the manifest.
 *
 * So this test sits on the seam the bug actually crossed, and reads BOTH sides
 * from the real thing: the manifest comes off disk from the committed bundle,
 * never an inline copy, and the resolvers are the adapters' own — the exact
 * path `ClaudeCodeAdapter.startSession` and `CodexAdapter.startSession` take
 * before they open anything. A copy of either side would prove the copy.
 *
 * Why it lives here and not in `tests/factory-graph-1.test.mjs`: that suite
 * declares "zero dependencies" in its own header and no root test imports a
 * workspace's `src`. The bundle's CONTENT is checked there; whether an adapter
 * can honour that content is a runner question, and it belongs next to the
 * runner.
 *
 * English per D18, and since t280 (D24) so is the manifest's own free text.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveSkillPermissions } from '../../src/dispatch/render-skill-instructions.ts';
import {
  CLOSED_WRITE_OPEN_NETWORK_REASON,
  DOMAIN_SCOPED_NETWORK_REASON as CODEX_DOMAIN_SCOPED_NETWORK_REASON,
  resolveCodexPermissions,
} from '../../src/engine/codex-permission-policy.ts';
import { resolvePermissions } from '../../src/engine/permission-policy.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SKILLS_DIR = path.join(
  REPO_ROOT,
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'skills',
);

/** A committed factory manifest, read from the bundle it ships in. */
function factoryManifest(skillId: string): Record<string, unknown> {
  const file = path.join(SKILLS_DIR, `${skillId}.json`);
  assert.ok(existsSync(file), `artifact does not exist: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

test('AT1 — the claude-code adapter opens a session under what alpha-test declares', () => {
  const permissions = resolveSkillPermissions(factoryManifest('alpha-test').permissions);
  assert.ok(permissions, 'alpha-test has to declare both permission axes');

  const { refusals } = resolvePermissions(permissions);

  assert.deepEqual(
    refusals,
    [],
    'a refusal here is `SessionStartError: permission policy unsupported: …` in ' +
      '`ClaudeCodeAdapter.startSession`, which is where the t109 crossing stopped: ' +
      'no session, no token spent, the job released on every tick',
  );
});

test('AT2 — no adapter refuses alpha-test for a domain-scoped network any more', () => {
  const permissions = resolveSkillPermissions(factoryManifest('alpha-test').permissions);
  assert.ok(permissions, 'alpha-test has to declare both permission axes');

  assert.equal(
    permissions.network.allowed,
    true,
    'the gate walks the integrated application over the network: closing it would close ' +
      '`WebFetch` and `Bash(curl *)`, which is the only evidence its single check accepts',
  );
  assert.equal(
    permissions.network.domains,
    undefined,
    '`allowed: true` with no `domains` is what the manifest format itself calls unrestricted ' +
      'network, and it is legal for a native skill — the one shape both adapters can express',
  );

  const codex = resolveCodexPermissions(permissions);
  assert.ok(
    !codex.refusals.includes(CODEX_DOMAIN_SCOPED_NETWORK_REASON),
    'the codex adapter refuses a per-domain allowlist for the same reason the first one does',
  );
});

/**
 * The codex half of the ficha's goal, pinned at what is actually true rather
 * than at what the ficha assumed.
 *
 * The ficha asked for "no refusal on either adapter" reading only the network
 * axis. There is a second one: `alpha-test` declares `filesystem.write: []`
 * (it judges a shared test bench and must leave it exactly as it found it), and
 * codex measured that NO sandbox tier combines closed writes with an open
 * network — `network_access` only exists inside `workspace-write`
 * (`src/engine/codex-permission-policy.ts`, the measured table). So this
 * manifest still cannot open on codex, for a reason this ficha did not
 * introduce and cannot fix within its scope: closing it would take either
 * granting the gate write access to the checkout it judges, or changing the
 * codex policy — and the ficha's FR5 keeps that policy untouched, correctly.
 *
 * It is not a regression and not new: `grafos-de-fabrica/bets-assimetricas`
 * already ships `coletar-fundamentos` with exactly this pair, and every node of
 * both factory graphs runs on the default engine, which is claude-code.
 *
 * This assertion is the record. It goes red the day someone opens the gate's
 * writes or teaches codex the combination — which is the day the gap closes and
 * this comment stops being true.
 */
test('AT3 — codex still refuses alpha-test, and only for the closed-write gap', () => {
  const permissions = resolveSkillPermissions(factoryManifest('alpha-test').permissions);
  assert.ok(permissions, 'alpha-test has to declare both permission axes');

  assert.deepEqual(
    resolveCodexPermissions(permissions).refusals,
    [CLOSED_WRITE_OPEN_NETWORK_REASON],
    'the only thing left between this manifest and a codex session is the measured gap the ' +
      'codex policy documents — not the domain allowlist this ficha removed',
  );
});

test('AT4 — the other four manifests of the bundle open on both adapters', () => {
  for (const skillId of [
    'refine-ticket',
    'develop-ticket',
    'integrate-branch',
    'verify-release',
  ]) {
    const permissions = resolveSkillPermissions(factoryManifest(skillId).permissions);
    assert.ok(permissions, `${skillId}: has to declare both permission axes`);

    assert.deepEqual(resolvePermissions(permissions).refusals, [], `${skillId}: claude-code`);
    assert.deepEqual(resolveCodexPermissions(permissions).refusals, [], `${skillId}: codex`);
  }
});
