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
 * **One thing this handler decides before forwarding anything (t192):** whether
 * a WRITE came from this screen's own page. Everything it forwards carries the
 * operator's credential (t124), so a proxy that forwards indiscriminately hands
 * that credential to any page open in the same browser. `isTrustedScreenOrigin`
 * is the gate, it runs here and not inside `forwardRequest` — which stays a dumb
 * pipe — and the only two doors it covers are the ones that write: `/v1/*` with
 * a method other than `GET`/`HEAD`, and the answer form below.
 *
 * **And one more, for the same reason (t206):** how much of a body it agrees to
 * hold. The proxy forwards bytes and not a stream, so it buffers the whole body
 * before deciding anything — and `PROXY_BODY_LIMIT` is what stops whoever
 * reaches this loopback port from choosing that number. Both checks live on this
 * side of the pipe, and both refuse without the control plane ever learning the
 * request existed.
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
 * `http://127.0.0.1:CARTOGRAFO_PORT` > `http://127.0.0.1:4317`. That way whoever
 * starts the control plane on another port does not have to repeat the
 * configuration in two different vocabularies. Since t199 (FR6) this file no
 * longer resolves it itself: `proxy.ts`'s `resolveControlPlaneUrl` is the single
 * resolver, and the `--url` flag reaches it as the explicit override. The two
 * used to be separate functions, and the one the command actually ran was the
 * one that dropped `CARTOGRAFO_PORT` on the floor.
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
  bodyTooLargeResponse,
  forwardRequest,
  isTrustedScreenOrigin,
  parsePortFromEnv,
  resolveControlPlaneToken,
  resolveControlPlaneUrl,
  untrustedOriginResponse,
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
  runnersPage,
  type Page,
} from './pages.ts';

/** Default screen port. Next door to the control plane's, and never the same. */
export const DEFAULT_PORT = 4318;

/** Environment variable that overrides the screen's port. */
export const PORT_ENV = 'CARTOGRAFO_TELA_PORT';

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

/**
 * A `/v1/*` body larger than this is refused before anything is forwarded (t206).
 *
 * 1 MiB, which is Fastify's own default and therefore the control plane's:
 * `packages/core/src/server.ts` builds the server without overriding
 * `bodyLimit`, and the single route that raises it — `PATCH /sessions/:id/finish`,
 * at 32 MiB — is dispatched by the runner and never by this screen's page. So
 * this ceiling refuses nothing the core would have accepted through a door a
 * browser tab can reach through here.
 *
 * Separate from `BODY_LIMIT` on purpose, and an order of magnitude above it: the
 * form is this screen's own surface with one small field in it, this is a pipe
 * to somebody else's API, and one number for both would tie the screen's copy of
 * the core's limit to a decision about a text area.
 */
export const PROXY_BODY_LIMIT = 1_048_576;

/**
 * Methods that change nothing upstream, and are therefore not gated (t192).
 *
 * `OPTIONS` is deliberately NOT in here. It changes nothing either, but no page
 * of this screen ever sends one, and the gate's default is to refuse: a
 * cross-site preflight then dies against this screen's 403 instead of against
 * the control plane's answer, which is the same dead end seen from the browser
 * and one request less that the core has to answer for a stranger.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

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

/**
 * The client sent more than the proxy is willing to hold in memory (t206).
 *
 * A type of its own, and deliberately NOT a `ClientAbortedError`, because the
 * two say opposite things about how the request ended: one client gave up, the
 * other sent too much. They meet the same `catch` blocks and land on the same
 * stderr line, so collapsing them would make the ceiling invisible in the one
 * place it can be observed — and would diagnose a refusal by this screen as a
 * connection that died.
 */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadTooLargeError';
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
 * Delegates to `parsePortFromEnv`, which `server.ts` already uses for the same
 * variable (t199, FR6): two readers of `CARTOGRAFO_TELA_PORT` that refuse a bad
 * value with two different messages, one of them in Portuguese, is the same
 * split this ticket closes on the control plane's address.
 *
 * @param env Environment to read `CARTOGRAFO_TELA_PORT` from.
 * @returns A valid port.
 */
export function screenPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parsePortFromEnv(env, PORT_ENV, DEFAULT_PORT);
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
    if (pathname === '/runners') return await runnersPage(client);

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
      // The same gate the proxy gets (t192), and for the same reason: this is a
      // same-site form post, so a form on any other page can aim at it. It comes
      // before the id is even read — a request from elsewhere gets one answer,
      // and not a 404 that tells it which ids exist.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'origem não confiável',
          'Este formulário só aceita envios que começaram nesta página. Recarregue e tente de novo.',
        );
      }

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
  /** Control plane to read. Default: `resolveControlPlaneUrl`'s precedence. */
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

/**
 * Reads a request's whole body, with a ceiling; the proxy forwards bytes, not a
 * stream.
 *
 * The ceiling is checked AS the body arrives, the same shape `readForm` uses
 * above, and not on what was read: the whole point of a limit is that the bytes
 * past it are never held, and a read-then-check would have already buffered
 * everything it then refuses.
 *
 * @param request The request being read.
 * @param limit Bytes this screen is willing to hold before refusing.
 * @returns The body, whole.
 */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      const block = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += block.length;
      if (size > limit) throw new PayloadTooLargeError(`corpo maior que ${limit} bytes`);
      chunks.push(block);
    }
  } catch (cause) {
    // The ceiling is this screen refusing a body it does not want, and it keeps
    // saying so. Anything else out of the iteration is the connection dying
    // underneath it.
    if (cause instanceof PayloadTooLargeError) throw cause;
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
  const controlPlaneUrl = options.controlPlaneUrl ?? resolveControlPlaneUrl();
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
          const method = (request.method ?? 'GET').toUpperCase();

          // …but not a WRITE that started on someone else's page (t192). The
          // gate runs here, before the body is even read, so a refused request
          // costs nothing and the control plane never learns it existed. Reads
          // are not gated: a `no-cors` response body is opaque to the page that
          // asked for it, so there is nothing to exfiltrate through them.
          if (
            !READ_ONLY_METHODS.has(method) &&
            !isTrustedScreenOrigin(request.headers, request.headers.host)
          ) {
            const refused = untrustedOriginResponse();
            response.writeHead(refused.status, refused.headers);
            response.end(refused.body);
            return;
          }

          // …nor a body bigger than this screen agreed to hold for somebody
          // else's API (t206). The body is read HERE, before `forwardRequest`,
          // so that the refusal happens on the same side of the pipe as the
          // origin gate above it: a request the screen will not carry must not
          // become a request the control plane has to answer.
          let body: Buffer;
          try {
            body = await readBody(request, PROXY_BODY_LIMIT);
          } catch (error) {
            // Only the ceiling is answered here. A client that vanished mid-body
            // goes up to the outer guard exactly as before — there is no longer
            // anyone holding the socket that would read this 413.
            if (!(error instanceof PayloadTooLargeError)) throw error;
            const refused = bodyTooLargeResponse(PROXY_BODY_LIMIT);
            response.writeHead(refused.status, refused.headers);
            response.end(refused.body);
            return;
          }

          const forwarded: ProxiedResponse = await forwardRequest(
            controlPlaneUrl,
            { method, target, headers: request.headers, body },
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
  const controlPlaneUrl = options.controlPlaneUrl ?? resolveControlPlaneUrl();
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
  if (value === undefined || value.startsWith('-')) throw new UsageError('--url needs an address');
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
    controlPlaneUrl: resolveControlPlaneUrl(env, urlFromArgs(args)),
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
