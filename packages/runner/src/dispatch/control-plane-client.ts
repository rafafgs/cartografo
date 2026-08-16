/**
 * The one door out of the dispatch, as a module of its own (t202, FR3).
 *
 * It was a closure inside `createClaudeCodeDispatch` — `headers()` plus a
 * `call<T>()` wrapping `requestJson` — and it stayed there while the dispatch
 * was one file. The split moved the reporting writes into `report.ts`, and a
 * second consumer of a private closure is not a thing: either `report.ts` gets
 * handed the function, or it builds its own headers and the credential has two
 * owners. This is the first of those two, hoisted so that both sides can be
 * given the SAME client.
 *
 * Nothing about what it does changed. The header rule is still the one t124/t147
 * settled — the body's `content-type` only when there is a body, and the
 * credential only when there is one, because an empty `Authorization` would look
 * like a credential — and the mechanic is still `requestJson`'s, which is what
 * t193 unified across this package's three clients: a deadline on every request,
 * the status read BEFORE the body, and the error type the caller's own
 * (`controller/http-client.ts`).
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API, same boundary the UI has (D1, D11).
 *
 * English per D18; the routes it is pointed at are wire vocabulary and stay in
 * Portuguese.
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeErrorBody,
  requestJson,
} from '../controller/http-client.ts';

/**
 * One call to the control plane: a route, a verb, and a body when there is one.
 *
 * Generic in the answer and not in the request on purpose — every route this
 * dispatch calls takes a plain JSON object and gives back a shape the caller
 * names, and a request type would only be a second place to keep it.
 */
export type ControlPlaneCall = <T>(route: string, method: string, body?: unknown) => Promise<T>;

/** Everything a dispatch's client needs to reach its control plane. */
export interface DispatchControlPlaneClientOptions {
  /**
   * Base URL of the control plane. Trailing slashes are trimmed here, once, so
   * that no route has to care whether it was configured with one.
   */
  urlBase: string;
  /**
   * Credential presented on every call (t124, t147).
   *
   * With no token no header goes out, and the API answers 401 — which is the
   * honest outcome: an empty header would look like a credential.
   */
  token?: string;
  /** Deadline of every call. Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** `fetch` implementation. Default: the global one. Test seam only. */
  doFetch?: typeof fetch;
}

/**
 * Builds the client every call of one dispatch goes through.
 *
 * @param options Address, credential, deadline and the `fetch` to use.
 * @returns The typed `call` the dispatch and its reports share.
 */
export function createDispatchControlPlaneClient(
  options: DispatchControlPlaneClientOptions,
): ControlPlaneCall {
  const urlBase = options.urlBase.replace(/\/+$/, '');
  const doFetch = options.doFetch ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Headers of every call: the body's `content-type`, when there is a body, and
  // the credential. Built once — the seven routes are one client, and a route
  // that assembled its own headers is a route that could forget them.
  const headers = (withBody: boolean): Record<string, string> => {
    const built: Record<string, string> = {};
    if (withBody) built['content-type'] = 'application/json';
    if (options.token !== undefined) built.authorization = `Bearer ${options.token}`;
    return built;
  };

  /**
   * The one door out of this dispatch, and since t193 it is the SHARED mechanic.
   *
   * What it used to be was a second copy of `ClienteControle`'s, and the copy
   * had drifted: it decoded the body before it looked at the status, so a 502
   * with an HTML page from a proxy came out of here as a raw `SyntaxError` —
   * carrying neither the status nor the text — while the very same answer came
   * out of the other client as an `ErroDoControlPlane`. That is exactly the
   * regression t156 had already fixed once, in the other file.
   */
  return async <T>(route: string, method: string, body?: unknown): Promise<T> =>
    await requestJson<T>({
      url: `${urlBase}${route}`,
      method,
      headers: headers(body !== undefined),
      body,
      timeoutMs: requestTimeoutMs,
      fetchImpl: doFetch,
      buildError: ({ status, body: text }) =>
        new ErroDoControlPlane(
          `${method} ${route} answered ${status}`,
          status,
          decodeErrorBody(text),
        ),
    });
}
