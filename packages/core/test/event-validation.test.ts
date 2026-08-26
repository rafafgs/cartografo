/**
 * Unit tests of the validator's own non-empty-string rule (t157, FR5).
 *
 * `src/db/event-validation.ts` adds a rule the JSON schemas of
 * `specs/events/schemas/` do not declare: a `string` field cannot be
 * the empty string. That rule is this file's own contract — and until t157 it
 * applied to scalar strings only, so `changed_fields: ['']` walked into the
 * log while `title: ''` was refused. An internally inconsistent mirror is the
 * drift the header of that file exists to prevent.
 *
 * Since t227 the event-type strings, the envelope keys and the payload keys are
 * the English ones of `docs/spec/glossario-wire.md` §2 — and the last block of
 * this file is the gate on that: the old Portuguese spellings are not accepted
 * "as well", they are unknown.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KNOWN_TYPES,
  ValidationError,
  requireValidData,
  requireValidEvent,
} from '../src/db/event-validation.ts';

/** Asserts that a payload is refused, and that the message names the field. */
function refuses(type: string, data: Record<string, unknown>, field: string): void {
  assert.throws(
    () => requireValidData(type, data),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, `${type} has to fail with a ValidationError`);
      assert.ok(
        error.errors.some((detail) => detail.includes(field)),
        `the errors have to name ${field}: ${JSON.stringify(error.errors)}`,
      );
      return true;
    },
    `${type} accepted ${JSON.stringify(data)}`,
  );
}

test('t157 FR5 — an empty item is refused in a required string-list', () => {
  refuses('job.amended', { changed_fields: [''] }, 'changed_fields');
  refuses('job.amended', { changed_fields: ['title', ''] }, 'changed_fields');
});

test('t157 FR5 — an empty item is refused in an optional string-list too', () => {
  refuses(
    'job.created',
    { title: 'x', entry_node_id: 'y', acceptance_criteria: [''] },
    'acceptance_criteria',
  );
  refuses(
    'input_request.created',
    {
      job_id: 1,
      kind: 'question',
      question: 'which path?',
      options: ['go on', ''],
      auto_approvable: false,
    },
    'options',
  );
});

test('t157 FR5 — the rule is the same one scalar strings already carry', () => {
  refuses('job.created', { title: '', entry_node_id: 'y' }, 'title');
});

test('t157 FR5 — a list of real strings still passes', () => {
  assert.deepEqual(requireValidData('job.amended', { changed_fields: ['title'] }), {
    changed_fields: ['title'],
  });
  assert.deepEqual(
    requireValidData('job.created', {
      title: 'x',
      entry_node_id: 'y',
      acceptance_criteria: ['the note fits on one screen'],
    }),
    {
      title: 'x',
      entry_node_id: 'y',
      body: null,
      acceptance_criteria: ['the note fits on one screen'],
      fields: null,
      tier: null,
    },
  );
  // An absent optional list is still absent, not an empty-item violation.
  assert.deepEqual(requireValidData('job.created', { title: 'x', entry_node_id: 'y' }), {
    title: 'x',
    entry_node_id: 'y',
    body: null,
    acceptance_criteria: null,
    fields: null,
    tier: null,
  });
});

/**
 * t168 — the custom fields a problem class declares, carried by the ticket.
 *
 * A new shape in this mirror (`scalar-map`) and not a reuse of `usage`: that one
 * validates a CLOSED set of four integer totals, while here the keys are
 * whatever the class declared and the values are the three scalars a person can
 * type. What the two do share is the discipline every optional field of this
 * taxonomy follows — absent normalizes to `null`, and `null` is not `{}`.
 */
test('t168 — job.created accepts fields as a map of scalars', () => {
  const filled = {
    premise_source: 'quarterly report 2026Q2, page 12',
    downside: -12.5,
    upside: 40,
    reviewed: true,
  };

  assert.deepEqual(
    requireValidData('job.created', { title: 'x', entry_node_id: 'y', fields: filled }),
    {
      title: 'x',
      entry_node_id: 'y',
      body: null,
      acceptance_criteria: null,
      fields: filled,
      tier: null,
    },
  );

  // An empty map is a legitimate value and survives as itself: "the class
  // declares fields and this ticket filled none" is a statement somebody made,
  // and it is not the same fact as never having been asked.
  assert.deepEqual(
    requireValidData('job.created', { title: 'x', entry_node_id: 'y', fields: {} }).fields,
    {},
  );
});

test('t168 — a job born with no declared field records null, never an empty map', () => {
  assert.equal(
    requireValidData('job.created', { title: 'x', entry_node_id: 'y' }).fields,
    null,
  );
});

test('t168 — a non-scalar entry in fields is refused', () => {
  for (const broken of [
    { premise_source: { page: 12 } },
    { downside: [12] },
    { premise_source: null },
    ['premise_source'],
    'premise_source=x',
  ]) {
    refuses('job.created', { title: 'x', entry_node_id: 'y', fields: broken }, 'fields');
  }
});

/** Everything `session.opened` requires, so a case only has to vary its own field. */
const OPEN_SESSION = Object.freeze({
  engine: 'claude-code',
  working_dir: '/tmp/cartografo',
  prompt: 'do something and report what happened',
});

test('t163 — session.opened accepts the silence budget, and absent reads as null', () => {
  assert.equal(
    requireValidData('session.opened', { ...OPEN_SESSION, silence_seconds: 900 }).silence_seconds,
    900,
  );
  // Zero is a legitimate measurement here, exactly as it is for `timeout_seconds`:
  // the schema's floor is 0, and "no policy" is expressed by absence, not by a
  // number. What a non-positive DECLARED budget means is `resolveBudget`'s
  // business, one layer up, and not this contract's.
  assert.equal(
    requireValidData('session.opened', { ...OPEN_SESSION, silence_seconds: 0 }).silence_seconds,
    0,
  );
  assert.equal(
    requireValidData('session.opened', { ...OPEN_SESSION }).silence_seconds,
    null,
    'an absent budget is a session that declares no policy, never a zero',
  );
  refuses('session.opened', { ...OPEN_SESSION, silence_seconds: -1 }, 'silence_seconds');
  refuses('session.opened', { ...OPEN_SESSION, silence_seconds: '900' }, 'silence_seconds');
});

test('t163 — session.finished accepts the two watchdog causes and nothing else', () => {
  for (const reason of ['wall_clock', 'silence']) {
    assert.equal(
      requireValidData('session.finished', { status: 'timed_out', timeout_reason: reason })
        .timeout_reason,
      reason,
    );
  }
  assert.equal(
    requireValidData('session.finished', { status: 'completed' }).timeout_reason,
    null,
    'a session that did not run a watchdog out has no cause to report',
  );
  refuses(
    'session.finished',
    { status: 'timed_out', timeout_reason: 'stuck' },
    'timeout_reason',
  );
});

/* -------------------------------------------------------------------------- */
/* t227 / AT4 — the wire vocabulary of the log is English, and only English.    */
/* -------------------------------------------------------------------------- */

/** A whole envelope in the new vocabulary, so a case only varies its own field. */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'job.created',
    project_id: 1,
    execution_id: 7,
    entity: { type: 'job', id: 101 },
    actor: { type: 'user', ref: 'rafael' },
    occurred_at: '2026-08-17T09:00:00Z',
    data: { title: 'x', entry_node_id: 'entrada' },
    ...overrides,
  };
}

/** Asserts that a whole envelope is refused, and that the message names `field`. */
function refusesEvent(input: Record<string, unknown>, field: string): void {
  assert.throws(
    () => requireValidEvent(input),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, 'the envelope has to fail with a ValidationError');
      assert.ok(
        error.errors.some((detail) => detail.includes(field)),
        `the errors have to name ${field}: ${JSON.stringify(error.errors)}`,
      );
      return true;
    },
    `the envelope ${JSON.stringify(input)} was accepted`,
  );
}

test('t196 AT9 — the catalogue is the 20 type names of the taxonomy, in its order', () => {
  assert.deepEqual(
    [...KNOWN_TYPES],
    [
      'job.created',
      'job.transitioned',
      'job.blocked',
      'job.unblocked',
      'job.amended',
      'job.dependency_declared',
      'job.hook_failed',
      'session.opened',
      'session.finished',
      'session.permission_denied',
      'input_request.created',
      'input_request.answered',
      'input_request.auto_resolved',
      'lease.granted',
      'lease.expired',
      'graph_version.registered',
      'graph_version.applied',
      'graph_version.reverted',
      // The twentieth type, and the fourth of this group (t283): a version's
      // contract state moving, which only ever happens on the re-check a newly
      // registered manifest triggers. It sits inside the graph_version run for
      // the same reason as the three above it — the taxonomy groups by entity.
      'graph_version.contracts_checked',
      // The sixth group, and the nineteenth type: the control plane declaring a
      // round over (D21, t245). It is last here because it is last in the
      // taxonomy's own catalogue, which is what this assertion mirrors.
      'execution.finished',
    ],
  );
});

test('t227 AT4 — a whole envelope in the new vocabulary is accepted', () => {
  const event = requireValidEvent(envelope());

  assert.equal(event.type, 'job.created');
  assert.equal(event.project_id, 1);
  assert.equal(event.execution_id, 7);
  assert.deepEqual(event.entity, { type: 'job', id: 101 });
  assert.deepEqual(event.actor, { type: 'user', ref: 'rafael' });
  assert.equal(event.occurred_at, '2026-08-17T09:00:00Z');
  assert.equal(event.data.title, 'x');
  assert.equal(event.data.entry_node_id, 'entrada');
});

test('t227 AT4 — every entity and actor type of §2.3 is the English one', () => {
  const payloads: Record<string, Record<string, unknown>> = {
    'job.created': { title: 'x', entry_node_id: 'entrada' },
    'session.opened': { engine: 'claude-code', working_dir: '/tmp', prompt: 'p' },
    'input_request.created': { job_id: 1, kind: 'question', question: 'q?', auto_approvable: false },
  };

  for (const [type, entity] of [
    ['job.created', 'job'],
    ['session.opened', 'session'],
    ['input_request.created', 'input_request'],
  ]) {
    refusesEvent(
      envelope({ type, entity: { type: 'trabalho', id: 1 }, data: payloads[type] }),
      'entity.type',
    );
    const accepted = requireValidEvent(
      envelope({ type, entity: { type: entity, id: 1 }, data: payloads[type] }),
    );
    assert.equal(accepted.entity.type, entity);
  }

  for (const actor of ['user', 'agent', 'system']) {
    assert.equal(
      requireValidEvent(envelope({ actor: { type: actor, ref: 'r' } })).actor.type,
      actor,
    );
  }
  for (const actor of ['usuario', 'agente', 'sistema']) {
    refusesEvent(envelope({ actor: { type: actor, ref: 'r' } }), 'actor.type');
  }
});

test('t227 AT4 — the old Portuguese type names are unknown, not aliases', () => {
  for (const type of [
    'trabalho.criado',
    'trabalho.transicao',
    'trabalho.bloqueado',
    'trabalho.desbloqueado',
    'trabalho.emendado',
    'trabalho.dependencia_declarada',
    'trabalho.gancho_falhou',
    'sessao.aberta',
    'sessao.finalizada',
    'sessao.permissao_negada',
    'pergunta.criada',
    'pergunta.respondida',
    'pergunta.auto_resolvida',
  ]) {
    assert.ok(!KNOWN_TYPES.includes(type), `"${type}" is still in the catalogue`);
    assert.throws(
      () => requireValidData(type, {}),
      ValidationError,
      `requireValidData still knows "${type}"`,
    );
    refusesEvent(envelope({ type }), 'unknown type');
  }
});

test('t227 AT4 — the old Portuguese envelope keys do not exist any more', () => {
  for (const key of [
    'tipo',
    'projeto_id',
    'execucao_id',
    'entidade',
    'ator',
    'ocorrido_em',
    'dados',
  ]) {
    refusesEvent(
      { ...envelope(), [key]: 'whatever it may be' },
      `${key} does not exist in the envelope`,
    );
  }
  refusesEvent(envelope({ entity: { tipo: 'job', id: 1 } }), 'entity.tipo does not exist');
  refusesEvent(envelope({ actor: { tipo: 'user', ref: 'r' } }), 'actor.tipo does not exist');
});

test('t227 AT4 — the old Portuguese payload keys are outside every contract', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['job.created', { titulo: 'x', no_entrada_id: 'y' }, 'titulo'],
    ['job.transitioned', { para_no_id: 'x' }, 'para_no_id'],
    ['job.blocked', { motivo: 'x' }, 'motivo'],
    ['job.amended', { campos_alterados: ['x'] }, 'campos_alterados'],
    ['job.dependency_declared', { depende_de_trabalho_id: 1 }, 'depende_de_trabalho_id'],
    ['job.hook_failed', { gancho_id: 'g', no_id: 'n', url: 'u', ultimo_erro: 'e' }, 'gancho_id'],
    [
      'session.opened',
      { engine: 'e', working_dir: 'w', prompt: 'p', trabalho_id: 1 },
      'trabalho_id',
    ],
    // A REAL value, not `null`: `validateData` tolerates an explicit null on an
    // undeclared key (it reads as "absent"), so a `uso: null` here would prove
    // nothing about the key having been renamed.
    [
      'session.finished',
      {
        status: 'completed',
        uso: {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      'uso',
    ],
    ['session.permission_denied', { recurso: 'network', ferramenta: 'W', motivo: 'm' }, 'recurso'],
    ['input_request.created', { trabalho_id: 1 }, 'trabalho_id'],
    ['input_request.answered', { resposta: 'a', respondido_por: 'r' }, 'resposta'],
    ['input_request.auto_resolved', { resposta: 'a', baseada_em: 'recommendation' }, 'resposta'],
  ];

  for (const [type, data, key] of cases) {
    refuses(type, data, key);
  }
});

test('t227 AT4 / FR5 — the four enum-valued payload fields carry English values', () => {
  for (const status of [
    'completed',
    'failed',
    'stuck',
    'timed_out',
    'quota_paused',
    'resume_failed',
  ]) {
    assert.equal(requireValidData('session.finished', { status }).status, status);
  }
  for (const status of [
    'concluida',
    'falhou',
    'travada',
    'tempo_esgotado',
    'pausada_cota',
    'retomada_falhou',
  ]) {
    refuses('session.finished', { status }, 'status');
  }

  const denial = { tool: 'WebFetch', reason: 'no permission' };
  for (const resource of ['filesystem', 'network']) {
    assert.equal(
      requireValidData('session.permission_denied', { ...denial, resource }).resource,
      resource,
    );
  }
  refuses('session.permission_denied', { ...denial, resource: 'rede' }, 'resource');

  const asked = { job_id: 1, question: 'q?', auto_approvable: false };
  for (const kind of ['question', 'approval']) {
    assert.equal(requireValidData('input_request.created', { ...asked, kind }).kind, kind);
  }
  for (const kind of ['pergunta', 'aprovacao']) {
    refuses('input_request.created', { ...asked, kind }, 'kind');
  }

  for (const basis of ['recommendation', 'default_answer', 'precedent']) {
    assert.equal(
      requireValidData('input_request.auto_resolved', { answer: 'a', based_on: basis }).based_on,
      basis,
    );
  }
  for (const basis of ['recomendacao', 'resposta_padrao', 'precedente']) {
    refuses('input_request.auto_resolved', { answer: 'a', based_on: basis }, 'based_on');
  }
});

/**
 * The wire learns the second failure kind (t296, AT1/FR1).
 *
 * A quota refusal and a crash are one word — `failed` — with two different
 * answers: a crash is worth another attempt right now, and an account that hit
 * its own limit will refuse the next three the same way, in twenty seconds, for
 * free (`notes/2026-08-18-n3-round.md`, hole 1). The kind is what tells them
 * apart, and it travels in exactly the shape t265 built for the refusal.
 *
 * Which makes this file the FIRST gate on it: `PATCH /finish` calls
 * `requireValidData` before it writes anything, so a `failure_kind` this list
 * does not carry is a `400` and the adapter's whole reading is lost on the way
 * in. Widening the list is the one change this ticket makes here — `status` is
 * untouched on purpose (the frozen `SessionStatus` is a decision, not an
 * oversight: `docs/formats/engine-adapter.md`, "Rejected — a richer
 * `SessionStatus`"), and no cross-field rule is added, because
 * `timeout_reason` next door has never had one either.
 *
 * The set stays CLOSED, which is the half that is easy to lose while widening
 * it: this word is ours, and a second value entered because a second kind of
 * failure was measured — not because an engine invented one.
 */
test('t296 AT1 — `failure_kind` carries the quota refusal, and still refuses the rest', () => {
  for (const kind of ['engine_refusal', 'quota']) {
    assert.equal(
      requireValidData('session.finished', { status: 'failed', failure_kind: kind }).failure_kind,
      kind,
      `\`${kind}\` is a kind this system measured and declared`,
    );
  }

  for (const invented of ['engine_crash', 'cota', 'quota_paused', '']) {
    refuses('session.finished', { status: 'failed', failure_kind: invented }, 'failure_kind');
  }

  assert.equal(
    requireValidData('session.finished', { status: 'failed' }).failure_kind,
    null,
    'absence is still absence: a session that reported no kind records none',
  );
});

/* -------------------------------------------------------------------------- */
/* t196 — the five types the taxonomy declared and nobody recorded.            */
/*                                                                             */
/* The mirror is the contract: a payload the schemas of                        */
/* `specs/events/schemas/` accept has to pass here, and one they      */
/* refuse has to fail here. These cases are the fields that carry the join —    */
/* `graph_id`, `target_version`, the lease's own runner — plus the two closed   */
/* enums, which are the only vocabulary of the five that a caller can get       */
/* wrong in a way no shape check would catch.                                   */
/* -------------------------------------------------------------------------- */

test('t196 AT9 — the graph_version payloads demand what their schemas require', () => {
  assert.deepEqual(
    requireValidData('graph_version.registered', { graph_id: 'nota-curta', source: 'manual' }),
    { graph_id: 'nota-curta', parent_version: null, source: 'manual', proposal_id: null },
    'the first version of a lineage has no parent and no proposal, and says so explicitly',
  );
  refuses('graph_version.registered', { source: 'manual' }, 'graph_id');
  refuses('graph_version.registered', { graph_id: 'nota-curta' }, 'source');

  assert.deepEqual(requireValidData('graph_version.applied', { graph_id: 'nota-curta' }), {
    graph_id: 'nota-curta',
    proposal_id: null,
  });
  refuses('graph_version.applied', {}, 'graph_id');

  assert.deepEqual(
    requireValidData('graph_version.reverted', {
      graph_id: 'nota-curta',
      target_version: 'sha256:abc',
      reason: 'the rework got worse',
    }),
    { graph_id: 'nota-curta', target_version: 'sha256:abc', reason: 'the rework got worse' },
  );
  for (const missing of ['graph_id', 'target_version', 'reason']) {
    const complete: Record<string, unknown> = {
      graph_id: 'nota-curta',
      target_version: 'sha256:abc',
      reason: 'the rework got worse',
    };
    delete complete[missing];
    refuses('graph_version.reverted', complete, missing);
  }
});

test('t283 — graph_version.contracts_checked demands the state and the count, and nothing else', () => {
  assert.deepEqual(
    requireValidData('graph_version.contracts_checked', { state: 'checked', problem_count: 0 }),
    { state: 'checked', problem_count: 0 },
  );
  assert.deepEqual(
    requireValidData('graph_version.contracts_checked', { state: 'failed', problem_count: 3 }),
    { state: 'failed', problem_count: 3 },
  );

  // Both are required: a re-check that does not say where the version landed,
  // or over how many problems, records nothing the row does not already say.
  refuses('graph_version.contracts_checked', { problem_count: 0 }, 'state');
  refuses('graph_version.contracts_checked', { state: 'checked' }, 'problem_count');

  // The vocabulary is ours, so the set closes — the same call `tier` makes.
  refuses('graph_version.contracts_checked', { state: 'skipped', problem_count: 0 }, 'state');
  refuses('graph_version.contracts_checked', { state: 'checked', problem_count: -1 }, 'problem_count');
  refuses(
    'graph_version.contracts_checked',
    { state: 'checked', problem_count: 0, graph_id: 'nota-curta' },
    'graph_id',
  );
});

test('t196 AT9 — the lease payloads demand what their schemas require', () => {
  const granted = { job_id: 101, runner_id: 'runner-a', expires_at: '2026-08-17T13:00:00Z' };
  assert.deepEqual(requireValidData('lease.granted', granted), granted);
  for (const missing of Object.keys(granted)) {
    const partial: Record<string, unknown> = { ...granted };
    delete partial[missing];
    refuses('lease.granted', partial, missing);
  }

  assert.deepEqual(
    requireValidData('lease.expired', { runner_id: 'runner-a', reason: 'ttl_elapsed' }),
    { runner_id: 'runner-a', reason: 'ttl_elapsed' },
  );
  refuses('lease.expired', { reason: 'ttl_elapsed' }, 'runner_id');
  refuses('lease.expired', { runner_id: 'runner-a' }, 'reason');
});

test('t196 AT9 — the two closed enums of the new types accept their values and nothing else', () => {
  for (const source of ['synthesizer', 'manual', 'proposal']) {
    assert.equal(
      requireValidData('graph_version.registered', { graph_id: 'g', source }).source,
      source,
    );
  }
  for (const source of ['sintetizador', 'proposta', 'importado']) {
    refuses('graph_version.registered', { graph_id: 'g', source }, 'source');
  }

  for (const reason of ['heartbeat_lost', 'ttl_elapsed']) {
    assert.equal(requireValidData('lease.expired', { runner_id: 'r', reason }).reason, reason);
  }
  for (const reason of ['heartbeat_perdido', 'expirou', 'released']) {
    refuses('lease.expired', { runner_id: 'r', reason }, 'reason');
  }
});

test('t196 AT9 — an event whose entity is not the type\'s own subject is refused', () => {
  const leaseEnvelope = {
    type: 'lease.granted',
    entity: { type: 'graph_version', id: 'sha256:abc' },
    data: { job_id: 1, runner_id: 'runner-a', expires_at: '2026-08-17T13:00:00Z' },
  };
  refusesEvent(envelope(leaseEnvelope), 'entity.type');
  assert.deepEqual(
    requireValidEvent(envelope({ ...leaseEnvelope, entity: { type: 'lease', id: 7001 } })).entity,
    { type: 'lease', id: 7001 },
  );

  const versionEnvelope = {
    type: 'graph_version.applied',
    entity: { type: 'lease', id: 7001 },
    data: { graph_id: 'nota-curta' },
  };
  refusesEvent(envelope(versionEnvelope), 'entity.type');
  // And the id of a graph_version is the snapshot HASH, never an integer (D15).
  refusesEvent(
    envelope({ ...versionEnvelope, entity: { type: 'graph_version', id: 7001 } }),
    'entity.id',
  );
  assert.deepEqual(
    requireValidEvent(
      envelope({ ...versionEnvelope, entity: { type: 'graph_version', id: 'sha256:abc' } }),
    ).entity,
    { type: 'graph_version', id: 'sha256:abc' },
  );
});

/* -------------------------------------------------------------------------- */
/* t253 — session.finished carries the node's structured report.               */
/* -------------------------------------------------------------------------- */

test('t253 FR1 — session.finished round-trips an arbitrary output object', () => {
  const output = { branch: 'ticket-253', files: ['a.ts', 'b.ts'], nested: { ok: true } };

  assert.deepEqual(
    requireValidData('session.finished', { status: 'completed', output }).output,
    output,
    'the SHAPE inside is the skill schema\'s business, not the envelope\'s',
  );
  assert.equal(
    requireValidData('session.finished', { status: 'completed' }).output,
    null,
    'absent and null are the same fact, like usage and models beside it',
  );
  assert.equal(
    requireValidData('session.finished', { status: 'completed', output: null }).output,
    null,
  );
});

test('t253 FR1 — an output that is not an object never enters the log', () => {
  for (const output of ['the note', 42, true, ['a', 'list']]) {
    refuses('session.finished', { status: 'completed', output }, 'output');
  }
});

test('t253 FR4 — output_schema_error is the list of reasons, and never empty', () => {
  const problems = ['data has to have required property texto', 'data must NOT have additional properties'];

  assert.deepEqual(
    requireValidData('session.finished', {
      status: 'completed',
      output: null,
      output_schema_error: problems,
    }).output_schema_error,
    problems,
  );
  assert.equal(
    requireValidData('session.finished', { status: 'completed' }).output_schema_error,
    null,
    'nothing was wrong: the absence normalizes to null like every other optional',
  );
  refuses(
    'session.finished',
    { status: 'completed', output_schema_error: [] },
    'output_schema_error',
  );
  refuses(
    'session.finished',
    { status: 'completed', output_schema_error: 'just one reason' },
    'output_schema_error',
  );
});

/**
 * The verdict the runner reads to decide whether the job may move (t268, FR3).
 *
 * A boolean and not a second list beside `output_schema_error` above: what the
 * dispatch has to know synchronously is only WHETHER the report was taken, and
 * the reasons it was not are already carried, whole, by the field next door.
 * Optional like every other one, so an event written before this ticket still
 * validates — but `finishSession` never leaves it unset, the same discipline
 * `output_schema_error` keeps on the path that raises it.
 */
test('t268 FR3 — output_accepted is a boolean, and false is a measurement', () => {
  assert.equal(
    requireValidData('session.finished', { status: 'completed', output_accepted: true })
      .output_accepted,
    true,
  );
  assert.equal(
    requireValidData('session.finished', {
      status: 'completed',
      output: null,
      output_accepted: false,
      output_schema_error: ['output must have required property texto'],
    }).output_accepted,
    false,
    'false is the refusal itself, and it may never be read as an absence',
  );
  assert.equal(
    requireValidData('session.finished', { status: 'completed' }).output_accepted,
    null,
    'nothing was set: the absence normalizes to null like every other optional',
  );
  for (const value of ['sim', 1]) {
    refuses('session.finished', { status: 'completed', output_accepted: value }, 'output_accepted');
  }
});
