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
 * | anything else | the views rendered here (`/board`, `/executions`, …) |
 *
 * The order is the contract: the proxy comes first because `/v1` belongs to the
 * API and not to the screen; static comes before rendering because
 * `resolveStaticFile` only returns a path for a known extension, and it is
 * precisely its `null` that hands `/executions` and `/jobs/7` to the views
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
 * The route paths are English since t230, out of `docs/spec/glossary-wire.md`
 * §5.1. They used to be exempt for being the product's own URL surface rather
 * than an identifier (t133, AC3); D20 names `/quadro` and `/perguntas` among
 * what it moves, which supersedes that exemption for exactly these six paths.
 * Each one takes the name the API already publishes for the same entity —
 * `/input-requests` and not `/questions`, because the route behind it is
 * `GET /v1/input-requests` — and `/runners` was already there. Nothing is
 * public yet (D20), so no old path redirects: they simply do not exist.
 *
 * What did NOT move with them is the DOM/structural contract: the
 * `.quadro`/`.pergunta` class names and the `data-*` markers are what the
 * acceptance tests and the stylesheet select on, and they keep their Portuguese
 * spelling (t133, exception 10). The nav link text and the page titles used to
 * be named here too, as copy that stayed — they went English with the rest of
 * what a person reads in t310, and this file's own failure titles and details
 * went with them.
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

import { ApiClient, ApiError, NetworkError, type Settings } from './client.ts';
import {
  API_PREFIX,
  CONTROL_PLANE_URL_ENV,
  bodyTooLargeResponse,
  forwardRequest,
  isTrustedScreenOrigin,
  parsePortFromEnv,
  resolveControlPlaneToken,
  resolveControlPlaneUrl,
  resolveScreenHost,
  SCREEN_HOST_ENV,
  untrustedOriginResponse,
  type ProxiedResponse,
} from './proxy.ts';
import { resolveStaticFile, serveStatic } from './static.ts';
import {
  DEFAULT_ANSWERED_BY,
  boardPage,
  checkPage,
  errorPage,
  examplesPage,
  executionPage,
  executionsPage,
  jobPage,
  questionsPage,
  runnersPage,
  type Page,
  type ProjectScope,
} from './pages.ts';

/**
 * The cookie the project switcher writes, and the only state this screen keeps.
 *
 * D11 is unchanged by it: a cookie lives in the browser, the screen reads it
 * per request and forgets it, and nothing about the choice reaches the control
 * plane except as a `project_id` on reads the operator could already make.
 */
export const PROJECT_COOKIE = 'cartografo_project';

/**
 * The project a page shows when the cookie says nothing (t354).
 *
 * The same `1` the API defaults to, so a browser that has never touched the
 * switcher sees exactly what this screen showed before the switcher existed.
 */
export const DEFAULT_PROJECT_ID = 1;

/** Default screen port. Next door to the control plane's, and never the same. */
export const DEFAULT_PORT = 4318;

/** Environment variable that overrides the screen's port. */
export const PORT_ENV = 'CARTOGRAFO_SCREEN_PORT';

/**
 * Loopback: the default listening address, and the host of the default control
 * plane URL the usage text quotes.
 *
 * It stays loopback for the reason t124 gave — the screen takes no credential
 * from the browser, so its own port is the boundary — and `CARTOGRAFO_HOST`
 * still moves the control plane and not this. What t250 added is a knob of its
 * own, `CARTOGRAFO_SCREEN_HOST` (`resolveScreenHost`, in `proxy.ts`), for the
 * one deployment where loopback is the container's interface rather than the
 * operator's machine.
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

/**
 * What `cartografo-screen -h` answers (t248, FR7).
 *
 * The other five commands of the product all short-circuit `-h`/`--help` before
 * doing any work. This one had no `--help` handling at all: the flag fell
 * through as "no `--url`", the screen started for real, printed its readiness
 * line and then waited on a signal — so asking the command what it does meant
 * having to kill it. That is also why the whole of D23's "each bin answers
 * `--help`" could not be true before this constant existed.
 *
 * Same shape as `packages/surveyor/src/cli.ts`'s: the command, one line of
 * synopsis, the single flag it takes, and the environment it reads.
 */
export const USAGE = `usage: cartografo-screen [options]

Starts the screen: the proposal inbox and the observability pages, served on a
port of its own as one more unprivileged client of the public API (D11).

options:
  --url <url>            control plane to watch (env ${CONTROL_PLANE_URL_ENV};
                         default http://${DEFAULT_HOST}:4317)
  -h, --help             this text

environment:
  ${SCREEN_HOST_ENV}  the address to bind (default ${DEFAULT_HOST})
  ${PORT_ENV}  the screen's own port (default ${DEFAULT_PORT})
  ${CONTROL_PLANE_URL_ENV}          control plane address, unless --url says otherwise

The screen holds no database and no credential of its own: it starts, and stops,
without the control plane ever noticing.`;

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
    process.stderr.write(`cartografo-screen: unhandled rejection — ${describeError(reason)}\n`);
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
 * variable (t199, FR6): two readers of `CARTOGRAFO_SCREEN_PORT` that refuse a bad
 * value with two different messages, one of them in Portuguese, is the same
 * split this ticket closes on the control plane's address.
 *
 * @param env Environment to read `CARTOGRAFO_SCREEN_PORT` from.
 * @returns A valid port.
 */
export function screenPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return parsePortFromEnv(env, PORT_ENV, DEFAULT_PORT);
}

/**
 * The project this request is looking at, out of its cookie.
 *
 * A cookie a person edited by hand is not a reason to refuse a page: anything
 * that is not a run of digits reads as the default, silently. What the wrong
 * value could produce is a `404 unknown_project` from the control plane, and
 * that is a failure of the SCOPE and not of the page — so it is filtered out
 * here, where the answer is cheap.
 *
 * @param header The raw `Cookie` header, if the browser sent one.
 * @returns The project id, or {@link DEFAULT_PROJECT_ID}.
 */
export function projectFromCookie(header: string | undefined): number {
  if (header === undefined) return DEFAULT_PROJECT_ID;

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== PROJECT_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return /^[0-9]+$/.test(value) ? Number(value) : DEFAULT_PROJECT_ID;
  }

  return DEFAULT_PROJECT_ID;
}

/**
 * The scope every GET route hands to its page: the cookie plus the project list.
 *
 * The listing is what the switcher draws itself from, and a failure to get it
 * is deliberately NOT a failure of the page: a control plane that does not know
 * `GET /v1/projects` answers a 404, and turning that into a 502 would take the
 * whole screen down over a piece of navigation. An empty list draws no
 * switcher, which is exactly what a single-project deployment wants anyway.
 *
 * That tolerance covers a body without `projects` in it too, and not only a
 * refusal. `ApiClient` mirrors the wire and hands back what came, so an upstream
 * that answers `200` with something else entirely produces `undefined` rather
 * than a throw — and the one read of this screen that is allowed to come back
 * empty must not be the one that turns a strange answer into a broken page.
 *
 * @param client Client of the public API.
 * @param request The incoming request, for its cookie.
 * @returns The project in force and the ones that exist.
 */
async function readScope(client: ApiClient, request: IncomingMessage): Promise<ProjectScope> {
  const projectId = projectFromCookie(request.headers.cookie);
  try {
    const projects = await client.listProjects();
    return { projectId, projects: Array.isArray(projects) ? projects : [] };
  } catch {
    return { projectId, projects: [] };
  }
}

/**
 * Does this GET path render one of the screen's own views?
 *
 * Outside `route()` on purpose, and not merely for tidiness: the paths are
 * listed once in the dispatch below, and a second copy of them inside the same
 * function would be two lists to keep agreeing — which is exactly what
 * `test/spec-routes.test.ts` reads `route()` to prevent.
 *
 * @param pathname Path, already normalized.
 * @returns Whether the answer is going to be a rendered page.
 */
function rendersAView(pathname: string): boolean {
  return (
    ['/', '/board', '/examples', '/executions', '/input-requests', '/runners'].includes(pathname) ||
    /^\/(executions|jobs)\/[^/]+$/.test(pathname)
  );
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
      if (size > BODY_LIMIT) throw new UsageError('form too large');
      chunks.push(block);
    }
  } catch (cause) {
    // The ceiling is this screen refusing a body it does not want, and it keeps
    // saying so with a 400. Anything else coming out of the iteration is the
    // connection dying underneath it.
    if (cause instanceof UsageError) throw cause;
    throw new ClientAbortedError('the form stopped arriving halfway through', { cause });
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** A route's answer: a page, or a redirect. */
type RouteResult =
  | Page
  | {
      redirect: string;
      /** `Set-Cookie` to send with it, when the redirect exists to write one. */
      cookie?: string;
      /** `303` by default — the way back from a POST is a GET. */
      status?: number;
    };

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
      'client disconnected',
      'The connection dropped before the screen finished reading the request. Nothing was changed.',
    );
  }
  if (error instanceof NetworkError) {
    return errorPage(
      502,
      'control plane down',
      `Could not reach ${controlPlaneUrl}. Run \`npx cartografo\` in another terminal (or point somewhere else with --url).`,
    );
  }
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return errorPage(404, 'not found', 'The control plane does not know this address.');
    }
    return errorPage(
      502,
      'the control plane refused',
      `${error.message}. Nothing was changed by this screen.`,
    );
  }
  if (error instanceof UsageError) return errorPage(400, 'invalid request', error.message);
  return errorPage(500, 'screen error', 'Something broke while building this page.');
}

/**
 * Decides which view answers a request.
 *
 * @param client Client of the public API, already pointed at the control plane.
 * @param request The raw request.
 * @returns The page, or the redirect target.
 */
async function route(client: ApiClient, request: IncomingMessage): Promise<RouteResult> {
  // The trailing slash is stripped so `/board/` and `/board` are one address —
  // with one exception, and it is the whole of t402's FR9: the EXACT root keeps
  // its own literal instead of collapsing to the empty string. The root used to
  // belong to the static half, so nothing here ever had to name it; now it is
  // the check page, and a normalization that erased it would leave that page's
  // own branch permanently unreachable — dead code that
  // `test/spec-routes.test.ts` would nonetheless read as a route and demand a
  // row of the specification for.
  const requested = new URL(request.url ?? '/', 'http://tela.local').pathname;
  const pathname = requested === '/' ? requested : requested.replace(/\/+$/, '');
  const method = request.method ?? 'GET';

  if (method === 'GET') {
    // Read ONCE per request, and only for a path that is going to render: the
    // scope costs a call to the control plane, and a 404 must not pay for it.
    const scope = rendersAView(pathname) ? await readScope(client, request) : undefined;

    // The root is the check (t402): the first page a person opens is a check
    // that runs itself, not a form and not a list. The proposal inbox that used
    // to live here moved to `/inbox`, one line away in `static.ts`, and the two
    // halves keep reaching each other through the navigation both pages carry.
    if (pathname === '/') return await checkPage(client, scope);
    if (pathname === '/board') return await boardPage(client, scope);
    if (pathname === '/examples') return await examplesPage(client, scope);
    if (pathname === '/executions') return await executionsPage(client, scope);
    if (pathname === '/input-requests') return await questionsPage(client, scope);
    if (pathname === '/runners') return await runnersPage(client, scope);

    const executionMatch = /^\/executions\/([^/]+)$/.exec(pathname);
    if (executionMatch !== null) {
      const id = routeId(executionMatch[1]);
      return id === null
        ? errorPage(404, 'invalid execution', 'An execution id is an integer.')
        : await executionPage(client, id, scope);
    }

    const jobMatch = /^\/jobs\/([^/]+)$/.exec(pathname);
    if (jobMatch !== null) {
      const id = routeId(jobMatch[1]);
      return id === null
        ? errorPage(404, 'invalid job', 'A job id is an integer.')
        : await jobPage(client, id, scope);
    }
  }

  if (method === 'POST') {
    if (pathname === '/project') {
      // The same origin gate every other write of this screen gets (t192): a
      // form on any other page can aim at a same-site POST, and switching the
      // project somebody else is looking at is a small thing to be able to do
      // from outside.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'untrusted origin',
          'This form only accepts submissions that started on this page. Reload and try again.',
        );
      }
      return await switchProject(request);
    }

    if (pathname === '/settings') {
      // The same gate every other write of this screen gets (t192). This one
      // moves where every future session of a project is allowed to write, so a
      // form on somebody else's page reaching it would be among the worst.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'untrusted origin',
          'This form only accepts submissions that started on this page. Reload and try again.',
        );
      }
      return await saveSettings(client, request);
    }

    const recheckMatch = /^\/runners\/([^/]+)\/rechecks$/.exec(pathname);
    if (recheckMatch !== null) {
      // The same gate, and before the id is even read: a request from elsewhere
      // gets one answer, and not a 404 that tells it which runners exist.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'untrusted origin',
          'This form only accepts submissions that started on this page. Reload and try again.',
        );
      }
      return await requestRecheck(client, decodeURIComponent(recheckMatch[1]));
    }

    const exampleMatch = /^\/examples\/([^/]+)\/run$/.exec(pathname);
    if (exampleMatch !== null) {
      // The same gate every other write of this screen gets (t192): this one
      // starts an agent session and spends money, so a form on somebody else's
      // page reaching it would be worse than most.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'untrusted origin',
          'This form only accepts submissions that started on this page. Reload and try again.',
        );
      }
      return await runExample(client, decodeURIComponent(exampleMatch[1]), request);
    }

    const answerMatch = /^\/input-requests\/([^/]+)\/answer$/.exec(pathname);
    if (answerMatch !== null) {
      // The same gate the proxy gets (t192), and for the same reason: this is a
      // same-site form post, so a form on any other page can aim at it. It comes
      // before the id is even read — a request from elsewhere gets one answer,
      // and not a 404 that tells it which ids exist.
      if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
        return errorPage(
          403,
          'untrusted origin',
          'This form only accepts submissions that started on this page. Reload and try again.',
        );
      }

      const id = routeId(answerMatch[1]);
      if (id === null) {
        return errorPage(404, 'invalid question', 'A question id is an integer.');
      }
      return await submitAnswer(client, id, request);
    }

    // Two routes and not one `(block|unblock)` alternation: `spec-routes.test.ts`
    // reads the paths this function recognizes straight off the source, and a
    // path it cannot spell is a path the specification cannot be checked against.
    const unblockMatch = /^\/jobs\/([^/]+)\/unblock$/.exec(pathname);
    if (unblockMatch !== null) return await flagRoute(client, request, unblockMatch[1], false);

    const blockMatch = /^\/jobs\/([^/]+)\/block$/.exec(pathname);
    if (blockMatch !== null) return await flagRoute(client, request, blockMatch[1], true);
  }

  return errorPage(404, 'page not found', `There is no ${pathname === '' ? '/' : pathname}.`);
}

/**
 * `POST /project` — the switcher, which writes a cookie and nothing else (t354).
 *
 * The only route of this screen that changes something and does NOT talk to the
 * control plane: what project a browser is looking at is this browser's
 * business, and sending it upstream would be the screen keeping state on
 * somebody else's server (D11).
 *
 * `302` and back to the referrer, not `303` to a fixed page: the answer form
 * redirects to the queue because the write CHANGED the queue, while switching
 * the project changes which version of the page you were already on you get —
 * so the way back is where you came from. A referrer that did not come, or came
 * from somewhere else, falls back to the board rather than being trusted into
 * an open redirect.
 */
async function switchProject(request: IncomingMessage): Promise<RouteResult> {
  const fields = await readForm(request);
  const raw = (fields.get('project_id') ?? '').trim();
  if (!/^[0-9]+$/.test(raw)) {
    return errorPage(400, 'invalid project', 'A project id is an integer.');
  }

  return {
    redirect: backTo(request.headers.referer),
    cookie: `${PROJECT_COOKIE}=${raw}; Path=/; SameSite=Lax; Max-Age=31536000`,
    status: 302,
  };
}

/**
 * Where the switcher sends the browser: back where it was, or the board.
 *
 * Only the PATH of the referrer survives, and that is the whole guard: a
 * `Location` built from a header a stranger controls is an open redirect, and
 * dropping the origin makes the answer same-site by construction.
 *
 * @param referer The `Referer` header, if the browser sent one.
 * @returns A path of this screen.
 */
function backTo(referer: string | undefined): string {
  if (referer === undefined) return '/board';
  try {
    const { pathname, search } = new URL(referer, 'http://tela.local');
    return pathname === '/' || pathname === '' ? '/board' : `${pathname}${search}`;
  } catch {
    return '/board';
  }
}

/**
 * `POST /examples/:class/run` — one click, and a demo is running (t408, FR7).
 *
 * The screen decides nothing here: the class comes off its own path, the scope
 * off the cookie, and everything else — which bundle that class lives in,
 * whether it has to be registered first, which round the job lands in — is the
 * control plane's answer to one request. What comes back is an execution id,
 * and the redirect opens the board on it, because the round is the only thing
 * the person who clicked is now waiting on.
 *
 * The form body is not even read: there is nothing in it. A failure raises out
 * of the client and lands on `failurePage`, like every other route of this file.
 */
async function runExample(
  client: ApiClient,
  className: string,
  request: IncomingMessage,
): Promise<RouteResult> {
  const { execution_id: executionId } = await client.runExample(className, {
    project_id: projectFromCookie(request.headers.cookie),
  });

  // 303 and not 302, for the same reason the answer form gives: after a POST
  // the way back is a GET, and a reload must not start a second demo.
  return { redirect: `/executions/${executionId}` };
}

/**
 * `POST /runners/:id/rechecks` — "check again", on the check page (t402, FR5).
 *
 * It writes for real (`POST /v1/runners/:id/rechecks`) and comes back to `/`.
 * What it does NOT do is wait for the answer: the runner serves the request on
 * its next loop tick by reporting a fresh probe, and the reload IS the refresh
 * — the same posture every other view of this screen takes, none of which
 * polls.
 *
 * The form body is not read: there is nothing in it. The id comes off the path
 * and everything else — whether a re-check is already pending, whether this
 * runner exists at all — is the control plane's answer to one request, and a
 * failure raises out of the client onto `failurePage` like every other route
 * here.
 */
async function requestRecheck(client: ApiClient, runnerId: string): Promise<RouteResult> {
  await client.requestRunnerRecheck(runnerId);

  // 303 and not 302, the same reason the answer form gives: after a POST the
  // way back is a GET, and a reload must not queue a second re-check.
  return { redirect: '/' };
}

/**
 * `POST /settings` — the two roots, from the check page's inline form (t402, FR6).
 *
 * **A blank field is not sent.** `PATCH /v1/settings` refuses an empty string
 * with `invalid_setting_value`, on purpose: an empty root is not "no root", it
 * is a value nothing could be started from. So a half-filled form writes the
 * half that was filled, and the screen never forwards a request it already
 * knows will be refused — turning a partial edit into a 502 would be this
 * screen inventing a failure out of a decision the operator was allowed to
 * take.
 *
 * Only the two roots, and deliberately never `engine`: the check page reads
 * that key to decide which fix actions to draw, and a form that could rewrite
 * it would let a typo silently change what the page then claims about the
 * machine. Changing the engine stays a `PATCH` any API client can make.
 */
async function saveSettings(client: ApiClient, request: IncomingMessage): Promise<RouteResult> {
  const fields = await readForm(request);

  const patch: Settings = {};
  const workspaceRoot = (fields.get('workspace_root') ?? '').trim();
  const worktreesRoot = (fields.get('worktrees_root') ?? '').trim();
  if (workspaceRoot !== '') patch.workspace_root = workspaceRoot;
  if (worktreesRoot !== '') patch.worktrees_root = worktreesRoot;

  // Nothing filled is nothing to write, and the control plane never hears about
  // it: an empty patch is a form somebody submitted by accident, not an edit.
  if (Object.keys(patch).length > 0) {
    await client.updateSettings(patch, { project_id: projectFromCookie(request.headers.cookie) });
  }

  return { redirect: '/' };
}

/**
 * `POST /input-requests/:id/answer` — the screen's only write (FR9).
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
      'blank answer',
      'Write the answer (or click one of the options) before sending.',
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
  return { redirect: '/input-requests' };
}

/**
 * What both flag routes do before they write: the gate, then the id (t339).
 *
 * The same gate every other write of this screen gets (t192), and it runs BEFORE
 * the id is even parsed — a request from somewhere else gets one answer, and not
 * a 404 that tells it which job ids exist.
 *
 * @param client Client of the public API.
 * @param request The raw request.
 * @param rawId The `:id` segment, still a string.
 * @param blocking `true` to raise the flag, `false` to lower it.
 * @returns The redirect, or the page that says why not.
 */
async function flagRoute(
  client: ApiClient,
  request: IncomingMessage,
  rawId: string,
  blocking: boolean,
): Promise<RouteResult> {
  if (!isTrustedScreenOrigin(request.headers, request.headers.host)) {
    return errorPage(
      403,
      'untrusted origin',
      'This form only accepts submissions that started on this page. Reload and try again.',
    );
  }

  const id = routeId(rawId);
  if (id === null) return errorPage(404, 'invalid job', 'A job id is an integer.');
  return await submitFlag(client, id, blocking, request);
}

/**
 * `POST /jobs/:id/block` and `POST /jobs/:id/unblock` — the flag, from the board (t339).
 *
 * Real writes against the real control plane, and the same redirect-after-POST
 * shape `submitAnswer` uses: 303, and back to a page reread from the API. Each
 * one lands where the person who did it is now looking — `/board` after a
 * release, because the point was to get a queue of held jobs moving, and
 * `/jobs/:id` after a hold, because the block was about that one job.
 *
 * Two boundaries drawn HERE and not upstream:
 *
 * 1. **A blank reason is refused before the network.** `job.blocked` already
 *    requires one, so the control plane would refuse the block anyway — but
 *    `job.unblocked.reason` is optional (t339), and a whitespace-only sentence
 *    would land in the log as a fact that says nothing. The same 400 the answer
 *    form draws, and for the same reason.
 * 2. **The actor is always sent.** `resolveActor` on the control plane turns an
 *    absent one into the API's own identity, so omitting it would record the
 *    system as having done what a person did — the one failure mode
 *    `packages/core/src/repositories/input-request.ts` names when it explains
 *    why the answer-driven unblock carries the answerer's actor.
 */
async function submitFlag(
  client: ApiClient,
  jobId: number,
  blocking: boolean,
  request: IncomingMessage,
): Promise<RouteResult> {
  const fields = await readForm(request);
  const reason = (fields.get('reason') ?? '').trim();
  if (reason === '') {
    return errorPage(
      400,
      'blank reason',
      `Say why the job ${blocking ? 'should stop here' : 'can move again'} before sending.`,
    );
  }

  const typed = (fields.get('actor_ref') ?? '').trim();
  const input = {
    reason,
    actor: { type: 'user' as const, ref: typed === '' ? DEFAULT_ANSWERED_BY : typed },
  };

  if (blocking) {
    await client.blockJob(jobId, input);
    return { redirect: `/jobs/${jobId}` };
  }
  await client.unblockJob(jobId, input);
  return { redirect: '/board' };
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
   * `resolveControlPlaneToken`'s precedence — `CARTOGRAFO_SCREEN_TOKEN` first,
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
      if (size > limit) throw new PayloadTooLargeError(`body larger than ${limit} bytes`);
      chunks.push(block);
    }
  } catch (cause) {
    // The ceiling is this screen refusing a body it does not want, and it keeps
    // saying so. Anything else out of the iteration is the connection dying
    // underneath it.
    if (cause instanceof PayloadTooLargeError) throw cause;
    throw new ClientAbortedError('the request body stopped arriving halfway through', { cause });
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
  process.stderr.write(`cartografo-screen: request failed — ${describeError(error)}\n`);

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
          const headers: Record<string, string> = { location: result.redirect };
          if (result.cookie !== undefined) headers['set-cookie'] = result.cookie;
          response.writeHead(result.status ?? 303, headers);
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
  const host = options.host ?? resolveScreenHost();
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
 * Entry point of the `cartografo-screen` command.
 *
 * Prints one JSON readiness line on stdout — the same contract as the control
 * plane's startup, so that a supervisor (or a test) knows the screen is up and
 * against which control plane.
 *
 * This is one of the two places `installCrashGuard` is installed (the other is
 * `main` in `server.ts`): a process that is going to stay up serving strangers
 * is exactly where Node's "die on an unhandled rejection" is the wrong default.
 *
 * `-h`/`--help` is answered BEFORE any of that (t248, FR7) — before the crash
 * guard, before the port, before the control plane is contacted. A question is
 * not a start, and everything below this line is a start.
 *
 * @param args Arguments after the command name.
 * @param env Environment to read the configuration from.
 * @param context Test injection for the output writer, as in the surveyor's CLI.
 */
export async function runScreenCli(
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  context: { write?: (text: string) => void } = {},
): Promise<void> {
  const write = context.write ?? ((text: string) => void process.stdout.write(text));

  if (args.some((argument) => argument === '--help' || argument === '-h')) {
    write(`${USAGE}\n`);
    return;
  }

  installCrashGuard();

  const screen = await startScreenRouter({
    controlPlaneUrl: resolveControlPlaneUrl(env, urlFromArgs(args)),
    token: resolveControlPlaneToken(env),
    host: resolveScreenHost(env),
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
