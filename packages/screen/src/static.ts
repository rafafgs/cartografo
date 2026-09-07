/**
 * The files the browser loads, and nothing else.
 *
 * Extracted from `server.ts` when the screen grew a second half. The proposal
 * inbox (t111) is a static page plus three native ES modules; the observability
 * screen (t107) is rendered on the server. Both live behind the same port, so
 * the one handler that decides between them needs to serve files without
 * depending on either half — that is all this module is.
 *
 * It serves five files. It is not a file server, and
 * `../../.cartografo/cartografo.db` is exactly the request it refuses.
 *
 * The 404 it answers is a body the screen INVENTS, so it carries the core's
 * envelope — `{error, message}` since t255, `{erro, mensagem}` before it, which
 * is the same drift `proxy.ts`'s three refusals had.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { jsonResponse, type ProxiedResponse } from './proxy.ts';

/** Directory served as-is to the browser. */
export const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

/** File served for the inbox's own entry path. */
export const INDEX_FILE = 'index.html';

/**
 * The inbox's own entry path, since t402.
 *
 * It used to be the root. The root is now the check page — a rendered view — and
 * the router tries a file BEFORE a view, so a resolver that kept answering for
 * `/` would keep serving `index.html` over a page that exists. Moving the
 * mapping here is the whole of that swap: nothing about the document changes,
 * and its `./style.css` / `./inbox.js` survive it, because `/` and `/inbox`
 * resolve to the same base directory for a relative URL.
 *
 * Nothing redirects the old address (D20's precedent): nothing here is public
 * yet, so a path does not move, it simply is somewhere else.
 */
export const INDEX_PATH = '/inbox';

/** Content types of what the page is made of; anything else is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * `cache-control` for every static file (t484): cacheable, but a browser must
 * revalidate before reusing a copy — never `no-store` (that would defeat the
 * caching this file exists to allow) and never a bare `max-age` (that would
 * let a stale copy survive without ever checking back). Pairs with the
 * `ETag`/`If-None-Match` exchange below, the one validator that makes
 * revalidation cheap: a match answers `304` with no body at all.
 */
export const STATIC_CACHE_CONTROL = 'no-cache';

/**
 * A content-derived validator for `bytes`: a quoted hex digest, so it changes
 * the instant the file's bytes do and stays stable otherwise. sha1 is plenty
 * for a cache validator (this is not a security boundary) and needs no new
 * dependency — `node:crypto` is already in the runtime.
 *
 * @param bytes File contents to derive the tag from.
 * @returns A quoted ETag value, ready to compare against `If-None-Match`.
 */
function etagFor(bytes: Buffer): string {
  return `"${createHash('sha1').update(bytes).digest('hex')}"`;
}

/**
 * Resolves a request path to a file inside `PUBLIC_DIR`.
 *
 * Returns `null` for anything that escapes the directory or has an extension
 * the page is not made of — and, since the screen gained server-rendered
 * routes, that `null` is also what hands `/executions` and `/jobs/7` over
 * to the renderer instead of 404-ing them as missing files.
 *
 * @param pathname Path from the request, already without the query.
 * @returns Absolute path of the file, or `null`.
 */
export function resolveStaticFile(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  // Only the exact path, never a prefix of it: `/inbox.js` is the page's own
  // module and has to keep resolving to itself.
  const relative = decoded === INDEX_PATH ? INDEX_FILE : decoded.replace(/^\/+/, '');
  const absolute = path.resolve(PUBLIC_DIR, relative);
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  if (!Object.hasOwn(CONTENT_TYPES, path.extname(absolute))) return null;

  return absolute;
}

/**
 * Serves one static file, or the 404 of a page that does not exist.
 *
 * Every `200` carries an `ETag` derived from the file's bytes and a
 * `cache-control` that permits caching but forces revalidation (t484) — the
 * design t458 moved onto this path assumed for free, and did not get: a
 * browser holding a copy from before that ticket had no validator to check
 * and no freshness directive to obey, so it kept the old design under
 * heuristic caching. When `requestHeaders`' `if-none-match` matches the
 * computed tag exactly, the file's bytes are skipped entirely and a `304`
 * goes back instead, with no `content-type` since there is no body to type.
 *
 * @param pathname Path from the request, already without the query.
 * @param requestHeaders The incoming request's headers, for `if-none-match`.
 *   Defaults to `{}` so every call site that predates conditional requests
 *   keeps compiling and behaving exactly as it did before.
 * @returns The response to write back.
 */
export async function serveStatic(
  pathname: string,
  requestHeaders: NodeJS.Dict<string | string[]> = {},
): Promise<ProxiedResponse> {
  const file = resolveStaticFile(pathname);
  if (file === null) {
    return jsonResponse(404, {
      error: 'file_not_found',
      message: `the screen does not serve "${pathname}"`,
    });
  }

  try {
    const body = await readFile(file);
    const etag = etagFor(body);

    if (requestHeaders['if-none-match'] === etag) {
      return {
        status: 304,
        headers: { etag, 'cache-control': STATIC_CACHE_CONTROL },
        body: Buffer.alloc(0),
      };
    }

    return {
      status: 200,
      headers: {
        'content-type': CONTENT_TYPES[path.extname(file)],
        etag,
        'cache-control': STATIC_CACHE_CONTROL,
      },
      body,
    };
  } catch {
    return jsonResponse(404, {
      error: 'file_not_found',
      message: `the screen does not serve "${pathname}"`,
    });
  }
}
