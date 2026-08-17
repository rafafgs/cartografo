/**
 * Acceptance tests for the dispatch prompt (t202, FR2/FR7).
 *
 * `buildPrompt` had no test of its own for its whole life: it lived inside
 * `dispatch-claude-code.ts` and was only ever exercised sideways, through the
 * t106 escalation-cycle test — which boots a real control plane over HTTP
 * against a fake engine to assert, among a dozen other things, that the second
 * dispatch's prompt carries the answer. That proves the cycle; it does not pin
 * the rendering, and it costs a process spawn to ask a question about string
 * concatenation.
 *
 * So this file is what the split buys (t202): the prompt is a pure function of
 * three plain values, and here it is tested as one. No HTTP, no engine, no
 * worktree, no control plane.
 *
 * English per D18; the prompt's own CONTENT is Portuguese, because it is what
 * reaches a model — the same rule the module it tests records.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PromptModule from '../../src/dispatch/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/prompt.ts';

/** The heading of the block that only exists when something was answered. */
const ANSWERED_HEADING = '## O que você já perguntou, e o que responderam';

let cache: typeof PromptModule | null = null;

/**
 * Imports the module under test, failing with its path while it does not exist.
 *
 * The idiom the rest of this directory already uses: in the red phase the
 * failure has to read as "the implementation is missing", never as a module
 * resolution stack trace.
 */
async function loadPrompt(): Promise<typeof PromptModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/prompt.ts', import.meta.url).href
  )) as typeof PromptModule;
  return cache;
}

/** The work every case here renders, with the fields the prompt reads. */
const JOB = Object.freeze({
  id: 42,
  title: 'Portar o grafo de referência',
  current_node_id: 'desenvolvimento',
  blocked: false,
  execution_id: null,
});

/** One `pergunta.criada` envelope of the work's timeline. */
function asked(questionId: number): PromptModule.Event {
  return {
    id: questionId * 10,
    tipo: 'pergunta.criada',
    entidade: { tipo: 'pergunta', id: questionId },
    dados: {},
  };
}

/** One row of the answered-questions projection. */
function question(overrides: Partial<PromptModule.Question> = {}): PromptModule.Question {
  return {
    id: 1,
    job_id: JOB.id,
    question: 'Renumerar a migração para 0003?',
    status: 'respondida',
    answer: 'Manter 0002',
    answered_by: 'rafael',
    source: 'humano',
    ...overrides,
  };
}

test('AT1 — with no events and no answers the prompt is only the base text', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(JOB, [], []);

  assert.equal(
    prompt,
    [
      '# Trabalho #42 — Portar o grafo de referência',
      '',
      'Nó atual: `desenvolvimento`.',
      '',
      'Faça o que este nó pede neste trabalho, no diretório em que você está.',
    ].join('\n'),
  );
  assert.ok(!prompt.includes(ANSWERED_HEADING));
});

test('AT2 — a question that is still open is not rendered', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, answer: null, answered_by: null, status: 'pendente' })],
  );

  assert.ok(!prompt.includes(ANSWERED_HEADING));
  assert.ok(!prompt.includes('Renumerar a migração para 0003?'));
});

test('AT3 — an answered question renders with its question and its answer', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(JOB, [asked(1)], [question({ id: 1 })]);

  assert.ok(prompt.includes(ANSWERED_HEADING));
  assert.ok(prompt.includes('Isto já foi decidido. Não pergunte de novo: siga a resposta.'));
  assert.ok(prompt.includes('- **Você perguntou:** Renumerar a migração para 0003?'));
  assert.ok(prompt.includes('  **rafael respondeu:** Manter 0002'));
});

test('AT4 — an automatic answer names itself, any other names who answered', async () => {
  const { buildPrompt } = await loadPrompt();

  const automatic = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: 'auto', answered_by: 'politica' })],
  );
  assert.ok(automatic.includes('  **a resposta automática respondeu:** Manter 0002'));
  assert.ok(!automatic.includes('politica respondeu'));

  const human = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: 'humano', answered_by: 'rafael' })],
  );
  assert.ok(human.includes('  **rafael respondeu:** Manter 0002'));

  // No `origem` and nobody named: the fallback is a person, unattributed —
  // never the automatic wording, which would claim a decision nobody took.
  const anonymous = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: null, answered_by: null })],
  );
  assert.ok(anonymous.includes('  **a pessoa respondeu:** Manter 0002'));
});

test('AT5 — two answered questions render in the LOG order, not the projection order', async () => {
  const { buildPrompt } = await loadPrompt();

  // The projection hands them over newest-first; the log says #7 was asked
  // before #9, and the log is the only total ordering there is.
  const prompt = buildPrompt(
    JOB,
    [asked(7), asked(9)],
    [
      question({ id: 9, question: 'Segunda pergunta?', answer: 'Segunda resposta' }),
      question({ id: 7, question: 'Primeira pergunta?', answer: 'Primeira resposta' }),
    ],
  );

  assert.ok(prompt.indexOf('Primeira pergunta?') < prompt.indexOf('Segunda pergunta?'));
  assert.ok(prompt.indexOf('Primeira resposta') < prompt.indexOf('Segunda resposta'));
});

test('AT6 — an event that is not `pergunta.criada` renders nothing', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [
      { id: 1, tipo: 'trabalho.criado', entidade: { tipo: 'trabalho', id: JOB.id }, dados: {} },
      { id: 2, tipo: 'sessao.aberta', entidade: { tipo: 'sessao', id: 1 }, dados: {} },
    ],
    [question({ id: 1 })],
  );

  assert.ok(!prompt.includes(ANSWERED_HEADING));
});
