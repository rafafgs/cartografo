/**
 * The `CodexAdapter` running the whole conformance kit (C1–C10).
 *
 * This file is the proof that the kit is what it claims to be. It is the SAME
 * `runConformanceKit` the Claude Code adapter runs, imported and not copied:
 * everything specific to this engine lives here — the seam that swaps the real
 * binary for the fake, and the shape of the frame the `engineRef` comes out of.
 * If the kit had leaked engine vocabulary above the line, this is the file that
 * would not compile.
 *
 * With this adapter certified, the two-consumers rule
 * (`notes/2026-08-14-extension-and-quality.md:58-64`) is satisfied and the
 * specification freezes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { buildCommand } from '../../src/engine/codex-command.ts';
import { runConformanceKit } from '../../src/engine/conformance-kit.ts';
import { resolveCapabilities } from '../../src/engine/types.ts';

const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** A thread id in the shape the real CLI emitted (`engine-adapter.md:410`). */
const ENGINE_REF = '01a000e7-3f4b-7c21-9d55-2b8e6a1c0f93';

runConformanceKit(
  (fakeEnginePath) =>
    new CodexAdapter({
      // The kit's seam: the argv the real `codex` would receive, whole and
      // unedited, handed to the fake engine. Only the binary changes — which is
      // what makes C2 measure the real injection and not a version of it
      // simplified for the test.
      //
      // Spread and not rebuilt from `{command, args}`, since t203: the command
      // grew an optional `stdin` off the argv, and a seam that dropped it would
      // be testing an adapter whose oversized content channel the test harness
      // had removed.
      commandBuilder: (spec) => {
        const built = buildCommand(spec);
        return { ...built, command: process.execPath, args: [fakeEnginePath, ...built.args] };
      },
      // Short grace: C4 waits for the escalation to SIGKILL inside the case's
      // own deadline.
      graceMs: 300,
    }),
  FAKE_ENGINE,
  {
    engineRefFrame: {
      line: JSON.stringify({ type: 'thread.started', thread_id: ENGINE_REF }),
      expectedRef: ENGINE_REF,
    },
  },
);

test('engineName is the stable identifier persisted on the session row', () => {
  assert.equal(new CodexAdapter().engineName, 'codex');
});

test('capabilities declares only what has a consumer in v0', () => {
  // `hasStructuredOutput` because `--json` emits JSONL. `hasResume` stays
  // ABSENT even though `codex exec resume [SESSION_ID]` exists for real
  // (`engine-adapter.md:415`): resume is listed in "Fora de escopo (v0)"
  // (`:487-491`), and lighting up a field with no consumer is the same way a
  // format rots as inventing one (`types.ts:103-105`). The feasibility table
  // is exploratory analysis; the scope decision is what rules.
  const declared = new CodexAdapter().capabilities();

  assert.deepEqual(declared, { hasStructuredOutput: true });
  assert.ok(!('hasResume' in declared));
  assert.ok(!('reportsUsage' in declared));

  // The other half of the same statement, and the one C10 branches on: absent
  // IS false, through the document's own normalizer. t173 lit `hasResume` up
  // for the `claude-code` adapter and left this one alone on purpose —
  // `codex exec resume` is a subcommand, not a flag, so it is a different
  // mechanism and a ficha of its own.
  assert.equal(resolveCapabilities(declared).hasResume, false);
});
