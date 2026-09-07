/**
 * The prompt of a dispatch: what to do, plus what was already asked and
 * answered (t202, FR2).
 *
 * Moved out of `dispatch.ts` unchanged. It is a pure function of three plain
 * values — the work, its timeline and the answered-questions projection — and
 * it was the only piece of that file with no HTTP, no engine and no worktree in
 * it, which made it the one piece nobody could test without booting all three.
 *
 * What it renders is the mechanism that keeps a re-dispatch from asking the same
 * thing forever. Engine-native resume is out of scope for the v0 adapter
 * (`docs/formats/engine-adapter.md`, "Out of scope (v0)"), so "resuming" is
 * always a fresh session that was TOLD what happened — and the block below is
 * how it is told.
 *
 * English, content included (D24, t309). The paragraph this replaces said the
 * opposite, and it is worth keeping the shape of what it argued: English per
 * D18, but the prompt's CONTENT in Portuguese, because it is what reaches a
 * model and the node instructions it is composed with are the registered skill
 * manifests, which were Portuguese (`specs/formats/examples/`).
 *
 * Two things are wrong with that. The smaller one is that its evidence had
 * already expired: every example under `specs/formats/examples/` and every
 * skill in `factory-graphs/<bundle>/skills/` is English today, and the sentence
 * pointing at them as Portuguese outlived the fact by several tickets, in eight
 * files at once, because nothing reads a rationale.
 *
 * The larger one is that the manifests were never the argument. What made the
 * exemption look sound is that a prompt is consumed by a subprocess, so nobody
 * reads it — and D7 is the answer: this repository is published to be read, and
 * to a reader a prompt is not plumbing but the most interesting file here, the
 * place where the product's behaviour is actually written down. A model reads
 * English at least as well; a person who does not read Portuguese reads none of
 * it at all.
 */

import type { Job } from './options.ts';
import type { Field } from './parse-input-request.ts';

/**
 * One envelope of the work's timeline.
 *
 * Declared here rather than in `dispatch.ts` because this is the only module
 * that reads one: the orchestrator fetches the list and hands it straight over.
 */
export interface Event {
  id: number;
  type: string;
  entity: { type: string; id: number | string };
  data: Record<string, unknown>;
}

/** A question, as `GET /v1/input-requests` projects it. */
export interface Question {
  id: number;
  job_id: number;
  question: string;
  status: string;
  answer: string | null;
  answered_by: string | null;
  /**
   * Where the decision came from: `user` or `auto`, and nothing else.
   *
   * The KEY went English with the API in t226 and the VALUES followed with
   * t235, D20's fifth child, which rewrote the column's own `CHECK` to
   * `('user','auto')` (`packages/core/migrations/0003_trabalho_sessao_evento_pergunta.sql:98`).
   * This comment said otherwise until t323 — it still listed the pre-t235
   * spellings — and the fixture of `test/dispatch/prompt.test.ts` was built on
   * the claim, with a third value that had never been in the enum at all.
   *
   * Read as `string | null` and not as the union, because it is what a body
   * carried: only `auto` is branched on below, and a value this projection has
   * never seen is a person's answer, not a crash.
   */
  source: string | null;
  /**
   * The shape the question was ASKED in (t480).
   *
   * Read here, and not the answer, because only the question knows whether a
   * form was ever drawn: the answer column is a plain string either way, and a
   * document answer is a JSON-stringified one. Sniffing the answer would turn a
   * person who happened to type `{"ok": 1}` into a form nobody asked for.
   *
   * `null` for every question recorded before there was anything else to be,
   * and a flat `string[]` for every single-decision escalation from here on.
   */
  options: string[] | Field[] | null;
}

/** Is this the ordered list of fields of a batched question, and not labels? */
function isFieldList(options: Question['options']): options is Field[] {
  return (
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Field).id === 'string' &&
        typeof (item as Field).label === 'string' &&
        typeof (item as Field).kind === 'string',
    )
  );
}

/** Reads a document answer, or `null` when it is not one. Never throws. */
function parseDocument(answer: string | null): Record<string, unknown> | null {
  if (answer === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/** One value of the document, as a line of prose. */
function renderValue(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value);
}

/**
 * What came back, as the question's own shape says to read it (t480, FR5).
 *
 * A batched question was several decisions asked at once, and the document it
 * came back as is unreadable to a model that has to re-derive which value
 * belonged to which control. So the labels are put back: one bullet per field,
 * in the order the question declared them, which is also the order it was
 * answered in even though a JSON object's keys carry no order at all.
 *
 * Everything the pair does not fit — a legacy list of labels, no options at
 * all, an answer that is not a document — falls back to the one line this
 * function has always rendered, unchanged.
 */
function renderAnswer(question: Question, who: string): string[] {
  const document = isFieldList(question.options) ? parseDocument(question.answer) : null;
  if (document === null) return [`  **${who} replied:** ${question.answer ?? ''}`];

  const fields = question.options as Field[];
  const declared = new Set(fields.map((field) => field.id));
  const lines = [`  **${who} replied:**`];

  // A field with no key in the document was not answered, and an empty bullet
  // claims otherwise.
  for (const field of fields) {
    if (field.id in document) {
      lines.push(`  - **${field.label}:** ${renderValue(document[field.id])}`);
    }
  }
  // Anything volunteered on top of what was asked is kept, under its own raw
  // name — there is no label for it, and dropping it would lose an answer.
  for (const [key, value] of Object.entries(document)) {
    if (!declared.has(key)) lines.push(`  - **${key}:** ${renderValue(value)}`);
  }

  return lines;
}

/**
 * The prompt of a dispatch: what to do, plus what was already asked and
 * answered.
 *
 * @param job The work being dispatched.
 * @param events Its timeline, in log order.
 * @param answered Questions already answered, from the projection.
 * @returns The prompt text.
 */
export function buildPrompt(
  job: Job,
  events: readonly Event[],
  answered: readonly Question[],
): string {
  const parts = [
    `# Job #${job.id} — ${job.title}`,
    '',
    `Current node: \`${job.current_node_id}\`.`,
    '',
    'Do what this node asks of this job, in the directory you are in.',
  ];

  const byId = new Map(answered.map((question) => [question.id, question]));
  const alreadyClosed: Question[] = [];

  // The ORDER comes from the log — the only total ordering there is — and the
  // ANSWER from the projection: `input_request.answered` carries no `job_id`,
  // so the work's timeline structurally cannot show it (t102,
  // `packages/core/src/db/events.ts`, `EventFilter`).
  for (const event of events) {
    if (event.type !== 'input_request.created') continue;
    const question = byId.get(Number(event.entity.id));
    if (question !== undefined && question.answer !== null) alreadyClosed.push(question);
  }

  if (alreadyClosed.length > 0) {
    parts.push(
      '',
      '## What you already asked, and what came back',
      '',
      'This is decided. Do not ask again: follow the answer.',
    );
    for (const question of alreadyClosed) {
      const who =
        question.source === 'auto' ? 'the automatic answer' : (question.answered_by ?? 'the person');
      parts.push('', `- **You asked:** ${question.question}`, ...renderAnswer(question, who));
    }
  }

  return parts.join('\n');
}
