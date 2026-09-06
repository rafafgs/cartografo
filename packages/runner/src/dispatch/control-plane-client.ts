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

import { ControlPlaneClientError } from '../controller/control-plane-client.ts';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeErrorBody,
  requestJson,
} from '../controller/http-client.ts';

/**
 * The same route, scoped to one project — or untouched, when none was named
 * (t410).
 *
 * FIVE of this dispatch's reads go to routes that read ONE project's partition:
 * the work itself, its timeline and its node's input (partitioned by t410), and
 * the graph version and the pinned skill the node names (partitioned by t354).
 * A read that declares no project reads the DEFAULT one, so a dispatch working
 * any other project is told its own work does not exist — a lease taken, a
 * `404`, the lease given back, on every tick, with nothing in the log that says
 * which project was actually read.
 *
 * The last two are t354's partition rather than this ticket's, and they are
 * fixed here because t410 is what makes them certain: `POST /v1/jobs` refuses a
 * `graph_version_id` from another project since this ticket, so a job outside
 * the default project now necessarily cites a version registered in ITS
 * project — which an unscoped read can never find.
 *
 * The separator is chosen rather than assumed: `skillRoute` already carries a
 * `?version=`, and a second `?` would make the scope a parameter the router
 * never sees.
 *
 * `undefined` is kept as "say nothing" rather than folded into project 1: every
 * caller written before the partition means the server's default, and the two
 * spikes and the sixty-odd test wirings that build a dispatch without a project
 * are all of them working in it. Saying it explicitly would be inventing a
 * declaration none of them made.
 *
 * @param route The route to scope, with or without a query string of its own.
 * @param projectId The project to scope to, when the caller named one.
 * @returns The route, with `project_id` appended when there is one to append.
 */
export function withProject(route: string, projectId: number | undefined): string {
  if (projectId === undefined) return route;
  return `${route}${route.includes('?') ? '&' : '?'}project_id=${String(projectId)}`;
}

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
   * What it used to be was a second copy of `ControlPlaneClient`'s, and the copy
   * had drifted: it decoded the body before it looked at the status, so a 502
   * with an HTML page from a proxy came out of here as a raw `SyntaxError` —
   * carrying neither the status nor the text — while the very same answer came
   * out of the other client as an `ControlPlaneClientError`. That is exactly the
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
        new ControlPlaneClientError(
          `${method} ${route} answered ${status}`,
          status,
          decodeErrorBody(text),
        ),
    });
}
