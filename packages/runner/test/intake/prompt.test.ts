/**
 * Acceptance tests for the intake session's prompt (t144, AT1).
 *
 * A pure function tested on its own, for the reason
 * `test/synthesizer/prompt.test.ts` already records about its own subject: this
 * text IS the contract of the ficha. The session runs in an empty temporary
 * directory, so it cannot open `packages/core/src/domain/intake.ts` and read the
 * item format for itself — every rule `validateItems` enforces and the prompt
 * does not state is a rule the session has no way to follow, and the bill
 * arrives as an `invalid_items` the person never asked for.
 *
 * Four rules make up that contract, and the fourth is the one that is easy to
 * get wrong: `acceptance_criteria` is written ONLY when real criteria are known.
 * `null` is not `[]` (`domain/intake.ts:34-43`) — "nobody wrote any yet" and "it
 * was declared that there are none" are different statements, and the node that
 * refines has to be able to tell them apart.
 *
 * English per D18; the prompt's own prose is Portuguese, like every other agent
 * instruction in this repository. The payload KEYS it teaches are English since
 * t255: they are the wire format of `POST /v1/intake`, and a prompt that taught
 * the retired spelling would be teaching a batch the validator refuses.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PromptModule from '../../src/intake/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const PROMPT_MODULE = 'src/intake/prompt.ts';

/** The request in natural language, exactly as a person would type it. */
const REQUEST = [
  'Preciso fechar a camada de intake: uma rota que propoe a quebra, outra que',
  'confirma, e a tela fica para depois.',
].join('\n');

const CLASS_NAME = 'desenvolvimento-de-software';

let cache: typeof PromptModule | null = null;

async function loadPrompt(): Promise<typeof PromptModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, PROMPT_MODULE)),
    `artifact does not exist yet: packages/runner/${PROMPT_MODULE}`,
  );
  cache ??= (await import(
    new URL(`../../${PROMPT_MODULE}`, import.meta.url).href
  )) as typeof PromptModule;
  return cache;
}

/**
 * What the session has to be told, and the tokens that say it.
 *
 * Tokens and not a sentence: the wording is the prompt author's, the RULE is the
 * contract. Each entry fails with the claim it belongs to, so a prompt that
 * drops one says which one.
 */
const RULES: ReadonlyArray<{ claim: string; tokens: readonly string[] }> = Object.freeze([
  {
    claim: '`ref` and `title` are the two required fields of an item',
    tokens: ['`ref`', '`title`', 'obrigat'],
  },
  {
    claim: '`depends_on` cites only refs of the same batch',
    tokens: ['`depends_on`', 'lote'],
  },
  {
    claim: 'an item never depends on itself and never closes a cycle',
    tokens: ['si mesmo', 'ciclo'],
  },
  {
    claim: '`acceptance_criteria` is written only when there are real criteria',
    tokens: ['`acceptance_criteria`', 'null', '[]'],
  },
]);

test('AT1 — the request and the class reach the session verbatim', async () => {
  const { buildIntakePrompt } = await loadPrompt();

  const prompt = buildIntakePrompt(REQUEST, CLASS_NAME);

  assert.ok(
    prompt.includes(REQUEST),
    `the request has to arrive whole, in the words the person typed:\n${prompt}`,
  );
  assert.ok(prompt.includes(CLASS_NAME), `the class the user named is missing:\n${prompt}`);
});

test('AT1 — the contract handed to the session states every rule of an item', async () => {
  const { INTAKE_INSTRUCTIONS, buildIntakePrompt } = await loadPrompt();

  // Instructions and prompt are never concatenated by the caller
  // (`docs/formats/engine-adapter.md`), so the claim is about the two TOGETHER:
  // where each rule is written is the prompt author's call, that it is written
  // at all is not.
  const composed = `${INTAKE_INSTRUCTIONS}\n${buildIntakePrompt(REQUEST, CLASS_NAME)}`;

  for (const rule of RULES) {
    for (const token of rule.tokens) {
      assert.ok(
        composed.includes(token),
        `${rule.claim} — nothing in the session's contract says "${token}":\n${composed}`,
      );
    }
  }
});

test('AT1 — the output contract is one file, with one key in it', async () => {
  const { INTAKE_INSTRUCTIONS, OUTPUT_FILE, buildIntakePrompt } = await loadPrompt();

  const composed = `${INTAKE_INSTRUCTIONS}\n${buildIntakePrompt(REQUEST, CLASS_NAME)}`;

  assert.equal(OUTPUT_FILE, 'intake-proposto.json');
  assert.ok(composed.includes(OUTPUT_FILE), `the session is never told where to write:\n${composed}`);
  assert.ok(
    composed.includes('{"items"'),
    `the shape of the file is not stated, so the session has to guess it:\n${composed}`,
  );
});

/**
 * t175 — the triage rides the session that already runs.
 *
 * No second session is spawned to classify: the intake session is already
 * reading the request and proposing the breakdown, so asking it to also label
 * each item costs nothing extra. That makes the PROMPT the whole mechanism —
 * a value the instructions never teach is a value the session cannot produce,
 * and the field would silently stay `null` forever with nothing failing.
 *
 * Both values are demanded by name, and so is at least one worked case of each
 * side of the line, because "trivial" and "standard" are judgement words: a
 * prompt that names them without saying when each applies hands the session a
 * coin flip.
 */
test('t175 — the contract teaches both tier values and when each applies', async () => {
  const { INTAKE_INSTRUCTIONS } = await loadPrompt();

  assert.ok(
    INTAKE_INSTRUCTIONS.includes('`tier`'),
    `nothing in the instructions names the field:\n${INTAKE_INSTRUCTIONS}`,
  );
  for (const value of ['trivial', 'standard']) {
    assert.ok(
      INTAKE_INSTRUCTIONS.includes(value),
      `the allowed value "${value}" is never stated:\n${INTAKE_INSTRUCTIONS}`,
    );
  }
  assert.match(
    INTAKE_INSTRUCTIONS,
    /opcional/i,
    'the field has to be stated as optional — an item that omits it stays valid',
  );
});

test('t255 — the shape the session is taught is the shape the validator accepts', async () => {
  const { INTAKE_INSTRUCTIONS, buildIntakePrompt } = await loadPrompt();

  const composed = `${INTAKE_INSTRUCTIONS}\n${buildIntakePrompt(REQUEST, CLASS_NAME)}`;

  // The session writes `intake-proposto.json` and never sees `domain/intake.ts`,
  // so the only thing standing between it and a refused batch is this text. Every
  // key it teaches has to be one `validateItems` reads.
  for (const key of ['"items"', '"title"', '"body"', '"acceptance_criteria"', '"depends_on"']) {
    assert.ok(composed.includes(key), `the contract never teaches ${key}:\n${composed}`);
  }

  for (const retired of ['"itens"', '"titulo"', '"corpo"', '"criterios_de_aceite"', '"depende_de"']) {
    assert.ok(
      !composed.includes(retired),
      `the contract still teaches ${retired}, which POST /v1/intake refuses since t255`,
    );
  }
});

test('AT1 — the session is told it writes the file and nothing else', async () => {
  const { INTAKE_INSTRUCTIONS } = await loadPrompt();

  // The same posture as the surveyor's session (`src/surveyor/proposal.ts`): no
  // URL, no credential, no write anywhere else. The only POST of this ficha is
  // the orchestrator's.
  assert.match(INTAKE_INSTRUCTIONS, /API/i, 'the instructions have to close the API door out loud');
});
