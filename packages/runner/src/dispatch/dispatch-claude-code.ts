/**
 * The real dispatch: an `EngineAdapter` session, wired to the control plane
 * (t106, FR6/FR7).
 *
 * This is the seam t103 left open. `Controller.despachar` is an injected
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
export const STATUS_DA_TAXONOMIA: Readonly<Record<SessionStatus, string>> = Object.freeze({
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
export const INSTRUCOES_PADRAO = [
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
interface Trabalho {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  execucao_id: number | null;
}

/** One envelope of the work's timeline. */
interface Evento {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  dados: Record<string, unknown>;
}

/** A question, as `GET /v1/input-requests` projects it. */
interface Pergunta {
  id: number;
  trabalho_id: number;
  pergunta: string;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
}

/** A session, as `POST /v1/sessions` gives it back. */
interface Sessao {
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
  /** Node instructions. Default: {@link INSTRUCOES_PADRAO}. */
  instructions?: string;
  /** Opaque additions to the engine's environment. */
  envOverrides?: Readonly<Record<string, string>>;
  /** `fetch` implementation. Default: the global one. Test seam only. */
  buscar?: typeof fetch;
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
function textoDoQuadro(linha: string): string[] | null {
  const podado = linha.trim();
  if (!podado.startsWith('{')) return null;

  let quadro: unknown;
  try {
    quadro = JSON.parse(podado);
  } catch {
    return null;
  }
  if (typeof quadro !== 'object' || quadro === null) return null;

  const { type, result, message } = quadro as {
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
    if (Array.isArray(content)) return content.filter(isTextBlock).map((bloco) => bloco.text);
  }

  return null;
}

/** Everything the session said, with engine frames decoded back into text. */
export function textoDaSessao(linhas: readonly string[]): string {
  const partes: string[] = [];
  for (const linha of linhas) {
    const textos = textoDoQuadro(linha);
    if (textos === null) partes.push(linha);
    else partes.push(...textos);
  }
  return partes.join('\n');
}

/**
 * The prompt of a dispatch: what to do, plus what was already asked and
 * answered.
 *
 * @param trabalho The work being dispatched.
 * @param eventos Its timeline, in log order.
 * @param respondidas Questions already answered, from the projection.
 * @returns The prompt text.
 */
export function montarPrompt(
  trabalho: Trabalho,
  eventos: readonly Evento[],
  respondidas: readonly Pergunta[],
): string {
  const partes = [
    `# Trabalho #${trabalho.id} — ${trabalho.titulo}`,
    '',
    `Nó atual: \`${trabalho.no_atual}\`.`,
    '',
    'Faça o que este nó pede neste trabalho, no diretório em que você está.',
  ];

  const porId = new Map(respondidas.map((pergunta) => [pergunta.id, pergunta]));
  const jaFechadas: Pergunta[] = [];

  // The ORDER comes from the log — the only total ordering there is — and the
  // ANSWER from the projection: `pergunta.respondida` carries no `trabalho_id`,
  // so the work's timeline structurally cannot show it (t102,
  // `packages/core/src/db/events.ts`, `FiltroDeEventos`).
  for (const evento of eventos) {
    if (evento.tipo !== 'pergunta.criada') continue;
    const pergunta = porId.get(Number(evento.entidade.id));
    if (pergunta !== undefined && pergunta.resposta !== null) jaFechadas.push(pergunta);
  }

  if (jaFechadas.length > 0) {
    partes.push(
      '',
      '## O que você já perguntou, e o que responderam',
      '',
      'Isto já foi decidido. Não pergunte de novo: siga a resposta.',
    );
    for (const pergunta of jaFechadas) {
      const quem = pergunta.origem === 'auto' ? 'a resposta automática' : (pergunta.respondido_por ?? 'a pessoa');
      partes.push(
        '',
        `- **Você perguntou:** ${pergunta.pergunta}`,
        `  **${quem} respondeu:** ${pergunta.resposta ?? ''}`,
      );
    }
  }

  return partes.join('\n');
}

/** What the session reported when it ended. */
interface Desfecho {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Builds the `despachar` callback of the controller (t103), with a real engine
 * behind it.
 *
 * @param opcoes Control plane, engine, working directory and session limits.
 * @returns The exact signature `OpcoesDoController.despachar` expects.
 */
export function createClaudeCodeDispatch(
  opcoes: ClaudeCodeDispatchOptions,
): (trabalhoId: number) => Promise<void> {
  const urlBase = opcoes.urlBase.replace(/\/+$/, '');
  const buscar = opcoes.buscar ?? fetch;
  const timeoutSeconds = opcoes.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  const pedir = async <T>(caminho: string, metodo: string, corpo?: unknown): Promise<T> => {
    const resposta = await buscar(`${urlBase}${caminho}`, {
      method: metodo,
      headers: corpo === undefined ? undefined : { 'content-type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resposta.text();
    const decodificado: unknown = texto === '' ? undefined : JSON.parse(texto);
    if (!resposta.ok) {
      throw new ErroDoControlPlane(
        `${metodo} ${caminho} respondeu ${resposta.status}`,
        resposta.status,
        decodificado,
      );
    }
    return decodificado as T;
  };

  return async (trabalhoId: number): Promise<void> => {
    const trabalho = await pedir<Trabalho>(`/v1/jobs/${trabalhoId}`, 'GET');
    const { eventos } = await pedir<{ eventos: Evento[] }>(
      `/v1/jobs/${trabalhoId}/events`,
      'GET',
    );
    const { perguntas } = await pedir<{ perguntas: Pergunta[] }>(
      '/v1/input-requests?status=respondida',
      'GET',
    );

    const prompt = montarPrompt(
      trabalho,
      eventos,
      perguntas.filter((pergunta) => pergunta.trabalho_id === trabalhoId),
    );

    const spec: SessionSpec = {
      workingDir: opcoes.workingDir,
      instructions: opcoes.instructions ?? INSTRUCOES_PADRAO,
      prompt,
      timeoutSeconds,
      ...(opcoes.envOverrides === undefined ? {} : { envOverrides: opcoes.envOverrides }),
    };

    const linhas: string[] = [];
    let engineRef: string | null = null;
    let avisarFim: (desfecho: Desfecho) => void = () => undefined;
    const fim = new Promise<Desfecho>((resolve) => {
      avisarFim = resolve;
    });

    // `startSession` rejects with `SessionStartError` when the session did not
    // come up. That one propagates untouched: it is a dispatch that never
    // happened, and the controller's `finally` gives the lease back anyway.
    await opcoes.adapter.startSession(spec, {
      onOutput(linha) {
        linhas.push(linha);
      },
      onEngineRef(ref) {
        engineRef = ref;
      },
      onFinished(status, exitCode) {
        avisarFim({ status, exitCode });
      },
    });

    // Recorded as soon as the session is up, with whatever ref is known by
    // then. There is no endpoint to fill `engine_session_ref` in later (out of
    // scope), so `null` here means "the engine had not said it yet" and never
    // "this engine has no ref".
    const sessao = await pedir<Sessao>('/v1/sessions', 'POST', {
      trabalho_id: trabalho.id,
      no_id: trabalho.no_atual,
      engine: opcoes.adapter.engineName,
      engine_session_ref: engineRef,
      working_dir: spec.workingDir,
      prompt: spec.prompt,
      timeout_seconds: spec.timeoutSeconds,
    });

    const desfecho = await fim;

    await pedir(`/v1/sessions/${sessao.id}/finish`, 'PATCH', {
      status: STATUS_DA_TAXONOMIA[desfecho.status],
      exit_code: desfecho.exitCode,
      // The v0 interface reports no token usage (out of scope). `null` is "the
      // engine reported nothing" and must never collapse into zero.
      uso: null,
    });

    const pedido: InputRequest | null = parseInputRequest(textoDaSessao(linhas));
    if (pedido !== null) {
      // This POST is what blocks the work, inside the control plane and in the
      // same transaction as `pergunta.criada` (FR1). The runner never posts a
      // block of its own — two owners for one flag is how a work ends up
      // blocked with nothing pending.
      await pedir('/v1/input-requests', 'POST', {
        trabalho_id: trabalho.id,
        sessao_id: sessao.id,
        tipo: 'pergunta',
        pergunta: pedido.question,
        contexto: pedido.context ?? null,
        opcoes: pedido.options ?? null,
        recomendacao: pedido.recommendation ?? null,
        resposta_padrao: pedido.default ?? null,
        // The field exists since t102; nothing reads it to answer on its own —
        // the auto-answer policy is still outside the PoC.
        auto_aprovavel: true,
        ator: { tipo: 'agente', ref: trabalho.no_atual === '' ? 'sessao' : trabalho.no_atual },
      });
    }

    // Asking is a successful dispatch — the question is already recorded above,
    // and the work is already blocked. What is NOT successful is a session that
    // died: reporting that as a normal dispatch would hide a broken engine
    // behind a work that simply stopped moving.
    if (desfecho.status !== 'completed') {
      throw new DispatchError(
        `a sessão do trabalho ${trabalho.id} terminou como "${desfecho.status}" (exit ${String(desfecho.exitCode)})`,
        desfecho.status,
        desfecho.exitCode,
      );
    }
  };
}
