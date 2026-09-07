/**
 * Acceptance tests of `--project` on the CLI (t354, FR6).
 *
 * The three API subcommands take the scope the same way every route does, and
 * from one place: `--project <id|name>` is parsed by the router
 * (`src/cli/index.ts`), resolved once against `GET /v1/projects` when a name is
 * given, and threaded into `import`, `export` and `status`. A per-subcommand
 * flag would have been three parsers and three defaults for one idea.
 *
 * `status` is also where a naming collision gets closed before it can bite. Its
 * report has always carried a field literally called `projects` that holds the
 * registered graph CLASSES (`GET /v1/classes`). With a real project list about
 * to arrive from `GET /v1/projects`, the field is renamed to `classes` in the
 * same delivery — the `--json` shape is machine output, so the rename is a
 * contract change and belongs in the ticket that makes it necessary.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FACTORY_BUNDLE,
  importedClasses,
  temporaryArea,
  looksLikeStackTrace,
  runCli,
  SHIPPED_CLASS,
  startControlPlane,
  type RunningControlPlane,
} from './cli-support.ts';

const FACTORY_CLASS = 'software-development';
const FACTORY_GRAPH = path.join(FACTORY_BUNDLE, 'graph.json');

/** Declares a project through the public API, as a person would. */
async function declareProject(cp: RunningControlPlane, name: string): Promise<number> {
  const response = await fetch(`${cp.url}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json()) as { id: number };
  assert.equal(response.status, 201, `POST /v1/projects returned ${response.status}`);
  return body.id;
}

test(
  't354 — import and export travel inside --project, and the round trip is byte-identical',
  { timeout: 300_000 },
  async (t) => {
    const base = temporaryArea(t);
    const cp = await startControlPlane(t, { databasePath: path.join(base, 'cartografo.db') });
    assert.equal(await declareProject(cp, 'second'), 2);

    const imported = await runCli(['import', FACTORY_BUNDLE, '--project', '2', '--url', cp.url], {
      token: cp.token,
    });
    assert.equal(imported.code, 0, `stdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`);

    // The default project saw none of it: the scope is a partition, not a label.
    // Minus the interview `up` registers into project 1 on its own (t360) —
    // which is itself the sharper form of the claim, since it did NOT reach
    // project 2 either.
    assert.deepEqual(await importedClasses(cp.url), [], 'nothing was imported into project 1');
    assert.deepEqual(
      await importedClasses(cp.url, 2),
      [FACTORY_CLASS],
      'and the interview of project 1 did not cross into project 2',
    );

    const exportedFile = path.join(base, 'exported.graph.json');
    const exported = await runCli(
      ['export', FACTORY_CLASS, '--project', '2', '--out', exportedFile, '--url', cp.url],
      { token: cp.token },
    );
    assert.equal(exported.code, 0, `stdout:\n${exported.stdout}\nstderr:\n${exported.stderr}`);
    assert.deepEqual(
      JSON.parse(readFileSync(exportedFile, 'utf8')),
      JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')),
      'the scope is not a field of the document: what comes out is what went in',
    );

    // Exporting the same class out of the project that never imported it is the
    // ordinary unknown-class refusal, and not an empty file.
    const missing = await runCli(['export', FACTORY_CLASS, '--url', cp.url], {
      token: cp.token,
      cwd: base,
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /unknown_graph/);
    assert.equal(looksLikeStackTrace(missing.stderr), false, `a stack trace leaked:\n${missing.stderr}`);
  },
);

test('t354 — --project takes a NAME and resolves it once', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t);
  const cp = await startControlPlane(t, { databasePath: path.join(base, 'cartografo.db') });
  await declareProject(cp, 'second');

  const imported = await runCli(
    ['import', FACTORY_BUNDLE, '--project', 'second', '--url', cp.url],
    { token: cp.token },
  );
  assert.equal(imported.code, 0, `stdout:\n${imported.stdout}\nstderr:\n${imported.stderr}`);

  assert.deepEqual(await importedClasses(cp.url, 2), [FACTORY_CLASS]);
});

test('t354 — a --project nobody declared fails with a message, not a stack', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const cp = await startControlPlane(t, { databasePath: path.join(base, 'cartografo.db') });

  const result = await runCli(['status', '--project', 'nao-existe', '--url', cp.url], {
    token: cp.token,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /nao-existe/);
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
});

test('t354 — status --json reports classes and projects apart', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const cp = await startControlPlane(t, { databasePath: path.join(base, 'cartografo.db') });
  await declareProject(cp, 'second');

  const result = await runCli(['status', '--json', '--url', cp.url], { token: cp.token });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);

  // Key for key, like `cli-status.test.ts`'s pin: this is machine output, and a
  // field that silently appears or disappears breaks its consumers. The project
  // list carries `id` and `name` only — `created_at` is a clock, and a pinned
  // shape cannot hold one. The class list is read by NAME rather than pinned
  // byte for byte, because since t360 it holds the interview `up` registers on
  // its own, whose current version is a hash no fixture can spell.
  const report = JSON.parse(result.stdout.trim()) as {
    server: string;
    classes: { class: string }[];
    projects: { id: number; name: string }[];
    jobs: number;
    pendingInputRequests: number;
  };
  assert.deepEqual(Object.keys(report), [
    'server',
    'classes',
    'projects',
    'jobs',
    'pendingInputRequests',
  ]);
  assert.equal(report.server, 'ok');
  assert.deepEqual(report.classes.map((entry) => entry.class), [SHIPPED_CLASS]);
  assert.deepEqual(report.projects, [
    { id: 1, name: 'default' },
    { id: 2, name: 'second' },
  ]);
  assert.equal(report.jobs, 0);
  assert.equal(report.pendingInputRequests, 0);

  const table = await runCli(['status', '--url', cp.url], { token: cp.token });
  assert.equal(table.code, 0, `stderr:\n${table.stderr}`);
  assert.match(table.stdout, /^classes: 1$/m, 'the graph classes are called classes now');
  assert.match(table.stdout, /^projects: 2$/m);
  assert.match(table.stdout, /second/);
});
