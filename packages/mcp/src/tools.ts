/**
 * The tool catalogue — what a model is allowed to ask of the cartografo, and in
 * what shape the answer comes back.
 *
 * Three decisions are worth knowing before reading the code.
 *
 * **1. The surface is a decision, not a mapping of the API.** Everything here
 * could be done with `curl` against `/v1/*` by anybody holding the token; what
 * this file adds is a line around the part of the API a model may drive on its
 * own. Two exclusions carry the weight, and both are deliberate:
 *
 * - **Nothing decides a proposal.** `approve`, `apply`, `reject` and `revert`
 *   are absent, and their absence IS principle 5 (README): the surveyor's
 *   proposals wait for a human at the gate. A tool that let the same model that
 *   ran the surveyor approve the surveyor's own proposal would close the
 *   learning loop with no judge outside it, which is the one thing the loop is
 *   for. Reading a proposal is here; deciding it is the screen's (`/`).
 * - **Nothing transitions a job.** `POST /v1/jobs/:id/transitions` is the
 *   runner's traversal, written as it happens. Walking a job across the graph
 *   by hand from a chat window would leave the log saying that work happened at
 *   a node where none did — and the log is what the surveyor reads to propose
 *   the next version. `blocks`/`unblocks` ARE here, because stopping and
 *   resuming a job is an operator's fact about an operator's decision.
 *
 * Also absent, for a different reason: anything that starts or stops a process.
 * The control plane, the runner and the surveyor are long-lived commands an
 * operator brings up (D21), and a request/response tool is the wrong shape for
 * them even where it would be safe.
 *
 * **2. Every tool digests.** The raw API answers are honest and large — one
 * graph version's `snapshot` is tens of kilobytes of JSON Schema, one job's
 * timeline carries whole event payloads. What travels back to a model is a
 * projection: the fields that answer the question, with every long string
 * clipped by {@link clipStrings} and the clip declared in the text rather than
 * silently applied. Digesting is most of the reason this package exists at all
 * — a tool that pasted the wire body back would cost more context than the
 * `curl` it replaced.
 *
 * **3. A write says who wrote it.** {@link DEFAULT_ACTOR} is `agent`/`mcp`, and
 * every write route this file reaches carries it. The event log distinguishes
 * `user`, `agent` and `system`; a model acting through here is an agent, and
 * recording it as a person would corrupt the one record that says whether the
 * human was actually at the gate.
 */

import {
  ApiError,
  DeniedError,
  NetworkError,
  type ApiClient,
  type Actor,
  type Event,
  type GraphNode,
  type GraphVersion,
  type InputRequest,
  type Job,
  type Proposal,
  type Session,
  type Skill,
} from './client.ts';

/** Who a write made through this server is recorded as. */
export const DEFAULT_ACTOR: Actor = Object.freeze({ type: 'agent', ref: 'mcp' });

/** What `answered_by` says when the caller names nobody. */
export const DEFAULT_ANSWERED_BY = 'mcp';

/** Ceiling on any single string inside a digest, before the clip marker. */
export const CLIP_CHARS = 600;

/** Transcript slice a `read_transcript` call returns when it asks for no size. */
export const TRANSCRIPT_DEFAULT_CHARS = 4_000;

/** Ceiling on the transcript slice, whatever the call asks for. */
export const TRANSCRIPT_MAX_CHARS = 200_000;

/** The statuses `list_input_requests` filters by, as the control plane spells them. */
export const INPUT_REQUEST_STATUSES = Object.freeze(['pending', 'answered', 'auto_resolved']);

/** The statuses `list_proposals` filters by. */
export const PROPOSAL_STATUSES = Object.freeze([
  'pending',
  'approved',
  'applied',
  'rejected',
  'reverted',
]);

/* -------------------------------------------------------------------------- */
/* Argument reading                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A call this server refuses to make, and why.
 *
 * Thrown before any request leaves: an argument that is missing or of the wrong
 * type is the caller's mistake, and answering it with the control plane's `400`
 * would name a field of the wire format instead of the tool's own.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

function requireText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolError(`"${key}" is required and has to be a non-empty string`);
  }
  return value.trim();
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`"${key}" has to be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError(`"${key}" is required and has to be an integer`);
  }
  return value;
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError(`"${key}" has to be an integer`);
  }
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolError(`"${key}" has to be a boolean`);
  return value;
}

function optionalTextList(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ToolError(`"${key}" has to be a list of strings`);
  }
  return value as string[];
}

function optionalChoice(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = optionalText(args, key);
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) {
    throw new ToolError(`"${key}" has to be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* Digesting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Copies a value, clipping every string longer than `limit`.
 *
 * The clip is DECLARED and not silent — `…(+312 chars)` at the end of the
 * string — because a model reading a truncated instruction with no marker will
 * reason about the half it got as if it were the whole. Whoever needs the rest
 * has a route that gives it: the transcript tool for a session, and the API
 * itself for anything else.
 *
 * @param value Anything JSON-serializable.
 * @param limit Characters kept per string. Default {@link CLIP_CHARS}.
 * @returns A copy with long strings clipped.
 */
export function clipStrings(value: unknown, limit: number = CLIP_CHARS): unknown {
  if (typeof value === 'string') {
    return value.length <= limit ? value : `${value.slice(0, limit)}…(+${value.length - limit} chars)`;
  }
  if (Array.isArray(value)) return value.map((entry) => clipStrings(entry, limit));
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) copy[key] = clipStrings(source[key], limit);
    return copy;
  }
  return value;
}

/** A job, in the fields that answer "where is it and is it moving?". */
export function jobDigest(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    title: job.title,
    execution_id: job.execution_id,
    node: job.current_node_id,
    entry_node: job.entry_node_id,
    blocked: job.blocked,
    block_reason: job.block_reason,
    completed: job.completed,
    graph_version_id: job.graph_version_id,
    tier: job.tier,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

/** A session, in the fields that answer "did the agent finish, and at what cost?". */
export function sessionDigest(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    job_id: session.job_id,
    execution_id: session.execution_id,
    node: session.node_id,
    engine: session.engine,
    status: session.status,
    exit_code: session.exit_code,
    timeout_reason: session.timeout_reason,
    usage: session.usage,
    opened_at: session.opened_at,
    finished_at: session.finished_at,
  };
}

/** An input request, in the fields a reader needs to answer it. */
export function inputRequestDigest(request: InputRequest): Record<string, unknown> {
  return clipStrings({
    id: request.id,
    job_id: request.job_id,
    session_id: request.session_id,
    node: request.node_id,
    kind: request.kind,
    status: request.status,
    question: request.question,
    context: request.context,
    options: request.options,
    recommendation: request.recommendation,
    default_answer: request.default_answer,
    auto_approvable: request.auto_approvable,
    answer: request.answer,
    answered_by: request.answered_by,
    source: request.source,
    created_at: request.created_at,
    answered_at: request.answered_at,
  }) as Record<string, unknown>;
}

/**
 * A proposal, with its operations named rather than pasted.
 *
 * The operations stay — a proposal IS its operations, and a summary that hid
 * them would describe a decision without its content — but each one is reduced
 * to what it touches, because an `add_node` carries the whole node document,
 * contract and all.
 */
export function proposalDigest(proposal: Proposal): Record<string, unknown> {
  return clipStrings({
    id: proposal.id,
    graph_id: proposal.graph_id,
    target_version: proposal.target_version,
    status: proposal.status,
    expected_metric: proposal.expected_metric,
    lens: readLens(proposal.evidence),
    operations: proposal.operations.map(summarizeOperation),
    applied_version_id: proposal.applied_version_id,
    rejection_reason: proposal.rejection_reason,
    revert_reason: proposal.revert_reason,
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
  }) as Record<string, unknown>;
}

/** Which lens proposed this, as the evidence declares it; `null` for a manual edit. */
function readLens(evidence: Record<string, unknown> | null): string | null {
  if (evidence === null || typeof evidence !== 'object') return null;
  return typeof evidence.lens === 'string' ? evidence.lens : null;
}

/** One operation, reduced to its type and what it names. */
function summarizeOperation(operation: { type: string; [key: string]: unknown }): string {
  const node = operation.node as { id?: string } | undefined;
  const edge = operation.edge as { from?: string; to?: string } | undefined;
  switch (operation.type) {
    case 'add_node':
      return `add_node ${node?.id ?? '?'}`;
    case 'remove_node':
      return `remove_node ${String(operation.node_id ?? '?')}`;
    case 'add_edge':
      return `add_edge ${edge?.from ?? '?'} -> ${edge?.to ?? '?'}`;
    case 'remove_edge': {
      const reference = operation.edge as { from?: string; to?: string } | undefined;
      return `remove_edge ${reference?.from ?? '?'} -> ${reference?.to ?? '?'}`;
    }
    case 'change_node_field':
      return `change_node_field ${String(operation.node_id ?? '?')}.${String(operation.field ?? '?')}`;
    default:
      return operation.type;
  }
}

/** One event of a timeline: when, what, who, and the payload clipped. */
export function eventDigest(event: Event): Record<string, unknown> {
  return clipStrings({
    id: event.id,
    at: event.occurred_at,
    type: event.type,
    actor: event.actor === null ? null : `${event.actor.type}:${event.actor.ref ?? ''}`,
    data: event.data,
  }) as Record<string, unknown>;
}

/**
 * A graph version reduced to its map: the nodes, the edges and the gate's
 * verdict.
 *
 * `contracts` travels whole and first among the equals, because a version whose
 * state is not `checked` takes no job at all — the topology below it would
 * describe something that cannot run.
 */
export function versionDigest(version: GraphVersion): Record<string, unknown> {
  const snapshot = version.snapshot ?? {};
  return {
    version_id: version.id,
    graph_id: version.graph_id,
    problem_class: snapshot.problem_class ?? null,
    source: version.source,
    parent_version: version.parent_version,
    proposal_id: version.proposal_id,
    created_at: version.created_at,
    contracts: version.contracts,
    initial_node: snapshot.initial_node ?? null,
    final_nodes: snapshot.final_nodes ?? [],
    nodes: (snapshot.nodes ?? []).map(nodeDigest),
    edges: (snapshot.edges ?? []).map((edge) => ({
      from: edge.from,
      to: edge.to,
      condition: edge.condition ?? null,
    })),
  };
}

/** One node: what it is, who runs it and which skill it is pinned to. */
function nodeDigest(node: GraphNode): Record<string, unknown> {
  return clipStrings({
    id: node.id,
    node_type: node.node_type ?? null,
    role: node.role ?? null,
    engine: node.engine ?? null,
    model: node.model ?? null,
    skill:
      node.skill_ref === undefined
        ? null
        : `${node.skill_ref.id ?? '?'}@${node.skill_ref.version ?? '?'}`,
    description: node.description ?? null,
  }) as Record<string, unknown>;
}

/**
 * A skill, in what somebody choosing a pin for a node needs.
 *
 * The contract travels only when it is asked for: `input` and `output` are JSON
 * Schemas, and a registry of five skills answers with more schema than map if
 * they all come along by default.
 */
export function skillDigest(skill: Skill, withContract: boolean): Record<string, unknown> {
  const summary = {
    id: skill.id,
    version: skill.version,
    role: skill.role,
    description: skill.description,
    hash: skill.hash,
    registered_at: skill.registered_at,
    deprecated_at: skill.deprecated_at,
  };
  return clipStrings(
    withContract
      ? {
          ...summary,
          input: skill.input,
          output: skill.output,
          preconditions: skill.preconditions,
          checks: skill.checks,
        }
      : summary,
  ) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Turns a failure into the one line whoever called can act on.
 *
 * The three failures a caller can actually do something about get their own
 * sentence, with the action in it — the same contract
 * `packages/core/src/cli/url.ts` holds for the CLI, and for the same reason: a
 * `TypeError: fetch failed` handed to a model produces a guess, while "the
 * control plane is not running, start it with `npx cartografo`" produces the
 * next step.
 *
 * The credential is never in any of them. It is not in `ApiError` (which
 * carries the route, the status and the server's body) and it is not added
 * here.
 *
 * @param error Whatever was thrown.
 * @param baseUrl Control plane this server was pointed at.
 * @returns One line for the model.
 */
export function describeFailure(error: unknown, baseUrl: string): string {
  if (error instanceof NetworkError) {
    return `the control plane at ${baseUrl} did not answer — start it with \`npx cartografo\`, or point this server elsewhere with --url / CARTOGRAFO_URL`;
  }
  if (error instanceof DeniedError) {
    return `the control plane at ${baseUrl} refused the credential — set CARTOGRAFO_MCP_TOKEN (or CARTOGRAFO_TOKEN) in this server's environment to the token printed when the control plane started`;
  }
  if (error instanceof ApiError) {
    const body = error.body === undefined ? '' : ` ${JSON.stringify(clipStrings(error.body))}`;
    return `the control plane refused: ${error.message}.${body}`;
  }
  if (error instanceof ToolError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/** JSON Schema of a tool's arguments, as `tools/list` publishes it. */
export interface InputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

/** What a tool is, from the protocol's side and from this package's. */
export interface Tool {
  /** Name the client calls. Prefixed, because a client sees many servers' tools at once. */
  name: string;
  /** What it does, written for the model that has to choose between fourteen of them. */
  description: string;
  inputSchema: InputSchema;
  /** The hints the protocol carries; a client may show them before it calls. */
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  /** Runs it. Returns anything JSON-serializable; the protocol layer encodes it. */
  run: (client: ApiClient, args: Record<string, unknown>) => Promise<unknown>;
}

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const WRITE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

/** An empty argument object — the shape half the read tools take. */
const NO_ARGUMENTS: InputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

/**
 * Resolves which version a caller means.
 *
 * Three ways in, in order: an explicit `version_id`, a `graph_id`, or a
 * `class`. The last two land on whatever version is in force RIGHT NOW, which
 * is the answer somebody asking about "the software-development graph" wants —
 * and the returned digest names the version id it landed on, so the answer says
 * which map it drew.
 */
async function resolveVersion(
  client: ApiClient,
  args: Record<string, unknown>,
): Promise<GraphVersion> {
  const versionId = optionalText(args, 'version_id');
  if (versionId !== undefined) {
    const version = await client.getGraphVersion(versionId);
    if (version === null) throw new ToolError(`no graph version with id "${versionId}"`);
    return version;
  }

  const graphId = optionalText(args, 'graph_id');
  const className = optionalText(args, 'class');
  if (graphId === undefined && className === undefined) {
    throw new ToolError('name one of "version_id", "graph_id" or "class"');
  }

  const current =
    graphId !== undefined
      ? (await client.listGraphs()).find((graph) => graph.id === graphId)?.current_version_id
      : (await client.listClasses()).find((row) => row.class === className)?.current_version_id;

  if (current === undefined) {
    throw new ToolError(
      `no ${graphId !== undefined ? `graph "${graphId}"` : `class "${className}"`} is registered — \`cartografo_list_graphs\` lists what is`,
    );
  }
  if (current === null) {
    throw new ToolError(
      `${graphId !== undefined ? `graph "${graphId}"` : `class "${className}"`} has no version in force yet`,
    );
  }

  const version = await client.getGraphVersion(current);
  if (version === null) throw new ToolError(`the version in force (${current}) could not be read`);
  return version;
}

/** The catalogue, in the order `tools/list` publishes it: read first, write last. */
export const TOOLS: readonly Tool[] = Object.freeze([
  {
    name: 'cartografo_status',
    description:
      'Whether the control plane is up and what it is holding right now: problem classes, paired runners, executions, and the counts of jobs, blocked jobs, pending questions and pending proposals. Start here when asked how the cartografo is doing.',
    inputSchema: NO_ARGUMENTS,
    annotations: { title: 'Control plane status', ...READ_ONLY },
    run: async (client) => {
      const [health, classes, runners, executions, jobs, questions, proposals] = await Promise.all([
        client.health(),
        client.listClasses(),
        client.listRunners(),
        client.listExecutions(),
        client.listJobs(),
        client.listInputRequests({ status: 'pending' }),
        client.listProposals({ status: 'pending' }),
      ]);

      return {
        control_plane: { url: client.baseUrl, health },
        classes: classes.map((row) => ({
          class: row.class,
          graph_id: row.graph_id,
          current_version_id: row.current_version_id,
        })),
        runners: runners.map((runner) => ({
          id: runner.id,
          name: runner.name,
          active_leases: runner.active_leases,
          last_heartbeat: runner.last_heartbeat,
        })),
        executions,
        jobs: {
          total: jobs.length,
          blocked: jobs.filter((job) => job.blocked).length,
          completed: jobs.filter((job) => job.completed).length,
        },
        pending_input_requests: questions.length,
        pending_proposals: proposals.length,
      };
    },
  },
  {
    name: 'cartografo_list_graphs',
    description:
      'The problem classes registered and every lineage under them — bases and the variants forked off them — each with the version currently in force. Use it to find the graph_id or class another tool needs.',
    inputSchema: NO_ARGUMENTS,
    annotations: { title: 'List graphs and classes', ...READ_ONLY },
    run: async (client) => {
      const [classes, graphs] = await Promise.all([client.listClasses(), client.listGraphs()]);
      return { classes, graphs };
    },
  },
  {
    name: 'cartografo_describe_graph',
    description:
      'The map itself: the nodes of a graph version (id, gate or work, role, pinned skill), its edges with their conditions, the initial and final nodes, and the contract gate\'s verdict on the version. A version whose contracts are not "checked" accepts no job. Name one of version_id, graph_id or class.',
    inputSchema: {
      type: 'object',
      properties: {
        class: { type: 'string', description: 'Problem class; reads the version in force.' },
        graph_id: { type: 'string', description: 'Lineage id; reads the version in force.' },
        version_id: { type: 'string', description: 'An exact version id (sha256:…).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Describe a graph version', ...READ_ONLY },
    run: async (client, args) => versionDigest(await resolveVersion(client, args)),
  },
  {
    name: 'cartografo_list_skills',
    description:
      'The capability registry: every version of every skill a node may pin, with the role each plays and the hash it is pinned by. Ask for the contract to get the input and output schemas too. The instructions — the prompt body a session runs on — are never returned; they belong to the session, not to a listing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Only the versions of this skill lineage.' },
        include_contract: {
          type: 'boolean',
          description: 'Include each skill’s input and output schemas, its preconditions and its checks. Default false.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List skills', ...READ_ONLY },
    run: async (client, args) => {
      const withContract = optionalBoolean(args, 'include_contract', false);
      const skills = await client.listSkills({ id: optionalText(args, 'id') });
      return { skills: skills.map((skill) => skillDigest(skill, withContract)) };
    },
  },
  {
    name: 'cartografo_list_jobs',
    description:
      'The board: every job with the node it is standing on, whether it is blocked and why, and whether it has arrived. Optionally narrowed to one execution.',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'integer', description: 'Only the jobs of this execution.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List jobs', ...READ_ONLY },
    run: async (client, args) => {
      const executionId = optionalInteger(args, 'execution_id');
      const jobs = await client.listJobs(
        executionId === undefined ? {} : { execution_id: executionId },
      );
      return { jobs: jobs.map(jobDigest) };
    },
  },
  {
    name: 'cartografo_get_job',
    description:
      'One job with everything that explains where it stands: its own fields, the sessions that ran on it, the questions it is waiting on, and its timeline from the event log. This is the tool for "why is job N not moving".',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'integer', description: 'Job id.' },
        include_timeline: {
          type: 'boolean',
          description: 'Include the event log of this job. Default true.',
        },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Read a job', ...READ_ONLY },
    run: async (client, args) => {
      const id = requireInteger(args, 'job_id');
      const includeTimeline = optionalBoolean(args, 'include_timeline', true);

      const job = await client.getJob(id);
      if (job === null) throw new ToolError(`no job with id ${id}`);

      const [sessions, questions, timeline] = await Promise.all([
        client.listSessions({ job_id: id }),
        client.listInputRequests({ job_id: id }),
        includeTimeline ? client.jobEvents(id) : Promise.resolve(null),
      ]);

      return {
        job: clipStrings(job),
        sessions: sessions.map(sessionDigest),
        input_requests: questions.map(inputRequestDigest),
        timeline: timeline === null ? undefined : timeline.map(eventDigest),
      };
    },
  },
  {
    name: 'cartografo_list_executions',
    description:
      'The executions that exist, each with how many jobs it holds, how many are blocked and how many questions are waiting on a human.',
    inputSchema: NO_ARGUMENTS,
    annotations: { title: 'List executions', ...READ_ONLY },
    run: async (client) => ({ executions: await client.listExecutions() }),
  },
  {
    name: 'cartografo_list_sessions',
    description:
      'Agent sessions: which engine ran, on which node, how it ended, and what it spent in tokens. Narrow by job or by execution.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'integer', description: 'Only the sessions of this job.' },
        execution_id: { type: 'integer', description: 'Only the sessions of this execution.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List sessions', ...READ_ONLY },
    run: async (client, args) => {
      const sessions = await client.listSessions({
        job_id: optionalInteger(args, 'job_id'),
        execution_id: optionalInteger(args, 'execution_id'),
      });
      return { sessions: sessions.map(sessionDigest) };
    },
  },
  {
    name: 'cartografo_read_transcript',
    description:
      'What one agent session printed, as it printed it. Returns the LAST max_chars characters by default, because that is where a failure is; ask for "start" to read from the beginning. The transcript is stored unredacted, so it can contain whatever the session echoed.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'integer', description: 'Session id.' },
        max_chars: {
          type: 'integer',
          description: `Characters to return. Default ${TRANSCRIPT_DEFAULT_CHARS}, ceiling ${TRANSCRIPT_MAX_CHARS}.`,
        },
        from: {
          type: 'string',
          enum: ['end', 'start'],
          description: 'Which end to read from. Default "end".',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Read a session transcript', ...READ_ONLY },
    run: async (client, args) => {
      const id = requireInteger(args, 'session_id');
      const asked = optionalInteger(args, 'max_chars') ?? TRANSCRIPT_DEFAULT_CHARS;
      if (asked <= 0) throw new ToolError('"max_chars" has to be positive');
      const limit = Math.min(asked, TRANSCRIPT_MAX_CHARS);
      const from = optionalChoice(args, 'from', ['end', 'start']) ?? 'end';

      const envelope = await client.sessionTranscript(id);
      if (envelope === null) throw new ToolError(`no session with id ${id}`);

      const whole = envelope.transcript ?? '';
      const slice = from === 'end' ? whole.slice(-limit) : whole.slice(0, limit);

      return {
        session_id: id,
        // Both truncations are named, and they are different facts: the control
        // plane's ceiling on what it stored, and this tool's on what it returned.
        stored_truncated: envelope.transcript_truncated,
        stored_original_size: envelope.transcript_original_size,
        total_chars: whole.length,
        returned_chars: slice.length,
        returned_from: from,
        transcript: slice,
      };
    },
  },
  {
    name: 'cartografo_list_input_requests',
    description:
      'The questions sessions raised for a human: what was asked, the options offered, the recommendation, and the answer if one was given. Filter by status, job or execution.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...INPUT_REQUEST_STATUSES],
          description: 'Only requests in this status.',
        },
        job_id: { type: 'integer', description: 'Only the requests of this job.' },
        execution_id: { type: 'integer', description: 'Only the requests of this execution.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List input requests', ...READ_ONLY },
    run: async (client, args) => {
      const requests = await client.listInputRequests({
        status: optionalChoice(args, 'status', INPUT_REQUEST_STATUSES),
        job_id: optionalInteger(args, 'job_id'),
        execution_id: optionalInteger(args, 'execution_id'),
      });
      return { input_requests: requests.map(inputRequestDigest) };
    },
  },
  {
    name: 'cartografo_list_proposals',
    description:
      'The graph changes a surveyor proposed, with the lens that proposed them, the metric each expects to move and the operations each carries. Reading only: approving, applying, rejecting and reverting a proposal are decisions taken by a human at the screen, and this server exposes no tool for them.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: [...PROPOSAL_STATUSES],
          description: 'Only proposals in this status.',
        },
        graph_id: { type: 'string', description: 'Only proposals against this lineage.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'List proposals', ...READ_ONLY },
    run: async (client, args) => {
      const proposals = await client.listProposals({
        status: optionalChoice(args, 'status', PROPOSAL_STATUSES),
        graph_id: optionalText(args, 'graph_id'),
      });
      return { proposals: proposals.map(proposalDigest) };
    },
  },
  {
    name: 'cartografo_create_job',
    description:
      'Puts a piece of work on the graph. Name the class (the version in force is used, and the entry node defaults to the graph\'s initial node) or an exact graph_version_id. The job waits at its entry node until a runner picks it up; this tool starts no runner.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'One line naming the work.' },
        body: { type: 'string', description: 'The request itself, in full.' },
        class: {
          type: 'string',
          description: 'Problem class; the version in force is what the job is pinned to.',
        },
        graph_version_id: {
          type: 'string',
          description: 'An exact version, instead of the class. One or the other, not both.',
        },
        entry_node_id: {
          type: 'string',
          description: "Node the job starts at. Defaults to the version's initial node.",
        },
        acceptance_criteria: {
          type: 'array',
          items: { type: 'string' },
          description: 'What the work has to satisfy to be finished.',
        },
        execution_id: {
          type: 'integer',
          description: 'Group this job with the others of one round.',
        },
        tier: { type: 'string', description: 'Tier of the job, when the graph uses tiers.' },
        project_id: { type: 'integer', description: 'Project the job belongs to. Default 1.' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    annotations: { title: 'Create a job', ...WRITE },
    run: async (client, args) => {
      const title = requireText(args, 'title');
      const className = optionalText(args, 'class');
      const versionId = optionalText(args, 'graph_version_id');
      if (className !== undefined && versionId !== undefined) {
        throw new ToolError('name "class" or "graph_version_id", not both');
      }

      let entryNode = optionalText(args, 'entry_node_id');
      let pinnedVersion = versionId;

      if (className !== undefined || entryNode === undefined) {
        if (className === undefined && versionId === undefined) {
          throw new ToolError(
            '"entry_node_id" is required unless you name a "class" or a "graph_version_id" to take the initial node from',
          );
        }
        const version = await resolveVersion(
          client,
          className !== undefined ? { class: className } : { version_id: versionId },
        );
        pinnedVersion = version.id;
        entryNode = entryNode ?? version.snapshot.initial_node;
        if (entryNode === undefined) {
          throw new ToolError(
            `version ${version.id} declares no initial node; pass "entry_node_id" explicitly`,
          );
        }
      }

      const job = await client.createJob({
        title,
        entry_node_id: entryNode,
        body: optionalText(args, 'body'),
        acceptance_criteria: optionalTextList(args, 'acceptance_criteria'),
        tier: optionalText(args, 'tier'),
        execution_id: optionalInteger(args, 'execution_id'),
        graph_version_id: pinnedVersion,
        project_id: optionalInteger(args, 'project_id'),
        actor: DEFAULT_ACTOR,
      });

      return { created: jobDigest(job) };
    },
  },
  {
    name: 'cartografo_answer_input_request',
    description:
      'Answers a question a session raised, which is what unblocks the job waiting on it. answered_by goes to the event log: leave it out and the log records "mcp", and name a person only when a person actually decided.',
    inputSchema: {
      type: 'object',
      properties: {
        input_request_id: { type: 'integer', description: 'Input request id.' },
        answer: { type: 'string', description: 'The answer, as the session will read it.' },
        answered_by: {
          type: 'string',
          description: `Who answered. Default "${DEFAULT_ANSWERED_BY}".`,
        },
      },
      required: ['input_request_id', 'answer'],
      additionalProperties: false,
    },
    annotations: { title: 'Answer an input request', ...WRITE },
    run: async (client, args) => {
      const answered = await client.answerInputRequest(
        requireInteger(args, 'input_request_id'),
        requireText(args, 'answer'),
        optionalText(args, 'answered_by') ?? DEFAULT_ANSWERED_BY,
      );
      return { answered: inputRequestDigest(answered) };
    },
  },
  {
    name: 'cartografo_block_job',
    description:
      'Stops a job where it stands, with the reason recorded in the log. Blocked is not a terminal state: the job carries on from the same node when it is unblocked.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'integer', description: 'Job id.' },
        reason: { type: 'string', description: 'Why it is being stopped.' },
      },
      required: ['job_id', 'reason'],
      additionalProperties: false,
    },
    annotations: { title: 'Block a job', ...WRITE },
    run: async (client, args) => {
      const job = await client.blockJob(
        requireInteger(args, 'job_id'),
        requireText(args, 'reason'),
        DEFAULT_ACTOR,
      );
      return { blocked: jobDigest(job) };
    },
  },
  {
    name: 'cartografo_unblock_job',
    description: 'Releases a blocked job; it resumes from the node it stopped at, with a fresh tree.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'integer', description: 'Job id.' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Unblock a job', ...WRITE },
    run: async (client, args) => {
      const job = await client.unblockJob(requireInteger(args, 'job_id'), DEFAULT_ACTOR);
      return { unblocked: jobDigest(job) };
    },
  },
  {
    name: 'cartografo_register_graph',
    description:
      'Registers a graph document as a NEW problem class and its first version. The document goes through the same validation gate the CLI\'s import uses, and a class that already exists is refused rather than overwritten. It does not register skills: a node pinned to a skill the registry does not hold produces a version whose contracts are not "checked", which accepts no job. Importing a factory bundle — skills, hash pins and all — is `npx cartografo import <dir>` at the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        document: {
          type: 'object',
          description:
            'The whole graph document: problem_class, lineage, metadata, nodes, edges, initial_node, final_nodes.',
        },
      },
      required: ['document'],
      additionalProperties: false,
    },
    annotations: { title: 'Register a graph', ...WRITE },
    run: async (client, args) => {
      const document = args.document;
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        throw new ToolError('"document" has to be the graph document, as an object');
      }
      return clipStrings(await client.registerGraph(document));
    },
  },
]);

/** The catalogue by name, for `tools/call`. */
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * Finds a tool by the name a client called.
 *
 * @param name Tool name.
 * @returns The tool, or `undefined` when this server has none by that name.
 */
export function findTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}
