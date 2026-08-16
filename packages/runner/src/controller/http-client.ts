/**
 * The one HTTP mechanic every runner-initiated request uses (t193, FR1).
 *
 * Three clients in this package had hand-rolled the same six lines —
 * `ClienteControle`'s `#get`/`#post`, `createClaudeCodeDispatch`'s own `call()`
 * and `synthesizer/control-plane-client.ts`'s `getJson()` — and the copies had
 * already drifted in the way copies do: t156 fixed the decode order in one of
 * them and left the other two decoding the body BEFORE looking at the status.
 * What lives here is that mechanic, once:
 *
 * - **a deadline on every request.** A control plane that is down answers, and
 *   a client handles it; a control plane that accepts the TCP connection and
 *   never writes a byte does not, and a request with no deadline waits for it
 *   forever — which hangs the tick that made it, the loop that awaits the tick,
 *   and the shutdown that awaits the loop.
 * - **the status before the body.** Whoever answers an error is not always the
 *   control plane: a reverse proxy answers 502 with an HTML page, and a
 *   `JSON.parse` of that page throws a `SyntaxError` carrying neither the
 *   status nor the text. Failing to decode the body of an error is not a second
 *   failure — it is the body, exactly as it came.
 * - **the error is the CALLER'S.** This module does not own an error type and
 *   does not export one: the two error shapes in this package differ in what
 *   they carry, for reasons that predate this ficha, and unifying them is a
 *   ticket that touches every call site of both. What is unified here is the
 *   mechanic, not the vocabulary.
 *
 * The timeout is surfaced as whatever `AbortSignal.timeout` aborts with — a
 * `DOMException` named `TimeoutError` — and passes through unchanged. There is
 * no new type to catch: a caller that wants to tell a deadline apart from a
 * refusal reads `error.name`, and one that does not care lets it travel up like
 * any other rejection.
 *
 * English per D18: this is code written after the decision, and the two
 * Portuguese-named clients call INTO it rather than the other way round.
 */

/**
 * Deadline of one request, in milliseconds, when nobody says otherwise.
 *
 * 30s is generous for every route this package calls — the longest of them
 * reads a graph snapshot out of SQLite — and the number is deliberately far
 * from the tick interval: what it exists to catch is a server that stopped
 * answering at all, never a server that is merely busy.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** What an error answer carries: the status, and the body exactly as it came. */
export interface HttpFailure {
  status: number;
  /** The body as TEXT, undecoded: what it parses into is the caller's call. */
  body: string;
}

/** One request, with everything this module needs to make it and read it back. */
export interface JsonRequest {
  /** Absolute URL, already assembled. */
  url: string;
  /** HTTP verb. Default: `GET`. */
  method?: string;
  /** Headers to send — the credential, and the body's `content-type`. */
  headers?: Record<string, string>;
  /** Body to send, serialized as JSON. Absent means no body at all. */
  body?: unknown;
  /** Deadline of THIS request. Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** What performs the request. Injected by every caller; the tests' only seam. */
  fetchImpl: typeof fetch;
  /**
   * Builds the error a non-2xx answer becomes.
   *
   * Called with the status and the raw text, and never with a decoded body:
   * decoding is what {@link decodeErrorBody} is for, and a caller whose error
   * type carries no body (there is one) does not have to run it.
   */
  buildError: (failure: HttpFailure) => unknown;
}

/**
 * Decodes the body of an ERROR answer, without ever throwing (t156).
 *
 * Not for the success path, on purpose: a malformed body in a 2xx is the
 * control plane breaking its own contract, and that one has to surface.
 *
 * @param text The body, as text.
 * @returns `undefined` for an empty body, the decoded value when it is JSON,
 *   and the raw text itself when it is not.
 */
export function decodeErrorBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Makes one request, on a deadline, and gives back the decoded success body.
 *
 * The deadline is enforced HERE and not only through the signal handed to
 * `fetch`. That is not distrust of the platform: `fetchImpl` is an injected
 * seam in all three callers, and a request that gives up only if the injected
 * implementation cooperates is a request whose deadline is not a property of
 * this module. The signal still goes out, because it is what actually tears
 * down a real socket.
 *
 * @param request Where to go, what to send, how long to wait and what an error
 *   should become.
 * @returns The decoded body, or `undefined` when a 2xx answered with none.
 * @throws Whatever `buildError` built, for any non-2xx; the `TimeoutError` of
 *   `AbortSignal.timeout`, unchanged, when the deadline ran out.
 */
export async function requestJson<T>(request: JsonRequest): Promise<T> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);

  const deadline = new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

  const response = await Promise.race([
    request.fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal,
    }),
    deadline,
  ]);

  const text = await Promise.race([response.text(), deadline]);

  // The status comes BEFORE any decoding, and that ordering is the whole of
  // t156: over an error, the body is material for a log and never a reason for
  // an exception other than this door's.
  if (!response.ok) {
    throw request.buildError({ status: response.status, body: text });
  }

  return (text === '' ? undefined : JSON.parse(text)) as T;
}
