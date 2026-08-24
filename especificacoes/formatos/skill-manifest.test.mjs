/**
 * Contract tests of the skill-manifest format (t163, AT1).
 *
 * Until this file existed, the four validation commands of
 * `skill-manifest.md` § "Como validar" were prose: a human had to remember to
 * run four `npx ajv-cli` lines by hand, and nothing in `npm test` would notice a
 * schema that stopped compiling or an example that stopped validating. This file
 * IS those four commands, plus the two claims the document makes that no ajv run
 * could ever check — that each example's committed `hash` reproduces its own
 * content, and that the pinned subset is the one the document's recipe names.
 *
 * ajv is used directly instead of through `npx ajv-cli`: a gate that reaches the
 * network to run is a gate that is red on a plane. Same validator, same draft.
 *
 * `strict: false` mirrors what the document's own commands get: `ajv-cli@5`
 * without a formats plugin, over a schema that deliberately uses `pattern`
 * instead of `"format": "date"` for exactly that reason (see *Limites
 * conhecidos*). Nothing here depends on strict-mode diagnostics; what is being
 * checked is acceptance and refusal.
 *
 * English identifiers per D18 — and, since the 2026-08-15 amendment (t178), the
 * manifest's own KEYS too: the carve-out that used to leave data-format keys in
 * Portuguese is exactly what that amendment lifted. `additionalProperties:
 * false` is what turns the rename into a one-way door, and the last test here is
 * what proves it: a manifest carrying any single old key is refused like any
 * other unknown key, with no dual-key window.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

const SCHEMA_PATH = fileURLToPath(new URL('./skill-manifest.schema.json', import.meta.url));
const DOC_PATH = fileURLToPath(new URL('./skill-manifest.md', import.meta.url));
const EXAMPLES_DIR = new URL('./exemplos/', import.meta.url);

/** The two examples the document lists as complete manifests. */
const EXAMPLES = ['skill-manifest.develop.json', 'skill-manifest.verify-develop.json'];

/** The negative fixture: material of test, never an example (see the doc). */
const NEGATIVE = 'skill-manifest.invalid.fixture.json';

/**
 * The subset the pin covers, in the document's own order.
 *
 * `budgets` joined it in t163 for the reason `permissions` is already there: it
 * is behaviour-affecting, and D4's whole point is that behaviour cannot move
 * without the hash moving with it.
 */
const PINNED_FIELDS = ['instructions', 'input', 'output', 'checks', 'permissions', 'budgets'];

/**
 * Every key the rename retired, with the new name it answers to (t178).
 *
 * The map is the test's, not the schema's: it is what lets the last test feed
 * the schema a manifest that is correct in every way EXCEPT one key, one key at
 * a time, and demand a refusal for each.
 */
const RETIRED_KEYS = Object.freeze({
  versao: 'version',
  papel: 'role',
  descricao: 'description',
  entrada: 'input',
  saida: 'output',
  pre_condicoes: 'preconditions',
  permissoes: 'permissions',
  orcamentos: 'budgets',
  instrucoes: 'instructions',
  origem: 'origin',
});

/**
 * Every retired name the DOCUMENT may still be caught citing, and its new one.
 *
 * Wider than `RETIRED_KEYS` because the doc quotes more than the manifest's own
 * top level: the nested permission axes, and the node-contract and routing names
 * that live in the graph schema (`docs/spec/graph.md`) but are cited here where
 * *Renderização e injeção* says what else the runner injects.
 *
 * The rename left free-text prose in Portuguese on purpose — what a backtick
 * quotes is not prose, it is a name, and a name the schema no longer declares is
 * a spec describing a format nobody implements (t184).
 */
const RETIRED_CITATIONS = Object.freeze({
  ...RETIRED_KEYS,
  // The axes inside `permissions`.
  leitura: 'read',
  escrita: 'write',
  rede: 'network',
  permitido: 'allowed',
  dominios: 'domains',
  // The node's own contract and the routing vocabulary, from the graph schema.
  entrada_schema: 'input_schema',
  saida_schema: 'output_schema',
  verificacoes: 'checks',
  condicao: 'condition',
  resultado: 'outcome',
});

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const example = (name) => readJson(fileURLToPath(new URL(name, EXAMPLES_DIR)));

/** RFC 8785-ish canonicalization: keys sorted, no insignificant whitespace. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = canonical(value[key]);
        return sorted;
      }, {});
  }
  return value;
}

/**
 * The pin, recomputed from the content — the document's bash recipe, in JS.
 *
 * An absent field serializes to nothing: `JSON.stringify` drops a key whose
 * value is `undefined`, which is what lets the subset grow without touching the
 * hash of a manifest that declares nothing new.
 */
function manifestHash(manifest) {
  const subset = {};
  for (const field of PINNED_FIELDS) subset[field] = manifest[field];
  const digest = createHash('sha256')
    .update(JSON.stringify(canonical(subset)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function compileSchema() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(readJson(SCHEMA_PATH));
}

/** A valid manifest with `budgets` replaced by whatever the case is about. */
function withBudgets(budgets) {
  const manifest = example(EXAMPLES[1]);
  if (budgets === undefined) delete manifest.budgets;
  else manifest.budgets = budgets;
  return manifest;
}

test('the schema compiles as a draft 2020-12 document', () => {
  assert.doesNotThrow(() => compileSchema());
});

test('both examples validate against the schema', () => {
  const validate = compileSchema();
  for (const name of EXAMPLES) {
    assert.ok(
      validate(example(name)),
      `${name} does not validate: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('the negative fixture is refused, and for its one deliberate violation', () => {
  const validate = compileSchema();
  assert.equal(validate(example(NEGATIVE)), false, `${NEGATIVE} was accepted by the schema`);
  assert.ok(
    validate.errors.some((error) => error.params?.missingProperty === 'required_evidence'),
    'the refusal has to point at the missing required_evidence, not at some other field: ' +
      JSON.stringify(validate.errors),
  );
});

test("each example's committed hash reproduces its own content", () => {
  for (const name of EXAMPLES) {
    const manifest = example(name);
    assert.equal(
      manifest.hash,
      manifestHash(manifest),
      `${name}: the committed pin does not match the canonical subset — ` +
        'a manifest whose hash does not match its content is a tampered manifest (D4)',
    );
  }
});

test("the document's hash recipe names exactly the pinned subset", () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const recipe = /const sub=\{([\s\S]*?)\};/.exec(doc);
  assert.ok(recipe, 'the bash recipe of the hash was not found in skill-manifest.md');
  const named = [...recipe[1].matchAll(/(\w+)\s*:\s*m\./g)].map((match) => match[1]);
  assert.deepEqual(
    [...named].sort(),
    [...PINNED_FIELDS].sort(),
    'the recipe in the doc and the subset this test pins have drifted apart',
  );
});

test('budgets accepts a partial declaration', () => {
  const validate = compileSchema();
  for (const budgets of [{ timeout_s: 5400 }, { silence_s: 900 }, {}]) {
    assert.ok(
      validate(withBudgets(budgets)),
      `budgets: ${JSON.stringify(budgets)} was refused: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('budgets refuses a non-positive budget', () => {
  const validate = compileSchema();
  for (const budgets of [{ timeout_s: 0 }, { silence_s: 0 }, { silence_s: -1 }]) {
    assert.equal(
      validate(withBudgets(budgets)),
      false,
      `budgets: ${JSON.stringify(budgets)} was accepted — a budget of zero is not a budget`,
    );
  }
});

test('budgets refuses an unknown key', () => {
  const validate = compileSchema();
  assert.equal(
    validate(withBudgets({ silence_s: 900, silence_ms: 900_000 })),
    false,
    'an unknown budget key was accepted; a typo has to be refused, never ignored',
  );
});

test('a manifest that declares no budgets at all is still valid', () => {
  const validate = compileSchema();
  const manifest = withBudgets(undefined);
  assert.ok(!('budgets' in manifest), 'the fixture itself has to carry no budgets');
  assert.ok(validate(manifest), `refused: ${JSON.stringify(validate.errors)}`);
});

test('t178 — the schema declares the English key vocabulary and nothing else', () => {
  const schema = readJson(SCHEMA_PATH);

  assert.deepEqual(schema.required, [
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
  ]);
  assert.deepEqual(schema.properties.role.enum, ['work', 'gate']);
  assert.deepEqual(schema.$defs.check.required, ['id', 'type', 'description']);
  assert.deepEqual(schema.$defs.check.properties.type.enum, ['deterministic', 'agentic']);
  assert.deepEqual(schema.$defs.permissions.required, ['filesystem', 'network']);
  assert.deepEqual(schema.$defs.permissions.properties.filesystem.required, ['read', 'write']);
  assert.deepEqual(schema.$defs.origin.properties.type.enum, ['native', 'imported']);

  for (const retired of Object.keys(RETIRED_KEYS)) {
    assert.ok(
      !Object.hasOwn(schema.properties, retired),
      `the schema still declares the retired key "${retired}"`,
    );
  }
});

test('t178 — a manifest that still uses any single old key is refused', () => {
  const validate = compileSchema();
  const valid = example(EXAMPLES[1]);
  assert.ok(validate(valid), `the baseline stopped validating: ${JSON.stringify(validate.errors)}`);

  // `budgets` is the one optional field in the map, and the example declares
  // none — so it is supplied here rather than skipped: an optional key that is
  // still spelled the old way has to be refused exactly like a required one.
  const IF_ABSENT = { budgets: { timeout_s: 1800 } };

  let checked = 0;
  for (const [old, current] of Object.entries(RETIRED_KEYS)) {
    const manifest = example(EXAMPLES[1]);
    if (!Object.hasOwn(manifest, current)) {
      assert.ok(
        Object.hasOwn(IF_ABSENT, current),
        `the example does not carry "${current}", so this case would prove nothing`,
      );
      manifest[current] = IF_ABSENT[current];
    }
    manifest[old] = manifest[current];
    delete manifest[current];
    checked += 1;

    assert.equal(
      validate(manifest),
      false,
      `"${old}" was accepted in place of "${current}": additionalProperties has to close the door`,
    );
    assert.ok(
      validate.errors.some(
        (error) =>
          error.params?.additionalProperty === old || error.params?.missingProperty === current,
      ),
      `the refusal of "${old}" has to name it, or name the "${current}" it left missing: ${JSON.stringify(
        validate.errors,
      )}`,
    );
  }
  assert.equal(checked, Object.keys(RETIRED_KEYS).length, 'every retired key has to be exercised');
});

/** Every inline `code` span of a markdown text, with its 1-based line. */
function inlineCodeSpans(markdown) {
  return markdown.split('\n').flatMap((line, index) =>
    [...line.matchAll(/`([^`\n]+)`/g)].map((match) => ({ line: index + 1, text: match[1] })),
  );
}

/** The retired names one span quotes, in the order it quotes them. */
function retiredNamesIn(text) {
  return text.split(/[^A-Za-z0-9_]+/).filter((token) => Object.hasOwn(RETIRED_CITATIONS, token));
}

test('t184 — the document quotes no name the rename retired', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');

  const stale = inlineCodeSpans(doc).flatMap(({ line, text }) =>
    retiredNamesIn(text).map(
      (old) => `skill-manifest.md:${line} — \`${text}\`: "${old}" is now "${RETIRED_CITATIONS[old]}"`,
    ),
  );

  assert.deepEqual(
    stale,
    [],
    'the spec still cites pre-rename names. Prose stays Portuguese; a backticked ' +
      `name is not prose, and one the schema no longer declares is a lie:\n${stale.join('\n')}`,
  );
});

test('t184 — the citation scan bites, and spares what was never a format key', () => {
  assert.deepEqual(retiredNamesIn('escrita: []'), ['escrita']);
  assert.deepEqual(retiredNamesIn('rede.permitido: true'), ['rede', 'permitido']);
  assert.deepEqual(retiredNamesIn('network.allowed: true'), []);
  // `entrada` is retired AND is a prefix of `entrada_schema`: each answers for
  // itself, or a corrected `input_schema` would keep being reported as the old
  // `entrada` and a corrected `entrada` would hide a stale `entrada_schema`.
  assert.deepEqual(retiredNamesIn('entrada_schema'), ['entrada_schema']);
  assert.deepEqual(retiredNamesIn('input_schema'), []);
  // The examples' own domain fields are not this format's keys: they stay put.
  assert.deepEqual(retiredNamesIn('artefato.gates_declarados'), []);
  assert.deepEqual(retiredNamesIn('{{input.projeto.comando_testes}}'), []);
  assert.deepEqual(retiredNamesIn('packages/runner/src/engine/permission-policy.ts'), []);
});
