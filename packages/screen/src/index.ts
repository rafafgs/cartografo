/**
 * The cartografo screen — placeholder.
 *
 * It exists at this stage only to prove the D11 boundary: the screen is one
 * more client of the public API, with no privilege over the core. It does not
 * know the database, imports nothing from `packages/core/src/db` and declares
 * no SQLite driver — it talks to the control plane over HTTP and nothing else.
 *
 * The real content (observability and the proposal inbox, D11) arrives in the
 * following tickets.
 */

/** Body of the control plane's `GET /health`. */
export interface HealthStatus {
  status: string;
  db: string;
}

/**
 * Reads the control plane's health through the public route.
 *
 * `doFetch` is injectable for tests only; in production it is the global
 * `fetch` — the same convention `proxy.ts` already uses.
 *
 * @param baseUrl Control plane base URL (e.g. `http://127.0.0.1:4317`).
 * @param doFetch `fetch` implementation to use.
 * @returns The body of `/health`.
 */
export async function checkHealth(
  baseUrl: string,
  doFetch: typeof fetch = fetch,
): Promise<HealthStatus> {
  const response = await doFetch(`${baseUrl.replace(/\/+$/, '')}/health`);
  return (await response.json()) as HealthStatus;
}
