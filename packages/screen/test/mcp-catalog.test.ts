/**
 * Acceptance tests for the MCP catalogue (t373, RF-20 extension).
 *
 * The whole file is about ONE promise: `search()` never rejects and never
 * blocks the page behind it. RF-20's suggestion is a courtesy — a registry that
 * is slow, down, or answering something nobody expected must cost the interview
 * exactly as much as one that answered "nothing found", which is nothing at all.
 *
 * So every failure mode the network has is staged for real here, against
 * `fakes/registry-server.mjs` on a loopback port, rather than mocked at the
 * `fetch` boundary: a stub that resolves `Promise.reject()` proves the `catch`
 * runs, and proves nothing about a socket that accepts a connection and then
 * says nothing, which is the failure this product's own t434 measured one layer
 * down.
 *
 * The two pure functions — `cachedCatalog` and `extractMcpHint` — take an
 * injected clock and a string, and need no server at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as McpCatalogModule from '../src/mcp-catalog.ts';
import {
  DOCKER_ENTRY,
  NO_HOMEPAGE_ENTRY,
  NPM_ENTRY,
  PYPI_ENTRY,
  REMOTE_ONLY_ENTRY,
  entry,
  startRegistryFixture,
} from './fakes/registry-server.mjs';
import { requireArtifacts } from './support.ts';

async function loadCatalog(): Promise<typeof McpCatalogModule> {
  requireArtifacts('src/mcp-catalog.ts');
  return (await import(
    new URL('../src/mcp-catalog.ts', import.meta.url).href
  )) as typeof McpCatalogModule;
}

/** Minimal shape of the test context this file uses, for the fixture's shutdown. */
interface Cleanup {
  after: (fn: () => void | Promise<void>) => void;
}

/** The default `timeoutMs` of `officialRegistry`, restated so AT4 can measure it. */
const DECLARED_TIMEOUT_MS = 3000;

/* ================================================================= AT1 */

test('t373 AT1 — an npm entry and a pypi entry each come back with both add commands', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const registry = await startRegistryFixture(t as Cleanup, {
    servers: [NPM_ENTRY, PYPI_ENTRY],
  });

  const found = await officialRegistry({ baseUrl: registry.url }).search('calendar');

  assert.equal(found.length, 2);
  assert.deepEqual(found[0].install, {
    claude_code: 'claude mcp add io.example/calendar -- npx -y calendar-mcp-server',
    codex: 'codex mcp add io.example/calendar -- npx -y calendar-mcp-server',
  });
  assert.deepEqual(found[1].install, {
    claude_code: 'claude mcp add io.example/calendar-python -- uvx calendar-mcp',
    codex: 'codex mcp add io.example/calendar-python -- uvx calendar-mcp',
  });
  assert.equal(found[0].name, 'io.example/calendar');
  assert.equal(found[0].description, 'Reads and writes a calendar.');
});

/* ================================================================= AT2 */

test('t373 AT2 — a remote-only entry and a docker-only entry carry no add command at all', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const registry = await startRegistryFixture(t as Cleanup, {
    servers: [REMOTE_ONLY_ENTRY, DOCKER_ENTRY],
  });

  const found = await officialRegistry({ baseUrl: registry.url }).search('calendar');

  assert.equal(found.length, 2);
  for (const suggestion of found) {
    assert.equal(suggestion.install.claude_code, null, `${suggestion.name} claims a claude command`);
    assert.equal(suggestion.install.codex, null, `${suggestion.name} claims a codex command`);
  }
  // It is still a suggestion, and still points somewhere.
  assert.equal(found[0].homepage, 'https://github.com/example/calendar-hosted');
});

/* ================================================================= AT3 */

test('t373 AT3 — homepage prefers websiteUrl, falls back to the repository, then to null', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const registry = await startRegistryFixture(t as Cleanup, {
    // NPM_ENTRY has both; PYPI_ENTRY has only the repository; the third has
    // neither.
    servers: [NPM_ENTRY, PYPI_ENTRY, NO_HOMEPAGE_ENTRY],
  });

  const found = await officialRegistry({ baseUrl: registry.url }).search('calendar');

  assert.equal(found[0].homepage, 'https://example.com/calendar');
  assert.equal(found[1].homepage, 'https://github.com/example/calendar-python');
  assert.equal(found[2].homepage, null);
});

/* ================================================================= AT4 */

test('t373 AT4 — a registry that never answers resolves empty, inside the declared timeout', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const registry = await startRegistryFixture(t as Cleanup, {
    servers: [NPM_ENTRY],
    delayMs: 60_000,
  });

  const started = Date.now();
  const found = await officialRegistry({ baseUrl: registry.url }).search('calendar');
  const elapsed = Date.now() - started;

  assert.deepEqual(found, [], 'a hung registry is "nothing found", never a rejection');
  assert.ok(
    elapsed >= DECLARED_TIMEOUT_MS - 250,
    `it gave up before its own timeout: ${elapsed}ms`,
  );
  assert.ok(
    elapsed < DECLARED_TIMEOUT_MS + 2000,
    `it waited well past its own timeout: ${elapsed}ms`,
  );
});

/* ================================================================= AT5 */

test('t373 AT5 — a refusal, a wrong shape and a broken body all resolve empty', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const registry = await startRegistryFixture(t as Cleanup, { servers: [NPM_ENTRY] });
  const catalog = officialRegistry({ baseUrl: registry.url });

  registry.plan.status = 503;
  registry.plan.body = '{"error":"unavailable"}';
  assert.deepEqual(await catalog.search('calendar'), [], 'a non-2xx answer');

  registry.plan.status = 200;
  registry.plan.body = '{"totally":"different"}';
  assert.deepEqual(await catalog.search('calendar'), [], 'valid JSON of the wrong shape');

  registry.plan.body = 'not json at all {';
  assert.deepEqual(await catalog.search('calendar'), [], 'a body that does not parse');
});

/* ================================================================= AT6 */

test('t373 AT6 — the query carries search and limit=3, and more than three are cut to three', async (t) => {
  const { officialRegistry } = await loadCatalog();
  const five = [1, 2, 3, 4, 5].map((index) =>
    entry({
      name: `io.example/calendar-${index}`,
      description: `Calendar number ${index}.`,
      packages: [{ registryType: 'npm', identifier: `calendar-${index}` }],
    }),
  );
  const registry = await startRegistryFixture(t as Cleanup, { servers: five });

  const found = await officialRegistry({ baseUrl: registry.url }).search('a calendar');

  assert.equal(found.length, 3, 'the page shows at most three, whatever came back');
  assert.equal(registry.requests.length, 1);
  const asked = new URL(registry.requests[0], registry.url);
  assert.equal(asked.pathname, '/v0/servers');
  assert.equal(asked.searchParams.get('search'), 'a calendar');
  assert.equal(asked.searchParams.get('limit'), '3');
});

/* ================================================================= AT7 */

test('t373 AT7 — a non-empty result is served from cache until successTtlMs has passed', async () => {
  const { cachedCatalog } = await loadCatalog();

  let calls = 0;
  let clock = 1_000;
  const underlying: McpCatalogModule.McpCatalog = {
    async search(query) {
      calls += 1;
      return [
        {
          name: `io.example/${query}`,
          description: 'anything',
          homepage: null,
          install: { claude_code: 'claude mcp add x -- npx -y x', codex: null },
        },
      ];
    },
  };

  const cached = cachedCatalog(underlying, {
    successTtlMs: 300_000,
    failureTtlMs: 30_000,
    now: () => clock,
  });

  await cached.search('x');
  clock += 299_999;
  await cached.search('x');
  assert.equal(calls, 1, 'a second look inside the window costs no request');

  clock += 1;
  await cached.search('x');
  assert.equal(calls, 2, 'past the window it asks again');
});

/* ================================================================= AT8 */

test('t373 AT8 — an empty result expires on failureTtlMs, not on successTtlMs', async () => {
  const { cachedCatalog } = await loadCatalog();

  let calls = 0;
  let clock = 1_000;
  const underlying: McpCatalogModule.McpCatalog = {
    async search() {
      calls += 1;
      return [];
    },
  };

  const cached = cachedCatalog(underlying, {
    successTtlMs: 300_000,
    failureTtlMs: 30_000,
    now: () => clock,
  });

  assert.deepEqual(await cached.search('x'), []);
  clock += 29_999;
  await cached.search('x');
  assert.equal(calls, 1, 'a down registry is not re-attempted on the very next poll');

  clock += 1;
  await cached.search('x');
  assert.equal(calls, 2, 'and it IS re-attempted well inside the success window');
});

/* ================================================================= AT9 */

test('t373 AT9 — extractMcpHint reads the one line it is looking for, and nothing else', async () => {
  const { extractMcpHint } = await loadCatalog();

  const context = [
    'You said this step reaches into your calendar.',
    'Nothing this engine reports covers that.',
    'NEEDS_MCP_SERVER: calendar',
    'I am recording it in the step description either way.',
  ].join('\n');
  assert.equal(extractMcpHint(context), 'calendar');

  assert.equal(extractMcpHint('The name is the address every map is filed under.'), null);
  assert.equal(extractMcpHint(null), null);
  assert.equal(extractMcpHint('NEEDS_MCP_SERVER:'), null);
  assert.equal(extractMcpHint('NEEDS_MCP_SERVER:    '), null);
  assert.equal(extractMcpHint('prose\nNEEDS_MCP_SERVER:   a shared calendar  \nmore'), 'a shared calendar');
});
