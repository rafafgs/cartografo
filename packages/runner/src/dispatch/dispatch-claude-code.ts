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
 * 4. reports every attempt at a tool the session's permission policy denied,
 *    as it happens (t125);
 * 5. on finish, records `sessao.finalizada` in the taxonomy's vocabulary, and
 *    ships the session's whole raw output with it — the buffer this file was
 *    already keeping for the escalation parser, which until t159 was thrown
 *    away with the process that held it;
 * 6. runs the escalation parser over the output and, if the session asked
 *    something, posts the question — which blocks the work inside the control
 *    plane, in the same transaction (t106, FR1).
 *
 * **Asking is not failing, and neither is being denied.** A dispatch that ends
 * with a pending question and a blocked work resolves normally: the lease goes
 * back through the controller's `finally`, and the work simply stops being a
 * candidate until someone answers. A denial is an incident that gets recorded,
 * never a reason to fail the dispatch nor to cancel the session — escalating on
 * repeated denials is a decision nobody has taken yet. Only a session that
 * could not start or did not reach `completed` rejects.
 *
 * English per D18. The prompt and instruction CONTENT stays in Portuguese: it
 * stands in for the skill manifest the graph will inject (t101/t105), and those
 * are written in Portuguese (`especificacoes/formatos/exemplos/`).
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import { resolvePermissions } from '../engine/permission-policy.ts';
import type {
  EngineAdapter,
  SessionPermissions,
  SessionSpec,
  SessionStatus,
} from '../engine/types.ts';
import { parseInputRequest, type InputRequest } from './parse-input-request.ts';
import { PermissionDenialTracker, type PermissionDenial } from './parse-permission-denial.ts';
import { decodeClaudeCodeSessionText } from './session-text.ts';

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
  /**
   * The graph version this work traverses, when it has one (t101).
   *
   * `null` is ordinary and not a defect: a work created by hand names an entry
   * node and no graph at all, and that is the shape every dispatch had before
   * t141. It is the first of the three ways {@link DEFAULT_ENGINE} is reached.
   */
  grafo_versao_id?: string | null;
}

/** One node of a graph snapshot, in the part this module reads. */
interface GraphNode {
  id: string;
  /** The engine declared for this node (t141, FR1). Optional by design. */
  engine?: unknown;
}

/** What `GET /v1/graph-versions/:id` gives back, in the part this module reads. */
interface GraphVersion {
  grafo_versao: {
    id: string;
    snapshot?: { nos?: GraphNode[] };
  };
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

/**
 * The engine name used when the graph says nothing (t141, FR3).
 *
 * Exported and named, never silently implied: three different situations land
 * here — a work with no `grafo_versao_id`, a node the snapshot does not carry,
 * and a node that simply declares no `engine` — and in all three the telemetry
 * has to be able to say WHICH engine ran without anyone guessing.
 */
export const DEFAULT_ENGINE = 'claude-code';

/**
 * One engine this dispatch can route to: who opens the session, and how to read
 * back what it printed.
 */
export interface EngineRoute {
  /** Production passes a real adapter; tests pass one pointed at the fake engine. */
  adapter: EngineAdapter;
  /**
   * Decodes the lines that reached `onOutput` into the text the model produced.
   *
   * Part of the route and not of the adapter because it is the DISPATCH that
   * needs the text — to find an escalation block — while the adapter's contract
   * stops at delivering lines verbatim (invariant 4). Adding it to
   * `EngineAdapter` would have grown a frozen interface (v1) for the benefit of
   * exactly one consumer.
   */
  decodeSessionText: (lines: readonly string[]) => string;
}

/** Configuration of a dispatch. */
export interface ClaudeCodeDispatchOptions {
  /**
   * Base URL of the control plane. Named as in `ClienteControle`, on purpose:
   * whoever wires both passes the same value to both.
   */
  urlBase: string;
  /**
   * Credential presented on every call (t124, t147).
   *
   * Generic on purpose: any token this control plane accepts. In production it
   * has to be the operator token, and that is not a shortcut — the five routes
   * a pairing credential reaches (`RUNNER_SURFACE`, `packages/core/src/auth.ts`)
   * do not include a single one of the seven this module calls, so a runner
   * credential answers `403 credencial_fora_de_escopo` on all of them rather
   * than degrading into anything usable. Cutting a credential that reaches
   * exactly these routes is another ticket, the same one t146 deferred for the
   * flow surveyor (`docs/spec/topografo-fluxo.md`).
   *
   * With no token no header goes out, and the API answers 401 — which is the
   * honest outcome: an empty header would look like a credential.
   */
  token?: string;
  /**
   * The engines this dispatch can route to, by the name a node declares (t141,
   * FR4).
   *
   * A table and not a single adapter, because the choice belongs to the NODE:
   * `POST /v1/sessions` has recorded `engine` dynamically since t124/t147, but
   * until this ficha there was only ever one adapter to record. The key is what
   * `no.engine` says in the graph document; the absence of that field resolves
   * to {@link DEFAULT_ENGINE}, so a graph that declares nothing behaves exactly
   * as it did before.
   *
   * Whoever wires this owns the pairing: an adapter and the decoder for the
   * frames that adapter's engine prints. Getting that pair wrong is how a
   * session's escalation stops being readable, so they travel together rather
   * than being resolved from the engine name in two different places.
   */
  engines: Record<string, EngineRoute>;
  /** Where the session runs — typically an isolated git worktree. */
  workingDir: string;
  /** Wall-clock limit of the session. Default: one hour. */
  timeoutSeconds?: number;
  /** Node instructions. Default: {@link DEFAULT_INSTRUCTIONS}. */
  instructions?: string;
  /** Opaque additions to the engine's environment. */
  envOverrides?: Readonly<Record<string, string>>;
  /**
   * Permission policy of the session (t125).
   *
   * Passed straight through to the `SessionSpec`, like `instructions` and
   * `envOverrides`. Resolving it from the node's real `skill_ref` — registry
   * lookup, hash check — belongs to the skill-rendering pipeline, which does
   * not exist yet (`especificacoes/formatos/manifesto-skill.md:18-20`); what
   * exists here is the seam that pipeline will fill.
   */
  permissions?: SessionPermissions;
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

/**
 * A node asked for an engine this dispatch has no route for (t141, FR5).
 *
 * Thrown BEFORE any session opens, and never softened into a fallback: routing
 * the work to whatever engine happens to be registered would run it on an engine
 * nobody chose AND record that engine as if the graph had asked for it. The
 * telemetry would be internally consistent and false, which is worse than a
 * dispatch that stops.
 *
 * It propagates untouched, the same way `SessionStartError` does: the controller's
 * `finally` returns the lease, and the work is simply not advanced.
 */
export class UnknownEngineError extends Error {
  /** The engine the node declared. */
  readonly engine: string;
  /** The node that declared it. */
  readonly nodeId: string;
  /** The engines that DO have a route, for the message a human reads. */
  readonly known: readonly string[];

  constructor(engine: string, nodeId: string, known: readonly string[]) {
    super(
      `node "${nodeId}" asks for engine "${engine}", which has no route in this dispatch ` +
        `(registered: ${known.length === 0 ? 'none' : known.join(', ')})`,
    );
    this.name = 'UnknownEngineError';
    this.engine = engine;
    this.nodeId = nodeId;
    this.known = known;
  }
}

/** Default wall-clock limit, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 3_600;

/**
 * `ator.ref` of a permission denial.
 *
 * `sistema` and not `agente`: the fact being recorded is not something the
 * session decided, it is the wiring reporting what the engine refused. Same
 * `ref` the control plane uses by default for a write coming from the runner,
 * on purpose — two spellings for one actor is how a log stops being groupable.
 */
const RUNNER_ACTOR_REF = 'runner';

/**
 * Everything the session said, with Claude Code's frames decoded back into text.
 *
 * @deprecated Moved to `./session-text.ts` as `decodeClaudeCodeSessionText`
 * (t141, FR6) — one decoder per engine, now that there is more than one engine
 * to decode. Re-exported here, unchanged, so nothing that imported it breaks.
 */
export const sessionText = decodeClaudeCodeSessionText;

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

  // Headers of every call: the body's `content-type`, when there is a body, and
  // the credential. Built once — the seven routes below are one client, and a
  // route that assembled its own headers is a route that could forget them.
  const headers = (withBody: boolean): Record<string, string> => {
    const built: Record<string, string> = {};
    if (withBody) built['content-type'] = 'application/json';
    if (options.token !== undefined) built.authorization = `Bearer ${options.token}`;
    return built;
  };

  const call = async <T>(route: string, method: string, body?: unknown): Promise<T> => {
    const response = await doFetch(`${urlBase}${route}`, {
      method,
      headers: headers(body !== undefined),
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

  /**
   * Which engine handles the node this work is sitting on RIGHT NOW (FR3).
   *
   * The current node and not the entry one: a work moves, and the engine is a
   * property of the step being executed, not of the traversal that contains it.
   *
   * Three roads lead to {@link DEFAULT_ENGINE}, and all three are ordinary: the
   * work carries no graph version, the snapshot has no node with this id, or the
   * node declares no `engine`. A missing graph version the work explicitly
   * points at is NOT one of them — that is a dangling reference, and `call`
   * rejects on the 404 rather than papering over it with a default.
   *
   * @param job The work being dispatched.
   * @returns The engine name to route on.
   */
  const resolveEngine = async (job: Job): Promise<string> => {
    const versionId = job.grafo_versao_id;
    if (versionId === undefined || versionId === null || versionId === '') return DEFAULT_ENGINE;

    const { grafo_versao: version } = await call<GraphVersion>(
      `/v1/graph-versions/${encodeURIComponent(versionId)}`,
      'GET',
    );
    const node = version.snapshot?.nos?.find((candidate) => candidate.id === job.no_atual);
    const declared = node?.engine;
    // Free text at the schema level on purpose (Out of Scope: no closed enum),
    // so "declared" means a non-empty string and nothing else.
    if (typeof declared !== 'string' || declared.trim() === '') return DEFAULT_ENGINE;
    return declared;
  };

  return async (jobId: number): Promise<void> => {
    const job = await call<Job>(`/v1/jobs/${jobId}`, 'GET');

    // Resolved before anything is read for the prompt and long before a session
    // opens: an engine nobody registered has to stop the dispatch while stopping
    // it is still free (FR5).
    const engineName = await resolveEngine(job);
    const route = options.engines[engineName];
    if (route === undefined) {
      throw new UnknownEngineError(engineName, job.no_atual, Object.keys(options.engines));
    }

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
      ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    };

    const lines: string[] = [];
    let engineRef: string | null = null;
    let announceEnd: (outcome: Outcome) => void = () => undefined;
    const end = new Promise<Outcome>((resolve) => {
      announceEnd = resolve;
    });

    // The tracker watches for exactly what this session denied — the same list
    // the adapter handed the engine, resolved from the same policy (t125, FR6).
    const tracker = new PermissionDenialTracker(
      resolvePermissions(options.permissions).deniedTools,
    );

    // A denial can happen before `POST /v1/sessions` has answered, and there is
    // no id to post it against until then. It waits here, and the queue is
    // drained as soon as the id exists.
    const queued: PermissionDenial[] = [];
    let sessionId: number | null = null;
    let denialWrites: Promise<void> = Promise.resolve();
    let denialFailure: unknown = null;

    const recordDenial = (denial: PermissionDenial): void => {
      const id = sessionId;
      if (id === null) {
        queued.push(denial);
        return;
      }
      // Serialized, and with the catch attached right here: a rejection with
      // nobody listening yet would take the whole process down as an unhandled
      // rejection, long before anyone could report it.
      denialWrites = denialWrites
        .then(() =>
          call(`/v1/sessions/${id}/permission-denials`, 'POST', {
            recurso: denial.recurso,
            ferramenta: denial.ferramenta,
            motivo: denial.motivo,
            ator: { tipo: 'sistema', ref: RUNNER_ACTOR_REF },
          }),
        )
        .then(() => undefined)
        .catch((error: unknown) => {
          denialFailure ??= error;
        });
    };

    // `startSession` rejects with `SessionStartError` when the session did not
    // come up. That one propagates untouched: it is a dispatch that never
    // happened, and the controller's `finally` gives the lease back anyway.
    await route.adapter.startSession(spec, {
      onOutput(line) {
        lines.push(line);
        for (const denial of tracker.observe(line)) recordDenial(denial);
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
      engine: route.adapter.engineName,
      engine_session_ref: engineRef,
      working_dir: spec.workingDir,
      prompt: spec.prompt,
      timeout_seconds: spec.timeoutSeconds,
    });

    sessionId = session.id;
    for (const denial of queued.splice(0)) recordDenial(denial);

    const outcome = await end;

    // Drained BEFORE the end of the session, so the log reads in the order
    // things happened: the session opened, it was denied, it finished. A
    // failure here is remembered and surfaced at the very end — telemetry of an
    // incident may not cost the session its closure nor its question.
    await denialWrites;

    await call(`/v1/sessions/${session.id}/finish`, 'PATCH', {
      status: TAXONOMY_STATUS[outcome.status],
      exit_code: outcome.exitCode,
      // The v0 interface reports no token usage (out of scope). `null` is "the
      // engine reported nothing" and must never collapse into zero.
      uso: null,
      // The raw stream, exactly as `onOutput` reported it — undecoded, frames
      // and dying screams alike (t159). `decodeSessionText` below is a READER
      // of this same buffer, and its frame-decoding is lossy by design: what
      // gets persisted is the material before that, because a session that
      // died is diagnosed from what it printed, not from what parsed.
      transcricao: lines.join('\n'),
    });

    const request: InputRequest | null = parseInputRequest(route.decodeSessionText(lines));
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

    // A denial that could not be recorded is not the session's fault, but it is
    // a fault: the control plane refused a write the runner owes it, and a
    // silent swallow here would leave the log claiming a clean session.
    if (denialFailure !== null) throw denialFailure;

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
