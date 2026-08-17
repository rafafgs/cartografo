/**
 * Acceptance tests for everything the dispatch owes the control plane once a
 * session's outcome is being processed (t202, FR4/FR7).
 *
 * Until the split these nine writes were closures inside
 * `dispatch-claude-code.ts`, reading `call` off the enclosing scope, and the
 * only way to ask "what does a routing escalation actually POST?" was to boot a
 * real control plane over HTTP, run a fake engine against it and read the row
 * back out. Nineteen tests did exactly that, and they still do — that suite is
 * what proves the orchestration. What it cannot do is pin one call's BODY
 * cheaply, which is why `finish` shipped `uso: null` hardcoded for eleven
 * fichas with nobody the wiser (t172).
 *
 * Here each function takes its client as a parameter, so a fake `call` that
 * records what it was handed is the whole harness: no server, no engine, no
 * worktree, no database.
 *
 * English per D18; every route, field and status value is wire vocabulary and
 * stays in Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { ControlPlaneCall } from '../../src/dispatch/control-plane-client.ts';
import type { GraphEdge, ResolvedNode } from '../../src/dispatch/resolve-node.ts';
import type * as ReportModule from '../../src/dispatch/report.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/report.ts';

let cache: typeof ReportModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadReport(): Promise<typeof ReportModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/report.ts', import.meta.url).href
  )) as typeof ReportModule;
  return cache;
}

/** One call the fake client was handed. */
interface Sent {
  route: string;
  method: string;
  body: unknown;
}

/** A fake `call` that records every request and never refuses. */
function recorder(): { sent: Sent[]; call: ControlPlaneCall } {
  const sent: Sent[] = [];
  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    sent.push({ route, method, body });
    return undefined as T;
  };
  return { sent, call };
}

/** A fake `call` that refuses the routes whose path contains `failOn`. */
function refuser(failOn: string, error: Error): { sent: Sent[]; call: ControlPlaneCall } {
  const sent: Sent[] = [];
  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    sent.push({ route, method, body });
    if (route.includes(failOn)) throw error;
    return undefined as T;
  };
  return { sent, call };
}

/** The work every case here reports about, in the part a report reads. */
const JOB = Object.freeze({ id: 7, current_node_id: 'revisao' });

/** Reads a recorded body as a plain record, so a field can be named. */
function body(sent: Sent): Record<string, unknown> {
  return sent.body as Record<string, unknown>;
}

/** A node with the given edges, and optionally a declared escalation policy. */
function node(edges: GraphEdge[], escalationPolicy?: string): ResolvedNode {
  return {
    versionId: 'sha256:abc',
    node: {
      id: JOB.current_node_id,
      ...(escalationPolicy === undefined ? {} : { escalation_policy: escalationPolicy }),
    },
    edges,
  };
}

/* -- the two unconditional writes ------------------------------------------ */

test('AT1 — `transition` posts the target node and the system actor', async () => {
  const { transition } = await loadReport();
  const { sent, call } = recorder();

  await transition(call, JOB, { from: 'revisao', to: 'entrega', condition: 'aprovado' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/transitions');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].body, {
    para_no_id: 'entrega',
    ator: { tipo: 'sistema', ref: 'runner' },
  });
});

test('AT2 — `blockWithNobodyToAsk` posts the reason it was given, as the system', async () => {
  const { blockWithNobodyToAsk } = await loadReport();
  const { sent, call } = recorder();

  await blockWithNobodyToAsk(call, JOB, 'Este nó não tem a quem perguntar.');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(sent[0].body, {
    motivo: 'Este nó não tem a quem perguntar.',
    ator: { tipo: 'sistema', ref: 'runner' },
  });
});

test('AT3 — `blockForUncommittedWork` names the tree that was retained', async () => {
  const { blockForUncommittedWork } = await loadReport();
  const { sent, call } = recorder();

  await blockForUncommittedWork(call, JOB, '/tmp/worktrees/job-7');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');

  const motivo = body(sent[0]).motivo;
  assert.equal(typeof motivo, 'string');
  assert.ok((motivo as string).includes('/tmp/worktrees/job-7'));
  assert.ok((motivo as string).includes(JOB.current_node_id));
  assert.deepEqual(body(sent[0]).ator, { tipo: 'sistema', ref: 'runner' });
});

/* -- the routing escalation, and its `never` twin --------------------------- */

const TWO_EDGES: GraphEdge[] = [
  { from: 'revisao', to: 'entrega', condition: 'aprovado' },
  { from: 'revisao', to: 'desenvolvimento', condition: 'retrabalho' },
];

test('AT4 — under an ordinary policy the routing escalation posts a question', async () => {
  const { escalateRouting } = await loadReport();
  const { sent, call } = recorder();

  await escalateRouting(call, JOB, 31, TWO_EDGES, 'escala', 'on_uncertainty');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/input-requests');
  assert.equal(sent[0].method, 'POST');

  const posted = body(sent[0]);
  assert.equal(posted.trabalho_id, JOB.id);
  assert.equal(posted.sessao_id, 31);
  assert.equal(posted.tipo, 'pergunta');
  assert.deepEqual(posted.opcoes, ['aprovado', 'retrabalho']);
  assert.equal(posted.auto_aprovavel, true);
  assert.deepEqual(posted.ator, { tipo: 'sistema', ref: 'runner' });
  assert.ok(String(posted.pergunta).includes('"escala"'));
  assert.ok(String(posted.contexto).includes('entrega'));
  assert.ok(String(posted.contexto).includes('desenvolvimento'));
});

test('AT5 — with no result observed at all the question says so', async () => {
  const { escalateRouting } = await loadReport();
  const { sent, call } = recorder();

  await escalateRouting(call, JOB, 31, TWO_EDGES, null, 'always');

  assert.ok(String(body(sent[0]).pergunta).includes('nenhum'));
});

test('AT6 — under `never` it blocks instead, and posts no question at all', async () => {
  const { escalateRouting } = await loadReport();
  const { sent, call } = recorder();

  await escalateRouting(call, JOB, 31, TWO_EDGES, 'escala', 'never');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.ok(!sent.some((request) => request.route === '/v1/input-requests'));
  assert.ok(String(body(sent[0]).motivo).includes('não tem a quem perguntar'));
});

/* -- the decision on top of them ------------------------------------------- */

test('AT7 — `advance` on a node with no way out writes nothing', async () => {
  const { advance } = await loadReport();
  const { sent, call } = recorder();

  await advance(call, JOB, node([]), 31, 'qualquer coisa');

  assert.equal(sent.length, 0);
});

test('AT8 — `advance` on a single edge transitions whatever the session said', async () => {
  const { advance } = await loadReport();
  const { sent, call } = recorder();

  await advance(
    call,
    JOB,
    node([{ from: 'revisao', to: 'entrega', condition: 'sempre' }]),
    31,
    'a sessão não escolheu nada',
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/transitions');
  assert.deepEqual(body(sent[0]).para_no_id, 'entrega');
});

test('AT9 — `advance` on two edges takes the one the result names', async () => {
  const { advance } = await loadReport();
  const { sent, call } = recorder();

  const output = ['Conferi os critérios.', '```resultado', '{"resultado":"retrabalho"}', '```'].join(
    '\n',
  );
  await advance(call, JOB, node(TWO_EDGES), 31, output);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/transitions');
  assert.equal(body(sent[0]).para_no_id, 'desenvolvimento');
});

test('AT10 — `advance` on two edges escalates when nothing matches', async () => {
  const { advance } = await loadReport();
  const { sent, call } = recorder();

  const output = ['```resultado', '{"resultado":"escala"}', '```'].join('\n');
  await advance(call, JOB, node(TWO_EDGES), 31, output);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/input-requests');
});

test('AT11 — `advance` at a `never` node blocks rather than asking', async () => {
  const { advance } = await loadReport();
  const { sent, call } = recorder();

  await advance(call, JOB, node(TWO_EDGES, 'never'), 31, 'nada fenceado aqui');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
});

/* -- the denials, which start before there is an id to post them against ---- */

const DENIAL = Object.freeze({
  recurso: 'rede' as const,
  ferramenta: 'WebFetch',
  motivo: 'a política desta sessão nega WebFetch',
});

test('AT12 — a denial recorded before the session exists is queued, then flushed in order', async () => {
  const { PermissionDenialReporter } = await loadReport();
  const { sent, call } = recorder();

  const reporter = new PermissionDenialReporter(call);
  reporter.record({ ...DENIAL, ferramenta: 'WebFetch' });
  reporter.record({ ...DENIAL, ferramenta: 'Bash(curl *)' });

  assert.equal(sent.length, 0, 'nothing may go out before there is a session to post it against');

  reporter.bindSession(31);
  await reporter.drain();

  assert.equal(sent.length, 2);
  assert.equal(sent[0].route, '/v1/sessions/31/permission-denials');
  assert.equal(sent[0].method, 'POST');
  assert.equal(body(sent[0]).ferramenta, 'WebFetch');
  assert.equal(body(sent[1]).ferramenta, 'Bash(curl *)');
  assert.deepEqual(body(sent[0]).ator, { tipo: 'sistema', ref: 'runner' });
  assert.equal(body(sent[0]).recurso, 'rede');
  assert.equal(body(sent[0]).motivo, DENIAL.motivo);
  assert.equal(reporter.failure, null);
});

test('AT13 — a denial recorded after the session exists goes out straight away', async () => {
  const { PermissionDenialReporter } = await loadReport();
  const { sent, call } = recorder();

  const reporter = new PermissionDenialReporter(call);
  reporter.bindSession(31);
  reporter.record(DENIAL);
  await reporter.drain();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/sessions/31/permission-denials');
});

test('AT14 — a refused denial is captured, never thrown, and the first one is kept', async () => {
  const { PermissionDenialReporter } = await loadReport();
  const refusal = new Error('the control plane refused the first denial');
  const { call } = refuser('permission-denials', refusal);

  const reporter = new PermissionDenialReporter(call);
  reporter.bindSession(31);
  reporter.record(DENIAL);
  reporter.record({ ...DENIAL, ferramenta: 'Bash(curl *)' });

  // The whole contract in one line: a telemetry write that could not be made
  // may not take the dispatch down with it, and may not become an unhandled
  // rejection either.
  await reporter.drain();

  assert.equal(reporter.failure, refusal);
});

/* -- the closure ------------------------------------------------------------ */

test('AT15 — `finishSession` sends the three absent fields as null, never omitted', async () => {
  const { finishSession, TAXONOMY_STATUS } = await loadReport();
  const { sent, call } = recorder();

  const failure = await finishSession(
    call,
    31,
    { status: 'completed', exitCode: 0 },
    'linha um\nlinha dois',
  );

  assert.equal(failure, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/sessions/31/finish');
  assert.equal(sent[0].method, 'PATCH');

  const posted = body(sent[0]);
  assert.equal(posted.status, TAXONOMY_STATUS.completed);
  assert.equal(posted.exit_code, 0);
  assert.equal(posted.transcricao, 'linha um\nlinha dois');

  for (const field of ['timeout_reason', 'uso', 'modelos']) {
    assert.ok(field in posted, `\`${field}\` has to be SENT, not omitted`);
    assert.equal(posted[field], null, `\`${field}\` is null, never zeroed`);
  }
});

test('AT16 — `finishSession` ships what the engine did report', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = recorder();

  await finishSession(
    call,
    31,
    {
      status: 'timed_out',
      exitCode: 143,
      timeoutReason: 'silence',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5,
      },
      models: ['claude-opus-4'],
    },
    '',
  );

  const posted = body(sent[0]);
  assert.equal(posted.status, 'tempo_esgotado');
  assert.equal(posted.exit_code, 143);
  assert.equal(posted.timeout_reason, 'silence');
  assert.deepEqual(posted.uso, {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  });
  assert.deepEqual(posted.modelos, ['claude-opus-4']);
});

test('AT17 — a refused closure is given back, not thrown', async () => {
  const { finishSession } = await loadReport();
  const refusal = new Error('the control plane refused the closure');
  const { call } = refuser('finish', refusal);

  const failure = await finishSession(call, 31, { status: 'failed', exitCode: 1 }, '');

  assert.equal(failure, refusal);
});

/* -- the ordinary question the session itself wrote ------------------------- */

test('AT18 — `postSessionQuestion` posts as the AGENT, with the node as its ref', async () => {
  const { postSessionQuestion } = await loadReport();
  const { sent, call } = recorder();

  await postSessionQuestion(call, JOB, 31, {
    question: 'Renumerar a migração para 0003?',
    context: 'A t101 corre em paralelo.',
    options: ['Renumerar', 'Manter'],
    recommendation: 'Manter 0002.',
    default: 'Manter 0002',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/input-requests');

  const posted = body(sent[0]);
  assert.equal(posted.trabalho_id, JOB.id);
  assert.equal(posted.sessao_id, 31);
  assert.equal(posted.pergunta, 'Renumerar a migração para 0003?');
  assert.equal(posted.contexto, 'A t101 corre em paralelo.');
  assert.deepEqual(posted.opcoes, ['Renumerar', 'Manter']);
  assert.equal(posted.recomendacao, 'Manter 0002.');
  assert.equal(posted.resposta_padrao, 'Manter 0002');
  assert.equal(posted.auto_aprovavel, true);
  assert.deepEqual(posted.ator, { tipo: 'agente', ref: 'revisao' });
});

test('AT19 — a question from a work standing on no node is signed `sessao`', async () => {
  const { postSessionQuestion } = await loadReport();
  const { sent, call } = recorder();

  await postSessionQuestion(call, { id: 7, current_node_id: '' }, 31, {
    question: 'E agora?',
  });

  const posted = body(sent[0]);
  assert.deepEqual(posted.ator, { tipo: 'agente', ref: 'sessao' });
  assert.equal(posted.contexto, null);
  assert.equal(posted.opcoes, null);
  assert.equal(posted.recomendacao, null);
  assert.equal(posted.resposta_padrao, null);
});
