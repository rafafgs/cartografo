/**
 * The intake generation command against the real thing, end to end (t144, AT5/AT6).
 *
 * `generate.test.ts` fakes both sides of the control plane, so no request is ever
 * made and no credential is ever missed. This file removes exactly that fake and
 * nothing else:
 *
 * - the control plane is the REAL binary, spawned as a child process, with the
 *   credential gate t124 put on `/v1` fully armed. The token is the one it
 *   printed on its own readiness line;
 * - `globalThis.fetch` is left ALONE. `test/authorized-fetch.ts` exists for the
 *   suites that want to assert about dispatch instead of about headers, and a
 *   test that patches the global cannot find out whether the code under test
 *   presents a token, because the answer is always yes (t148);
 * - the class is registered from factory bundle 1, unedited, because a synthetic
 *   graph would not prove that the jobs are born on the entry node of the version
 *   that really holds today — the same reasoning `packages/core/test/intake-routes.test.ts`
 *   records;
 * - the engine stays fake (deterministic, no installed CLI, no authentication:
 *   `docs/formats/engine-adapter.md:363-366`), because the model's judgement is
 *   the one thing no test can assert about anyway.
 *
 * The claim that matters most is the last one: the draft this command lands is
 * the SAME draft a hand-written one is, so t122's human gate closes over it
 * unchanged. If that were not true, this ficha would have built a second intake.
 *
 * t254 added the one spawn this file was missing: the SUCCESS path. AT5a/AT5b
 * calls `generateIntakeDraft` in process, and the three spawns below all return
 * before a draft is ever posted — so the lines `cli.mjs` prints afterwards were
 * covered by nothing, and shipped reading two fields the answer does not carry.
 *
 * English per D18. Route segments and payload keys are the published wire, in
 * English since t226 and — for the item's own keys — t255; the file the session
 * writes keeps its Portuguese name, because that is data the prompt names and
 * not a field of the API.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore, resolvePins } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type { SessionSpec } from '../../src/engine/types.ts';
import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as ReaderModule from '../../src/synthesizer/control-plane-client.ts';
import type * as GenerateModule from '../../src/intake/generate.ts';
import type * as PromptModule from '../../src/intake/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CLI_PATH = path.join(PACKAGE_ROOT, 'src', 'intake', 'cli.mjs');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));
const FACTORY_GRAPH = path.join(
  REPO_ROOT,
  'factory-graphs',
  'software-development',
  'grafo.json',
);

const CLASS_NAME = 'software-development';
const REQUEST = 'Fechar a camada de intake: propor a quebra e confirmar num portao humano.';

/** Two items, one depending on the other — the shape a real batch has. */
const ITEMS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    ref: 'migracao',
    title: 'Migracao do intake',
    body: 'As duas tabelas e as colunas novas.',
    acceptance_criteria: ['a migracao roda do zero'],
  },
  { ref: 'rotas', title: 'Rotas do intake', depends_on: ['migracao'] },
]);

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/** A control plane of this test's own, and the credential it minted. */
interface ControlPlane {
  baseUrl: string;
  token: string;
}

/**
 * Boots the real control plane and returns its address and credential.
 *
 * The spawn, the readiness wait and the teardown are
 * `@cartografo/test-support`'s since t201; what stays here is the shape the
 * assertions below already speak.
 *
 * It touches no global, and that absence IS the device: with `globalThis.fetch`
 * untouched, the only credential that can reach the API is one the code under
 * test presented itself.
 */
async function bootControlPlane(t: TestHook): Promise<ControlPlane> {
  const { url, token } = await bootCore(t);
  return { baseUrl: url, token };
}

/** Talks JSON with the control plane, presenting the credential and asserting the status. */
async function api<T>(
  plane: ControlPlane,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${plane.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${plane.baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route} answered ${response.status}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** A scratch directory that cleans itself up. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t144-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Registers factory bundle 1 unedited, so the class exists exactly as shipped. */
async function registerFactoryGraph(plane: ControlPlane): Promise<string> {
  // The bundle's own manifests are not registered here (this suite is about the
  // intake, not about `cartografo import`), so a stand-in per pin is what keeps
  // the version `checked` and the jobs it confirms creatable (t283).
  const document = await resolvePins(
    plane.baseUrl,
    plane.token,
    JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')) as Record<string, unknown>,
  );
  const { graph_version: version } = await api<{ graph_version: { id: string } }>(
    plane,
    'POST',
    '/v1/graphs',
    document,
    201,
  );
  return version.id;
}

/** The `claude` argv handed whole to the fake engine, which writes the answer. */
function engineWriting(file: string, content: string): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    environmentBuilder: () => ({
      ...process.env,
      FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [file]: content }),
    }),
    graceMs: 300,
  });
}

/**
 * A directory holding a `claude` that is really the fake engine.
 *
 * The device `test/bin.e2e.test.ts` already uses, and the only one that works
 * when the command under test is a CHILD PROCESS: `engineWriting` above swaps
 * the adapter's `commandBuilder` in this process, and `cli.mjs` builds its own
 * adapter with no seam at all — deliberately, since what it needs a process for
 * is precisely the real engine. So the swap happens where a spawned command can
 * still see it, which is `PATH`.
 *
 * @param base Directory to put the shim in.
 * @returns The directory to prepend to `PATH`.
 */
function fakeEngineOnPath(base: string): string {
  const shim = path.join(base, 'claude');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_ENGINE)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return base;
}

/** Runs the real entrypoint and gives back what a shell would see. */
function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(CLI_PATH), 'artifact does not exist yet: packages/runner/src/intake/cli.mjs');

  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI_PATH, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    // A credential exported by whoever runs the suite must not decide the
    // outcome of a test about credentials.
    env: { ...process.env, CARTOGRAFO_TOKEN: '', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A draft, as `GET /v1/intake/:id` returns it. */
interface Draft {
  id: number;
  class: string;
  request: string;
  items: Array<Record<string, unknown>>;
  status: string;
  created_jobs: Record<string, number> | null;
}

interface Job {
  id: number;
  title: string;
  current_node_id: string;
  body: string | null;
  acceptance_criteria: string[] | null;
}

interface LogEvent {
  type: string;
  data: Record<string, unknown>;
}

test('AT5a/AT5b — the generated draft is a real pending one, and t122 confirms it unchanged', async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    'src/controller/cliente-controle.ts',
  );
  const { createControlPlaneReader } = await loadModule<typeof ReaderModule>(
    'src/synthesizer/control-plane-client.ts',
  );
  const { generateIntakeDraft } = await loadModule<typeof GenerateModule>('src/intake/generate.ts');
  const { OUTPUT_FILE } = await loadModule<typeof PromptModule>('src/intake/prompt.ts');

  const plane = await bootControlPlane(t);
  await registerFactoryGraph(plane);

  const draft = await generateIntakeDraft({
    reader: createControlPlaneReader(plane.baseUrl, { token: plane.token }),
    client: new ClienteControle({ urlBase: plane.baseUrl, token: plane.token }),
    adapter: engineWriting(OUTPUT_FILE, JSON.stringify({ items: ITEMS }, null, 2)),
    request: REQUEST,
    className: CLASS_NAME,
    workingDir: scratch(t, 'workdir'),
    timeoutSeconds: 60,
  });

  assert.equal(draft.status, 'pending', 'a generated draft is proposed, never confirmed');

  // (a) it is a real row, readable through the public API.
  const { draft: stored } = await api<{ draft: Draft }>(
    plane,
    'GET',
    `/v1/intake/${draft.id}`,
  );
  assert.equal(stored.class, CLASS_NAME);
  assert.equal(stored.request, REQUEST, 'the request is stored as the person typed it');
  assert.deepEqual(
    stored.items.map((item) => item.ref),
    ['migracao', 'rotas'],
  );
  assert.deepEqual(
    stored.items[1].depends_on,
    ['migracao'],
    'the dependency the session declared survived the round trip',
  );
  assert.equal(
    stored.items[1].acceptance_criteria,
    null,
    'an item with no criteria is null, never the empty list (domain/intake.ts)',
  );

  // (b) t122's human gate closes over it exactly as it does over a hand-written
  // draft — this ficha added no second confirmation path.
  const confirmed = await api<{ draft: Draft; jobs: Job[] }>(
    plane,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
    201,
  );

  assert.equal(confirmed.draft.status, 'confirmed');
  assert.equal(confirmed.jobs.length, 2);
  const created = confirmed.draft.created_jobs;
  assert.ok(created !== null, 'the confirmation maps every ref to a real id');
  assert.deepEqual(Object.keys(created).sort(), ['migracao', 'rotas']);

  const dependent = confirmed.jobs.find((job) => job.id === created.rotas);
  assert.ok(dependent !== undefined);
  assert.equal(dependent.title, 'Rotas do intake');
  assert.equal(dependent.current_node_id, 'refine', 'the traveller is born on the entry node of the version');

  const { events: events } = await api<{ events: LogEvent[] }>(
    plane,
    'GET',
    `/v1/jobs/${created.rotas}/events`,
  );
  const declared = events.find((event) => event.type === 'job.dependency_declared');
  assert.ok(declared !== undefined, `no dependency was declared: ${JSON.stringify(events)}`);
  assert.equal(declared.data.depends_on_job_id, created.migracao);
});

test('t254 — a spawned intake prints the draft it posted, over the real class, and exits 0', async (t) => {
  const { OUTPUT_FILE } = await loadModule<typeof PromptModule>('src/intake/prompt.ts');

  const plane = await bootControlPlane(t);
  await registerFactoryGraph(plane);

  // The gap this closes: every spawn above returns BEFORE the draft is posted —
  // a refusal, a usage error, a denied credential — so the last three lines of
  // `cli.mjs`, the ones that run only after the write succeeded, had never been
  // executed by any test. They read `draft.itens`/`draft.classe` off a
  // `Rascunho` that carries `items`/`class`, which is a TypeError thrown after
  // the row is already in the book: `npm run intake` exited 1 on a run that had
  // worked, and there was nothing in the report to say the draft existed.
  const result = runCli(
    [
      REQUEST,
      '--class',
      CLASS_NAME,
      '--url',
      plane.baseUrl,
      '--token',
      plane.token,
      '--dir',
      scratch(t, 'spawned-workdir'),
    ],
    {
      PATH: `${fakeEngineOnPath(scratch(t, 'spawned-bin'))}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_ENGINE_WRITE_FILES: JSON.stringify({
        // `items`, not `itens`: t255 moved the envelope key the session writes
        // to English along with the item's own, and `generate.ts` reads
        // `document.items` now — a draft under the old key is `missing_items`.
        [OUTPUT_FILE]: JSON.stringify({ items: ITEMS }, null, 2),
      }),
    },
  );

  assert.equal(result.status, 0, `a posted draft is a 0:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(
    result.stdout,
    /with 2 item\(s\)/,
    `the summary has to count the items that were posted:\n${result.stdout}`,
  );
  assert.match(
    result.stdout,
    new RegExp(`over ${CLASS_NAME}`),
    `...and name the class they will cross:\n${result.stdout}`,
  );
  assert.doesNotMatch(
    result.stdout,
    /undefined/,
    `a field the answer does not carry reads as "undefined":\n${result.stdout}`,
  );

  // ...and what it printed is a real row, not a hopeful line: one draft, the two
  // items, still waiting on the human gate.
  const { drafts } = await api<{ drafts: Draft[] }>(plane, 'GET', '/v1/intake');
  assert.equal(drafts.length, 1, 'exactly one draft was posted');
  assert.equal(drafts[0].status, 'pending');
  assert.equal(drafts[0].items.length, 2);
  assert.match(result.stdout, new RegExp(`draft ${drafts[0].id} `), 'and the id printed is that row');
});

test('AT5c — an unregistered class posts nothing, and the command exits 1', async (t) => {
  const plane = await bootControlPlane(t);
  // Deliberately no graph registered: every class is unknown here.

  const result = runCli([
    REQUEST,
    '--class',
    'classe-que-ninguem-registrou',
    '--url',
    plane.baseUrl,
    '--token',
    plane.token,
  ]);

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(
    result.stderr,
    new RegExp('grafo_desconhecido'),
    'the refusal echoes the control plane own code',
  );

  const { drafts: drafts } = await api<{ drafts: Draft[] }>(plane, 'GET', '/v1/intake');
  assert.deepEqual(drafts, [], 'a refused class never reaches POST /v1/intake');
});

test('AT6 — --help exits 0 and a missing --class exits 2', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0, `stderr:\n${help.stderr}`);
  assert.match(help.stdout, new RegExp('--class'));
  assert.match(help.stdout, new RegExp('--token'));
  assert.match(help.stdout, /rascunho|draft/i, 'what the command produces is named');

  const typo = runCli([REQUEST]);
  assert.equal(typo.status, 2, `stdout:\n${typo.stdout}\nstderr:\n${typo.stderr}`);
  assert.match(typo.stderr, new RegExp('--class'), 'the message names the flag that is missing');
});

test('AT6 — a control plane that refuses the credential exits 1, saying what to do', async (t) => {
  const plane = await bootControlPlane(t);

  const result = runCli([REQUEST, '--class', CLASS_NAME, '--url', plane.baseUrl]);

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, new RegExp('CARTOGRAFO_TOKEN'));
  assert.match(result.stderr, new RegExp('--token'));

  const { drafts: drafts } = await api<{ drafts: Draft[] }>(plane, 'GET', '/v1/intake');
  assert.deepEqual(drafts, [], 'a denied command writes nothing either');
});
