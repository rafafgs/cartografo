/**
 * Acceptance tests of the synthesis prompt (t115, AT2).
 *
 * The prompt is a pure function on purpose: it is the whole contract between us
 * and the copilot session (D10 — the synthesizer proposes, the human edits, and
 * the edit is the entire gate), and a contract that can only be read by opening
 * a session is a contract nobody reviews.
 *
 * Four things have to be in it, and each one is a requirement of the ficha:
 * the declaration as the user wrote it, the class name the user chose (D8 — the
 * command never invents one), the skill catalogue in enough detail to compose
 * nodes from it, and the similarity suggestions when there are any. Plus the
 * output contract: EXACTLY one ```grafo-proposto block.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PromptModule from '../../src/synthesizer/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
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
  'Quero um fluxo que transforma uma ideia de artigo em um rascunho revisado por um segundo leitor.';

const SKILLS = [
  {
    id: 'cartografo/redigir-nota',
    versao: '1.0.0',
    hash: `sha256:${'a'.repeat(64)}`,
    papel: 'skill',
    descricao: 'Escreve a nota a partir do tema declarado.',
    entrada: { type: 'object', required: ['tema'] },
    saida: { type: 'object', required: ['texto'] },
    checks: [{ tipo: 'deterministico', comando: 'test -s nota.md' }],
  },
  {
    id: 'cartografo/revisar-nota',
    versao: '2.1.0',
    hash: `sha256:${'b'.repeat(64)}`,
    papel: 'portao',
    descricao: 'Confere a nota contra o tema e encerra a travessia.',
    entrada: { type: 'object', required: ['texto'] },
    saida: { type: 'object', required: ['resultado'] },
    checks: [
      {
        tipo: 'agentico',
        instrucao: 'A nota responde ao tema declarado?',
        evidencia_obrigatoria: ['nota.md'],
      },
    ],
  },
];

const SIMILAR = [
  { classe: 'nota-curta', nome: 'Nota curta', descricao: 'Redigir e revisar uma nota.', score: 0.42 },
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
    assert.ok(prompt.includes(skill.versao), `catalogue is missing the versao of ${skill.id}`);
    assert.ok(prompt.includes(skill.hash), `catalogue is missing the hash of ${skill.id}`);
    assert.ok(prompt.includes(skill.descricao), `catalogue is missing the descricao of ${skill.id}`);
    assert.ok(
      prompt.includes(JSON.stringify(skill.entrada)),
      `catalogue is missing the entrada of ${skill.id}`,
    );
    assert.ok(
      prompt.includes(JSON.stringify(skill.saida)),
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
  assert.ok(withSuggestions.includes('Redigir e revisar uma nota.'), 'with its description');

  const without = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], SKILLS);
  assert.ok(!without.includes('nota-curta'), 'no suggestion is invented when there is none');
});

test('AT2 — the prompt states the output contract: one `grafo-proposto` block', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', SIMILAR, SKILLS);

  assert.ok(prompt.includes('```grafo-proposto'), 'the fence is named literally');
  assert.ok(prompt.includes('linhagem'), 'the document is a base lineage (D13: variante is a fork)');
  assert.ok(prompt.includes('skill_ref'), 'the nodes pin capabilities');
  assert.match(
    prompt,
    /nunca invent|nunca escreva|não invent/i,
    'the pin is copied from the catalogue, never invented (D4)',
  );
});

test('AT2 — an empty catalogue is stated, not silently rendered as nothing', async () => {
  const { buildSynthesisPrompt } = await loadPrompt();

  const prompt = buildSynthesisPrompt(DECLARATION, 'artigo-revisado', [], []);

  assert.ok(prompt.includes(DECLARATION));
  assert.match(
    prompt,
    /registro (de skills )?(está )?vazio|nenhuma skill/i,
    'an empty registry is said out loud, or the session composes from hallucination',
  );
});
