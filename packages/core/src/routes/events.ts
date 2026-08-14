/**
 * Outbound event stream (t123, FR1–FR8).
 *
 * Extension point nº 5 of `notas/2026-08-14-extensao-e-qualidade.md`: every
 * published transition should reach an outside integration without anybody
 * touching the core. The taxonomy is the contract
 * (`especificacoes/eventos/taxonomia.md`); this route is the transport, and the
 * public spec a third party builds a client from is
 * `docs/spec/eventos-stream.md`.
 *
 * Three decisions are worth knowing before reading the code:
 *
 * - **SSE, not WebSocket.** The traffic is one-directional and the envelope
 *   already carries the monotonic `id` that `Last-Event-ID` wants, so the
 *   reconnect protocol comes for free and no new dependency enters the repo.
 * - **The stream POLLS, it is never wired into the insert.** `recordEvent` does
 *   not know this file exists, and that is the point (FR6): a consumer that
 *   stopped reading can slow down its own connection and nothing else. The
 *   price is up to one poll interval of latency, which for telemetry is nothing.
 * - **The cursor IS the envelope's `id`** — "the only total ordering there is"
 *   (`especificacoes/eventos/taxonomia.md:52`). There is no `desde_id` query
 *   parameter alongside it: one resume mechanism, not two ways to do the same
 *   thing.
 *
 * The `MAX(id)` read below is the only SQL in this file, and it is a READ — the
 * log keeps its single writer (`src/db/events.ts`, D1). It does not become a
 * fourth function there because that module's export list is a contract
 * (`test/event-append-only.test.ts`, AT16), and the same direct read of the
 * table already has a precedent in `src/repositories/job.ts:283-289`.
 *
 * The event-type strings and the query field names stay in Portuguese: they are
 * the taxonomy's vocabulary and the wire format (t127, FR8).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { KNOWN_TYPES, ValidationError } from '../db/event-validation.ts';
import { listEvents, type EventFilter } from '../db/events.ts';
import { integerFromQuery } from '../repositories/common.ts';
import { withValidation } from './common.ts';

/** How often an open connection looks for events past its cursor. */
export const DEFAULT_POLL_INTERVAL_MS = 300;

/** How long a silent connection waits before the keep-alive comment (FR5). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Ceiling of events one poll tick may read (FR8).
 *
 * A consumer reconnecting far behind is caught up in several bounded reads
 * instead of one unbounded burst; the tick keeps looping until it is up to date.
 */
export const POLL_CEILING = 500;

/**
 * Clocks of the stream, injectable for the same reason as the runner's
 * heartbeat (`packages/runner/src/controller/controller.ts:147-152`): a test
 * cannot wait 15 real seconds to see a keep-alive.
 */
export interface StreamOptions {
  /** Interval between polls. Default: `DEFAULT_POLL_INTERVAL_MS`. */
  pollIntervalMs?: number;
  /** Interval of the keep-alive. Default: `DEFAULT_HEARTBEAT_INTERVAL_MS`. */
  heartbeatIntervalMs?: number;
}

/** One open connection, with everything it needs to keep pushing. */
interface Connection {
  request: FastifyRequest;
  reply: FastifyReply;
  db: Database;
  /** Slice asked for in the query string; the same for every tick. */
  filter: EventFilter;
  /** Highest id already delivered — where the next read starts. */
  cursor: number;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
}

/**
 * Reads the query string into a filter, or throws (FR3).
 *
 * An invalid value is a 400 and never a filter silently ignored: "nothing came"
 * and "something wrong came" are different questions
 * (`src/repositories/common.ts:97-105`).
 */
function readFilter(query: unknown): EventFilter {
  const asked = (query ?? {}) as { projeto_id?: string; tipo?: string };
  return {
    projetoId: integerFromQuery('projeto_id', asked.projeto_id),
    tipos: readTypes(asked.tipo),
  };
}

/**
 * Reads `?tipo=a,b` against the taxonomy's catalogue.
 *
 * The list of types is not re-declared here: `KNOWN_TYPES` already is the
 * catalogue (`src/db/event-validation.ts`), and a second copy would be a second
 * thing to forget to update when the taxonomy grows.
 */
function readTypes(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw === '') return undefined;

  const asked = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');

  const strangers = asked.filter((item) => !KNOWN_TYPES.includes(item));
  if (strangers.length > 0) {
    throw new ValidationError(
      strangers.map((item) => `tipo "${item}" is not in the taxonomy (see KNOWN_TYPES)`),
    );
  }

  return asked.length === 0 ? undefined : asked;
}

/**
 * Where this connection starts reading (FR4).
 *
 * With `Last-Event-ID`, everything recorded after that id — the reconnect the
 * browser's `EventSource` performs by itself. Without it, the id current at
 * connection time: a first-time consumer gets the log from NOW on, and never
 * a surprise replay of the whole history.
 */
function readCursor(header: string | string[] | undefined, db: Database): number {
  const declared = Array.isArray(header) ? header[0] : header;

  if (declared !== undefined && declared !== '') {
    const parsed = Number(declared);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ValidationError([
        `Last-Event-ID has to be the integer id of an event (got: ${declared})`,
      ]);
    }
    return parsed;
  }

  const row = db.prepare('SELECT MAX(id) AS last_id FROM evento').get() as {
    last_id: number | null;
  };
  return row.last_id ?? 0;
}

/**
 * Takes the response over and starts pushing.
 *
 * From `hijack()` on, Fastify is out of this connection's lifecycle: the
 * headers, every message and the end of the response are written here, and the
 * two timers are cleared exactly once, by `release`.
 *
 * @param connection Everything the connection needs.
 * @param open Set of live connections, so a server shutdown can end them.
 */
function begin(connection: Connection, open: Set<() => void>): void {
  const { request, reply, db, filter } = connection;
  let cursor = connection.cursor;
  let lastWrite = Date.now();

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Reverse proxies buffer a response body by default, which turns a stream
    // back into a batch; this is the header that asks them not to.
    'x-accel-buffering': 'no',
  });
  raw.flushHeaders();

  const alive = (): boolean => !raw.writableEnded && !raw.destroyed;

  const drain = (): void => {
    while (alive()) {
      const batch = listEvents(db, { ...filter, sinceId: cursor, limit: POLL_CEILING });
      if (batch.length === 0) return;

      for (const event of batch) {
        raw.write(`id: ${event.id}\nevent: ${event.tipo}\ndata: ${JSON.stringify(event)}\n\n`);
        cursor = event.id;
      }
      lastWrite = Date.now();

      // A full batch means there may be more behind it: keep reading, in bounded
      // steps, until this tick is caught up (FR8).
      if (batch.length < POLL_CEILING) return;
    }
  };

  const poll = setInterval(drain, connection.pollIntervalMs);
  if (typeof poll.unref === 'function') poll.unref();

  /**
   * The keep-alive, measured from the LAST byte written and not from a fixed
   * grid: a stream that went quiet 14s after an event owes a comment in one
   * second, not in sixteen. With a fixed interval, an event landing just after a
   * tick buys the connection two whole intervals of silence — which is exactly
   * the idle window the comment exists to stay under.
   */
  let heartbeat: NodeJS.Timeout;
  const beat = (): void => {
    if (!alive()) return;
    if (Date.now() - lastWrite >= connection.heartbeatIntervalMs) {
      raw.write(': heartbeat\n\n');
      lastWrite = Date.now();
    }
    // Whatever is left of the interval counted from the last byte — never zero,
    // which is what would turn this clock into a busy loop.
    const wait = Math.max(connection.heartbeatIntervalMs - (Date.now() - lastWrite), 1);
    heartbeat = setTimeout(beat, wait);
    // `unref`ed, like the runner's heartbeat: an open connection is no reason
    // for the process to stay up on its own.
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  };
  beat();

  const release = (): void => {
    clearInterval(poll);
    clearTimeout(heartbeat);
    open.delete(release);
    if (alive()) raw.end();
  };

  open.add(release);
  // The client going away and the socket erroring are the same event as far as
  // this connection is concerned: stop the clocks, let the resources go (FR7).
  request.raw.on('close', release);
  raw.on('error', release);

  // The first read happens now, not one interval from now: whoever reconnects
  // with a cursor wants the backlog immediately.
  drain();
}

/**
 * Registers the stream route in the `/v1` scope.
 *
 * @param app Already prefixed scope.
 * @param db Open database.
 * @param options Injected clocks; production uses the defaults.
 */
export function registerEvents(
  app: FastifyInstance,
  db: Database,
  options: StreamOptions = {},
): void {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  /** Live connections of this app, each one under the function that ends it. */
  const open = new Set<() => void>();

  // `preClose` and not `onClose`: Fastify waits for the open sockets BEFORE
  // running `onClose`, so a stream nobody closed would hold the shutdown
  // forever. Here the connections are ended first, and the shutdown proceeds
  // (FR7).
  app.addHook('preClose', async () => {
    for (const release of [...open]) release();
  });

  app.get('/events/stream', async (request, reply) =>
    withValidation(reply, () => {
      const filter = readFilter(request.query);
      const cursor = readCursor(request.headers['last-event-id'], db);

      // Nothing above this line wrote a byte: a bad filter answers 400 with the
      // ordinary JSON body, and never a stream that opens and then apologizes
      // (FR3).
      begin(
        { request, reply, db, filter, cursor, pollIntervalMs, heartbeatIntervalMs },
        open,
      );
      return undefined;
    }),
  );
}
