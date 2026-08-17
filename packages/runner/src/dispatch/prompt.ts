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
 * (`docs/formatos/engine-adapter.md`, "Fora de escopo (v0)"), so "resuming" is
 * always a fresh session that was TOLD what happened — and the block below is
 * how it is told.
 *
 * English per D18. The prompt's CONTENT stays in Portuguese: it is what reaches
 * a model, and the node instructions it is composed with are the registered
 * skill manifests, which are written in Portuguese
 * (`especificacoes/formatos/exemplos/`).
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
  tipo: string;
  entidade: { tipo: string; id: number | string };
  dados: Record<string, unknown>;
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
   * `auto`, `recomendacao`, …) — those are the `pergunta.respondida` payload's
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
    `# Trabalho #${job.id} — ${job.title}`,
    '',
    `Nó atual: \`${job.current_node_id}\`.`,
    '',
    'Faça o que este nó pede neste trabalho, no diretório em que você está.',
  ];

  const byId = new Map(answered.map((question) => [question.id, question]));
  const alreadyClosed: Question[] = [];

  // The ORDER comes from the log — the only total ordering there is — and the
  // ANSWER from the projection: `pergunta.respondida` carries no `trabalho_id`,
  // so the work's timeline structurally cannot show it (t102,
  // `packages/core/src/db/events.ts`, `EventFilter`).
  for (const event of events) {
    if (event.tipo !== 'pergunta.criada') continue;
    const question = byId.get(Number(event.entidade.id));
    if (question !== undefined && question.answer !== null) alreadyClosed.push(question);
  }

  if (alreadyClosed.length > 0) {
    parts.push(
      '',
      '## O que você já perguntou, e o que responderam',
      '',
      'Isto já foi decidido. Não pergunte de novo: siga a resposta.',
    );
    for (const question of alreadyClosed) {
      const who = question.source === 'auto' ? 'a resposta automática' : (question.answered_by ?? 'a pessoa');
      parts.push(
        '',
        `- **Você perguntou:** ${question.question}`,
        `  **${who} respondeu:** ${question.answer ?? ''}`,
      );
    }
  }

  return parts.join('\n');
}
