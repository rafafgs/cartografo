/**
 * `listModels()` on both adapters (t166, FR9/FR10).
 *
 * What is proven here is narrow on purpose, because the capability is: each
 * adapter answers a non-empty catalog, every entry names an identifier the CLI
 * would accept after `--model`/`-m`, and every entry says `origin: 'catalog'`.
 *
 * The last one is not a formality — it is the honest gap the ticket wrote down.
 * Neither `claude --help` nor `codex --help` exposes a subcommand or a flag that
 * LISTS models (both were run for this ticket; both only SET one), so the
 * CLI-query branch of `listModels()` has no consumer in v0 and both adapters
 * resolve to their static catalog, always. An entry that claimed `origin: 'cli'`
 * would be an adapter lying about where it got the list, which is exactly the
 * kind of claim `CliProbe.authenticated` already had demoted, in writing, for
 * the same reason.
 *
 * No fake engine and no spawn: the catalog is a pure read, and a test that
 * needed a binary to prove it would be testing the binary.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { CodexAdapter } from '../../src/engine/codex-adapter.ts';
import { CopilotAdapter } from '../../src/engine/copilot-adapter.ts';
import type { EngineAdapter, ModelCatalog } from '../../src/engine/types.ts';

/** The three adapters, each named as it names itself. */
const ADAPTERS: ReadonlyArray<() => EngineAdapter> = [
  () => new ClaudeCodeAdapter(),
  () => new CodexAdapter(),
  () => new CopilotAdapter(),
];

/** Calls `listModels()`, failing by name when an adapter did not implement it. */
async function catalogOf(adapter: EngineAdapter): Promise<ModelCatalog> {
  assert.equal(
    typeof adapter.listModels,
    'function',
    `${adapter.engineName} does not implement listModels()`,
  );
  return await adapter.listModels!();
}

for (const build of ADAPTERS) {
  const engineName = build().engineName;

  test(`t166 — ${engineName} resolves a non-empty catalog`, async () => {
    const catalog = await catalogOf(build());

    assert.ok(Array.isArray(catalog.models));
    assert.ok(catalog.models.length > 0, 'an empty catalog is not discovery, it is silence');

    const identifiers = catalog.models.map((entry) => entry.id);
    assert.deepEqual(
      identifiers,
      [...new Set(identifiers)],
      'a repeated identifier is a catalog that would upsert over itself',
    );
    for (const entry of catalog.models) {
      assert.equal(typeof entry.id, 'string');
      assert.ok(entry.id.trim() !== '', 'an empty id is not something to pass after --model');
      if (entry.label !== undefined) assert.equal(typeof entry.label, 'string');
    }
  });

  test(`t166 — every ${engineName} entry declares origin "catalog"`, async () => {
    const catalog = await catalogOf(build());

    for (const entry of catalog.models) {
      assert.equal(
        entry.origin,
        'catalog',
        `"${entry.id}" claims to have come from the CLI, and no CLI answers that question in v0`,
      );
    }
  });

  test(`t166 — ${engineName} stamps resolvedAt as an ISO timestamp`, async () => {
    const catalog = await catalogOf(build());

    assert.equal(typeof catalog.resolvedAt, 'string');
    assert.ok(
      !Number.isNaN(Date.parse(catalog.resolvedAt)),
      `resolvedAt is not a readable instant: ${JSON.stringify(catalog.resolvedAt)}`,
    );
  });
}

test('t166 — the two catalogs are the two adapters, not one list shared by accident', async () => {
  const [claude, codex] = await Promise.all([
    catalogOf(new ClaudeCodeAdapter()),
    catalogOf(new CodexAdapter()),
  ]);

  const shared = claude.models
    .map((entry) => entry.id)
    .filter((id) => codex.models.some((entry) => entry.id === id));
  assert.deepEqual(shared, [], 'the two engines cannot offer the same model identifier');
});

test('t676 — the copilot catalog offers "auto" and ids the CLI documents', async () => {
  const catalog = await catalogOf(new CopilotAdapter());
  const ids = catalog.models.map((entry) => entry.id);

  // `--model auto` is how the CLI itself says "let Copilot pick" (`copilot
  // --help`), and it is the one entry that is not a model id.
  assert.ok(ids.includes('auto'), 'the catalog has no "auto" entry');
  // A few ids `copilot help config` lists for 1.0.95, across the vendors it routes.
  for (const id of ['claude-sonnet-5.5', 'gpt-5.5', 'gemini-3.8-flash']) {
    assert.ok(ids.includes(id), `the documented id "${id}" is missing`);
  }
  for (const entry of catalog.models) assert.equal(entry.origin, 'catalog');
});

test('t676 — the copilot adapter still does not declare reportsUsage', () => {
  // `result.usage` carries request counts and durations, not tokens, and
  // `SessionFinishDetail` has no slot for them: declaring the capability would
  // promise a number nobody reports.
  const capabilities = new CopilotAdapter().capabilities();
  assert.notEqual(capabilities.reportsUsage, true);
  assert.equal(capabilities.reportsUsage ?? false, false);
});
