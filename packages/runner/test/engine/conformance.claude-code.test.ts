/**
 * The `ClaudeCodeAdapter` running the whole conformance kit (C1–C7).
 *
 * The kit knows nothing about this adapter: it receives a factory and a path to
 * a fake engine. Every Claude Code specificity lives in this file — the seam
 * that swaps the real binary for the fake, and the shape of the `stream-json`
 * frame the `engineRef` comes out of. It is that boundary that makes the same
 * suite serve the second adapter (t119) without a copy.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import { runConformanceKit } from '../../src/engine/conformance-kit.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const ENGINE_REF = 'engine-session-ref-abc123';

runConformanceKit(
  (fakeEnginePath) =>
    new ClaudeCodeAdapter({
      // The seam the kit demands: the argv the `claude` CLI would receive,
      // whole and unedited, handed to the fake engine. Changing only the binary
      // is what makes C2 measure the real injection, and not a simplified
      // version of it built for the test.
      commandBuilder: (spec) => ({
        command: process.execPath,
        args: [fakeEnginePath, ...buildCommand(spec).args],
      }),
      // Short grace: C4 waits for the escalation to SIGKILL within the case's
      // own deadline.
      graceMs: 300,
    }),
  FAKE_ENGINE,
  {
    engineRefFrame: {
      line: JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: ENGINE_REF,
        model: 'claude-opus-5',
      }),
      expectedRef: ENGINE_REF,
    },
  },
);

test('engineName is the stable identifier persisted on the session row', () => {
  assert.equal(new ClaudeCodeAdapter().engineName, 'claude-code');
});

test('capabilities declares only what has a consumer', () => {
  // `hasStructuredOutput` because `stream-json` is parseable. The other two
  // stay ABSENT, not explicitly `false`: neither has a consumer in v0, and
  // "declaring the fourth, fifth and sixth before anybody reads them is how a
  // format rots" (`docs/formatos/engine-adapter.md:160-165`). Absent already
  // means `false` through `resolveCapabilities`.
  const declared = new ClaudeCodeAdapter().capabilities();

  assert.deepEqual(declared, { hasStructuredOutput: true });
  assert.ok(!('hasResume' in declared));
  assert.ok(!('reportsUsage' in declared));
});
