/**
 * Acceptance tests for the intake session's prompt (t144, AT1).
 *
 * A pure function tested on its own, for the reason
 * `test/synthesizer/prompt.test.ts` already records about its own subject: this
 * text IS the contract of the ficha. The session runs in an empty temporary
 * directory, so it cannot open `packages/core/src/domain/intake.ts` and read the
 * item format for itself — every rule `validateItems` enforces and the prompt
 * does not state is a rule the session has no way to follow, and the bill
 * arrives as an `itens_invalidos` the person never asked for.
 *
 * Four rules make up that contract, and the fourth is the one that is easy to
 * get wrong: `criterios_de_aceite` is written ONLY when real criteria are known.
 * `null` is not `[]` (`domain/intake.ts:34-43`) — "nobody wrote any yet" and "it
 * was declared that there are none" are different statements, and the node that
 * refines has to be able to tell them apart.
 *
 * English per D18; the prompt's own prose is Portuguese, like every other agent
 * instruction in this repository, and so are the payload keys it teaches.
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
    claim: '`ref` and `titulo` are the two required fields of an item',
    tokens: ['`ref`', '`titulo`', 'obrigat'],
  },
  {
    claim: '`depende_de` cites only refs of the same batch',
    tokens: ['`depende_de`', 'lote'],
  },
  {
    claim: 'an item never depends on itself and never closes a cycle',
    tokens: ['si mesmo', 'ciclo'],
  },
  {
    claim: '`criterios_de_aceite` is written only when there are real criteria',
    tokens: ['`criterios_de_aceite`', 'null', '[]'],
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
  // (`docs/formatos/engine-adapter.md`), so the claim is about the two TOGETHER:
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
    composed.includes('{"itens"'),
    `the shape of the file is not stated, so the session has to guess it:\n${composed}`,
  );
});

test('AT1 — the session is told it writes the file and nothing else', async () => {
  const { INTAKE_INSTRUCTIONS } = await loadPrompt();

  // The same posture as the surveyor's session (`src/surveyor/proposal.ts`): no
  // URL, no credential, no write anywhere else. The only POST of this ficha is
  // the orchestrator's.
  assert.match(INTAKE_INSTRUCTIONS, /API/i, 'the instructions have to close the API door out loud');
});
