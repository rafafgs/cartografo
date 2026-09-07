/**
 * HTTP client of the public API — the only door between the screen and the
 * state (t107).
 *
 * The screen is one more client of the API, with no privilege at all (D11): it
 * opens no database, imports nothing from `packages/core`, and does not even
 * know where the SQLite file lives. Everything it shows came through here, and
 * what does not exist here the screen has no way to invent — which is why this
 * ticket closed three gaps in the API instead of working around them
 * (`GET /v1/executions` and the `trabalho_id` filter on sessions and questions).
 *
 * The interfaces declare only the SUBSET of the contract the screen consumes,
 * in the same spirit as `packages/runner/src/controller/cliente-controle.ts`:
 * one extra field in the control plane's response breaks nothing here, and one
 * missing field breaks in the right place — at the boundary, with the route
 * name in the error.
 *
 * The field names below are the control plane's wire format — English since
 * t226 (`docs/spec/glossary-wire.md` §1). This file MIRRORS that format, it
 * does not own it: the interfaces are declared here so a missing field breaks
 * at the boundary, with the route name in the error, and they move whenever the
 * API moves.
 *
 * The method names of {@link ApiClient} were already English before this ticket
 * (D18 covers identifiers) and did not change: what moved is only what travels.
 *
 * The one call that still spoke Portuguese on the way IN stopped with t227:
 * {@link ApiClient.answerQuestion} PATCHes `{answer, answered_by}`. That
 * route's body is validated against the `input_request.answered` EVENT
 * contract, and the event vocabulary was D20's second child.
 *
 * `doFetch` is injectable for tests only; in production it is the global
 * `fetch`.
 */

/**
 * The six words RF-30 defines for "what is this job doing right now" (t415).
 *
 * In the control plane's own attention-priority order — the same order
 * `boardPage` groups by (t416).
 */
export type JobState =
  | 'awaiting_you'
  | 'blocked_unasked'
  | 'running'
  | 'unowned'
  | 'completed'
  | 'queued';

/**
 * A screen-local mirror of core's `ScalarMap` (D11 — no import from
 * `packages/core`): a flat object of string, number or boolean values.
 */
export type JobFields = Record<string, string | number | boolean>;

/**
 * Who the control plane records as the author of a write (t339).
 *
 * The minimal shape of the envelope's `actor`, declared HERE and never imported
 * from `packages/core` — the screen mirrors the wire format, it does not share
 * the core's types (D11). `type` is narrowed to `'user'` because that is the
 * only actor this screen has any business claiming to be: everything it writes
 * was somebody clicking a form.
 */
export interface ScreenActor {
  type: 'user';
  ref: string;
}

/**
 * Body of `POST /v1/jobs/:id/blocks` and `/unblocks`, as the screen sends it.
 *
 * The `actor` is never left out. `resolveActor` on the control plane defaults an
 * absent one to the API's own identity, i.e. "the control plane" and not a
 * person — and the one thing this audit trail has to keep straight is which of
 * the two lowered a flag (`packages/core/src/repositories/input-request.ts`
 * makes the same point about the unblock that follows an answer). A required
 * field here is what makes forgetting it a type error instead of a quiet lie.
 */
export interface FlagInput {
  reason: string;
  actor: ScreenActor;
}

/**
 * Body of `POST /v1/jobs`, in the four fields this screen ever sends (t433).
 *
 * Narrower than the route's own contract on purpose: `POST /v1/jobs` accepts
 * acceptance criteria, class fields, a tier and a round, and the one form of
 * this screen that creates a job asks for none of them. A field the page cannot
 * fill has no business being declarable here.
 */
export interface NewJob {
  title: string;
  body: string;
  entry_node_id: string;
  graph_version_id: string;
}

/** Projection of a job, as `GET /v1/jobs` returns it. */
export interface Job {
  id: number;
  execution_id: number | null;
  title: string;
  entry_node_id: string;
  current_node_id: string;
  blocked: boolean;
  block_reason: string | null;
  graph_version_id: string | null;
  /**
   * The control plane's own answer to "did this job arrive?" (t152).
   *
   * Derived over there, out of the job's node and its graph version's
   * `final_nodes` — data the screen has no way to reach, which is exactly why it
   * is read and not recomputed here.
   */
  completed: boolean;
  /**
   * What this job is doing right now, in the six words RF-30 defines (t415).
   *
   * Derived over there, read and never recomputed here — same posture as
   * {@link Job.completed} above.
   */
  state: JobState;
  /** When the job entered {@link Job.state}, as an ISO instant (t415). */
  state_since: string;
  /**
   * Values of the fields the job's class declares (t168); `null` when it
   * carries none. The board's only use of this today is the `demo` badge
   * (t416) — nothing here interprets any other key.
   */
  fields: JobFields | null;
  created_at: string;
  updated_at: string;
}

/** One row of `GET /v1/executions`. */
export interface ExecutionSummary {
  execution_id: number | null;
  jobs: number;
  blocked_jobs: number;
  pending_input_requests: number;
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
  /** Still the column's value: session status is the event surface (t226, FR1). */
  status: string;
  exit_code: number | null;
  usage: SessionUsage | null;
  opened_at: string;
  finished_at: string | null;
}

/** One row of `GET /v1/jobs/:id/artifacts` (t368, RF-39). */
export interface Artifact {
  id: number;
  session_id: number;
  /** Joined from the session that produced it; `null` for a session with none declared. */
  node_id: string | null;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
}

/** `GET /v1/sessions/:id/log`'s answer — the decoded session log (t368, RF-39/RF-40). */
export interface SessionLog {
  session_id: number;
  node_id: string | null;
  engine: string;
  exit_code: number | null;
  /** The decoded text, or `null` when the session recorded no transcript. */
  text: string | null;
  transcript_truncated: boolean;
  transcript_original_size: number | null;
  /** The artifact holding the WHOLE transcript, when the cap bit; `null` until t424 populates it. */
  transcript_artifact_id: number | null;
}

/** Projection of an input request, as `GET /v1/input-requests` returns it. */
export interface Question {
  id: number;
  job_id: number;
  execution_id: number | null;
  kind: string;
  question: string;
  context: string | null;
  options: string[] | null;
  recommendation: string | null;
  default_answer: string | null;
  status: string;
  answer: string | null;
  answered_by: string | null;
  created_at: string;
  answered_at: string | null;
}

/** The engine preflight a runner ran on its own machine, as t401 stores it. */
export interface ProbeCli {
  available: boolean;
  version: string | null;
  /** Best effort, and the adapter's own word for it — never a guarantee. */
  authenticated: boolean;
}

/** One MCP server, by name and nothing else — the runner's own `McpServerRef`. */
export interface McpServerRef {
  name: string;
}

/**
 * What the machine's MCP discovery found, or the fact that it cannot answer.
 *
 * Two shapes and not one with nullable fields, mirroring the control plane's:
 * `{supported: false}` says the adapter implements no discovery at all (t400),
 * and the check page must not read it as an engine that found nothing.
 */
export type ProbeMcp =
  | { supported: false }
  | {
      supported: true;
      servers: McpServerRef[];
      origin: 'cli' | 'file';
      resolved_at: string | null;
    };

/** The two directories a runner was pointed at, as they really are on disk. */
export interface ProbeWorkspace {
  working_dir: string;
  working_dir_resolved: string;
  is_git_repo: boolean;
  worktrees_root: string;
  worktrees_root_resolved: string;
  worktrees_root_exists: boolean;
  worktrees_root_writable: boolean;
}

/** What a runner reported about its own machine. */
export interface ProbeReport {
  cli: ProbeCli;
  mcp: ProbeMcp;
  workspace: ProbeWorkspace;
}

/**
 * The stored probe, as `GET /v1/runners` embeds it.
 *
 * Mirrors `packages/core/src/repositories/runner-probes.ts`'s public shape and
 * does not own it: nothing here validates, resolves or re-derives any of it —
 * the screen draws what the machine said about itself, and the only thing that
 * ever refuses a bad machine is a session that fails to open on it.
 */
export interface RunnerProbe extends ProbeReport {
  runner_id: string;
  reported_at: string;
}

/** A re-check an operator asked for, as `POST /v1/runners/:id/rechecks` answers. */
export interface RunnerRecheck {
  id: number;
  runner_id: string;
  requested_at: string;
  /** When a probe answered it; `null` while it is still pending. */
  served_at: string | null;
}

/**
 * The three keys `GET`/`PATCH /v1/settings` hold per project (t403).
 *
 * Every one optional, and that is the wire: a project whose settings were never
 * seeded answers with `project_id` and nothing else. The check page reads the
 * absence as "no value recorded" and never as an empty string — the API refuses
 * an empty string with `invalid_setting_value`, so the two are not the same
 * fact.
 */
export interface Settings {
  workspace_root?: string;
  worktrees_root?: string;
  engine?: string;
}

/** The last lease a runner lost to the deadline, inside {@link RunnerHealth}. */
export interface RunnerExpiration {
  job_id: number;
  expires_at: string;
  expiration_reason: string | null;
}

/**
 * A paired runner and its liveness, as `GET /v1/runners` returns it (t164).
 *
 * All of it is derived by the control plane from the lease table — there is no
 * runner-level ping — so a runner that never held a lease reads exactly like
 * one that is down. The screen shows what the server tracks; inventing a
 * liveness signal of its own is the one thing D11 does not let it do.
 */
export interface RunnerHealth {
  id: string;
  name: string | null;
  registered_at: string;
  active_leases: number;
  last_heartbeat: string | null;
  last_expiration: RunnerExpiration | null;
  /**
   * The last thing this runner said about its own machine (t401), or `null`.
   *
   * `null` is a real answer and not a missing field: a machine that has said
   * nothing about itself is a different state from one that reported a CLI it
   * could not find, and the check page draws the two differently.
   */
  probe: RunnerProbe | null;
}

/** Event envelope, in the slice the timeline reads. */
export interface Event {
  id: number;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/**
 * One demo-ready bundle, as `GET /v1/examples` returns it (t408).
 *
 * The screen knows nothing about where these come from: `class` and `bundle`
 * are names the control plane read off disk, and `registered` is its own answer
 * about its own database. Everything this interface declares is a field the
 * Examples page draws — the screen has no way to invent one, which is the whole
 * of D11 restated for one more route.
 */
export interface Example {
  class: string;
  bundle: string;
  demo_title: string;
  registered: boolean;
}

/** What `POST /v1/examples/:class/run` answers (t408). */
export interface ExampleRun {
  /** The job that was created, as `POST /v1/jobs` would have returned it. */
  job: Job;
  /** The round the control plane allocated for it — where the board opens. */
  execution_id: number;
  /** Whether THIS call is what registered the bundle. */
  registered: boolean;
}

/**
 * One closed exchange of an interview, as `GET /v1/jobs/:id/conversation`
 * returns it (t360, `docs/spec/interview.md` §3).
 *
 * Mirrors the wire and does not own it, like every other interface here: the
 * projection is `packages/core/src/domain/conversation.ts`'s, and the screen
 * reads it because a page that rebuilt the exchange out of three listings would
 * have to get the ordering rule right on its own.
 */
export interface ConversationTurn {
  question: string;
  answer: string;
  /** Who answered; `null` when nobody signed it. */
  answered_by: string | null;
  /** When the answer landed; `null` for a row written before the column. */
  at: string | null;
}

/**
 * The one open question of an interview, in the vocabulary the fenced block
 * uses.
 *
 * `default` and not `default_answer`: the projection renames exactly that one
 * field, `GET /v1/input-requests` is untouched, and this interface mirrors the
 * route it actually reads.
 */
export interface PendingQuestion {
  id: number;
  question: string;
  context: string | null;
  recommendation: string | null;
  options: string[] | null;
  default: string | null;
}

/** The whole exchange of one interview, as one page-sized answer. */
export interface Conversation {
  /** Closed turns, in the order the log recorded the questions. */
  turns: ConversationTurn[];
  /** The one open question, or `null` when nobody is being asked anything. */
  pending: PendingQuestion | null;
  /** Something is running and there is nothing to answer yet. */
  thinking: boolean;
  /**
   * The map the last completed session reported; `null` when there is none.
   *
   * `unknown` on purpose, and it is the honest type: what is in there is an
   * agent's structured report, checked upstream against the node's own output
   * schema and against nothing this package declares. Whoever reads it narrows
   * it where it is used (`register-map.ts`'s `MapDraft`).
   */
  draft: unknown;
  /** The traveller arrived: there is nothing left to ask. */
  done: boolean;
}

/**
 * What the control plane's soundness gate says about one document (t460).
 *
 * The same shape three answers carry — the `422 invalid_graph` of `POST
 * /v1/graphs`, the `422` of `POST /v1/proposals/:id/apply`, and the plain 200
 * of `POST /v1/graphs/validate` — which is why there is one type here and not
 * one per route. `target` is `unknown` because it genuinely varies: a node id
 * for three of the four rules, `{from, to}` for the fourth
 * (`packages/core/src/domain/graph.ts`), and the renderer that turns a
 * violation into a sentence is the one place that narrows it.
 */
export interface GraphReport {
  valid: boolean;
  structure: { valid: boolean; errors: { code: string; message: string; target: unknown }[] };
  soundness: { valid: boolean; violations: { rule: string; target: unknown }[] };
}

/** A lineage, as `GET /v1/graphs/:id` returns it inside `{graph}` (D8: `id` IS the class). */
export interface GraphSummary {
  id: string;
  class: string;
  lineage_type: string;
  base_class: string | null;
  current_version_id: string | null;
  created_at: string;
}

/**
 * One version WITH its snapshot, as `GET /v1/graph-versions/:id` returns it
 * inside `{graph_version}`.
 *
 * `snapshot` is typed as an open record and never as the graph format: the
 * document's schema lives in `schema/graph.schema.json` and the one consumer
 * here — `map-document.ts` — already declares the slice it reads, field by
 * field, and degrades on everything else.
 */
export interface GraphVersionSummary {
  id: string;
  graph_id: string;
  parent_version: string | null;
  created_at: string;
  snapshot: Record<string, unknown>;
}

/**
 * One registered skill manifest, as `GET /v1/skills/:id` returns it.
 *
 * The three pin fields are named because the one caller matches on all three
 * (D4); everything else rides along as declared keys of an open record, which
 * is what lets `permissions.network` reach `map-document.ts` without this file
 * restating `specs/formats/skill-manifest.schema.json`.
 */
export type SkillSummary = Record<string, unknown> & {
  id: string;
  version: string;
  hash: string;
};

/** A project, as `GET /v1/projects` returns it (t354). */
export interface Project {
  id: number;
  name: string;
  created_at: string;
}

/**
 * The slice asked of a listing route.
 *
 * `project_id` is the partition and not a filter like the other three (D25,
 * t354): every read of this client carries it, and the screen takes it from a
 * cookie the switcher writes. It is optional here for one reason only — the
 * routes default to project 1, so a call that omits it means exactly what it
 * meant before this ticket.
 */
export interface Filter {
  execution_id?: number;
  job_id?: number;
  status?: string;
  project_id?: number;
}

/**
 * The control plane answered, but with an error.
 *
 * It carries the status because the screen has to tell "does not exist" (404,
 * which it passes on as a 404 to the browser) from any other failure (which
 * becomes a 502: the problem is not with whoever asked for the page).
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

/** Client configuration. */
export interface ClientOptions {
  /** Control plane base URL (e.g. `http://127.0.0.1:4317`). */
  baseUrl: string;
  /**
   * Credential presented on every call (t124, FR7).
   *
   * It is the SCREEN's credential, held by the process and never asked of the
   * browser: the pages rendered from this client show whatever this token can
   * read, and the browser that asks for a page still presents nothing (D11).
   */
  token?: string;
  /** `fetch` implementation to use. Default: the global `fetch`. */
  doFetch?: typeof fetch;
}

function queryString(filter: Filter): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.execution_id !== undefined) params.set('execution_id', String(filter.execution_id));
  if (filter.job_id !== undefined) params.set('job_id', String(filter.job_id));
  if (filter.project_id !== undefined) params.set('project_id', String(filter.project_id));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Decodes the body of an ERROR answer, without ever throwing (t156).
 *
 * Whoever answers an error is not always the control plane: a reverse proxy in
 * the middle answers 502/504 with an HTML page, and then `JSON.parse` throws a
 * raw `SyntaxError` — which carries neither the status nor the text, and is
 * neither of the two failures this module names. Failing to decode the body of
 * an error is not a second failure: it IS the body, as it came.
 *
 * Deliberately not used on the success path: a malformed body on a 2xx is the
 * control plane breaking its own contract, and that one has to show.
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

/** Thin client of the slice of the public API the screen reads. */
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

  /**
   * The board: every job, or the ones of a single execution.
   *
   * @param filter Optional slice by execution.
   * @returns Jobs in the order the control plane sent them.
   */
  async listJobs(filter: Filter = {}): Promise<Job[]> {
    const { jobs } = await this.#get<{ jobs: Job[] }>(
      `/v1/jobs${queryString(filter)}`,
    );
    return jobs;
  }

  /**
   * Every project that exists — what the switcher in the navigation draws.
   *
   * Unscoped, and it is the one read here that is: "which projects exist" is
   * the question a scope would be an answer to (t354).
   *
   * @returns The projects, in id order.
   */
  async listProjects(): Promise<Project[]> {
    const { projects } = await this.#get<{ projects: Project[] }>('/v1/projects');
    return projects;
  }

  /**
   * One job.
   *
   * @param id Job id.
   * @param filter Scope of the read.
   * @returns The job, or `null` when the control plane says it does not exist.
   */
  async getJob(id: number, filter: Filter = {}): Promise<Job | null> {
    return await this.#getOrNull<Job>(`/v1/jobs/${id}${queryString(filter)}`);
  }

  /**
   * The raw timeline of a job, from the event log.
   *
   * @param id Job id.
   * @returns Events in order, or `null` if the job does not exist.
   */
  async jobEvents(id: number, filter: Filter = {}): Promise<Event[] | null> {
    const body = await this.#getOrNull<{ events: Event[] }>(
      `/v1/jobs/${id}/events${queryString(filter)}`,
    );
    return body === null ? null : body.events;
  }

  /**
   * Every artifact of every session of one job, newest first (t368, RF-39).
   *
   * @param jobId Job id.
   * @param filter Scope of the read.
   * @returns The artifacts, or `null` if the control plane says the job does
   *   not exist in that scope.
   */
  async listJobArtifacts(jobId: number, filter: Filter = {}): Promise<Artifact[] | null> {
    const body = await this.#getOrNull<{ artifacts: Artifact[] }>(
      `/v1/jobs/${jobId}/artifacts${queryString(filter)}`,
    );
    return body === null ? null : body.artifacts;
  }

  /**
   * The executions that exist, with the counts of each.
   *
   * @returns One row per execution, with the `null` group last.
   */
  async listExecutions(filter: Filter = {}): Promise<ExecutionSummary[]> {
    const { executions } = await this.#get<{ executions: ExecutionSummary[] }>(
      `/v1/executions${queryString(filter)}`,
    );
    return executions;
  }

  /**
   * The fleet: every paired runner, with what the lease table says about it.
   *
   * The one listing here that takes no scope, and deliberately: a runner is not
   * scoped to a project — "pairing is identity alone"
   * (`docs/spec/runner-and-controller.md` §1) — so the fleet reads the same from
   * every project, and passing a `project_id` the route has no column for would
   * suggest otherwise.
   *
   * @returns Runners in pairing order, as the control plane sent them.
   */
  async listRunners(): Promise<RunnerHealth[]> {
    const { runners } = await this.#get<{ runners: RunnerHealth[] }>('/v1/runners');
    return runners;
  }

  /**
   * The local runner's recorded defaults for one project (t403).
   *
   * Scoped, unlike {@link listRunners} right above it, and the asymmetry is the
   * data's: a runner is identity alone, while where it works is a per-project
   * decision the operator took at the screen.
   *
   * @param filter Scope of the read; `project_id` is the only key that matters.
   * @returns Whatever keys are recorded — possibly none at all.
   */
  async getSettings(filter: Filter = {}): Promise<Settings> {
    return await this.#get<Settings>(`/v1/settings${queryString(filter)}`);
  }

  /**
   * Writes settings — the screen's fourth write, and its first configuration one.
   *
   * The patch is sent whole and the project rides in the BODY, not the query:
   * that is `PATCH /v1/settings`'s own convention, since a query string has no
   * natural home for a write. Only the keys the caller passes are touched; a
   * key not in the patch keeps whatever value it had.
   *
   * An empty string is deliberately not this method's problem to catch: the API
   * refuses it with `invalid_setting_value`, and the one place that decision
   * belongs is the form handler that knows a blank field is a field left alone.
   *
   * @param patch Keys to write; every one of them a non-empty string.
   * @param filter Scope of the write.
   * @returns The settings as they ended up.
   * @throws {ApiError} When the control plane refuses.
   */
  async updateSettings(patch: Settings, filter: Filter = {}): Promise<Settings> {
    return await this.#request<Settings>('/v1/settings', {
      method: 'PATCH',
      body: { ...patch, ...(filter.project_id === undefined ? {} : { project_id: filter.project_id }) },
    });
  }

  /**
   * Asks one runner to report about its machine again (t401).
   *
   * Nothing comes back that the check page draws: the request is recorded, the
   * runner serves it on its next loop tick by reporting a fresh probe, and the
   * page shows it when somebody reloads. There is no third route acknowledging
   * it, and this screen does not poll for one.
   *
   * Idempotent upstream while a request is still pending, so an impatient
   * second click queues no second re-check.
   *
   * @param runnerId The runner to re-probe.
   * @returns The pending re-check, whether this call created it or found it.
   * @throws {ApiError} When the control plane refuses — 404 included.
   */
  async requestRunnerRecheck(runnerId: string): Promise<RunnerRecheck> {
    const { recheck } = await this.#request<{ recheck: RunnerRecheck }>(
      `/v1/runners/${encodeURIComponent(runnerId)}/rechecks`,
      { method: 'POST' },
    );
    return recheck;
  }

  /**
   * The sessions of an execution or of a job.
   *
   * @param filter Optional slices; with none, all of them.
   * @returns Sessions in id order.
   */
  async listSessions(filter: Filter = {}): Promise<Session[]> {
    const { sessions } = await this.#get<{ sessions: Session[] }>(
      `/v1/sessions${queryString(filter)}`,
    );
    return sessions;
  }

  /**
   * One session's decoded log (t368, RF-39/RF-40).
   *
   * @param id Session id.
   * @param filter Scope of the read.
   * @returns The decoded log, or `null` if the control plane says the session
   *   does not exist in that scope.
   */
  async getSessionLog(id: number, filter: Filter = {}): Promise<SessionLog | null> {
    return await this.#getOrNull<SessionLog>(`/v1/sessions/${id}/log${queryString(filter)}`);
  }

  /**
   * The input requests, by the slice asked for.
   *
   * @param filter Optional slices by status, execution and job.
   * @returns Questions in id order.
   */
  async listQuestions(filter: Filter = {}): Promise<Question[]> {
    const { input_requests: questions } = await this.#get<{ input_requests: Question[] }>(
      `/v1/input-requests${queryString(filter)}`,
    );
    return questions;
  }

  /**
   * The bundles the control plane can demonstrate, and which it already knows.
   *
   * @param filter Scope of the read.
   * @returns One entry per demo-ready bundle, sorted by the control plane.
   */
  async listExamples(filter: Filter = {}): Promise<Example[]> {
    const { examples } = await this.#get<{ examples: Example[] }>(
      `/v1/examples${queryString(filter)}`,
    );
    return examples;
  }

  /**
   * Runs one example: register it if it is new, then open its demo job.
   *
   * The screen's second write, and the first one that is not an answer to a
   * question. It carries no body at all — everything the run needs is the class
   * in the path and the scope on the query string, and a body invented here
   * would be the screen deciding something the bundle already declares.
   *
   * @param className The example's problem class.
   * @param filter Scope of the write.
   * @returns The job, the round it landed in, and whether this call registered.
   * @throws {ApiError} When the control plane refuses — 404 included.
   */
  async runExample(className: string, filter: Filter = {}): Promise<ExampleRun> {
    return await this.#request<ExampleRun>(
      `/v1/examples/${encodeURIComponent(className)}/run${queryString(filter)}`,
      { method: 'POST' },
    );
  }

  /**
   * Answers a question — the screen's ONLY write.
   *
   * A real write, against the real control plane: the screen keeps no state of
   * its own, and the queue only shrinks because the next read comes from the
   * API. What happens AFTER this write (unblocking the job, resuming the
   * agent's session) is t106's cycle and does not go through here.
   *
   * @param id Question id.
   * @param answer What was answered.
   * @param answeredBy Who answered (required in the event payload).
   * The BODY is the one Portuguese thing left in this file, and it is not an
   * oversight: `PATCH /v1/input-requests/:id/answer` validates against the
   * `pergunta.respondida` event contract, whose vocabulary D20 hands to its
   * SECOND child. Sending `{answer, answered_by}` today would be refused by the
   * control plane's own validator. The response comes back English.
   *
   * @returns The question as it ended up.
   * @throws {ApiError} When the control plane refuses — 404 included.
   */
  async answerQuestion(id: number, answer: string, answeredBy: string): Promise<Question> {
    return await this.#request<Question>(`/v1/input-requests/${id}/answer`, {
      method: 'PATCH',
      body: { answer, answered_by: answeredBy },
    });
  }

  /**
   * Raises a job's blocked flag, saying why and who (t339).
   *
   * @param id Job id.
   * @param input The stated reason and the person doing it.
   * @returns The job as the control plane left it.
   * @throws {ApiError} When the control plane refuses — 404 included.
   */
  async blockJob(id: number, input: FlagInput): Promise<Job> {
    return await this.#request<Job>(`/v1/jobs/${id}/blocks`, { method: 'POST', body: input });
  }

  /**
   * Lowers a job's blocked flag, saying why and who (t339).
   *
   * @param id Job id.
   * @param input The stated reason and the person doing it.
   * @returns The job as the control plane left it.
   * @throws {ApiError} When the control plane refuses — 404 included.
   */
  async unblockJob(id: number, input: FlagInput): Promise<Job> {
    return await this.#request<Job>(`/v1/jobs/${id}/unblocks`, { method: 'POST', body: input });
  }

  /**
   * Starts an interview: an ordinary job, on an ordinary class (t433, FR2).
   *
   * The screen decides nothing about the shape of it. `entry_node_id` and the
   * version are the caller's, read off the class the button targets, and the
   * title and the description are what a person typed — which is why the input
   * is the four fields and not a `Job`: everything else on that projection is
   * the control plane's answer, not this screen's request.
   *
   * @param input Title, description, entry node and the version to travel.
   * @param filter Scope of the write.
   * @returns The job as the control plane created it.
   * @throws {ApiError} When the control plane refuses.
   */
  async createJob(input: NewJob, filter: Filter = {}): Promise<Job> {
    return await this.#request<Job>('/v1/jobs', {
      method: 'POST',
      body: {
        ...input,
        ...(filter.project_id === undefined ? {} : { project_id: filter.project_id }),
      },
    });
  }

  /**
   * One interview, read as the conversation it is (t360, FR5).
   *
   * The page reads THIS and never a job, a session or an input request by name
   * — which is the whole reason the projection exists: the mechanism under it
   * (one dispatch per question today) can be swapped for the recorded plan B
   * without this method, or the page above it, changing at all.
   *
   * @param id Job id.
   * @param filter Scope of the read.
   * @returns The exchange, or `null` when the control plane does not know it.
   */
  async getConversation(id: number, filter: Filter = {}): Promise<Conversation | null> {
    return await this.#getOrNull<Conversation>(`/v1/jobs/${id}/conversation${queryString(filter)}`);
  }

  /**
   * One lineage, by the class it belongs to — which is its id (D8).
   *
   * @param id Class name.
   * @param filter Scope of the read.
   * @returns The lineage, or `null` when no class answers to that name.
   */
  async getGraph(id: string, filter: Filter = {}): Promise<GraphSummary | null> {
    const body = await this.#getOrNull<{ graph: GraphSummary }>(
      `/v1/graphs/${encodeURIComponent(id)}${queryString(filter)}`,
    );
    return body === null ? null : body.graph;
  }

  /**
   * One version, snapshot included.
   *
   * @param id Version id — the hash of the document itself.
   * @param filter Scope of the read.
   * @returns The version, or `null` when it does not exist.
   */
  async getGraphVersion(id: string, filter: Filter = {}): Promise<GraphVersionSummary | null> {
    const body = await this.#getOrNull<{ graph_version: GraphVersionSummary }>(
      `/v1/graph-versions/${encodeURIComponent(id)}${queryString(filter)}`,
    );
    return body === null ? null : body.graph_version;
  }

  /**
   * One registered manifest, by its pin.
   *
   * A pin that resolves to nothing comes back as `null` and never as a throw:
   * the one caller draws a map document, and a step whose manifest cannot be
   * found still has a step to draw — the same grace `map-document.ts` already
   * documents for its own "no manifest for that node" case.
   *
   * @param id Skill id.
   * @param pin The version and/or the content hash asked for.
   * @param filter Scope of the read.
   * @returns The manifest, or `null`.
   */
  async getSkill(
    id: string,
    pin: { version?: string; hash?: string } = {},
    filter: Filter = {},
  ): Promise<SkillSummary | null> {
    const params = new URLSearchParams();
    if (pin.version !== undefined) params.set('version', pin.version);
    if (pin.hash !== undefined) params.set('hash', pin.hash);
    if (filter.project_id !== undefined) params.set('project_id', String(filter.project_id));
    const query = params.toString();
    return await this.#getOrNull<SkillSummary>(
      `/v1/skills/${encodeURIComponent(id)}${query === '' ? '' : `?${query}`}`,
    );
  }

  /**
   * Registers one skill manifest — the first half of registering a map (t432).
   *
   * Declared with exactly the shape `register-map.ts`'s `RegisterMapClient`
   * asks for, so this class satisfies that interface structurally, with no
   * adapter type in between: the manifest goes up whole, and a refusal is the
   * `ApiError` every other method of this class already throws.
   *
   * @param manifest The manifest, already pinned.
   * @param filter Scope of the write.
   * @returns The registered skill, as the registry left it.
   * @throws {ApiError} When the registry refuses it.
   */
  async registerSkill(manifest: Record<string, unknown>, filter: Filter = {}): Promise<unknown> {
    return await this.#request<unknown>(`/v1/skills${queryString(filter)}`, {
      method: 'POST',
      body: manifest,
    });
  }

  /**
   * Registers one graph document — the second half, and only after the first.
   *
   * The ORDER is `register-map.ts`'s to keep, not this method's: a class whose
   * nodes pin a capability the registry refused is a class nobody can dispatch.
   *
   * @param document The graph document, with every pin closed.
   * @param filter Scope of the write.
   * @returns The lineage and the version it was born as.
   * @throws {ApiError} When the control plane refuses it.
   */
  async registerGraph(
    document: Record<string, unknown>,
    filter: Filter = {},
  ): Promise<{ graph: unknown; graph_version: unknown }> {
    return await this.#request<{ graph: unknown; graph_version: unknown }>(
      `/v1/graphs${queryString(filter)}`,
      { method: 'POST', body: document },
    );
  }

  /**
   * What the soundness gate WOULD say about a document nobody registered (t460).
   *
   * The one read of this class that judges instead of fetching, and the one
   * that takes no scope: `POST /v1/graphs/validate` writes nothing and needs no
   * project, because its answer is a pure function of the document handed to it.
   *
   * It never throws for an invalid document — that is the whole point of the
   * route. `{valid: false, …}` is a normal 200, and an `ApiError` from here
   * means the control plane could not be asked at all, which is a different
   * fact and stays a different signal.
   *
   * @param document The candidate graph document, however incomplete.
   * @returns The combined structure/soundness report.
   * @throws {ApiError} When the control plane refuses the call itself.
   */
  async validateGraphDocument(document: unknown): Promise<GraphReport> {
    return await this.#request<GraphReport>('/v1/graphs/validate', {
      method: 'POST',
      body: document,
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
    // ANSWERED, so nothing that happens next is a `NetworkError`. The status
    // comes before any decoding — on an error the body is material to log, and
    // never a reason to throw something other than `ApiError`.
    if (!response.ok) throw new ApiError(path, response.status, decodeErrorBody(text));
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}
