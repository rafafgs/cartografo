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
 * t226 (`docs/spec/glossario-wire.md` §1). This file MIRRORS that format, it
 * does not own it: the interfaces are declared here so a missing field breaks
 * at the boundary, with the route name in the error, and they move whenever the
 * API moves.
 *
 * The method names of {@link ApiClient} were already English before this ticket
 * (D18 covers identifiers) and did not change: what moved is only what travels.
 *
 * ONE call still speaks Portuguese on the way IN, and it is deliberate:
 * {@link ApiClient.answerQuestion} PATCHes `{resposta, respondido_por}`. That
 * route's body is validated against the `pergunta.respondida` EVENT contract
 * (`packages/core/src/routes/common.ts` documents the whole asymmetry), and the
 * event vocabulary is D20's second child, not this one. What the same call
 * READS back is English like everything else.
 *
 * `doFetch` is injectable for tests only; in production it is the global
 * `fetch`.
 */

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
}

/** Event envelope, in the slice the timeline reads. */
export interface Event {
  id: number;
  tipo: string;
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** The slice asked of a listing route. */
export interface Filter {
  execution_id?: number;
  job_id?: number;
  status?: string;
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

  /**
   * The executions that exist, with the counts of each.
   *
   * @returns One row per execution, with the `null` group last.
   */
  async listExecutions(): Promise<ExecutionSummary[]> {
    const { executions } = await this.#get<{ executions: ExecutionSummary[] }>(
      '/v1/executions',
    );
    return executions;
  }

  /**
   * The fleet: every paired runner, with what the lease table says about it.
   *
   * @returns Runners in pairing order, as the control plane sent them.
   */
  async listRunners(): Promise<RunnerHealth[]> {
    const { runners } = await this.#get<{ runners: RunnerHealth[] }>('/v1/runners');
    return runners;
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
      body: { resposta: answer, respondido_por: answeredBy },
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
