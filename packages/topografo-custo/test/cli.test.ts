/**
 * End-to-end acceptance test of the `avaliar` subcommand (t114, AT9).
 *
 * It starts the real control plane as a child process — the same pattern as
 * `packages/runner/test/controller/dispatch-e-lease.e2e.test.ts` — seeds an
 * execution with real telemetry and runs the command against it. Nothing is
 * simulated: graph, job, sessions and proposal all cross the public API over
 * HTTP.
 *
 * It is this file that proves the central criterion of that ticket: a second
 * surveyor fits the API that already exists, **without opening
 * `packages/core`**. That is why the final assertion is not about the proposal
 * but about the set of routes touched: four, all reads but one, and none of them
 * `/aplicar` — applying is still a human decision at the gate (README,
 * principle 5).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bootCore, type TestHook } from '@cartografo/test-support';

import type * as CliModule from '../src/cli.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GRAPH_PATH = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-valido-minimo.json');

/** Grouper of the seeded round. Opaque by design (t102). */
const EXECUTION_ID = 7;
/** Token ceiling of the scenario: "redigir" passes it, "revisar" is nowhere near. */
const TOKEN_CEILING = 1000;

type TestContext = TestHook;

let cache: typeof CliModule | null = null;

async function loadCli(): Promise<typeof CliModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'cli.ts')),
    'artifact does not exist yet: packages/topografo-custo/src/cli.ts',
  );
  cache ??= (await import(new URL('../src/cli.ts', import.meta.url).href)) as typeof CliModule;
  return cache;
}

/**
 * Boots the real control plane with its credential armed on the global `fetch`.
 *
 * Since t124 the API does not answer without a credential. The control plane
 * prints the one it has just issued; this test presents it from here on, both in
 * the seeding and in the command — which is how a person would run it.
 *
 * The patch stays local to this file on purpose: the surveyor's CLI is the code
 * under test and it builds its own requests, so what a shared helper could arm
 * for everybody would quietly hide which side presented the token. Everything
 * ABOVE the patch — spawn, readiness, teardown — is `@cartografo/test-support`'s
 * since t201.
 *
 * @param t Test context, so both the process and the patch are undone at the end.
 * @returns The URL the control plane announced.
 */
async function bootAuthorized(t: TestContext): Promise<string> {
  const { url, token } = await bootCore(t);

  const previous = globalThis.fetch;
  globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!target.startsWith(url)) return await previous(input, init);
    const headers = new Headers(init?.headers);
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return await previous(input, { ...init, headers });
  };
  t.after(() => {
    globalThis.fetch = previous;
  });

  return url;
}

/** A raw POST/PATCH against the control plane, with the answer already parsed. */
async function call(
  baseUrl: string,
  route: string,
  method: 'POST' | 'PATCH',
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${route} answered ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** Opens and finishes a session of a node, with the declared token totals. */
async function seedSession(
  baseUrl: string,
  jobId: number,
  nodeId: string,
  tokens: number,
): Promise<void> {
  // The route returns the projection of the raw session in the body, with no
  // envelope (t102).
  const session = (await call(baseUrl, '/v1/sessions', 'POST', {
    trabalho_id: jobId,
    no_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/t114',
    prompt: `trabalhar o nó ${nodeId}`,
  })) as { id: number };

  await call(baseUrl, `/v1/sessions/${session.id}/finish`, 'PATCH', {
    status: 'concluida',
    exit_code: 0,
    uso: {
      input_tokens: tokens,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
}

interface SpiedCall {
  route: string;
  method: string;
  body: unknown;
  response: unknown;
}

test('AT9 — avaliar creates exactly one pending proposal from the cost lens', async (t) => {
  const { runCli } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  // --- seeding: the graph as data, one job and two sessions of distinct nodes
  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const versionId = record.graph_version.id;

  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    titulo: 'nota sobre custo',
    no_entrada_id: 'redigir',
    execucao_id: EXECUTION_ID,
    grafo_versao_id: versionId,
  })) as { id: number };

  await seedSession(baseUrl, job.id, 'redigir', 5000);
  await seedSession(baseUrl, job.id, 'revisar', 100);

  // --- the command, with the network spied on but real
  const calls: SpiedCall[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const response = await fetch(input, init);
    const echo = response.clone();
    const text = await echo.text();
    calls.push({
      route: new URL(url).pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      response: text === '' ? undefined : JSON.parse(text),
    });
    return response;
  };

  const printed: string[] = [];
  const exitCode = await runCli(
    [
      'avaliar',
      '--url',
      baseUrl,
      '--execucao',
      String(EXECUTION_ID),
      '--teto-tokens',
      String(TOKEN_CEILING),
    ],
    { doFetch, write: (text) => printed.push(text) },
  );

  assert.equal(exitCode, 0, `the command exited ${exitCode}:\n${printed.join('')}`);

  const creations = calls.filter(
    (spied) => spied.route === '/v1/proposals' && spied.method === 'POST',
  );
  assert.equal(creations.length, 1, 'only "redigir" passes the ceiling; "revisar" makes nothing');

  const { proposal: proposal } = creations[0].response as {
    proposal: { id: number; status: string; evidence: Record<string, unknown> };
  };
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.evidence.lente, 'custo');
  assert.equal(proposal.evidence.tipo, 'teto');
  assert.equal(proposal.evidence.no_id, 'redigir');
  assert.equal(proposal.evidence.grafo_versao_id, versionId);
  assert.equal(proposal.evidence.tokens_total, 5000);
  assert.equal(proposal.evidence.teto_excedido, 'tokens');

  const lines = printed.join('').trimEnd().split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'one line per proposal created');
  assert.match(lines[0], new RegExp(`\\b${proposal.id}\\b`));
  assert.match(lines[0], /redigir/);
  assert.match(lines[0], /teto/);
});

test('AT9 — avaliar touches only the four routes of the contract, and never /aplicar', async (t) => {
  const { runCli } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    titulo: 'nota sobre custo',
    no_entrada_id: 'redigir',
    execucao_id: EXECUTION_ID,
    grafo_versao_id: record.graph_version.id,
  })) as { id: number };
  await seedSession(baseUrl, job.id, 'redigir', 5000);

  const routes: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    routes.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return await fetch(input, init);
  };

  await runCli(
    ['avaliar', '--url', baseUrl, '--execucao', String(EXECUTION_ID), '--teto-tokens', '1000'],
    { doFetch, write: () => undefined },
  );

  const allowed = [
    /^GET \/v1\/sessions$/,
    /^GET \/v1\/jobs$/,
    /^GET \/v1\/graph-versions\/[^/]+$/,
    /^POST \/v1\/proposals$/,
  ];
  for (const touched of routes) {
    assert.ok(
      allowed.some((pattern) => pattern.test(touched)),
      `route outside the contract of this lens: ${touched}`,
    );
  }
  assert.ok(
    routes.every((touched) => !touched.includes('/aplicar')),
    'applying a proposal is a human decision at the gate, never the surveyor',
  );
});

/* -------------------------------------------------------------------------- */
/* t180 — the output of the command is English; the subcommand and the options  */
/* stay as they are, because that is what a person types.                      */
/* -------------------------------------------------------------------------- */

test('t180 — --help prints the usage in English, still naming avaliar and the options', async () => {
  const { runCli, USAGE } = await loadCli();

  const printed: string[] = [];
  const exitCode = await runCli(['--help'], { write: (text) => printed.push(text) });

  assert.equal(exitCode, 0);
  assert.equal(printed.join(''), `${USAGE}\n`);
  assert.match(USAGE, /^usage: topografo-custo avaliar --url <url> --execucao <id> \[options\]$/m);
  assert.match(USAGE, /^subcommands:$/m);
  assert.match(USAGE, /^options:$/m);
  assert.match(USAGE, /control plane to query \(required\)/);
  assert.match(USAGE, /With no ceiling declared, the ceiling policy does not run/);
  // What the person types does not change (D20 freezes the published surface).
  assert.match(USAGE, new RegExp('--teto-tokens <n>'));
  assert.match(USAGE, new RegExp('--tier-minimo-nos <n>'));
});

test('t180 — the usage errors of avaliar are English', async () => {
  const { runCli } = await loadCli();

  assert.equal(
    await stderrOf(() => runCli(['avaliar', '--execucao', '7'], { write: () => undefined })),
    'topografo-custo: avaliar needs --url\ntopografo-custo: run `topografo-custo --help` for the usage\n',
  );

  assert.equal(
    await stderrOf(() =>
      runCli(['avaliar', '--url', 'http://127.0.0.1:1'], { write: () => undefined }),
    ),
    'topografo-custo: avaliar needs --execucao\ntopografo-custo: run `topografo-custo --help` for the usage\n',
  );
});

/**
 * Runs something and returns what went to stderr.
 *
 * `runCli` never propagates a `UsageError` — it prints and returns 2 —, so the
 * text that matters is exactly what a person sees in the terminal.
 */
async function stderrOf(action: () => Promise<number>): Promise<string> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((text: string) => {
    chunks.push(String(text));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(await action(), 2, 'a usage error exits 2, as in `cartografo`');
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}
