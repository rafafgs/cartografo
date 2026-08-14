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
 */

import { DEFAULT_HOST, serverPort } from '../index.ts';

/** Environment variable that overrides the control plane's base URL. */
export const ENV_URL = 'CARTOGRAFO_URL';

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

/** A response already read: status and parsed body (raw text, if it is not JSON). */
export interface HttpResponse {
  status: number;
  body: unknown;
}

/**
 * Makes a request and reads the whole response.
 *
 * Does not throw on an error status — 404 and 422 are answers, not exceptions,
 * and each subcommand decides what to do with the body. It only fails on not
 * reaching the server, and then always with `NetworkError`.
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
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
    text = await response.text();
  } catch (cause) {
    throw new NetworkError(url, cause);
  }

  if (text === '') return { status: response.status, body: undefined };
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
