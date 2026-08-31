/**
 * HTTP client of the public API — the only door between the MCP server and the
 * state (D11).
 *
 * The MCP server is one more client of the API, with no privilege at all: it
 * opens no database, imports nothing from `packages/core`, and does not know
 * where the SQLite file lives. Everything a tool answers came through here, and
 * what does not exist here a tool has no way to invent. It is the same boundary
 * `packages/screen/src/client.ts` sits on, and this file is deliberately its
 * twin rather than a shared abstraction: the two consume different slices of
 * the contract, and a common client would be a third place for the wire format
 * to live.
 *
 * The interfaces declare only the SUBSET of the contract this package consumes.
 * One extra field in the control plane's response breaks nothing here, and one
 * missing field breaks in the right place — at the boundary, with the route
 * name in the error.
 *
 * The field names below are the control plane's wire format (English since
 * t226, `docs/spec/glossary-wire.md` §1). This file MIRRORS that format, it
 * does not own it.
 *
 * **Nothing here ever puts the credential in a message.** The token travels in
 * a header and lives in this object; `ApiError` carries the route, the status
 * and the body the server sent, and the request headers are not part of any of
 * the three. That matters more for this package than for the screen: an MCP
 * tool's failure is text handed straight to a model, and from there into a
 * transcript that `packages/core/src/repositories/session.ts` stores
 * unredacted.
 *
 * `doFetch` is injectable for tests only; in production it is the global
 * `fetch`.
 */

/** Answer of `GET /health` — the one route that demands no credential. */
export interface Health {
  status: string;
  db: string;
}

/** One row of `GET /v1/classes`: a problem class and the version in force. */
export interface ClassRow {
  class: string;
  graph_id: string;
  current_version_id: string | null;
  created_at: string;
}

/** One row of `GET /v1/graphs`: a lineage, base or variant (D13). */
export interface GraphRow {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  origin_proposal_id: number | null;
  current_version_id: string | null;
  created_at: string;
}

/** A node of a graph document, in the slice the digest reads. */
export interface GraphNode {
  id: string;
  role?: string;
  node_type?: string;
  description?: string;
  engine?: string;
  model?: string;
  skill_ref?: { id?: string; version?: string; hash?: string };
}

/** An edge of a graph document, in the slice the digest reads. */
export interface GraphEdge {
  from: string;
  to: string;
  condition?: string;
  description?: string;
}

/** The frozen document a version holds, in the slice the digest reads. */
export interface GraphSnapshot {
  problem_class?: string;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  initial_node?: string;
  final_nodes?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * A graph version, as `GET /v1/graph-versions/:id` returns it.
 *
 * `contracts` is the gate's verdict over the document, and the digest reports
 * it whole: a version whose contracts are not `checked` accepts no job
 * (`GraphVersionNotReadyError`), so a map that showed the topology and hid that
 * would be describing something that cannot run.
 */
export interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  created_at: string;
  snapshot: GraphSnapshot;
  contracts: { state: string; problems: unknown[] };
}

/** Projection of a job, as `GET /v1/jobs` returns it. */
export interface Job {
  id: number;
  project_id: number;
  execution_id: number | null;
  title: string;
  body: string | null;
  acceptance_criteria: string[] | null;
  fields: Record<string, unknown> | null;
  tier: string | null;
  entry_node_id: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  graph_version_id: string | null;
  /**
   * The control plane's own answer to "did this job arrive?".
   *
   * Derived over there, out of the job's node and its version's `final_nodes` —
   * data this package has no way to reach, which is exactly why it is read and
   * never recomputed here.
   */
  completed: boolean;
  created_at: string;
  updated_at: string;
}

/** Event envelope, in the slice the timeline reads. */
export interface Event {
  id: number;
  type: string;
  execution_id: number | null;
  entity: { type: string; id: number | string | null } | null;
  actor: { type: string; ref: string | null } | null;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Token totals of a session; `null` when the engine reported nothing. */
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Projection of a session, as `GET /v1/sessions` returns it. */
export interface Session {
  id: number;
  job_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  engine: string;
  working_dir: string | null;
  status: string;
  exit_code: number | null;
  timeout_reason: string | null;
  usage: SessionUsage | null;
  opened_at: string;
  finished_at: string | null;
}

/** Answer of `GET /v1/sessions/:id/transcript`. */
export interface Transcript {
  transcript: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
}

/** Projection of an input request, as `GET /v1/input-requests` returns it. */
export interface InputRequest {
  id: number;
  job_id: number;
  session_id: number | null;
  execution_id: number | null;
  node_id: string | null;
  kind: string;
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
  default_answer: string | null;
  auto_approvable: boolean;
  status: string;
  answer: string | null;
  answered_by: string | null;
  source: string | null;
  created_at: string;
  answered_at: string | null;
}

/** Projection of a proposal, as `GET /v1/proposals` returns it. */
export interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  operations: { type: string; [key: string]: unknown }[];
  evidence: Record<string, unknown> | null;
  expected_metric: string | null;
  status: string;
  applied_version_id: string | null;
  rejection_reason: string | null;
  revert_reason: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

/**
 * A skill of the registry, as `GET /v1/skills` returns it.
 *
 * `instructions` is on the wire and is deliberately absent from this interface:
 * it is the prompt body a session runs on, it is long, and nothing this package
 * does with a skill needs it. What a reader of the registry is choosing between
 * is contracts, and those are here.
 */
export interface Skill {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  preconditions: unknown[];
  checks: unknown[];
  registered_at: string;
  deprecated_at: string | null;
}

/** One row of `GET /v1/executions`. */
export interface ExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
  finished_at: string | null;
}

/** A paired runner and its liveness, as `GET /v1/runners` returns it. */
export interface RunnerHealth {
  id: string;
  name: string | null;
  registered_at: string;
  active_leases: number;
  last_heartbeat: string | null;
}

/** Who the control plane records as the author of a write. */
export interface Actor {
  type: 'user' | 'agent' | 'system';
  ref: string;
}

/** Body of `POST /v1/jobs`, in the slice this package sends. */
export interface NewJob {
  title: string;
  entry_node_id: string;
  body?: string;
  acceptance_criteria?: string[];
  tier?: string;
  execution_id?: number;
  graph_version_id?: string;
  project_id?: number;
  actor?: Actor;
}

/** The slice asked of a listing route. */
export interface Filter {
  execution_id?: number;
  job_id?: number;
  status?: string;
  graph_id?: string;
  id?: string;
}

/**
 * The control plane answered, but with an error.
 *
 * It carries the status because a tool tells "does not exist" (404, an answer a
 * model can act on) from any other refusal — and the body, because a `400` from
 * this API names the field it refused and that is the whole of what makes the
 * failure fixable by whoever called.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(path: string, status: number, body: unknown) {
    super(`the control plane answered ${status} on ${path}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Failure to REACH the control plane — distinct from an error answer from it. */
export class NetworkError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`could not talk to the control plane at ${url}`, { cause });
    this.name = 'NetworkError';
    this.url = url;
  }
}

/**
 * The control plane answered, and it refused the credential.
 *
 * A class of its own and not a status each tool interprets: `401` is never a
 * domain answer — no route means anything by it — so the useful thing to do
 * with it is always the same, and doing it in one place is what guarantees the
 * message is the same too. Same reasoning as `packages/core/src/cli/url.ts`.
 */
export class DeniedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`the control plane refused the credential at ${url}`);
    this.name = 'DeniedError';
    this.url = url;
  }
}

/** Client configuration. */
export interface ClientOptions {
  /** Control plane base URL (e.g. `http://127.0.0.1:4317`). */
  baseUrl: string;
  /** Credential presented on every `/v1/*` call. */
  token?: string;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
}

function queryString(filter: Filter): string {
  const params = new URLSearchParams();
  if (filter.execution_id !== undefined) params.set('execution_id', String(filter.execution_id));
  if (filter.job_id !== undefined) params.set('job_id', String(filter.job_id));
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.graph_id !== undefined) params.set('graph_id', filter.graph_id);
  if (filter.id !== undefined) params.set('id', filter.id);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Decodes the body of an ERROR answer, without ever throwing.
 *
 * Whoever answers an error is not always the control plane: a reverse proxy in
 * the middle answers 502 with an HTML page, and then `JSON.parse` throws a raw
 * `SyntaxError` — which carries neither the status nor the text, and is neither
 * of the failures this module names. Failing to decode the body of an error is
 * not a second failure: it IS the body, as it came.
 *
 * @param text The answer's body, as text.
 * @returns `undefined` for an empty body, the decoded value when it is JSON,
 *   and the raw text itself when it is not.
 */
function decodeErrorBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Thin client of the slice of the public API the MCP tools reach. */
export class ApiClient {
  /** Base URL, already normalized, with no trailing slash. */
  readonly baseUrl: string;
  readonly #doFetch: typeof fetch;
  readonly #token: string | undefined;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#doFetch = options.doFetch ?? fetch;
    this.#token = options.token;
  }

  /** Is the control plane up, and is its database answering? */
  async health(): Promise<Health> {
    return await this.#get<Health>('/health');
  }

  /** The problem classes that exist, with the version in force for each. */
  async listClasses(): Promise<ClassRow[]> {
    const { classes } = await this.#get<{ classes: ClassRow[] }>('/v1/classes');
    return classes;
  }

  /** Every lineage: the bases and the variants forked off them (D13). */
  async listGraphs(): Promise<GraphRow[]> {
    const { graphs } = await this.#get<{ graphs: GraphRow[] }>('/v1/graphs');
    return graphs;
  }

  /**
   * One version, with the frozen document it holds.
   *
   * @param id Version id (the canonical hash of the document).
   * @returns The version, or `null` when there is none by that id.
   */
  async getGraphVersion(id: string): Promise<GraphVersion | null> {
    const body = await this.#getOrNull<{ graph_version: GraphVersion }>(
      `/v1/graph-versions/${encodeURIComponent(id)}`,
    );
    return body === null ? null : body.graph_version;
  }

  /**
   * Registers a graph document as a new lineage plus its first version.
   *
   * @param document The graph document, whole — the same shape
   *   `factory-graphs/<class>/graph.json` carries.
   * @returns Whatever the control plane recorded, untouched.
   * @throws {ApiError} On a refused document (`422`) or a class that already
   *   exists (`409`).
   */
  async registerGraph(document: unknown): Promise<Record<string, unknown>> {
    return await this.#request<Record<string, unknown>>('/v1/graphs', {
      method: 'POST',
      body: document,
    });
  }

  /**
   * The capability registry: every version of every skill, or one lineage.
   *
   * This is the "query the registry of capabilities" step of the idea, read
   * rather than composed: what a node may pin is what is in here.
   */
  async listSkills(filter: Filter = {}): Promise<Skill[]> {
    const { skills } = await this.#get<{ skills: Skill[] }>(`/v1/skills${queryString(filter)}`);
    return skills;
  }

  /**
   * The board: every job, or the ones of a single execution.
   *
   * `execution_id` is the only slice the route takes; anything narrower is the
   * caller's to do over what comes back.
   */
  async listJobs(filter: Filter = {}): Promise<Job[]> {
    const { jobs } = await this.#get<{ jobs: Job[] }>(`/v1/jobs${queryString(filter)}`);
    return jobs;
  }

  /**
   * One job.
   *
   * @param id Job id.
   * @returns The job, or `null` when the control plane says it does not exist.
   */
  async getJob(id: number): Promise<Job | null> {
    return await this.#getOrNull<Job>(`/v1/jobs/${id}`);
  }

  /**
   * The raw timeline of a job, from the event log.
   *
   * @param id Job id.
   * @returns Events in order, or `null` if the job does not exist.
   */
  async jobEvents(id: number): Promise<Event[] | null> {
    const body = await this.#getOrNull<{ events: Event[] }>(`/v1/jobs/${id}/events`);
    return body === null ? null : body.events;
  }

  /** Opens a job on the graph. */
  async createJob(job: NewJob): Promise<Job> {
    return await this.#request<Job>('/v1/jobs', { method: 'POST', body: job });
  }

  /** Blocks a job, naming why — the fact goes to the log with its actor. */
  async blockJob(id: number, reason: string, actor: Actor): Promise<Job> {
    return await this.#request<Job>(`/v1/jobs/${id}/blocks`, {
      method: 'POST',
      body: { reason, actor },
    });
  }

  /** Unblocks a job; it carries on from the node it stopped at. */
  async unblockJob(id: number, actor: Actor): Promise<Job> {
    return await this.#request<Job>(`/v1/jobs/${id}/unblocks`, {
      method: 'POST',
      body: { actor },
    });
  }

  /** The sessions of an execution or of a job. */
  async listSessions(filter: Filter = {}): Promise<Session[]> {
    const { sessions } = await this.#get<{ sessions: Session[] }>(
      `/v1/sessions${queryString(filter)}`,
    );
    return sessions;
  }

  /**
   * What one session printed, as the engine printed it.
   *
   * @param id Session id.
   * @returns The transcript envelope, or `null` if the session does not exist.
   */
  async sessionTranscript(id: number): Promise<Transcript | null> {
    return await this.#getOrNull<Transcript>(`/v1/sessions/${id}/transcript`);
  }

  /** The executions that exist, with the counts of each. */
  async listExecutions(): Promise<ExecutionSummary[]> {
    const { executions } = await this.#get<{ executions: ExecutionSummary[] }>('/v1/executions');
    return executions;
  }

  /** The fleet: every paired runner, with what the lease table says about it. */
  async listRunners(): Promise<RunnerHealth[]> {
    const { runners } = await this.#get<{ runners: RunnerHealth[] }>('/v1/runners');
    return runners;
  }

  /** The proposals, by the slice asked for. Reading only: deciding is the gate's. */
  async listProposals(filter: Filter = {}): Promise<Proposal[]> {
    const { proposals } = await this.#get<{ proposals: Proposal[] }>(
      `/v1/proposals${queryString(filter)}`,
    );
    return proposals;
  }

  /** The input requests, by the slice asked for. */
  async listInputRequests(filter: Filter = {}): Promise<InputRequest[]> {
    const { input_requests: requests } = await this.#get<{ input_requests: InputRequest[] }>(
      `/v1/input-requests${queryString(filter)}`,
    );
    return requests;
  }

  /**
   * Answers a pending input request.
   *
   * @param id Input request id.
   * @param answer What was answered.
   * @param answeredBy Who answered — required in the event payload, and the
   *   only place the log can record that a model and not a person spoke.
   * @returns The input request as it ended up.
   */
  async answerInputRequest(id: number, answer: string, answeredBy: string): Promise<InputRequest> {
    return await this.#request<InputRequest>(`/v1/input-requests/${id}/answer`, {
      method: 'PATCH',
      body: { answer, answered_by: answeredBy },
    });
  }

  async #get<T>(path: string): Promise<T> {
    return await this.#request<T>(path, {});
  }

  /** Like `#get`, but a 404 is an expected answer and becomes `null`. */
  async #getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.#request<T>(path, {});
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async #request<T>(path: string, options: { method?: string; body?: unknown }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const hasBody = options.body !== undefined;

    const headers: Record<string, string> = {};
    if (hasBody) headers['content-type'] = 'application/json';
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;

    let response: Response;
    let text: string;
    try {
      response = await this.#doFetch(url, {
        method: options.method ?? 'GET',
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
      });
      text = await response.text();
    } catch (cause) {
      throw new NetworkError(url, cause);
    }

    // Outside the block above, and on purpose: from here on the control plane
    // ANSWERED, so nothing that happens next is a `NetworkError`.
    if (response.status === 401 || response.status === 403) throw new DeniedError(this.baseUrl);
    if (!response.ok) throw new ApiError(path, response.status, decodeErrorBody(text));
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}
