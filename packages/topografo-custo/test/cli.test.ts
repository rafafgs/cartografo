/**
 * End-to-end acceptance test of the `evaluate` subcommand (t114, AT9; `avaliar`
 * until t255).
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
    job_id: jobId,
    node_id: nodeId,
    engine: 'claude-code',
    working_dir: '/tmp/t114',
    prompt: `trabalhar o nó ${nodeId}`,
  })) as { id: number };

  await call(baseUrl, `/v1/sessions/${session.id}/finish`, 'PATCH', {
    status: 'completed',
    exit_code: 0,
    usage: {
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

test('AT9 — evaluate creates exactly one pending proposal from the cost lens', async (t) => {
  const { runCli } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  // --- seeding: the graph as data, one job and two sessions of distinct nodes
  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const versionId = record.graph_version.id;

  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    title: 'nota sobre custo',
    entry_node_id: 'redigir',
    execution_id: EXECUTION_ID,
    graph_version_id: versionId,
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
      'evaluate',
      '--url',
      baseUrl,
      '--execution',
      String(EXECUTION_ID),
      '--token-cap',
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
  assert.equal(proposal.evidence.lens, 'cost');
  assert.equal(proposal.evidence.type, 'ceiling');
  assert.equal(proposal.evidence.node_id, 'redigir');
  assert.equal(proposal.evidence.graph_version_id, versionId);
  assert.equal(proposal.evidence.tokens_total, 5000);
  assert.equal(proposal.evidence.ceiling_exceeded, 'tokens');

  const lines = printed.join('').trimEnd().split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 1, 'one line per proposal created');
  assert.match(lines[0], new RegExp(`\\b${proposal.id}\\b`));
  assert.match(lines[0], /redigir/);
  assert.match(lines[0], /ceiling/);
});

test('AT9 — evaluate touches only the four routes of the contract, and never /aplicar', async (t) => {
  const { runCli } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    title: 'nota sobre custo',
    entry_node_id: 'redigir',
    execution_id: EXECUTION_ID,
    graph_version_id: record.graph_version.id,
  })) as { id: number };
  await seedSession(baseUrl, job.id, 'redigir', 5000);

  const routes: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    routes.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return await fetch(input, init);
  };

  await runCli(
    ['evaluate', '--url', baseUrl, '--execution', String(EXECUTION_ID), '--token-cap', '1000'],
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

test('t255 — a proposal from this lens closes its experiment instead of 422-ing', async (t) => {
  const { runCli } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  // --- the same seeding as AT9: one expensive node under one version
  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const versionId = record.graph_version.id;

  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    title: 'nota sobre custo',
    entry_node_id: 'redigir',
    execution_id: EXECUTION_ID,
    graph_version_id: versionId,
  })) as { id: number };
  await seedSession(baseUrl, job.id, 'redigir', 5000);

  const created: unknown[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).endsWith('/v1/proposals') && init?.method === 'POST') {
      created.push(JSON.parse(await response.clone().text()));
    }
    return response;
  };

  const exitCode = await runCli(
    ['evaluate', '--url', baseUrl, '--execution', String(EXECUTION_ID), '--token-cap', String(TOKEN_CEILING)],
    { doFetch, write: () => undefined },
  );
  assert.equal(exitCode, 0);
  assert.equal(created.length, 1, 'the scenario has to produce exactly one proposal to close');

  const { proposal } = created[0] as {
    proposal: { id: number; expected_metric: Record<string, unknown> };
  };

  // The human gate, by hand: this lens applies nothing (AT9 above pins that), so
  // the two calls a person makes at the inbox are made here.
  await call(baseUrl, `/v1/proposals/${proposal.id}/approve`, 'POST', {});
  const applied = (await call(baseUrl, `/v1/proposals/${proposal.id}/apply`, 'POST', {})) as {
    proposal: { applied_version_id: string };
  };

  // The next round, demonstrable from telemetry: one job under the version the
  // proposal wrote, which is what `/outcome` demands before it judges anything.
  const nextExecution = EXECUTION_ID + 1;
  await call(baseUrl, '/v1/jobs', 'POST', {
    title: 'a rodada seguinte',
    entry_node_id: 'redigir',
    execution_id: nextExecution,
    graph_version_id: applied.proposal.applied_version_id,
  });

  const response = await fetch(`${baseUrl}/v1/proposals/${proposal.id}/outcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `execucao_id` and `depois` are the frozen hypothesis vocabulary, which this
    // ticket does not touch: what was broken was the metric this lens WROTE.
    body: JSON.stringify({ execucao_id: nextExecution, depois: 900 }),
  });
  const body = (await response.json()) as {
    error?: string;
    proposal?: { result: { veredito: string; antes: number; depois: number } };
  };

  assert.equal(
    response.status,
    200,
    `the cost lens still writes a metric nobody can read: ${JSON.stringify(body)}`,
  );
  assert.equal(body.proposal?.result.veredito, 'confirmada', '5000 tokens fell to 900');
  assert.equal(
    body.proposal?.result.antes,
    proposal.expected_metric.de,
    'the "antes" of the verdict is the `de` this lens declared',
  );
});

/* -------------------------------------------------------------------------- */
/* t180 — the output of the command is English; the subcommand and the options  */
/* stay as they are, because that is what a person types.                      */
/* -------------------------------------------------------------------------- */

test('t180 — --help prints the usage in English, naming the subcommand and the options', async () => {
  const { runCli, USAGE } = await loadCli();

  const printed: string[] = [];
  const exitCode = await runCli(['--help'], { write: (text) => printed.push(text) });

  assert.equal(exitCode, 0);
  assert.equal(printed.join(''), `${USAGE}\n`);
  assert.match(USAGE, /^usage: topografo-custo evaluate --url <url> --execution <id> \[options\]$/m);
  assert.match(USAGE, /^subcommands:$/m);
  assert.match(USAGE, /^options:$/m);
  assert.match(USAGE, /control plane to query \(required\)/);
  assert.match(USAGE, /With no ceiling declared, the ceiling policy does not run/);
  // Every flag §5.2 maps for this command, all of them English since t255: the
  // `--tier-*` pair was the last thing here a person typed in Portuguese.
  assert.match(USAGE, new RegExp('--token-cap <n>'));
  assert.match(USAGE, new RegExp('--second-cap <n>'));
  assert.match(USAGE, new RegExp('--tier-min-nodes <n>'));
  assert.match(USAGE, new RegExp('--tier-factor <n>'));
  for (const gone of ['--execucao', '--teto-tokens', '--teto-segundos', '--tier-fator', '--tier-minimo-nos', 'avaliar']) {
    assert.ok(!USAGE.includes(gone), `the usage still documents ${gone}`);
  }
});

test('t230 — the pre-D20 spellings are refused, not accepted as synonyms', async () => {
  const { runCli } = await loadCli();

  // `evaluate` refuses whatever it did not consume, so an old flag comes back as
  // an argument the command does not understand — never as an alias that
  // quietly keeps working alongside the new name.
  for (const gone of ['--execucao', '--teto-tokens', '--teto-segundos', '--tier-fator', '--tier-minimo-nos']) {
    const stderr = await stderrOf(() =>
      runCli(['evaluate', '--url', 'http://127.0.0.1:1', gone, '7'], { write: () => undefined }),
    );
    assert.match(
      stderr,
      new RegExp(`evaluate does not understand: "${gone}"`),
      `${gone} is still understood by the command`,
    );
  }
});

test('t255 — the tier options parse under their English names, and only under those', async () => {
  const { runCli } = await loadCli();

  // Nobody is listening on port 1, so a command line that PARSED gets as far as
  // the network and comes back 1 ("could not reach"). Exit 2 would mean the
  // parser refused it, which is exactly what the old spellings get.
  const parsed = await runCli(
    [
      'evaluate',
      '--url',
      'http://127.0.0.1:1',
      '--execution',
      '7',
      '--tier-factor',
      '5',
      '--tier-min-nodes',
      '2',
    ],
    { write: () => undefined },
  );
  assert.equal(parsed, 1, 'the English tier options are the ones this command takes');

  const stderr = await stderrOf(() =>
    runCli(['avaliar', '--url', 'http://127.0.0.1:1', '--execution', '7'], {
      write: () => undefined,
    }),
  );
  assert.match(
    stderr,
    /unknown subcommand: "avaliar"/,
    'the retired subcommand answers as an unknown one, never as an alias',
  );
});

test('t180 — the usage errors of evaluate are English', async () => {
  const { runCli } = await loadCli();

  assert.equal(
    await stderrOf(() => runCli(['evaluate', '--execution', '7'], { write: () => undefined })),
    'topografo-custo: evaluate needs --url\ntopografo-custo: run `topografo-custo --help` for the usage\n',
  );

  assert.equal(
    await stderrOf(() =>
      runCli(['evaluate', '--url', 'http://127.0.0.1:1'], { write: () => undefined }),
    ),
    'topografo-custo: evaluate needs --execution\ntopografo-custo: run `topografo-custo --help` for the usage\n',
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

/* -------------------------------------------------------------------------- */
/* t247 — every candidate says whether it CREATED a proposal (AT4).            */
/*                                                                            */
/* The cost lens is about to be triggered by something that types nothing and  */
/* reads no report — D21's watcher — and "posted" versus "deduplicated" is the  */
/* distinction it writes one line about. Since t246 the proposal itself cannot  */
/* answer that: a deduplicated one reads `pending` exactly like a fresh one.    */
/* -------------------------------------------------------------------------- */

test('t247 AT4 — evaluateExecution reports created: true, then false on the repeat', async (t) => {
  const { evaluateExecution } = await loadCli();
  const baseUrl = await bootAuthorized(t);

  // The same seeding as AT9: one node whose tokens pass the declared ceiling.
  const document = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as Record<string, unknown>;
  const record = (await call(baseUrl, '/v1/graphs', 'POST', document)) as {
    graph_version: { id: string };
  };
  const job = (await call(baseUrl, '/v1/jobs', 'POST', {
    title: 'nota sobre custo',
    entry_node_id: 'redigir',
    execution_id: EXECUTION_ID,
    graph_version_id: record.graph_version.id,
  })) as { id: number };
  await seedSession(baseUrl, job.id, 'redigir', 5000);

  const options = {
    url: baseUrl,
    executionId: EXECUTION_ID,
    tokenCeiling: TOKEN_CEILING,
  };

  const first = await evaluateExecution(options);
  assert.equal(first.length, 1, 'only "redigir" passes the ceiling');
  assert.equal(first[0].created, true, 'the first evaluation creates the proposal: 201');

  // The same telemetry read again: same lens, same target version, same
  // operations — t246's triple, and the proposal is still pending.
  const second = await evaluateExecution(options);
  assert.equal(second.length, 1, 'the candidate is still a candidate; what changed is what happened to it');
  assert.equal(second[0].created, false, 'the repeat matched the pending proposal: 200');
  assert.equal(second[0].id, first[0].id, 'and it is the SAME proposal, never a clone');
  assert.equal(
    second[0].status,
    first[0].status,
    'both read `pending`, which is exactly why `created` had to exist at all',
  );

  const listed = (await (await fetch(`${baseUrl}/v1/proposals`)).json()) as {
    proposals: Array<{ id: number }>;
  };
  assert.equal(
    listed.proposals.length,
    1,
    `two evaluations, one proposal: ${JSON.stringify(listed.proposals)}`,
  );
});
