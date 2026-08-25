/**
 * Acceptance tests for the classification of a pre-session failure (t252, FR1/FR2).
 *
 * The bug this closes is a loop: four of the reads a dispatch does BEFORE it
 * acquires a worktree can throw an error that will reproduce identically on
 * every retry — an unresolved placeholder, a skill nobody registered, a pin that
 * stopped matching, an engine with no route, and a `graph_version_id` the
 * control plane no longer has. Every one of them propagated out of `tick()`,
 * got logged, and came back two seconds later as the same job at the head of the
 * same queue, forever, with nothing a human could see.
 *
 * What decides "forever" from "once" is exactly this function: a reason means
 * the job is blocked and stops being a candidate, and `null` means the error is
 * transient and the retry is the right answer. So the boundary is the whole
 * subject here, and it is pinned from both sides — the five causes that
 * classify, and the errors that must NOT, whatever they look like.
 *
 * No server, no engine, no worktree: the function is pure, and that is why it
 * lives in a module of its own.
 *
 * English per D18; the reasons it produces are Portuguese, because they are read
 * by a person in the inbox — same voice as `report.ts`'s two existing blocks.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ControlPlaneClientError } from '../../src/controller/control-plane-client.ts';
import { PERMISSION_REFUSAL_PREFIX } from '../../src/engine/claude-code-adapter.ts';
import { DOMAIN_SCOPED_NETWORK_REASON } from '../../src/engine/permission-policy.ts';
import { SessionStartError } from '../../src/engine/types.ts';
import {
  SkillNotRegisteredError,
  SkillPinMismatchError,
  UnresolvedPlaceholderError,
} from '../../src/dispatch/render-skill-instructions.ts';
import { UnknownEngineError } from '../../src/dispatch/resolve-engine.ts';
import type * as PreSessionModule from '../../src/dispatch/pre-session-failure.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/pre-session-failure.ts';

let cache: typeof PreSessionModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadModule(): Promise<typeof PreSessionModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/pre-session-failure.ts', import.meta.url).href
  )) as typeof PreSessionModule;
  return cache;
}

/** The work being dispatched, as this classifier reads one. */
const JOB = Object.freeze({
  current_node_id: 'publicar',
  graph_version_id: 'sha256:0123456789abcdef',
});

/** Asserts the reason exists and names every one of the given strings. */
function namesAll(reason: string | null, mentions: readonly string[]): void {
  assert.ok(reason !== null, 'a deterministic cause has to classify into a reason');
  for (const mention of mentions) {
    assert.ok(
      reason.includes(mention),
      `the reason has to name "${mention}", and it reads: ${reason}`,
    );
  }
}

test('AT1 — an unresolved placeholder names every path that did not resolve', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const reason = classifyPreSessionFailure(
    new UnresolvedPlaceholderError('publicar', 'coletar-fundamentos', [
      'tese_triada.titulo',
      'tese_triada.tese',
    ]),
    JOB,
  );

  // Every path and not just the first: whoever reads this is about to go and
  // assemble an input, and discovering the gaps one unblock at a time is a
  // round trip per field.
  namesAll(reason, ['tese_triada.titulo', 'tese_triada.tese', 'publicar', 'coletar-fundamentos']);
});

test('AT2 — a skill the registry never registered names the skill id', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const reason = classifyPreSessionFailure(
    new SkillNotRegisteredError('publicar', 'skill-que-ninguem-registrou'),
    JOB,
  );

  namesAll(reason, ['skill-que-ninguem-registrou', 'publicar']);
});

test('AT3 — a pin mismatch names BOTH hashes, the declared and the registered', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const declared = `sha256:${'a'.repeat(64)}`;
  const registered = `sha256:${'f'.repeat(64)}`;
  const reason = classifyPreSessionFailure(
    new SkillPinMismatchError('publicar', 'travessia-fazer', declared, registered),
    JOB,
  );

  // Which of the two moved is not the machine's to guess (D4), so a human needs
  // both sides of the comparison to decide.
  namesAll(reason, [declared, registered, 'travessia-fazer']);
});

test('AT4 — an engine with no route names the engine and the node that asked for it', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const reason = classifyPreSessionFailure(
    new UnknownEngineError('gemini', 'revisar', ['claude-code', 'codex']),
    JOB,
  );

  namesAll(reason, ['gemini', 'revisar']);
});

test('AT5 — a dangling graph version names the version the work points at', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  // A skill-registry 404 is already translated into `SkillNotRegisteredError`
  // inside `renderSkillInstructions`, so a raw 404 surviving to here can only be
  // the graph-version read.
  const reason = classifyPreSessionFailure(
    new ControlPlaneClientError('unknown_graph_version', 404, { erro: 'unknown_graph_version' }),
    JOB,
  );

  namesAll(reason, [JOB.graph_version_id]);
});

test('AT6 — a control plane having a bad day does not classify, whatever the status', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  for (const status of [500, 502, 503]) {
    assert.equal(
      classifyPreSessionFailure(new ControlPlaneClientError('fora do ar', status, null), JOB),
      null,
      `${String(status)} is transient: blocking the job on it would need a human to undo a hiccup`,
    );
  }
});

test('AT7 — anything that is not one of the five classifies to null', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';

  for (const error of [timeout, new Error('boom'), new TypeError('nope'), 'a string', null]) {
    assert.equal(
      classifyPreSessionFailure(error, JOB),
      null,
      `an unrecognized error retries, it never blocks: ${String(error)}`,
    );
  }
});

/**
 * AT8/AT9 — the seventh cause, and the boundary right next to it (t272).
 *
 * The t109 game run put a real job through `software-development` and hit
 * the loop this classifier was built to close, from a direction it did not
 * cover: `testar-alpha` declares a domain-scoped `network`, `resolvePermissions`
 * cannot express that on this engine, and `ClaudeCodeAdapter.startSession`
 * refuses BEFORE the spawn — 38 leases in two minutes, not one session opened.
 * A refusal for a policy the engine cannot enforce is as deterministic as the
 * six above it: the same skill hash resolves to the same refusal on every tick.
 *
 * AT9 is the other half and the reason this is one CASE and not a whole
 * class: `SessionStartError` is one class for four causes, and the two spawn
 * shapes ("could not start", "could not open a session") carry nothing that
 * tells a missing binary from an `EMFILE`. Those keep classifying to `null` —
 * they are the bounded counter's business (`pre-session-retry.ts`), which is a
 * strictly weaker claim than "this will never work".
 */

test('AT8 — a permission policy the engine cannot enforce names the node and quotes the engine', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  const reason = classifyPreSessionFailure(
    new SessionStartError(`${PERMISSION_REFUSAL_PREFIX}${DOMAIN_SCOPED_NETWORK_REASON}`),
    JOB,
  );

  // The adapter's own message, verbatim: what a person has to fix is the field
  // `permission-policy.ts` names, and paraphrasing it here would be a second
  // spelling of a rule that lives in exactly one place.
  namesAll(reason, [JOB.current_node_id, DOMAIN_SCOPED_NETWORK_REASON]);
});

test('AT9 — a SessionStartError that is NOT a permission refusal classifies to null', async () => {
  const { classifyPreSessionFailure } = await loadModule();

  for (const message of [
    'could not start "claude": spawn claude ENOENT',
    'could not open a session: EMFILE',
    'permission policy',
  ]) {
    assert.equal(
      classifyPreSessionFailure(new SessionStartError(message), JOB),
      null,
      `a spawn failure may heal itself, so it retries instead of blocking: ${message}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* t270 Half B — the sixth cause: a bench the runner cannot read.              */
/*                                                                            */
/* `resolveExecutorEnvironment` shells out to `git` for a path and a commit    */
/* the operator configured at boot. A bad path, a `mainBranch` that does not   */
/* resolve, a bench that is not a repository — each of those answers the same  */
/* way on every retry, which is precisely the class this module exists to      */
/* block instead of loop. Leaving it unclassified would reopen t252's bug for  */
/* one new failure mode.                                                      */
/* -------------------------------------------------------------------------- */

test('t270 AT — a bench git could not read blocks, naming the command', async () => {
  const { classifyPreSessionFailure } = await loadModule();
  const { ExecutorEnvironmentError } = await import(
    new URL('../../src/dispatch/resolve-executor-environment.ts', import.meta.url).href
  );

  const reason = classifyPreSessionFailure(
    new ExecutorEnvironmentError(
      'the reference of the test bench could not be read',
      'git -C /srv/bancos/cartografo rev-parse main',
      "fatal: not a git repository: '/srv/bancos/cartografo'",
    ),
    JOB,
  );

  namesAll(reason, ['git -C /srv/bancos/cartografo rev-parse main']);
  assert.match(
    reason ?? '',
    /desbloqueie/,
    'the reason ends where every other one does: fix the configuration and unblock',
  );
});
