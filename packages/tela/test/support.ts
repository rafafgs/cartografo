/**
 * Shared support for the screen's acceptance tests (t107).
 *
 * Not a test file (the package glob is `test/*.test.ts`): it is the repeated
 * part of four tickets — start a REAL control plane, start the screen FOR REAL
 * against it, and speak HTTP with both.
 *
 * The control plane comes up as a CHILD PROCESS, not through an import. That is
 * D11 being exercised instead of declared: the screen cannot import anything
 * from `packages/core`, declares no SQLite driver and does not know the
 * database path — the only surface between the two packages is the HTTP port,
 * and a test that imported the core to seed data would prove less than it
 * promises (it is the same pattern as
 * `packages/runner/test/controller/dispatch-e-lease.e2e.test.ts`).
 *
 * As a consequence, ALL the data seeding in these tests goes through the public
 * API, and so does every state check.
 *
 * The screen, by contrast, comes up IN PROCESS: `bin/tela.mjs` is a thin shell
 * (a TDD exception declared in the ticket) and what the tests exercise is
 * `src/router.ts`.
 *
 * The Portuguese field names in the projections below are the control plane's
 * wire format, frozen by t127's FR8 exception: this file mirrors them.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';

import type * as RouterModule from '../src/router.ts';

/** Root of the `packages/tela` package. */
export const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Root of the monorepo. */
export const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The control plane's command, run as a child process. */
export const CORE_BIN = path.join(REPO_ROOT, 'packages', 'core', 'bin', 'cartografo.mjs');

/** Artifacts this ticket creates; every test requires the ones it exercises. */
export const T107_ARTIFACTS = Object.freeze({
  client: 'src/client.ts',
  timeline: 'src/timeline.ts',
  pages: 'src/pages.ts',
  router: 'src/router.ts',
  bin: 'bin/tela.mjs',
});

/** Deadline for the control plane to come up. Wide margin over the usual ~2s. */
const READINESS_TIMEOUT_MS = 60_000;

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, stdout/stderr both read. */
type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

/** The slice of `node:test`'s `TestContext` this support module uses. */
export interface TestHooks {
  after: (fn: () => void | Promise<void>) => void;
}

/**
 * Fails naming the missing file, instead of letting the import blow up.
 *
 * @param relatives Paths relative to the root of `packages/tela`.
 */
export function requireArtifacts(...relatives: string[]): void {
  for (const relative of relatives) {
    assert.ok(
      existsSync(path.join(PACKAGE_ROOT, relative)),
      `artifact does not exist yet: packages/tela/${relative}`,
    );
  }
}

/** The control plane, up, as seen by someone who only speaks HTTP with it. */
export interface RunningControlPlane {
  /** Base URL announced by the command itself. */
  url: string;
  /**
   * Operator credential, read off the same readiness line (t124).
   *
   * The database is brand new on every start here, so the control plane always
   * mints one and always prints it. It is what `api()` seeds with and what the
   * screen is configured to forward — the screen holds a service credential and
   * the browser keeps holding none (D11).
   */
  token: string;
}

/**
 * Starts the real control plane and resolves when it announces readiness.
 *
 * @param t Test context, so the process is shut down at the end.
 * @returns The control plane, up.
 */
export async function startControlPlane(t: TestHooks): Promise<RunningControlPlane> {
  assert.ok(existsSync(CORE_BIN), `artifact does not exist yet: ${CORE_BIN}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t107-'));
  const child: CommandChild = spawn(process.execPath, [CORE_BIN], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await wait(100);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before becoming ready (code ${child.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    const line = stdout
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.startsWith('{') && text.includes('cartografo.ready'));
    if (line !== undefined) {
      const readiness = JSON.parse(line) as { url: string; bootstrapToken: string | null };
      assert.equal(
        typeof readiness.bootstrapToken,
        'string',
        'a brand-new database announces the credential these tests authenticate with',
      );
      return { url: readiness.url, token: readiness.bootstrapToken ?? '' };
    }
    await wait(50);
  }

  throw new Error(`the control plane was not ready in ${READINESS_TIMEOUT_MS}ms\nstdout:\n${stdout}`);
}

/** The screen, up. */
export interface ScreenUnderTest {
  url: string;
}

/**
 * Starts the screen against a control plane, on an ephemeral port.
 *
 * The screen receives the control plane's credential and forwards it on every
 * call it makes (t124, FR7). It is the whole control plane the screen is given,
 * and not just its URL, because an address without a credential no longer
 * reaches anything.
 *
 * @param t Test context, so the server is shut down at the end.
 * @param cp The control plane the screen will read.
 * @returns The screen, up.
 */
export async function startScreen(t: TestHooks, cp: RunningControlPlane): Promise<ScreenUnderTest> {
  requireArtifacts(T107_ARTIFACTS.router);
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const screen = await startScreenRouter({
    controlPlaneUrl: cp.url,
    token: cp.token,
    port: 0,
  });
  t.after(async () => {
    await screen.close();
  });
  return { url: screen.url };
}

/** An HTTP/JSON answer from the control plane. */
export interface JsonResponse<T> {
  status: number;
  body: T;
}

/**
 * Speaks JSON with the control plane — the tests' seeding and checking.
 *
 * @param cp The control plane, up.
 * @param method HTTP verb.
 * @param path Path, already carrying the `/v1` prefix.
 * @param body JSON body, when there is one.
 * @returns Status and decoded body.
 */
export async function api<T>(
  cp: RunningControlPlane,
  method: string,
  path: string,
  body?: unknown,
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = { authorization: `Bearer ${cp.token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${cp.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

/** Job projection, as the public API returns it. */
export interface Job {
  id: number;
  execucao_id: number | null;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  criado_em: string;
}

/** Session projection, as the public API returns it. */
export interface Session {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  engine: string;
  status: string;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Input-request projection, as the public API returns it. */
export interface Question {
  id: number;
  trabalho_id: number;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  criada_em: string;
  respondida_em: string | null;
}

/** Shortcut: creates a job through the public API. */
export async function createJob(
  cp: RunningControlPlane,
  body: Record<string, unknown>,
): Promise<Job> {
  const response = await api<Job>(cp, 'POST', '/v1/jobs', body);
  assert.equal(response.status, 201, `POST /v1/jobs returned ${response.status}`);
  return response.body;
}

/** Shortcut: opens a session through the public API. */
export async function openSession(
  cp: RunningControlPlane,
  body: Record<string, unknown>,
): Promise<Session> {
  const response = await api<Session>(cp, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
    ...body,
  });
  assert.equal(response.status, 201, `POST /v1/sessions returned ${response.status}`);
  return response.body;
}

/** Shortcut: creates an input request through the public API. */
export async function createQuestion(
  cp: RunningControlPlane,
  body: Record<string, unknown>,
): Promise<Question> {
  const response = await api<Question>(cp, 'POST', '/v1/input-requests', {
    tipo: 'pergunta',
    auto_aprovavel: false,
    ...body,
  });
  assert.equal(response.status, 201, `POST /v1/input-requests returned ${response.status}`);
  return response.body;
}

/** An HTML page, already read. */
export interface PageResponse {
  status: number;
  contentType: string | null;
  html: string;
}

/**
 * Asks the screen for a page.
 *
 * @param screen The screen, up.
 * @param path Route path.
 * @returns Status, content-type and body.
 */
export async function openPage(screen: ScreenUnderTest, path: string): Promise<PageResponse> {
  const response = await fetch(`${screen.url}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    html: await response.text(),
  };
}

/** The answer to a form submit. */
export interface FormResult {
  status: number;
  location: string | null;
}

/**
 * Submits one of the screen's forms, the way a browser would.
 *
 * `redirect: 'manual'` is the point: the test needs to SEE the 303 and where it
 * points, not the result of having already followed it.
 *
 * @param screen The screen, up.
 * @param path Path of the write route.
 * @param fields Form fields.
 * @returns Status and the redirect's `Location`.
 */
export async function submitForm(
  screen: ScreenUnderTest,
  path: string,
  fields: Record<string, string>,
): Promise<FormResult> {
  const response = await fetch(`${screen.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location') };
}

/** A block of HTML sliced out by a `data-*` marker. */
export interface Block {
  value: string;
  excerpt: string;
}

/**
 * Slices the HTML at the points where a `data-*` marker appears.
 *
 * Cutting by marker, not parsing: the screen's `data-*` attributes are a
 * contract declared in `docs/spec/tela.md` precisely so the tests can assert
 * about STRUCTURE (what is inside which group, in what order) without freezing
 * the whole markup. Each block runs from its marker to the next marker of the
 * same name — enough for "this title is under this group".
 *
 * @param html The whole page.
 * @param attribute Marker name, without the `data-` prefix (e.g. `no-atual`).
 * @returns Blocks in the order they appear.
 */
export function blocks(html: string, attribute: string): Block[] {
  const pattern = new RegExp(`data-${attribute}="([^"]*)"`, 'g');
  const marks: { value: string; start: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    marks.push({ value: match[1], start: match.index });
  }
  return marks.map((mark, index) => ({
    value: mark.value,
    excerpt: html.slice(mark.start, marks[index + 1]?.start ?? html.length),
  }));
}
