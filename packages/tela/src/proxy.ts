/**
 * Where the control plane is, and how a browser request reaches it.
 *
 * The screen is one more HTTP client of the public API (D11) — never a second
 * writer (D1). A browser, though, cannot call the control plane directly: the
 * core ships no CORS plugin, and installing one would widen who may call the
 * only writer in the system. So the screen serves its own page and forwards
 * `/v1/*` from the same origin: the browser talks to the screen, the screen
 * talks to the API, and nothing about the API's boundary changes.
 *
 * "Forward" here means verbatim. Method, path, query and body cross unchanged,
 * and the upstream status comes back as it is — a `409 proposta_nao_pendente`
 * is an answer the inbox must show, not an error for the proxy to reshape. Two
 * replies this module invents rather than forwards: the control plane that is
 * down (`502 control_plane_indisponivel`), because the alternative is a socket
 * error reaching the browser as a blank page, and the write that did not start
 * on this screen's page (`403 origem_nao_confiavel`, t192), because a forwarded
 * request carries the operator's credential and a page on another site must not
 * get to spend it. The second one is a decision ABOUT forwarding, so it is a
 * check the router runs before the pipe, never a branch inside it.
 *
 * The address resolution repeats `packages/core/src/cli/url.ts` on purpose: the
 * screen declares no dependency on the core package (that is the whole point of
 * D11), so the precedence `CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT`
 * is duplicated here rather than imported. Duplicated and pinned by test, like
 * the graph validator in `scripts/validar-grafo.mjs`.
 */

/** Environment variable that overrides the control plane base URL. */
export const CONTROL_PLANE_URL_ENV = 'CARTOGRAFO_URL';

/** Environment variable with the screen's own credential (t124, FR7). */
export const SCREEN_TOKEN_ENV = 'CARTOGRAFO_TELA_TOKEN';

/** Fallback credential: the one the CLI already uses, when the screen has none. */
export const SHARED_TOKEN_ENV = 'CARTOGRAFO_TOKEN';

/** Environment variable that gives the control plane port of the default URL. */
export const CONTROL_PLANE_PORT_ENV = 'CARTOGRAFO_PORT';

/** Default control plane port — the same `PORTA_PADRAO` the core listens on. */
export const DEFAULT_CONTROL_PLANE_PORT = 4317;

/** Default control plane host — loopback, like the core's `HOST_PADRAO`. */
export const DEFAULT_CONTROL_PLANE_HOST = '127.0.0.1';

/** Prefix of every business route; everything else on the screen is static. */
export const API_PREFIX = '/v1';

/** Error code of the failure this proxy invents when the core does not answer. */
export const UPSTREAM_DOWN_CODE = 'control_plane_indisponivel';

/** Error code of a state-changing request that did not start on this screen. */
export const UNTRUSTED_ORIGIN_CODE = 'origem_nao_confiavel';

/**
 * What a browser looks like when it says nothing else about itself.
 *
 * Deliberately generous — every engine in use puts one of these tokens in its
 * `User-Agent`, and the cost of a false positive here is a script on this same
 * machine having to stop pretending to be a browser.
 */
const BROWSER_AGENT = /Mozilla\/|Chrome\/|Safari\/|Firefox\/|Edg\//;

/**
 * Headers that describe THIS hop and must not be forwarded: they belong to the
 * browser↔screen connection, not to the screen↔core one. `content-length` and
 * `accept-encoding` go with them because `fetch` recomputes the first and
 * decodes the second — passing them on is how a proxy ends up announcing a
 * length or an encoding that does not match the bytes it sends.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Methods that never carry a body — sending one makes `fetch` throw. */
const BODILESS_METHODS = new Set(['GET', 'HEAD']);

/** A request as it arrived from the browser, ready to be forwarded. */
export interface ProxiedRequest {
  method: string;
  /** Path AND query, exactly as the browser wrote it (`/v1/proposals?status=x`). */
  target: string;
  headers: NodeJS.Dict<string | string[]>;
  body?: Buffer;
}

/** What the screen writes back to the browser. */
export interface ProxiedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * Reads a port from the environment, rejecting a value that is not one.
 *
 * Lives here because the control plane default URL needs it; `server.ts` reuses
 * it for the screen's own port so that both fail the same way, at startup, with
 * the name of the variable in the message instead of an `EADDRINUSE` later.
 *
 * @param env Environment to read from.
 * @param name Variable name.
 * @param fallback Port to use when the variable is unset or blank.
 * @returns A valid port number.
 */
export function parsePortFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const configured = env[name]?.trim();
  if (configured === undefined || configured === '') return fallback;

  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${name} invalid: "${configured}" (expected an integer from 0 to 65535)`);
  }
  return port;
}

/**
 * Resolves the control plane base URL.
 *
 * Precedence: `CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT` > the
 * default `http://127.0.0.1:4317` — the same order as the CLI, so one
 * `CARTOGRAFO_PORT=5000` in the shell moves the server, the CLI and the screen
 * together.
 *
 * @param env Environment to read from.
 * @returns Base URL with no trailing slash.
 */
export function resolveControlPlaneUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[CONTROL_PLANE_URL_ENV]?.trim();
  const chosen =
    configured !== undefined && configured !== ''
      ? configured
      : `http://${DEFAULT_CONTROL_PLANE_HOST}:${parsePortFromEnv(env, CONTROL_PLANE_PORT_ENV, DEFAULT_CONTROL_PLANE_PORT)}`;

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new Error(
      `${CONTROL_PLANE_URL_ENV} invalid: "${chosen}" (expected something like http://127.0.0.1:4317)`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${CONTROL_PLANE_URL_ENV} has to be http or https: "${chosen}"`);
  }

  return chosen.replace(/\/+$/, '');
}

/**
 * Resolves the credential the screen presents to the control plane (t124, FR7).
 *
 * Its own variable first, the CLI's shared one after: a single-operator setup
 * exports `CARTOGRAFO_TOKEN` once and everything works, and whoever later gives
 * the screen a credential of its own does it without touching the terminal where
 * the CLI runs.
 *
 * The screen holds this token; it does NOT ask the browser for one. D11 makes
 * the screen an unprivileged client of the public API, not a second
 * authentication boundary — the browser reaches the screen with no credential,
 * exactly as before.
 *
 * @param env Environment to read from.
 * @returns The token, or `undefined` when the screen has none to present.
 */
export function resolveControlPlaneToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const own = env[SCREEN_TOKEN_ENV]?.trim();
  if (own !== undefined && own !== '') return own;

  const shared = env[SHARED_TOKEN_ENV]?.trim();
  return shared === undefined || shared === '' ? undefined : shared;
}

/**
 * The answer for a control plane that did not answer.
 *
 * Same `erro` / `mensagem` shape every error of the core uses, so the page has
 * one way to show a failure instead of two — and, since t180, the same English
 * prose: this body is API plumbing, not the rendered copy t133 keeps in
 * Portuguese on purpose. The cause is deliberately dropped:
 * `ECONNREFUSED` and a stack trace say nothing to whoever is looking at the
 * inbox, and the actionable half is the address plus what to run.
 *
 * @param baseUrl Address that did not answer.
 * @returns A complete `502` response.
 */
export function unavailableResponse(baseUrl: string): ProxiedResponse {
  return jsonResponse(502, {
    erro: UPSTREAM_DOWN_CODE,
    mensagem: `could not reach the control plane at ${baseUrl} — run \`npx cartografo\` first (or point somewhere else with ${CONTROL_PLANE_URL_ENV})`,
  });
}

/** Reads one header, collapsing a repeated one into the value it really sent. */
function headerOf(headers: NodeJS.Dict<string | string[]>, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  // A repeated `Origin` or `Sec-Fetch-Site` is not something a browser does. It
  // stays joined on purpose: the joined value matches none of the accepted ones,
  // so the ambiguous case falls on the refusing side without a branch of its own.
  return Array.isArray(raw) ? raw.join(', ') : raw;
}

/**
 * Did this state-changing request start on the screen's own page? (t192)
 *
 * The screen's `/v1/*` proxy stamps the operator's credential onto everything it
 * forwards (t124), and the control plane's write routes are satisfied by an
 * empty body. A `fetch(…, {method:'POST', mode:'no-cors'})` is a "simple"
 * request — no preflight — so, without this gate, any page open in the same
 * browser could apply a proposal with the operator's token just by knowing the
 * port. That is the hole; this is the whole of the fix.
 *
 * It reads fetch metadata, and nothing else, because `Sec-Fetch-Site` and
 * `Origin` are written by the browser's own network stack and are forbidden to
 * page script — a hostile page cannot forge them even in `no-cors` mode. Three
 * refusals, in order:
 *
 * 1. **`Sec-Fetch-Site` present and neither `same-origin` nor `none`** — the
 *    browser is telling us this came from somewhere else (or from a form on
 *    another site, which reads `cross-site`). `none` is a typed address or a
 *    bookmark, which is the screen's own page too.
 * 2. **`Origin` present and not exactly `http://<Host>`** — the standard
 *    Origin-vs-Host check, and no configuration to keep in sync: both headers
 *    are set honestly by the browser for a real cross-origin request. Plain
 *    `http`, since nothing in this stack terminates TLS.
 * 3. **Neither header, but a browser-shaped `User-Agent`** — a browser that
 *    predates fetch metadata is still a browser, and gets no free pass.
 *
 * What is left — no `Sec-Fetch-Site`, no `Origin`, no browser signature — is
 * `curl`, a script, or Node's own `fetch`, and it is trusted DELIBERATELY. The
 * boundary for a local process is D11's loopback port, not this function: a
 * hostile process on this machine forges any header it likes, and closing that
 * would take a credential the browser presents, which is a decision the founder
 * has not taken.
 *
 * @param headers Request headers, as Node lower-cases them.
 * @param host The request's own `Host` header.
 * @returns `true` when the request may be forwarded.
 */
export function isTrustedScreenOrigin(
  headers: NodeJS.Dict<string | string[]>,
  host: string | undefined,
): boolean {
  const site = headerOf(headers, 'sec-fetch-site');
  if (site !== undefined) {
    const declared = site.trim().toLowerCase();
    if (declared !== 'same-origin' && declared !== 'none') return false;
  }

  const origin = headerOf(headers, 'origin');
  if (origin !== undefined) {
    if (host === undefined) return false;
    if (origin.trim().toLowerCase() !== `http://${host.trim().toLowerCase()}`) return false;
  }

  if (site === undefined && origin === undefined) {
    const agent = headerOf(headers, 'user-agent');
    if (agent !== undefined && BROWSER_AGENT.test(agent)) return false;
  }

  return true;
}

/**
 * The answer for a write that came from somewhere else (t192).
 *
 * Same `erro` / `mensagem` shape as `unavailableResponse`, and English for the
 * same reason (t180): this body is proxy plumbing, met as an API response, not
 * the rendered copy the screen keeps in Portuguese. The way out is in the
 * message, because the two people who will ever read it are whoever reloaded a
 * stale tab and whoever is scripting against the wrong port.
 *
 * @returns A complete `403` response.
 */
export function untrustedOriginResponse(): ProxiedResponse {
  return jsonResponse(403, {
    erro: UNTRUSTED_ORIGIN_CODE,
    mensagem: `this proxy only forwards writes that started on the screen's own page — reload the tab, or call the control plane directly (${DEFAULT_CONTROL_PLANE_HOST}:${DEFAULT_CONTROL_PLANE_PORT} by default)`,
  });
}

/**
 * Builds a JSON response in the screen's own voice (the two cases the proxy
 * answers by itself: upstream down, and a static file that is not there).
 *
 * @param status HTTP status.
 * @param body Object to serialize.
 * @returns A complete response.
 */
export function jsonResponse(status: number, body: unknown): ProxiedResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
  };
}

/**
 * Forwards one request to the control plane and brings the answer back.
 *
 * Does not throw on an error status — `404`, `409` and `422` are answers the
 * inbox renders. It only absorbs the failure to REACH the server, and even that
 * comes back as a response, so the caller stays a dumb pipe.
 *
 * The one header this proxy writes itself is the credential (t124, FR7): it is
 * the screen's, not the browser's, and it OVERWRITES whatever came in. A browser
 * that sends an `Authorization` of its own is not granted anything it could not
 * already reach through this same screen — the credential of this hop belongs to
 * the process, not to whoever opened the page.
 *
 * @param baseUrl Control plane base URL, no trailing slash.
 * @param request The browser request to forward.
 * @param options `fetch` implementation (injectable for tests) and the token.
 * @returns The upstream response, or the `502` of a control plane that is down.
 */
export async function forwardRequest(
  baseUrl: string,
  request: ProxiedRequest,
  options: { doFetch?: typeof fetch; token?: string } = {},
): Promise<ProxiedResponse> {
  const doFetch = options.doFetch ?? fetch;

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
  else headers.delete('authorization');

  const method = request.method.toUpperCase();
  const hasBody =
    !BODILESS_METHODS.has(method) && request.body !== undefined && request.body.length > 0;

  let response: Response;
  let body: Buffer;
  try {
    response = await doFetch(`${baseUrl}${request.target}`, {
      method,
      headers,
      body: hasBody ? request.body : undefined,
    });
    body = Buffer.from(await response.arrayBuffer());
  } catch {
    return unavailableResponse(baseUrl);
  }

  // Only `content-type` crosses back: it is what tells the page how to read the
  // body. Everything else the core sets describes a connection that ends here.
  const forwarded: Record<string, string> = {};
  const contentType = response.headers.get('content-type');
  if (contentType !== null) forwarded['content-type'] = contentType;

  return { status: response.status, headers: forwarded, body };
}
