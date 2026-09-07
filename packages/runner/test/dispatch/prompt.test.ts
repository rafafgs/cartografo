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
 * English per D24, the prompt's own CONTENT included. The sentence here used to
 * say the opposite and cite the module as agreeing with it; t309 lifted that
 * exemption and `src/dispatch/prompt.ts` records the argument at length, the
 * short of which is D7: a repository published to be read has its prompts read
 * too, and a model reads English at least as well.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PromptModule from '../../src/dispatch/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/prompt.ts';

/** The heading of the block that only exists when something was answered. */
const ANSWERED_HEADING = '## What you already asked, and what came back';

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
  title: 'Port the reference graph',
  current_node_id: 'desenvolvimento',
  blocked: false,
  execution_id: null,
});

/** One `input_request.created` envelope of the work's timeline. */
function asked(questionId: number): PromptModule.Event {
  return {
    id: questionId * 10,
    type: 'input_request.created',
    entity: { type: 'input_request', id: questionId },
    data: {},
  };
}

/** One row of the answered-questions projection. */
function question(overrides: Partial<PromptModule.Question> = {}): PromptModule.Question {
  return {
    id: 1,
    job_id: JOB.id,
    question: 'Renumber the migration to 0003?',
    status: 'answered',
    answer: 'Keep 0002',
    answered_by: 'rafael',
    source: 'user',
    // The shape the question was ASKED in (t480). `null` is every question
    // recorded before there was anything else to be, and it is what the
    // one-line rendering below keys off.
    options: null,
    ...overrides,
  };
}

test('AT1 — with no events and no answers the prompt is only the base text', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(JOB, [], []);

  assert.equal(
    prompt,
    [
      '# Job #42 — Port the reference graph',
      '',
      'Current node: `desenvolvimento`.',
      '',
      'Do what this node asks of this job, in the directory you are in.',
    ].join('\n'),
  );
  assert.ok(!prompt.includes(ANSWERED_HEADING));
});

test('AT2 — a question that is still open is not rendered', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, answer: null, answered_by: null, status: 'pending' })],
  );

  assert.ok(!prompt.includes(ANSWERED_HEADING));
  assert.ok(!prompt.includes('Renumber the migration to 0003?'));
});

test('AT3 — an answered question renders with its question and its answer', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(JOB, [asked(1)], [question({ id: 1 })]);

  assert.ok(prompt.includes(ANSWERED_HEADING));
  assert.ok(prompt.includes('This is decided. Do not ask again: follow the answer.'));
  assert.ok(prompt.includes('- **You asked:** Renumber the migration to 0003?'));
  assert.ok(prompt.includes('  **rafael replied:** Keep 0002'));
});

test('AT4 — an automatic answer names itself, any other names who answered', async () => {
  const { buildPrompt } = await loadPrompt();

  const automatic = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: 'auto', answered_by: 'politica' })],
  );
  assert.ok(automatic.includes('  **the automatic answer replied:** Keep 0002'));
  assert.ok(!automatic.includes('politica replied'));

  const human = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: 'user', answered_by: 'rafael' })],
  );
  assert.ok(human.includes('  **rafael replied:** Keep 0002'));

  // No `source` and nobody named: the fallback is a person, unattributed —
  // never the automatic wording, which would claim a decision nobody took.
  const anonymous = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, source: null, answered_by: null })],
  );
  assert.ok(anonymous.includes('  **the person replied:** Keep 0002'));
});

test('AT5 — two answered questions render in the LOG order, not the projection order', async () => {
  const { buildPrompt } = await loadPrompt();

  // The projection hands them over newest-first; the log says #7 was asked
  // before #9, and the log is the only total ordering there is.
  const prompt = buildPrompt(
    JOB,
    [asked(7), asked(9)],
    [
      question({ id: 9, question: 'Second question?', answer: 'Second answer' }),
      question({ id: 7, question: 'First question?', answer: 'First answer' }),
    ],
  );

  assert.ok(prompt.indexOf('First question?') < prompt.indexOf('Second question?'));
  assert.ok(prompt.indexOf('First answer') < prompt.indexOf('Second answer'));
});

test('AT6 — an event that is not `input_request.created` renders nothing', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [
      { id: 1, type: 'job.created', entity: { type: 'job', id: JOB.id }, data: {} },
      { id: 2, type: 'session.opened', entity: { type: 'session', id: 1 }, data: {} },
    ],
    [question({ id: 1 })],
  );

  assert.ok(!prompt.includes(ANSWERED_HEADING));
});

/* -- t480: an answer that is a whole document, rendered field by field ------ */

/**
 * A batched question comes back as one JSON document (t480, FR5).
 *
 * The answer column is, and stays, a plain string — a document answer is a
 * JSON-stringified one. So the prompt cannot read the ANSWER to decide how to
 * render it: sniffing would turn a person who typed `{"ok":1}` into a form.
 * What it reads is the QUESTION's own `options`, which is the only place that
 * knows whether a form was ever asked for, and which supplies the labels and
 * the order the bullets are drawn in.
 *
 * Everything else — a legacy flat list, no options at all, a document that
 * does not parse — renders exactly as it did before, and nothing here throws.
 */
const FIELDS: PromptModule.Question['options'] = [
  { id: 'scope', label: 'Which scope?', kind: 'choice' },
  { id: 'areas', label: 'Which areas?', kind: 'multi' },
];

test('t480 AT13 — a document answer renders one bullet per field, in declared order', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [asked(1)],
    [
      question({
        id: 1,
        question: 'Step 4 of 7',
        options: FIELDS,
        answer: JSON.stringify({ areas: ['api', 'screen'], scope: 'one package' }),
      }),
    ],
  );

  assert.ok(prompt.includes('- **You asked:** Step 4 of 7'));
  assert.ok(prompt.includes('  **rafael replied:**'));
  assert.ok(prompt.includes('  - **Which scope?:** one package'));
  assert.ok(prompt.includes('  - **Which areas?:** api, screen'));
  // The order is the one the question DECLARED, never the document's key order.
  assert.ok(prompt.indexOf('Which scope?') < prompt.indexOf('Which areas?'));
  // The raw document is not also dumped on the opener line.
  assert.ok(!prompt.includes('{"areas"'));
});

test('t480 AT14 — a field with no key in the document is skipped, not drawn blank', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [asked(1)],
    [question({ id: 1, options: FIELDS, answer: JSON.stringify({ scope: 'one package' }) })],
  );

  assert.ok(prompt.includes('  - **Which scope?:** one package'));
  assert.ok(!prompt.includes('Which areas?'));
});

test('t480 AT15 — a key naming no declared field renders after them, by its raw name', async () => {
  const { buildPrompt } = await loadPrompt();

  const prompt = buildPrompt(
    JOB,
    [asked(1)],
    [
      question({
        id: 1,
        options: FIELDS,
        answer: JSON.stringify({ notes: 'and one more thing', scope: 'one package' }),
      }),
    ],
  );

  assert.ok(prompt.includes('  - **Which scope?:** one package'));
  assert.ok(prompt.includes('  - **notes:** and one more thing'));
  assert.ok(
    prompt.indexOf('Which scope?') < prompt.indexOf('notes'),
    'what was asked comes first; what was volunteered follows',
  );
});

test('t480 AT16 — an answer that is not a JSON object falls back to the one line', async () => {
  const { buildPrompt } = await loadPrompt();

  for (const answer of ['Keep 0002', '{"unterminated', '["a","list"]', '7', 'null', '']) {
    const prompt = buildPrompt(JOB, [asked(1)], [question({ id: 1, options: FIELDS, answer })]);

    assert.ok(prompt.includes(`  **rafael replied:** ${answer}`), `raw answer for ${answer}`);
    assert.ok(!prompt.includes('  - **Which scope?:**'), `no bullets for ${answer}`);
  }
});

test('t480 AT17 — a legacy or absent `options` never renders bullets, whatever the answer is', async () => {
  const { buildPrompt } = await loadPrompt();

  const document = JSON.stringify({ scope: 'one package' });

  for (const options of [
    null,
    ['Renumber', 'Keep'],
    [],
    // Mixed: not every item is Field-shaped, so it is not a form.
    [{ id: 'scope', label: 'Which scope?', kind: 'choice' }, 'Keep'],
  ] as PromptModule.Question['options'][]) {
    const prompt = buildPrompt(JOB, [asked(1)], [question({ id: 1, options, answer: document })]);

    assert.ok(
      prompt.includes(`  **rafael replied:** ${document}`),
      `the raw answer is the whole rendering for ${JSON.stringify(options)}`,
    );
    assert.ok(!prompt.includes('- **Which scope?:**'));
  }
});
