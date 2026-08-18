/**
 * Validation of the event envelope and of each type's payload (t102, FR3).
 *
 * Mirrors, in TypeScript, the schemas of `especificacoes/eventos/schemas/`. The
 * duplication is deliberate and recorded in the ticket: loading those `.json` at
 * runtime would couple `packages/core` to a path outside the package and pull a
 * generic validator into the control plane's dependency surface, in order to
 * validate ten formats that fit in one table. If the duplicated rule ever turns
 * into a maintenance burden, adopting `ajv` is another ticket's decision — and
 * this file is the only place that changes.
 *
 * No event enters the log without going through here: it is the "no contract, no
 * record" version of D9 applied to telemetry. And the validation happens BEFORE
 * any write, so that an invalid request leaves no trace at all — neither a
 * projection row nor an event.
 *
 * The field names below are the envelope's and the payloads' wire keys, and
 * since t227 they are the English ones of `docs/spec/glossario-wire.md` §2 —
 * D20's second child. The migration columns caught up with D20's FOURTH child
 * (t229): `entity_type`, `actor_type` and `occurred_at` are the column names
 * now. The VALUES inside the first two followed with the FIFTH (t235), which
 * rewrote the `CHECK` of migration `0003` into the envelope's own words — so
 * there is no longer a place where two vocabularies meet, here or in
 * `db/events.ts`.
 */

// The one import this mirror allows itself, and only because the alternative is
// worse: `isScalarMap` is the SAME predicate the intake validator and the
// transition gate apply to `fields` (t168), and a second copy of "what a map of
// scalars is" would be a rule that could drift between the log and the check
// that reads it. `domain/` is pure — no database, no clock — so nothing about
// this direction costs the owner of the connection anything.
import { isScalarMap } from '../domain/custom-fields.ts';
import { isObject } from '../util/is-object.ts';

/** Possible subjects of an event (`envelope.schema.json`). */
export type EntityType =
  | 'job'
  | 'session'
  | 'input_request'
  | 'lease'
  | 'graph_version'
  /**
   * The round itself (D21, t245).
   *
   * The sixth, and the one with no table behind it: `execution_id` is still an
   * opaque grouper and there is still nothing to `SELECT` from. What it has is
   * a FACT — the control plane declaring the round over — and a fact needs a
   * subject. `entity.id` is the `execution_id`, an integer like everybody
   * else's but `graph_version`'s.
   */
  | 'execution';

/** Who caused the event. Parity with flowpilot's `ActorType`. */
export type ActorType = 'user' | 'agent' | 'system';

/** The subject of the event — the join key of telemetry with the rest of the database. */
export interface Entity {
  type: EntityType;
  /**
   * Integer for `job`/`session`/`input_request`/`lease`/`execution` — on the
   * last one it is the `execution_id` itself (t245); string (hash) for
   * `graph_version` (D15).
   */
  id: number | string;
}

/** Who caused the event. */
export interface Actor {
  type: ActorType;
  ref: string;
}

/**
 * An event ready to be written — the whole envelope MINUS the `id`.
 *
 * The `id` is the log order and the only total ordering there is; the server
 * assigns it, and that is why it never appears in the input.
 */
export interface EventToRecord {
  type: string;
  project_id: number;
  execution_id: number | null;
  entity: Entity;
  actor: Actor;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** An event as it exists in the log, already carrying the server's id. */
export interface Event extends EventToRecord {
  id: number;
}

/** Validation result: either the normalized event, or the whole list of errors. */
export type ValidationResult =
  | { valid: true; event: EventToRecord }
  | { valid: false; errors: string[] };

/** Event validation failure. The routes translate it into a 400. */
export class ValidationError extends Error {
  /** Every problem found, not only the first. */
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`invalid event: ${errors.join('; ')}`);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const ENTITY_TYPES: readonly EntityType[] = [
  'job',
  'session',
  'input_request',
  'lease',
  'graph_version',
  'execution',
];

const ACTOR_TYPES: readonly ActorType[] = ['user', 'agent', 'system'];

const ENVELOPE_FIELDS = [
  'type',
  'project_id',
  'execution_id',
  'entity',
  'actor',
  'occurred_at',
  'data',
] as const;

/** How a field of `data` is checked. */
interface FieldRule {
  /** Expected shape of the value. */
  shape:
    | 'string'
    | 'integer'
    | 'boolean'
    | 'string-list'
    | 'usage'
    | 'scalar-map'
    | 'open-object';
  /** Is absent/null accepted? */
  required: boolean;
  /** Closed set of values, when the schema declares an `enum`. */
  values?: readonly string[];
  /** Floor, for non-negative integers (`timeout_seconds`, tokens). */
  min?: number;
  /** Minimum number of items, for lists (`changed_fields` has `minItems: 1`). */
  minItems?: number;
  /** Does the list have to have unique items? */
  unique?: boolean;
}

/** The contract of an event type: who it talks about and what it carries. */
interface TypeRule {
  entity: EntityType;
  fields: Record<string, FieldRule>;
}

const required = (shape: FieldRule['shape'], extra: Partial<FieldRule> = {}): FieldRule => ({
  shape,
  required: true,
  ...extra,
});

const optional = (shape: FieldRule['shape'], extra: Partial<FieldRule> = {}): FieldRule => ({
  shape,
  required: false,
  ...extra,
});

/**
 * The types the control plane emits today, in taxonomy order.
 *
 * A type enters here together with the code that emits it, never before — that
 * is how `job.dependency_declared` arrived, with the intake that declares it
 * (t122). The five `lease.*`/`graph_version.*` ones are the exception that
 * proves the rule: they had a schema, an example and a case in the reference
 * reducer since t98, and no writer at all until t196 wired the repositories that
 * were already producing the facts. The nineteenth, `execution.finished`,
 * arrives the ordinary way again — with the helper in `repositories/job.ts` that
 * detects the end of a round (D21, t245).
 */
const RULES: Record<string, TypeRule> = {
  'job.created': {
    entity: 'job',
    fields: {
      title: required('string'),
      entry_node_id: required('string'),
      // Optional since the intake (t122): a job can be born already carrying
      // content. The criteria recorded here are PRELIMINARY — the node that
      // refines is the one that produces the real ones out of the raw request.
      body: optional('string'),
      acceptance_criteria: optional('string-list'),
      // The fields the CLASS declares in its own graph document (t168). The
      // keys are open on purpose: what may appear here is `custom_fields` of
      // the class's version, and freezing a list in this mirror would mean a
      // release of the control plane per problem class.
      fields: optional('scalar-map'),
      // The cost triage (t175), and the exact opposite openness decision from
      // `fields` above: this vocabulary is OURS, not the class's and not the
      // engine's, so the set closes here. A third value is not new data, it is
      // a mistake by whoever wrote it — the same reasoning `timeout_reason`
      // carries. Absent normalizes to `null` like every optional field of this
      // type, and `null` is "nobody classified this", never "trivial".
      tier: optional('string', { values: ['trivial', 'standard'] }),
    },
  },
  'job.transitioned': {
    entity: 'job',
    fields: {
      from_node_id: optional('string'),
      to_node_id: required('string'),
    },
  },
  'job.blocked': {
    entity: 'job',
    fields: {
      reason: required('string'),
      // How many failed sessions in a row put the flag up (t265). Present ONLY
      // for the block the cap itself triggered: every other reason a job stops —
      // a pre-session failure, uncommitted work, a node with nobody to ask, an
      // ordinary escalation — has no streak behind it, and writing a number
      // there would invent a count nobody measured. Floored at 1 because a block
      // over zero failures is not a cap, it is a bug.
      consecutive_failures: optional('integer', { min: 1 }),
    },
  },
  'job.unblocked': {
    entity: 'job',
    fields: {},
  },
  'job.amended': {
    entity: 'job',
    fields: {
      changed_fields: required('string-list', { minItems: 1, unique: true }),
    },
  },
  'job.dependency_declared': {
    entity: 'job',
    fields: {
      depends_on_job_id: required('integer'),
    },
  },
  // The graph-declared hook that gave up (t169). It is an incident and not an
  // outcome — the same reading as `session.permission_denied`: nothing about the
  // job's traversal changes, and the only reason the type exists is that a hook
  // nobody registered is a hook nobody is polling. Every field is required
  // because a failure that does not say which hook, from which node, to which
  // URL and with which error is not auditable.
  'job.hook_failed': {
    entity: 'job',
    fields: {
      hook_id: required('string'),
      node_id: required('string'),
      url: required('string'),
      last_error: required('string'),
    },
  },
  'session.opened': {
    entity: 'session',
    fields: {
      job_id: optional('integer'),
      node_id: optional('string'),
      engine: required('string'),
      engine_session_ref: optional('string'),
      working_dir: required('string'),
      prompt: required('string'),
      timeout_seconds: optional('integer', { min: 0 }),
      // The second watchdog (t163). Optional and floored at 0 exactly like the
      // wall clock beside it: absent is "this session declares no policy", and
      // that is a different fact from a budget of zero seconds.
      silence_seconds: optional('integer', { min: 0 }),
    },
  },
  'session.finished': {
    entity: 'session',
    fields: {
      status: required('string', {
        values: [
          'completed',
          'failed',
          'stuck',
          'timed_out',
          'quota_paused',
          'resume_failed',
        ],
      }),
      exit_code: optional('integer'),
      usage: optional('usage'),
      // Which of the two watchdogs stopped the session (t163). A field and not
      // a seventh `status`: both land on `timed_out`, and the cause rides
      // in the payload — the same reasoning that kept quota states out of the
      // adapter's own status vocabulary.
      timeout_reason: optional('string', { values: ['wall_clock', 'silence'] }),
      // What KIND of failure it was, when `failed` alone does not say (t265).
      // The same move `timeout_reason` above makes, applied to the other
      // ambiguous status: a crash and an engine that REFUSED to answer both land
      // on `failed`, and only the second one reproduces identically on every
      // retry. Closed set, like `tier` and unlike `models`: this word is ours.
      failure_kind: optional('string', { values: ['engine_refusal'] }),
      // ...and how the engine classified its own refusal. Open, like `models`
      // beside it and for the same reason: the category is the ENGINE's word
      // (`reasoning_extraction` is what t198 measured), and a closed enum would
      // need a release of this file for every category an engine ships. No
      // cross-field check against `status` either — `timeout_reason` has never
      // had one, and the mirror is not where that rule would belong.
      refusal_category: optional('string'),
      // Which models ran the session (t172). `minItems: 1` is the same rule the
      // schema declares, and it is what keeps `[]` out: an empty list is not a
      // way to say "nothing was reported" — that is what the absence, normalized
      // to `null` below, already says. Open value set, so no `values` here: the
      // identifier is whatever the engine reported, and a closed enum would need
      // a release of this file for every model that ships.
      models: optional('string-list', { minItems: 1 }),
      // The node's structured result (t253) — what the next node's `input`
      // projection reads. The mirror checks that it is an OBJECT and stops
      // there, on purpose: the shape inside is declared by the `output` schema
      // of the skill the node pins (D9), and freezing it here would be one event
      // contract per problem class. `repositories/session.ts` is what holds it
      // against that schema, at `/finish`, where the registry row is in reach.
      output: optional('open-object'),
      // ...and why it was refused, when it was. Present only on the mismatch
      // path, and then `output` is `null`: the session's terminal status is
      // recorded either way, because losing the end of a session over a
      // malformed self-report would be strictly worse than losing the
      // self-report — which was never evidence to begin with.
      output_schema_error: optional('string-list', { minItems: 1 }),
      // ...and the VERDICT itself, which is the same fact seen from the side
      // that has to act on it (t268). The list above says why a report was
      // refused and is present only when one was; this says whether it was
      // taken at all, and it is written on every close — `true` when nothing
      // was reported and when the report matched, `false` only when the pinned
      // skill's own schema refused it. One boolean and not a derivation from
      // the list beside it, because the runner reads this OFF THE RESPONSE to
      // decide whether the job may move, and "no reasons" and "not checked" are
      // the same absence there. Optional like everything else here: an event
      // written before this ficha still validates, and normalizes to `null`.
      output_accepted: optional('boolean'),
    },
  },
  'session.permission_denied': {
    entity: 'session',
    fields: {
      resource: required('string', { values: ['filesystem', 'network'] }),
      tool: required('string'),
      reason: required('string'),
    },
  },
  'input_request.created': {
    entity: 'input_request',
    fields: {
      job_id: required('integer'),
      session_id: optional('integer'),
      // The node the owning job was standing on (t167). Optional, and stamped by
      // the repository from the job — the payload is where the fact is audited,
      // not where it is declared.
      node_id: optional('string'),
      kind: required('string', { values: ['question', 'approval'] }),
      question: required('string'),
      context: optional('string'),
      options: optional('string-list'),
      recommendation: optional('string'),
      default_answer: optional('string'),
      auto_approvable: required('boolean'),
    },
  },
  'input_request.answered': {
    entity: 'input_request',
    fields: {
      answer: required('string'),
      answered_by: required('string'),
    },
  },
  'input_request.auto_resolved': {
    entity: 'input_request',
    fields: {
      answer: required('string'),
      based_on: required('string', {
        values: ['recommendation', 'default_answer', 'precedent'],
      }),
    },
  },
  // A runner took possession of a job for a while (D5). `expires_at` is an
  // instant like `occurred_at` and is validated as a string for the same reason
  // the envelope's own timestamps are: the schema says `format: date-time`, and
  // this mirror has never enforced a format anybody could disagree about.
  'lease.granted': {
    entity: 'lease',
    fields: {
      job_id: required('integer'),
      runner_id: required('string'),
      expires_at: required('string'),
    },
  },
  // The possession lapsed and the job goes back to the queue. The two reasons
  // are the SAME two `lease.expiration_reason` holds
  // (`repositories/leases.ts`), and the set closes here for the same motive
  // every other closed enum of this file does: a third word is not new data, it
  // is a mistake by whoever wrote it.
  'lease.expired': {
    entity: 'lease',
    fields: {
      runner_id: required('string'),
      reason: required('string', { values: ['heartbeat_lost', 'ttl_elapsed'] }),
    },
  },
  // A new version entered the database (D15). Registering does NOT move the
  // pointer — the event that does is `graph_version.applied`, and a call site
  // that does both in one transaction owes the log both facts.
  'graph_version.registered': {
    entity: 'graph_version',
    fields: {
      graph_id: required('string'),
      /** `null` on the first version of a lineage, which has no parent. */
      parent_version: optional('string'),
      source: required('string', { values: ['synthesizer', 'manual', 'proposal'] }),
      proposal_id: optional('integer'),
    },
  },
  'graph_version.applied': {
    entity: 'graph_version',
    fields: {
      graph_id: required('string'),
      proposal_id: optional('integer'),
    },
  },
  // Rollback: the pointer went back and nothing was erased. `entity.id` is the
  // ABANDONED version — the one whose telemetry the surveyor will cross with
  // the `reason` recorded here — and `target_version` is where the pointer went.
  'graph_version.reverted': {
    entity: 'graph_version',
    fields: {
      graph_id: required('string'),
      target_version: required('string'),
      reason: required('string'),
    },
  },
  // A version's contract state moved (t283). Emitted ONLY by the re-check that
  // a newly registered manifest triggers — never at a version's birth, where
  // `graph_version.registered`/`.applied` already say what happened at that
  // instant, and a third event for the same moment would be the envelope's own
  // facts written twice (the reasoning `execution.finished`'s empty payload
  // records in `taxonomia.md`).
  //
  // The payload counts the problems instead of carrying them: the report is on
  // the row and one GET away, and the same object in two places is two places
  // to disagree — the call `job.blocked.consecutive_failures` already makes.
  'graph_version.contracts_checked': {
    entity: 'graph_version',
    fields: {
      state: required('string', { values: ['checked', 'unchecked', 'failed'] }),
      problem_count: required('integer', { min: 0 }),
    },
  },
  // The round is over (D21, t245): every job of it arrived and no lease is
  // still holding one. Empty payload for the same reason `job.unblocked` has
  // one — the envelope's `execution_id`, `entity.id` and `occurred_at` already
  // say which round ended and when, and repeating that inside `data` would be
  // the same fact twice in one event.
  'execution.finished': {
    entity: 'execution',
    fields: {},
  },
};

/** The event types the control plane knows how to record today. */
export const KNOWN_TYPES: readonly string[] = Object.freeze(Object.keys(RULES));

/** Fields of `usage`, all required when `usage` is not null. */
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** Validates `data.usage` (a token totals object, or null). */
function validateUsage(fieldPath: string, value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${fieldPath} has to be a token totals object or null`);
    return;
  }
  for (const field of USAGE_FIELDS) {
    const total = value[field];
    if (!isInteger(total) || total < 0) {
      errors.push(`${fieldPath}.${field} has to be an integer >= 0`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!USAGE_FIELDS.includes(key as (typeof USAGE_FIELDS)[number])) {
      errors.push(`${fieldPath}.${key} does not exist in the usage contract`);
    }
  }
}

/** Validates a field of `data` against its rule. */
function validateField(fieldPath: string, rule: FieldRule, value: unknown, errors: string[]): void {
  switch (rule.shape) {
    case 'string':
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`${fieldPath} has to be a non-empty string`);
        return;
      }
      if (rule.values !== undefined && !rule.values.includes(value)) {
        errors.push(`${fieldPath} has to be one of: ${rule.values.join(', ')}`);
      }
      return;

    case 'integer':
      if (!isInteger(value)) {
        errors.push(`${fieldPath} has to be an integer`);
        return;
      }
      if (rule.min !== undefined && value < rule.min) {
        errors.push(`${fieldPath} has to be >= ${rule.min}`);
      }
      return;

    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${fieldPath} has to be true or false`);
      return;

    case 'string-list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        errors.push(`${fieldPath} has to be a list of strings`);
        return;
      }
      // The same non-empty rule the `'string'` case above applies. None of the
      // JSON schemas declares `minLength` — the rule is this file's own added
      // contract — and applying it to a scalar `title` but not to an item of
      // `changed_fields` made the mirror disagree with itself (t157, FR5).
      if ((value as string[]).some((item) => item.length === 0)) {
        errors.push(`${fieldPath} cannot contain an empty string`);
      }
      if (rule.minItems !== undefined && value.length < rule.minItems) {
        errors.push(`${fieldPath} has to have at least ${rule.minItems} item(s)`);
      }
      if (rule.unique === true && new Set(value).size !== value.length) {
        errors.push(`${fieldPath} cannot repeat items`);
      }
      return;
    }

    case 'usage':
      validateUsage(fieldPath, value, errors);
      return;

    case 'scalar-map':
      // The opposite of `usage`, and that is why it is a shape of its own: there
      // the four keys are a closed contract, here the keys belong to the class's
      // graph document and only the VALUES are this mirror's business. The
      // non-empty rule that `string` carries does not apply to them either — a
      // field name cannot be blank, but `""` is a legitimate answer somebody
      // typed into a field.
      if (!isScalarMap(value)) {
        errors.push(`${fieldPath} has to be an object of string, number or boolean values`);
      }
      return;

    case 'open-object':
      // One step further open than `scalar-map`: not even the values are this
      // mirror's business. It is the shape of a payload whose whole contract
      // lives somewhere else — `session.finished.output`, judged against the
      // skill's own `output` schema — and the only claim made here is the one
      // the envelope can make on its own: it is a JSON object, so a string, a
      // number and a list are refused before anything is written.
      if (!isObject(value)) {
        errors.push(`${fieldPath} has to be a JSON object, or absent`);
      }
      return;
  }
}

/**
 * Validates `data` against the type's rule and returns the normalized version.
 *
 * Normalizing means: every field declared by the type appears in the recorded
 * payload, with an explicit `null` when the client did not send it. A log in
 * which "absent field" and "null field" are the same thing is a log you can
 * compare with `deepEqual` without ceremony.
 */
function validateData(
  type: string,
  rule: TypeRule,
  data: Record<string, unknown>,
  errors: string[],
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [name, fieldRule] of Object.entries(rule.fields)) {
    const value = data[name];
    if (isAbsent(value)) {
      if (fieldRule.required) errors.push(`data.${name} is required`);
      else normalized[name] = null;
      continue;
    }
    validateField(`data.${name}`, fieldRule, value, errors);
    normalized[name] = value;
  }

  for (const key of Object.keys(data)) {
    if (!(key in rule.fields) && !isAbsent(data[key])) {
      errors.push(`data.${key} does not exist in the contract of "${type}"`);
    }
  }

  return normalized;
}

/** Validates `entity` against the envelope and against the event type. */
function validateEntity(value: unknown, expected: EntityType | null, errors: string[]): void {
  if (!isObject(value)) {
    errors.push('entity has to be an object {type, id}');
    return;
  }
  const type = value.type;
  if (typeof type !== 'string' || !ENTITY_TYPES.includes(type as EntityType)) {
    errors.push(`entity.type has to be one of: ${ENTITY_TYPES.join(', ')}`);
  } else if (expected !== null && type !== expected) {
    errors.push(`entity.type has to be "${expected}" for this event type`);
  }

  // graph_version is the only one whose id is a snapshot hash (D15); the others
  // are integers of their own tables.
  const id = value.id;
  if (type === 'graph_version') {
    if (typeof id !== 'string' || id.length === 0) {
      errors.push('entity.id of graph_version has to be the snapshot hash (a string)');
    }
  } else if (!isInteger(id) || id < 1) {
    errors.push('entity.id has to be an integer >= 1');
  }

  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'id') errors.push(`entity.${key} does not exist in the envelope`);
  }
}

/** Validates `actor` against the envelope. */
function validateActor(value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push('actor has to be an object {type, ref}');
    return;
  }
  if (typeof value.type !== 'string' || !ACTOR_TYPES.includes(value.type as ActorType)) {
    errors.push(`actor.type has to be one of: ${ACTOR_TYPES.join(', ')}`);
  }
  if (typeof value.ref !== 'string' || value.ref.length === 0) {
    errors.push('actor.ref has to be a non-empty string');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'ref') errors.push(`actor.${key} does not exist in the envelope`);
  }
}

/**
 * Validates a whole event before it exists in the log.
 *
 * @param input Event candidate, still without an `id`.
 * @returns The normalized event, or ALL the errors found — never only the
 *   first: whoever builds a wrong envelope usually gets more than one field
 *   wrong, and returning them one at a time turns the fix into trial and error.
 */
export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { valid: false, errors: ['an event has to be an object'] };
  }

  if ('id' in input) {
    errors.push('id cannot come in the input: the server assigns it (envelope, FR1)');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'id' && !ENVELOPE_FIELDS.includes(key as (typeof ENVELOPE_FIELDS)[number])) {
      errors.push(`${key} does not exist in the envelope`);
    }
  }

  const type = input.type;
  const rule = typeof type === 'string' ? RULES[type] : undefined;
  if (typeof type !== 'string' || rule === undefined) {
    errors.push(
      `unknown type: ${JSON.stringify(type)} (known: ${KNOWN_TYPES.join(', ')})`,
    );
  }

  if (!isInteger(input.project_id)) errors.push('project_id has to be an integer');

  if (!isAbsent(input.execution_id) && !isInteger(input.execution_id)) {
    errors.push('execution_id has to be an integer or null');
  }

  validateEntity(input.entity, rule?.entity ?? null, errors);
  validateActor(input.actor, errors);

  const occurredAt = input.occurred_at;
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    errors.push('occurred_at has to be an ISO 8601 instant');
  }

  if (!isObject(input.data)) {
    errors.push('data has to be an object');
  }

  let data: Record<string, unknown> = {};
  if (rule !== undefined && isObject(input.data)) {
    data = validateData(type as string, rule, input.data, errors);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    event: {
      type: type as string,
      project_id: input.project_id as number,
      execution_id: isAbsent(input.execution_id) ? null : (input.execution_id as number),
      entity: input.entity as unknown as Entity,
      actor: input.actor as unknown as Actor,
      occurred_at: occurredAt as string,
      data,
    },
  };
}

/**
 * Validates ONLY the payload of a type, without the envelope around it.
 *
 * It exists because when an entity is created the envelope's `entity.id` is
 * only born after the projection insert, and the 400 for "missing required
 * field" (FR3) has to happen BEFORE any write. Whoever creates calls this first
 * and `recordEvent` afterwards — which revalidates the whole envelope, id
 * included.
 *
 * @param type Event type.
 * @param data Raw payload.
 * @returns Normalized payload (absent optionals become `null`).
 * @throws {ValidationError} When the payload does not match the type's contract.
 */
export function requireValidData(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const rule = RULES[type];
  if (rule === undefined) throw new ValidationError([`unknown type: ${JSON.stringify(type)}`]);

  const errors: string[] = [];
  const normalized = validateData(type, rule, data, errors);
  if (errors.length > 0) throw new ValidationError(errors);
  return normalized;
}

/**
 * Like `validateEvent`, but throws instead of returning the result.
 *
 * @param input Event candidate.
 * @returns The normalized event.
 * @throws {ValidationError} When something does not match the contract.
 */
export function requireValidEvent(input: unknown): EventToRecord {
  const result = validateEvent(input);
  if (!result.valid) throw new ValidationError(result.errors);
  return result.event;
}
