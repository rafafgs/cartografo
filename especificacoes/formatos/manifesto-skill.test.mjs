/**
 * Contract tests of the skill-manifest format (t163, AT1).
 *
 * Until this file existed, the four validation commands of
 * `manifesto-skill.md` § "Como validar" were prose: a human had to remember to
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
 * English identifiers per D18; the manifest's own keys are data and stay in
 * Portuguese.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

const SCHEMA_PATH = fileURLToPath(new URL('./manifesto-skill.schema.json', import.meta.url));
const DOC_PATH = fileURLToPath(new URL('./manifesto-skill.md', import.meta.url));
const EXAMPLES_DIR = new URL('./exemplos/', import.meta.url);

/** The two examples the document lists as complete manifests. */
const EXAMPLES = ['manifesto-skill.develop.json', 'manifesto-skill.verificacao-develop.json'];

/** The negative fixture: material of test, never an example (see the doc). */
const NEGATIVE = 'manifesto-skill.invalido.fixture.json';

/**
 * The subset the pin covers, in the document's own order.
 *
 * `orcamentos` joined it in t163 for the reason `permissoes` is already there:
 * it is behaviour-affecting, and D4's whole point is that behaviour cannot move
 * without the hash moving with it.
 */
const PINNED_FIELDS = ['instrucoes', 'entrada', 'saida', 'checks', 'permissoes', 'orcamentos'];

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

/** A valid manifest with `orcamentos` replaced by whatever the case is about. */
function withBudgets(budgets) {
  const manifest = example(EXAMPLES[1]);
  if (budgets === undefined) delete manifest.orcamentos;
  else manifest.orcamentos = budgets;
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
    validate.errors.some(
      (error) => error.params?.missingProperty === 'evidencia_obrigatoria',
    ),
    'the refusal has to point at the missing evidencia_obrigatoria, not at some other field: ' +
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
  assert.ok(recipe, 'the bash recipe of the hash was not found in manifesto-skill.md');
  const named = [...recipe[1].matchAll(/(\w+)\s*:\s*m\./g)].map((match) => match[1]);
  assert.deepEqual(
    [...named].sort(),
    [...PINNED_FIELDS].sort(),
    'the recipe in the doc and the subset this test pins have drifted apart',
  );
});

test('orcamentos accepts a partial declaration', () => {
  const validate = compileSchema();
  for (const budgets of [{ tempo_esgotado_s: 5400 }, { silencio_s: 900 }, {}]) {
    assert.ok(
      validate(withBudgets(budgets)),
      `orcamentos: ${JSON.stringify(budgets)} was refused: ${JSON.stringify(validate.errors)}`,
    );
  }
});

test('orcamentos refuses a non-positive budget', () => {
  const validate = compileSchema();
  for (const budgets of [{ tempo_esgotado_s: 0 }, { silencio_s: 0 }, { silencio_s: -1 }]) {
    assert.equal(
      validate(withBudgets(budgets)),
      false,
      `orcamentos: ${JSON.stringify(budgets)} was accepted — a budget of zero is not a budget`,
    );
  }
});

test('orcamentos refuses an unknown key', () => {
  const validate = compileSchema();
  assert.equal(
    validate(withBudgets({ silencio_s: 900, silencio_ms: 900_000 })),
    false,
    'an unknown budget key was accepted; a typo has to be refused, never ignored',
  );
});

test('a manifest that declares no orcamentos at all is still valid', () => {
  const validate = compileSchema();
  const manifest = withBudgets(undefined);
  assert.ok(!('orcamentos' in manifest), 'the fixture itself has to carry no orcamentos');
  assert.ok(validate(manifest), `refused: ${JSON.stringify(validate.errors)}`);
});
