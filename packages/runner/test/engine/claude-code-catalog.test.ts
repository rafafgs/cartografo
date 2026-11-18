/**
 * The claude-code catalogue after t1282 (FR10): two ids added, four kept.
 *
 * The list is advisory and ages — nothing validates a node's `model` against it —
 * so growing it is additive, and no existing id may leave.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';

test('t1282 AT25 — listModels() names the two newer ids, keeps the four old ones, and repeats none', async () => {
  const catalog = await new ClaudeCodeAdapter().listModels!();
  const byId = new Map(catalog.models.map((entry) => [entry.id, entry]));

  for (const added of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    const entry = byId.get(added);
    assert.ok(entry, `${added} is in the catalogue`);
    assert.equal(entry.origin, 'catalog');
    assert.ok((entry.label ?? '').trim() !== '', `${added} has a label`);
  }
  for (const kept of ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
    assert.ok(byId.has(kept), `${kept} stays: the change is additive`);
  }
  const ids = catalog.models.map((entry) => entry.id);
  assert.deepEqual(ids, [...new Set(ids)], 'no duplicate id');
});
