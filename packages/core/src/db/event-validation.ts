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
 * The field names below are the envelope's and the payloads' wire keys, which
 * mirror untouched migration columns and the event taxonomy: they stay in
 * Portuguese by FR8 (t127). The code around them is English.
 */

/** Possible subjects of an event (`envelope.schema.json`). */
export type EntityType = 'trabalho' | 'sessao' | 'pergunta' | 'lease' | 'grafo_versao';

/** Who caused the event. Parity with flowpilot's `ActorType`. */
export type ActorType = 'usuario' | 'agente' | 'sistema';

/** The subject of the event — the join key of telemetry with the rest of the database. */
export interface Entity {
  tipo: EntityType;
  /** Integer for `trabalho`/`sessao`/`pergunta`/`lease`; string (hash) for `grafo_versao` (D15). */
  id: number | string;
}

/** Who caused the event. */
export interface Actor {
  tipo: ActorType;
  ref: string;
}

/**
 * An event ready to be written — the whole envelope MINUS the `id`.
 *
 * The `id` is the log order and the only total ordering there is; the server
 * assigns it, and that is why it never appears in the input.
 */
export interface EventToRecord {
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade: Entity;
  ator: Actor;
  ocorrido_em: string;
  dados: Record<string, unknown>;
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
  'trabalho',
  'sessao',
  'pergunta',
  'lease',
  'grafo_versao',
];

const ACTOR_TYPES: readonly ActorType[] = ['usuario', 'agente', 'sistema'];

const ENVELOPE_FIELDS = [
  'tipo',
  'projeto_id',
  'execucao_id',
  'entidade',
  'ator',
  'ocorrido_em',
  'dados',
] as const;

/** How a field of `dados` is checked. */
interface FieldRule {
  /** Expected shape of the value. */
  shape: 'string' | 'integer' | 'boolean' | 'string-list' | 'usage';
  /** Is absent/null accepted? */
  required: boolean;
  /** Closed set of values, when the schema declares an `enum`. */
  values?: readonly string[];
  /** Floor, for non-negative integers (`timeout_seconds`, tokens). */
  min?: number;
  /** Minimum number of items, for lists (`campos_alterados` has `minItems: 1`). */
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
 * The 9 types of this ticket, in taxonomy order.
 *
 * The other 6 of the catalogue are left to their owners: `lease.*` belongs to
 * t103 (runner and controller) and `grafo_versao.*` to t101 — each enters here
 * together with the code that emits it, never before.
 */
const RULES: Record<string, TypeRule> = {
  'trabalho.criado': {
    entity: 'trabalho',
    fields: {
      titulo: required('string'),
      no_entrada_id: required('string'),
    },
  },
  'trabalho.transicao': {
    entity: 'trabalho',
    fields: {
      de_no_id: optional('string'),
      para_no_id: required('string'),
    },
  },
  'trabalho.bloqueado': {
    entity: 'trabalho',
    fields: { motivo: required('string') },
  },
  'trabalho.desbloqueado': {
    entity: 'trabalho',
    fields: {},
  },
  'trabalho.emendado': {
    entity: 'trabalho',
    fields: {
      campos_alterados: required('string-list', { minItems: 1, unique: true }),
    },
  },
  'sessao.aberta': {
    entity: 'sessao',
    fields: {
      trabalho_id: optional('integer'),
      no_id: optional('string'),
      engine: required('string'),
      engine_session_ref: optional('string'),
      working_dir: required('string'),
      prompt: required('string'),
      timeout_seconds: optional('integer', { min: 0 }),
    },
  },
  'sessao.finalizada': {
    entity: 'sessao',
    fields: {
      status: required('string', {
        values: [
          'concluida',
          'falhou',
          'travada',
          'tempo_esgotado',
          'pausada_cota',
          'retomada_falhou',
        ],
      }),
      exit_code: optional('integer'),
      uso: optional('usage'),
    },
  },
  'pergunta.criada': {
    entity: 'pergunta',
    fields: {
      trabalho_id: required('integer'),
      sessao_id: optional('integer'),
      tipo: required('string', { values: ['pergunta', 'aprovacao'] }),
      pergunta: required('string'),
      contexto: optional('string'),
      opcoes: optional('string-list'),
      recomendacao: optional('string'),
      resposta_padrao: optional('string'),
      auto_aprovavel: required('boolean'),
    },
  },
  'pergunta.respondida': {
    entity: 'pergunta',
    fields: {
      resposta: required('string'),
      respondido_por: required('string'),
    },
  },
  'pergunta.auto_resolvida': {
    entity: 'pergunta',
    fields: {
      resposta: required('string'),
      baseada_em: required('string', {
        values: ['recomendacao', 'resposta_padrao', 'precedente'],
      }),
    },
  },
};

/** The event types the control plane knows how to record today. */
export const KNOWN_TYPES: readonly string[] = Object.freeze(Object.keys(RULES));

/** Fields of `uso`, all required when `uso` is not null. */
const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value);

const isAbsent = (value: unknown): boolean => value === undefined || value === null;

/** Validates `dados.uso` (a token totals object, or null). */
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

/** Validates a field of `dados` against its rule. */
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
  }
}

/**
 * Validates `dados` against the type's rule and returns the normalized version.
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
      if (fieldRule.required) errors.push(`dados.${name} is required`);
      else normalized[name] = null;
      continue;
    }
    validateField(`dados.${name}`, fieldRule, value, errors);
    normalized[name] = value;
  }

  for (const key of Object.keys(data)) {
    if (!(key in rule.fields) && !isAbsent(data[key])) {
      errors.push(`dados.${key} does not exist in the contract of "${type}"`);
    }
  }

  return normalized;
}

/** Validates `entidade` against the envelope and against the event type. */
function validateEntity(value: unknown, expected: EntityType | null, errors: string[]): void {
  if (!isObject(value)) {
    errors.push('entidade has to be an object {tipo, id}');
    return;
  }
  const type = value.tipo;
  if (typeof type !== 'string' || !ENTITY_TYPES.includes(type as EntityType)) {
    errors.push(`entidade.tipo has to be one of: ${ENTITY_TYPES.join(', ')}`);
  } else if (expected !== null && type !== expected) {
    errors.push(`entidade.tipo has to be "${expected}" for this event type`);
  }

  // grafo_versao is the only one whose id is a snapshot hash (D15); the others
  // are integers of their own tables.
  const id = value.id;
  if (type === 'grafo_versao') {
    if (typeof id !== 'string' || id.length === 0) {
      errors.push('entidade.id of grafo_versao has to be the snapshot hash (a string)');
    }
  } else if (!isInteger(id) || id < 1) {
    errors.push('entidade.id has to be an integer >= 1');
  }

  for (const key of Object.keys(value)) {
    if (key !== 'tipo' && key !== 'id') errors.push(`entidade.${key} does not exist in the envelope`);
  }
}

/** Validates `ator` against the envelope. */
function validateActor(value: unknown, errors: string[]): void {
  if (!isObject(value)) {
    errors.push('ator has to be an object {tipo, ref}');
    return;
  }
  if (typeof value.tipo !== 'string' || !ACTOR_TYPES.includes(value.tipo as ActorType)) {
    errors.push(`ator.tipo has to be one of: ${ACTOR_TYPES.join(', ')}`);
  }
  if (typeof value.ref !== 'string' || value.ref.length === 0) {
    errors.push('ator.ref has to be a non-empty string');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'tipo' && key !== 'ref') errors.push(`ator.${key} does not exist in the envelope`);
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

  const type = input.tipo;
  const rule = typeof type === 'string' ? RULES[type] : undefined;
  if (typeof type !== 'string' || rule === undefined) {
    errors.push(
      `unknown type: ${JSON.stringify(type)} (known: ${KNOWN_TYPES.join(', ')})`,
    );
  }

  if (!isInteger(input.projeto_id)) errors.push('projeto_id has to be an integer');

  if (!isAbsent(input.execucao_id) && !isInteger(input.execucao_id)) {
    errors.push('execucao_id has to be an integer or null');
  }

  validateEntity(input.entidade, rule?.entity ?? null, errors);
  validateActor(input.ator, errors);

  const occurredAt = input.ocorrido_em;
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    errors.push('ocorrido_em has to be an ISO 8601 instant');
  }

  if (!isObject(input.dados)) {
    errors.push('dados has to be an object');
  }

  let data: Record<string, unknown> = {};
  if (rule !== undefined && isObject(input.dados)) {
    data = validateData(type as string, rule, input.dados, errors);
  }

  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    event: {
      tipo: type as string,
      projeto_id: input.projeto_id as number,
      execucao_id: isAbsent(input.execucao_id) ? null : (input.execucao_id as number),
      entidade: input.entidade as unknown as Entity,
      ator: input.ator as unknown as Actor,
      ocorrido_em: occurredAt as string,
      dados: data,
    },
  };
}

/**
 * Validates ONLY the payload of a type, without the envelope around it.
 *
 * It exists because when an entity is created the envelope's `entidade.id` is
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
