/**
 * Address of the control plane, and the HTTP access to it (t108, FR6).
 *
 * `import`, `export` and `status` are API clients like any other (D1, D11): they
 * speak `/health` and `/v1/*` over HTTP and open no database. This module is all
 * the networking the three of them know — resolving the address and making the
 * request live together because they are the same question ("how do I reach the
 * control plane?"), and because keeping `fetch` in a single place is what
 * guarantees a connection error always becomes the SAME actionable message,
 * instead of a `TypeError: fetch failed` stack trace leaking to the user.
 *
 * Address precedence: `--url` > `CARTOGRAFO_URL` > `http://127.0.0.1:PORT`.
 * The default port comes from `serverPort` (`src/index.ts`), the same function
 * that decides where the startup listens — so `CARTOGRAFO_PORT=5000 cartografo up`
 * in one terminal and `CARTOGRAFO_PORT=5000 cartografo status` in another find
 * each other without anyone having to repeat `--url`.
 *
 * Credential precedence, in the same spirit: `--token` > `CARTOGRAFO_TOKEN` >
 * none. It travels on every request this module makes (t124, FR6), because
 * every subcommand except `up` is a client of an API that no longer answers
 * anonymously — and a `401` comes back out of here as ONE actionable line,
 * never as the wire body, for the same reason a connection error does.
 */

import { DEFAULT_HOST, serverPort } from '../index.ts';

/** Environment variable that overrides the control plane's base URL. */
export const ENV_URL = 'CARTOGRAFO_URL';

/** Environment variable that carries the credential of the control plane. */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/** Failure to REACH the control plane — distinct from an error response from it. */
export class NetworkError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`could not talk to the control plane at ${url}`, { cause });
    this.name = 'NetworkError';
    this.url = url;
  }
}

/** Wrong use of the command — the caller turns it into a message, never a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The control plane answered, and it refused the credential (t124).
 *
 * A distinct class and not a status the subcommands each interpret: `401` is
 * never a domain answer — no route means anything by it — so the useful thing to
 * do with it is always the same, and doing it in one place is what guarantees
 * the message is the same too.
 */
export class DeniedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`the control plane refused the credential at ${url}`);
    this.name = 'DeniedError';
    this.url = url;
  }
}

/**
 * The server-is-down message. Always this one, and always with what to do next:
 * whoever runs `import` in a clean terminal does not fail for lack of a server,
 * they fail for not knowing they needed to start one.
 *
 * @param url Address that did not answer.
 * @returns A single line for stderr.
 */
export function serverDownMessage(url: string): string {
  return `cartografo: could not talk to the control plane at ${url} — run \`cartografo up\` first (or point somewhere else with --url)`;
}

/**
 * The credential-refused message, in the same voice as the one above.
 *
 * It says what to DO — the token is printed on the readiness line of the very
 * `cartografo up` this person ran — instead of forwarding `{"erro":"..."}`,
 * which describes the server's state to somebody asking about their own.
 *
 * @param url Address that refused.
 * @returns A single line for stderr.
 */
export function deniedMessage(url: string): string {
  return `cartografo: request denied (401) by the control plane at ${url} — set ${ENV_TOKEN} or pass --token with the token printed when the control plane started`;
}

/**
 * Resolves the control plane's base URL.
 *
 * @param option Value of `--url`, when it came on the command line.
 * @param env Environment to read `CARTOGRAFO_URL` and `CARTOGRAFO_PORT` from.
 * @returns Base URL with no trailing slash.
 */
export function resolveBaseUrl(option?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[ENV_URL]?.trim();
  const chosen =
    option !== undefined && option.trim() !== ''
      ? option.trim()
      : fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : `http://${DEFAULT_HOST}:${serverPort(env)}`;

  let parsed: URL;
  try {
    parsed = new URL(chosen);
  } catch {
    throw new UsageError(`invalid URL: "${chosen}" (expected something like http://127.0.0.1:4317)`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`the URL has to be http or https: "${chosen}"`);
  }

  return chosen.replace(/\/+$/, '');
}

/**
 * Resolves the credential the subcommands present.
 *
 * @param option Value of `--token`, when it came on the command line.
 * @param env Environment to read `CARTOGRAFO_TOKEN` from.
 * @returns The token, or `undefined` when there is none to present.
 */
export function resolveToken(
  option?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const chosen = option?.trim() !== undefined && option.trim() !== '' ? option.trim() : env[ENV_TOKEN]?.trim();
  return chosen === undefined || chosen === '' ? undefined : chosen;
}

/**
 * The credential every request of this process carries.
 *
 * A module-level value and not a parameter threaded through six subcommands:
 * `requestJson` is already the single place that knows how to reach the control
 * plane, and the token is one more thing about that reach. Setting it is the
 * router's job, once, right after it resolves the address.
 */
let currentToken: string | undefined;

/**
 * Sets the credential used from here on.
 *
 * @param token Token to present, or `undefined` for none.
 */
export function useToken(token: string | undefined): void {
  currentToken = token;
}

/** A response already read: status and parsed body (raw text, if it is not JSON). */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Makes a request and reads the whole response.
 *
 * Does not throw on an error status — 404 and 422 are answers, not exceptions,
 * and each subcommand decides what to do with the body. The two exceptions are
 * the two failures no subcommand can do anything useful with: not reaching the
 * server (`NetworkError`) and having the credential refused (`DeniedError`).
 *
 * @param url Full URL.
 * @param options Method and JSON body, when there is one.
 * @returns Status and already parsed body.
 */
export async function requestJson(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<HttpResponse> {
  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';
  if (currentToken !== undefined) headers.authorization = `Bearer ${currentToken}`;

  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
    text = await response.text();
  } catch (cause) {
    throw new NetworkError(url, cause);
  }

  if (response.status === 401) throw new DeniedError(url);

  if (text === '') return { status: response.status, body: undefined };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
