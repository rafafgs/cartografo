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
   * Where the decision came from.
   *
   * The KEY went English with the API in t226; the VALUES did not (`usuario`,
   * `auto`, `recomendacao`, …) — those are the `input_request.answered` payload's
   * vocabulary, which is D20's second child.
   */
  source: string | null;
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
      parts.push(
        '',
        `- **You asked:** ${question.question}`,
        `  **${who} replied:** ${question.answer ?? ''}`,
      );
    }
  }

  return parts.join('\n');
}
