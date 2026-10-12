/**
 * The runner's npm scripts run from any shell (t684, AT14, AT15).
 *
 * `NAME=value command` is bash-only: PowerShell and `cmd` reject it. The spike
 * mode therefore travels as an argument, and the environment variable stays
 * honoured for anyone who already uses it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error — a plain .mjs script with no type declarations.
import { resolveSpikeMode } from '../scripts/copilot-spike-mode.mjs';

const mode = resolveSpikeMode as (argv: string[], env: Record<string, string | undefined>) => string;

test('t684 AT14 — no script begins with a NAME=value prefix', () => {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts: Record<string, string> };

  for (const [name, command] of Object.entries(manifest.scripts)) {
    assert.ok(!/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command), `${name}: ${command}`);
  }
  assert.ok(manifest.scripts['spike:copilot:stub']?.endsWith('--stub'));
  assert.ok(!manifest.scripts['spike:copilot']?.includes('--stub'));
});

test('t684 AT15 — the spike mode comes from --stub, then the variable, then github', () => {
  assert.equal(mode(['--stub'], {}), 'stub');
  assert.equal(mode([], {}), 'github');
  assert.equal(mode([], { COPILOT_SPIKE_MODE: ' stub ' }), 'stub');
  assert.equal(mode(['--stub'], { COPILOT_SPIKE_MODE: 'github' }), 'stub');
  assert.throws(() => mode([], { COPILOT_SPIKE_MODE: 'x' }), /must be "stub" or "github", got "x"/);
});
