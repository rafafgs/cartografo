/**
 * Skill repository — the registry is the gate of truth of D4 (t117, FR3/FR4).
 *
 * Everything this module refuses, it refuses on its own evidence. The CLI
 * derived the manifest, a human approved it, and neither fact counts here: the
 * hash is recomputed from the content, the provenance is re-checked field by
 * field, and an approval of something the registry cannot verify is still not a
 * registration. That is not distrust of the human — it is the only way "pinned
 * by hash" means anything after the approval, because between the answer and
 * this INSERT there is a JSON payload that anybody can edit.
 *
 * Two of the rules here are IMPORT rules, not registration rules, and the
 * difference is deliberate:
 *
 * - at least one check, **always**, when `origin.type` is `imported`
 *   (`manifesto-skill.md:247`: "se não der para escrever nenhum check, a skill
 *   não entra"). A native skill keeps the schema's own weaker rule — one check
 *   required only for a gate — because this ticket's product rule is about
 *   importing third-party content, not about every future registration path;
 * - no unrestricted network on import (`manifesto-skill.md:266-268`): a
 *   third-party skill with open network and instructions nobody wrote is the
 *   supply-chain vector D4 exists to close. A native skill may declare it.
 *
 * The third rule, `outcome` in a gate's `output`, is structural and applies to
 * everyone: `manifesto-skill.md:322-331` documents it as enforced at registry
 * entry precisely because the schema cannot navigate inside an arbitrary JSON
 * Schema document.
 *
 * The fourth is the per-check contract, and it applies to everyone for a simpler
 * reason: it is the schema's own, and the schema does not ask where the manifest
 * came from. `manifesto-skill.schema.json:83` requires `id`, `type` and
 * `description` of every check; line 91 closes `type` to `deterministic` or
 * `agentic`; lines 108-111 require `command` of the first, lines 112-116
 * `instruction` + `required_evidence` of the second. This validator ports the
 * schema by hand — there is no ajv here, for the reason `db/event-validation.ts:9`
 * gives — so every rule that matters has to be ported deliberately, and this one
 * was ported twice by halves: t135 brought the agentic conditional, t155 the rest
 * of the contract that its early return had been skipping.
 *
 * No telemetry event is emitted. `skill` is not a member of the taxonomy's
 * `entidade.tipo` enum (`especificacoes/eventos/schemas/envelope.schema.json`),
 * and extending a versioned product format is a change of its own. Meanwhile the
 * import's audit trail is complete on the job/input-request side —
 * `trabalho.criado`, `pergunta.criada`, `pergunta.respondida`,
 * `trabalho.desbloqueado` already record who proposed what, from which repo and
 * ref, and who approved it.
 *
 * This module is the translation boundary the t178 rename leans on. `Skill` —
 * what the API returns — and every manifest-shaped rule below speak the format's
 * new English vocabulary; `SkillRow` and `COLUMNS` keep the Portuguese COLUMN
 * names of `migrations/0005_skill.sql`, because the database schema is a
 * separate slice with a migration of its own. `toSkill` is where the two meet,
 * and it is the only place that has to know both.
 *
 * That migration's own header still justifies its Portuguese columns by citing
 * the D18 carve-out this ticket lifted. The justification is stale; the columns
 * are not wrong until somebody migrates them.
 */

import type { Database } from '../db/connection.ts';
import {
  HASH_PATTERN,
  ID_PATTERN,
  MANIFEST_FIELDS,
  MANIFEST_ROLES,
  VERSION_PATTERN,
  manifestHash,
} from '../domain/manifest.ts';
import { isObject } from '../util/is-object.ts';
import { now } from './common.ts';

/** A registered skill, as the API returns it. */
export interface Skill {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  preconditions: string[];
  checks: Record<string, unknown>[];
  permissions: Record<string, unknown>;
  instructions: string;
  origin: Record<string, unknown>;
  /**
   * When the manifest entered the registry.
   *
   * English since t226: this was the ONE field `toSkill` still let through with
   * the column's own name, and the wire gate of D20's API child is what found
   * it. The COLUMN is still `registrado_em` (`migrations/0005_skill.sql`).
   */
  registered_at: string;
}

/** The `skill` table's own projection, in its own Portuguese (see the header). */
interface SkillRow {
  id: string;
  versao: string;
  hash: string;
  papel: string;
  descricao: string;
  entrada: string;
  saida: string;
  pre_condicoes: string;
  checks: string;
  permissoes: string;
  instrucoes: string;
  origem: string;
  registrado_em: string;
}

/**
 * A manifest the registry refuses, carrying the HTTP status the refusal deserves.
 *
 * `problems` is the WHOLE list, never the first one: whoever is fixing a
 * manifest that was already through a human gate needs every reason at once, or
 * the gate reopens once per problem.
 */
export class SkillRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly problems: string[];

  constructor(status: number, code: string, problems: string[]) {
    super(`skill refused: ${problems.join('; ')}`);
    this.name = 'SkillRejected';
    this.status = status;
    this.code = code;
    this.problems = problems;
  }
}

/** The three values a gate has to be able to return, so the executor can route. */
const GATE_OUTCOMES = ['pass', 'fail', 'escalate_human'];

/** The two things a check can be (`manifesto-skill.schema.json:91`), and no third. */
const CHECK_TYPES = ['deterministic', 'agentic'];

/**
 * `role`, as the `skill` table spells it — the other half of the translation
 * boundary, and the one that is not cosmetic.
 *
 * `migrations/0005_skill.sql:47` puts a `CHECK (papel IN ('fazer', 'portao'))`
 * on the column, which makes the Portuguese values part of the DB schema rather
 * than of the format. Renaming them belongs to the DB-entity slice, with its own
 * migration; until then a manifest that says `work` is stored as `fazer`, and
 * comes back out as `work`. Every other column is either free text or JSON, so
 * this is the only value the boundary has to carry across.
 */
const ROLE_COLUMN: Record<string, string> = { work: 'fazer', gate: 'portao' };
const ROLE_FIELD: Record<string, string> = { fazer: 'work', portao: 'gate' };

const COLUMNS = `
  id, versao, hash, papel, descricao, entrada, saida, pre_condicoes,
  checks, permissoes, instrucoes, origem, registrado_em
`;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Row to manifest: the one place the column names meet the format's names. */
function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    version: row.versao,
    hash: row.hash,
    role: ROLE_FIELD[row.papel] ?? row.papel,
    description: row.descricao,
    input: JSON.parse(row.entrada) as Record<string, unknown>,
    output: JSON.parse(row.saida) as Record<string, unknown>,
    preconditions: JSON.parse(row.pre_condicoes) as string[],
    checks: JSON.parse(row.checks) as Record<string, unknown>[],
    permissions: JSON.parse(row.permissoes) as Record<string, unknown>,
    instructions: row.instrucoes,
    origin: JSON.parse(row.origem) as Record<string, unknown>,
    registered_at: row.registrado_em,
  };
}

/** Shape of every field the schema declares `required`. */
function checkShape(manifest: Record<string, unknown>, problems: string[]): void {
  for (const field of MANIFEST_FIELDS) {
    if (manifest[field] === undefined) problems.push(`required field missing: "${field}"`);
  }

  if (!isText(manifest.id) || !ID_PATTERN.test(manifest.id)) {
    problems.push(`id: has to be kebab-case (${ID_PATTERN.source})`);
  }
  if (!isText(manifest.version) || !VERSION_PATTERN.test(manifest.version)) {
    problems.push('version: has to be semver (x.y.z)');
  }
  if (!isText(manifest.hash) || !HASH_PATTERN.test(manifest.hash)) {
    problems.push('hash: has to have the shape sha256:<64 hex>');
  }
  if (!isText(manifest.role) || !MANIFEST_ROLES.includes(manifest.role)) {
    problems.push(`role: has to be ${MANIFEST_ROLES.join(' or ')}`);
  }
  if (!isText(manifest.description)) problems.push('description: has to be a non-empty string');
  if (!isText(manifest.instructions)) problems.push('instructions: has to be a non-empty string');
  if (!isObject(manifest.input)) problems.push('input: has to be a JSON Schema object');
  if (!isObject(manifest.output)) problems.push('output: has to be a JSON Schema object');

  if (
    !Array.isArray(manifest.preconditions) ||
    manifest.preconditions.some((item) => !isText(item))
  ) {
    problems.push('preconditions: has to be a list of non-empty strings');
  }
  if (!Array.isArray(manifest.checks) || manifest.checks.some((item) => !isObject(item))) {
    problems.push('checks: has to be a list of check objects');
  } else {
    manifest.checks.forEach((check, index) =>
      checkCheck(check as Record<string, unknown>, index, problems),
    );
  }

  checkPermissions(manifest.permissions, problems);

  if (!isObject(manifest.origin)) {
    problems.push('origin: has to be an object with a "type" of native or imported');
  } else if (manifest.origin.type !== 'native' && manifest.origin.type !== 'imported') {
    problems.push('origin.type: has to be native or imported');
  }
}

/**
 * The whole per-check contract, the same for every check (t155, FR1-FR3).
 *
 * `manifesto-skill.schema.json:83` makes `id`, `type` and `description` required
 * of EVERY check, and line 91 closes `type` to two values. Then each half of the
 * enum has its own conditional: `deterministic` requires `command`
 * (lines 108-111), `agentic` requires `instruction` and `required_evidence`
 * (lines 112-116). All four rules are the format's own, not import rules, so
 * they apply to every manifest — D9 defines a check as either a deterministic
 * command or an agentic instruction with mandatory evidence, and a check that is
 * neither is one the runner reaches with nothing to execute.
 *
 * The rule this function used to be, `checkAgentic`, enforced only the agentic
 * conditional and returned early for everything else. That early return is what
 * t155 was: a check shaped `{type: "deterministic"}`, an unrecognized `type`,
 * or a check missing all three required fields all registered.
 *
 * `required_evidence` is a LIST of artifacts (the schema's `minItems: 1`),
 * not a sentence: the check is supposed to name what it will go read.
 *
 * @param check One entry of `checks`, already known to be an object.
 * @param index Its position, which names the check while `id` is still missing.
 * @param problems Accumulator; the offending check's `id` names each message.
 */
function checkCheck(check: Record<string, unknown>, index: number, problems: string[]): void {
  const label = `checks[${isText(check.id) ? check.id : `#${index}`}]`;

  if (!isText(check.id)) {
    problems.push(
      `${label}: required field missing: "id" — the key telemetry aggregates the check by`,
    );
  }
  if (!isText(check.description)) {
    problems.push(`${label}: required field missing: "description" — a non-empty string`);
  }

  if (check.type === undefined) {
    problems.push(
      `${label}: required field missing: "type" — has to be ${CHECK_TYPES.map((type) => `"${type}"`).join(' or ')}`,
    );
    return;
  }
  if (!isText(check.type) || !CHECK_TYPES.includes(check.type)) {
    problems.push(
      `${label}: type ${JSON.stringify(check.type)} is not a check type — has to be ${CHECK_TYPES.map(
        (type) => `"${type}"`,
      ).join(' or ')}; a check the runner cannot execute is not a check (D9)`,
    );
    return;
  }

  if (check.type === 'deterministic' && !isText(check.command)) {
    problems.push(
      `${label}: type "deterministic" requires "command" — the command whose exit code is the verdict; without it the runner reaches this check with nothing to run (D9)`,
    );
  }

  if (check.type === 'agentic') {
    if (!isText(check.instruction)) {
      problems.push(`${label}: type "agentic" requires "instruction" — the judgment being asked for`);
    }

    const evidence = check.required_evidence;
    if (
      !Array.isArray(evidence) ||
      evidence.length === 0 ||
      evidence.some((item) => !isText(item))
    ) {
      problems.push(
        `${label}: type "agentic" requires "required_evidence" — a non-empty list of the artifacts the verdict has to cite; without it the check concludes on a self-report (D9)`,
      );
    }
  }
}

/** `permissions` declares both surfaces; absence is never read as "anything goes". */
function checkPermissions(permissions: unknown, problems: string[]): void {
  if (!isObject(permissions)) {
    problems.push('permissions: has to declare filesystem and network');
    return;
  }

  const filesystem = permissions.filesystem;
  if (
    !isObject(filesystem) ||
    !Array.isArray(filesystem.read) ||
    !Array.isArray(filesystem.write)
  ) {
    problems.push('permissions.filesystem: has to declare "read" and "write" as lists');
  }

  const network = permissions.network;
  if (!isObject(network) || typeof network.allowed !== 'boolean') {
    problems.push('permissions.network: has to declare "allowed" as true or false');
  }
}

/** The pin, recomputed from the content — never taken from the payload (D4). */
function checkPin(manifest: Record<string, unknown>, problems: string[]): void {
  const declared = manifest.hash;
  if (!isText(declared) || !HASH_PATTERN.test(declared)) return;

  const recomputed = manifestHash(manifest);
  if (recomputed !== declared) {
    problems.push(
      `hash: the manifest declares ${declared}, but its content is ${recomputed} — a tampered manifest does not enter the registry (D4)`,
    );
  }
}

/** The five provenance fields D4 demands of anything that came from outside. */
function checkProvenance(origin: Record<string, unknown>, problems: string[]): void {
  for (const field of ['repo', 'ref', 'imported_by', 'imported_at', 'reviewed_by']) {
    if (!isText(origin[field])) {
      problems.push(`origin.${field}: required when origin.type is "imported" (D4)`);
    }
  }
}

/** A gate has to be able to say how it went, or the executor cannot route. */
function checkGateOutcome(output: unknown, problems: string[]): void {
  const properties = isObject(output) && isObject(output.properties) ? output.properties : {};
  const outcome = properties.outcome;
  const values = isObject(outcome) && Array.isArray(outcome.enum) ? outcome.enum : null;
  const declaresOutcome =
    values !== null &&
    values.length === GATE_OUTCOMES.length &&
    GATE_OUTCOMES.every((value) => values.includes(value));

  if (!declaresOutcome) {
    problems.push(
      `output: role "gate" requires an "outcome" field whose enum is exactly [${GATE_OUTCOMES.map(
        (value) => `"${value}"`,
      ).join(', ')}] — without it the executor cannot route the outcome`,
    );
  }
}

/**
 * Every reason this manifest cannot enter the registry.
 *
 * The content rules only run once the shape rules found nothing: recomputing a
 * hash over half a manifest, or reading `origin.type` off something that is not
 * an object, produces noise on top of a problem the caller already has.
 *
 * @param manifest The submitted manifest, still unverified.
 * @returns Problems found; empty when the manifest may be registered.
 */
export function findProblems(manifest: unknown): string[] {
  if (!isObject(manifest)) return ['the manifest has to be a JSON object'];

  const problems: string[] = [];
  checkShape(manifest, problems);
  if (problems.length > 0) return problems;

  checkPin(manifest, problems);

  const origin = manifest.origin as Record<string, unknown>;
  const checks = manifest.checks as unknown[];
  const imported = origin.type === 'imported';

  if (imported) {
    checkProvenance(origin, problems);

    // D4's import rule, and the one that most often ends an import: a skill
    // nobody can verify is a skill nobody can gate (principle 6).
    if (checks.length === 0) {
      problems.push(
        'checks: no derivable check — an imported skill enters the registry only with at least one check (D4); with no verification there is no gate',
      );
    }

    const network = (manifest.permissions as Record<string, unknown>).network as Record<
      string,
      unknown
    >;
    const domains = network.domains;
    if (network.allowed === true && (!Array.isArray(domains) || domains.length === 0)) {
      problems.push(
        'permissions.network: unrestricted network is rejected on import (D4) — declare "domains", or leave "allowed" as false',
      );
    }
  } else if (manifest.role === 'gate' && checks.length === 0) {
    problems.push('checks: role "gate" requires at least one check');
  }

  if (manifest.role === 'gate') checkGateOutcome(manifest.output, problems);

  return problems;
}

/**
 * Registers a manifest, after re-verifying it from scratch (FR3).
 *
 * Create-only: a second registration of the same `id` is a conflict, not an
 * update. Re-import, diff and version history for a skill are a separate ticket
 * — the graph-style lineage exists because two consumers asked for it, and this
 * one has none yet.
 *
 * @param db Open handle.
 * @param manifest The submitted manifest.
 * @returns The stored skill.
 * @throws {SkillRejected} With 422 for an unverifiable manifest, 409 for a known id.
 */
export function registerSkill(db: Database, manifest: unknown): Skill {
  const problems = findProblems(manifest);
  if (problems.length > 0) throw new SkillRejected(422, 'manifest_rejected', problems);

  const verified = manifest as Record<string, unknown>;
  const id = verified.id as string;

  if (getSkill(db, id) !== null) {
    throw new SkillRejected(409, 'skill_already_registered', [
      `a skill with id "${id}" is already registered; re-import is not this route's job`,
    ]);
  }

  const timestamp = now();
  db.prepare(
    `INSERT INTO skill (
       id, versao, hash, papel, descricao, entrada, saida, pre_condicoes,
       checks, permissoes, instrucoes, origem, registrado_em
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    verified.version as string,
    verified.hash as string,
    ROLE_COLUMN[verified.role as string] ?? (verified.role as string),
    verified.description as string,
    JSON.stringify(verified.input),
    JSON.stringify(verified.output),
    JSON.stringify(verified.preconditions),
    JSON.stringify(verified.checks),
    JSON.stringify(verified.permissions),
    verified.instructions as string,
    JSON.stringify(verified.origin),
    timestamp,
  );

  return getSkill(db, id) as Skill;
}

/**
 * Gets a registered skill by id.
 *
 * @param db Open handle.
 * @param id Skill id (the manifest's own kebab-case identifier).
 * @returns The skill, or `null` when it is not registered.
 */
export function getSkill(db: Database, id: string): Skill | null {
  const row = db.prepare(`SELECT ${COLUMNS} FROM skill WHERE id = ?`).get(id) as
    | SkillRow
    | undefined;
  return row === undefined ? null : toSkill(row);
}

/**
 * The whole registry, in id order — what a capability reader consults.
 *
 * @param db Open handle.
 * @returns Registered skills.
 */
export function listSkills(db: Database): Skill[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM skill ORDER BY id`).all() as SkillRow[];
  return rows.map(toSkill);
}
