/**
 * Skill manifest: the field vocabulary and the content hash (t117, FR2).
 *
 * This module exists because the same procedure now has TWO callers that must
 * never disagree: the bundle check of `cartografo import` (which refuses a
 * broken pin before anything is sent over the network) and the registry's own
 * validator (which re-verifies the pin at registration, D4). Two copies of a
 * hash procedure is two hashes waiting to drift, and a pin that can drift is not
 * a pin.
 *
 * Nothing here reaches the database or the network — it is pure computation over
 * an already-parsed manifest, which is what lets the CLI (an unprivileged HTTP
 * client, D1/D11) and the control plane share it without sharing anything else.
 *
 * The field names are the skill-manifest format's own, and they are English
 * since the 2026-08-15 amendment to D18 (`DECISIONS.md`, D18 amendment): the
 * original decision carved data-format keys out of the rename, and that
 * amendment closed the gap. `packages/core/test/domain-manifest-fields.test.ts`
 * pins the list below against the schema's own `required`, so the port cannot
 * drift from the format it ports.
 */

import { createHash } from 'node:crypto';

// The named export, not the default one: `ajv/dist/2020.js` is CommonJS, and
// only the named binding resolves the same way under Node's ESM loader and
// under `moduleResolution: nodenext` (`tsconfig.base.json` sets no
// `esModuleInterop`). The `/dist/2020` entry point is draft 2020-12's; the
// package's own root entry is draft-07, which is the version Fastify already
// carries and the reason `routes/graphs.ts` never reached for it.
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import { canonicalize, HASH_PREFIX } from './hash.ts';

/** Fields every manifest declares (`required` of the t97 schema). */
export const MANIFEST_FIELDS = [
  'id',
  'version',
  'hash',
  'role',
  'description',
  'input',
  'output',
  'preconditions',
  'checks',
  'permissions',
  'instructions',
  'origin',
];

/** `id` is kebab-case and unique in the registry. */
export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `version` is semver, three numeric parts. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** `hash` is the algorithm prefix plus 64 hex characters — the pin's shape (D4). */
export const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

/** `role`: produces an artifact, or checks another node's artifact. */
export const MANIFEST_ROLES = ['work', 'gate'];

/**
 * Content hash of a skill manifest, by the procedure of
 * `specs/formats/skill-manifest.md`: sha256 of the canonical JSON of
 * `{instructions, input, output, checks, permissions, budgets, command}`.
 *
 * It covers only that subset — and not the whole manifest, as the graph version
 * hash does — because catalogue metadata (`id`, `version`, `description`,
 * `origin`) must not invalidate a pin: renaming the skill does not change what
 * it does. The practical consequence at the import gate is worth stating: the
 * reviewer's signature (`origin.reviewed_by`) lands OUTSIDE the hash, so signing
 * an approved manifest never invalidates the pin the reviewer just approved.
 *
 * `budgets` joined the subset in t163 for the reason `permissions` was always in
 * it: a watchdog budget is a declaration of behaviour, and behaviour may not
 * move without the pin moving with it. Growing the subset costs nothing to the
 * manifests already registered — an absent key serializes to nothing, because
 * `JSON.stringify` drops a key whose value is `undefined` — so only a manifest
 * that actually declares budgets gets a different hash than it had.
 *
 * `command` joined it in t332, under the same rule and with the highest stake of
 * the three. On a skill whose node runs on the `shell` engine, the argv is not a
 * declaration ABOUT the behaviour, it IS the behaviour: `instructions` there
 * documents the command for whoever reads the registry, and what executes is
 * `command.argv`. A subset without it would let the one field that decides what
 * runs move under a pin somebody already approved — which is precisely the
 * tamper D4 exists to catch. It is `env_allowlist`'s reason too: which of the
 * runner's environment variables a command may read is a permission, and
 * permissions have been inside this subset from the beginning.
 *
 * The KEY NAMES are part of what is hashed, so t178's rename moved every pin in
 * the repository at once. That is the mechanical, expected consequence of
 * renaming a key in a content-addressed format, and the reason every hash in
 * both factory bundles was recomputed in the same commit.
 *
 * @param manifest Already parsed manifest.
 * @returns `sha256:` followed by 64 hex characters.
 */
export function manifestHash(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `${HASH_PREFIX}${digest}`;
}

/* -------------------------------------------------------------------------- */
/* Runtime JSON-Schema validation (t253, FR5).                                 */
/*                                                                            */
/* The first place this package validates an ARBITRARY, caller-declared schema */
/* at request time, and the reason `ajv` finally enters as a real dependency.  */
/* `db/event-validation.ts:9` named this as another ticket's decision, and this */
/* is that ticket — scoped to exactly one validation. The fixed envelope of the */
/* event log stays hand-ported there, deliberately: it validates ten formats    */
/* that fit in one table, and its whole value is being a mirror somebody reads. */
/*                                                                            */
/* It lives HERE, beside the manifest's other rules, because what it is pointed */
/* at is a manifest field: `skill.output`, the schema a node's self-report has  */
/* to match (D9). Still pure — no database, no clock, no network.              */
/* -------------------------------------------------------------------------- */

/**
 * The compiler, built once and reused.
 *
 * Draft 2020-12, which is what every schema in this repository declares
 * (`schema/graph.schema.json`, `specs/events/schemas/*`, and the
 * `input`/`output` of all twelve registered manifests).
 *
 * `strict: false` is not laziness: a registered manifest's `output` is a
 * document a third party wrote, `skill-manifest.md`'s *Limites conhecidos*
 * says out loud that the registry only checks it is an OBJECT, and ajv's strict
 * mode turns an unknown keyword or an unknown `format` into a COMPILATION
 * error. Refusing to compile is not a verdict about the reported value — it
 * would turn somebody else's loose schema into this session's problem.
 *
 * `allErrors` because the caller gets the whole list or fixes one thing at a
 * time, the same reasoning `validateEvent` writes for its own report.
 */
const compiler = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });

/**
 * A cache keyed by the schema's canonical serialization.
 *
 * Compiling is the expensive half, and the same node's `output` schema is
 * validated once per session it closes. The key is the canonical JSON rather
 * than the object identity because the schema is read out of the database and
 * parsed afresh on every call — object identity would never hit.
 */
const compiled = new Map<string, ((value: unknown) => boolean) | null>();

/** One ajv error, as a sentence somebody can act on. */
function describe(error: ErrorObject): string {
  const where = error.instancePath === '' ? 'output' : `output${error.instancePath}`;
  return `${where} ${error.message ?? 'does not match the schema'}`;
}

/**
 * Checks a value against a JSON Schema, and reports every reason it does not fit.
 *
 * Three answers, and the middle one is the subtle one:
 *
 * - **`[]`** — the value matches, or there is nothing to match it against;
 * - **`[]` for a schema that will not compile** — deliberately the SAME answer.
 *   A skill whose `output` is an object but not a usable JSON Schema is a
 *   documented, expected state of the registry, and it is not a fact about the
 *   value being reported. Treating it as a mismatch would throw away a
 *   legitimate self-report because of somebody else's manifest;
 * - **a non-empty list** — the value was checked and it does not fit. Every
 *   reason, not the first.
 *
 * @param schema The JSON Schema to check against, as it was registered.
 * @param value The value being judged.
 * @returns One sentence per problem; empty when there is nothing to report.
 */
export function validateAgainstJsonSchema(schema: unknown, value: unknown): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [];

  const key = JSON.stringify(canonicalize(schema));
  let validate = compiled.get(key);
  if (validate === undefined) {
    try {
      validate = compiler.compile(schema as Record<string, unknown>) as (
        candidate: unknown,
      ) => boolean;
    } catch {
      validate = null;
    }
    compiled.set(key, validate);
  }
  if (validate === null) return [];

  if (validate(value)) return [];
  const errors = (validate as unknown as { errors?: ErrorObject[] | null }).errors ?? [];
  // A validator that said "no" and then reported nothing would leave the caller
  // with an empty list, which this function's contract reads as "it fits".
  return errors.length === 0 ? ['output does not match the schema'] : errors.map(describe);
}
