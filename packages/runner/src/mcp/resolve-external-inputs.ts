/**
 * A node's declared external inputs, fetched before the session exists
 * (t370, FR3).
 *
 * This is the ticket's centre. A node declares `external.inputs`; before
 * anything opens, the runner asks each named MCP server for what the node needs
 * and sets the bytes aside. The session that opens afterwards finds FILES — it
 * never sees the server, the transport, or the credential that reached it
 * (RF-31, RF-32, RF-34).
 *
 * ## Why the write is not here
 *
 * The whole resolution runs in the pre-worktree window, beside the other seven
 * pre-session reads and for their reason: everything that fails in there fails
 * with no directory cut, no session row, no engine process and no token spent
 * (`resolve-session-plan.ts`). But `input.external.<name>` has to exist before
 * `renderSkillInstructions` interpolates `{{input.external.<name>.path}}` into
 * the manifest body — which puts the resolution *before* `worktrees.acquire`,
 * where there is no `workingDir` to write into yet.
 *
 * So the work is split at exactly that seam: the NETWORK call and its failure
 * classification happen here, and the DISK write of the already-fetched bytes
 * happens in `dispatch.ts` the moment the tree exists, through
 * {@link writeExternalInput}. Cheapest-failure-first is preserved and nothing is
 * fetched twice.
 *
 * ## Five reasons, because they are five different facts
 *
 * A server this machine's engine does not name, a connection nobody can read,
 * an argument the input does not carry, a tool that is not on the server, a
 * server that went quiet. Each reproduces identically on the next tick, each is
 * fixed somewhere else, and `pre-session-failure.ts` turns each into a block
 * reason a person reads in the inbox. Collapsing them into one would be telling
 * that person to go and look.
 *
 * ## What the CONTROL PLANE gets
 *
 * A record per call, in two phases: an intent before it and a completion after
 * (RF-37, input half). It is written through the caller's own control-plane
 * client, handed in as {@link ExternalCallRecorder} — this module opens no HTTP
 * connection of its own and touches no database (D1). Absent means no record,
 * which is what every unit test of this file runs under.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { interpolate } from '../dispatch/interpolate-input.ts';
import type { ExternalInputDeclaration, ResolvedNode } from '../dispatch/resolve-node.ts';
import type { EngineAdapter, McpServerConnection } from '../engine/types.ts';
import { createMcpClient, McpTimeoutError, type McpClientLike } from './client.ts';

/**
 * The most this runner accepts from one MCP call, in bytes.
 *
 * 10 MiB, fixed and not configurable (Out of Scope). An MCP server is less
 * trusted than this system's own control plane — it is a third party the
 * operator approved on their engine, not a component of this one — and an
 * unbounded read is a runner one answer away from its own memory. The number
 * follows the spirit of `render-input-values.ts`'s 64 KiB prompt cut and
 * `CARTOGRAFO_ARTIFACT_SIZE_CAP_BYTES`'s 32 MiB, scaled down because this
 * content never leaves the runner's own disk. Raising it later is additive.
 */
export const DEFAULT_RESULT_SIZE_CAP_BYTES = 10 * 1_048_576;

/** The five ways this resolution can refuse, each a different fact. */
export type ExternalInputFailure =
  | 'unknown_server'
  | 'call_error'
  | 'tool_not_found'
  | 'timeout'
  | 'unresolved_argument';

/** Everything the refusal names, so the block reason can name it too. */
export interface ExternalInputFailureDetail {
  readonly nodeId: string;
  readonly name: string;
  readonly server: string;
  readonly tool: string;
  readonly reason: ExternalInputFailure;
  /** What the far side said, when it said anything. */
  readonly detail?: string;
}

/** One sentence per reason, in the voice `ExecutorEnvironmentError`'s is. */
const SENTENCES: Readonly<Record<ExternalInputFailure, string>> = Object.freeze({
  unknown_server: 'no MCP server of that name is discovered on this machine',
  call_error: 'the call failed',
  tool_not_found: 'the server publishes no tool of that name',
  timeout: 'the server did not answer within the deadline',
  unresolved_argument: 'an argument names input this dispatch does not carry',
});

/**
 * An `external.inputs` entry that could not be resolved (t370, FR3).
 *
 * Built the same way `ExecutorEnvironmentError`'s message is: one sentence that
 * names the node, the entry, the server and the tool, plus whatever the far
 * side said. The FIELDS are what `pre-session-failure.ts` reads; the message is
 * what a log line shows.
 */
export class ExternalInputResolutionError extends Error {
  readonly nodeId: string;
  /**
   * The entry's own `name`, under the one spelling `Error` leaves free.
   *
   * The declaration calls this field `name`, and a class extending `Error`
   * cannot: `Error.name` is the class's name, every logger reads it that way,
   * and shadowing it with `report` would make one stack trace in ten thousand
   * unreadable to save four characters here. The constructor still TAKES
   * `name`, so the call sites read exactly as the format writes it.
   */
  readonly inputName: string;
  readonly server: string;
  readonly tool: string;
  readonly reason: ExternalInputFailure;
  /** What the far side said, when it said anything; `''` when it did not. */
  readonly detail: string;

  constructor(failure: ExternalInputFailureDetail, options?: { cause?: unknown }) {
    const detail = failure.detail?.trim() ?? '';
    super(
      `external input \`${failure.name}\` of node \`${failure.nodeId}\` could not be ` +
        `resolved from server \`${failure.server}\` (tool \`${failure.tool}\`): ` +
        `${SENTENCES[failure.reason]} [${failure.reason}]` +
        (detail === '' ? '' : ` — ${detail}`),
      options,
    );
    // Declared as fields and assigned in the body rather than as constructor
    // parameter properties, the same rule `UnknownSessionError` records: a
    // parameter property is not erasable syntax, and Node's own type stripping
    // refuses the whole module over one.
    this.name = 'ExternalInputResolutionError';
    this.nodeId = failure.nodeId;
    this.inputName = failure.name;
    this.server = failure.server;
    this.tool = failure.tool;
    this.reason = failure.reason;
    this.detail = detail;
  }
}

/** Bytes that are waiting for a working directory to be written into. */
export interface PendingExternalWrite {
  readonly as: string;
  readonly bytes: Buffer;
}

/** What one node's external inputs resolved to. */
export interface ExternalInputResolution {
  /** The node's input, with `input.external` filled in. */
  readonly input: Record<string, unknown>;
  /** The bytes, in declared order, for the dispatch to write after `acquire`. */
  readonly pendingWrites: readonly PendingExternalWrite[];
}

/**
 * Where the record of a call goes (RF-37, input half).
 *
 * An interface and not a client: this module has no control plane of its own,
 * and building one here would give the runner's credential a second owner
 * (`control-plane-client.ts`). `resolve-session-plan.ts` builds the real one
 * out of the dispatch's single client.
 *
 * `intent` answering `null` is ordinary — a control plane that does not carry
 * the job, a recorder switched off — and it means the completion is skipped
 * too. What it must never do is stop the fetch: the record is a record.
 */
export interface ExternalCallRecorder {
  intent(call: {
    nodeId: string;
    name: string;
    server: string;
    tool: string;
    argumentsSha256: string;
    argumentsSummary: string;
    startedAt: string;
  }): Promise<number | null>;
  complete(
    callId: number,
    outcome: { outcome: 'ok' | 'error'; finishedAt: string; resultSummary: string },
  ): Promise<void>;
}

/** How the resolution is wired. */
export interface ResolveExternalInputsOptions {
  /** Deadline of each `tools/call`, in milliseconds. */
  readonly callTimeoutMs: number;
  /** Ceiling on one result. Default {@link DEFAULT_RESULT_SIZE_CAP_BYTES}. */
  readonly resultSizeCapBytes?: number;
  /** Test seam: builds the client for a resolved connection. */
  readonly createClient?: (connection: McpServerConnection) => McpClientLike;
  /** Where the record of each call goes. Absent means no record is kept. */
  readonly record?: ExternalCallRecorder;
}

/** sha256, hex — of bytes or of a canonical string. */
function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The arguments as one deterministic string, for the digest and the summary. */
function canonicalArguments(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) sorted[key] = args[key];
  return JSON.stringify(sorted);
}

/**
 * Interpolates every string value of one entry's arguments.
 *
 * Element-wise and one level deep, which is the shape `arguments` has: a map of
 * named values. Non-strings pass through untouched — a number is a number, and
 * `{{input.x}}` is a grammar of text.
 *
 * @throws {ExternalInputResolutionError} `unresolved_argument`, listing every
 *   path that did not resolve rather than the first: whoever goes to fix the
 *   input assembly should find all the gaps in one reading.
 */
function interpolateArguments(
  entry: Required<Pick<ExternalInputDeclaration, 'name' | 'server' | 'tool'>>,
  nodeId: string,
  args: Record<string, unknown>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const unresolved: string[] = [];
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    resolved[key] = typeof value === 'string' ? interpolate(value, input, unresolved) : value;
  }

  if (unresolved.length > 0) {
    throw new ExternalInputResolutionError({
      nodeId,
      ...entry,
      reason: 'unresolved_argument',
      detail: unresolved.join(', '),
    });
  }

  return resolved;
}

/**
 * The bytes of a `tools/call` result, out of its FIRST content entry.
 *
 * The first and only the first: an external input is one file, and a server
 * that answered with several pieces is answering a question this format does
 * not ask. Two shapes are usable — `text`, and a `resource` carrying either a
 * base64 `blob` or its own `text` — and anything else is a `call_error` that
 * says the tool returned no usable content, because guessing at a shape is how
 * a file arrives corrupted instead of absent.
 */
function extractBytes(content: readonly unknown[]): Buffer | null {
  const first = content[0];
  if (typeof first !== 'object' || first === null) return null;

  const entry = first as { type?: unknown; text?: unknown; resource?: unknown };

  if (entry.type === 'text' && typeof entry.text === 'string') {
    return Buffer.from(entry.text, 'utf8');
  }

  if (entry.type === 'resource' && typeof entry.resource === 'object' && entry.resource !== null) {
    const resource = entry.resource as { blob?: unknown; text?: unknown };
    // Base64 first: a resource that carries bytes carries them there, and
    // reading its `text` instead would corrupt everything that is not UTF-8.
    if (typeof resource.blob === 'string') return Buffer.from(resource.blob, 'base64');
    if (typeof resource.text === 'string') return Buffer.from(resource.text, 'utf8');
  }

  return null;
}

/** One connected client per distinct server name, for one dispatch. */
class ClientPool {
  readonly #clients = new Map<string, McpClientLike>();
  readonly #create: (connection: McpServerConnection) => McpClientLike;

  constructor(create: (connection: McpServerConnection) => McpClientLike) {
    this.#create = create;
  }

  /** The client for this server, initialized exactly once. */
  async get(server: string, connection: McpServerConnection): Promise<McpClientLike> {
    const existing = this.#clients.get(server);
    if (existing !== undefined) return existing;

    const client = this.#create(connection);
    // Registered BEFORE the handshake, so a client whose `initialize` failed is
    // still closed by `closeAll` — a spawned child that never handshook is
    // exactly as much of a leak as one that did.
    this.#clients.set(server, client);
    await client.initialize();
    return client;
  }

  /** Closes everything this dispatch opened, whatever happened. */
  async closeAll(): Promise<void> {
    for (const client of this.#clients.values()) {
      // One client that refuses to close may not keep the others open, and a
      // close that failed says nothing about the resolution's own outcome.
      await client.close().catch(() => undefined);
    }
    this.#clients.clear();
  }
}

/** Turns whatever the client threw into the reason that fits it. */
function callFailure(
  entry: Required<Pick<ExternalInputDeclaration, 'name' | 'server' | 'tool'>>,
  nodeId: string,
  error: unknown,
): ExternalInputResolutionError {
  return new ExternalInputResolutionError(
    {
      nodeId,
      ...entry,
      // Silence past the deadline and a refusal are different facts: the first
      // is fixed at the server or the network, the second in the call itself.
      reason: error instanceof McpTimeoutError ? 'timeout' : 'call_error',
      detail: error instanceof Error ? error.message : String(error),
    },
    { cause: error },
  );
}

/**
 * Fetches every external input the node declares, in declared order.
 *
 * @param resolved The node the work is standing on.
 * @param input The node's merged input — the control plane's projection plus
 *   the executor environment — which is the SAME object `renderSkillInstructions`
 *   will interpolate against.
 * @param adapter The engine this node routes to, for its two MCP capabilities.
 * @param options Deadline, size cap, and the two seams.
 * @returns The input with `input.external` filled in, and the bytes to write
 *   once the worktree exists.
 * @throws {ExternalInputResolutionError} Any of the five reasons, on the first
 *   entry that hits one: an input the node declared and did not get is not a
 *   session that should open with a gap in it.
 */
export async function resolveExternalInputs(
  resolved: ResolvedNode,
  input: Record<string, unknown>,
  adapter: EngineAdapter,
  options: ResolveExternalInputsOptions,
): Promise<ExternalInputResolution> {
  const declared = resolved.node.external?.inputs ?? [];
  const external: Record<string, unknown> = {};
  const pendingWrites: PendingExternalWrite[] = [];

  // The empty drawer is deliberate and is the pre-existing behaviour: a graph
  // written before this field existed resolves `input.external = {}`, so
  // `{{input.external.x}}` fails closed with a path that does not resolve
  // instead of silently rendering `undefined`.
  if (declared.length === 0) return { input: { ...input, external }, pendingWrites };

  const nodeId = resolved.node.id;
  const sizeCap = options.resultSizeCapBytes ?? DEFAULT_RESULT_SIZE_CAP_BYTES;
  const pool = new ClientPool(
    options.createClient ??
      ((connection) => createMcpClient(connection, { requestTimeoutMs: options.callTimeoutMs })),
  );

  // ONE discovery per dispatch, whatever the node declares: it is the same
  // question for every entry, and asking an engine twice invites two answers.
  const discovered =
    typeof adapter.discoverMcpServers === 'function'
      ? new Set((await adapter.discoverMcpServers()).servers.map((server) => server.name))
      : null;

  try {
    for (const entry of declared) {
      const named = {
        name: entry.name ?? '(unnamed)',
        server: entry.server ?? '(unnamed)',
        tool: entry.tool ?? '(unnamed)',
      };
      const as = entry.as ?? named.name;

      // 1. The discovery gate. "Discovered from the runner's machine" (RF-31)
      // is what this means operationally: a server nobody's engine currently
      // sees — including one merely declared and still pending approval, since
      // discovery applies each CLI's own rules — is not callable, whatever a
      // configuration file on disk might say. An adapter that cannot answer at
      // all is not an engine with zero servers, and neither makes one callable.
      if (discovered === null || !discovered.has(named.server)) {
        throw new ExternalInputResolutionError({
          nodeId,
          ...named,
          reason: 'unknown_server',
          detail:
            discovered === null
              ? `engine \`${adapter.engineName}\` does not implement MCP discovery`
              : `this machine's engine names: ${[...discovered].join(', ') || 'none'}`,
        });
      }

      // 2. The connection. Known to discovery, and its details unreadable — an
      // unset credential placeholder among them — is a different fact from a
      // server nobody has.
      let connection: McpServerConnection | null;
      try {
        connection =
          typeof adapter.resolveMcpServerConnection === 'function'
            ? await adapter.resolveMcpServerConnection(named.server)
            : null;
      } catch (error) {
        throw new ExternalInputResolutionError(
          {
            nodeId,
            ...named,
            reason: 'call_error',
            detail: error instanceof Error ? error.message : String(error),
          },
          { cause: error },
        );
      }
      if (connection === null) {
        throw new ExternalInputResolutionError({
          nodeId,
          ...named,
          reason: 'call_error',
          detail: `engine \`${adapter.engineName}\` could not read how to reach this server`,
        });
      }

      // 3. The arguments, against the same input the manifest is rendered
      // against — and BEFORE any client is built, which is what keeps a
      // placeholder that does not resolve from ever spawning a server.
      const args = interpolateArguments(named, nodeId, entry.arguments ?? {}, input);
      const argumentsSummary = canonicalArguments(args);

      const client = await connectOrFail(pool, named, nodeId, connection);

      // 4. The tool has to be published. A name that is genuinely not on the
      // list and a call the server refused are two facts, and only the first
      // is fixed by editing the graph.
      const published = await listOrFail(client, named, nodeId);
      if (!published.has(named.tool)) {
        throw new ExternalInputResolutionError({
          nodeId,
          ...named,
          reason: 'tool_not_found',
          detail: `the server publishes: ${[...published].join(', ') || 'no tools at all'}`,
        });
      }

      // 5. The call, with the record bracketing it.
      const callId =
        (await options.record?.intent({
          nodeId,
          ...named,
          argumentsSha256: sha256(argumentsSummary),
          argumentsSummary,
          startedAt: new Date().toISOString(),
        })) ?? null;

      let bytes: Buffer;
      try {
        bytes = await callAndExtract(client, named, nodeId, args, options.callTimeoutMs, sizeCap);
      } catch (error) {
        if (callId !== null) {
          await options.record?.complete(callId, {
            outcome: 'error',
            finishedAt: new Date().toISOString(),
            resultSummary: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }

      const digest = sha256(bytes);
      if (callId !== null) {
        await options.record?.complete(callId, {
          outcome: 'ok',
          finishedAt: new Date().toISOString(),
          // The SUMMARY and never the payload (RF-37): what the call produced,
          // in the two facts that identify it.
          resultSummary: `${String(bytes.byteLength)} bytes, sha256 ${digest}`,
        });
      }

      external[named.name] = { path: as, size: bytes.byteLength, sha256: digest };
      pendingWrites.push({ as, bytes });
    }
  } finally {
    // Success or failure: no child process and no open socket survives this
    // function. The dispatch that follows has a worktree to look after and no
    // business inheriting a connection.
    await pool.closeAll();
  }

  return { input: { ...input, external }, pendingWrites };
}

/** {@link ClientPool.get}, with the failure classified. */
async function connectOrFail(
  pool: ClientPool,
  named: { name: string; server: string; tool: string },
  nodeId: string,
  connection: McpServerConnection,
): Promise<McpClientLike> {
  try {
    return await pool.get(named.server, connection);
  } catch (error) {
    throw callFailure(named, nodeId, error);
  }
}

/** `tools/list`, as a set of names, with the failure classified. */
async function listOrFail(
  client: McpClientLike,
  named: { name: string; server: string; tool: string },
  nodeId: string,
): Promise<Set<string>> {
  try {
    return new Set((await client.listTools()).map((tool) => tool.name));
  } catch (error) {
    throw callFailure(named, nodeId, error);
  }
}

/** One `tools/call`, and the bytes out of what it answered. */
async function callAndExtract(
  client: McpClientLike,
  named: { name: string; server: string; tool: string },
  nodeId: string,
  args: Record<string, unknown>,
  callTimeoutMs: number,
  sizeCap: number,
): Promise<Buffer> {
  let result;
  try {
    result = await client.callTool(named.tool, args, callTimeoutMs);
  } catch (error) {
    throw callFailure(named, nodeId, error);
  }

  // `isError: true` is the tool refusing, which is a RESULT and not a protocol
  // failure — and it is a `call_error` rather than `tool_not_found`, because
  // the tool is right there and the CALL is what went wrong.
  if (result.isError === true) {
    throw new ExternalInputResolutionError({
      nodeId,
      ...named,
      reason: 'call_error',
      detail: describeErrorResult(result.content),
    });
  }

  const bytes = extractBytes(result.content);
  if (bytes === null) {
    throw new ExternalInputResolutionError({
      nodeId,
      ...named,
      reason: 'call_error',
      detail: 'the tool returned no usable content',
    });
  }

  // Before anything is written and before the bytes are held any longer than
  // the check needs: an MCP server is a third party, and an unbounded answer is
  // a runner one call away from its own memory.
  if (bytes.byteLength > sizeCap) {
    throw new ExternalInputResolutionError({
      nodeId,
      ...named,
      reason: 'call_error',
      detail:
        `the result exceeded the size this runner accepts (${String(bytes.byteLength)} bytes ` +
        `> ${String(sizeCap)})`,
    });
  }

  return bytes;
}

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
 * Writes one fetched input into the session's working directory (t370, FR3).
 *
 * Called from `dispatch.ts` right after `worktrees.acquire` and before
 * `buildSessionSpec` — the first moment there is a directory to write into, and
 * still before the session exists.
 *
 * **The traversal check is defense in depth, and it is kept anyway.** t369's
 * schema refuses `as: "../x"` at registration, so a snapshot reaching here with
 * one has already been through a gate that should have stopped it. That is
 * exactly the posture `local-store.ts` takes about a ref "that only ever
 * originates from this module's own" trusted source: the guard costs two lines,
 * and what it protects is the invariant the whole engine-adapter contract rests
 * on — the session's directory is its entire write scope.
 *
 * @param workingDir The session's worktree.
 * @param write One entry of `pendingWrites`.
 * @throws {Error} `as` resolves outside `workingDir`.
 */
export async function writeExternalInput(
  workingDir: string,
  write: PendingExternalWrite,
): Promise<void> {
  const root = path.resolve(workingDir);
  const target = path.resolve(root, write.as);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `external input \`${write.as}\` resolves outside the session's working directory ` +
        `(${target}): a session's directory is its entire write scope`,
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, write.bytes);
}

/**
 * Writes every pending input, in declared order.
 *
 * The whole disk half in one call, so the orchestrator's line reads as the one
 * decision it is taking — "the tree exists now, put the bytes in it" — rather
 * than as a loop. Sequential rather than concurrent: the entries are few, they
 * may share a directory, and a `mkdir` race for one saved millisecond is not a
 * trade this file makes.
 *
 * @param workingDir The session's worktree.
 * @param writes What {@link resolveExternalInputs} set aside.
 */
export async function writeExternalInputs(
  workingDir: string,
  writes: readonly PendingExternalWrite[],
): Promise<void> {
  for (const write of writes) await writeExternalInput(workingDir, write);
}
