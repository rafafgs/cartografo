/**
 * Acceptance tests of the synthesis prompt (t115, AT2).
 *
 * The prompt is a pure function on purpose: it is the whole contract between us
 * and the copilot session (D10 — the synthesizer proposes, the human edits, and
 * the edit is the entire gate), and a contract that can only be read by opening
 * a session is a contract nobody reviews.
 *
 * Four things have to be in it, and each one is a requirement of the ticket:
 * the declaration as the user wrote it, the class name the user chose (D8 — the
 * command never invents one), the skill catalogue in enough detail to compose
 * nodes from it, and the similarity suggestions when there are any. Plus the
 * output contract: EXACTLY one fenced `grafo-proposto` block.
 *
 * The t138 block at the bottom adds the rule the alpha round caught missing:
 * `contrato.checks` carries at least one check. The session runs in an
 * empty temp directory and never sees `schema/graph.schema.json`, so a rule the
 * prompt does not state is a rule the session cannot follow — and the draft it
 * writes is refused by `cartografo import` after a person has already edited it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { ValidateFunction } from 'ajv';
// The NAMED export, not the default one `scripts/spike-real-session.mjs` uses:
// ajv ships CommonJS, this repository leaves `esModuleInterop` off, and under
// `module: NodeNext` a default import of a CJS module is typed as the whole
// `module.exports` — which is not constructable. `module.exports.Ajv2020` is set
// by the package for exactly this case.
import { Ajv2020 } from 'ajv/dist/2020.js';

import type * as PromptModule from '../../src/synthesizer/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const GRAPH_SCHEMA_PATH = path.join(REPO_ROOT, 'schema', 'graph.schema.json');
const MODULE_PATH = 'src/synthesizer/prompt.ts';

let cache: typeof PromptModule | null = null;

async function loadPrompt(): Promise<typeof PromptModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/prompt.ts', import.meta.url).href
  )) as typeof PromptModule;
  return cache;
}

const DECLARATION =
  'I want a flow that turns an article idea into a draft reviewed by a second reader.';

const SKILLS = [
  {
    id: 'cartografo/redigir-nota',
    version: '1.0.0',
    hash: `sha256:${'a'.repeat(64)}`,
    role: 'skill',
    description: 'Writes the note from the declared topic.',
    input: { type: 'object', required: ['tema'] },
    output: { type: 'object', required: ['texto'] },
    checks: [{ type: 'deterministic', command: 'test -s nota.md' }],
  },
  {
    id: 'cartografo/revisar-nota',
    version: '2.1.0',
    hash: `sha256:${'b'.repeat(64)}`,
    role: 'gate',
    description: 'Checks the note against the topic and closes the crossing.',
    input: { type: 'object', required: ['texto'] },
    output: { type: 'object', required: ['resultado'] },
    checks: [
      {
        type: 'agentic',
        instruction: 'Does the note answer the declared topic?',
        required_evidence: ['nota.md'],
      },
    ],
  },
];

const SIMILAR = [
  { classe: 'nota-curta', nome: 'Short note', descricao: 'Draft and review a note.', score: 0.42 },
];

test('AT2 — the prompt carries the declaration and the class the user named', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS);

  assert.ok(prompt.includes(DECLARATION), 'the declaration goes in verbatim');
  assert.ok(prompt.includes('artigo-revisado'), 'the class name goes in verbatim (D8)');
});

test('AT2 — the prompt carries the whole skill catalogue, readably', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS);

  for (const skill of SKILLS) {
    assert.ok(prompt.includes(skill.id), `catalogue is missing the id ${skill.id}`);
    assert.ok(prompt.includes(skill.version), `catalogue is missing the versao of ${skill.id}`);
    assert.ok(prompt.includes(skill.hash), `catalogue is missing the hash of ${skill.id}`);
    assert.ok(prompt.includes(skill.description), `catalogue is missing the descricao of ${skill.id}`);
    assert.ok(
      prompt.includes(JSON.stringify(skill.input)),
      `catalogue is missing the entrada of ${skill.id}`,
    );
    assert.ok(
      prompt.includes(JSON.stringify(skill.output)),
      `catalogue is missing the saida of ${skill.id}`,
    );
    assert.ok(
      prompt.includes(JSON.stringify(skill.checks)),
      `catalogue is missing the checks of ${skill.id}`,
    );
  }
});

test('AT2 — similarity suggestions appear when there are any, and nothing claims otherwise when there are none', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const withSuggestions = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', SIMILAR, SKILLS);
  assert.ok(withSuggestions.includes('nota-curta'), 'the suggested class is named');
  assert.ok(withSuggestions.includes('Draft and review a note.'), 'with its description');

  const without = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS);
  assert.ok(!without.includes('nota-curta'), 'no suggestion is invented when there is none');
});

test('AT2 — the prompt states the output contract: one `grafo-proposto` block', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', SIMILAR, SKILLS);

  assert.ok(prompt.includes('```grafo-proposto'), 'the fence is named literally');
  assert.ok(prompt.includes('lineage'), 'the document is a base lineage (D13: variante is a fork)');
  assert.ok(prompt.includes('skill_ref'), 'the nodes pin capabilities');
  assert.match(
    prompt,
    /never invent/i,
    'the pin is copied from the catalogue, never invented (D4)',
  );
});

test('AT2 — an empty catalogue is stated, not silently rendered as nothing', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], []);

  assert.ok(prompt.includes(DECLARATION));
  assert.match(
    prompt,
    /skill registry is empty|no registered skill/i,
    'an empty registry is said out loud, or the session composes from hallucination',
  );
});

/* ---------------------------------------------------------------------------
 * t138 — the rule that was missing: every node carries at least one check.
 * ------------------------------------------------------------------------ */

/**
 * A validator for ONE `contrato.checks` entry, compiled from the real
 * `schema/graph.schema.json`.
 *
 * Reaching for the file instead of restating the rule here is the whole point.
 * The prompt teaches a format the session cannot open — `workingDir` is an empty
 * temp directory — so the only thing that can prove the prompt teaches it
 * correctly is the format itself. Restate the rule in the suite and the suite
 * drifts with the prompt, together, in the same wrong direction.
 */
function verificationValidator(): ValidateFunction {
  const schema = JSON.parse(readFileSync(GRAPH_SCHEMA_PATH, 'utf8')) as { $id: string };
  // `validateFormats: false` because the whole document goes in — `metadata`
  // declares `format: "date"` — while what comes out is one check, which
  // declares no format at all. Loading `ajv-formats` for a subschema that does
  // not use it would be ceremony.
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/check`);
  assert.ok(validate, 'schema/graph.schema.json no longer defines $defs/check');
  return validate;
}

test('t138 — the hard rules say every node carries at least one verification', async () => {
  const { SYNTHESIS_INSTRUCTIONS } = await loadPrompt();

  assert.ok(
    SYNTHESIS_INSTRUCTIONS.includes('`checks`'),
    'the field is named literally, the way it is spelled in the document',
  );
  assert.match(
    SYNTHESIS_INSTRUCTIONS,
    /at least one|never empty/i,
    'an empty `contract.checks` has to be forbidden out loud, not left to be inferred',
  );
  assert.ok(
    SYNTHESIS_INSTRUCTIONS.includes('no_com_contrato'),
    'the soundness rule that refuses it is named, like the other hard rules name theirs',
  );
});

test('t138 — the prompt states the rule and shows checks the real schema accepts', async () => {
  const { buildSynthesisPrompt, VERIFICATION_EXAMPLES } = await loadPrompt();
  const validate = verificationValidator();

  assert.match(
    buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS),
    /checks[^\n]*(?:at least one|never empty)/i,
    'the output contract repeats the rule where it describes `contract`',
  );

  const kinds = VERIFICATION_EXAMPLES.map((example) => example.type);
  assert.ok(kinds.includes('deterministic'), 'the deterministic shape is shown');
  assert.ok(kinds.includes('agentic'), 'and the agentic one, or half the format is untaught');

  for (const example of VERIFICATION_EXAMPLES) {
    assert.ok(
      validate(example),
      `an example the session is shown is refused by the schema: ${JSON.stringify(validate.errors)}`,
    );
  }

  // Shown for a full catalogue and for an empty one: the format of a check does
  // not depend on whether any skill is registered.
  for (const catalogue of [SKILLS, []]) {
    const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], catalogue);
    for (const example of VERIFICATION_EXAMPLES) {
      assert.ok(
        prompt.includes(JSON.stringify(example)),
        'the example the suite validated is not the one the session sees',
      );
    }
  }
});

test('t138 — the prompt keeps the catalogue `checks` apart from `contract.checks`', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();
  const validate = verificationValidator();

  // The trap is real, and this asserts it rather than assuming it: the two
  // formats disagree on `required_evidence` — a list of artifacts in the
  // skill manifest, the literal `true` in the graph document — so the catalogue
  // check printed right above `contract.checks` is refused verbatim.
  const catalogueCheck = SKILLS[1].checks[0];
  assert.ok(
    !validate(catalogueCheck),
    'the fixture stopped being manifest-shaped; the warning it justifies is now untested',
  );

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS);
  assert.ok(prompt.includes(JSON.stringify(SKILLS[1].checks)), 'the catalogue still prints it');
  assert.match(
    prompt,
    /do NOT copy the `checks`/i,
    'a check of the catalogue is rewritten into the graph format, never pasted into it',
  );
});
