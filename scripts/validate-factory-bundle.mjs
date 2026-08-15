/**
 * Factory bundle validator (t105).
 *
 * A bundle is a directory with a `grafo.json` and a `skills/` directory of
 * manifests. This module checks the three things that make it a sound bundle
 * rather than a handful of JSON files in the same place:
 *
 * 1. **The graph is valid and sound** — delegated to `scripts/validar-grafo.mjs`
 *    (t96), which is where the four workflow-net rules live.
 * 2. **Each manifest validates against the format's schema** — t97's schema,
 *    `especificacoes/formatos/manifesto-skill.schema.json`.
 * 3. **Each pin closes** — for every graph node there is a manifest with the
 *    same `id` and the same `versao`, and the recomputed hash of the content
 *    matches what the node's `skill_ref` pins (D4). It is this third check that
 *    stops a skill's content from being swapped silently under an
 *    already-validated graph — and it is the verifiable stand-in for "import it
 *    through the API" while the control plane does not exist (D6).
 * 4. **The two declarations of how a node verifies itself line up** (t176) —
 *    `contrato.verificacoes` in the graph and `checks` in the pinned manifest
 *    are two FORMATS for the same verification, so they have to state the same
 *    list: same item count, same sequence of `tipo`, same `comando` on every
 *    deterministic item. Without this, a bundle can ship a node whose graph
 *    says "run the test suite" and whose manifest says the opposite, and the
 *    runner has no way to know which of the two to apply.
 *
 * Zero dependencies: only Node built-ins. The embedded JSON Schema validator
 * deliberately covers only the subset of keywords the manifest schema uses
 * (local `$ref`, `type`, `enum`, `const`, `required`, `properties`,
 * `additionalProperties`, `items`, `pattern`, `minLength`, `minItems`,
 * `minimum`, `allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`) — full
 * validation by ajv arrives with the control plane's TypeScript scaffold. Until
 * then, the cross-check is the `ajv-cli` of t97's definition of done.
 *
 * The Portuguese keys this file reads (`nos`, `skill_ref`, `versao`, `hash`,
 * `instrucoes`, `permissoes`, …) are the graph-bundle and skill-manifest JSON
 * Schema, frozen by D18's own carve-out: this module reads that format, it does
 * not own it.
 *
 * CLI use: `node scripts/validate-factory-bundle.mjs <bundle-dir>`
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { validarGrafo } from './validar-grafo.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The manifest format's schema (t97). It is the normative definition. */
export const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

let manifestSchemaCache = null;

/** Reads the manifest schema once per process. */
function manifestSchema() {
  manifestSchemaCache ??= JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, 'utf8'));
  return manifestSchemaCache;
}

// --------------------------------------------------------------------------
// JSON Schema validation (subset — see the header)
// --------------------------------------------------------------------------

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`a non-local $ref is not supported: ${ref}`);
  let target = root;
  for (const part of ref.slice(2).split('/')) {
    target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (target === undefined) throw new Error(`$ref does not resolve: ${ref}`);
  return target;
}

function typeMatches(value, type) {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new Error(`unknown type in the schema: ${type}`);
  }
}

/**
 * Validates an instance against a schema, returning ALL the errors.
 *
 * @param {unknown} instance Document to validate.
 * @param {object} schema Schema (or subschema) to apply.
 * @param {object} [root] Root for resolving `$ref`; the schema itself by default.
 * @param {string} [pointer] JSON pointer of the instance, for the message.
 * @returns {Array<{pointer: string, message: string}>}
 */
export function validateAgainstSchema(instance, schema, root = schema, pointer = '') {
  const errors = [];
  const annotate = (message, where = pointer) => errors.push({ pointer: where || '/', message });

  if (schema === true || schema === undefined) return errors;
  if (schema === false) {
    annotate('no value is accepted here');
    return errors;
  }
  if (schema.$ref !== undefined) {
    return validateAgainstSchema(instance, resolveRef(schema.$ref, root), root, pointer);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(instance, type))) {
      annotate(
        `expected type ${types.join(' or ')}, got ${Array.isArray(instance) ? 'array' : typeof instance}`,
      );
      return errors; // Without the right type, the other keywords would only echo.
    }
  }

  if (schema.const !== undefined && JSON.stringify(instance) !== JSON.stringify(schema.const)) {
    annotate(`value has to be ${JSON.stringify(schema.const)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(instance))
  ) {
    annotate(`value outside the enum ${JSON.stringify(schema.enum)}`);
  }

  if (typeof instance === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      annotate(`string needs at least ${schema.minLength} character(s)`);
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      annotate(`string needs at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(instance)) {
      annotate(`string does not match the pattern ${schema.pattern}`);
    }
  }

  if (typeof instance === 'number') {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      annotate(`number has to be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && instance > schema.maximum) {
      annotate(`number has to be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      annotate(`list needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      annotate(`list needs at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set(instance.map((item) => JSON.stringify(item)));
      if (seen.size !== instance.length) annotate('list needs unique items');
    }
    if (schema.items !== undefined) {
      instance.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items, root, `${pointer}/${index}`));
      });
    }
  }

  if (isObject(instance)) {
    for (const field of schema.required ?? []) {
      if (!Object.hasOwn(instance, field)) annotate(`required field missing: "${field}"`);
    }
    const declared = Object.keys(schema.properties ?? {});
    for (const [key, value] of Object.entries(instance)) {
      if (declared.includes(key)) {
        errors.push(
          ...validateAgainstSchema(value, schema.properties[key], root, `${pointer}/${key}`),
        );
        continue;
      }
      if (schema.additionalProperties === false) {
        annotate(`field not declared by the schema: "${key}"`, `${pointer}/${key}`);
      } else if (isObject(schema.additionalProperties)) {
        errors.push(
          ...validateAgainstSchema(value, schema.additionalProperties, root, `${pointer}/${key}`),
        );
      }
    }
  }

  for (const sub of schema.allOf ?? []) {
    errors.push(...validateAgainstSchema(instance, sub, root, pointer));
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((sub) => validateAgainstSchema(instance, sub, root, pointer).length === 0)
  ) {
    annotate('no anyOf alternative was satisfied');
  }
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter(
      (sub) => validateAgainstSchema(instance, sub, root, pointer).length === 0,
    ).length;
    if (matched !== 1) {
      annotate(`oneOf has to match exactly one alternative, matched ${matched}`);
    }
  }
  if (
    schema.not !== undefined &&
    validateAgainstSchema(instance, schema.not, root, pointer).length === 0
  ) {
    annotate('the instance matches a schema that should exclude it');
  }
  if (schema.if !== undefined) {
    const branch =
      validateAgainstSchema(instance, schema.if, root, pointer).length === 0
        ? schema.then
        : schema.else;
    if (branch !== undefined) {
      errors.push(...validateAgainstSchema(instance, branch, root, pointer));
    }
  }

  return errors;
}

/**
 * Validates a skill manifest against the format's schema (t97).
 *
 * @param {unknown} manifest Manifest, already parsed.
 * @returns {{valid: boolean, errors: Array<{pointer: string, message: string}>}}
 */
export function validateManifest(manifest) {
  const errors = validateAgainstSchema(manifest, manifestSchema());
  return { valid: errors.length === 0, errors };
}

// --------------------------------------------------------------------------
// Canonical hash (D4)
// --------------------------------------------------------------------------

/** Sorts keys recursively — the part of RFC 8785 this format uses. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Content hash of the manifest, by the procedure in
 * `especificacoes/formatos/manifesto-skill.md`: sha256 of the canonical JSON of
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 *
 * What is left out (`id`, `versao`, `descricao`, `origem`) is catalogue
 * metadata: renaming the skill does not invalidate the pin, changing a line of
 * the instructions or loosening a check does.
 *
 * @param {object} manifest Manifest, already parsed.
 * @returns {string} `sha256:` followed by 64 hex characters.
 */
export function manifestHash(manifest) {
  const subset = {
    instrucoes: manifest.instrucoes,
    entrada: manifest.entrada,
    saida: manifest.saida,
    checks: manifest.checks,
    permissoes: manifest.permissoes,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

// --------------------------------------------------------------------------
// Graph ↔ manifest parity (t176)
// --------------------------------------------------------------------------

/**
 * The part of one verification that has to be identical on both sides.
 *
 * Reads an entry of the manifest's `checks` or of the graph's
 * `contrato.verificacoes` — the two spell `tipo` and `comando` the same way,
 * which is exactly the subset that carries the meaning of the verification.
 * Everything else is free to differ: `evidencia_obrigatoria` is a list of
 * artifacts in the manifest and the literal `true` in the graph, and the prose
 * of an agentic item is REWRITTEN in each format rather than copied — the
 * discipline `packages/runner/src/synthesizer/prompt.ts` states for the
 * synthesizer and `bets-assimetricas` already follows.
 *
 * @param {unknown} entry One check, or one verification.
 * @returns {{tipo: string|null, comando: string|null}}
 */
export function verificationShape(entry) {
  const kind = isObject(entry) && typeof entry.tipo === 'string' ? entry.tipo : null;
  const command = isObject(entry) && typeof entry.comando === 'string' ? entry.comando : null;
  return { tipo: kind, comando: kind === 'deterministico' ? command : null };
}

const sameShape = (left, right) =>
  JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

// --------------------------------------------------------------------------
// Bundle validation
// --------------------------------------------------------------------------

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Validates a whole factory bundle: graph, manifests and pins.
 *
 * Never throws on a malformed bundle — it returns a report, like t96's graph
 * validator: the caller needs the whole list of what is wrong, not the first
 * error.
 *
 * @param {string} bundleDir Directory with `grafo.json` and `skills/`.
 * @returns {{valid: boolean, bundle: string, errors: Array<{code: string, message: string}>,
 *            graph: object|null, manifests: Array<object>, pins: Array<object>}}
 */
export function validateBundle(bundleDir) {
  const bundle = path.resolve(bundleDir);
  const report = { valid: false, bundle, errors: [], graph: null, manifests: [], pins: [] };
  const annotate = (code, message) => report.errors.push({ code, message });

  let doc = null;
  const graphPath = path.join(bundle, 'grafo.json');
  try {
    doc = readJson(graphPath);
  } catch (error) {
    annotate('grafo_ilegivel', `could not read grafo.json — ${error.message}`);
  }

  if (doc !== null) {
    report.graph = validarGrafo(doc);
  }

  const skillsDir = path.join(bundle, 'skills');
  let files = [];
  try {
    files = readdirSync(skillsDir)
      .filter((name) => name.endsWith('.json') && statSync(path.join(skillsDir, name)).isFile())
      .sort();
  } catch (error) {
    annotate('skills_ilegivel', `could not list skills/ — ${error.message}`);
  }
  if (files.length === 0 && report.errors.length === 0) {
    annotate('skills_vazio', 'skills/ has no manifest at all');
  }

  const byId = new Map();
  for (const file of files) {
    const entry = { file, id: null, version: null, valid: false, errors: [] };
    report.manifests.push(entry);
    let manifest;
    try {
      manifest = readJson(path.join(skillsDir, file));
    } catch (error) {
      entry.errors.push({ pointer: '/', message: `not valid JSON — ${error.message}` });
      continue;
    }
    const { valid, errors } = validateManifest(manifest);
    entry.id = manifest?.id ?? null;
    entry.version = manifest?.versao ?? null;
    entry.valid = valid;
    entry.errors = errors;

    if (typeof manifest?.id === 'string') {
      if (byId.has(manifest.id)) {
        entry.errors.push({ pointer: '/id', message: `id repeated in the bundle: "${manifest.id}"` });
        entry.valid = false;
      } else {
        byId.set(manifest.id, { manifest, file });
      }
    }
    if (typeof manifest?.id === 'string' && manifest.id !== path.basename(file, '.json')) {
      entry.errors.push({
        pointer: '/id',
        message: `the id "${manifest.id}" has to be the file name without its extension`,
      });
      entry.valid = false;
    }
  }

  const pinned = new Set();
  for (const node of Array.isArray(doc?.nos) ? doc.nos : []) {
    const ref = isObject(node?.skill_ref) ? node.skill_ref : {};
    const pin = { node: node?.id ?? null, skill: ref.id ?? null, file: null, ok: true, problems: [] };
    report.pins.push(pin);
    const fail = (message) => {
      pin.ok = false;
      pin.problems.push(message);
    };

    const found = typeof ref.id === 'string' ? byId.get(ref.id) : undefined;
    if (!found) {
      fail(`no manifest in skills/ with id "${ref.id}"`);
      continue;
    }
    pinned.add(ref.id);
    pin.file = found.file;

    if (found.manifest.versao !== ref.versao) {
      fail(`pinned version ${ref.versao}, manifest ${found.manifest.versao}`);
    }
    const recomputed = manifestHash(found.manifest);
    if (recomputed !== ref.hash) {
      fail(`pinned hash ${ref.hash}, manifest content ${recomputed}`);
    }
    if (found.manifest.hash !== recomputed) {
      fail(`the manifest declares hash ${found.manifest.hash}, but its content is ${recomputed}`);
    }

    const declared = Array.isArray(node?.contrato?.verificacoes) ? node.contrato.verificacoes : [];
    const checks = Array.isArray(found.manifest.checks) ? found.manifest.checks : [];
    if (declared.length !== checks.length) {
      fail(
        `the node declares ${declared.length} verification(s) and the manifest ${checks.length} ` +
          'check(s): each verification restates one check, in the same order',
      );
    }
    checks.slice(0, declared.length).forEach((check, index) => {
      const expected = verificationShape(check);
      const actual = verificationShape(declared[index]);
      if (sameShape(actual, expected)) return;
      fail(
        `verification #${index + 1} does not restate check "${check?.id}": the node declares ` +
          `${JSON.stringify(actual)}, the manifest ${JSON.stringify(expected)}`,
      );
    });
  }

  for (const [id, { file }] of byId) {
    if (!pinned.has(id)) {
      annotate('manifesto_orfao', `${file}: no graph node pins the skill "${id}"`);
    }
  }

  report.valid =
    report.errors.length === 0 &&
    report.graph?.valido === true &&
    report.manifests.every((m) => m.valid) &&
    report.pins.every((p) => p.ok) &&
    report.pins.length > 0;

  return report;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function main(args) {
  if (args.length !== 1) {
    console.error('usage: node scripts/validate-factory-bundle.mjs <bundle-dir>');
    return 2;
  }
  const [target] = args;
  const report = validateBundle(target);
  const label = path.relative(ROOT, report.bundle) || report.bundle;

  if (report.valid) {
    console.log(
      `✔ ${label} — sound graph, ${report.manifests.length} valid manifest(s), ${report.pins.length} pin(s) checked`,
    );
    return 0;
  }

  console.error(`✖ ${label}`);
  for (const problem of report.errors) {
    console.error(`  bundle     ${problem.code}: ${problem.message}`);
  }
  for (const problem of report.graph?.estrutura.erros ?? []) {
    console.error(`  graph      structure ${problem.codigo}: ${problem.mensagem}`);
  }
  for (const violation of report.graph?.soundness.violacoes ?? []) {
    console.error(`  graph      soundness ${violation.regra}: ${JSON.stringify(violation.alvo)}`);
  }
  for (const manifest of report.manifests) {
    for (const problem of manifest.errors) {
      console.error(`  manifest   ${manifest.file} ${problem.pointer}: ${problem.message}`);
    }
  }
  for (const pin of report.pins) {
    for (const problem of pin.problems) {
      console.error(`  pin        node "${pin.node}" → skill "${pin.skill}": ${problem}`);
    }
  }
  return 1;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
