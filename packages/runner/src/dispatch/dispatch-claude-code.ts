/**
 * The real dispatch: an `EngineAdapter` session, wired to the control plane
 * (t106, FR6/FR7).
 *
 * This is the seam t103 left open. `ControllerOptions.dispatch` is an injected
 * callback and the controller opens no session at all; `createClaudeCodeDispatch`
 * returns exactly that callback, with the engine on one side and the API on the
 * other. Nothing here touches the database: the runner is an ordinary client of
 * the public API, same boundary the UI has (D1, D11).
 *
 * What one dispatch does, in order:
 *
 * 1. reads the work and its timeline;
 * 2. builds the prompt — the node's (fixed, for now) instruction plus every
 *    question already asked AND answered for this work. That block is what
 *    keeps a re-dispatch from asking the same thing forever: engine-native
 *    resume is out of scope for the v0 adapter
 *    (`docs/formatos/engine-adapter.md`, "Fora de escopo (v0)"), so "resuming"
 *    is always a fresh session that was told what happened;
 * 3. opens the session and records `sessao.aberta` with the engine ref known so
 *    far — it may be `null`, and there is no endpoint to fill it in later;
 * 4. on finish, records `sessao.finalizada` in the taxonomy's vocabulary;
 * 5. runs the escalation parser over the output and, if the session asked
 *    something, posts the question — which blocks the work inside the control
 *    plane, in the same transaction (t106, FR1).
 *
 * **Asking is not failing.** A dispatch that ends with a pending question and a
 * blocked work resolves normally: the lease goes back through the controller's
 * `finally`, and the work simply stops being a candidate until someone answers.
 * Only a session that could not start or did not reach `completed` rejects.
 *
 * English per D18. The prompt and instruction CONTENT stays in Portuguese: it
 * stands in for the skill manifest the graph will inject (t101/t105), and those
 * are written in Portuguese (`especificacoes/formatos/exemplos/`).
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import type { EngineAdapter, SessionSpec, SessionStatus } from '../engine/types.ts';
import { parseInputRequest, type InputRequest } from './parse-input-request.ts';

/**
 * `SessionStatus` (the interface's vocabulary) -> the taxonomy's `status`
 * (t98). Two vocabularies on purpose: one is the minimum every headless CLI
 * expresses, the other describes the outcome of the WORK.
 *
 * `cancelled` lands on `travada` for want of anything better — the taxonomy has
 * no "cancelled". Same table `scripts/spike-real-session.mjs` already uses; if
 * it ever grows a third copy, it belongs in a module of its own.
 */
export const TAXONOMY_STATUS: Readonly<Record<SessionStatus, string>> = Object.freeze({
  pending: 'travada',
  running: 'travada',
  completed: 'concluida',
  failed: 'falhou',
  cancelled: 'travada',
  timed_out: 'tempo_esgotado',
});

/**
 * The node instruction, fixed and literal, exactly as t104's spike did it.
 *
 * Pulling the real skill from the registered graph (`grafo_versao`) is t109's
 * job, not this ticket's — but the protocol half of it is not decoration: a
 * session that does not know how to escalate never escalates, and the whole
 * cycle this ticket builds would never trigger.
 */
export const DEFAULT_INSTRUCTIONS = [
  'Você é uma sessão de trabalho despachada pelo runner do cartografo.',
  '',
  'Trabalhe no diretório atual e faça o que o trabalho pede.',
  '',
  'Quando alguma coisa que o trabalho não resolve travar você, NÃO chute e não',
  'fique esperando: termine seu turno com exatamente UM bloco cercado, e nada',
  'depois dele:',
  '',
  '```input-request',
  '{"question": "<a decisão que você precisa, em uma ou duas frases>",',
  ' "context": "<a evidência, o que você já tentou, as alternativas>",',
  ' "options": ["<rótulo curto>", "<rótulo curto>"],',
  ' "recommendation": "<a ação que você tomaria, no imperativo>",',
  ' "default": "<a opção que vale se a pessoa simplesmente aceitar>"}',
  '```',
  '',
  'O control plane bloqueia o trabalho, uma pessoa responde, e você é despachado',
  'de novo — com a pergunta e a resposta já escritas no prompt. Não existe',
  'retomada de sessão: cada despacho é uma sessão nova que foi informada do que',
  'aconteceu antes.',
].join('\n');

/** What `GET /v1/jobs/:id` gives back, in the part this module reads. */
interface Job {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  execucao_id: number | null;
}

/** One envelope of the work's timeline. */
interface Event {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  dados: Record<string, unknown>;
}

/** A question, as `GET /v1/input-requests` projects it. */
interface Question {
  id: number;
  trabalho_id: number;
  pergunta: string;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
}

/** A session, as `POST /v1/sessions` gives it back. */
interface Session {
  id: number;
}

/** Configuration of a dispatch. */
export interface ClaudeCodeDispatchOptions {
  /**
   * Base URL of the control plane. Named as in `ClienteControle`, on purpose:
   * whoever wires both passes the same value to both.
   */
  urlBase: string;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass a fake. */
  adapter: EngineAdapter;
  /** Where the session runs — typically an isolated git worktree. */
  workingDir: string;
  /** Wall-clock limit of the session. Default: one hour. */
  timeoutSeconds?: number;
  /** Node instructions. Default: {@link DEFAULT_INSTRUCTIONS}. */
  instructions?: string;
  /** Opaque additions to the engine's environment. */
  envOverrides?: Readonly<Record<string, string>>;
  /** `fetch` implementation. Default: the global one. Test seam only. */
  doFetch?: typeof fetch;
}

/** A session that started but did not end well. */
export class DispatchError extends Error {
  readonly status: SessionStatus;
  readonly exitCode: number | null;

  constructor(message: string, status: SessionStatus, exitCode: number | null) {
    super(message);
    this.name = 'DispatchError';
    this.status = status;
    this.exitCode = exitCode;
  }
}

/** Default wall-clock limit, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 3_600;

/** One text block of an assistant message frame. */
interface TextBlock {
  type: string;
  text: string;
}

const isTextBlock = (value: unknown): value is TextBlock =>
  typeof value === 'object' &&
  value !== null &&
  (value as TextBlock).type === 'text' &&
  typeof (value as TextBlock).text === 'string';

/**
 * The text a `stream-json` frame carries, or `null` when the line is not a
 * frame this engine emits.
 *
 * Without this step the parser would be reading JSON-ESCAPED text: a real
 * Claude Code session prints frames, so the block's own quotes arrive as `\"`
 * and its newlines as `\n`, and no fenced JSON would ever parse. The fake
 * engine of the suite prints plain lines, which fall through untouched — which
 * is exactly why this trap survives CI and only the manual spike catches it.
 */
function frameText(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let frame: unknown;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof frame !== 'object' || frame === null) return null;

  const { type, result, message } = frame as {
    type?: unknown;
    result?: unknown;
    message?: unknown;
  };

  // The final frame carries the whole last answer; it is the most reliable
  // place the block shows up whole.
  if (type === 'result' && typeof result === 'string') return [result];

  if (typeof message === 'object' && message !== null) {
    const { content } = message as { content?: unknown };
    // An assistant turn with only tool calls yields an empty list — and an
    // empty list is still a recognized frame, so the raw JSON is dropped
    // instead of being fed to the parser as if it were prose.
    if (Array.isArray(content)) return content.filter(isTextBlock).map((block) => block.text);
  }

  return null;
}

/** Everything the session said, with engine frames decoded back into text. */
export function sessionText(lines: readonly string[]): string {
  const parts: string[] = [];
  for (const line of lines) {
    const texts = frameText(line);
    if (texts === null) parts.push(line);
    else parts.push(...texts);
  }
  return parts.join('\n');
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
    `# Trabalho #${job.id} — ${job.titulo}`,
    '',
    `Nó atual: \`${job.no_atual}\`.`,
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
    if (question !== undefined && question.resposta !== null) alreadyClosed.push(question);
  }

  if (alreadyClosed.length > 0) {
    parts.push(
      '',
      '## O que você já perguntou, e o que responderam',
      '',
      'Isto já foi decidido. Não pergunte de novo: siga a resposta.',
    );
    for (const question of alreadyClosed) {
      const who = question.origem === 'auto' ? 'a resposta automática' : (question.respondido_por ?? 'a pessoa');
      parts.push(
        '',
        `- **Você perguntou:** ${question.pergunta}`,
        `  **${who} respondeu:** ${question.resposta ?? ''}`,
      );
    }
  }

  return parts.join('\n');
}

/** What the session reported when it ended. */
interface Outcome {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Builds the controller's `dispatch` callback (t103), with a real engine behind
 * it.
 *
 * @param options Control plane, engine, working directory and session limits.
 * @returns The exact signature `ControllerOptions.dispatch` expects.
 */
export function createClaudeCodeDispatch(
  options: ClaudeCodeDispatchOptions,
): (jobId: number) => Promise<void> {
  const urlBase = options.urlBase.replace(/\/+$/, '');
  const doFetch = options.doFetch ?? fetch;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${urlBase}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const decoded: unknown = text === '' ? undefined : JSON.parse(text);
    if (!response.ok) {
      throw new ErroDoControlPlane(
        `${method} ${route} answered ${response.status}`,
        response.status,
        decoded,
      );
    }
    return decoded as T;
  };

  return async (jobId: number): Promise<void> => {
    const job = await call<Job>(`/v1/jobs/${jobId}`, 'GET');
    const { eventos: events } = await call<{ eventos: Event[] }>(
      `/v1/jobs/${jobId}/events`,
      'GET',
    );
    const { perguntas: questions } = await call<{ perguntas: Question[] }>(
      '/v1/input-requests?status=respondida',
      'GET',
    );

    const prompt = buildPrompt(
      job,
      events,
      questions.filter((question) => question.trabalho_id === jobId),
    );

    const spec: SessionSpec = {
      workingDir: options.workingDir,
      instructions: options.instructions ?? DEFAULT_INSTRUCTIONS,
      prompt,
      timeoutSeconds,
      ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
    };

    const lines: string[] = [];
    let engineRef: string | null = null;
    let announceEnd: (outcome: Outcome) => void = () => undefined;
    const end = new Promise<Outcome>((resolve) => {
      announceEnd = resolve;
    });

    // `startSession` rejects with `SessionStartError` when the session did not
    // come up. That one propagates untouched: it is a dispatch that never
    // happened, and the controller's `finally` gives the lease back anyway.
    await options.adapter.startSession(spec, {
      onOutput(line) {
        lines.push(line);
      },
      onEngineRef(ref) {
        engineRef = ref;
      },
      onFinished(status, exitCode) {
        announceEnd({ status, exitCode });
      },
    });

    // Recorded as soon as the session is up, with whatever ref is known by
    // then. There is no endpoint to fill `engine_session_ref` in later (out of
    // scope), so `null` here means "the engine had not said it yet" and never
    // "this engine has no ref".
    const session = await call<Session>('/v1/sessions', 'POST', {
      trabalho_id: job.id,
      no_id: job.no_atual,
      engine: options.adapter.engineName,
      engine_session_ref: engineRef,
      working_dir: spec.workingDir,
      prompt: spec.prompt,
      timeout_seconds: spec.timeoutSeconds,
    });

    const outcome = await end;

    await call(`/v1/sessions/${session.id}/finish`, 'PATCH', {
      status: TAXONOMY_STATUS[outcome.status],
      exit_code: outcome.exitCode,
      // The v0 interface reports no token usage (out of scope). `null` is "the
      // engine reported nothing" and must never collapse into zero.
      uso: null,
    });

    const request: InputRequest | null = parseInputRequest(sessionText(lines));
    if (request !== null) {
      // This POST is what blocks the work, inside the control plane and in the
      // same transaction as `pergunta.criada` (FR1). The runner never posts a
      // block of its own — two owners for one flag is how a work ends up
      // blocked with nothing pending.
      await call('/v1/input-requests', 'POST', {
        trabalho_id: job.id,
        sessao_id: session.id,
        tipo: 'pergunta',
        pergunta: request.question,
        contexto: request.context ?? null,
        opcoes: request.options ?? null,
        recomendacao: request.recommendation ?? null,
        resposta_padrao: request.default ?? null,
        // The field exists since t102; nothing reads it to answer on its own —
        // the auto-answer policy is still outside the PoC.
        auto_aprovavel: true,
        ator: { tipo: 'agente', ref: job.no_atual === '' ? 'sessao' : job.no_atual },
      });
    }

    // Asking is a successful dispatch — the question is already recorded above,
    // and the work is already blocked. What is NOT successful is a session that
    // died: reporting that as a normal dispatch would hide a broken engine
    // behind a work that simply stopped moving.
    if (outcome.status !== 'completed') {
      throw new DispatchError(
        `the session of job ${job.id} ended as "${outcome.status}" (exit ${String(outcome.exitCode)})`,
        outcome.status,
        outcome.exitCode,
      );
    }
  };
}
