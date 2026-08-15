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
 *
 * ## Nothing a request does may end the process (t151)
 *
 * The handler runs inside a floating async call: nobody awaits it, so a
 * rejection in there reaches no `catch` at all, and since Node 15 an unhandled
 * rejection kills the process. One tab dropping an upload mid-body would take
 * both halves of D11 down for every other tab — which is exactly what happened
 * before this became one outer `try/catch` around the whole handler.
 *
 * So the discipline here is in two layers, and the second one is not a
 * substitute for the first:
 *
 * 1. the handler catches EVERYTHING and turns it into an answer, a closed
 *    socket, and a line on stderr — `ClientAbortedError` is the label for the
 *    case where there is no longer anyone to answer;
 * 2. `installCrashGuard` is the last line of defence for whatever still escapes
 *    the process, installed by the two ENTRY POINTS only, never by
 *    `createScreenRouter` — a listener registered on import would leak from one
 *    test file into the next, and every test in this package starts the screen
 *    in process.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ApiClient, ApiError, NetworkError } from './client.ts';
import {
  API_PREFIX,
  forwardRequest,
  resolveControlPlaneToken,
  type ProxiedResponse,
} from './proxy.ts';
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

/**
 * Listening address. Loopback, and it stays loopback even now that the control
 * plane authenticates (t124): the screen takes no credential from the browser,
 * so its own port is the boundary. `CARTOGRAFO_HOST` moves the control plane,
 * not this.
 */
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
 * The client went away before the screen finished reading its request (t151).
 *
 * A type of its own because this is NOT a failure of the screen and must never
 * be diagnosed as one: `for await (const chunk of request)` rejects with a raw
 * `Error: aborted` (`code: ECONNRESET`) that says nothing about who gave up,
 * and an unlabelled rejection in the request handler is what used to end the
 * process. Labelled, it becomes what it is — a connection that died — logged
 * once and dropped.
 */
export class ClientAbortedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientAbortedError';
  }
}

/** One line about a failure, for stderr: name and message, never a stack. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Keeps the screen alive when a rejection escapes every `catch` in the way.
 *
 * Node's default since v15 is to end the process on an unhandled rejection.
 * For a CLI that is right; for a server that both halves of D11 share, it means
 * one bad request closing the screen for everyone — so here the rejection is
 * logged and the screen keeps serving. It is a net under the handler's own
 * `try/catch`, not a replacement for it: whatever lands here is a bug to fix at
 * the source, and the stderr line is how it gets found.
 *
 * Called by the ENTRY POINTS only (`runScreenCli`, and `main` in `server.ts`),
 * never on import: a process-wide listener installed by `createScreenRouter`
 * would follow the test runner from one file into the next.
 *
 * @returns A function that removes the listener again.
 */
export function installCrashGuard(): () => void {
  const guard = (reason: unknown): void => {
    process.stderr.write(`cartografo-tela: unhandled rejection — ${describeError(reason)}\n`);
  };

  process.on('unhandledRejection', guard);
  return () => {
    process.off('unhandledRejection', guard);
  };
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

  try {
    for await (const chunk of request) {
      const block = chunk as Buffer;
      size += block.length;
      if (size > BODY_LIMIT) throw new UsageError('formulário grande demais');
      chunks.push(block);
    }
  } catch (cause) {
    // The ceiling is this screen refusing a body it does not want, and it keeps
    // saying so with a 400. Anything else coming out of the iteration is the
    // connection dying underneath it.
    if (cause instanceof UsageError) throw cause;
    throw new ClientAbortedError('o formulário parou de chegar no meio', { cause });
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A route's answer: a page, or a redirect. */
type RouteResult = Page | { redirect: string };

/**
 * Turns an API failure into a page, without inventing success.
 *
 * The translations, and why each one:
 * - **an API 404 becomes a screen 404** — the entity does not exist, and lying
 *   here would hide the one case where the user typed the wrong address;
 * - **any other control plane error becomes a 502** — the one that failed is
 *   the server behind, and the browser needs to know it was not itself;
 * - **not reaching the control plane becomes a 502 with the command that fixes
 *   it** — this screen's characteristic failure is being opened with no control
 *   plane running;
 * - **a client that gave up becomes a 499** — nginx's "client closed request",
 *   and nobody will ever read it, because the socket that would receive it is
 *   precisely the one that died. It exists so that the translation is TOTAL:
 *   every error the handler can catch has a page here, including the one whose
 *   page is never delivered (t151).
 */
export function failurePage(error: unknown, controlPlaneUrl: string): Page {
  if (error instanceof ClientAbortedError) {
    return errorPage(
      499,
      'cliente desconectado',
      'A conexão caiu antes de a tela terminar de ler o pedido. Nada foi alterado.',
    );
  }
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
  /**
   * Credential presented to the control plane (t124, FR7). Default:
   * `resolveControlPlaneToken`'s precedence — `CARTOGRAFO_TELA_TOKEN` first,
   * `CARTOGRAFO_TOKEN` after.
   */
  token?: string;
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
  try {
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
  } catch (cause) {
    throw new ClientAbortedError('o corpo do pedido parou de chegar no meio', { cause });
  }
  return Buffer.concat(chunks);
}

/**
 * Last stop of a request that failed: log it, then answer it or hang up.
 *
 * The order matters. The log comes FIRST and unconditionally, because the
 * common case is that there is no longer anyone to answer — without this line,
 * an aborted upload would be indistinguishable from a request that never
 * arrived. Only then does it try to answer, and only while the answer can still
 * go anywhere: after `writeHead` there is a status the browser already read,
 * and writing a second one over it would corrupt the response instead of
 * explaining it.
 *
 * @param error What the handler threw.
 * @param response The response, which may already be half written or dead.
 * @param controlPlaneUrl Control plane, for the message `failurePage` writes.
 */
function reportRequestFailure(
  error: unknown,
  response: ServerResponse,
  controlPlaneUrl: string,
): void {
  process.stderr.write(`cartografo-tela: pedido falhou — ${describeError(error)}\n`);

  if (response.headersSent || response.writableEnded || response.destroyed) {
    response.destroy();
    return;
  }

  // Writing to a socket the client already dropped must not become the NEXT
  // crash: the stream can report the failure asynchronously, and an `error`
  // event with no listener is an uncaught exception — the same bug one layer
  // down.
  response.on('error', () => undefined);

  try {
    const page = failurePage(error, controlPlaneUrl);
    response.writeHead(page.status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(page.html);
  } catch {
    response.destroy();
  }
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
  const token = options.token ?? resolveControlPlaneToken();
  const client = new ApiClient({ baseUrl: controlPlaneUrl, token, doFetch: options.doFetch });

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      // Nobody awaits this call, so this `try` is the only thing between a
      // failed request and the end of the process (t151). It covers the URL
      // parsing too: `new URL` throws on a request target the browser is free
      // to send, and it throws before there is any branch to blame.
      try {
        const target = request.url ?? '/';
        const { pathname } = new URL(target, 'http://tela.local');

        // 1. The API belongs to the control plane; the screen only forwards it.
        if (isApiPath(pathname)) {
          const forwarded: ProxiedResponse = await forwardRequest(
            controlPlaneUrl,
            {
              method: request.method ?? 'GET',
              target,
              headers: request.headers,
              body: await readBody(request),
            },
            { doFetch: options.doFetch, token },
          );
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
          // A dead client is not a page. It goes up to the guard, which logs it
          // and hangs up — rendering HTML for a socket nobody is holding would
          // spend the failure without telling anyone it happened.
          if (error instanceof ClientAbortedError) throw error;
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
      } catch (error) {
        reportRequestFailure(error, response, controlPlaneUrl);
      }
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
 * This is one of the two places `installCrashGuard` is installed (the other is
 * `main` in `server.ts`): a process that is going to stay up serving strangers
 * is exactly where Node's "die on an unhandled rejection" is the wrong default.
 *
 * @param args Arguments after the command name.
 * @param env Environment to read the configuration from.
 */
export async function runScreenCli(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  installCrashGuard();

  const screen = await startScreenRouter({
    controlPlaneUrl: resolveControlPlaneAddress(urlFromArgs(args), env),
    token: resolveControlPlaneToken(env),
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
