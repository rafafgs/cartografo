/**
 * The screen's router (t107, FR4) — and the single door into both its halves.
 *
 * Plain `node:http`, no runtime dependency. This is the ONLY module that knows
 * the control plane's address — everything else receives an `ApiClient` already
 * pointed at it — and it is also the only one that knows about inbound HTTP:
 * `pages.ts` returns `{status, html}` and does not know a `ServerResponse`
 * exists.
 *
 * **The two halves of D11 share this server.** The proposal inbox (`t111`) is a
 * static page plus a same-origin proxy; observability (`t107`) is rendered on
 * the server. They live in the same package on the same port, so a single
 * handler decides between them, in this order:
 *
 * | Path | Who answers |
 * |---|---|
 * | `/v1/*` | verbatim proxy to the control plane (`proxy.ts`) |
 * | a file from `src/public/` (`/`, `/inbox.js`, `/style.css`, …) | `static.ts` |
 * | anything else | the views rendered here (`/quadro`, `/execucoes`, …) |
 *
 * The order is the contract: the proxy comes first because `/v1` belongs to the
 * API and not to the screen; static comes before rendering because
 * `resolveStaticFile` only returns a path for a known extension, and it is
 * precisely its `null` that hands `/execucoes` and `/trabalhos/7` to the views
 * instead of 404-ing them as a missing file.
 *
 * The D11 boundary reads whole here: no import from `packages/core`, no
 * database driver, no file path. The screen starts on another port, in another
 * process, and can die without the control plane noticing — that is the proof,
 * and not just the promise, that it is one more client of the public API.
 *
 * The route paths stay in Portuguese: they are the product's own URL surface,
 * and changing one would be a route change rather than a rename (t133, AC3).
 *
 * Control plane address precedence, the same as the core's CLI
 * (`packages/core/src/cli/url.ts`): `--url` > `CARTOGRAFO_URL` >
 * `http://127.0.0.1:4317`. That way whoever starts the control plane on another
 * port does not have to repeat the configuration in two different vocabularies.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ApiClient, ApiError, NetworkError } from './client.ts';
import { API_PREFIX, forwardRequest, type ProxiedResponse } from './proxy.ts';
import { resolveStaticFile, serveStatic } from './static.ts';
import {
  DEFAULT_ANSWERED_BY,
  boardPage,
  errorPage,
  executionPage,
  executionsPage,
  jobPage,
  questionsPage,
  type Page,
} from './pages.ts';

/** Default screen port. Next door to the control plane's, and never the same. */
export const DEFAULT_PORT = 4318;

/** Environment variable that overrides the screen's port. */
export const PORT_ENV = 'CARTOGRAFO_TELA_PORT';

/** Environment variable that points at the control plane (the CLI's own). */
export const URL_ENV = 'CARTOGRAFO_URL';

/** Default control plane address. */
export const DEFAULT_CONTROL_PLANE_URL = 'http://127.0.0.1:4317';

/** Listening address. Loopback, like the control plane: there is no auth (t124). */
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Name of the readiness event printed on stdout.
 *
 * One for the whole package, and it is `t111`'s, which arrived first: the two
 * halves of the screen are ONE process on ONE port, so two different readiness
 * lines depending on the entry point would be the same screen lying about
 * itself to whoever supervises it. `server.ts` re-exports it.
 *
 * It follows `packages/core/src/index.ts`'s `cartografo.ready` pattern (t133,
 * rule 2).
 */
export const READY_EVENT = 'cartografo.tela.ready';

/** A form body larger than this is refused without being read whole. */
const BODY_LIMIT = 64 * 1024;

/** A command usage error — becomes a message, never a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * Resolves the port the screen listens on.
 *
 * @param env Environment to read `CARTOGRAFO_TELA_PORT` from.
 * @returns A valid port.
 */
export function screenPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const configured = env[PORT_ENV]?.trim();
  if (configured === undefined || configured === '') return DEFAULT_PORT;

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`${PORT_ENV} inválida: "${configured}" (esperado um inteiro de 0 a 65535)`);
  }
  return port;
}

/**
 * Resolves the control plane's address.
 *
 * @param option Value of `--url`, when it came on the command line.
 * @param env Environment to read `CARTOGRAFO_URL` from.
 * @returns Base URL with no trailing slash.
 */
export function resolveControlPlaneAddress(
  option?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = env[URL_ENV]?.trim();
  const chosen =
    option !== undefined && option.trim() !== ''
      ? option.trim()
      : fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : DEFAULT_CONTROL_PLANE_URL;

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new UsageError(`URL inválida: "${chosen}" (esperado algo como ${DEFAULT_CONTROL_PLANE_URL})`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`URL precisa ser http ou https: "${chosen}"`);
  }
  return chosen.replace(/\/+$/, '');
}

/** Reads a route `:id` as a positive integer; `null` when it is not one. */
function routeId(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Reads a form body, with a ceiling. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const block = chunk as Buffer;
    size += block.length;
    if (size > BODY_LIMIT) throw new UsageError('formulário grande demais');
    chunks.push(block);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A route's answer: a page, or a redirect. */
type RouteResult = Page | { redirect: string };

/**
 * Turns an API failure into a page, without inventing success.
 *
 * The three translations, and why each one:
 * - **an API 404 becomes a screen 404** — the entity does not exist, and lying
 *   here would hide the one case where the user typed the wrong address;
 * - **any other control plane error becomes a 502** — the one that failed is
 *   the server behind, and the browser needs to know it was not itself;
 * - **not reaching the control plane becomes a 502 with the command that fixes
 *   it** — this screen's characteristic failure is being opened with no control
 *   plane running.
 */
function failurePage(error: unknown, controlPlaneUrl: string): Page {
  if (error instanceof NetworkError) {
    return errorPage(
      502,
      'control plane fora do ar',
      `Não deu para falar com ${controlPlaneUrl}. Rode \`npx cartografo\` em outro terminal (ou aponte outro endereço com --url).`,
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return errorPage(404, 'não encontrado', 'O control plane não conhece este endereço.');
    }
    return errorPage(
      502,
      'o control plane recusou',
      `${error.message}. Nada foi alterado por esta tela.`,
    );
  }
  if (error instanceof UsageError) return errorPage(400, 'pedido inválido', error.message);
  return errorPage(500, 'erro na tela', 'Algo quebrou ao montar esta página.');
}

/**
 * Decides which view answers a request.
 *
 * @param client Client of the public API, already pointed at the control plane.
 * @param request The raw request.
 * @returns The page, or the redirect target.
 */
async function route(client: ApiClient, request: IncomingMessage): Promise<RouteResult> {
  const pathname = new URL(request.url ?? '/', 'http://tela.local').pathname.replace(/\/+$/, '');
  const method = request.method ?? 'GET';

  if (method === 'GET') {
    // `/quadro`, and not `/`: the root belongs to the proposal inbox (t111),
    // which was already this package's static `index.html` when this half
    // arrived. The two halves link to each other through the navigation;
    // neither disappears.
    if (pathname === '/quadro') return await boardPage(client);
    if (pathname === '/execucoes') return await executionsPage(client);
    if (pathname === '/perguntas') return await questionsPage(client);

    const executionMatch = /^\/execucoes\/([^/]+)$/.exec(pathname);
    if (executionMatch !== null) {
      const id = routeId(executionMatch[1]);
      return id === null
        ? errorPage(404, 'execução inválida', 'O id de uma execução é um inteiro.')
        : await executionPage(client, id);
    }

    const jobMatch = /^\/trabalhos\/([^/]+)$/.exec(pathname);
    if (jobMatch !== null) {
      const id = routeId(jobMatch[1]);
      return id === null
        ? errorPage(404, 'trabalho inválido', 'O id de um trabalho é um inteiro.')
        : await jobPage(client, id);
    }
  }

  if (method === 'POST') {
    const answerMatch = /^\/perguntas\/([^/]+)\/resposta$/.exec(pathname);
    if (answerMatch !== null) {
      const id = routeId(answerMatch[1]);
      if (id === null) {
        return errorPage(404, 'pergunta inválida', 'O id de uma pergunta é um inteiro.');
      }
      return await submitAnswer(client, id, request);
    }
  }

  return errorPage(404, 'página não encontrada', `Não existe ${pathname === '' ? '/' : pathname}.`);
}

/**
 * `POST /perguntas/:id/resposta` — the screen's only write (FR9).
 *
 * It writes to the control plane FOR REAL and redirects (303) to the queue,
 * which is reloaded from the API. The question disappears because the state
 * changed, not because the form hid it — and that difference is what the
 * acceptance test demands, with an independent read against the control plane
 * after the submit.
 *
 * A blank answer is refused here, before the network: the event schema accepts
 * an empty string, and recording a `pergunta.respondida` with no content would
 * pollute the audit trail with a fact that decides nothing.
 */
async function submitAnswer(
  client: ApiClient,
  questionId: number,
  request: IncomingMessage,
): Promise<RouteResult> {
  const fields = await readForm(request);
  const answer = (fields.get('resposta') ?? '').trim();
  if (answer === '') {
    return errorPage(
      400,
      'resposta em branco',
      'Escreva a resposta (ou clique numa das opções) antes de enviar.',
    );
  }

  const answeredBy = (fields.get('respondido_por') ?? '').trim();
  await client.answerQuestion(
    questionId,
    answer,
    answeredBy === '' ? DEFAULT_ANSWERED_BY : answeredBy,
  );

  // 303 and not 302: after a POST the way back is a GET — that is what stops
  // the browser from resending the answer when someone reloads the page.
  return { redirect: '/perguntas' };
}

/** The screen, up. */
export interface RunningScreen {
  server: Server;
  /** Base URL of the screen. */
  url: string;
  /** Control plane it reads. */
  controlPlaneUrl: string;
  close: () => Promise<void>;
}

/** Startup options for the screen. */
export interface ScreenOptions {
  /** Control plane to read. Default: `resolveControlPlaneAddress`'s precedence. */
  controlPlaneUrl?: string;
  /** Listening port. `0` asks the system for a free one (test use). */
  port?: number;
  /** Listening address. */
  host?: string;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
}

/** Is this path the API's, or the screen's? */
function isApiPath(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** Reads a request's whole body; the proxy forwards bytes, not a stream. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

/**
 * Creates the server of both halves, without listening.
 *
 * The order of the three decisions is the contract described in this file's
 * header: API, file, view. Nothing here invents success — a failure while
 * building the page becomes `failurePage`, and a failure to reach the control
 * plane becomes the answer `proxy.ts` writes itself.
 *
 * @param options Control plane and `fetch` to use.
 * @returns A server ready to `listen`.
 */
export function createScreenRouter(options: ScreenOptions = {}): Server {
  const controlPlaneUrl = options.controlPlaneUrl ?? resolveControlPlaneAddress();
  const client = new ApiClient({ baseUrl: controlPlaneUrl, doFetch: options.doFetch });

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const target = request.url ?? '/';
      const { pathname } = new URL(target, 'http://tela.local');

      // 1. The API belongs to the control plane; the screen only forwards it.
      if (isApiPath(pathname)) {
        const forwarded: ProxiedResponse = await forwardRequest(controlPlaneUrl, {
          method: request.method ?? 'GET',
          target,
          headers: request.headers,
          body: await readBody(request),
        });
        response.writeHead(forwarded.status, forwarded.headers);
        response.end(forwarded.body);
        return;
      }

      // 2. A file from `src/public/` — the inbox page and its modules.
      if (resolveStaticFile(pathname) !== null) {
        const file = await serveStatic(pathname);
        response.writeHead(file.status, file.headers);
        response.end(file.body);
        return;
      }

      // 3. What is left is a view rendered here.
      let result: RouteResult;
      try {
        result = await route(client, request);
      } catch (error) {
        result = failurePage(error, controlPlaneUrl);
      }

      if ('redirect' in result) {
        response.writeHead(303, { location: result.redirect });
        response.end();
        return;
      }

      response.writeHead(result.status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(result.html);
    })();
  });
}

/**
 * Starts the screen.
 *
 * @param options Control plane, port and host.
 * @returns The screen, up, with what it takes to shut it down.
 */
export async function startScreenRouter(options: ScreenOptions = {}): Promise<RunningScreen> {
  const controlPlaneUrl = options.controlPlaneUrl ?? resolveControlPlaneAddress();
  const host = options.host ?? DEFAULT_HOST;
  const server = createScreenRouter({ ...options, controlPlaneUrl });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? screenPortFromEnv(), host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = address !== null && typeof address !== 'string' ? address.port : 0;

  return {
    server,
    url: `http://${host}:${port}`,
    controlPlaneUrl,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Reads `--url <address>` from the arguments.
 *
 * @param args Arguments after the command name.
 * @returns The address asked for, or `undefined`.
 */
export function urlFromArgs(args: string[]): string | undefined {
  const index = args.indexOf('--url');
  if (index === -1) {
    const inline = args.find((argument) => argument.startsWith('--url='));
    return inline?.slice('--url='.length);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) throw new UsageError('--url exige um endereço');
  return value;
}

/**
 * Entry point of the `cartografo-tela` command.
 *
 * Prints one JSON readiness line on stdout — the same contract as the control
 * plane's startup, so that a supervisor (or a test) knows the screen is up and
 * against which control plane.
 *
 * @param args Arguments after the command name.
 * @param env Environment to read the configuration from.
 */
export async function runScreenCli(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const screen = await startScreenRouter({
    controlPlaneUrl: resolveControlPlaneAddress(urlFromArgs(args), env),
    port: screenPortFromEnv(env),
  });

  process.stdout.write(
    `${JSON.stringify({
      event: READY_EVENT,
      url: screen.url,
      controlPlane: screen.controlPlaneUrl,
    })}\n`,
  );

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void screen
        .close()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}
