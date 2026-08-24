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
 * No telemetry event is emitted ON THE SKILL. `skill` is not a member of the
 * taxonomy's `entidade.tipo` enum
 * (`especificacoes/eventos/schemas/envelope.schema.json`), and extending a
 * versioned product format is a change of its own — that claim is unchanged.
 * What t283 added is an event about a DIFFERENT entity: registering a manifest
 * re-judges every `graph_version` that was waiting on it, and each one that
 * moves records `graph_version.contracts_checked` about itself. Meanwhile the
 * import's audit trail is complete on the job/input-request side —
 * `trabalho.criado`, `pergunta.criada`, `pergunta.respondida`,
 * `trabalho.desbloqueado` already record who proposed what, from which repo and
 * ref, and who approved it.
 *
 * This module is the translation boundary the t178 rename leans on. `Skill` —
 * what the API returns — and every manifest-shaped rule below speak the format's
 * new English vocabulary. The COLUMNS followed with D20's fourth child (t229),
 * and `SkillRow` followed them with t289: it is the row as the driver hands it
 * over, spelled the way the columns are, and `hydrate` is what turns it into a
 * `Skill` — five `JSON.parse`s and one field whose column really is called
 * something else, where there used to be eleven aliases and a `toSkill` renaming
 * every field back.
 *
 * ## One row per `(id, version)` since t215 (D22)
 *
 * The registry used to be create-only, one row per id, ever — and the reason it
 * was is written in `migrations/0005_skill.sql`: version history for a skill was
 * deferred by the rule of two consumers. D22 is the decision that arrived with
 * them, and it says what the shape has to be: "skill tem id estável e versões
 * (semver + hash de conteúdo)... o nó continua pinado por hash (D4) e nunca
 * resolve 'a mais recente'".
 *
 * Three rules follow from that sentence, and every function below is one of them:
 *
 * - **the write is content-addressed per version.** Same `(id, version)` and the
 *   same `hash` is the SAME registration, answered with the row that is already
 *   there — that is what makes reimporting a bundle safe. Same `(id, version)`
 *   and a DIFFERENT `hash` is a refusal, because one pin naming two different
 *   bodies is exactly the thing pinning by hash exists to prevent;
 * - **"latest" is a convenience, never a resolution.** {@link getSkill} with no
 *   options answers the newest live version, and that read exists for a person
 *   or a synthesizer choosing what to pin. Nothing that EXECUTES uses it: the
 *   runner asks by `(id, version)`, off the frozen snapshot;
 * - **nothing is ever removed.** {@link deprecateSkill} stamps a version as
 *   retired, which takes it out of "latest" and out of nothing else. A node
 *   pinned to it keeps resolving, because that is D22's own promise: improving a
 *   skill never breaks a map that is pinned to it.
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
import { recheckContracts } from './graphs.ts';

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
   * English since t226: this was the ONE field the old `toSkill` still let
   * through with the column's own name, and the wire gate of D20's API child is
   * what found it. The COLUMN is `registered_at` since D20's fourth child
   * (t229), and since t289 every field around it reads that way too.
   */
  registered_at: string;
  /**
   * When this version was retired (t215, FR7), or `null` while it is live.
   *
   * Retired means "not what a new graph should pin", and nothing more: the row is
   * still served by every exact read, and the runner still dispatches on it.
   * Anything stronger would be withdrawing a version graphs already point at,
   * which append-only persistence does not do (D15) and which D22 forbids by
   * name: improving a skill never breaks a map pinned to it.
   */
  deprecated_at: string | null;
}

/**
 * The row as SQLite returns it: the column names, with the JSON still in TEXT.
 *
 * Every field is the column's own name, so {@link COLUMNS} needs no alias — with
 * one exception the schema itself imposes. The column behind `origin` is called
 * `source` (`migrations/0005_skill.sql`), and the manifest field it carries is
 * called `origin` (`manifesto-skill.schema.json`), so those two names are
 * genuinely different words for one thing. {@link hydrate} is where they meet,
 * because aliasing the column onto `origin` in the query would hide a real
 * difference behind the same mechanism t289 exists to delete.
 */
interface SkillRow {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  input: string;
  output: string;
  preconditions: string;
  checks: string;
  permissions: string;
  instructions: string;
  source: string;
  registered_at: string;
  deprecated_at: string | null;
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

/*
 * `role` used to be the one value this boundary carried across.
 *
 * `migrations/0005_skill.sql` puts a `CHECK` on the column, which made the
 * Portuguese values part of the DB schema rather than of the format, and a
 * manifest that said `work` was stored as `fazer`. D20's fourth child (t229)
 * renamed the column and its fifth (t235) rewrote the `CHECK` to
 * `('work', 'gate')` — the manifest's own two words, which the graph document
 * already spelled that way in `node_type`. Every other column is either free
 * text or JSON, so with that pair gone the boundary carries no value at all.
 */

const COLUMNS = `
  id, version, hash, role, description, input, output, preconditions,
  checks, permissions, instructions, source, registered_at, deprecated_at
`;

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The one parse between `skill` and the rest of the package.
 *
 * Five of the columns are JSON in TEXT, and a bare cast would hand a string to a
 * caller whose type says object — the same trap `repositories/graphs.ts` avoids
 * for `snapshot` and `contracts_report`. The sixth line that does anything is
 * `origin`, which reads the `source` column; see {@link SkillRow} for why that
 * one difference is real and not a leftover translation.
 *
 * @param row Row as the driver returned it.
 * @returns The manifest, with every JSON column parsed.
 */
function hydrate(row: SkillRow): Skill {
  // `source` is destructured OUT before the spread, and it has to be: a spread
  // copies what the driver returned, so leaving it in would publish the column's
  // name beside `origin` on every skill the API serves.
  const { source, ...rest } = row;
  return {
    ...rest,
    input: JSON.parse(row.input) as Record<string, unknown>,
    output: JSON.parse(row.output) as Record<string, unknown>,
    preconditions: JSON.parse(row.preconditions) as string[],
    checks: JSON.parse(row.checks) as Record<string, unknown>[],
    permissions: JSON.parse(row.permissions) as Record<string, unknown>,
    origin: JSON.parse(source) as Record<string, unknown>,
  };
}

/**
 * Orders two versions the way semver does, over the numeric triple (t215).
 *
 * Written here, small, instead of pulled in as a dependency or exported from
 * `domain/manifest.ts`: `VERSION_PATTERN` is already the strict `x.y.z` with no
 * pre-release suffix and no build metadata, so the whole of semver's ordering
 * that can ever apply to a registered version is three integers compared in
 * order. Nothing else in the package needs it, and a comparator with one caller
 * belongs next to that caller.
 *
 * String comparison is what this replaces and what it must never become: `'1.9.0'
 * > '1.10.0'` lexically, so a lineage that reached ten minor versions would start
 * offering the ninth as its newest.
 *
 * @param a One version, matching `VERSION_PATTERN`.
 * @param b The other.
 * @returns Negative when `a` is older, positive when newer, 0 when equal.
 */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
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

/** What {@link registerSkill} did, so the route can answer 201 or 200 (t215, FR2). */
export interface Registration {
  /** The stored version — the one that was written, or the one already there. */
  skill: Skill;
  /** `true` when a row came into being; `false` for an idempotent reimport. */
  created: boolean;
}

/**
 * Registers a manifest, after re-verifying it from scratch (FR3; t215 FR2).
 *
 * Content-addressed per version. The key is `(id, version)`, and what the
 * registry does with a key it already has is decided by the CONTENT:
 *
 * - **no row** → an INSERT, and `created: true`. Whether this is the first
 *   version of a lineage or its tenth is not this function's business: a version
 *   is a row, and a lineage is the rows that share an id;
 * - **a row with the same `hash`** → nothing is written, and the row that is
 *   already there comes back with `created: false`. This is what makes the second
 *   `cartografo import` of a bundle a no-op instead of a failure, and it is
 *   deliberately not an UPDATE: the fields OUTSIDE the content hash
 *   (`description`, `origin`) keep the values they were registered with, because
 *   a repeated write is not a revision, and a revision of a registered version is
 *   what the next bullet refuses;
 * - **a row with a DIFFERENT `hash`** → refused. One `(id, version)` naming two
 *   different bodies is precisely what pinning by hash exists to prevent (D4):
 *   every graph pinned to that version would silently start running content
 *   nobody approved. The way through is a new version, and the message says so.
 *
 * @param db Open handle.
 * @param manifest The submitted manifest.
 * @returns The stored version, and whether this call is what stored it.
 * @throws {SkillRejected} 422 for an unverifiable manifest, 409 for content that
 *   moved under an unchanged version.
 */
export function registerSkill(db: Database, manifest: unknown): Registration {
  const problems = findProblems(manifest);
  if (problems.length > 0) throw new SkillRejected(422, 'manifest_rejected', problems);

  const verified = manifest as Record<string, unknown>;
  const id = verified.id as string;
  const version = verified.version as string;
  const hash = verified.hash as string;

  const existing = getSkill(db, id, { version });
  if (existing !== null) {
    if (existing.hash === hash) return { skill: existing, created: false };
    throw new SkillRejected(409, 'skill_version_conflict', [
      `skill "${id}" version ${version} is already registered with hash ${existing.hash}, and this ` +
        `manifest carries ${hash} — one version cannot name two different bodies (D4): bump the ` +
        'version instead',
    ]);
  }

  const timestamp = now();

  // One transaction, where there used to be a bare INSERT (t283). The write is
  // no longer alone: a manifest arriving is what un-blocks every graph version
  // that pinned it and could not be checked, and the row, those versions and
  // their events have to land together — a registry that recorded a skill while
  // the re-check rolled back would leave versions `unchecked` with nothing left
  // to trigger them.
  db.transaction(() => {
    db.prepare(
      `INSERT INTO skill (
         id, version, hash, role, description, input, output, preconditions,
         checks, permissions, instructions, source, registered_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      version,
      hash,
      verified.role as string,
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

    // Only on this branch, which is the one that WROTE something. A same-hash
    // reimport returned above without reaching here: nothing about the registry
    // changed, so no version's answer could have changed either, and re-checking
    // would be a stack of `graph_version.contracts_checked` events saying the
    // same thing on every rerun of `cartografo import`.
    recheckContracts(db, { id, version }, (ref) => {
      const skill = getSkill(db, ref.id, { version: ref.version });
      return skill === null ? undefined : { input: skill.input, output: skill.output };
    }, timestamp);
  })();

  return { skill: getSkill(db, id, { version }) as Skill, created: true };
}

/** Which version of a lineage a read is asking for (t215, FR3). */
export interface SkillSelector {
  /** An exact version. Nothing is inferred: absent means "the newest live one". */
  version?: string;
  /** The pin, resolved inside the lineage — what a node actually carries. */
  hash?: string;
}

/**
 * Gets one version of a registered skill (t215, FR3).
 *
 * Three reads, and the difference between them is which of them may resolve
 * "forward":
 *
 * - **`{version}`** — the exact row, or `null`. This is the read that keeps a
 *   frozen graph running: `null` here means the lineage does not carry that
 *   version, never "here is a newer one";
 * - **`{hash}`** — the row of this lineage carrying that pin, or `null`. Same
 *   promise, reached from what the graph document actually stores. Two versions
 *   of a lineage may legally share a hash (the content hash excludes `version`),
 *   so the newest of the matches answers — deterministically, and it is the same
 *   content either way, which is the whole point of a content hash;
 * - **no selector** — the newest LIVE version, for a person or a synthesizer
 *   choosing what to pin. If every version has been retired it answers the
 *   newest overall rather than `null`: a lineage nobody should pin any more is
 *   still a lineage that exists, and answering 404 would make a deprecation
 *   indistinguishable from an unregistered skill.
 *
 * @param db Open handle.
 * @param id Skill id (the manifest's own kebab-case identifier).
 * @param selector Which version; absent selects the newest live one.
 * @returns The version, or `null` when the lineage does not carry it.
 */
export function getSkill(db: Database, id: string, selector: SkillSelector = {}): Skill | null {
  if (selector.version !== undefined) {
    const row = db
      .prepare(`SELECT ${COLUMNS} FROM skill WHERE id = ? AND version = ?`)
      .get(id, selector.version) as SkillRow | undefined;
    return row === undefined ? null : hydrate(row);
  }

  // Ordered in JS and not in SQL, and it has to be: `version` is TEXT, and
  // SQLite would sort `1.10.0` before `1.9.0`.
  const versions = lineage(db, id);
  if (versions.length === 0) return null;

  if (selector.hash !== undefined) {
    const matching = versions.filter((skill) => skill.hash === selector.hash);
    return matching.length === 0 ? null : matching[matching.length - 1];
  }

  const live = versions.filter((skill) => skill.deprecated_at === null);
  const candidates = live.length > 0 ? live : versions;
  return candidates[candidates.length - 1];
}

/** Every version of one lineage, oldest first. */
function lineage(db: Database, id: string): Skill[] {
  const rows = db.prepare(`SELECT ${COLUMNS} FROM skill WHERE id = ?`).all(id) as SkillRow[];
  return rows.map(hydrate).sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Retires one version of a lineage (t215, FR7).
 *
 * First write wins, the same posture `registered_at` has: retiring something
 * twice does not move when it happened, and a second call is not an error — it
 * is somebody confirming a decision that was already taken.
 *
 * @param db Open handle.
 * @param id Skill id.
 * @param version The exact version to retire.
 * @returns The version, retired; `null` when the lineage does not carry it.
 */
export function deprecateSkill(db: Database, id: string, version: string): Skill | null {
  const existing = getSkill(db, id, { version });
  if (existing === null) return null;
  if (existing.deprecated_at !== null) return existing;

  db.prepare('UPDATE skill SET deprecated_at = ? WHERE id = ? AND version = ?').run(
    now(),
    id,
    version,
  );
  return getSkill(db, id, { version });
}

/**
 * The registry, or one lineage of it — what a capability reader consults.
 *
 * One entry per `(id, version)`, and deliberately FLAT: a nested
 * "lineage → versions" envelope would be a wire change for every existing
 * consumer of this list, in exchange for a grouping any of them can do in one
 * pass. Ordered by id, then by version, so the newest version of each lineage is
 * the last of its run.
 *
 * @param db Open handle.
 * @param filter `id` narrows the answer to one lineage.
 * @returns Registered versions.
 */
export function listSkills(db: Database, filter: { id?: string } = {}): Skill[] {
  if (filter.id !== undefined) return lineage(db, filter.id);

  const rows = db.prepare(`SELECT ${COLUMNS} FROM skill ORDER BY id`).all() as SkillRow[];
  return rows
    .map(hydrate)
    .sort((a, b) => (a.id === b.id ? compareVersions(a.version, b.version) : a.id < b.id ? -1 : 1));
}
