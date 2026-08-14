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
 *   its `metadata.nome`/`metadata.descricao` can be scored against the
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
 * The payload field names are the API's own, which D18 leaves in Portuguese
 * (`DECISOES.md:153-155`); the route paths and the identifiers here are English.
 */

/** A registered class, as `GET /v1/classes` returns it. */
export interface ClassEntry {
  classe: string;
  /** `null` for a lineage with no version yet; such a class cannot be scored. */
  versao_corrente_id: string | null;
}

/** The metadata drawer of a graph document, in the part the ranking reads. */
export interface GraphMetadata {
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
  grafo_id: string;
  snapshot: GraphSnapshot;
}

/**
 * A registered skill, as `GET /v1/skills` returns it (t117).
 *
 * The eight fields the prompt renders, out of the thirteen the route projects.
 * `instrucoes`, `permissoes`, `origem`, `pre_condicoes` and `registrado_em` are
 * deliberately absent: the session composes a topology out of contracts, and
 * shipping a skill's whole instruction text into the prompt would both bloat it
 * and hand imported prose to the composing agent — which is precisely the
 * injection surface D4 pins by hash rather than trusts.
 */
export interface RegisteredSkill {
  id: string;
  versao: string;
  hash: string;
  papel: string;
  descricao: string;
  entrada: Record<string, unknown>;
  saida: Record<string, unknown>;
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

async function getJson<T>(baseUrl: string, route: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(`${normalizeBase(baseUrl)}${route}`);
  const text = await response.text();

  if (!response.ok) {
    throw new ControlPlaneError(
      `GET ${route} answered ${response.status}${text === '' ? '' : `: ${text}`}`,
      response.status,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ControlPlaneError(`GET ${route} did not answer JSON`, response.status);
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
): Promise<ClassEntry[]> {
  const { classes } = await getJson<{ classes: ClassEntry[] }>(baseUrl, '/v1/classes', fetchImpl);
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
): Promise<GraphVersion> {
  const { grafo_versao: version } = await getJson<{ grafo_versao: GraphVersion }>(
    baseUrl,
    `/v1/graph-versions/${encodeURIComponent(versionId)}`,
    fetchImpl,
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
): Promise<RegisteredSkill[]> {
  const { skills } = await getJson<{ skills: RegisteredSkill[] }>(baseUrl, '/v1/skills', fetchImpl);
  return skills;
}

/**
 * Binds a base URL to the three reads.
 *
 * @param baseUrl Base URL of the control plane.
 * @param fetchImpl Injectable for tests.
 * @returns A reader the synthesis run can be handed.
 */
export function createControlPlaneReader(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): ControlPlaneReader {
  return {
    fetchClasses: async () => await fetchClasses(baseUrl, fetchImpl),
    fetchClassVersion: async (versionId: string) =>
      await fetchClassVersion(baseUrl, versionId, fetchImpl),
    fetchSkills: async () => await fetchSkills(baseUrl, fetchImpl),
  };
}
