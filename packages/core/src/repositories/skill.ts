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
 * - at least one check, **always**, when `origem.tipo` is `importada`
 *   (`manifesto-skill.md:247`: "se não der para escrever nenhum check, a skill
 *   não entra"). A native skill keeps the schema's own weaker rule — one check
 *   required only for a gate — because this ticket's product rule is about
 *   importing third-party content, not about every future registration path;
 * - no unrestricted network on import (`manifesto-skill.md:266-268`): a
 *   third-party skill with open network and instructions nobody wrote is the
 *   supply-chain vector D4 exists to close. A native skill may declare it.
 *
 * The third rule, `resultado` in a gate's `saida`, is structural and applies to
 * everyone: `manifesto-skill.md:322-331` documents it as enforced at registry
 * entry precisely because the schema cannot navigate inside an arbitrary JSON
 * Schema document.
 *
 * The fourth, `instrucao` + `evidencia_obrigatoria` on an agentic check (t135,
 * FR1), applies to everyone for a simpler reason: it is the schema's own
 * conditional (`manifesto-skill.schema.json:113-115`), and the schema does not
 * ask where the manifest came from. This validator ports the schema by hand —
 * there is no ajv here, for the reason `db/event-validation.ts:9` gives — so
 * every rule that matters has to be ported deliberately, and this one had been
 * missed.
 *
 * No telemetry event is emitted. `skill` is not a member of the taxonomy's
 * `entidade.tipo` enum (`especificacoes/eventos/schemas/envelope.schema.json`),
 * and extending a versioned product format is a change of its own. Meanwhile the
 * import's audit trail is complete on the job/input-request side —
 * `trabalho.criado`, `pergunta.criada`, `pergunta.respondida`,
 * `trabalho.desbloqueado` already record who proposed what, from which repo and
 * ref, and who approved it.
 *
 * The column names and the projection's field names are the skill-manifest
 * format's own keys, which D18 leaves in Portuguese (`DECISOES.md:153-155`).
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
import { now } from './common.ts';

/** A registered skill, as the API returns it. */
export interface Skill {
  id: string;
  versao: string;
  hash: string;
  papel: string;
  descricao: string;
  entrada: Record<string, unknown>;
  saida: Record<string, unknown>;
  pre_condicoes: string[];
  checks: Record<string, unknown>[];
  permissoes: Record<string, unknown>;
  instrucoes: string;
  origem: Record<string, unknown>;
  registrado_em: string;
}

/** The three columns that are not JSON, plus the six that are. */
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
const GATE_OUTCOMES = ['passou', 'falhou', 'escalar_humano'];

const COLUMNS = `
  id, versao, hash, papel, descricao, entrada, saida, pre_condicoes,
  checks, permissoes, instrucoes, origem, registrado_em
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    versao: row.versao,
    hash: row.hash,
    papel: row.papel,
    descricao: row.descricao,
    entrada: JSON.parse(row.entrada) as Record<string, unknown>,
    saida: JSON.parse(row.saida) as Record<string, unknown>,
    pre_condicoes: JSON.parse(row.pre_condicoes) as string[],
    checks: JSON.parse(row.checks) as Record<string, unknown>[],
    permissoes: JSON.parse(row.permissoes) as Record<string, unknown>,
    instrucoes: row.instrucoes,
    origem: JSON.parse(row.origem) as Record<string, unknown>,
    registrado_em: row.registrado_em,
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
  if (!isText(manifest.versao) || !VERSION_PATTERN.test(manifest.versao)) {
    problems.push('versao: has to be semver (x.y.z)');
  }
  if (!isText(manifest.hash) || !HASH_PATTERN.test(manifest.hash)) {
    problems.push('hash: has to have the shape sha256:<64 hex>');
  }
  if (!isText(manifest.papel) || !MANIFEST_ROLES.includes(manifest.papel)) {
    problems.push(`papel: has to be ${MANIFEST_ROLES.join(' or ')}`);
  }
  if (!isText(manifest.descricao)) problems.push('descricao: has to be a non-empty string');
  if (!isText(manifest.instrucoes)) problems.push('instrucoes: has to be a non-empty string');
  if (!isObject(manifest.entrada)) problems.push('entrada: has to be a JSON Schema object');
  if (!isObject(manifest.saida)) problems.push('saida: has to be a JSON Schema object');

  if (
    !Array.isArray(manifest.pre_condicoes) ||
    manifest.pre_condicoes.some((item) => !isText(item))
  ) {
    problems.push('pre_condicoes: has to be a list of non-empty strings');
  }
  if (!Array.isArray(manifest.checks) || manifest.checks.some((item) => !isObject(item))) {
    problems.push('checks: has to be a list of check objects');
  } else {
    for (const check of manifest.checks) checkAgentic(check as Record<string, unknown>, problems);
  }

  checkPermissions(manifest.permissoes, problems);

  if (!isObject(manifest.origem)) {
    problems.push('origem: has to be an object with a "tipo" of nativa or importada');
  } else if (manifest.origem.tipo !== 'nativa' && manifest.origem.tipo !== 'importada') {
    problems.push('origem.tipo: has to be nativa or importada');
  }
}

/**
 * An agentic check says what to judge and what the verdict has to cite.
 *
 * `manifesto-skill.schema.json:113-115`: `tipo: "agentico"` requires both
 * `instrucao` and `evidencia_obrigatoria`. The rule is the format's, not an
 * import rule, so it applies to every manifest — a judgment nobody has to
 * evidence concludes on the self-report of whoever produced the artifact, which
 * is what D9 exists to forbid, and a native gate can get that wrong exactly as
 * easily as an imported one.
 *
 * `evidencia_obrigatoria` is a LIST of artifacts (the schema's `minItems: 1`),
 * not a sentence: the check is supposed to name what it will go read.
 *
 * @param check One entry of `checks`, already known to be an object.
 * @param problems Accumulator; the offending check's `id` names each message.
 */
function checkAgentic(check: Record<string, unknown>, problems: string[]): void {
  if (check.tipo !== 'agentico') return;

  const label = `checks[${isText(check.id) ? check.id : '?'}]`;
  if (!isText(check.instrucao)) {
    problems.push(`${label}: tipo "agentico" requires "instrucao" — the judgment being asked for`);
  }

  const evidence = check.evidencia_obrigatoria;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => !isText(item))) {
    problems.push(
      `${label}: tipo "agentico" requires "evidencia_obrigatoria" — a non-empty list of the artifacts the verdict has to cite; without it the check concludes on a self-report (D9)`,
    );
  }
}

/** `permissoes` declares both surfaces; absence is never read as "anything goes". */
function checkPermissions(permissions: unknown, problems: string[]): void {
  if (!isObject(permissions)) {
    problems.push('permissoes: has to declare filesystem and rede');
    return;
  }

  const filesystem = permissions.filesystem;
  if (
    !isObject(filesystem) ||
    !Array.isArray(filesystem.leitura) ||
    !Array.isArray(filesystem.escrita)
  ) {
    problems.push('permissoes.filesystem: has to declare "leitura" and "escrita" as lists');
  }

  const network = permissions.rede;
  if (!isObject(network) || typeof network.permitido !== 'boolean') {
    problems.push('permissoes.rede: has to declare "permitido" as true or false');
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
  for (const field of ['repo', 'ref', 'importado_por', 'importado_em', 'revisado_por']) {
    if (!isText(origin[field])) {
      problems.push(`origem.${field}: required when origem.tipo is "importada" (D4)`);
    }
  }
}

/** A gate has to be able to say how it went, or the executor cannot route. */
function checkGateOutcome(output: unknown, problems: string[]): void {
  const properties = isObject(output) && isObject(output.properties) ? output.properties : {};
  const outcome = properties.resultado;
  const values = isObject(outcome) && Array.isArray(outcome.enum) ? outcome.enum : null;
  const declaresOutcome =
    values !== null &&
    values.length === GATE_OUTCOMES.length &&
    GATE_OUTCOMES.every((value) => values.includes(value));

  if (!declaresOutcome) {
    problems.push(
      `saida: papel "portao" requires a "resultado" field whose enum is exactly [${GATE_OUTCOMES.map(
        (value) => `"${value}"`,
      ).join(', ')}] — without it the executor cannot route the outcome`,
    );
  }
}

/**
 * Every reason this manifest cannot enter the registry.
 *
 * The content rules only run once the shape rules found nothing: recomputing a
 * hash over half a manifest, or reading `origem.tipo` off something that is not
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

  const origin = manifest.origem as Record<string, unknown>;
  const checks = manifest.checks as unknown[];
  const imported = origin.tipo === 'importada';

  if (imported) {
    checkProvenance(origin, problems);

    // D4's import rule, and the one that most often ends an import: a skill
    // nobody can verify is a skill nobody can gate (principle 6).
    if (checks.length === 0) {
      problems.push(
        'checks: no derivable check — an imported skill enters the registry only with at least one check (D4); with no verification there is no gate',
      );
    }

    const network = (manifest.permissoes as Record<string, unknown>).rede as Record<
      string,
      unknown
    >;
    const domains = network.dominios;
    if (network.permitido === true && (!Array.isArray(domains) || domains.length === 0)) {
      problems.push(
        'permissoes.rede: unrestricted network is rejected on import (D4) — declare "dominios", or leave "permitido" as false',
      );
    }
  } else if (manifest.papel === 'portao' && checks.length === 0) {
    problems.push('checks: papel "portao" requires at least one check');
  }

  if (manifest.papel === 'portao') checkGateOutcome(manifest.saida, problems);

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
    verified.versao as string,
    verified.hash as string,
    verified.papel as string,
    verified.descricao as string,
    JSON.stringify(verified.entrada),
    JSON.stringify(verified.saida),
    JSON.stringify(verified.pre_condicoes),
    JSON.stringify(verified.checks),
    JSON.stringify(verified.permissoes),
    verified.instrucoes as string,
    JSON.stringify(verified.origem),
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
