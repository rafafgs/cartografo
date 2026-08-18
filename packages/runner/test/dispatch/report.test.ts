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
 * cheaply, which is why `finish` shipped `usage: null` hardcoded for eleven
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

/**
 * A fake `call` that records every request and answers all of them the same.
 *
 * The third client of this file, and the first one whose ANSWER matters (t268):
 * every write before this ficha was told-and-forgotten, so `recorder` handing
 * back `undefined` was the whole truth. The closure now reads a verdict off the
 * response it gets, and a body is the only way to pin what it does with one.
 */
function answering(answer: unknown): { sent: Sent[]; call: ControlPlaneCall } {
  const sent: Sent[] = [];
  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    sent.push({ route, method, body });
    return answer as T;
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
    to_node_id: 'entrega',
    actor: { type: 'system', ref: 'runner' },
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
    reason: 'Este nó não tem a quem perguntar.',
    actor: { type: 'system', ref: 'runner' },
  });
});

test('AT3 — `blockForUncommittedWork` names the tree that was retained', async () => {
  const { blockForUncommittedWork } = await loadReport();
  const { sent, call } = recorder();

  await blockForUncommittedWork(call, JOB, '/tmp/worktrees/job-7');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');

  const reason = body(sent[0]).reason;
  assert.equal(typeof reason, 'string');
  assert.ok((reason as string).includes('/tmp/worktrees/job-7'));
  assert.ok((reason as string).includes(JOB.current_node_id));
  assert.deepEqual(body(sent[0]).actor, { type: 'system', ref: 'runner' });
});

/**
 * The sixth block of `blocks.ts`, and the first one about a checkout nobody
 * opened a session in (t273, AT2).
 *
 * It stops the work when the shared test bench could not be advanced onto the
 * commit an accepted report named: the fast-forward was refused, the bench was
 * on another branch, or the bench-install command exited non-zero. The reason is
 * COMPOSED here, out of the detail the step handed over, exactly as
 * `blockForUncommittedWork` composes its own — a helper taking a ready-made
 * string would make "the bench is stale" indistinguishable from "the tree was
 * dirty" at the call site.
 */
test('t273 AT2 — `blockForMainLineAdvanceFailure` names the job and the reason it was given', async () => {
  const { blockForMainLineAdvanceFailure } = await loadReport();
  const { sent, call } = recorder();

  const returned = await blockForMainLineAdvanceFailure(
    call,
    JOB,
    'the test bench is checked out on `experimento`, not on the main line `main`',
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');
  assert.deepEqual(body(sent[0]).actor, { type: 'system', ref: 'runner' });

  const reason = String(body(sent[0]).reason);
  assert.ok(reason.includes('experimento'), `the detail it was given is quoted: ${reason}`);
  assert.ok(reason.includes(JOB.current_node_id), `and the node it stopped on: ${reason}`);
  assert.equal(
    returned,
    reason,
    'the runner may not tell the API one story and its caller another',
  );
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
  assert.equal(posted.job_id, JOB.id);
  assert.equal(posted.session_id, 31);
  assert.equal(posted.kind, 'question');
  assert.deepEqual(posted.options, ['aprovado', 'retrabalho']);
  assert.equal(posted.auto_approvable, true);
  assert.deepEqual(posted.actor, { type: 'system', ref: 'runner' });
  assert.ok(String(posted.question).includes('"escala"'));
  assert.ok(String(posted.context).includes('entrega'));
  assert.ok(String(posted.context).includes('desenvolvimento'));
});

test('AT5 — with no result observed at all the question says so', async () => {
  const { escalateRouting } = await loadReport();
  const { sent, call } = recorder();

  await escalateRouting(call, JOB, 31, TWO_EDGES, null, 'always');

  assert.ok(String(body(sent[0]).question).includes('nenhum'));
});

test('AT6 — under `never` it blocks instead, and posts no question at all', async () => {
  const { escalateRouting } = await loadReport();
  const { sent, call } = recorder();

  await escalateRouting(call, JOB, 31, TWO_EDGES, 'escala', 'never');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.ok(!sent.some((request) => request.route === '/v1/input-requests'));
  assert.ok(String(body(sent[0]).reason).includes('não tem a quem perguntar'));
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
  assert.deepEqual(body(sent[0]).to_node_id, 'entrega');
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
  assert.equal(body(sent[0]).to_node_id, 'desenvolvimento');
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
  assert.equal(body(sent[0]).tool, 'WebFetch');
  assert.equal(body(sent[1]).tool, 'Bash(curl *)');
  assert.deepEqual(body(sent[0]).actor, { type: 'system', ref: 'runner' });
  assert.equal(body(sent[0]).resource, 'network');
  assert.equal(body(sent[0]).reason, DENIAL.motivo);
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

  const verdict = await finishSession(
    call,
    31,
    { status: 'completed', exitCode: 0 },
    'linha um\nlinha dois',
  );

  assert.equal(verdict.failure, null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/sessions/31/finish');
  assert.equal(sent[0].method, 'PATCH');

  const posted = body(sent[0]);
  assert.equal(posted.status, TAXONOMY_STATUS.completed);
  assert.equal(posted.exit_code, 0);
  assert.equal(posted.transcript, 'linha um\nlinha dois');

  for (const field of ['timeout_reason', 'usage', 'models']) {
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
  assert.equal(posted.status, 'timed_out');
  assert.equal(posted.exit_code, 143);
  assert.equal(posted.timeout_reason, 'silence');
  assert.deepEqual(posted.usage, {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  });
  assert.deepEqual(posted.models, ['claude-opus-4']);
});

/**
 * The node's own structured report, and the difference between absent and null
 * (t259).
 *
 * `session.output` has existed since t253 and had no producer: the runner
 * printed a session's `` ```resultado `` block, read one field off it for
 * routing and threw the rest away. Now the parsed payload rides on the closure
 * — and the KEY is omitted when there is none, because the control plane
 * distinguishes "nothing was reported" from "a report the skill's schema
 * refused" and both of those are stored as a NULL row
 * (`packages/core/src/repositories/session.ts`). Sending `null` from here would
 * claim the second when only the first happened.
 */
test('t259 AT4 — `finishSession` ships the structured report when there is one', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = recorder();

  const reported = { resultado: 'aprovado', outcome: 'pass', evidencia: 'li a saída inteira' };
  await finishSession(call, 31, { status: 'completed', exitCode: 0 }, 'bruto', reported);

  const posted = body(sent[0]);
  assert.deepEqual(posted.output, reported);
  assert.equal(posted.transcript, 'bruto', 'and the raw stream is untouched by it');
});

test('t259 AT4 — ...and omits the key entirely when there is none', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = recorder();

  await finishSession(call, 31, { status: 'completed', exitCode: 0 }, 'bruto');

  assert.ok(
    !('output' in body(sent[0])),
    '`output` is OMITTED and never sent as null — the two are different facts',
  );
});

test('AT17 — a refused closure is given back, not thrown', async () => {
  const { finishSession } = await loadReport();
  const refusal = new Error('the control plane refused the closure');
  const { call } = refuser('finish', refusal);

  const verdict = await finishSession(call, 31, { status: 'failed', exitCode: 1 }, '');

  assert.equal(verdict.failure, refusal);
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
  assert.equal(posted.job_id, JOB.id);
  assert.equal(posted.session_id, 31);
  assert.equal(posted.question, 'Renumerar a migração para 0003?');
  assert.equal(posted.context, 'A t101 corre em paralelo.');
  assert.deepEqual(posted.options, ['Renumerar', 'Manter']);
  assert.equal(posted.recommendation, 'Manter 0002.');
  assert.equal(posted.default_answer, 'Manter 0002');
  assert.equal(posted.auto_approvable, true);
  assert.deepEqual(posted.actor, { type: 'agent', ref: 'revisao' });
});

/* -- t265: the engine that refused before answering ------------------------- */

/**
 * The two fields a refused session adds to the closure, and the block that
 * follows it (t265, AT3).
 *
 * A refusal is deterministic — it reproduced four times in a row against the
 * same prompt in t198 — so it stops the work on its FIRST occurrence instead of
 * riding the consecutive-failure cap. What travels on `/finish` is the fact
 * itself, in the same present-and-null posture `timeout_reason`/`usage`/`models`
 * already have; what stops the work is a block of the runner own account, the
 * fourth in this module and signed like the other three.
 */
test('t265 AT3 — `finishSession` sends the two refusal fields as null when there are none', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = recorder();

  await finishSession(call, 31, { status: 'completed', exitCode: 0 }, 'bruto');

  const posted = body(sent[0]);
  for (const field of ['failure_kind', 'refusal_category']) {
    assert.ok(field in posted, `\`${field}\` has to be SENT, not omitted`);
    assert.equal(posted[field], null, `\`${field}\` is null when the adapter reported none`);
  }
});

test('t265 AT3 — `finishSession` ships the refusal the adapter reported', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = recorder();

  await finishSession(
    call,
    31,
    {
      status: 'failed',
      exitCode: 1,
      failureKind: 'engine_refusal',
      refusalCategory: 'reasoning_extraction',
    },
    '',
  );

  const posted = body(sent[0]);
  assert.equal(posted.status, 'failed', 'a refusal is a failed session with a cause beside it');
  assert.equal(posted.failure_kind, 'engine_refusal');
  assert.equal(posted.refusal_category, 'reasoning_extraction');
});

test('t265 AT3 — `blockForEngineRefusal` names the node and the category it was given', async () => {
  const { blockForEngineRefusal } = await loadReport();
  const { sent, call } = recorder();

  await blockForEngineRefusal(call, JOB, 'reasoning_extraction');

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');

  const reason = body(sent[0]).reason;
  assert.equal(typeof reason, 'string');
  assert.ok((reason as string).includes(JOB.current_node_id), `the node is missing from: ${String(reason)}`);
  assert.ok(
    (reason as string).includes('reasoning_extraction'),
    `the category is missing from: ${String(reason)}`,
  );
  assert.deepEqual(body(sent[0]).actor, { type: 'system', ref: 'runner' });
});

test('t265 AT3 — ...and still blocks when the engine named no category', async () => {
  const { blockForEngineRefusal } = await loadReport();
  const { sent, call } = recorder();

  await blockForEngineRefusal(call, JOB, undefined);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  const reason = body(sent[0]).reason;
  assert.equal(typeof reason, 'string');
  assert.ok((reason as string).includes(JOB.current_node_id));
});

test('AT19 — a question from a work standing on no node is signed `sessao`', async () => {
  const { postSessionQuestion } = await loadReport();
  const { sent, call } = recorder();

  await postSessionQuestion(call, { id: 7, current_node_id: '' }, 31, {
    question: 'E agora?',
  });

  const posted = body(sent[0]);
  assert.deepEqual(posted.actor, { type: 'agent', ref: 'sessao' });
  assert.equal(posted.context, null);
  assert.equal(posted.options, null);
  assert.equal(posted.recommendation, null);
  assert.equal(posted.default_answer, null);
});

/* -- t268: the report the control plane refused ----------------------------- */

/**
 * The verdict that rides back on the closure, and the block that reads it
 * (t268, FR4/FR5).
 *
 * `PATCH /finish` has validated a reported `output` against the pinned skill's
 * own schema since t253, and stored `null` plus the reasons when it refused —
 * but the answer went nowhere: the runner discarded everything but the write
 * failure and then routed the job from its OWN parse of the same block. So a
 * report core rejected still moved the work along an edge, which is gap 2 of
 * `notas/2026-08-17-segunda-execucao-bets.md`.
 *
 * The verdict is read off the one response that carries it, and it is a
 * three-state answer on purpose: `true` accepted, `false` refused, and
 * `undefined` for "there was no response to read". Only `false` stops a job —
 * an unreachable control plane is already the write failure beside it, and
 * inventing a refusal out of it would stop work over a network hiccup.
 */
test('t268 AT — `finishSession` reads the accepted verdict off the /finish response', async () => {
  const { finishSession } = await loadReport();
  const { sent, call } = answering({ id: 31, status: 'completed', output_accepted: true });

  const verdict = await finishSession(call, 31, { status: 'completed', exitCode: 0 }, 'bruto', {
    nota: 'a etapa deixou saida.md pronto',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/sessions/31/finish');
  assert.equal(verdict.failure, null);
  assert.equal(verdict.outputAccepted, true);
  assert.equal(
    verdict.outputSchemaError,
    undefined,
    'nothing was refused, so there is no reason to carry',
  );
});

test('t268 AT — ...and the refusal, with every reason the control plane gave', async () => {
  const { finishSession } = await loadReport();
  const problems = [
    "output must have required property 'nota'",
    'output must NOT have additional properties',
  ];
  const { call } = answering({
    id: 31,
    status: 'completed',
    output: null,
    output_accepted: false,
    output_schema_error: problems,
  });

  const verdict = await finishSession(call, 31, { status: 'completed', exitCode: 0 }, 'bruto', {
    resultado: 'aprovado',
  });

  assert.equal(verdict.failure, null, 'a refused REPORT is not a refused write');
  assert.equal(verdict.outputAccepted, false);
  assert.deepEqual(
    verdict.outputSchemaError,
    problems,
    'every reason, never only the first — the block quotes them all',
  );
});

test('t268 AT — a closure the control plane refused answers no verdict at all', async () => {
  const { finishSession } = await loadReport();
  const refusal = new Error('the control plane refused the closure');
  const { call } = refuser('finish', refusal);

  const verdict = await finishSession(call, 31, { status: 'completed', exitCode: 0 }, '');

  assert.equal(verdict.failure, refusal);
  assert.equal(
    verdict.outputAccepted,
    undefined,
    'there was no response to read, and undefined is not false: only false stops a job',
  );
  assert.equal(verdict.outputSchemaError, undefined);
});

test('t268 AT — `blockForOutputSchemaRefusal` names the node, the session and every problem', async () => {
  const { blockForOutputSchemaRefusal } = await loadReport();
  const { sent, call } = recorder();
  const problems = [
    "output must have required property 'nota'",
    'output must NOT have additional properties',
  ];

  const reason = await blockForOutputSchemaRefusal(call, JOB, 41, problems);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].route, '/v1/jobs/7/blocks');
  assert.equal(sent[0].method, 'POST');

  const posted = body(sent[0]);
  assert.equal(
    posted.reason,
    reason,
    'the runner may not tell the API one story and its caller another',
  );
  const text = String(posted.reason);
  assert.ok(text.includes(JOB.current_node_id), `the node is missing from: ${text}`);
  assert.ok(text.includes('41'), `the session is what a reader opens next: ${text}`);
  for (const problem of problems) {
    assert.ok(text.includes(problem), `missing "${problem}" from: ${text}`);
  }
  assert.deepEqual(posted.actor, { type: 'system', ref: 'runner' });
});
