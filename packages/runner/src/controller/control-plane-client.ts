/**
 * HTTP client of the control plane (t103, FR10).
 *
 * This is the ONLY door between the runner and the state of the system. The
 * runner does not open the database file, imports nothing from
 * `packages/core/src/db` and declares no SQLite driver: only the control plane
 * writes (D1), and the runner is an ordinary client of the public API — the
 * same boundary the screen has (D11). `scripts/check-single-writer.mjs` is the
 * gate of that rule, and `test/no-privileged-access.test.ts` keeps it green.
 *
 * `fetchImpl` is injectable for tests only; in production it is the global
 * `fetch` — the same pattern `packages/screen/src/client.ts` uses.
 *
 * `GET /v1/jobs` is t102's delivery, merged long ago, and answers `{jobs: [...]}`
 * since t226. The client consumes only the subset of the contract it needs in
 * order to pick a candidate — `id` and `blocked` — and declares the remaining
 * fields only to document what arrives; the tests go on faking the route,
 * because what this module proves is the behaviour of the client, not that of
 * t102's server.
 *
 * The FIELD NAMES of this file are the wire, and went English with t226
 * (`docs/spec/glossary-wire.md` §1). The method and class names followed with
 * t304, which is the follow-up ticket the header used to point at: the file
 * itself was renamed from `cliente-controle.ts`, and every exported symbol with
 * it. Two spellings did not move, and neither is a name: `execucao_id` and
 * `depois` in {@link ControlPlaneClient.closeProposalOutcome}'s input are the
 * frozen hypothesis-outcome body (`docs/spec/entities-versioning.md` §5).
 *
 * What this client WRITES in `packages/runner/src/dispatch/report.ts` does not
 * pass through here and is still Portuguese throughout: that one is the client
 * of the EVENT surface, which is the second child of D20.
 */

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeErrorBody,
  requestJsonWithStatus,
  type JsonAnswer,
} from './http-client.ts';

/**
 * A job, as `GET /v1/jobs` (t102) answers it.
 *
 * Subset of the projection of `packages/core/src/repositories/job.ts`: the
 * optional ones are nullable there, and are nullable here for the same reason
 * (execution and graph version are loose, D15).
 */
export interface Job {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  /**
   * "The traveller arrived": `current_node_id` is one of the `final_nodes` of
   * the job's version (t152).
   *
   * Derived on read by the control plane, never stored: a job with no graph, or
   * whose version does not resolve, has no terminal state to reach and answers
   * `false`. It exists here for one reason only — it is what takes a finished
   * job out of the dispatch queue (see
   * {@link ControlPlaneClient.listReleasedJobs}).
   */
  completed: boolean;
  execution_id: number | null;
  graph_version_id: string | null;
}

/**
 * One envelope of the log, as the API answers it (t102).
 *
 * Declared by hand here, like the rest of the file: the client describes the
 * CONTRACT it consumes, and importing the core's type would pierce the boundary
 * this module exists to hold.
 */
export interface Event {
  id: number;
  type: string;
  project_id: number;
  execution_id: number | null;
  entity: { type: string; id: number | string };
  actor: { type: string; ref: string };
  occurred_at: string;
  data: Record<string, unknown>;
}

/** One row of `GET /v1/executions/:id/metrics-by-version` (t102, FR17). */
export interface MetricsByVersion {
  graph_version_id: string | null;
  jobs: number;
  events: number;
}

/**
 * The graph document inside a version.
 *
 * Only `nodes` and `edges` are named: that is what the surveyor reads to build
 * the prompt. The rest of the document arrives whole and passes straight
 * through — the format belongs to `schema/graph.schema.json`, not to this
 * client.
 */
export interface GraphSnapshot {
  nodes?: Array<{ id: string; [key: string]: unknown }>;
  edges?: Array<{ from: string; to: string; condition?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** A graph version, as `GET /v1/graph-versions/:id` answers it (t101). */
export interface GraphVersion {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  snapshot: GraphSnapshot;
  created_at: string;
}

/** What `POST /v1/proposals` requires: a semantic diff with a hypothesis (D15). */
export interface ProposalInput {
  graph_id: string;
  target_version: string;
  /** The vocabulary INSIDE the operation is D20's third child, and does not move. */
  operations: readonly unknown[];
  evidence: unknown;
  expected_metric: unknown;
}

/**
 * A proposal, in the slice the runner needs out of the answer.
 *
 * `expected_metric` and `result` arrive as `unknown` on purpose: the shape of
 * both belongs to the control plane (`hypothesis.ts`) and D20 does not unfreeze
 * it — the KEYS went English in t226, their content did not move a byte. The
 * runner only forwards them or reads the `nome` inside.
 */
export interface Proposal {
  id: number;
  graph_id: string;
  target_version: string;
  status: string;
  applied_version_id: string | null;
  expected_metric?: unknown;
  result?: unknown;
}

/**
 * What `POST /v1/intake` requires (t122): the class, the request and the
 * breakdown into items.
 *
 * `items` is `unknown[]` on purpose, like `operations` in
 * {@link ProposalInput}. The shape of an item belongs to the control plane
 * (`domain/intake.ts`, `validateItems`), which answers the whole report of
 * problems in a 400 — and a bad draft is cheap and reversible, so mirroring
 * that judgement here would be a second copy that can drift.
 *
 * `execucao_id` does not appear: the route defaults it, and the field arrives
 * the day somebody needs it. `project_id` DOES appear, since t421 — the
 * `intake` command resolves a `--project` (default 1, `command-line.ts`) and
 * has to say which project the draft is created in, the same way it already
 * has to say which project's classes it checked against.
 */
export interface IntakeInput {
  /** Class whose registered graph the batch will cross. */
  class: string;
  /** The request in natural language, as it arrived. */
  request: string;
  /** The proposed breakdown, exactly as whoever wrote it declared. */
  items: readonly unknown[];
  /** Project the draft is created in. Always present — the caller always resolves one. */
  project_id: number;
}

/**
 * An intake draft, as the API answers it (t122).
 *
 * Full projection of `intake_rascunho`, because that is what arrives in the
 * `201`. `items` arrives as an open object for the same reason as in
 * {@link IntakeInput}: the item's contract lives on the other side of the
 * boundary.
 */
export interface Draft {
  id: number;
  project_id: number;
  execution_id: number | null;
  class: string;
  request: string;
  items: Array<Record<string, unknown>>;
  /** `pending` at birth; `confirmed`/`discarded` only by human decision. */
  status: string;
  /** `ref` → real job id; `null` while nobody has confirmed. */
  created_jobs: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

/** A paired runner. */
export interface Runner {
  id: string;
  name: string | null;
  registered_at: string;
}

/**
 * A model, in the body `POST /v1/engines/:name/models` receives (t166).
 *
 * The keys are the API's, like the rest of this client: the `EngineAdapter`
 * vocabulary (`id`, `label`, `origin`) dies in the runner, and what crosses the
 * boundary is the API's data format. The two VALUES of `source` stay English,
 * because they are the adapter's vocabulary — it is what produced them.
 */
export interface ReportedModel {
  model_id: string;
  label?: string | null;
  source: 'cli' | 'catalog';
}

/** The catalogue of one engine, as the control plane answers it. */
export interface EngineCatalog {
  engine: string;
  models: Array<ReportedModel & { updated_at: string }>;
}

/**
 * What a runner reports about its own machine (t401).
 *
 * Declared here, in the wire's own spelling, like everything else in this file:
 * the `EngineAdapter` vocabulary — `CliProbe.available`, `McpDiscovery.origin`,
 * `resolvedAt` — dies in `cli/run.ts`, and what crosses the boundary is the
 * API's data format. Importing the control plane's type would pierce the very
 * boundary this module exists to hold.
 */
export interface ProbeReport {
  cli: { available: boolean; version: string | null; authenticated: boolean };
  /**
   * What discovery found, or the fact that this engine has none.
   *
   * Two shapes and not one with an empty list, because they are two different
   * facts: `discoverMcpServers?()` is optional ON THE MEMBER, and an adapter
   * that never implemented it is NOT an engine with zero MCP servers
   * (`engine/types.ts`). Collapsing them here would tell an operator a lie
   * about their own machine.
   */
  mcp:
    | { supported: false }
    | {
        supported: true;
        servers: Array<{ name: string }>;
        origin: 'cli' | 'file';
        resolved_at: string | null;
      };
  workspace: {
    working_dir: string;
    working_dir_resolved: string;
    is_git_repo: boolean;
    worktrees_root: string;
    worktrees_root_resolved: string;
    worktrees_root_exists: boolean;
    worktrees_root_writable: boolean;
  };
}

/** The same report, as the control plane hands it back after storing it. */
export interface RunnerProbe extends ProbeReport {
  runner_id: string;
  reported_at: string;
}

/** An operator's standing request that this runner report again (t401). */
export interface RunnerRecheck {
  id: number;
  runner_id: string;
  requested_at: string;
  /** When a probe answered it. Always `null` in what this client reads: it only asks for the pending one. */
  served_at: string | null;
}

/** Possible states of a lease, in the control plane's vocabulary. */
export type LeaseStatus = 'active' | 'released' | 'expired';

/** Why a lease died. */
export type ExpirationReason = 'heartbeat_lost' | 'ttl_elapsed';

/** Why a request did not become a lease. None of them is an error. */
export type DenialReason = 'job_already_leased' | 'runner_cap' | 'project_cap';

/** A lease, as the control plane answers it. */
/**
 * The local runner's defaults one project holds, as `GET /v1/settings` answers
 * them (t403, consumed by t404).
 *
 * Every key but the id is optional, and that is the contract rather than an
 * omission: a project the control plane never seeded — any id other than the
 * default one it seeds on `start()` — answers with `{project_id}` alone. So a
 * caller that starts on these values has to decide what an absent one means;
 * `cli/run.ts` does, and refuses to start rather than invent a directory.
 *
 * The three keys are the control plane's own spelling
 * (`packages/core/src/repositories/settings.ts`, `KNOWN_SETTING_KEYS`), with no
 * `runner_` prefix, and `engine` is a plain string here: the API does not
 * promise it is one of the two names `--engine` accepts, so validating it is
 * the caller's job.
 */
export interface Settings {
  project_id: number;
  /** The git repository a session's worktree is cut from. */
  workspace_root?: string;
  /** The directory those worktrees are created under. */
  worktrees_root?: string;
  /** The engine a runner of this project opens its sessions on. */
  engine?: string;
  /**
   * Whether this workspace may clone a repository — `'true'` / `'false'` (t439).
   *
   * A string like every other setting, and read as "anything but `'false'` is
   * yes": the key is seeded `'true'`, so a project nobody configured allows the
   * one thing that reads it — the interview cloning the repository of skills a
   * person pointed it at (t440, `resolve-skill-source.ts`).
   */
  allow_git_clone?: string;
}

export interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: LeaseStatus;
  ttl_seconds: number;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: ExpirationReason | null;
}

/** What the runner declares when it disputes a job. */
export interface LeaseRequest {
  runner_id: string;
  project_id: number;
  job_id: number;
  runner_cap: number;
  project_cap: number;
  ttl_seconds: number;
}

/** Answer of `POST /v1/leases`: either a lease came out, or the reason did. */
export interface LeaseGrantResponse {
  lease: Lease | null;
  reason?: DenialReason;
}

/** Configuration of the client. */
export interface ClientOptions {
  /** Base URL of the control plane (e.g. `http://127.0.0.1:4317`). */
  urlBase: string;
  /**
   * Credential presented on every call (t124, t143).
   *
   * Generic on purpose: it is any token the control plane accepts. In
   * production it is the credential pairing issued for THIS runner (`token` in
   * the `201` of `POST /v1/runners`), which only reaches the dispatch routes
   * and only as this `runner_id`; an operator's works, and is what the oldest
   * tests use, but it gives the runner access it does not need to have. With no
   * token at all the client sends no header and takes a 401, which is the
   * honest behaviour: an empty header would look like a credential.
   */
  token?: string;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Deadline of each call, in milliseconds (t193, FR2).
   *
   * Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}. What it exists to catch is not
   * a control plane that is down — that one answers, and every method here
   * already knows what to do with the answer — but one that accepts the
   * connection and writes nothing: with no deadline the call waits forever, and
   * with it the tick that made it, the loop that waits on the tick and the
   * shutdown that waits on the loop.
   */
  requestTimeoutMs?: number;
}

/**
 * Error answer of the control plane.
 *
 * Carries the status and the body: the controller has to tell "runner not
 * paired" (404, a configuration error — insisting does not help) from a passing
 * failure, and whoever logs it needs the body to know what.
 *
 * Named `ControlPlaneClientError` and not `ControlPlaneError` because that name
 * is taken, by a differently shaped class of `synthesizer/control-plane-client.ts`
 * — unifying the two is still a separate ticket (t304).
 */
export class ControlPlaneClientError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ControlPlaneClientError';
    this.status = status;
    this.body = body;
  }
}

/** Thin client of the control plane's API. */
export class ControlPlaneClient {
  /** Base URL, already normalized, with no trailing slash. */
  readonly urlBase: string;
  readonly #fetchImpl: typeof fetch;
  readonly #token: string | undefined;
  readonly #requestTimeoutMs: number;

  constructor(options: ClientOptions) {
    this.urlBase = options.urlBase.replace(/\/+$/, '');
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#token = options.token;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Pairs the runner. Idempotent on the server: calling again is not an error (D5).
   *
   * @param id Identity the runner declares.
   * @param name Readable name, optional.
   * @returns The runner as it was registered.
   */
  async registerRunner(id: string, name?: string): Promise<Runner> {
    const body = name === undefined ? { id } : { id, name };
    const { runner } = await this.#post<{ runner: Runner }>('/v1/runners', body);
    return runner;
  }

  /**
   * Reports which models this runner's engine offers (t166, FR11).
   *
   * Replaces the catalogue stored for that engine, and that is the semantics
   * the caller needs to know: reporting again does not add, it overwrites.
   * "Refreshing" is restarting the process — there is no timer, there is no
   * TTL, and it is the same posture {@link ControlPlaneClient.registerRunner}
   * already has for pairing.
   *
   * @param engine Name the adapter gives itself.
   * @param models The catalogue, already translated out of the adapter's
   *   vocabulary.
   * @returns The catalogue as it was stored.
   * @throws {ControlPlaneClientError} When the control plane refuses the shape
   *   (400) or the credential (401/403). Whoever calls decides whether that
   *   stops the boot — and in `run.ts` it does not.
   */
  async reportEngineModels(
    engine: string,
    models: readonly ReportedModel[],
  ): Promise<EngineCatalog> {
    return await this.#post<EngineCatalog>(
      `/v1/engines/${encodeURIComponent(engine)}/models`,
      { models },
    );
  }

  /**
   * The settings of one project — the paths and the engine a runner started
   * without them falls back to (t404, FR1).
   *
   * The project travels as a query filter and not as a path segment, because
   * that is the shape t403 published (`packages/core/src/routes/settings.ts`),
   * following `GET /v1/leases`'s own convention.
   *
   * **A 403 here is not a bug in this client.** `GET /v1/settings` is
   * operator-only by omission from `auth.ts`'s `RUNNER_SURFACE`, which is t403's
   * design and is pinned by a test of its own: a runner holding a plain
   * runner-scoped credential earns `403 out_of_scope_credential`. The caller
   * this method exists for — a runner the one-command startup spawned — is
   * handed an operator-scoped credential over its environment, so for it the
   * call succeeds. For anybody else the refusal is just one more shape of "the
   * settings fetch failed", and `cli/run.ts` lets it travel up untouched.
   *
   * @param projectId Project whose settings to read.
   * @returns The settings, with every key but the id optional — a project
   *   nobody seeded answers with its id alone, and that is a 200.
   * @throws {ControlPlaneClientError} On any non-2xx, the 401/403 of a
   *   credential this surface does not accept included.
   */
  async getSettings(projectId: number): Promise<Settings> {
    return await this.#get<Settings>(`/v1/settings?project_id=${String(projectId)}`);
  }

  /**
   * Reports what this machine is — CLI, MCP servers, workspace (t401, FR7).
   *
   * Replaces whatever this runner reported before: latest wins, one probe per
   * runner, the same semantics {@link ControlPlaneClient.reportEngineModels}
   * already has for the catalogue. Unlike that one, reporting is never skipped
   * for a CLI that did not answer — `available: false` IS the fact an operator
   * needs.
   *
   * It also SERVES a pending re-check, on the control plane's side and in the
   * same transaction as the write. There is no acknowledgement call to make
   * afterwards; a fresh report is the answer to the request.
   *
   * @param runnerId This runner's own id. A credential is good for one
   *   identity, and another runner's id is a `403`.
   * @param report What the machine said about itself.
   * @returns The probe as it was stored.
   * @throws {ControlPlaneClientError} When the control plane refuses the shape
   *   (400), the credential (401/403) or the id (404). Whoever calls decides
   *   whether that stops anything — and in `run.ts` it does not.
   */
  async reportProbe(runnerId: string, report: ProbeReport): Promise<RunnerProbe> {
    const { probe } = await this.#post<{ probe: RunnerProbe }>(
      `/v1/runners/${encodeURIComponent(runnerId)}/probes`,
      report,
    );
    return probe;
  }

  /**
   * Has anybody asked this runner to report again? (t401, FR9)
   *
   * Pull and not push, and that is the whole design: the control plane holds a
   * pending row, the runner asks about it on its own loop, and reporting a
   * fresh probe is what closes it. Nothing here opens a socket, and the runner
   * stays what it is — an ordinary HTTP client of the public API (D1, D11).
   *
   * @param runnerId This runner's own id; another's is a `403`.
   * @returns The pending request, or `null` when nothing is waiting.
   */
  async getPendingRecheck(runnerId: string): Promise<RunnerRecheck | null> {
    const { recheck } = await this.#get<{ recheck: RunnerRecheck | null }>(
      `/v1/runners/${encodeURIComponent(runnerId)}/rechecks`,
    );
    return recheck;
  }

  /**
   * Jobs of one project that are ready to be dispatched.
   *
   * Both filters live here, on the client side, so as to consume t102's
   * contract without depending on a query parameter that ticket never promised.
   *
   * `blocked` takes out whoever is waiting on a person; `completed` takes out
   * whoever arrived (t161). The second one is the difference between a crossing
   * that ends and a loop: without it, a job that lands on a final node stays
   * released forever, and the controller redispatches it to the same node on
   * every tick. The field has come out of `GET /v1/jobs` since t152 — what was
   * missing was somebody reading it.
   *
   * The SCOPE, on the other hand, is the server's own filter and has to be sent
   * (t410): `GET /v1/jobs` reads one project's board since that ticket, and a
   * poll that names none reads project 1's. A runner working project 2 would
   * then see an empty board on every tick and dispatch nothing at all — no
   * error, no event, just silence — which is the same shape of failure t198's
   * first crossing hit. Every lease this client asks for is already scoped
   * (`requestLease`), so the controller has the number to send.
   *
   * @param projectId Project whose board to read; omitted, the server's own
   *   default (project 1) answers, which is what every caller written before
   *   the partition meant.
   * @returns Only the jobs that can still move, in the order the server sent
   *   them.
   */
  async listReleasedJobs(projectId?: number): Promise<Job[]> {
    const scope = projectId === undefined ? '' : `?project_id=${String(projectId)}`;
    const { jobs } = await this.#get<{ jobs: Job[] }>(`/v1/jobs${scope}`);
    return jobs.filter((job) => job.blocked === false && job.completed === false);
  }

  /**
   * Disputes a job.
   *
   * @param request Runner, project, job, both caps and the TTL.
   * @returns The granted lease, or `{lease: null, reason}` — a denial is a
   *   normal answer, not an exception.
   */
  async requestLease(request: LeaseRequest): Promise<LeaseGrantResponse> {
    return await this.#post<LeaseGrantResponse>('/v1/leases', request);
  }

  /**
   * Pushes the lease's deadline forward.
   *
   * @param leaseId Active lease.
   * @param ttlSeconds New TTL; without it, the server keeps the lease's own.
   * @param timeoutMs Deadline of THIS call, in milliseconds (t193, FR3).
   *   Without it, the client's. It exists because the heartbeat is the one call
   *   of this client with a natural deadline shorter than the general one:
   *   whoever arms it knows how long until the next one falls due, and a
   *   heartbeat still in flight when the following one falls due is one that is
   *   already good for nothing.
   * @returns The renewed lease.
   */
  async heartbeat(leaseId: number, ttlSeconds?: number, timeoutMs?: number): Promise<Lease> {
    const body = ttlSeconds === undefined ? {} : { ttl_seconds: ttlSeconds };
    const { lease } = await this.#post<{ lease: Lease }>(
      `/v1/leases/${leaseId}/heartbeats`,
      body,
      timeoutMs,
    );
    return lease;
  }

  /**
   * Gives the lease back and, with it, the slot in the concurrency cap.
   *
   * @param leaseId Active lease.
   * @returns The released lease.
   */
  async release(leaseId: number): Promise<Lease> {
    const { lease } = await this.#post<{ lease: Lease }>(`/v1/leases/${leaseId}/releases`, {});
    return lease;
  }

  /* ------------------------------------------------------------------------ */
  /* t110 — the three reads and the one write the flow surveyor needs.         */
  /* Same door as everything else: the runner speaks HTTP and nothing else.    */
  /* ------------------------------------------------------------------------ */

  /**
   * The whole log of one execution, in `id` order (t110, FR1).
   *
   * @param executionId Opaque grouper of the round.
   * @returns Every event of the execution; an empty list when there was none —
   *   an execution is not an entity, so there is no 404 here.
   */
  async listExecutionEvents(executionId: number): Promise<Event[]> {
    const { events } = await this.#get<{ events: Event[] }>(
      `/v1/executions/${executionId}/events`,
    );
    return events;
  }

  /**
   * Graph version × telemetry of that execution (t102, FR17).
   *
   * This is how the surveyor finds out WHICH version the round ran under: the
   * log does not carry `grafo_versao_id` (the schema of `trabalho.criado` does
   * not declare it), and this query exists exactly for the crossing.
   *
   * @param executionId Opaque grouper of the round.
   * @returns One row per version; the `null` row groups jobs with no version.
   */
  async metricsByVersion(executionId: number): Promise<MetricsByVersion[]> {
    const { metrics } = await this.#get<{ metrics: MetricsByVersion[] }>(
      `/v1/executions/${executionId}/metrics-by-version`,
    );
    return metrics;
  }

  /**
   * One graph version, with the whole snapshot.
   *
   * @param id Id of the version (the snapshot's hash, with `:` — hence the encode).
   * @returns The version and the document it freezes.
   * @throws {ControlPlaneClientError} 404 when the version does not exist.
   */
  async getGraphVersion(id: string): Promise<GraphVersion> {
    const { graph_version: version } = await this.#get<{ graph_version: GraphVersion }>(
      `/v1/graph-versions/${encodeURIComponent(id)}`,
    );
    return version;
  }

  /**
   * Creates a proposal — which is born, always, `pending`.
   *
   * There is no `apply` counterpart in this client on purpose: applying is a
   * human decision (README, principle 5), and a client that does not have the
   * method does not take it by accident.
   *
   * `created` is t247's, and what it settles is an ambiguity t246 created: the
   * control plane's deduplication answers `200` with the pending proposal that
   * already existed, instead of `201` with a clone, and that proposal reads
   * `pending` exactly like a freshly created one. Whoever calls twice by
   * accident does not need to know the difference; whoever fires alone, with
   * nobody reading a report (D21), does — it is the difference between "I
   * proposed" and "this was already proposed".
   *
   * @param input Graph, target version, operations, evidence and expected metric.
   * @returns The stored proposal, and whether this call is the one that created
   *   it (`201`) or whether it matched a pending one and only reinforced its
   *   evidence (`200`, t246).
   * @throws {ControlPlaneClientError} 400 when the server refuses the shape.
   */
  async createProposal(input: ProposalInput): Promise<{
    proposal: Proposal;
    created: boolean;
  }> {
    const { body, status } = await this.#postWithStatus<{ proposal: Proposal }>(
      '/v1/proposals',
      input,
    );
    return { proposal: body.proposal, created: status === 201 };
  }

  /**
   * One proposal, by id (t165, FR9).
   *
   * Whoever is going to close the experiment needs the `expected_metric` the
   * hypothesis declared — it is its `nome` that says WHICH number to measure in
   * the following round.
   *
   * @param id Id of the proposal.
   * @returns The proposal, in the slice the runner consumes.
   * @throws {ControlPlaneClientError} 404 when the proposal does not exist.
   */
  async getProposal(id: number): Promise<Proposal> {
    const { proposal } = await this.#get<{ proposal: Proposal }>(`/v1/proposals/${id}`);
    return proposal;
  }

  /**
   * Closes the experiment of an applied proposal (t165, FR7).
   *
   * This is the ONLY write that ticket adds to the client, and the reason it
   * gets to exist is that closing an outcome is reporting a measured fact, not
   * taking a decision with a gate. There is still no `apply`, `revert`,
   * `approve` or `reject` here, for the same reason
   * {@link ControlPlaneClient.createProposal} already documents: those four are
   * a human decision (README, principle 5), they live on the screen or in the
   * operator's `curl`, and a client that does not have the button does not press
   * it by accident.
   *
   * The `depois` is the caller's: there is no named-metric engine in v1
   * (`docs/spec/entities-versioning.md` §5). Whoever computes it is the
   * surveyor, with `measureForExpectedMetric` over the telemetry of the
   * following round.
   *
   * Both keys of `input` are spelled in Portuguese and stay that way (t304,
   * FR6): `execucao_id` and `depois` are the frozen hypothesis-outcome body,
   * sent verbatim as the JSON body of `POST /v1/proposals/:id/outcome`. They are
   * a recorded value, not a name of this package.
   *
   * @param id Applied proposal.
   * @param input Following execution and the number measured in it.
   * @returns The proposal with the verdict already stored.
   * @throws {ControlPlaneClientError} 409 when the outcome was already stored
   *   (`proposta_ja_avaliada`) or the proposal is not applied; 422 when no job
   *   of that execution ran under the applied version.
   */
  async closeProposalOutcome(
    id: number,
    input: { execucao_id: number; depois: number },
  ): Promise<Proposal> {
    const { proposal } = await this.#post<{ proposal: Proposal }>(
      `/v1/proposals/${id}/outcome`,
      input,
    );
    return proposal;
  }

  /* ------------------------------------------------------------------------ */
  /* t144 — the one write intake generation adds.                             */
  /* ------------------------------------------------------------------------ */

  /**
   * Every class registered for one project — the read `intake` consults before
   * it opens a session (FR3a).
   *
   * The project travels as a query filter, not a path segment, following the
   * same convention {@link ControlPlaneClient.getSettings} already uses for
   * `GET /v1/settings` and {@link ControlPlaneClient.listReleasedJobs} follows
   * for `GET /v1/jobs`. Required, with no default baked in here: `--project`'s
   * default (1) is `command-line.ts`'s decision, not this client's.
   *
   * @param projectId Project whose registered classes to read.
   * @returns The classes registered for that project, in the order the route
   *   sent them.
   */
  async getClasses(projectId: number): Promise<readonly { class: string }[]> {
    const { classes } = await this.#get<{ classes: Array<{ class: string }> }>(
      `/v1/classes?project_id=${String(projectId)}`,
    );
    return classes;
  }

  /**
   * Proposes an intake draft — which is born, always, `pending`.
   *
   * There is no `confirm`, `amend` or `discard` counterpart in this client, and
   * the reason is the one {@link ControlPlaneClient.createProposal} already
   * documents: confirming is the human gate of the intake layer
   * (`docs/spec/intake.md` §1), and a client that does not have the method does
   * not take the decision by accident. What this method stores is a proposed
   * breakdown anybody can still edit by `PATCH`, discard, or simply ignore:
   * nothing in it creates a job and nothing in it emits an event.
   *
   * @param input Class, request and the breakdown into items.
   * @returns The stored draft.
   * @throws {ControlPlaneClientError} 404 when the class has no base graph; 400
   *   when `items` does not pass the server's validation (`itens_invalidos`).
   */
  async createIntake(input: IntakeInput): Promise<Draft> {
    const { draft } = await this.#post<{ draft: Draft }>('/v1/intake', input);
    return draft;
  }

  /** Headers of a call: the body's `content-type`, if any, and the credential. */
  #headers(withBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (withBody) headers['content-type'] = 'application/json';
    if (this.#token !== undefined) headers.authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #get<T>(route: string, timeoutMs?: number): Promise<T> {
    return (await this.#call<T>('GET', route, undefined, timeoutMs)).body;
  }

  async #post<T>(route: string, body: unknown, timeoutMs?: number): Promise<T> {
    return (await this.#call<T>('POST', route, body, timeoutMs)).body;
  }

  /**
   * The same `POST`, with the status still attached (t247).
   *
   * It exists for one route only — `POST /v1/proposals` —, where the status IS
   * the answer: since t246 the control plane answers `201` when it created and
   * `200` when it matched a pending proposal and reinforced its evidence. The
   * other `#post`s go on reading the body alone, because for them a 2xx is a
   * 2xx.
   */
  async #postWithStatus<T>(
    route: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<JsonAnswer<T>> {
    return await this.#call<T>('POST', route, body, timeoutMs);
  }

  /**
   * The one way out of this class (t193, FR2).
   *
   * The mechanic — deadline, status before body, decoding — lives in
   * `http-client.ts`, and what is left here is what belongs to THIS client: the
   * base URL, the headers and the {@link ControlPlaneClientError} it promises.
   * The `corpoDeErro` that lived in this file since t156 became `decodeErrorBody`
   * over there, with the same rule and a single owner.
   *
   * @param method HTTP method.
   * @param route Path from the base URL.
   * @param body Body to send, when there is one.
   * @param timeoutMs Deadline of this call. Without it, the client's.
   * @returns The decoded body of the answer, and the status it came with.
   */
  async #call<T>(
    method: string,
    route: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<JsonAnswer<T>> {
    return await requestJsonWithStatus<T>({
      url: `${this.urlBase}${route}`,
      method,
      headers: this.#headers(body !== undefined),
      body,
      timeoutMs: timeoutMs ?? this.#requestTimeoutMs,
      fetchImpl: this.#fetchImpl,
      buildError: ({ status, body: failureBody }) =>
        new ControlPlaneClientError(
          // The message is what an operator reads on the stderr of `prune`, of
          // `intake` and of the surveyor, and that is why it has been English
          // since t254 — as the neighbouring "the control plane did not answer
          // for it" already was.
          `${method} ${route} answered ${status}`,
          status,
          decodeErrorBody(failureBody),
        ),
    });
  }
}
