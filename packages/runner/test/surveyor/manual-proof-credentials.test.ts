/**
 * Acceptance tests for the surveyor's manual proof and for what the spec says
 * about it (t146).
 *
 * `scripts/spike-surveyor-flow.mjs` is the other half of `proposal.test.ts`:
 * the half the suite cannot run, because it needs a real `claude` binary. Since
 * t124 it also needs a credential — it boots a real control plane and then
 * speaks `/v1` at it eight times — and it had none, so the proof died on its
 * first call with a 401 nobody would understand. A proof script that cannot run
 * is worse than no proof script: it is a green checkbox in a ficha's evidence
 * section pointing at a command that fails.
 *
 * A static sweep and not an execution, on purpose: running it needs the binary,
 * an account and about three minutes, which is exactly why it is not a CI test
 * (`docs/formatos/engine-adapter.md`). What a sweep CAN prove is the invariant
 * this ficha exists for — that no call in that script reaches the control plane
 * anonymously — and it is the same device `no-privileged-access.test.ts` uses
 * to keep the runner off the database.
 *
 * The last test is the doc claim itself. The bug this ficha reports is not only
 * that the command had no token: it is that the spec asserted it did. A
 * document that describes a flag nobody implemented is a trap for the next
 * person, so the claim is now something a test holds up.
 *
 * English per D18; route segments and payload keys stay in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPIKE_PATH = path.join(PACKAGE_ROOT, 'scripts', 'spike-surveyor-flow.mjs');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'topografo-flow.md');

/** Reads a file the sweep asserts about, failing with its path when absent. */
function read(file: string): string {
  assert.ok(existsSync(file), `artifact does not exist yet: ${file}`);
  return readFileSync(file, 'utf8');
}

/**
 * The object literal a named call is made with, as written.
 *
 * A scanner and not a regex: these calls carry other calls inside them
 * (`instructions: nodeInstructions(node, task)`), and a pattern bounded by the
 * next parenthesis stops in the middle of the argument it is supposed to read.
 *
 * @param source File contents.
 * @param callee Text right before the `({` — a name, or `new` plus a name.
 * @returns The `({ … })` span, or `null` when the call is not there at all.
 */
function objectArgument(source: string, callee: string): string | null {
  const start = source.indexOf(`${callee}({`);
  if (start === -1) return null;
  const end = source.indexOf('})', start);
  return end === -1 ? null : source.slice(start, end + 2);
}

test('AT8 — the manual proof takes the token the control plane printed on boot', () => {
  const source = read(SPIKE_PATH);

  assert.ok(
    source.includes('bootstrapToken'),
    'the proof boots its own control plane, so the only token it can present is the one that ' +
      'startup announced on its readiness line — and it never reads it',
  );
});

test('AT9 — no call in the manual proof reaches the control plane anonymously', () => {
  const source = read(SPIKE_PATH);

  // One place in the whole script may call the global `fetch`: the wrapper that
  // arms the request with the token. Any second one is a route that goes out
  // bare, which is precisely the defect this ficha reports.
  const bare = source.match(/(?<![\w.$])fetch\(/g) ?? [];
  assert.equal(
    bare.length,
    1,
    `the script calls the global fetch in ${bare.length} places; exactly one — the wrapper that ` +
      'presents the token — may do so',
  );
  assert.match(source, /authorization/i);

  // The two other doors out of this script: the HTTP client the surveyor gets,
  // and the dispatch that writes the telemetry of the two crossing sessions.
  const construction = objectArgument(source, 'new ClienteControle');
  assert.ok(construction !== null, 'the proof no longer builds a ClienteControle at all');
  assert.match(construction, /token/, 'the surveyor client is still built with no token');

  const dispatch = objectArgument(source, 'createClaudeCodeDispatch');
  assert.ok(dispatch !== null, 'the proof no longer dispatches a session at all');
  // Until t147 this read `doFetch`: the dispatch had no notion of a credential,
  // and the only way to arm it was to hand it the wrapper above through its test
  // seam. t147 gave it a `token` of its own, so the invariant this test defends
  // is unchanged and only the door it comes through moved.
  assert.match(
    dispatch,
    /token/,
    'the two real sessions write their telemetry through the dispatch, so it has to be handed ' +
      'the token the boot announced',
  );
});

test('AT10 — the spec documents the credential the command actually accepts', () => {
  const spec = read(SPEC_PATH);

  const usage = spec.match(/```\n(npm run surveyor[^`]*)```/);
  assert.ok(usage !== null, 'the spec no longer shows how the command is invoked');
  assert.match(
    usage[1],
    /--token/,
    `the invocation the spec documents does not carry the token:\n${usage[1]}`,
  );
  assert.ok(
    spec.includes('CARTOGRAFO_TOKEN'),
    'the spec claims the command presents a token; it has to name the variable it reads',
  );
});
