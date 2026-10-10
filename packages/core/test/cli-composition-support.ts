/**
 * Support for the composition CLI tests (t639): seeding jobs, parents, children
 * and arrived jobs through the public API of a REAL control plane.
 *
 * Not a test file (`test/*.test.ts` is the runner glob). The plane started by
 * `startControlPlane` authorizes the global `fetch`, so these helpers speak to
 * it with a bare one.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, type RunningControlPlane } from './cli-support.ts';
import { resolvePinsOver } from './support.ts';

/** A job, in the fields the composition tests read. */
export interface Job {
  id: number;
  title: string;
  state: string;
  completed: boolean;
  current_node_id: string;
  parent_job_id: number | null;
  parent_node_id: string | null;
  sibling_position: number | null;
  children: number[];
  depends_on: number[];
  cancelled_at: string | null;
  dispatch_hold: string | null;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** POSTs to the control plane and demands the status it promised. */
export async function post<T>(
  plane: RunningControlPlane,
  route: string,
  body: unknown,
  expected = 201,
): Promise<T> {
  const response = await fetch(`${plane.url}${route}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `POST ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** A direct GET of the control plane, for comparison against the CLI's own reads. */
export async function get<T>(plane: RunningControlPlane, route: string): Promise<T> {
  const response = await fetch(`${plane.url}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `GET ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** Opens a job at `refine`; `extra` may make it a child, a dependent, or give it a graph. */
export async function open(
  plane: RunningControlPlane,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Job> {
  return post<Job>(plane, '/v1/jobs', { title, entry_node_id: 'refine', ...extra });
}

/** Opens a child of `parent`, from the node `fan-out`. */
export async function childOf(plane: RunningControlPlane, parent: Job, title: string): Promise<Job> {
  return open(plane, title, { parent_job_id: parent.id, parent_node_id: 'fan-out' });
}

/** Registers the minimal graph once and returns its version id. */
async function minimalVersion(plane: RunningControlPlane): Promise<string> {
  const document = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json'), 'utf8'),
  ) as Record<string, unknown>;
  await resolvePinsOver(document, {
    get: async (route) => ({ status: (await fetch(`${plane.url}${route}`)).status }),
    post: async (route, body) => ({
      status: (
        await fetch(`${plane.url}${route}`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        })
      ).status,
    }),
  });
  const response = await fetch(`${plane.url}/v1/graphs`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(document),
  });
  const body = (await response.json()) as { graph_version?: { id: string } };
  if (body.graph_version !== undefined) return body.graph_version.id;

  // Registered by an earlier call on this plane: read the version in force.
  const classes = await get<{ classes: Array<{ class: string; current_version_id: string }> }>(
    plane,
    '/v1/classes',
  );
  const id = classes.classes.find((entry) => entry.class === String(document.problem_class))?.current_version_id;
  assert.ok(id, `the minimal graph is neither registered nor listed: ${JSON.stringify(body)}`);
  return id;
}

/**
 * Opens a job that has ARRIVED: walked to `revisar` and its pinned final step
 * finished. Writing a transition is fine here — this is the core's own test
 * seeding a fact, not the end-to-end test that must move nothing by hand.
 */
export async function openCompleted(
  plane: RunningControlPlane,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<Job> {
  const versionId = await minimalVersion(plane);
  const job = await open(plane, title, { graph_version_id: versionId, entry_node_id: 'redigir', ...extra });
  await post(plane, `/v1/jobs/${job.id}/transitions`, { to_node_id: 'revisar' }, 200);
  const session = await post<{ id: number }>(plane, '/v1/sessions', {
    job_id: job.id,
    node_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'review and close',
  });
  const finished = await fetch(`${plane.url}/v1/sessions/${session.id}/finish`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      status: 'completed',
      exit_code: 0,
      output: { outcome: 'pass', evidence: 'the note answers the stated theme' },
    }),
  });
  assert.equal(finished.status, 200, `PATCH /finish answered ${finished.status}`);
  const arrived = await get<Job>(plane, `/v1/jobs/${job.id}`);
  assert.equal(arrived.completed, true, 'the fixture job has to arrive');
  return arrived;
}
