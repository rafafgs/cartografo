/**
 * HTTP client of the cost surveyor (t114, FR3).
 *
 * Four routes, and not one more — three reads and one write:
 *
 * | Route | What for |
 * |---|---|
 * | `GET /v1/sessions?execucao_id=` | tokens (`uso`) and time (`aberta_em`/`finalizada_em`) per `no_id` |
 * | `GET /v1/jobs?execucao_id=` | the `trabalho_id -> grafo_versao_id` map |
 * | `GET /v1/graph-versions/:id` | the node's current `description`, which becomes the `de` of the operation |
 * | `POST /v1/proposals` | the candidate, as a pending proposal |
 *
 * The PATH is English (D18, t127); the body KEYS stay in Portuguese
 * (`sessoes`, `trabalhos`, `grafo_versao`, `proposta`), because they are format
 * keys and D18 explicitly takes them out of the scope of English — D20 later
 * froze them as wire vocabulary, to migrate only under t213.
 *
 * There is no `POST /v1/proposals/:id/apply` here, and the absence is the rule:
 * applying a proposal is a human decision at the gate (README, principle 5).
 *
 * This is the ONLY surface between the lens and the state of the system. No
 * database, nothing from `packages/core` (D1/D11) — `doFetch` is injectable for
 * tests only, and in production it is the global `fetch`, the same pattern as
 * `packages/tela/src/index.ts:31`.
 */

import type { ObservedSession } from './cost.ts';
import type { ChangeNodeDescription, CostEvidence, ExpectedMetric } from './policy.ts';

/**
 * A job, in the subset the lens reads from `GET /v1/jobs`.
 *
 * `grafo_versao_id` is nullable here because it is nullable there: the version
 * is loose in the job's projection (D15).
 */
export interface ObservedJob {
  id: number;
  grafo_versao_id: string | null;
}

/** A node of the snapshot, in the subset the lens reads. */
export interface SnapshotNode {
  id: string;
  description?: string;
}

/** A graph version with the whole snapshot, as the route returns it. */
export interface GraphVersion {
  id: string;
  grafo_id: string;
  snapshot: { nodes?: SnapshotNode[] };
}

/** Body of `POST /v1/proposals`. The five keys the route demands. */
export interface ProposalInput {
  grafo_id: string;
  versao_alvo: string;
  operacoes: ChangeNodeDescription[];
  evidencia: CostEvidence | Record<string, unknown>;
  metrica_esperada: ExpectedMetric | Record<string, unknown>;
}

/** A proposal, in the subset the lens reads from the answer. */
export interface Proposal {
  id: number;
  status: string;
}

/** Narrowing by execution. Without it, the route returns everything. */
export interface ExecutionFilter {
  execucao_id?: number;
}

/**
 * Error answer from the API.
 *
 * It carries status and body: whoever calls has to tell "this execution does
 * not exist" from a passing failure, and whoever logs needs the body to know
 * what happened. Same shape as `ErroDoControlPlane` (`packages/runner`) and as
 * `ApiError` (`packages/tela/src/client.ts:142`), whose name this one now takes.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Takes the trailing slash off the base URL, so as not to make `//v1/...`. */
function normalize(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Builds `?execucao_id=N`, or empty text — never a dangling `?`. */
function query(filter: ExecutionFilter): string {
  if (filter.execucao_id === undefined) return '';
  return `?execucao_id=${encodeURIComponent(String(filter.execucao_id))}`;
}

/**
 * Decodes the body of an ERROR answer, without ever throwing (t156).
 *
 * Whoever answers an error is not always the API: a reverse proxy in the middle
 * answers 502/504 with an HTML page, and then `JSON.parse` throws a raw
 * `SyntaxError` — which carries neither the status nor the text, and is not the
 * error this module promises. Failing to decode the body of an error is not a
 * second failure: it IS the body, as it came.
 *
 * Deliberately not valid for the success path: a malformed body on a 2xx is the
 * API breaking its own contract, and that one has to show.
 *
 * @param text The body of the answer, as text.
 * @returns `undefined` for an empty body, the decoded value when it is JSON, and
 *   the raw text itself when it is not.
 */
function errorBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parseResponse<T>(path: string, method: string, response: Response): Promise<T> {
  const text = await response.text();

  // The status comes BEFORE any decoding: on an error, the body is log material
  // and never a reason for an exception other than this door's own.
  if (!response.ok) {
    throw new ApiError(
      `${method} ${path} responded with ${response.status}`,
      response.status,
      errorBody(text),
    );
  }

  return (text === '' ? undefined : JSON.parse(text)) as T;
}

async function get<T>(baseUrl: string, path: string, doFetch: typeof fetch): Promise<T> {
  return await parseResponse<T>(path, 'GET', await doFetch(`${normalize(baseUrl)}${path}`));
}

/**
 * The sessions of an execution.
 *
 * @param baseUrl Base URL of the control plane.
 * @param filter Narrowing by execution.
 * @param doFetch `fetch` implementation to use.
 * @returns The sessions, in the order the server sent them.
 */
export async function getSessions(
  baseUrl: string,
  filter: ExecutionFilter = {},
  doFetch: typeof fetch = fetch,
): Promise<ObservedSession[]> {
  const { sessoes: sessions } = await get<{ sessoes: ObservedSession[] }>(
    baseUrl,
    `/v1/sessions${query(filter)}`,
    doFetch,
  );
  return sessions;
}

/**
 * The jobs of an execution — where each session's graph version comes from.
 *
 * @param baseUrl Base URL of the control plane.
 * @param filter Narrowing by execution.
 * @param doFetch `fetch` implementation to use.
 * @returns The jobs, in the order the server sent them.
 */
export async function getJobs(
  baseUrl: string,
  filter: ExecutionFilter = {},
  doFetch: typeof fetch = fetch,
): Promise<ObservedJob[]> {
  const { trabalhos: jobs } = await get<{ trabalhos: ObservedJob[] }>(
    baseUrl,
    `/v1/jobs${query(filter)}`,
    doFetch,
  );
  return jobs;
}

/**
 * The snapshot of a version, to read the current `description` of its nodes.
 *
 * @param baseUrl Base URL of the control plane.
 * @param id Id of the version (`sha256:...`; the colon goes in escaped).
 * @param doFetch `fetch` implementation to use.
 * @returns The version with the whole document.
 */
export async function getGraphVersion(
  baseUrl: string,
  id: string,
  doFetch: typeof fetch = fetch,
): Promise<GraphVersion> {
  const { grafo_versao: version } = await get<{ grafo_versao: GraphVersion }>(
    baseUrl,
    `/v1/graph-versions/${encodeURIComponent(id)}`,
    doFetch,
  );
  return version;
}

/**
 * Creates the proposal. It is born `pendente`: the human gate is what applies it.
 *
 * @param baseUrl Base URL of the control plane.
 * @param input The five keys of the route's contract.
 * @param doFetch `fetch` implementation to use.
 * @returns The proposal as the server recorded it.
 */
export async function createProposal(
  baseUrl: string,
  input: ProposalInput,
  doFetch: typeof fetch = fetch,
): Promise<Proposal> {
  const path = '/v1/proposals';
  const response = await doFetch(`${normalize(baseUrl)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const { proposta: proposal } = await parseResponse<{ proposta: Proposal }>(path, 'POST', response);
  return proposal;
}
