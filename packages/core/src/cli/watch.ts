/**
 * `cartografo watch` — a terminal tail of the event stream (t543, D26).
 *
 * The control plane already serves `GET /v1/events/stream`
 * (`docs/spec/events-stream.md`, `src/routes/events.ts`) and one Node-side
 * consumer of it already exists: `packages/surveyor/src/stream.ts`. What lives
 * HERE is a second, independent implementation of the same protocol — decode,
 * reconnect, the "cursor is what was PROCESSED, never what arrived" rule — not
 * an import of that one. `reads.ts`'s own header already documents why: this
 * package has never depended on `packages/screen`'s `src/`, and the same
 * boundary holds for `packages/surveyor`'s `src/`, in the other direction.
 *
 * Two differences from the surveyor's version, both because this consumer
 * serves a person at a terminal rather than one lens pinned to one type:
 *
 * - it decodes EVERY event type — the server is asked for no `?type=` at all —
 *   because the line format (`job=`, `node=`) and the `--job`/`--execution`
 *   filters both read fields that live on types beyond any single one;
 * - `--job` and `--execution` are never sent to the server (the route has no
 *   such parameter, `docs/spec/events-stream.md` §3) and are applied
 *   client-side, to every envelope, before it is printed.
 *
 * The exit-code boundary mirrors `status`'s own posture: the FIRST connection
 * attempt failing outright (`fetch` throws) is treated the same way `status`
 * treats an unreachable server — a `NetworkError`, which `runCli`'s own catch
 * already turns into `serverDownMessage` and exit `1`. Everything after that
 * first attempt is a drop to reconnect from, forever, on the surveyor's fixed
 * 1s backoff — except `400`/`401`/`403`, which are a refusal and not an
 * outage, on ANY attempt.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { NetworkError, UsageError, requestJson } from './url.ts';

/** Wait between a drop and the next reconnect attempt. Fixed, not exponential. */
export const DEFAULT_BACKOFF_MS = 1_000;

/** Statuses that mean "denied", and never "try again later" (events-stream.md §7). */
const DENIED: ReadonlySet<number> = new Set([400, 401, 403]);

/**
 * The envelope of the taxonomy, in the shape this command reads.
 *
 * Deliberately open (`[key: string]: unknown`): everything the control plane
 * writes travels here whole, and narrowing the type would be re-declaring
 * somebody else's format. `entity.id` is `number | string` because it is a
 * job/session/execution id (a number) for most types and the hash of a graph
 * version (a string) for `graph_version.*` (specs/events/taxonomy.md).
 */
export interface EventEnvelope {
  id: number;
  type: string;
  project_id: number;
  execution_id: number | null;
  entity: { type: string; id: number | string };
  actor: { type: string; ref: string };
  occurred_at: string;
  data: Record<string, unknown>;
  [key: string]: unknown;
}

/** The stream refused the connection outright — a retry would not change that. */
export class StreamDeniedError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`the event stream answered ${status}`);
    this.name = 'StreamDeniedError';
    this.status = status;
    this.body = body;
  }
}

/** Options of `watch`, as the router hands them over. */
export interface WatchOptions {
  url: string;
  token?: string;
  projectId: number;
  jobId?: number;
  executionId?: number;
  since?: number;
  fromStart: boolean;
  json: boolean;
  untilDone: boolean;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
  /** Wait between a drop and the next attempt. Default: 1s. */
  backoffMs?: number;
  /** Stops the watch: the open connection is torn down and the loop ends. */
  signal?: AbortSignal;
}

/**
 * Reads `--job`/`--execution`/`--since`/`--from-start`/`--until-done` for the
 * two rules the wire cannot enforce (FR2): `--since` and `--from-start` name
 * the same thing two ways, and `--until-done` needs exactly one scope to know
 * when it is done.
 *
 * Pure and synchronous, on purpose, like `export-history`'s `historyScope`: a
 * wrong command line costs the server nothing (AT6), so this runs before any
 * request goes out.
 *
 * @throws {UsageError} On `--since` with `--from-start`, or `--until-done`
 *   with zero or two of `--job`/`--execution`.
 */
export function validateWatchFlags(flags: {
  job?: number;
  execution?: number;
  since?: number;
  fromStart: boolean;
  untilDone: boolean;
}): void {
  if (flags.since !== undefined && flags.fromStart) {
    throw new UsageError('watch: --since and --from-start are mutually exclusive');
  }
  if (flags.untilDone) {
    const scopes = [flags.job, flags.execution].filter((value) => value !== undefined);
    if (scopes.length !== 1) {
      throw new UsageError('watch --until-done needs exactly one of --job or --execution');
    }
  }
}

/** Trims a trailing slash, so as not to make `//v1/...`. */
function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Decodes one SSE block into an envelope.
 *
 * Ported from `packages/surveyor/src/stream.ts`'s `decodeBlock`, simplified:
 * this command has no use for the `event:`/`id:` fields on their own, since
 * the JSON in `data:` already carries the same `type` and `id`
 * (events-stream.md §4, "byte for byte the same envelope").
 *
 * @param block The text between two blank lines, without them.
 * @returns The envelope, or `null` for a block that carries no event — the
 *   keep-alive comment (§6), or one with no `data:` to decode.
 */
function decodeBlock(block: string): EventEnvelope | null {
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

  try {
    return JSON.parse(raw) as EventEnvelope;
  } catch {
    // Not JSON: a truncated read, not a fact of the log. The reconnection
    // brings it back whole.
    return null;
  }
}

/** Reads one open body and yields the envelopes in it, in order. */
async function* decodeBody(body: AsyncIterable<Uint8Array>): AsyncGenerator<EventEnvelope> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let cut = buffer.indexOf('\n\n');
    while (cut !== -1) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const envelope = decodeBlock(block);
      if (envelope !== null) yield envelope;
      cut = buffer.indexOf('\n\n');
    }
  }
}

/** Waits out the backoff, and comes back early if the watch was stopped. */
async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // The only way this rejects is the abort, which the caller's own
    // `stopped()` notices — not a failure to report.
  }
}

/**
 * `--job <id>` (FR8): the job named in `entity`, or the one named in
 * `data.job_id` — the fields `session.opened`, `input_request.created` and
 * `lease.granted` carry, per `specs/events/taxonomy.md`.
 *
 * The gap FR8 names and Out of Scope leaves open: `session.finished`,
 * `session.permission_denied` and the two `input_request.answered`/
 * `.auto_resolved` types carry no `job_id` of their own, so this filter never
 * shows them.
 */
function matchesJob(envelope: EventEnvelope, jobId: number): boolean {
  if (envelope.entity.type === 'job' && envelope.entity.id === jobId) return true;
  const dataJobId = envelope.data.job_id;
  return typeof dataJobId === 'number' && dataJobId === jobId;
}

/** `--execution <id>` (FR9): the envelope's own top-level `execution_id`. */
function matchesExecution(envelope: EventEnvelope, executionId: number): boolean {
  return envelope.execution_id === executionId;
}

/** Whether an envelope passes the client-side `--job`/`--execution` filters. */
function passesFilters(envelope: EventEnvelope, options: WatchOptions): boolean {
  if (options.jobId !== undefined && !matchesJob(envelope, options.jobId)) return false;
  if (options.executionId !== undefined && !matchesExecution(envelope, options.executionId)) return false;
  return true;
}

/** `job=<id>` (FR6): `entity.id` when it is the job, else `data.job_id`, else `-`. */
function jobIdOf(envelope: EventEnvelope): number | string {
  if (envelope.entity.type === 'job') return envelope.entity.id;
  const dataJobId = envelope.data.job_id;
  return typeof dataJobId === 'number' ? dataJobId : '-';
}

/** `node=<id>` (FR6): `data.node_id` when it is a string, else `-`. */
function nodeIdOf(envelope: EventEnvelope): string {
  const nodeId = envelope.data.node_id;
  return typeof nodeId === 'string' ? nodeId : '-';
}

/** One human line (FR6). */
function humanLine(envelope: EventEnvelope): string {
  return `${envelope.occurred_at} ${envelope.actor.type}:${envelope.actor.ref} ${envelope.type} job=${jobIdOf(
    envelope,
  )} node=${nodeIdOf(envelope)} ${JSON.stringify(envelope.data)}`;
}

/** The message to print for a `400`/`401`/`403` (FR5) — the body's own `message`, when there is one. */
function deniedBodyMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; details?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (Array.isArray(parsed.details)) return parsed.details.map(String).join('; ');
  } catch {
    // Not JSON: the raw body is all there is to print.
  }
  return body;
}

/**
 * Subscribes to the whole project's event stream and yields every envelope
 * that passes the client-side filters, in `id` order, reconnecting forever
 * past the first successful connection (FR3–FR5).
 *
 * @throws {NetworkError} When the very first attempt cannot reach the control
 *   plane at all — the caller lets this propagate to `runCli`'s own handling.
 * @throws {StreamDeniedError} On `400`/`401`/`403`, on any attempt.
 */
export async function* watchEvents(options: WatchOptions): AsyncGenerator<EventEnvelope> {
  const doFetch = options.doFetch ?? fetch;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const target = `${normalize(options.url)}/v1/events/stream?project_id=${options.projectId}`;

  const stopped = (): boolean => options.signal?.aborted === true;

  // Absent by default (starts from now); `--since`'s value when given; `0`
  // when `--from-start` is given, which reads the whole log (`id > 0`,
  // `routes/events.ts:135-152`).
  let cursor: number | null = options.since ?? (options.fromStart ? 0 : null);
  let firstAttempt = true;

  while (!stopped()) {
    let response: Response;
    try {
      response = await doFetch(target, {
        headers: {
          accept: 'text/event-stream',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(cursor === null ? {} : { 'last-event-id': String(cursor) }),
        },
        signal: options.signal,
      });
    } catch (failure) {
      if (stopped()) return;
      // Only the FIRST attempt turns an unreachable server into a fatal exit
      // (FR5) — every later drop, including a thrown fetch, is retried.
      if (firstAttempt) throw new NetworkError(options.url, failure);
      await pause(backoffMs, options.signal);
      continue;
    }
    firstAttempt = false;

    if (DENIED.has(response.status)) {
      throw new StreamDeniedError(response.status, await response.text());
    }

    if (!response.ok || response.body === null) {
      await pause(backoffMs, options.signal);
      continue;
    }

    try {
      for await (const envelope of decodeBody(response.body as AsyncIterable<Uint8Array>)) {
        if (!passesFilters(envelope, options)) continue;
        yield envelope;
        // AFTER the caller printed it, never before: the cursor is what this
        // process PRINTED (FR5), the same rule the surveyor's own consumer
        // keeps for what it processed.
        cursor = envelope.id;
      }
    } catch (failure) {
      if (stopped()) return;
      void failure; // a drop mid-stream; falls through to the reconnect below.
    }

    if (stopped()) return;
    await pause(backoffMs, options.signal);
  }
}

/**
 * `--until-done`'s terminal check (FR10/FR11), on an envelope already known to
 * have passed the `--job`/`--execution` filter.
 *
 * Execution-scoped: the `execution.finished` event named by `--execution` IS
 * the terminal signal (FR10), no extra call. Job-scoped: every
 * `job.transitioned` of the job named by `--job` (which, by construction, is
 * every one the filter let through) triggers one `GET /v1/jobs/:id`, and the
 * server's own `completed` decides (FR11) — the same computation `job <id>`
 * already relies on (`reads.ts`'s `JobRead.completed`).
 */
async function isDone(envelope: EventEnvelope, options: WatchOptions): Promise<boolean> {
  if (options.executionId !== undefined) {
    return envelope.type === 'execution.finished' && envelope.entity.id === options.executionId;
  }
  if (options.jobId !== undefined) {
    if (envelope.type !== 'job.transitioned') return false;
    const response = await requestJson(`${options.url}/v1/jobs/${options.jobId}?project_id=${options.projectId}`);
    const body = response.body as { completed?: unknown };
    return body.completed === true;
  }
  return false;
}

/**
 * Runs `cartografo watch`.
 *
 * SIGINT (FR12): a handler of its own, `process.on('SIGINT', ...)` — not
 * `up.ts`'s `STOP_SIGNALS`, which also catches `SIGTERM`; this command leaves
 * that one to the process default, by the ticket's own line. Aborting the
 * shared `AbortSignal` is what makes the in-flight `fetch` (or the read of its
 * body) end, which is what lets the loop below return instead of reconnecting.
 *
 * @param options Scope, filters and output format, already validated.
 * @returns `0` on `--until-done` reaching its terminal event, or on a clean
 *   `SIGINT`; `1` on a `400`/`401`/`403` refusal. A `NetworkError` on the
 *   first attempt propagates to `runCli`'s own handling.
 */
export async function runWatch(options: WatchOptions): Promise<number> {
  const controller = new AbortController();
  const handleSigint = (): void => controller.abort();
  process.on('SIGINT', handleSigint);

  try {
    for await (const envelope of watchEvents({ ...options, signal: controller.signal })) {
      process.stdout.write(`${options.json ? JSON.stringify(envelope) : humanLine(envelope)}\n`);

      if (options.untilDone && (await isDone(envelope, options))) {
        return 0;
      }
    }
    // The generator only returns without throwing when `stopped()` became
    // true — a clean SIGINT, never a plain end of stream (FR3–FR5 keep it
    // reconnecting forever otherwise).
    return 0;
  } catch (failure) {
    if (failure instanceof StreamDeniedError) {
      process.stderr.write(`cartografo: ${deniedBodyMessage(failure.body)}\n`);
      return 1;
    }
    throw failure;
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }
}
