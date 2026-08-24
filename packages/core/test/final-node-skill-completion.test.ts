/**
 * The two real factory bundles, at their own last node (t262, AT-8).
 *
 * `jobs.test.ts` proves the rule against the minimal example graph, which is
 * where a rule belongs. This file proves it against the documents that actually
 * ship: `grafos-de-fabrica/bets-assimetricas` ends at `record-monitoring`
 * pinning `record-crossing`, and `grafos-de-fabrica/desenvolvimento-de-software`
 * ends at `deploy` pinning `verify-release` — the identical shape, and the
 * one t198's first real crossing found broken
 * (`notas/2026-08-17-first-bets-run.md`, gap 2): the job was declared
 * `completed` the instant it LANDED there, so D14's own "registro e
 * monitoramento" step never got a session.
 *
 * Both bundles are read UNCHANGED. Nothing here patches a pin, a schema or a
 * node — if a real bundle stops satisfying this, the bundle is what has to
 * change, and this file is where that shows up.
 *
 * **Neither sub-test goes through the runner, on purpose.** Both of these
 * manifests interpolate a placeholder nothing produces yet
 * (`{{input.traversal.nodes_visited}}` and `{{input.referencia.commit}}`/`.modo`), so a
 * REAL dispatch of either final node fails closed with `UnresolvedPlaceholderError`
 * before a session exists. That gap is this ficha's own discovery and explicitly
 * not its scope — what is in scope is the derivation, and the derivation is
 * exercised the way the control plane sees it: `POST /v1/sessions` plus
 * `PATCH /v1/sessions/:id/finish`.
 *
 * English per D18, and since t280/t293 the bundles' own vocabulary too: both
 * report payloads below are spelled the way the manifests they are held against
 * spell them. What is still Portuguese is the bets thesis prose inside the
 * values, which is the language the example was written in.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  PACKAGE_ROOT,
  T102_ARTIFACTS,
  createJob,
  requireArtifacts,
  request,
  startControlPlane,
  type Job,
  type TestContext,
} from './support.ts';

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BUNDLES = path.join(REPO_ROOT, 'grafos-de-fabrica');

/** Artifacts the derivation and the report's validation live in. */
const ARTIFACTS = [
  T102_ARTIFACTS.migration,
  T102_ARTIFACTS.jobRepository,
  T102_ARTIFACTS.jobRoutes,
  'src/repositories/session.ts',
  'src/routes/graphs.ts',
  'src/routes/skills.ts',
];

/** The job projection with the terminal flag this file is about. */
type JobProjection = Job & { completed: boolean };

/** Reads a document of a factory bundle, byte for byte as it ships. */
function bundleFile(bundle: string, ...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(BUNDLES, bundle, ...segments), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** One bundle's last node, its manifest, and a report that manifest accepts. */
interface FinalNodeCase {
  bundle: string;
  finalNode: string;
  manifest: string;
  report: Record<string, unknown>;
}

/**
 * The two cases, written from the bundles' own `output` schemas.
 *
 * The reports are the smallest object each schema accepts: every `required`
 * key, nothing else. `additionalProperties: false` at the top of both means a
 * generous payload would be REFUSED, which would prove the opposite of what
 * these tests are for.
 */
const CASES: readonly FinalNodeCase[] = Object.freeze([
  {
    bundle: 'bets-assimetricas',
    finalNode: 'record-monitoring',
    manifest: 'record-crossing.json',
    report: {
      process_metrics: {
        red_team_ran: false,
        sourced_assumptions_fraction: 0,
        human_decision_id: null,
        final_outcome: 'archived',
      },
      record: {
        thesis_id: 'tese-eqx-2026-08',
        summary: 'a triagem descartou a tese antes da coleta; nada foi alocado',
      },
      note: 'travessia registrada; nada a monitorar',
    },
  },
  {
    bundle: 'desenvolvimento-de-software',
    finalNode: 'deploy',
    manifest: 'verify-release.json',
    report: {
      verdict: 'published',
      checked_reference: { commit: 'f03f0d4', mode: 'ponta_do_principal' },
      note: 'the merge commit is contained in the tip of the main line',
    },
  },
]);

/**
 * Registers the bundle's manifests and its graph.
 *
 * Until t283 only the FINAL node's manifest went in — `POST /v1/graphs` does not
 * demand a registered skill for every node, and registering the rest said
 * nothing about the derivation under test. It does now, indirectly: a version
 * whose pins do not all resolve is stored `unchecked`, and no job may cite one
 * of those, so the job below could not exist. Standing empty capabilities in for
 * the others is not an option either — the bundle's real final-node manifest
 * requires keys its real ancestors produce, and empty stand-ins would make the
 * document fail the contract check outright. So the whole `skills/` directory
 * goes in, which is what `cartografo import` does anyway.
 *
 * @param ctx Control plane running.
 * @param testCase Which bundle.
 * @returns Id of the version born with the lineage.
 */
async function registerBundle(ctx: TestContext, testCase: FinalNodeCase): Promise<string> {
  const skillsDir = path.join(BUNDLES, testCase.bundle, 'skills');
  for (const file of readdirSync(skillsDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const skill = await request(ctx, 'POST', '/v1/skills', bundleFile(testCase.bundle, 'skills', file));
    assert.ok(
      skill.status === 201 || skill.status === 200,
      `POST /v1/skills (${file}) returned ${skill.status}`,
    );
  }

  const graph = await request<{ graph_version: { id: string } }>(
    ctx,
    'POST',
    '/v1/graphs',
    bundleFile(testCase.bundle, 'grafo.json'),
  );
  assert.equal(graph.status, 201, `POST /v1/graphs returned ${graph.status}`);
  return graph.body.graph_version.id;
}

for (const testCase of CASES) {
  test(`t262 AT-8 — ${testCase.bundle}: ${testCase.finalNode} only completes once ${testCase.manifest.replace('.json', '')} reported`, async (t) => {
    requireArtifacts(...ARTIFACTS);
    const ctx = await startControlPlane(t);
    const versionId = await registerBundle(ctx, testCase);

    // Born ON the final node: this file is about what the last node owes, and
    // walking the whole graph to get there would only re-prove the transitions.
    const job = await createJob(ctx, {
      title: `travessia parada em ${testCase.finalNode}`,
      entry_node_id: testCase.finalNode,
      graph_version_id: versionId,
    });

    const readJob = async (): Promise<JobProjection> => {
      const response = await request<JobProjection>(ctx, 'GET', `/v1/jobs/${job.id}`);
      assert.equal(response.status, 200);
      return response.body;
    };

    const before = await readJob();
    assert.equal(before.current_node_id, testCase.finalNode);
    assert.equal(
      before.completed,
      false,
      `${testCase.finalNode} pins a skill and that skill has not run: the job is not done, ` +
        'it is waiting to be dispatched (t198, gap 2)',
    );
    assert.equal(before.blocked, false, 'and it is a candidate, not a blocked job');

    const opened = await request<{ id: number }>(ctx, 'POST', '/v1/sessions', {
      job_id: job.id,
      node_id: testCase.finalNode,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'Registre a travessia.',
    });
    assert.equal(opened.status, 201);

    assert.equal(
      (await readJob()).completed,
      false,
      'an OPEN session on the final node is not a finished one either',
    );

    const finished = await request(ctx, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
      status: 'completed',
      exit_code: 0,
      output: testCase.report,
    });
    assert.equal(finished.status, 200);

    const stored = await request<{ sessions: Array<{ output: unknown }> }>(
      ctx,
      'GET',
      `/v1/sessions?job_id=${job.id}`,
    );
    assert.equal(stored.status, 200);
    assert.deepEqual(
      stored.body.sessions[0].output,
      testCase.report,
      `the report has to have SURVIVED ${testCase.manifest}'s registered output schema — ` +
        'a stored null here would make the assertion below prove nothing',
    );

    assert.equal(
      (await readJob()).completed,
      true,
      'the bundle\'s own last step ran and reported what it declares: now the traversal is over',
    );
  });
}
