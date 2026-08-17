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
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { jsonResponse, type ProxiedResponse } from './proxy.ts';

/** Directory served as-is to the browser. */
export const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

/** File served for the inbox's own entry path. */
export const INDEX_FILE = 'index.html';

/** Content types of what the page is made of; anything else is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

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

  const relative = decoded === '/' || decoded === '' ? INDEX_FILE : decoded.replace(/^\/+/, '');
  const absolute = path.resolve(PUBLIC_DIR, relative);
  if (absolute !== PUBLIC_DIR && !absolute.startsWith(`${PUBLIC_DIR}${path.sep}`)) return null;
  if (!Object.hasOwn(CONTENT_TYPES, path.extname(absolute))) return null;

  return absolute;
}

/**
 * Serves one static file, or the 404 of a page that does not exist.
 *
 * @param pathname Path from the request, already without the query.
 * @returns The response to write back.
 */
export async function serveStatic(pathname: string): Promise<ProxiedResponse> {
  const file = resolveStaticFile(pathname);
  if (file === null) {
    return jsonResponse(404, {
      erro: 'arquivo_nao_encontrado',
      mensagem: `the screen does not serve "${pathname}"`,
    });
  }

  try {
    return {
      status: 200,
      headers: { 'content-type': CONTENT_TYPES[path.extname(file)] },
      body: await readFile(file),
    };
  } catch {
    return jsonResponse(404, {
      erro: 'arquivo_nao_encontrado',
      mensagem: `the screen does not serve "${pathname}"`,
    });
  }
}
