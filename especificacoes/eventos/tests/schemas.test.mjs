// Contract tests for the event schemas (t98, acceptance test 1).
//
// The table below IS the specification: each event type, the entity it
// describes and the fields of the `data` payload (the ones marked optional stay
// out of `required`, but are still declared in `properties`). Any divergence
// between a schema file and this table is an error in the schema, never in the
// test — the table reproduces the "Schema / Data Changes" section of the ficha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SCHEMAS_DIR = fileURLToPath(new URL('../schemas/', import.meta.url));

/** type -> { entity, required, optional } */
export const TABLE = {
  'job.created': {
    entity: 'job',
    required: ['title', 'entry_node_id'],
    // `body` and `acceptance_criteria` came in with the intake (t122): a job
    // can be born carrying content, and the criteria the intake writes are
    // preliminary — the one that has the last word is the `refinar` node.
    // `fields` came in with the per-class custom fields (t168): what the class
    // declares in its own graph, the job carries here. `tier` came in with the
    // cheap triage (t175): how much the job COSTS to run, never which edge it
    // leaves by — the graph stays frozen.
    optional: ['body', 'acceptance_criteria', 'fields', 'tier'],
  },
  'job.transitioned': {
    entity: 'job',
    required: ['to_node_id'],
    optional: ['from_node_id'],
  },
  'job.blocked': {
    entity: 'job',
    // `consecutive_failures` came in with the ceiling on consecutive failures
    // (t265): how many failed sessions in a row, at the same node, raised the
    // flag. Optional because it is the only reason for blocking that has a run
    // behind it — the other four (failure before the session, work left
    // uncommitted, a node with nobody to ask, an ordinary escalation) count
    // nothing, and writing a number there would be inventing a measurement.
    required: ['reason'],
    optional: ['consecutive_failures'],
  },
  'job.unblocked': {
    entity: 'job',
    required: [],
    optional: [],
  },
  'job.amended': {
    entity: 'job',
    required: ['changed_fields'],
    optional: [],
  },
  'job.dependency_declared': {
    entity: 'job',
    required: ['depends_on_job_id'],
    optional: [],
  },
  // The 18th type came in with the hooks declared in the graph (t169): when a
  // hook delivery exhausts its six attempts, the only trace observable outside
  // the deliveries table is this event. The four fields are required for the
  // same reason as those of `session.permission_denied` — without knowing WHICH
  // hook, of WHICH node, to WHICH url and with WHICH error, the incident is not
  // auditable, and this log exists to be audited.
  'job.hook_failed': {
    entity: 'job',
    required: ['hook_id', 'node_id', 'url', 'last_error'],
    optional: [],
  },
  // `silence_seconds` came in with the second watchdog (t163): the session now
  // declares two independent budgets — wall clock and silence — and both are
  // optional for the same reason, absence = no policy of its own.
  'session.opened': {
    entity: 'session',
    required: ['engine', 'working_dir', 'prompt'],
    optional: [
      'job_id',
      'node_id',
      'engine_session_ref',
      'timeout_seconds',
      'silence_seconds',
    ],
  },
  'session.finished': {
    entity: 'session',
    required: ['status'],
    // `timeout_reason` (t163) is what separates our two kinds of stop without
    // growing the `status` enum: both watchdogs end at `timed_out`, and the
    // cause travels in the payload.
    //
    // `models` (t172) is the identity that was missing for the question "cost
    // per model": until here the log said which ENGINE ran
    // (`session.opened.engine`) and never which model. It is a list because one
    // session runs more than one — measured against the real CLI, a single turn
    // gave back two — and collapsing it into "the" model would charge the whole
    // bill to the wrong one.
    //
    // `output` and `output_schema_error` came in with the per-node input
    // projection (t253): `output` is the STRUCTURED result the session reports
    // from the node, with no nested `required` at all, because the shape inside
    // is checked against the skill's own `output` schema (D9) and not against
    // this envelope. When that check refuses, the value is not written and what
    // travels in its place is the list of reasons in `output_schema_error` —
    // never at the cost of recording the session's terminal status, which is
    // the fact nobody can lose.
    //
    // `failure_kind` and `refusal_category` came in with the engine's refusal
    // (t265): `failed` is a single word for two things — a crash, which is
    // worth retrying, and an engine that REFUSED to answer, which reproduces
    // identically on every attempt (measured: four refusals in a row on the
    // same prompt, t198). The kind is closed because the word is ours; the
    // category is open because it is the engine's word, exactly like `models`
    // beside it.
    //
    // `output_accepted` came in with the refused report that moved the job
    // anyway (t268). It is the same fact as `output_schema_error` seen from the
    // acting side: the list says WHY a report was refused and exists only where
    // there was a refusal, and this one says WHETHER it was accepted — written
    // at every close, `true` included when nothing was reported, `false` only
    // when the pinned skill's `output` schema refused. A boolean and not a
    // derivation of the list, because the one who reads it is the runner, in
    // the answer to its own `PATCH /finish`, deciding whether the job moves:
    // there "no reasons" and "not checked" would be the same absence, and the
    // difference between the two is a job travelling down an edge chosen from a
    // report that was never written.
    optional: [
      'exit_code',
      'usage',
      'timeout_reason',
      'failure_kind',
      'refusal_category',
      'models',
      'output',
      'output_schema_error',
      'output_accepted',
    ],
  },
  // The 17th type came in with permission enforcement (t125): every attempt to
  // use a tool the session policy denied becomes telemetry. The three fields
  // are required — a denial without a resource, without a tool or without a
  // reason is not auditable, and this log exists to be audited.
  'session.permission_denied': {
    entity: 'session',
    required: ['resource', 'tool', 'reason'],
    optional: [],
  },
  'input_request.created': {
    entity: 'input_request',
    required: ['job_id', 'kind', 'question', 'auto_approvable'],
    // `node_id` since t167: which node the question came from, stamped by the server.
    optional: ['session_id', 'node_id', 'context', 'options', 'recommendation', 'default_answer'],
  },
  'input_request.answered': {
    entity: 'input_request',
    required: ['answer', 'answered_by'],
    optional: [],
  },
  'input_request.auto_resolved': {
    entity: 'input_request',
    required: ['answer', 'based_on'],
    optional: [],
  },
  'lease.granted': {
    entity: 'lease',
    required: ['job_id', 'runner_id', 'expires_at'],
    optional: [],
  },
  'lease.expired': {
    entity: 'lease',
    required: ['runner_id', 'reason'],
    optional: [],
  },
  'graph_version.registered': {
    entity: 'graph_version',
    required: ['graph_id', 'source'],
    optional: ['parent_version', 'proposal_id'],
  },
  'graph_version.applied': {
    entity: 'graph_version',
    required: ['graph_id'],
    optional: ['proposal_id'],
  },
  'graph_version.reverted': {
    entity: 'graph_version',
    required: ['graph_id', 'target_version', 'reason'],
    optional: [],
  },
  // The 20th type came in with the version's contract state (t283): registering
  // a manifest re-judges every version that pinned it and could not be checked,
  // and each one that moves writes this event. Both fields are required because
  // a re-check that says neither which state it went to nor over how many
  // problems counts nothing the row does not already count better.
  // `problem_count` is a count and not the report: the report is on the row, one
  // GET away.
  'graph_version.contracts_checked': {
    entity: 'graph_version',
    required: ['state', 'problem_count'],
    optional: [],
  },
  // The 19th type came in with D21 (t245): the control plane declares the
  // execution finished, and it is the control plane — it alone (D1) — that
  // asserts that fact. No payload, for the same reason as `job.unblocked`: the
  // envelope's `execution_id`, `entity.id` and `occurred_at` already say which
  // round is meant and when it ended, and one more field would be data repeated
  // inside the event itself.
  'execution.finished': {
    entity: 'execution',
    required: [],
    optional: [],
  },
};

const ENVELOPE = 'envelope.schema.json';

function readSchema(file) {
  const raw = readFileSync(join(SCHEMAS_DIR, file), 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    assert.fail(`${file} is not valid JSON: ${error.message}`);
  }
}

function schemaFiles() {
  return readdirSync(SCHEMAS_DIR)
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
}

test('the directory holds the envelope and one schema per event type', () => {
  const expected = [ENVELOPE, ...Object.keys(TABLE).map((type) => `${type}.schema.json`)].sort();
  assert.deepEqual(schemaFiles(), expected);
});

test('the envelope declares the fields common to every event', () => {
  const envelope = readSchema(ENVELOPE);

  assert.deepEqual(
    [...envelope.required].sort(),
    ['actor', 'data', 'entity', 'execution_id', 'id', 'occurred_at', 'project_id', 'type'],
  );

  assert.equal(envelope.properties.id.type, 'integer');
  assert.equal(envelope.properties.type.type, 'string');
  assert.equal(envelope.properties.project_id.type, 'integer');
  assert.deepEqual([...envelope.properties.execution_id.type].sort(), ['integer', 'null']);
  assert.equal(envelope.properties.occurred_at.format, 'date-time');
  assert.equal(envelope.properties.data.type, 'object');

  const entity = envelope.properties.entity;
  assert.deepEqual([...entity.required].sort(), ['id', 'type']);
  // `execution` came in with D21 (t245): the round became the subject of an
  // event, and its `entity.id` is the `execution_id` itself — an integer, like
  // almost everyone else's here. Migration 0003 and `routes/executions.ts` said
  // the opposite ("there is no execution entity"), and both predate the decision.
  assert.deepEqual(
    [...entity.properties.type.enum].sort(),
    ['execution', 'graph_version', 'input_request', 'job', 'lease', 'session'],
  );
  assert.deepEqual([...entity.properties.id.type].sort(), ['integer', 'string']);

  const actor = envelope.properties.actor;
  assert.deepEqual([...actor.required].sort(), ['ref', 'type']);
  assert.deepEqual([...actor.properties.type.enum].sort(), ['agent', 'system', 'user']);
  assert.equal(actor.properties.ref.type, 'string');
});

for (const [type, spec] of Object.entries(TABLE)) {
  const file = `${type}.schema.json`;

  test(`${file} is valid JSON and extends the envelope`, () => {
    const schema = readSchema(file);
    assert.ok(Array.isArray(schema.allOf), `${file}: the allOf is missing`);
    const refs = schema.allOf.map((sub) => sub.$ref);
    assert.ok(
      refs.some((ref) => typeof ref === 'string' && ref.includes(ENVELOPE)),
      `${file}: no allOf references ${ENVELOPE} (refs: ${JSON.stringify(refs)})`,
    );
  });

  test(`${file} pins properties.type.const to the name of the file`, () => {
    const schema = readSchema(file);
    assert.equal(schema.properties.type.const, type);
  });

  test(`${file} pins the entity of the event`, () => {
    const schema = readSchema(file);
    assert.equal(schema.properties.entity.properties.type.const, spec.entity);
  });

  test(`${file} declares the data fields of the table`, () => {
    const schema = readSchema(file);
    const data = schema.properties.data;

    assert.deepEqual(
      [...data.required].sort(),
      [...spec.required].sort(),
      `${file}: data.required diverges from the table`,
    );
    assert.deepEqual(
      Object.keys(data.properties ?? {}).sort(),
      [...spec.required, ...spec.optional].sort(),
      `${file}: data.properties diverges from the table`,
    );
    assert.equal(
      data.additionalProperties,
      false,
      `${file}: data has to close additionalProperties`,
    );
  });
}

test('t175 — job.created.data.tier closes the set at trivial, standard and null', () => {
  // Structural, like the rest of this directory (`examples.test.mjs` writes the
  // reason down): with no ajv, what gets checked is the DECLARATION — and a
  // declared enum is exactly what separates "accepts the two values and the
  // null" from "accepts any string at all". The table in
  // `src/db/event-validation.ts` is the duplicate the server charges at write
  // time; the two have to move together, and it is the `optional` assertion
  // above that catches the divergence.
  const tier = readSchema('job.created.schema.json').properties.data.properties.tier;

  assert.ok(tier, 'job.created does not declare data.tier');
  assert.deepEqual([...tier.type].sort(), ['null', 'string'], 'null is a valid answer');
  assert.deepEqual(
    [...tier.enum].sort((a, b) => String(a).localeCompare(String(b))),
    ['standard', 'trivial', null].sort((a, b) => String(a).localeCompare(String(b))),
    'the enum closes the set: any other string is refused',
  );
});

test('no schema describes an update or a delete of an event (append-only)', () => {
  for (const file of schemaFiles()) {
    const raw = readFileSync(join(SCHEMAS_DIR, file), 'utf8').toLowerCase();
    for (const forbidden of ['update', 'delete', 'atualiza', 'remove']) {
      assert.ok(
        !raw.includes(forbidden),
        `${file}: mentions "${forbidden}" — the log is append-only, the only operation is insert`,
      );
    }
  }
});

test('taxonomy.md references every schema', () => {
  // The mechanical item of the definition of done. The rest of the document is
  // prose and is checked by human review at the acceptance gate (an exception to
  // the ficha's TDD); "there is a schema with no entry in the catalogue" is not
  // prose.
  const doc = readFileSync(fileURLToPath(new URL('../taxonomy.md', import.meta.url)), 'utf8');
  const missing = schemaFiles().filter((name) => !doc.includes(name));
  assert.deepEqual(missing, [], `schemas with no reference in taxonomy.md: ${missing.join(', ')}`);
});

test('no event type outside the scope of the PoC', () => {
  // `service_class` (urgency) and the proposal events stay outside the PoC
  // (D6/D16). The check is by TYPE NAME, not by vocabulary: citing the
  // topographer in a description is legitimate — it is the consumer of this
  // telemetry.
  const outOfScope = [
    'service_class',
    'proposta.criada',
    'proposta.aprovada',
    'proposta.aplicada',
    'proposta.revertida',
  ];
  for (const file of schemaFiles()) {
    const raw = readFileSync(join(SCHEMAS_DIR, file), 'utf8');
    for (const term of outOfScope) {
      assert.ok(!raw.includes(term), `${file}: contains "${term}", which is outside the scope`);
    }
  }
});
