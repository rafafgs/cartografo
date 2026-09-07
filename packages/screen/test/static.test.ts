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
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as StaticModule from '../src/static.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const STATIC_PATH = path.join(PACKAGE_ROOT, 'src', 'static.ts');

let cache: typeof StaticModule | null = null;

async function loadStatic(): Promise<typeof StaticModule> {
  assert.ok(existsSync(STATIC_PATH), 'artifact does not exist yet: packages/screen/src/static.ts');
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

  assert.ok(names.includes(INDEX_FILE), `src/public has no ${INDEX_FILE} to serve at /inbox`);
  assert.ok(names.length >= 5, `found only ${names.length} files; this is not reading the directory`);

  for (const requested of ['/inbox', ...names.map((name) => `/${name}`)]) {
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

/**
 * t402 AT11 — the inbox moved from `/` to `/inbox`, in both directions.
 *
 * The root became the check page (RF-10), which is rendered by `pages.ts` and
 * reached through `route()`. That only works if `resolveStaticFile` stops
 * claiming `/`: the router tries the file first, and a resolver that still
 * answered there would keep serving `index.html` over a view that exists.
 *
 * So both halves are asserted, and the second is the one that matters: the
 * document really moved (byte for byte against the file on disk), and the old
 * address really stopped answering with it.
 */
test('t402 AT11 — /inbox serves index.html byte for byte, and / no longer does', async () => {
  const { INDEX_FILE, PUBLIC_DIR, resolveStaticFile, serveStatic } = await loadStatic();

  const onDisk = readFileSync(path.join(PUBLIC_DIR, INDEX_FILE));

  assert.equal(
    resolveStaticFile('/inbox'),
    path.join(PUBLIC_DIR, INDEX_FILE),
    'the inbox no longer has an address of its own',
  );
  const served = await serveStatic('/inbox');
  assert.equal(served.status, 200);
  assert.deepEqual(served.body, onDisk, '/inbox does not serve the inbox document');
  assert.match(served.headers['content-type'], /^text\/html/);

  assert.equal(
    resolveStaticFile('/'),
    null,
    'the root still resolves to a file, so the check page can never be reached',
  );

  // `/inbox.js` is a different path and keeps being the module it always was —
  // the new mapping matches the exact path, not a prefix of it.
  assert.equal(resolveStaticFile('/inbox.js'), path.join(PUBLIC_DIR, 'inbox.js'));
});

/**
 * t458 AT3 — `/style.css` is the one stylesheet, exercised through the real
 * static-file path (not just read off disk): the collapse (`layout()` linking
 * it instead of inlining `STYLE`) only holds if this route keeps serving it.
 */
test('t458 AT3 — GET /style.css 200s as CSS and carries the token set', async () => {
  const { serveStatic } = await loadStatic();

  const served = await serveStatic('/style.css');
  assert.equal(served.status, 200);
  assert.match(served.headers['content-type'], /^text\/css/);
  const body = served.body.toString('utf8');
  assert.ok(body.includes(':root'), '/style.css has no :root token block');
  assert.ok(body.includes('--radius'), '/style.css has no --radius token');
});

/**
 * t484 AC1 — the returning-browser bug. `serveStatic` answered `/style.css`
 * with no validator at all (`static.ts:88-109` before this ticket), so a
 * browser holding a heuristically-cached copy from before t458 never asked
 * again. An `etag` closes that: a conditional request that echoes it back
 * gets a `304` instead of a fresh body.
 */
test('t484 AC1 — GET /style.css carries an etag, and a matching If-None-Match gets 304', async () => {
  const { serveStatic } = await loadStatic();

  const first = await serveStatic('/style.css');
  assert.equal(first.status, 200);
  const etag = first.headers.etag;
  assert.ok(etag, '/style.css has no etag header');
  assert.match(etag, /^"[0-9a-f]+"$/, 'etag is not a quoted hex digest');

  const revalidated = await serveStatic('/style.css', { 'if-none-match': etag });
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.body.length, 0, '304 must carry an empty body');
  assert.equal(revalidated.headers.etag, etag);
  assert.equal(
    revalidated.headers['content-type'],
    undefined,
    '304 has no body, so it has no content-type either',
  );
});

/**
 * t484 AC2 — the validator has to be content-derived, not a constant: a file
 * whose bytes change on disk must report a different `etag`, and a browser
 * still holding the old one must get the new bytes back, not a stale 304.
 *
 * The fixture is written into `public/` (the only directory `serveStatic`
 * will answer from) and removed in a `finally`, so a failed assertion never
 * leaves the repository dirty.
 */
test('t484 AC2 — changing a static file on disk changes its etag', async () => {
  const { PUBLIC_DIR, serveStatic } = await loadStatic();

  const fixtureName = 't484-etag-fixture.json';
  const fixturePath = path.join(PUBLIC_DIR, fixtureName);
  writeFileSync(fixturePath, '{"version":1}');

  try {
    const first = await serveStatic(`/${fixtureName}`);
    assert.equal(first.status, 200);
    const firstEtag = first.headers.etag;
    assert.ok(firstEtag, 'fixture has no etag');

    writeFileSync(fixturePath, '{"version":2}');

    const second = await serveStatic(`/${fixtureName}`, { 'if-none-match': firstEtag });
    assert.equal(second.status, 200, 'stale If-None-Match must not short-circuit fresh bytes');
    assert.equal(second.body.toString('utf8'), '{"version":2}');
    assert.notEqual(second.headers.etag, firstEtag, 'etag did not change with the file bytes');
  } finally {
    unlinkSync(fixturePath);
  }
});

/**
 * t484 FR3/FR4 — `no-cache` (cacheable, but must revalidate), never `no-store`,
 * and uniform across every file `public/` serves, not special-cased to
 * `/style.css`.
 */
test('t484 FR3/FR4 — static files carry cache-control: no-cache, never no-store', async () => {
  const { serveStatic } = await loadStatic();

  for (const requested of ['/style.css', '/graph-editor.html']) {
    const served = await serveStatic(requested);
    assert.equal(served.status, 200, `${requested} did not come back as a file`);
    assert.equal(served.headers['cache-control'], 'no-cache', `${requested}'s cache-control`);
  }
});
