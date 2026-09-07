/**
 * The way out: a node's declared outputs, delivered once (t371; RF-33, RF-35,
 * RF-36, RF-37).
 *
 * `resolve-external-inputs.ts` is the other direction, and the two share this
 * folder and almost nothing else. Fetching happens BEFORE a session, where
 * everything that fails is free; delivering happens after one is terminal AND
 * after the control plane has accepted what it reported, where nothing is free
 * at all — a call made here has already left the machine, and no part of this
 * system can take it back.
 *
 * ## Four claims, and where each one is enforced
 *
 * **The write happens only after the checks pass (RF-33), and structurally.**
 * This module is called from inside `report.ts`'s `advance()`, which
 * `dispatch.ts` only reaches when five conditions hold: a resolved node, a
 * session that COMPLETED, no pending question, no dirty worktree, and a report
 * the control plane ACCEPTED. There is no code path from a refused report to a
 * delivery — not by convention, but because the function is never entered.
 *
 * **It happens once (RF-35).** Before every attempt, the log itself is asked:
 * has this job, on this node, already delivered this name?
 * `GET /v1/jobs/:id/external-calls?node_id=&name=&direction=output` is that
 * question, and a settled row is what makes the answer yes. A row that was
 * OPENED and never closed is not settled and not absent either — it is the one
 * genuinely ambiguous state, and the two node classes read it differently, which
 * is the next claim.
 *
 * **A step that cannot be repeated is not repeated (RF-36).** `unsafe_to_retry`
 * buys exactly one attempt and no ladder. A refusal, a deadline, or a dangling
 * row from an attempt that crashed all go the same way: a person is asked
 * "retry, skip this output, or mark as done?", tagged `origin:
 * external_output_write` so that the runner can recognise its own question
 * before it opens anything. A safe node gets the opposite treatment — a small,
 * local ladder around the CALL, never around the session.
 *
 * **Every call is written down (RF-37).** Two phases per attempt, t370's shape:
 * an intent before, an outcome after. Including the attempts that were not made
 * — a skip is a decision, and "nobody called anybody" and "somebody looked,
 * found it already delivered, and stood down" are different things to read six
 * weeks later.
 *
 * ## The two carve-outs, named rather than smuggled
 *
 * The question this module raises is posted **whatever the node's
 * `escalation_policy` says, `never` included**. `never` governs a node's own
 * business doubts having nobody to ask; this is the platform asking about a side
 * effect it already attempted, which is a different question and one no graph
 * author opted out of.
 *
 * And two of its three answers **do not redispatch**. "Resuming is
 * redispatching" (`docs/spec/human-escalation.md` §5) is the rule everywhere
 * else, and here it would be the bug: re-opening the step's session is exactly
 * the repeat `unsafe_to_retry` exists to prevent. So `skip this output` and
 * `mark as done` are settled from the ORIGINAL session's stored report, with no
 * worktree and no session at all. `retry` is the one answer that legitimately
 * uses the ordinary mechanism — a person authorised trying the call again, and
 * the skill itself never touches the external system.
 *
 * Both carve-outs are keyed on {@link EXTERNAL_OUTPUT_WRITE_ORIGIN} and on
 * nothing else. This is not a general "resume without redispatch" capability.
 *
 * Nothing here touches the database, and nothing here opens a control plane of
 * its own: every write rides the ONE client `dispatch.ts` builds (D1, D11).
 *
 * English per D24.
 */

import { createHash } from 'node:crypto';

import { blockForExternalOutputFailure, type JobRef } from '../dispatch/blocks.ts';
import { withProject, type ControlPlaneCall } from '../dispatch/control-plane-client.ts';
import { interpolate } from '../dispatch/interpolate-input.ts';
import {
  isUnsafeToRetry,
  resolveNode,
  type ExternalOutputDeclaration,
  type GraphVersionBody,
  type JobPosition,
  type ResolvedNode,
} from '../dispatch/resolve-node.ts';
import { selectAndTransition } from '../dispatch/routing.ts';
import { RUNNER_ACTOR_REF } from '../dispatch/blocks.ts';
import type { EngineAdapter, McpServerConnection } from '../engine/types.ts';
import { createMcpClient, McpTimeoutError, type McpClientLike } from './client.ts';

/**
 * The tag this module puts on the one question it raises (t371, FR6).
 *
 * A value of `input_request.origin`, which is open text and carries no `CHECK`:
 * whatever starts tagging itself next adds no migration
 * (`0035_input_request_origin.sql`).
 */
export const EXTERNAL_OUTPUT_WRITE_ORIGIN = 'external_output_write';

/** The three answers that question offers, in the order a person reads them. */
export const EXTERNAL_OUTPUT_WRITE_OPTIONS: readonly string[] = Object.freeze([
  'retry',
  'skip this output',
  'mark as done',
]);

/**
 * The outcomes that mean "this delivery is settled; do not make it again".
 *
 * Four of the five values the column takes. `error` is the fifth and is
 * deliberately not here: a call that failed left nothing on the far side, so
 * repeating it is not repeating a delivery.
 */
const SETTLED_OUTCOMES: readonly string[] = Object.freeze([
  'ok',
  'skipped_duplicate',
  'skipped_by_person',
  'marked_done_by_person',
]);

/** How the whole delivery step ended, for the one caller that maps it. */
export type ExternalOutputStep =
  /** Every declared output is settled; the work may move. */
  | { readonly kind: 'written' }
  /** The work was stopped with this reason; it may not move. */
  | { readonly kind: 'blocked'; readonly reason: string }
  /** A person was asked; the work is blocked behind the question itself. */
  | { readonly kind: 'asked' };

/**
 * The signature `report.ts` calls this step through.
 *
 * Injected rather than imported, on `MainLineAdvancer`'s own precedent: the
 * ORDER is `report.ts`'s to guarantee and the delivery is not, so that module
 * names the seam and this one fills it. Absent is ordinary — a dispatch wired
 * without the MCP window, which is every dispatch this package's older tests
 * build — and then nothing is delivered and nothing changes.
 */
export type ExternalOutputWriter = (
  call: ControlPlaneCall,
  job: JobRef,
  resolved: ResolvedNode,
  sessionId: number,
  report: Record<string, unknown> | null,
) => Promise<ExternalOutputStep>;

/** One row of `external_call`, in the part this module reads. */
interface ExternalCallRow {
  id: number;
  node_id: string;
  direction: string;
  name: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  result_summary: string | null;
}

/** One answered question, in the part this module reads. */
interface AnsweredQuestion {
  id: number;
  session_id: number | null;
  node_id: string | null;
  answer: string | null;
  answered_by: string | null;
}

/** One session, in the part this module reads. */
interface StoredSession {
  id: number;
  output: Record<string, unknown> | null;
}

/** Everything the delivery needs that is not the report itself. */
export interface ExternalOutputWiring {
  /** The engine this node routes to, for its two MCP capabilities. */
  readonly adapter: EngineAdapter;
  /** Deadline of each `tools/call`, in milliseconds. */
  readonly callTimeoutMs: number;
  /** Project every scoped read of this step names (t410). */
  readonly projectId?: number;
  /** Attempts a SAFE node's delivery gets, in total. */
  readonly maxAttempts?: number;
  /** What it waits between them, rung by rung. */
  readonly backoffMs?: readonly number[];
  /** Test seam: what the ladder waits with. Default: a real timer. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Test seam: builds the client for a resolved connection. */
  readonly createClient?: (connection: McpServerConnection) => McpClientLike;
}

/** A real wait, which is what the ladder uses when nobody replaced it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** sha256, hex — of the canonical arguments. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The arguments as one deterministic string, for the digest and the summary. */
function canonicalArguments(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = args[key];
  return JSON.stringify(sorted);
}

/** The entry's three names, filled in where the declaration left a gap. */
function named(entry: ExternalOutputDeclaration): {
  name: string;
  server: string;
  tool: string;
  from: string;
} {
  return {
    name: entry.name ?? '(unnamed)',
    server: entry.server ?? '(unnamed)',
    tool: entry.tool ?? '(unnamed)',
    from: entry.from ?? '(unnamed)',
  };
}

/**
 * What a delivery's `{{input.<path>}}` placeholders resolve against.
 *
 * NOT the node's input, which is the fetch direction's context and is gone by
 * the time this runs: a delivery is about what the step PRODUCED. Two drawers,
 * both named after what is in them —
 *
 * - `job` — the work's id and the node it is standing on, which is what
 *   `docs/spec/graph.md`'s own example interpolates
 *   (`"folder": "clients/{{input.job.id}}"`);
 * - `output` — the accepted report, whole, so a declaration can name any
 *   property of it and not only the one at `from`.
 *
 * The `{{input.…}}` prefix is the manifest format's single placeholder grammar
 * and is kept as-is: a second grammar for one more context would be two
 * fail-closed rules, and two copies of a fail-closed rule is one copy waiting to
 * fail open (`interpolate-input.ts`).
 */
function deliveryContext(job: JobRef, report: Record<string, unknown> | null): Record<string, unknown> {
  return {
    job: { id: job.id, node_id: job.current_node_id },
    output: report ?? {},
  };
}

/** Whether a declaration reaches into the report on its own account. */
function namesTheReport(args: Record<string, unknown>): boolean {
  return Object.values(args).some(
    (value) => typeof value === 'string' && value.includes('{{input.output.'),
  );
}

/**
 * The arguments of one delivery, resolved.
 *
 * Two steps, and the second one is the whole of what `from` means on the wire.
 * First every string value is interpolated against {@link deliveryContext},
 * fail-closed exactly as `render-skill-instructions.ts` already is: a path that
 * does not resolve does not become text. Then the value being delivered is added
 * under the key `from` names — one name for one thing, so a graph that declares
 * `"from": "proposal"` sends an argument called `proposal`.
 *
 * Unless the declaration already named the report itself. `{{input.output.…}}`
 * anywhere in the arguments means the author is driving the payload — putting it
 * under the key their tool actually expects — and adding a second copy under a
 * name they did not choose would send a server a parameter it never published.
 *
 * @returns The arguments, or the paths that did not resolve.
 */
function resolveArguments(
  entry: ExternalOutputDeclaration,
  job: JobRef,
  report: Record<string, unknown> | null,
  value: unknown,
): { args: Record<string, unknown> } | { unresolved: string[] } {
  const declared = entry.arguments ?? {};
  const context = deliveryContext(job, report);
  const unresolved: string[] = [];
  const args: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(declared)) {
    args[key] = typeof raw === 'string' ? interpolate(raw, context, unresolved) : raw;
  }

  if (unresolved.length > 0) return { unresolved };

  if (!namesTheReport(declared)) args[named(entry).from] = value;

  return { args };
}

/**
 * Where a delivery's record goes, and where its history is read from.
 *
 * The read half is what t370's `ExternalCallRecorder` does not have, and it is
 * the whole of RF-35: an interface rather than a client, so that this module
 * opens no connection of its own and the credential keeps exactly one owner.
 */
interface DeliveryJournal {
  settled(entry: { nodeId: string; name: string }): Promise<ExternalCallRow[]>;
  intent(call: {
    nodeId: string;
    name: string;
    server: string;
    tool: string;
    argumentsSha256: string;
    argumentsSummary: string;
  }): Promise<number | null>;
  complete(callId: number, outcome: { outcome: string; resultSummary: string }): Promise<void>;
}

/** The journal, built out of the dispatch's own client. */
function journalFor(
  call: ControlPlaneCall,
  jobId: number,
  projectId: number | undefined,
): DeliveryJournal {
  const route = withProject(`/v1/jobs/${String(jobId)}/external-calls`, projectId);

  return {
    settled: async (entry) => {
      const query =
        `node_id=${encodeURIComponent(entry.nodeId)}` +
        `&name=${encodeURIComponent(entry.name)}` +
        '&direction=output';
      const listed = await call<{ external_calls: ExternalCallRow[] }>(
        withProject(`/v1/jobs/${String(jobId)}/external-calls?${query}`, projectId),
        'GET',
      );
      return listed.external_calls;
    },
    intent: async (intent) => {
      const created = await call<{ external_call: { id: number } }>(route, 'POST', {
        node_id: intent.nodeId,
        direction: 'output',
        name: intent.name,
        server: intent.server,
        tool: intent.tool,
        arguments_sha256: intent.argumentsSha256,
        arguments_summary: intent.argumentsSummary,
        started_at: new Date().toISOString(),
      });
      return created.external_call.id;
    },
    complete: async (callId, outcome) => {
      await call(route, 'POST', {
        call_id: callId,
        finished_at: new Date().toISOString(),
        outcome: outcome.outcome,
        result_summary: outcome.resultSummary,
      });
    },
  };
}

/** A row nobody closed: an attempt whose fate this system never recorded. */
function isDangling(row: ExternalCallRow): boolean {
  return row.outcome === null;
}

/** ...and one that says this delivery is done, however it got done. */
function isSettled(row: ExternalCallRow): boolean {
  return row.outcome !== null && SETTLED_OUTCOMES.includes(row.outcome);
}

/** What one attempt at a tool answered. */
type Attempt = { ok: true; summary: string } | { ok: false; detail: string; timedOut: boolean };

/** The text of a refused call, for the reason a person reads. */
function describeErrorResult(content: readonly unknown[]): string {
  const first = content[0];
  if (typeof first === 'object' && first !== null) {
    const text = (first as { text?: unknown }).text;
    if (typeof text === 'string' && text !== '') return text;
  }
  return 'the tool answered isError with no message';
}

/**
 * One `tools/call`, classified.
 *
 * A deadline and a refusal are different facts and stay different all the way
 * up: a server that accepted the message and went quiet may well have DONE the
 * thing, which is the whole reason an unsafe node treats a timeout exactly as it
 * treats a dangling row.
 */
async function attempt(
  client: McpClientLike,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Attempt> {
  try {
    const result = await client.callTool(tool, args, timeoutMs);
    // `isError: true` is the tool refusing, which is a RESULT and not a protocol
    // failure — the same distinction the fetch direction already draws.
    if (result.isError === true) {
      return { ok: false, detail: describeErrorResult(result.content), timedOut: false };
    }
    const answered = describeErrorResult(result.content);
    return { ok: true, summary: answered };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      timedOut: error instanceof McpTimeoutError,
    };
  }
}

/** How this delivery could not be started at all — before any call. */
class DeliverySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeliverySetupError';
  }
}

/**
 * Builds the client for one server, or says why it could not.
 *
 * The same three questions the fetch direction asks, in the same order and for
 * the same reasons: a server nobody's engine names, a connection nobody can
 * read, and a tool the server does not publish are three different facts fixed
 * in three different places.
 */
async function connect(
  wiring: ExternalOutputWiring,
  server: string,
  tool: string,
): Promise<McpClientLike> {
  const { adapter } = wiring;

  const discovered =
    typeof adapter.discoverMcpServers === 'function'
      ? new Set((await adapter.discoverMcpServers()).servers.map((one) => one.name))
      : null;
  if (discovered === null || !discovered.has(server)) {
    throw new DeliverySetupError(
      discovered === null
        ? `engine \`${adapter.engineName}\` does not implement MCP discovery`
        : `no server named \`${server}\` is discovered on this machine (it names: ` +
          `${[...discovered].join(', ') || 'none'})`,
    );
  }

  const connection =
    typeof adapter.resolveMcpServerConnection === 'function'
      ? await adapter.resolveMcpServerConnection(server)
      : null;
  if (connection === null) {
    throw new DeliverySetupError(
      `engine \`${adapter.engineName}\` could not read how to reach \`${server}\``,
    );
  }

  const client = (wiring.createClient ??
    ((one: McpServerConnection) =>
      createMcpClient(one, { requestTimeoutMs: wiring.callTimeoutMs })))(connection);

  await client.initialize();

  const published = new Set((await client.listTools()).map((one) => one.name));
  if (!published.has(tool)) {
    throw new DeliverySetupError(
      `server \`${server}\` publishes no tool named \`${tool}\` (it publishes: ` +
        `${[...published].join(', ') || 'no tools at all'})`,
    );
  }

  return client;
}

/**
 * Asks a person about a delivery that did not finish cleanly (RF-36).
 *
 * `POST /v1/input-requests` is what BLOCKS the job, inside the control plane and
 * in the same transaction as the question — so no block of this module's own is
 * posted beside it. Two owners for one flag is how a job ends up blocked with
 * nothing pending.
 *
 * `auto_approvable: false`, and that is mandatory rather than cautious: an
 * environment fault is never something a gate should answer on its own, which is
 * the reasoning `pre-session-failure.ts` already records for the block it raises.
 */
async function askAboutDelivery(
  call: ControlPlaneCall,
  job: JobRef,
  sessionId: number,
  entry: { name: string; server: string; tool: string },
  detail: string,
  history: readonly ExternalCallRow[],
): Promise<void> {
  const recorded = history
    .map(
      (row) =>
        `#${String(row.id)} started ${row.started_at}, ` +
        `${row.outcome === null ? 'never reported an outcome' : `ended \`${row.outcome}\``}` +
        `${row.result_summary === null ? '' : ` — ${row.result_summary}`}`,
    )
    .join('; ');

  await call('/v1/input-requests', 'POST', {
    job_id: job.id,
    session_id: sessionId,
    kind: 'question',
    question:
      `Step \`${job.current_node_id}\` writes outside the system and did not finish ` +
      'cleanly. Should it be tried again?',
    context:
      `The delivery \`${entry.name}\` goes to \`${entry.tool}\` on server ` +
      `\`${entry.server}\`, and this node is marked \`unsafe_to_retry\` — so nothing ` +
      `was attempted a second time. What happened: ${detail}. ` +
      `Calls recorded for this delivery: ${recorded === '' ? 'none' : recorded}. ` +
      'Check the external system before answering: `retry` calls the tool again, ' +
      '`skip this output` abandons it and moves the work on, and `mark as done` ' +
      'records that the delivery had in fact landed and moves the work on. Neither of ' +
      'the last two re-runs the step.',
    options: [...EXTERNAL_OUTPUT_WRITE_OPTIONS],
    recommendation: null,
    default_answer: null,
    // Mandatory. An environment or side-effect fault is never auto-answered, and
    // this is the one question in the system where answering it wrongly cannot
    // be undone.
    auto_approvable: false,
    origin: EXTERNAL_OUTPUT_WRITE_ORIGIN,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Delivers every output the node declares, in declared order (FR1–FR5).
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param resolved The node it is standing on, and its `external.outputs`.
 * @param sessionId The session whose report was accepted, for the trail.
 * @param report That report, decoded — the object `from` reads a property of.
 * @param wiring The engine, the deadline and the ladder. Absent means this
 *   dispatch has no MCP window, and then nothing is delivered and nothing is
 *   read: the pre-t371 behaviour, exactly.
 * @returns `written` when every declared output is settled; `blocked` with the
 *   reason the work was stopped with; `asked` when a person was called.
 */
export async function writeExternalOutputs(
  call: ControlPlaneCall,
  job: JobRef,
  resolved: ResolvedNode,
  sessionId: number,
  report: Record<string, unknown> | null,
  wiring?: ExternalOutputWiring,
): Promise<ExternalOutputStep> {
  const declared = resolved.node.external?.outputs ?? [];
  if (declared.length === 0 || wiring === undefined) return { kind: 'written' };

  const nodeId = resolved.node.id;
  const unsafe = isUnsafeToRetry(resolved);
  const journal = journalFor(call, job.id, wiring.projectId);
  const maxAttempts = unsafe ? 1 : (wiring.maxAttempts ?? DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS);
  const backoff = wiring.backoffMs ?? DEFAULT_OUTPUT_WRITE_BACKOFF_MS;
  const wait = wiring.delay ?? sleep;

  // One client per server for the whole step, closed however this ends: a
  // delivery that threw may not leave a spawned child behind, and the dispatch
  // that follows has no business inheriting a connection.
  const clients = new Map<string, McpClientLike>();

  try {
    for (const entry of declared) {
      const spec = named(entry);
      let history = await journal.settled({ nodeId, name: spec.name });

      // RF-35, first: an identical delivery already made is not made again, and
      // the standing down is recorded as itself.
      if (history.some(isSettled)) {
        const skipped = await journal.intent({
          nodeId,
          name: spec.name,
          server: spec.server,
          tool: spec.tool,
          argumentsSha256: sha256(''),
          argumentsSummary: '{}',
        });
        if (skipped !== null) {
          await journal.complete(skipped, {
            outcome: 'skipped_duplicate',
            resultSummary: 'an earlier call already settled this delivery; nothing was sent',
          });
        }
        continue;
      }

      // ...and the genuinely ambiguous state. For a safe node a dangling row is
      // "not yet delivered": repeating costs nothing. For an unsafe one it is "a
      // write may already have happened", and there is exactly one honest thing
      // to do with that, which is to ask.
      if (unsafe && history.some(isDangling)) {
        await askAboutDelivery(
          call,
          job,
          sessionId,
          spec,
          'an earlier attempt was recorded and never reported how it ended, so it is ' +
            'unknown whether the delivery landed',
          history,
        );
        return { kind: 'asked' };
      }

      // The value, and the arguments around it. Both are resolved BEFORE any
      // client is built, which is what keeps a declaration that does not add up
      // from ever reaching a server.
      if (report === null || !Object.hasOwn(report, spec.from)) {
        return blockedBy(
          call,
          job,
          spec,
          `the accepted report carries no property \`${spec.from}\`, so there is nothing ` +
            'to deliver',
        );
      }
      const value = report[spec.from];

      const resolvedArgs = resolveArguments(entry, job, report, value);
      if ('unresolved' in resolvedArgs) {
        return blockedBy(
          call,
          job,
          spec,
          'the declared arguments name values this report does not carry: ' +
            resolvedArgs.unresolved.join(', '),
        );
      }
      const summary = canonicalArguments(resolvedArgs.args);

      let client: McpClientLike;
      try {
        client = clients.get(spec.server) ?? (await connect(wiring, spec.server, spec.tool));
        clients.set(spec.server, client);
      } catch (error) {
        return blockedBy(
          call,
          job,
          spec,
          error instanceof Error ? error.message : String(error),
        );
      }

      let last: Attempt = { ok: false, detail: 'no attempt was made', timedOut: false };

      for (let made = 0; made < maxAttempts; made += 1) {
        // The lookup again, before EVERY attempt and not once per entry: two
        // runners holding the same job is not a state this system produces, but
        // a second attempt made after a first one landed is precisely what RF-35
        // forbids, and re-asking costs one indexed read.
        if (made > 0) {
          history = await journal.settled({ nodeId, name: spec.name });
          if (history.some(isSettled)) break;
        }

        const callId = await journal.intent({
          nodeId,
          name: spec.name,
          server: spec.server,
          tool: spec.tool,
          argumentsSha256: sha256(summary),
          argumentsSummary: summary,
        });

        last = await attempt(client, spec.tool, resolvedArgs.args, wiring.callTimeoutMs);

        if (callId !== null) {
          // A call that timed out is left OPEN on purpose, and only for an
          // unsafe node: the server may have done the thing, and writing
          // `error` over that would be this side deciding what the far side
          // did. For a safe node it is recorded as the failure it is, because
          // repeating it is free either way.
          const leaveOpen = unsafe && !last.ok && last.timedOut;
          if (!leaveOpen) {
            await journal.complete(callId, {
              outcome: last.ok ? 'ok' : 'error',
              resultSummary: last.ok ? last.summary : last.detail,
            });
          }
        }

        if (last.ok) break;

        // The ladder is entirely local to this one entry: no cross-tick state,
        // no shared tracker, and nothing to do with `pre-session-retry.ts`'s
        // count of dispatches or with the control plane's count of failed
        // sessions. Those two are about the SESSION; this is about one HTTP
        // call inside a dispatch that already succeeded.
        const rung = backoff[made];
        if (made + 1 < maxAttempts && rung !== undefined) await wait(rung);
      }

      if (last.ok) continue;

      // A settled row that appeared mid-ladder is a delivery, not a failure.
      if (history.some(isSettled)) continue;

      if (unsafe) {
        await askAboutDelivery(
          call,
          job,
          sessionId,
          spec,
          last.timedOut
            ? `the server did not answer within the deadline (${last.detail})`
            : `the call failed: ${last.detail}`,
          await journal.settled({ nodeId, name: spec.name }),
        );
        return { kind: 'asked' };
      }

      return blockedBy(
        call,
        job,
        spec,
        `${String(maxAttempts)} attempts were made and none of them landed; the last one ` +
          `said: ${last.detail}`,
      );
    }
  } finally {
    for (const client of clients.values()) await client.close().catch(() => undefined);
  }

  return { kind: 'written' };
}

/** Stops the work with the seventh block, and hands the reason back. */
async function blockedBy(
  call: ControlPlaneCall,
  job: JobRef,
  entry: { name: string; server: string; tool: string },
  detail: string,
): Promise<ExternalOutputStep> {
  const reason = await blockForExternalOutputFailure(call, job, entry, detail);
  return { kind: 'blocked', reason };
}

/**
 * Attempts a SAFE node's delivery gets, in total (t371, FR4).
 *
 * Three, and the number is the ladder's own: a delivery that failed three times
 * in a couple of seconds failed for a reason a fourth attempt will not fix, and
 * what is on the other side of the ladder is a person reading a block reason
 * rather than a job retried forever. It bounds ONE call — a node declaring three
 * deliveries gets three ladders, because what this is about is a server that
 * refused, not a budget for the node.
 */
export const DEFAULT_MAX_OUTPUT_WRITE_ATTEMPTS = 3;

/**
 * ...and what it waits between them, rung by rung (t371, FR4).
 *
 * One entry fewer than there are attempts, which is what "between" means: no
 * trailing wait before a block nobody is racing. Short on purpose — this happens
 * inside a dispatch that has already spent a session, and the failures worth
 * waiting out at this timescale are a socket and a restart, never a quota.
 */
export const DEFAULT_OUTPUT_WRITE_BACKOFF_MS: readonly number[] = Object.freeze([500, 1_500]);

/**
 * Binds the delivery step to this dispatch's wiring (t371, FR1).
 *
 * What `dispatch.ts` hands to `report.ts`, so that the orchestrator's line reads
 * as the one decision it is taking. The same shape `createMainLineAdvancer` and
 * `createMergedInputResolver` already have.
 *
 * @param wiring The engine, the deadline and the ladder.
 * @returns The writer `advance()` calls between the bench and the edges.
 */
export function createExternalOutputWriter(wiring: ExternalOutputWiring): ExternalOutputWriter {
  return (call, job, resolved, sessionId, report) =>
    writeExternalOutputs(call, job, resolved, sessionId, report, wiring);
}

/* -------------------------------------------------------------------------- */
/* FR6 — the answer, without re-running the step                               */
/* -------------------------------------------------------------------------- */

/** The three answers, as this module reads them off free text. */
type Decision = 'retry' | 'skip' | 'done' | 'unrecognised';

/**
 * Which of the three a person's answer is.
 *
 * Matched loosely — trimmed and case-folded — because the options are prose a
 * person clicks OR types, and an answer of "Skip this output." is the same
 * decision as `skip this output`. Anything else is `unrecognised`, and
 * unrecognised deliberately behaves like `retry`: the job was unblocked by
 * somebody who read the question, and an ordinary dispatch is what every other
 * answered question in this system produces. Silently skipping a delivery on a
 * sentence nobody parsed is the one outcome that would be worse than either.
 */
function readDecision(answer: string | null): Decision {
  const said = (answer ?? '').trim().toLowerCase();
  if (said === '') return 'unrecognised';
  if (said.startsWith('retry')) return 'retry';
  if (said.startsWith('skip')) return 'skip';
  if (said.startsWith('mark as done') || said === 'done') return 'done';
  return 'unrecognised';
}

/** What a `skip`/`done` decision records, and the sentence it records it with. */
const DECISION_OUTCOME: Readonly<Record<'skip' | 'done', string>> = Object.freeze({
  skip: 'skipped_by_person',
  done: 'marked_done_by_person',
});

/**
 * Carries out a person's answer about a delivery, before a worktree exists
 * (t371, FR6).
 *
 * Called by `dispatch.ts` at the very top of a tick, before anything is read for
 * a session. Almost every job answers `false` on the first read and pays one
 * listing for it.
 *
 * The three answers, and why only two of them are this function's:
 *
 * - **`retry`** — an ordinary dispatch. The one thing done here is closing any
 *   row the previous attempt left open: it was left open BECAUSE nobody knew how
 *   it ended, and a person has now decided that the call may be made again, so
 *   leaving it open would make the delivery step ask the identical question on
 *   the next tick, forever. It is closed as `error` and never as `ok`: what is
 *   recorded is that the call never reported, and the summary says so.
 * - **`skip this output`** and **`mark as done`** — the carve-out. The outcome
 *   is recorded, the ORIGINAL session's stored report is read back, and the work
 *   is moved along the edge that report names. No worktree, no session, no
 *   engine.
 *
 * **What keeps it from firing twice.** The decision is settled in the CALL LOG,
 * not in the question: once the row is written, `isSettled` is true and this
 * function answers `false` — so a job that loops back to this node later
 * dispatches normally instead of skipping on a months-old answer.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work about to be dispatched, with its position.
 * @param options The project every read below is scoped to (t410).
 * @returns `true` when the work was settled and moved here, and no session
 *   should be opened; `false` for an ordinary dispatch.
 */
export async function settleAnsweredOutputWrite(
  call: ControlPlaneCall,
  job: JobRef & JobPosition,
  options: { projectId?: number },
): Promise<boolean> {
  const { projectId } = options;

  const query =
    `job_id=${String(job.id)}&status=answered&origin=${EXTERNAL_OUTPUT_WRITE_ORIGIN}`;
  const { input_requests: answered } = await call<{ input_requests: AnsweredQuestion[] }>(
    withProject(`/v1/input-requests?${query}`, projectId),
    'GET',
  );

  // The most recent decision about THIS node, and nothing else: a question
  // answered about a node the work has since left is not a decision about where
  // it is standing now.
  const decided = answered
    .filter((question) => question.node_id === job.current_node_id)
    .at(-1);
  if (decided === undefined) return false;

  const decision = readDecision(decided.answer);
  const journal = journalFor(call, job.id, projectId);

  const rows = await call<{ external_calls: ExternalCallRow[] }>(
    withProject(
      `/v1/jobs/${String(job.id)}/external-calls?node_id=` +
        `${encodeURIComponent(job.current_node_id)}&direction=output`,
      projectId,
    ),
    'GET',
  );

  // Which delivery the question was about: the one that is not settled. If they
  // all are, the decision has already been carried out and this is an ordinary
  // tick.
  const byName = new Map<string, ExternalCallRow[]>();
  for (const row of rows.external_calls) {
    byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
  }
  const unsettled = [...byName.entries()].find(([, history]) => !history.some(isSettled));
  if (unsettled === undefined) return false;

  const [name, history] = unsettled;

  if (decision === 'retry' || decision === 'unrecognised') {
    for (const row of history.filter(isDangling)) {
      await journal.complete(row.id, {
        outcome: 'error',
        resultSummary:
          'this call never reported how it ended; a person authorised a retry, so the ' +
          'row is closed to let the delivery be attempted again',
      });
    }
    return false;
  }

  // The decision itself, recorded. A `done` closes the attempt that is already
  // open — that row IS the delivery the person confirmed, and a second one would
  // invent a call nobody made. A `skip` opens and closes a row of its own,
  // because there is nothing open to speak for it.
  const open = history.find(isDangling);
  const summary =
    decision === 'skip'
      ? `${decided.answered_by ?? 'a person'} asked for this output to be skipped`
      : `${decided.answered_by ?? 'a person'} confirmed this delivery had already landed`;

  const callId =
    open?.id ??
    (await journal.intent({
      nodeId: job.current_node_id,
      name,
      server: '(decided by a person)',
      tool: '(no call was made)',
      argumentsSha256: sha256(''),
      argumentsSummary: '{}',
    }));

  if (callId !== null) {
    await journal.complete(callId, { outcome: DECISION_OUTCOME[decision], resultSummary: summary });
  }

  // And the work moves, from the report the ORIGINAL session already had stored
  // — never from a new one. Reopening the step's session is exactly the repeat
  // `unsafe_to_retry` exists to prevent.
  const resolved = await resolveNode(job, (route) =>
    call<GraphVersionBody>(withProject(route, projectId), 'GET'),
  );
  if (resolved === null) return true;

  const sessionId = decided.session_id;
  if (sessionId === null) return true;

  const { sessions } = await call<{ sessions: StoredSession[] }>(
    withProject(`/v1/sessions?job_id=${String(job.id)}`, projectId),
    'GET',
  );
  const original = sessions.find((one) => one.id === sessionId) ?? null;

  await selectAndTransition(call, job, resolved, sessionId, original?.output ?? null);
  return true;
}
