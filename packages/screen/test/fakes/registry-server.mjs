/**
 * A fake official MCP registry, in the real one's measured shape (t373).
 *
 * `GET /v0/servers?search=<query>&limit=<n>` answers
 * `{"servers": [{"server": {…}, "_meta": {…}}], "metadata": {…}}` — the envelope
 * a live `GET` against `registry.modelcontextprotocol.io` returned on
 * 2026-09-07, and the one `officialRegistry` reads.
 *
 * It exists as a file of its own, rather than inline in a test, because TWO
 * suites need it: `mcp-catalog.test.ts` drives the client against it directly,
 * and `interview.test.ts` points a whole screen at it through
 * `ScreenOptions.mcpRegistryUrl`. The closest precedent is
 * `server-proxy.test.ts`'s `startFakeUpstream`, which stayed inline because
 * only that file ever used it.
 *
 * **Every knob is on a mutable `plan`**, read at request time and never
 * captured at start: the failure tests change the registry's behaviour BETWEEN
 * two calls of the same catalogue instance, which is precisely what a TTL test
 * has to be able to do.
 *
 * `.mjs` and not `.ts` on purpose: `packages/screen`'s own test script is
 * `node --test test/*.test.ts`, so a file here is only ever loaded by a test
 * that imports it, and never collected as one itself.
 */

import { createServer } from 'node:http';

/**
 * How the fixture answers, read fresh on every request.
 *
 * @typedef {object} RegistryPlan
 * @property {unknown[]} servers Entries to wrap in the registry envelope.
 * @property {number} status HTTP status of the answer.
 * @property {string | undefined} body A body sent verbatim instead of the
 *   envelope — how the malformed and wrong-shape cases are staged.
 * @property {number} delayMs Milliseconds to wait before answering; large
 *   enough is "it hangs".
 */

/** @type {RegistryPlan} */
const DEFAULT_PLAN = {
  servers: [],
  status: 200,
  body: undefined,
  delayMs: 0,
};

/**
 * One `server` object, in the registry's own shape.
 *
 * @param {Record<string, unknown>} overrides What this entry says.
 * @returns {{server: Record<string, unknown>, _meta: Record<string, unknown>}} The entry, enveloped.
 */
export function entry(overrides) {
  return {
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      version: '1.0.0',
      ...overrides,
    },
    _meta: {
      'io.modelcontextprotocol.registry/official': {
        status: 'active',
        isLatest: true,
      },
    },
  };
}

/** An entry whose only package is an npm one — the `npx -y …` case. */
export const NPM_ENTRY = entry({
  name: 'io.example/calendar',
  description: 'Reads and writes a calendar.',
  repository: { url: 'https://github.com/example/calendar', source: 'github' },
  websiteUrl: 'https://example.com/calendar',
  packages: [
    {
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: 'calendar-mcp-server',
      version: '0.1.2',
      runtimeHint: 'npx',
      transport: { type: 'stdio' },
      environmentVariables: [],
    },
  ],
});

/** An entry whose only package is a pypi one — the `uvx …` case. */
export const PYPI_ENTRY = entry({
  name: 'io.example/calendar-python',
  description: 'The same calendar, in Python.',
  repository: { url: 'https://github.com/example/calendar-python', source: 'github' },
  packages: [
    {
      registryType: 'pypi',
      identifier: 'calendar-mcp',
      version: '2.0.0',
      runtimeHint: 'uvx',
      transport: { type: 'stdio' },
      environmentVariables: [],
    },
  ],
});

/** An entry that is only reachable over HTTP: no add command is evidenced. */
export const REMOTE_ONLY_ENTRY = entry({
  name: 'io.example/calendar-hosted',
  description: 'A hosted calendar endpoint.',
  repository: { url: 'https://github.com/example/calendar-hosted', source: 'github' },
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://example.com/api/mcp',
      headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
    },
  ],
});

/** An entry whose only package is a container: no add command is evidenced. */
export const DOCKER_ENTRY = entry({
  name: 'io.example/calendar-container',
  description: 'The calendar, as a container.',
  repository: { url: 'https://github.com/example/calendar-container', source: 'github' },
  packages: [
    {
      registryType: 'docker',
      identifier: 'example/calendar-mcp',
      version: '1.4.0',
      transport: { type: 'stdio' },
    },
  ],
});

/** An entry with neither `websiteUrl` nor a repository — `homepage` is null. */
export const NO_HOMEPAGE_ENTRY = entry({
  name: 'io.example/calendar-anonymous',
  description: 'A calendar nobody published an address for.',
  packages: [{ registryType: 'npm', identifier: 'anonymous-calendar-mcp', version: '0.0.1' }],
});

/**
 * The fixture, up.
 *
 * @typedef {object} RunningRegistry
 * @property {string} url Its address, loopback and ephemeral.
 * @property {string[]} requests Every request target it saw, in order.
 * @property {RegistryPlan} plan What it answers next — mutate it freely.
 */

/**
 * Starts the fixture on an ephemeral loopback port.
 *
 * @param {{after: (fn: () => void | Promise<void>) => void}} t Test context, for the shutdown.
 * @param {Partial<RegistryPlan>} [initial] What it answers to begin with.
 * @returns {Promise<RunningRegistry>} The fixture, up.
 */
export async function startRegistryFixture(t, initial = {}) {
  /** @type {string[]} */
  const requests = [];
  /** @type {RegistryPlan} */
  const plan = { ...DEFAULT_PLAN, ...initial };
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();

  const server = createServer((request, response) => {
    requests.push(request.url ?? '');

    const answer = () => {
      const body =
        plan.body ??
        JSON.stringify({ servers: plan.servers, metadata: { count: plan.servers.length } });
      response.writeHead(plan.status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(body);
    };

    if (plan.delayMs <= 0) {
      answer();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.writableEnded) answer();
    }, plan.delayMs);
    timers.add(timer);
  });

  const port = await /** @type {Promise<number>} */ (
    new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('the registry fixture did not bind a port'));
          return;
        }
        resolve(address.port);
      });
    })
  );

  t.after(async () => {
    // The timers first: a hung answer still holds a socket, and closing the
    // server without cutting them would make the suite wait out the delay it
    // exists never to wait for.
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  });

  return { url: `http://127.0.0.1:${port}`, requests, plan };
}
