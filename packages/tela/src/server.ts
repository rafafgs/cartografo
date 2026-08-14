/**
 * The screen's own HTTP server: static page in front, proxy behind.
 *
 * Two jobs, and nothing else. It serves `src/public/` (an HTML page and three
 * native ES modules — no bundler, no framework, no build step) and forwards
 * `/v1/*` to the control plane. Everything the page knows about the system it
 * learns from the public API, over the same origin it was loaded from.
 *
 * There is no database here, no import from `packages/core`, and no SQLite
 * driver in this package's manifest: the D11 boundary is the reason this
 * package exists, and `test/no-privileged-access.test.ts` keeps it honest.
 *
 * Startup mirrors the control plane's: resolve the configuration, listen, print
 * one JSON readiness line to stdout. A supervisor — or a person with two
 * terminals open — should be able to tell the screen is up, on which port, and
 * against which control plane, from that single line.
 */

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';

import {
  API_PREFIX,
  forwardRequest,
  jsonResponse,
  parsePortFromEnv,
  resolveControlPlaneUrl,
  type ProxiedResponse,
} from './proxy.ts';

/** Environment variable that overrides the screen's port. */
export const SCREEN_PORT_ENV = 'CARTOGRAFO_TELA_PORT';

/** Default screen port — the control plane's 4317, plus one. */
export const DEFAULT_SCREEN_PORT = 4318;

/**
 * Listening address. Loopback, like the control plane: the screen has no
 * authentication (`t124`) and proxies to the only writer in the system, so
 * exposing it on an external interface is a decision for the ticket that brings
 * authorization, not for this one.
 */
export const SCREEN_HOST = '127.0.0.1';

/** Name of the readiness event printed on stdout, next to `cartografo.pronto`. */
export const READY_EVENT = 'cartografo.tela.pronta';

/** Directory served as-is to the browser. */
export const PUBLIC_DIR = path.resolve(import.meta.dirname, 'public');

/** File served for `/`. */
export const INDEX_FILE = 'index.html';

/** Content types of what the page is made of; anything else is not served. */
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The screen, up. */
export interface Screen {
  server: Server;
  /** Base URL of the screen itself. */
  url: string;
  /** Port actually bound (relevant when the configured port is `0`). */
  port: number;
  /** Control plane this screen proxies to. */
  controlPlaneUrl: string;
  /** Stops listening. */
  close: () => Promise<void>;
}

/**
 * Resolves the screen's listening port.
 *
 * @param env Environment to read `CARTOGRAFO_TELA_PORT` from.
 * @returns A valid port.
 */
export function resolveScreenPort(env: NodeJS.ProcessEnv = process.env): number {
  return parsePortFromEnv(env, SCREEN_PORT_ENV, DEFAULT_SCREEN_PORT);
}

/** Is this path the API's, or the page's? */
function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** Reads the whole request body; the proxy forwards bytes, not a stream. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Resolves a request path to a file inside `PUBLIC_DIR`.
 *
 * Returns `null` for anything that escapes the directory or has an extension
 * the page is not made of. The screen serves five files; it is not a file
 * server, and `../../.cartografo/cartografo.db` is exactly the request this
 * refuses to answer.
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

/** Serves one static file, or the 404 of a page that does not exist. */
async function serveStatic(pathname: string): Promise<ProxiedResponse> {
  const file = resolveStaticFile(pathname);
  if (file === null) {
    return jsonResponse(404, {
      erro: 'arquivo_nao_encontrado',
      mensagem: `a tela não serve "${pathname}"`,
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
      mensagem: `a tela não serve "${pathname}"`,
    });
  }
}

/**
 * Handles one request: proxy if it is the API's, static file otherwise.
 *
 * @param request Incoming request.
 * @param controlPlaneUrl Where `/v1/*` goes.
 * @returns The response to write back.
 */
async function handle(
  request: IncomingMessage,
  controlPlaneUrl: string,
): Promise<ProxiedResponse> {
  const target = request.url ?? '/';
  // A base is required to parse a relative target; it is thrown away right
  // after, because what travels upstream is the original `target` string.
  const { pathname } = new URL(target, 'http://tela.invalid');

  if (!isApiPath(pathname)) return await serveStatic(pathname);

  return await forwardRequest(controlPlaneUrl, {
    method: request.method ?? 'GET',
    target,
    headers: request.headers,
    body: await readBody(request),
  });
}

/**
 * Builds the HTTP server without listening.
 *
 * @param controlPlaneUrl Control plane base URL.
 * @returns A server ready to `listen`.
 */
export function createScreenServer(controlPlaneUrl: string): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, controlPlaneUrl)
      .catch((causa: unknown) =>
        // Nothing here should throw; if it does, the browser gets the same
        // `erro`/`mensagem` shape as everything else, never a hanging socket.
        jsonResponse(500, {
          erro: 'falha_na_tela',
          mensagem: causa instanceof Error ? causa.message : 'erro inesperado na tela',
        }),
      )
      .then((resultado) => {
        response.writeHead(resultado.status, resultado.headers);
        response.end(resultado.body);
      });
  });
}

/**
 * Starts the screen.
 *
 * @param env Environment with `CARTOGRAFO_TELA_PORT` and `CARTOGRAFO_URL`.
 * @returns The screen, up, with what it takes to shut it down.
 */
export async function startScreen(env: NodeJS.ProcessEnv = process.env): Promise<Screen> {
  const controlPlaneUrl = resolveControlPlaneUrl(env);
  const port = resolveScreenPort(env);
  const server = createScreenServer(controlPlaneUrl);

  const bound = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, SCREEN_HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`a tela não conseguiu escutar em ${SCREEN_HOST}:${port}`));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    server,
    url: `http://${SCREEN_HOST}:${bound}`,
    port: bound,
    controlPlaneUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((erro) => (erro === undefined ? resolve() : reject(erro)));
      });
    },
  };
}

/**
 * Entry point of `npm start --workspace @cartografo/tela`.
 *
 * Prints one JSON readiness line, in the same spirit as `cartografo.pronto`:
 * where the screen is, and which control plane it is showing.
 */
export async function main(): Promise<void> {
  const screen = await startScreen();

  process.stdout.write(
    `${JSON.stringify({
      evento: READY_EVENT,
      url: screen.url,
      control_plane: screen.controlPlaneUrl,
    })}\n`,
  );

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void screen
        .close()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}

if (import.meta.filename === process.argv[1]) {
  main().catch((causa: unknown) => {
    process.exitCode = 1;
    process.stderr.write(
      `cartografo-tela: ${causa instanceof Error ? causa.message : String(causa)}\n`,
    );
  });
}
