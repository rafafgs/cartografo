/**
 * The three reads the synthesizer consults before it composes (t115, FR2–FR4).
 *
 * Hand-rolled, same posture as `controller/cliente-controle.ts`: the runner is
 * an unprivileged API client (D1/D11), it does not open the database and it does
 * not import anything from `packages/core`. Every interface below declares ONLY
 * the subset of the contract this ficha consumes — the routes return more, and
 * describing more here would create a coupling nobody asked for.
 *
 * The three routes, and who owns them:
 *
 * - `GET /v1/classes` (t101, `routes/graphs.ts`) — is this class already a
 *   registered lineage? FR2 refuses on a hit, before opening any session.
 * - `GET /v1/graph-versions/:id` (t101) — the current version of each class, so
 *   its `metadata.name`/`metadata.description` can be scored against the
 *   declaration. The class id alone is too short for a token heuristic with a
 *   3-character floor to say anything.
 * - `GET /v1/skills` (t117, `routes/skills.ts`) — the capability catalogue the
 *   session composes nodes out of. This ficha READS the registry and never
 *   writes to it: importing a third-party skill is D4's gate, a separate flow.
 *
 * WRITES ARE ABSENT BY DESIGN, not by omission. There is no `postGraph` here
 * and there will not be one: the synthesizer stops at a draft file, and
 * registering it is `cartografo import` run by a human after they edited it
 * (D10). A client that does not have the method cannot take the decision by
 * accident — the same reasoning that keeps `aplicar` out of the surveyor's
 * client.
 *
 * The payload field names are the API's own. D18 left them in Portuguese and D20
 * took them to English, which t226 applied here (`docs/spec/glossario-wire.md`);
 * the route paths and the identifiers were already English. The one thing that
 * did NOT move is `GraphMetadata` below — a key of the graph document's own
 * format, not of the wire, as its comment records.
 */

import { DEFAULT_REQUEST_TIMEOUT_MS, requestJson } from '../controller/http-client.ts';

/** A registered class, as `GET /v1/classes` returns it. */
export interface ClassEntry {
  class: string;
  /** `null` for a lineage with no version yet; such a class cannot be scored. */
  current_version_id: string | null;
}

/** The metadata drawer of a graph document, in the part the ranking reads. */
export interface GraphMetadata {
  /**
   * The document's own metadata, NOT the API's.
   *
   * `schema/grafo.schema.json` is a format of its own and no child of D20
   * renames it, so these two keys stay Portuguese while everything around them
   * went English in t226.
   */
  nome?: string;
  descricao?: string;
  [key: string]: unknown;
}

/** The frozen document inside a version. Only `metadata` is named. */
export interface GraphSnapshot {
  metadata?: GraphMetadata;
  [key: string]: unknown;
}

/** A graph version, as `GET /v1/graph-versions/:id` returns it. */
export interface GraphVersion {
  id: string;
  graph_id: string;
  snapshot: GraphSnapshot;
}

/**
 * A registered skill, as `GET /v1/skills` returns it (t117).
 *
 * The eight fields the prompt renders, out of the thirteen the route projects.
 * `instructions`, `permissions`, `origin`, `preconditions` and `registered_at` are
 * deliberately absent: the session composes a topology out of contracts, and
 * shipping a skill's whole instruction text into the prompt would both bloat it
 * and hand imported prose to the composing agent — which is precisely the
 * injection surface D4 pins by hash rather than trusts.
 */
export interface RegisteredSkill {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  checks: Record<string, unknown>[];
}

/**
 * The read-only door the synthesis run is given.
 *
 * An interface rather than a class so the suite can hand `runSynthesis` a fake
 * without a socket: what the acceptance tests prove is the runner's behaviour,
 * and t101/t117 already prove their own routes.
 */
export interface ControlPlaneReader {
  fetchClasses(): Promise<ClassEntry[]>;
  fetchClassVersion(versionId: string): Promise<GraphVersion>;
  fetchSkills(): Promise<RegisteredSkill[]>;
}

/** The control plane answered, and the answer was not usable. */
export class ControlPlaneError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ControlPlaneError';
    this.status = status;
  }
}

/** Trailing slashes are the caller's habit, not part of the URL. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * One read, on a deadline, through the mechanic every runner client shares
 * (t193, FR5).
 *
 * `ControlPlaneError` keeps the shape it has always had — a message and a
 * status, no body — because nothing here has ever needed the body as a value:
 * the text goes into the message, where whoever reads the command's stderr
 * finds it. Unifying it with `ErroDoControlPlane` is a separate ticket; what is
 * unified here is the request, not the error.
 *
 * The `did not answer JSON` case stays, and stays HERE rather than in the
 * shared module: a malformed body in a 2xx is the control plane breaking its
 * own contract, and this command's answer to that is its own error rather than
 * a `SyntaxError` from a `JSON.parse` deep inside a synthesis run.
 */
async function getJson<T>(
  baseUrl: string,
  route: string,
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): Promise<T> {
  try {
    return await requestJson<T>({
      url: `${normalizeBase(baseUrl)}${route}`,
      fetchImpl,
      timeoutMs,
      buildError: ({ status, body }) =>
        new ControlPlaneError(
          `GET ${route} answered ${status}${body === '' ? '' : `: ${body}`}`,
          status,
        ),
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      // The status is gone by the time a decode fails, and inventing one would
      // be worse than the `0` this reports: the answer WAS a 2xx, and what is
      // wrong with it is the body.
      throw new ControlPlaneError(`GET ${route} did not answer JSON`, 0);
    }
    throw error;
  }
}

/**
 * Every class that already has a base graph.
 *
 * @param baseUrl Base URL of the control plane.
 * @param fetchImpl Injectable for tests; production is the global `fetch`.
 * @returns The registered classes, in the order the route sent them.
 */
export async function fetchClasses(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<ClassEntry[]> {
  const { classes } = await getJson<{ classes: ClassEntry[] }>(
    baseUrl,
    '/v1/classes',
    fetchImpl,
    timeoutMs,
  );
  return classes;
}

/**
 * One graph version, with the snapshot the ranking reads its metadata from.
 *
 * @param baseUrl Base URL of the control plane.
 * @param versionId Version id (the snapshot hash, which carries a `:`).
 * @param fetchImpl Injectable for tests.
 * @returns The version and its document.
 * @throws {ControlPlaneError} 404 when the version does not exist.
 */
export async function fetchClassVersion(
  baseUrl: string,
  versionId: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<GraphVersion> {
  const { graph_version: version } = await getJson<{ graph_version: GraphVersion }>(
    baseUrl,
    `/v1/graph-versions/${encodeURIComponent(versionId)}`,
    fetchImpl,
    timeoutMs,
  );
  return version;
}

/**
 * The whole capability catalogue.
 *
 * @param baseUrl Base URL of the control plane.
 * @param fetchImpl Injectable for tests.
 * @returns Registered skills, in the id order the registry keeps.
 */
export async function fetchSkills(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<RegisteredSkill[]> {
  const { skills } = await getJson<{ skills: RegisteredSkill[] }>(
    baseUrl,
    '/v1/skills',
    fetchImpl,
    timeoutMs,
  );
  return skills;
}

/** What a reader needs beyond the address (t148). */
export interface ControlPlaneReaderOptions {
  /**
   * Credential presented on every read.
   *
   * Since t124 there is no open mode: `/v1` answers 401 to a request with no
   * usable bearer, so a synthesizer with no token here does not degrade — it is
   * denied on its very first call, which is how `cartografo synthesize` shipped.
   *
   * With no token no header goes out, and that is the honest outcome rather
   * than an oversight: an empty `Authorization` would read as a credential in
   * the server's log instead of as the absence of one
   * (`controller/cliente-controle.ts`).
   */
  token?: string;
  /** `fetch` implementation. Default: the global one. Test seam only. */
  fetchImpl?: typeof fetch;
  /**
   * Deadline of each read, in milliseconds (t193, FR5). Default:
   * {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   *
   * A synthesis run consults three routes before it opens a session, and until
   * this ficha none of the three could give up: a control plane that accepted
   * the connection and never answered left `cartografo synthesize` sitting at a
   * prompt that never came back.
   */
  requestTimeoutMs?: number;
}

/**
 * Wraps a `fetch` so every request it carries presents the credential.
 *
 * Wrapped ONCE here, rather than threading a `token` through `getJson` and the
 * three reads below it: those are one client with one door out, and a read that
 * assembled its own headers is a read that could forget them — the same
 * reasoning `dispatch/control-plane-client.ts`'s single `headers()` records.
 *
 * @param fetchImpl What actually performs the request.
 * @param token The credential, when there is one.
 * @returns `fetchImpl` untouched when there is no token; otherwise a `fetch`
 *   that adds `Authorization` without overwriting one already on the request.
 */
function withAuthorization(fetchImpl: typeof fetch, token: string | undefined): typeof fetch {
  if (token === undefined) return fetchImpl;

  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return await fetchImpl(input, { ...init, headers });
  };
}

/**
 * Binds a base URL and a credential to the three reads.
 *
 * @param baseUrl Base URL of the control plane.
 * @param options Credential to present, and the `fetch` seam for the suite.
 * @returns A reader the synthesis run can be handed.
 */
export function createControlPlaneReader(
  baseUrl: string,
  options: ControlPlaneReaderOptions = {},
): ControlPlaneReader {
  const fetchImpl = withAuthorization(options.fetchImpl ?? fetch, options.token);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    fetchClasses: async () => await fetchClasses(baseUrl, fetchImpl, timeoutMs),
    fetchClassVersion: async (versionId: string) =>
      await fetchClassVersion(baseUrl, versionId, fetchImpl, timeoutMs),
    fetchSkills: async () => await fetchSkills(baseUrl, fetchImpl, timeoutMs),
  };
}
