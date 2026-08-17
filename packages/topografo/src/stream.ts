/**
 * The watcher's ear: `GET /v1/events/stream?type=execution.finished` (t247, FR2).
 *
 * The protocol is the one `docs/spec/eventos-stream.md` publishes, and this is
 * the second Node-side implementation of it in the repository — the first being
 * the reference consumer that document writes out in its §8. What is ported
 * from there is the mechanic, not the shape: a generator, so that the caller's
 * `for await` body IS the processing step, which is what makes the cursor rule
 * of §5 true by construction rather than by remembering to update a variable.
 *
 * Three things this module is careful about, and each of them is a line of the
 * spec rather than a preference:
 *
 * - **the cursor is what was PROCESSED, never what arrived** (§5). The `yield`
 *   below is followed by the assignment, not preceded by it: control only comes
 *   back after the consumer finished with that event, so a drop mid-processing
 *   replays the event instead of skipping it. Replaying is safe — t246 keys a
 *   proposal by `(lens, target_version, operations)` and answers `200` with the
 *   one that is already pending — and skipping is not.
 * - **a refusal is not an outage** (§7). `400` (the filter is wrong) and `401`
 *   (the credential is missing or does not resolve) are configuration, and a
 *   retry loop over either is a process that looks alive and does nothing. They
 *   throw. `403` joins them for the same reason and on the same authority: §9
 *   documents it as the third credential answer this route has — a runner token
 *   presented here is out of scope, permanently, not momentarily.
 * - **everything else is a drop, and a drop is a reconnection** (§7, closing).
 *   A socket cut in half, a gateway answering `502`, a control plane that is not
 *   up yet: one fixed second, then try again, forever. The credential goes on
 *   every attempt, because every attempt is a new request (§2).
 *
 * There is no persisted cursor: a process that dies and comes back starts from
 * now (§5) and does not see what fired while it was down. That is the ticket's
 * declared gap, named rather than papered over.
 */

import { setTimeout as delay } from 'node:timers/promises';

/** The one event type this watcher subscribes to (t245, D21). */
export const FINISHED_EXECUTION = 'execution.finished';

/** Wait between a drop and the next attempt. Fixed, not exponential. */
export const DEFAULT_BACKOFF_MS = 1_000;

/**
 * Statuses that mean "denied", and never "try again later" (§7, §9).
 *
 * `400` is a contract error, `401` a credential that is absent or does not
 * resolve, `403` a credential whose scope does not reach this route. None of
 * the three improves by being asked a second time.
 */
const DENIED: ReadonlySet<number> = new Set([400, 401, 403]);

/**
 * The envelope of the taxonomy, in the subset this watcher reads.
 *
 * Deliberately open: everything the control plane records travels here whole
 * (§4), and a consumer that narrowed the shape would be re-declaring somebody
 * else's format. What this module promises is the two fields it dispatches on.
 */
export interface EventEnvelope {
  id: number;
  type: string;
  /** The round the event belongs to; `null` for a fact that has no round. */
  execution_id: number | null;
  [key: string]: unknown;
}

/** One SSE message, already decoded. */
export interface StreamMessage {
  /** The `id:` field — the cursor, and the only total order there is. */
  id: number;
  /** The `event:` field — the envelope's own type. */
  type: string;
  /** The `data:` field — the envelope, whole. */
  envelope: EventEnvelope;
}

/** The stream refused the connection, and a retry would not change that. */
export class StreamDeniedError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`the event stream answered ${status}: a retry does not fix a refusal`);
    this.name = 'StreamDeniedError';
    this.status = status;
    this.body = body;
  }
}

/** What one subscription needs to know. */
export interface StreamOptions {
  /** Base URL of the control plane. */
  url: string;
  /** Operator credential, presented on every connection attempt (§2). */
  token: string;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
  /** Wait between a drop and the next attempt. Default: 1s. */
  backoffMs?: number;
  /** Stops the subscription: the open connection is torn down and the loop ends. */
  signal?: AbortSignal;
  /** Where diagnostics go. Default: nowhere — this is a library, not a command. */
  log?: (message: string) => void;
}

/** Takes the trailing slash off the base URL, so as not to make `//v1/...`. */
function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** What to put in a log line about a failure, whatever it turned out to be. */
function reasonOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Decodes one SSE block into a message.
 *
 * @param block The text between two blank lines, without them.
 * @returns The message, or `null` when the block carries no event — a keep-alive
 *   comment (§6), or a block with no `data:` to decode.
 */
export function decodeBlock(block: string): StreamMessage | null {
  // Every line starting with ':' is a comment and is to be ignored (§6). A
  // block that is nothing but comments is the keep-alive, and it is not an
  // event: yielding it would make every idle 15 seconds look like news.
  const lines = block.split('\n').filter((line) => line !== '' && !line.startsWith(':'));
  if (lines.length === 0) return null;

  const fields = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1).replace(/^ /, ''));
  }

  const raw = fields.get('data');
  const id = Number(fields.get('id'));
  if (raw === undefined || !Number.isInteger(id)) return null;

  let envelope: EventEnvelope;
  try {
    envelope = JSON.parse(raw) as EventEnvelope;
  } catch {
    // A block that is not JSON is not a fact of the log: this stream is the
    // only writer of its own format, so a malformed one is a truncated read,
    // and the reconnection will bring it back whole.
    return null;
  }

  return { id, type: fields.get('event') ?? envelope.type, envelope };
}

/**
 * Reads one open body and yields the messages in it, in order.
 *
 * The buffering is what a `for await` over a socket forces: a chunk boundary
 * falls wherever TCP decided, so a message is only complete once the blank line
 * that closes it has arrived.
 */
async function* decodeBody(body: AsyncIterable<Uint8Array>): AsyncGenerator<StreamMessage> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const message = decodeBlock(block);
      if (message !== null) yield message;
      cut = buffer.indexOf('\n\n');
    }
  }
}

/** Waits out the backoff, and comes back early if the subscription was stopped. */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // The only way this rejects is the abort, which is not a failure: it is the
    // caller saying the loop above should end, and it checks that itself.
  }
}

/**
 * Subscribes to the finished rounds and yields each one, exactly once.
 *
 * Infinite by design: a stream that ends is a stream to reconnect to, never an
 * end. A caller stops it by breaking out of its `for await`, or by aborting the
 * signal it passed in.
 *
 * @param options Control plane, credential, and how to stop.
 * @returns Every `execution.finished`, in the order the log recorded it.
 * @throws {StreamDeniedError} On `400`, `401` or `403` — the three answers a
 *   retry cannot improve.
 */
export async function* watchFinishedExecutions(
  options: StreamOptions,
): AsyncGenerator<StreamMessage> {
  const doFetch = options.doFetch ?? fetch;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const log = options.log ?? ((): void => undefined);
  const target = `${normalize(options.url)}/v1/events/stream?type=${FINISHED_EXECUTION}`;

  // Read through a function, never through the narrowed expression: the checks
  // below are spread across an `await` each, and a compiler that remembers what
  // the flag was before one of them is remembering the wrong thing.
  const stopped = (): boolean => options.signal?.aborted === true;

  /** The last id this consumer FINISHED processing; `null` before the first. */
  let cursor: number | null = null;

  while (!stopped()) {
    let response: Response;
    try {
      response = await doFetch(target, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${options.token}`,
          // No header at all on the first attempt: without one the stream
          // starts at the present, which is what a fresh watcher wants (§5).
          ...(cursor === null ? {} : { 'last-event-id': String(cursor) }),
        },
        signal: options.signal,
      });
    } catch (failure) {
      if (stopped()) return;
      log(`stream unavailable: ${reasonOf(failure)}`);
      await pause(backoffMs, options.signal);
      continue;
    }

    if (DENIED.has(response.status)) {
      throw new StreamDeniedError(response.status, await response.text());
    }

    if (!response.ok || response.body === null) {
      log(`stream answered ${response.status}: reconnecting`);
      await pause(backoffMs, options.signal);
      continue;
    }

    log(`connected to ${target}${cursor === null ? '' : ` from event ${cursor}`}`);

    try {
      for await (const message of decodeBody(response.body as AsyncIterable<Uint8Array>)) {
        // An unknown type is to be ignored, never an error (§4). Under this
        // subscription the server sends nothing else, so this is the belt to
        // the filter's braces — and it deliberately leaves the cursor where it
        // is: replaying something this consumer ignored costs nothing.
        if (message.type !== FINISHED_EXECUTION) continue;

        yield message;

        // AFTER the consumer came back, and never before: the cursor is what
        // was processed (§5). A drop in the middle of a lens run replays that
        // event, which t246's deduplication makes harmless.
        cursor = message.id;
      }
    } catch (failure) {
      if (stopped()) return;
      log(`stream dropped: ${reasonOf(failure)}`);
    }

    if (stopped()) return;
    await pause(backoffMs, options.signal);
  }
}
