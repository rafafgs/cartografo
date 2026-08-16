/**
 * t206 — the traversal defence of `resolveStaticFile`, pinned by test.
 *
 * `static.ts` says of itself that it is "not a file server", and that
 * `../../.cartografo/cartografo.db` "is exactly the request it refuses". Until
 * this file that was a promise checked by hand: every path below was probed once,
 * refused, and then nothing in the suite would have noticed the day an allowlist
 * tweak or a rewritten resolver stopped refusing it. The only 404 the suite had
 * was a plain `/nao-existe.js` in `server-proxy.test.ts`, which proves the shape
 * of the answer and nothing about the defence.
 *
 * No screen is started here, on purpose: the resolver is a pure function of the
 * request path, so this half of the ticket needs no port and no upstream, and
 * `test/server-proxy.test.ts` keeps the half that does.
 *
 * The probe paths keep their exact spelling, percent-encoded bytes and all: they
 * are the input under test, not prose.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as StaticModule from '../src/static.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const STATIC_PATH = path.join(PACKAGE_ROOT, 'src', 'static.ts');

let cache: typeof StaticModule | null = null;

async function loadStatic(): Promise<typeof StaticModule> {
  assert.ok(existsSync(STATIC_PATH), 'artifact does not exist yet: packages/tela/src/static.ts');
  cache ??= (await import(
    new URL('../src/static.ts', import.meta.url).href
  )) as typeof StaticModule;
  return cache;
}

/**
 * Every way out of `PUBLIC_DIR` that was worth trying, and one that is not a way
 * out at all but reads like one.
 *
 * Two different defences answer these, and both matter:
 *
 * - the **prefix check** stops what really resolves outside the directory —
 *   `..` raw, `..` percent-encoded once, and the mixed form that walks INTO a
 *   real file's name before climbing back out of it;
 * - the **extension allowlist** stops the rest — `//etc/passwd` collapses into
 *   `PUBLIC_DIR/etc/passwd`, which never escapes anything and is refused because
 *   the page is not made of extensionless files, and `%00` is refused because
 *   what follows the NUL is a `.png` the screen does not serve either.
 *
 * The backslash variant is here because it escapes on Windows and does not on
 * POSIX: on this platform it is one more file name that is not in the allowlist,
 * and pinning it is what will make a future `path.win32` mistake visible.
 *
 * `/../../package.json` is the last one and does not come from the ticket's
 * probe list, which was written from paths tried by hand. It is here because
 * every other probe above is refused by the ALLOWLIST — deleting the prefix
 * check outright leaves this test green, which was measured, not assumed. This
 * one escapes into a file that really exists and whose extension the page is
 * made of, so it is the only probe the prefix check refuses on its own, and
 * therefore the only one that pins it.
 */
const TRAVERSAL_PROBES = Object.freeze([
  '/../server.ts',
  '/..%2Fserver.ts',
  '/%2e%2e/server.ts',
  '/%2e%2e%2fserver.ts',
  '//etc/passwd',
  '/../../.cartografo/cartografo.db',
  '/inbox.js%00.png',
  '/..\\server.ts',
  '/style.css/../../router.ts',
  '/../../package.json',
]);

test('t206 AT3 — resolveStaticFile refuses every path that reaches outside the page', async () => {
  const { resolveStaticFile } = await loadStatic();

  for (const probe of TRAVERSAL_PROBES) {
    assert.equal(
      resolveStaticFile(probe),
      null,
      `the screen resolved a path it must never serve: ${probe}`,
    );
  }
});

test('t206 AT4 — every file the page is really made of resolves, and is served', async () => {
  const { INDEX_FILE, PUBLIC_DIR, resolveStaticFile, serveStatic } = await loadStatic();

  // Enumerated from disk, never hardcoded: the allowlist and the directory's
  // real contents drifting apart is the exact failure this half of the test
  // exists to catch — a new `.png` in `src/public/` would be a page piece the
  // screen silently 404s.
  const names = readdirSync(PUBLIC_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  assert.ok(names.includes(INDEX_FILE), `src/public has no ${INDEX_FILE} to serve at /`);
  assert.ok(names.length >= 5, `found only ${names.length} files; this is not reading the directory`);

  for (const requested of ['/', ...names.map((name) => `/${name}`)]) {
    const resolved = resolveStaticFile(requested);
    assert.ok(resolved !== null, `the screen stopped serving ${requested}`);
    assert.ok(
      resolved === PUBLIC_DIR || resolved.startsWith(`${PUBLIC_DIR}${path.sep}`),
      `${requested} resolved outside the page: ${resolved}`,
    );

    const served = await serveStatic(requested);
    assert.equal(served.status, 200, `${requested} did not come back as a file`);
    assert.ok(served.body.length > 0, `${requested} came back empty`);
  }
});
