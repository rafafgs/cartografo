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
 *   `docs/formatos/engine-adapter.md:363-366`), because the model's judgement is
 *   the one thing no test can assert about anyway.
 *
 * The claim that matters most is the last one: the draft this command lands is
 * the SAME draft a hand-written one is, so t122's human gate closes over it
 * unchanged. If that were not true, this ficha would have built a second intake.
 *
 * English per D18; route segments, payload keys and the file the session writes
 * are the published, Portuguese surface.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

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
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'grafo.json',
);

const CLASS_NAME = 'desenvolvimento-de-software';
const REQUEST = 'Fechar a camada de intake: propor a quebra e confirmar num portao humano.';

/** Two items, one depending on the other — the shape a real batch has. */
const ITEMS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    ref: 'migracao',
    titulo: 'Migracao do intake',
    corpo: 'As duas tabelas e as colunas novas.',
    criterios_de_aceite: ['a migracao roda do zero'],
  },
  { ref: 'rotas', titulo: 'Rotas do intake', depende_de: ['migracao'] },
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
  const document: unknown = JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8'));
  const { grafo_versao: version } = await api<{ grafo_versao: { id: string } }>(
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
  classe: string;
  pedido: string;
  itens: Array<Record<string, unknown>>;
  status: string;
  trabalhos_criados: Record<string, number> | null;
}

interface Job {
  id: number;
  titulo: string;
  no_atual: string;
  corpo: string | null;
  criterios_de_aceite: string[] | null;
}

interface LogEvent {
  tipo: string;
  dados: Record<string, unknown>;
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
    adapter: engineWriting(OUTPUT_FILE, JSON.stringify({ itens: ITEMS }, null, 2)),
    request: REQUEST,
    className: CLASS_NAME,
    workingDir: scratch(t, 'workdir'),
    timeoutSeconds: 60,
  });

  assert.equal(draft.status, 'pendente', 'a generated draft is proposed, never confirmed');

  // (a) it is a real row, readable through the public API.
  const { rascunho: stored } = await api<{ rascunho: Draft }>(
    plane,
    'GET',
    `/v1/intake/${draft.id}`,
  );
  assert.equal(stored.classe, CLASS_NAME);
  assert.equal(stored.pedido, REQUEST, 'the request is stored as the person typed it');
  assert.deepEqual(
    stored.itens.map((item) => item.ref),
    ['migracao', 'rotas'],
  );
  assert.deepEqual(
    stored.itens[1].depende_de,
    ['migracao'],
    'the dependency the session declared survived the round trip',
  );
  assert.equal(
    stored.itens[1].criterios_de_aceite,
    null,
    'an item with no criteria is null, never the empty list (domain/intake.ts)',
  );

  // (b) t122's human gate closes over it exactly as it does over a hand-written
  // draft — this ficha added no second confirmation path.
  const confirmed = await api<{ rascunho: Draft; trabalhos: Job[] }>(
    plane,
    'POST',
    `/v1/intake/${draft.id}/confirmations`,
    {},
    201,
  );

  assert.equal(confirmed.rascunho.status, 'confirmado');
  assert.equal(confirmed.trabalhos.length, 2);
  const created = confirmed.rascunho.trabalhos_criados;
  assert.ok(created !== null, 'the confirmation maps every ref to a real id');
  assert.deepEqual(Object.keys(created).sort(), ['migracao', 'rotas']);

  const dependent = confirmed.trabalhos.find((job) => job.id === created.rotas);
  assert.ok(dependent !== undefined);
  assert.equal(dependent.titulo, 'Rotas do intake');
  assert.equal(dependent.no_atual, 'refinar', 'the traveller is born on the entry node of the version');

  const { eventos: events } = await api<{ eventos: LogEvent[] }>(
    plane,
    'GET',
    `/v1/jobs/${created.rotas}/events`,
  );
  const declared = events.find((event) => event.tipo === 'trabalho.dependencia_declarada');
  assert.ok(declared !== undefined, `no dependency was declared: ${JSON.stringify(events)}`);
  assert.equal(declared.dados.depende_de_trabalho_id, created.migracao);
});

test('AT5c — an unregistered class posts nothing, and the command exits 1', async (t) => {
  const plane = await bootControlPlane(t);
  // Deliberately no graph registered: every class is unknown here.

  const result = runCli([
    REQUEST,
    '--classe',
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

  const { rascunhos: drafts } = await api<{ rascunhos: Draft[] }>(plane, 'GET', '/v1/intake');
  assert.deepEqual(drafts, [], 'a refused class never reaches POST /v1/intake');
});

test('AT6 — --help exits 0 and a missing --classe exits 2', () => {
  const help = runCli(['--help']);
  assert.equal(help.status, 0, `stderr:\n${help.stderr}`);
  assert.match(help.stdout, new RegExp('--classe'));
  assert.match(help.stdout, new RegExp('--token'));
  assert.match(help.stdout, /rascunho|draft/i, 'what the command produces is named');

  const typo = runCli([REQUEST]);
  assert.equal(typo.status, 2, `stdout:\n${typo.stdout}\nstderr:\n${typo.stderr}`);
  assert.match(typo.stderr, new RegExp('--classe'), 'the message names the flag that is missing');
});

test('AT6 — a control plane that refuses the credential exits 1, saying what to do', async (t) => {
  const plane = await bootControlPlane(t);

  const result = runCli([REQUEST, '--classe', CLASS_NAME, '--url', plane.baseUrl]);

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, new RegExp('CARTOGRAFO_TOKEN'));
  assert.match(result.stderr, new RegExp('--token'));

  const { rascunhos: drafts } = await api<{ rascunhos: Draft[] }>(plane, 'GET', '/v1/intake');
  assert.deepEqual(drafts, [], 'a denied command writes nothing either');
});
