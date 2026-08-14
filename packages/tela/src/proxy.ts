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
 * is an answer the inbox must show, not an error for the proxy to reshape. The
 * one thing this module does invent is the reply for a control plane that is
 * down (`502 control_plane_indisponivel`), because the alternative is a socket
 * error reaching the browser as a blank page.
 *
 * The address resolution repeats `packages/core/src/cli/url.ts` on purpose: the
 * screen declares no dependency on the core package (that is the whole point of
 * D11), so the precedence `CARTOGRAFO_URL` > `http://127.0.0.1:CARTOGRAFO_PORT`
 * is duplicated here rather than imported. Duplicated and pinned by test, like
 * the graph validator in `scripts/validar-grafo.mjs`.
 */

/** Environment variable that overrides the control plane base URL. */
export const CONTROL_PLANE_URL_ENV = 'CARTOGRAFO_URL';

/** Environment variable that gives the control plane port of the default URL. */
export const CONTROL_PLANE_PORT_ENV = 'CARTOGRAFO_PORT';

/** Default control plane port — the same `PORTA_PADRAO` the core listens on. */
export const DEFAULT_CONTROL_PLANE_PORT = 4317;

/** Default control plane host — loopback, like the core's `HOST_PADRAO`. */
export const DEFAULT_CONTROL_PLANE_HOST = '127.0.0.1';

/** Prefix of every business route; everything else on the screen is static. */
export const API_PREFIX = '/v1';

/** Error code of the only failure this proxy invents. */
export const UPSTREAM_DOWN_CODE = 'control_plane_indisponivel';

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
    throw new Error(`${name} inválida: "${configured}" (esperado um inteiro de 0 a 65535)`);
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
      `${CONTROL_PLANE_URL_ENV} inválida: "${chosen}" (esperado algo como http://127.0.0.1:4317)`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${CONTROL_PLANE_URL_ENV} precisa ser http ou https: "${chosen}"`);
  }

  return chosen.replace(/\/+$/, '');
}

/**
 * The answer for a control plane that did not answer.
 *
 * Same `erro` / `mensagem` shape every error of the core uses, so the page has
 * one way to show a failure instead of two. The cause is deliberately dropped:
 * `ECONNREFUSED` and a stack trace say nothing to whoever is looking at the
 * inbox, and the actionable half is the address plus what to run.
 *
 * @param baseUrl Address that did not answer.
 * @returns A complete `502` response.
 */
export function unavailableResponse(baseUrl: string): ProxiedResponse {
  return jsonResponse(502, {
    erro: UPSTREAM_DOWN_CODE,
    mensagem: `não deu para falar com o control plane em ${baseUrl} — rode \`npx cartografo\` primeiro (ou aponte outro endereço com ${CONTROL_PLANE_URL_ENV})`,
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
 * @param baseUrl Control plane base URL, no trailing slash.
 * @param request The browser request to forward.
 * @param doFetch `fetch` implementation; injectable for tests.
 * @returns The upstream response, or the `502` of a control plane that is down.
 */
export async function forwardRequest(
  baseUrl: string,
  request: ProxiedRequest,
  doFetch: typeof fetch = fetch,
): Promise<ProxiedResponse> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

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
