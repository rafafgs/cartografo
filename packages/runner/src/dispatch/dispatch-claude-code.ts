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
 * **And every session gets a tree of its own** (t160). The directory a session
 * runs in is its entire write scope (`docs/formatos/engine-adapter.md`,
 * invariant 7), so it is acquired per dispatch from a `WorktreeManager` and
 * given back on every path out of here — kept for diagnosis unless the session
 * completed. There is no static working directory left to fall back to, which
 * is the point: with one, every session of every job wrote in the same tree as
 * the operator.
 *
 * **Asking is not failing, and neither is being denied.** A dispatch that ends
 * with a pending question and a blocked work resolves normally: the lease goes
 * back through the controller's `finally`, and the work simply stops being a
 * candidate until someone answers. A denial is an incident that gets recorded,
 * never a reason to fail the dispatch nor to cancel the session — escalating on
 * repeated denials is a decision nobody has taken yet. Only a session that
 * could not start or did not reach `completed` rejects.
 *
 * **And a dispatch never settles with a live session.** The lease goes back
 * through that same `finally` however this callback settles, so a rejection
 * with the engine still running hands the work to the next tick while a process
 * is still writing in the same working dir — two sessions, one directory. So
 * anything that fails between the session coming up and its outcome being known
 * cancels it before rethrowing (t148). Once the outcome IS known the session is
 * terminal on its own account, and what is left is telemetry the runner owes:
 * the closure and the question are attempted write by write, so that neither
 * one can swallow the other.
 *
 * English per D18. The prompt and instruction CONTENT stays in Portuguese: it
 * stands in for the skill manifest the graph will inject (t101/t105), and those
 * are written in Portuguese (`especificacoes/formatos/exemplos/`).
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import { resolvePermissions } from '../engine/permission-policy.ts';
import { resolveBudget } from '../engine/resolve-budget.ts';
import type {
  EngineAdapter,
  SessionFinishDetail,
  SessionPermissions,
  SessionSpec,
  SessionStatus,
} from '../engine/types.ts';
import { parseInputRequest, type InputRequest } from './parse-input-request.ts';
import { parseNodeResult } from './parse-node-result.ts';
import { PermissionDenialTracker, type PermissionDenial } from './parse-permission-denial.ts';
import {
  ESCALATION_PROTOCOL,
  renderSkillInstructions,
  type RegisteredSkill,
  type RenderedSkill,
} from './render-skill-instructions.ts';
import {
  resolveEscalationPolicy,
  resolveNode,
  type EscalationPolicy,
  type GraphEdge,
  type GraphVersionBody,
  type ResolvedNode,
} from './resolve-node.ts';
import { decodeClaudeCodeSessionText } from './session-text.ts';
import type { WorktreeManager } from './session-worktree.ts';

export {
  ESCALATION_PROTOCOL,
  SkillNotRegisteredError,
  SkillPinMismatchError,
} from './render-skill-instructions.ts';

/**
 * Which escalation policy governs the node being dispatched (t167, FR4).
 *
 * Re-exported here, where {@link DEFAULT_ENGINE} and `resolveEngine` live,
 * because this is the module that ACTS on the answer: the two places that would
 * raise a question resolve it first, and `never` routes them to
 * `POST /v1/jobs/:id/blocks` instead. It is defined next to the field it reads
 * (`resolve-node.ts`) so that the instruction renderer can ask the same question
 * without the two modules importing each other — the same shape
 * `ESCALATION_PROTOCOL` above already has.
 */
export { resolveEscalationPolicy, DEFAULT_ESCALATION_POLICY } from './resolve-node.ts';
export type { EscalationPolicy } from './resolve-node.ts';

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
 * The instruction of a work with NO resolvable node, fixed and literal, exactly
 * as t104's spike wrote it.
 *
 * It stopped being the instruction of every session in t161: a work standing on
 * a node of a registered graph is dispatched with that node's skill rendered
 * into it (`render-skill-instructions.ts`), which is what the manifest format
 * had been waiting for since t117. What is left here is the honest fallback for
 * the case that has no graph to read — a work created by hand, which is every
 * work this package's own suite dispatches — and it composes
 * {@link ESCALATION_PROTOCOL} rather than restating it, so that the two texts
 * cannot drift apart on the one paragraph both of them need.
 */
export const DEFAULT_INSTRUCTIONS = [
  'Você é uma sessão de trabalho despachada pelo runner do cartografo.',
  '',
  'Trabalhe no diretório atual e faça o que o trabalho pede.',
  '',
  ESCALATION_PROTOCOL,
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

  /**
   * What this work costs to run, as the intake triaged it (t175).
   *
   * Optional and nullable for the same reason `grafo_versao_id` above is: a work
   * created by hand names no tier, and every work born before the column existed
   * reads `null`. Absent and `null` mean the same thing here — nobody
   * classified it — and neither means `trivial`.
   */
  tier?: 'trivial' | 'standard' | null;
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
  /**
   * Who gives each session the directory it runs in (t160, FR6).
   *
   * It replaced a static `workingDir: string`, and the replacement IS the
   * enforcement: while that field existed, every session this dispatch ever
   * opened wrote in the same tree — including the operator's own checkout — and
   * any "isolate it" logic would have had a value to quietly fall back to.
   * There is no such value here anymore.
   *
   * Required, with no default: a manager chosen by this module would be a guess
   * about which repository sessions may write in, and that guess is what gap #6
   * of the first dogfood run cost.
   */
  worktrees: WorktreeManager;
  /** Wall-clock limit of the session. Default: one hour. */
  timeoutSeconds?: number;
  /**
   * Silence tolerated before the session is stopped (t163, FR9).
   *
   * The second watchdog, and the second budget: it resolves through
   * {@link resolveBudget} against {@link DEFAULT_SILENCE_SECONDS}, so declaring
   * a shorter one shortens it and declaring a longer one does nothing. Zero and
   * negative are "no override", never "no watchdog".
   *
   * This is where a skill's declared `orcamentos.silencio_s` will arrive when
   * something finally renders a registered manifest into a dispatch — the same
   * seam `permissions` below already is, and for the same missing pipeline.
   */
  silenceSeconds?: number;
  /**
   * Node instructions, for a work with no resolvable node.
   *
   * Since t161 it is a FALLBACK and no longer an override: a work standing on a
   * node of a registered graph is dispatched with that node's skill rendered
   * into the session, and a dispatch-wide literal that replaced it would be
   * exactly the hand-cranked mode this ficha closes — one instruction for every
   * node of every graph, decided by whoever wired the process. What still
   * arrives here is the text for a work with no graph, or one whose node the
   * snapshot does not carry. Default: {@link DEFAULT_INSTRUCTIONS}.
   */
  instructions?: string;
  /** Opaque additions to the engine's environment. */
  envOverrides?: Readonly<Record<string, string>>;
  /**
   * Permission policy of a session with no resolvable node (t125).
   *
   * The seam t125 left open is filled: a dispatch that resolves a node resolves
   * its skill too, and the session runs under the policy that skill's manifest
   * declares — registry lookup and hash check included (t161, FR6). This field
   * is what is left for a work with no graph behind it, and for those it behaves
   * exactly as it always did.
   *
   * The precedence is not a preference. `permissions` is inside the manifest's
   * content hash on purpose, so a skill that opens a permission changes hash and
   * reappears at the human gate; letting a dispatch-wide option override it
   * would make that whole mechanism decorative.
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
 * Server ceiling for silence, in seconds (t163, FR9).
 *
 * 300s is flowpilot's own `DEFAULT_SILENCE_SECONDS`: short enough that a stuck
 * session is noticed while somebody still cares, long enough that a session
 * thinking hard between two tool calls is not murdered for it. Exported because
 * it IS the ceiling — whoever reads a skill's declared budget resolves against
 * this number, and a ceiling nobody can name is a ceiling nobody can check.
 *
 * "Server config" in the ticket's sense is exactly this: a constant plus a
 * dispatch option, the same shape {@link DEFAULT_TIMEOUT_SECONDS} has had since
 * t106. There is no configuration subsystem in `packages/core` to put it in, and
 * inventing one for two numbers is how a knob nobody turns gets born.
 */
export const DEFAULT_SILENCE_SECONDS = 300;

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
  /**
   * Which watchdog stopped it, when the adapter itself stopped it (t163).
   *
   * Absent means the adapter reported no cause, and that is what gets recorded:
   * `null`, never one of the two picked because it looked likely.
   */
  timeoutReason?: SessionFinishDetail['timeoutReason'];
  /**
   * The tokens the engine reported, when it reported any (t172).
   *
   * Same reading as the field above, applied to the number this whole ficha is
   * about: absent is "the engine counted nothing", it is recorded as `null`, and
   * it is never completed with zeros. An engine whose adapter does not declare
   * `reportsUsage` lands here absent, which is exactly what it is.
   */
  usage?: SessionFinishDetail['usage'];
  /** Which models ran it, when the engine named them (t172). */
  models?: SessionFinishDetail['models'];
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
  const silenceSeconds = resolveBudget(options.silenceSeconds, DEFAULT_SILENCE_SECONDS);

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
   * Which engine handles the node this work is sitting on RIGHT NOW (t141, FR3).
   *
   * The current node and not the entry one: a work moves, and the engine is a
   * property of the step being executed, not of the traversal that contains it.
   *
   * Three roads lead to {@link DEFAULT_ENGINE}, and all three are ordinary: the
   * work carries no graph version, the snapshot has no node with this id, or the
   * node declares no `engine`. A missing graph version the work explicitly
   * points at is NOT one of them — that is a dangling reference, and it rejects
   * out of `resolveNode` rather than being papered over with a default.
   *
   * Since t161 the fetch is `resolveNode`'s and this function is pure: the first
   * two roads are the same `null` the rest of the dispatch reads, so the engine
   * that ran and the edge that was taken come from ONE read of ONE snapshot.
   *
   * @param resolved The node this dispatch resolved, or `null`.
   * @returns The engine name to route on.
   */
  const resolveEngine = (resolved: ResolvedNode | null): string => {
    const declared = resolved?.node.engine;
    // Free text at the schema level on purpose (Out of Scope: no closed enum),
    // so "declared" means a non-empty string and nothing else.
    if (typeof declared !== 'string' || declared.trim() === '') return DEFAULT_ENGINE;
    return declared;
  };

  /**
   * Which model of that engine runs the node this work is sitting on (t166, FR5).
   *
   * The mirror of {@link resolveEngine}, with the one difference that matters:
   * there is no `DEFAULT_MODEL` to fall back to, and there must not be. The
   * runner has no way of knowing which models a given installation can reach,
   * so the honest absence is `undefined` — no flag assembled, the engine picks
   * its own default, and the telemetry records that nobody chose. A constant
   * here would put a decision into every session that no graph ever made.
   *
   * The blank-string guard is the same one `resolveEngine` has, and it earns
   * its place for a different reason: a `model: "  "` that survived into a
   * snapshot would otherwise reach the CLI as an empty `--model`, and the
   * session would die on a flag nobody typed.
   *
   * @param resolved The node this dispatch resolved, or `null`.
   * @returns The model identifier to pin, or `undefined` for the engine's own.
   */
  const resolveModel = (resolved: ResolvedNode | null): string | undefined => {
    const declared = resolved?.node.model;
    if (typeof declared !== 'string' || declared.trim() === '') return undefined;
    return declared;
  };

  /**
   * Moves the work along the edge the traversal chose (FR10).
   *
   * The one write of this whole ficha that PROPAGATES on failure, and the
   * asymmetry with the denial and the closure is deliberate: those are telemetry
   * the runner owes after the fact, and a work that keeps moving with a gap in
   * its log is recoverable. A transition that was not recorded is a work that
   * stopped, standing on a node it already finished, with nobody able to tell
   * that from a work that is merely slow. That is the single failure mode this
   * ficha exists to close, so it may not be swallowed into a report at the end.
   *
   * @param job The work being dispatched.
   * @param edge The edge to take.
   */
  const transition = async (job: Job, edge: GraphEdge): Promise<void> => {
    await call(`/v1/jobs/${job.id}/transitions`, 'POST', {
      para_no_id: edge.to,
      ator: { tipo: 'sistema', ref: RUNNER_ACTOR_REF },
    });
  };

  /**
   * Stops the work with a reason, for a node that has nobody to ask (t167, FR6).
   *
   * The other half of `never`, and the half that is deterministic: the rendered
   * instructions ask the session not to write an escalation block, and this is
   * what happens when one shows up anyway — or when the wiring itself has no
   * rule to apply. `POST /v1/jobs/:id/blocks` is an unconditional, reason-
   * carrying block that has existed since t102, so nothing new is invented here;
   * what is chosen at dispatch time is WHICH of the two existing mechanisms
   * stops the work.
   *
   * The difference that matters is what is NOT created: no row in `pergunta`,
   * no `pergunta.criada`, nothing in anybody's queue. A node that declares it has
   * nobody to ask may not put a line in the queue of someone who is not there —
   * that queue is the list of things a person is expected to answer, and a
   * question nobody owns sitting in it forever is exactly the state `never`
   * exists to avoid.
   *
   * The actor is `sistema/runner`, like every other write this module makes on
   * its own account: the wiring stopped the work, not the session and not a
   * person.
   *
   * @param job The work being dispatched.
   * @param motivo Why it stopped — it quotes the node and what walled the
   *   session, because `trabalho.motivo_bloqueio` is what whoever opens the work
   *   reads first.
   */
  const blockWithNobodyToAsk = async (job: Job, motivo: string): Promise<void> => {
    await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
      motivo,
      ator: { tipo: 'sistema', ref: RUNNER_ACTOR_REF },
    });
  };

  /**
   * Asks a human which way the work goes (FR9).
   *
   * Reached when a node with more than one way out finished without naming one
   * of them: no block, a malformed block, or a result that matches no edge —
   * the last of which is a real case and not a defect. The reference graph's own
   * gate declares `escala` in its `saida_schema` and has no edge for it, on
   * purpose: some outcomes are not the machine's to route.
   *
   * `ator.tipo` is `sistema` and not `agente`, which is the only thing that
   * tells this question apart from one the SESSION wrote: that one is a model
   * asking for a decision, this one is the wiring reporting that it has no rule
   * to apply. Two spellings for two different facts, in a log somebody has to be
   * able to group.
   *
   * At a `never` node it stops the work instead of asking (t167, FR6). The
   * missing routing decision is just as real, and the work stops just as hard —
   * what changes is that nobody is called for it, which is what the node
   * declared.
   */
  const escalateRouting = async (
    job: Job,
    sessionId: number,
    edges: readonly GraphEdge[],
    observed: string | null,
    policy: EscalationPolicy,
  ): Promise<void> => {
    const labels = edges.map((edge) => edge.condition ?? '').filter((label) => label !== '');
    const seen = observed === null ? 'nenhum' : `"${observed}"`;
    // Built with concatenation and not with a nested template literal: the D18
    // sweep's masking scanner reads one backtick at a time, and a template
    // inside a `${…}` silently desyncs it for the whole rest of the file
    // (`test/no-portuguese-identifiers.test.ts`, "one backtick in a comment can
    // swallow the quoted strings that follow it").
    const routes = edges
      .map((edge) => '`' + (edge.condition ?? '') + '` → `' + edge.to + '`')
      .join(', ');

    const question =
      `O nó \`${job.no_atual}\` tem mais de uma saída e a sessão não escolheu ` +
      `nenhuma delas: o resultado observado foi ${seen}, e ele não casa com ` +
      'aresta nenhuma deste nó. Por qual aresta o trabalho segue?';

    if (policy === 'never') {
      await blockWithNobodyToAsk(job, `${question} Este nó não tem a quem perguntar.`);
      return;
    }

    await call('/v1/input-requests', 'POST', {
      trabalho_id: job.id,
      sessao_id: sessionId,
      tipo: 'pergunta',
      pergunta: question,
      contexto:
        `Arestas que saem de \`${job.no_atual}\`: ${routes}. ` +
        'A sessão terminou sem falhar; o que falta é a decisão de rota.',
      opcoes: labels,
      recomendacao: null,
      resposta_padrao: null,
      // Written as `true` since t102, and nothing reads it to answer on its own:
      // a routing escalation is resolved by a person, same as every other
      // pending question today.
      auto_aprovavel: true,
      ator: { tipo: 'sistema', ref: RUNNER_ACTOR_REF },
    });
  };

  /**
   * Advances the work to the next node, or asks (FR8/FR9).
   *
   * Only ever called for a session that ended `completed` AND asked nothing:
   * advancing a work that escalated would answer its own question by walking
   * away from it, and advancing one whose session died would record progress
   * that never happened.
   *
   * @param job The work being dispatched.
   * @param resolved Its node and the edges leaving it.
   * @param sessionId The session that just finished, for the question's trail.
   * @param output Everything the session printed, decoded.
   */
  const advance = async (
    job: Job,
    resolved: ResolvedNode,
    sessionId: number,
    output: string,
  ): Promise<void> => {
    const { edges } = resolved;

    // Nothing to do: a node with no way out is a final node by the graph's own
    // `termina` soundness rule, and the work has arrived. What marks it as
    // finished is `concluido`, derived by the control plane from this very
    // position (t152) — the runner records no arrival of its own.
    if (edges.length === 0) return;

    // Deterministic by construction: one way out is taken whatever the label
    // says. Every non-gate node of the reference graph labels it `sempre`, and
    // that string is not special-cased — a node with a single edge has no
    // decision to report, so asking it for one would invent a decision and then
    // escalate for the lack of an answer to it.
    if (edges.length === 1) {
      await transition(job, edges[0]);
      return;
    }

    const observed = parseNodeResult(output)?.resultado ?? null;
    const chosen = edges.find((edge) => edge.condition === observed);
    if (chosen === undefined) {
      await escalateRouting(job, sessionId, edges, observed, resolveEscalationPolicy(resolved));
      return;
    }

    await transition(job, chosen);
  };

  return async (jobId: number): Promise<void> => {
    const job = await call<Job>(`/v1/jobs/${jobId}`, 'GET');

    // ONE read of the graph version, and it is the first thing the dispatch
    // does: the engine, the skill, the contract and the edges all come out of
    // this (FR1). A version the work points at and that does not resolve
    // rejects right here, which is where stopping is cheapest.
    const resolved = await resolveNode(job, (route) => call<GraphVersionBody>(route, 'GET'));

    // Resolved before anything is read for the prompt and long before a session
    // opens: an engine nobody registered has to stop the dispatch while stopping
    // it is still free (t141, FR5).
    const engineName = resolveEngine(resolved);
    const route = options.engines[engineName];
    if (route === undefined) {
      throw new UnknownEngineError(engineName, job.no_atual, Object.keys(options.engines));
    }

    // Then the skill, in the same window and for the same reason: an
    // unregistered skill or a pin that stopped matching refuses the dispatch
    // before a worktree is cut, before a session exists and before a single
    // token is spent (FR3). A refusal after the engine is running is a refusal
    // that already let the instructions out.
    const rendered: RenderedSkill | null =
      resolved === null
        ? null
        : await renderSkillInstructions(resolved, (skillRoute) =>
            call<RegisteredSkill>(skillRoute, 'GET'),
          );

    // The manifest wins over the dispatch's own configuration wherever it has
    // something to say, and falls back to it where it does not (FR4/FR6).
    const instructions = rendered?.instructions ?? options.instructions ?? DEFAULT_INSTRUCTIONS;
    const permissions = rendered?.permissions ?? options.permissions;

    // The whole write scope of this session, minted here and nowhere else
    // (FR7). After the engine check, because the cheapest failure stays first,
    // and before anything is read for the prompt: from this line on there is a
    // directory that has to be given back, whichever way this callback settles.
    const worktree = await options.worktrees.acquire(job.id);

    let released = false;
    let releaseFailure: unknown = null;

    /**
     * Gives the worktree back, exactly once, on whatever path leaves here.
     *
     * Idempotent because the paths overlap on purpose: the terminal path
     * releases with the fate the outcome earned, and the catch below releases
     * whatever it finds still held — including what the terminal path already
     * handed over on its way to throwing.
     *
     * The failure is captured, never thrown from here, exactly as
     * `denialFailure` and `finishFailure` are: a cleanup that could not be done
     * is a fault worth reporting, and never a reason to replace the error that
     * is already unwinding with a symptom of it.
     */
    const release = async (keep: boolean): Promise<void> => {
      if (released) return;
      released = true;
      try {
        await options.worktrees.release(worktree, { keep });
      } catch (error) {
        releaseFailure = error;
      }
    };

    try {
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

      // Read from the SAME resolved node the engine came from, and spread only
      // when there is one: a `model: undefined` key present in the object would
      // still be a key, and `buildCommand` reads absence, not falsiness.
      const model = resolveModel(resolved);

      // The tier comes off the WORK, not off the node — it is a property of what
      // is being done, not of the step doing it, so it is set once here and
      // travels to whichever engine this node resolved to. Which model that
      // buys is the adapter's answer, below boundary 1, where model names live.
      // Same conditional spread and same reason as `model` above: `null` is the
      // ordinary "nobody triaged this", and it has to reach the adapters as an
      // absent key rather than a present one holding nothing.
      const modelTier = job.tier ?? undefined;

      const spec: SessionSpec = {
        workingDir: worktree.path,
        instructions,
        prompt,
        timeoutSeconds,
        silenceSeconds,
        ...(model === undefined ? {} : { model }),
        ...(modelTier === undefined ? {} : { modelTier }),
        ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
        ...(permissions === undefined ? {} : { permissions }),
      };

      const lines: string[] = [];
      let engineRef: string | null = null;
      let announceEnd: (outcome: Outcome) => void = () => undefined;
      const end = new Promise<Outcome>((resolve) => {
        announceEnd = resolve;
      });

      // The tracker watches for exactly what this session denied — the same list
      // the adapter handed the engine, resolved from the same policy (t125, FR6).
      // `permissions` and not `options.permissions`: since t161 the policy that
      // reached the engine may be the skill's, and a tracker watching for the
      // other one would report denials nobody was denied and miss the real ones.
      const tracker = new PermissionDenialTracker(resolvePermissions(permissions).deniedTools);

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
      //
      // The handle it resolves with is kept, and that is the whole point: from
      // here on there is a live process in `spec.workingDir`, and the only thing
      // that can stop it is this handle (t148, FR1).
      const handle = await route.adapter.startSession(spec, {
        onOutput(line) {
          lines.push(line);
          for (const denial of tracker.observe(line)) recordDenial(denial);
        },
        onEngineRef(ref) {
          engineRef = ref;
        },
        onFinished(status, exitCode, detail) {
          announceEnd({
            status,
            exitCode,
            timeoutReason: detail?.timeoutReason,
            usage: detail?.usage,
            models: detail?.models,
          });
        },
      });

      let session: Session;
      let outcome: Outcome;
      try {
        // Recorded as soon as the session is up, with whatever ref is known by
        // then. There is no endpoint to fill `engine_session_ref` in later (out
        // of scope), so `null` here means "the engine had not said it yet" and
        // never "this engine has no ref".
        session = await call<Session>('/v1/sessions', 'POST', {
          trabalho_id: job.id,
          no_id: job.no_atual,
          engine: route.adapter.engineName,
          engine_session_ref: engineRef,
          working_dir: spec.workingDir,
          prompt: spec.prompt,
          timeout_seconds: spec.timeoutSeconds,
          silence_seconds: spec.silenceSeconds,
        });

        sessionId = session.id;
        for (const denial of queued.splice(0)) recordDenial(denial);

        outcome = await end;
      } catch (error) {
        // Everything between the session coming up and its outcome being known
        // runs with a process alive on the other side, and the controller's
        // `finally` gives the lease back however this promise settles
        // (`controller.ts:122-136`). Rejecting from here without taking the
        // session down puts the work back in the pool with an engine still
        // writing in its working dir, for up to `timeoutSeconds` — and the next
        // tick would dispatch a second one into the same directory (t148, FR2).
        //
        // No explicit status: `cancel` defaults to `"cancelled"`
        // (`engine/types.ts:236-245`), which is what happened. The clock did not
        // run out and the engine did not crash; a control-plane call did.
        try {
          await route.adapter.cancel(handle);
        } catch {
          // Swallowed on purpose, and only here: the original failure is the one
          // that explains the dispatch, and a secondary error from the cleanup
          // would replace a cause with a symptom.
        }
        throw error;
      }

      // Past this line the session is terminal on its own account and `cancel` is
      // never called again (FR3): what is left is telemetry the runner owes, and
      // each write is attempted even when the one before it failed.

      // Drained BEFORE the end of the session, so the log reads in the order
      // things happened: the session opened, it was denied, it finished. A
      // failure here is remembered and surfaced at the very end — telemetry of an
      // incident may not cost the session its closure nor its question.
      await denialWrites;

      // Captured rather than thrown, exactly as `denialFailure` already is: a
      // closure the control plane refused may not cancel the question that comes
      // after it. "Asking is not failing" is not a rule about happy paths — a
      // question dropped here is a human who is never called, and the work stays
      // unblocked with nobody knowing what it needed.
      let finishFailure: unknown = null;
      try {
        await call(`/v1/sessions/${session.id}/finish`, 'PATCH', {
          status: TAXONOMY_STATUS[outcome.status],
          exit_code: outcome.exitCode,
          // Both watchdogs land on `tempo_esgotado`; this is what tells them
          // apart. `null` is "the adapter reported no cause" — for a cancel
          // somebody else drove, or for an adapter that predates the field —
          // and it may never be filled in with a guess.
          timeout_reason: outcome.timeoutReason ?? null,
          // What the session actually cost, as the engine counted it (t172).
          // Until this ficha these two lines were a hardcoded `uso: null` and no
          // `modelos` key at all, and every session this system ever ran
          // recorded zero cost data — with the placeholder reading exactly like
          // an honest absence, which is why it survived so long.
          //
          // `null` still means "the engine reported nothing", and it must never
          // collapse into zero: an engine with no accounting, a session that
          // died before its terminal frame and a session that genuinely spent
          // nothing are three different facts, and only the third is a number.
          // The key is SENT, present and null — same posture as
          // `timeout_reason` above, so that what the runner claims is legible in
          // the call itself and not only in the row it produces.
          uso: outcome.usage ?? null,
          modelos: outcome.models ?? null,
          // The raw stream, exactly as `onOutput` reported it — undecoded, frames
          // and dying screams alike (t159). `decodeSessionText` below is a READER
          // of this same buffer, and its frame-decoding is lossy by design: what
          // gets persisted is the material before that, because a session that
          // died is diagnosed from what it printed, not from what parsed.
          transcricao: lines.join('\n'),
        });
      } catch (error) {
        finishFailure = error;
      }

      // Decoded ONCE and read twice: the escalation block and the routing block
      // are two readings of the same text, and decoding it a second time would
      // let them disagree about what the session said.
      const output = route.decodeSessionText(lines);

      const request: InputRequest | null = parseInputRequest(output);
      if (request !== null && resolveEscalationPolicy(resolved) === 'never') {
        // The node declares it has nobody to ask, and the session asked anyway
        // (t167, FR6). The work stops either way — what it does not do is put a
        // question in a queue nobody is watching. There is exactly one owner for
        // the flag here too: this route blocks and nothing else does.
        await blockWithNobodyToAsk(
          job,
          `O nó \`${job.no_atual}\` não tem a quem perguntar, e a sessão travou em: ` +
            request.question,
        );
      } else if (request !== null) {
        // This POST is what blocks the work, inside the control plane and in the
        // same transaction as `pergunta.criada` (FR1). The runner never posts a
        // block of its own for an ordinary question — two owners for one flag is
        // how a work ends up blocked with nothing pending.
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

      // And here is where a traversal stops needing an operator (FR7-FR10).
      //
      // Three conditions, and each one is a different way of not having earned
      // an advance. No resolved node: there is no graph to say where "next"
      // even is. A session that did not complete: recording progress for work
      // that died would make the log claim something that did not happen. A
      // session that asked: it is blocked behind a person now, and the next
      // dispatch re-enters this same node with the answer already in the
      // prompt — moving it on would answer its question by walking away from
      // it (`docs/spec/escalacao-humana.md`).
      //
      // BEFORE the release and before the captured failures are rethrown, on
      // purpose: a denial or a closure the control plane refused is telemetry
      // the runner owes, and letting either of them strand a work that finished
      // cleanly would trade the recoverable problem for the unrecoverable one.
      if (resolved !== null && outcome.status === 'completed' && request === null) {
        await advance(job, resolved, session.id, output);
      }

      // The tree goes back before this callback settles, and the OUTCOME is what
      // decides its fate (FR8): what a completed session produced is already in
      // its branch's history, so the directory is scratch; anything else is the
      // only evidence there is of what went wrong, and it stays on disk until a
      // human — or a later ficha — decides otherwise.
      await release(outcome.status !== 'completed');

      // A write that could not be made is not the session's fault, but it is a
      // fault: the control plane refused something the runner owes it, and a
      // silent swallow here would leave the log claiming a clean session.
      //
      // The FIRST one captured is the one that surfaces — a denial happens during
      // the session, the closure after it, the cleanup last of all — which is the
      // precedent `denialFailure` already set when it was alone. Reporting more
      // than one at a time is a multi-error type nobody has needed yet.
      const failure = denialFailure ?? finishFailure ?? releaseFailure;
      if (failure !== null) throw failure;

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
    } catch (error) {
      // Every exit that is not the terminal one lands here — a read that
      // failed before the session opened, the control-plane failure that
      // cancels a live session, a throw from the telemetry the runner owes, and
      // since t161 a transition the control plane refused. The tree stays on
      // disk for all of them, including that last one: a work whose advance did
      // not record is a work standing on a node it already finished, and the
      // directory is the only place what it did still exists (FR8).
      await release(true);
      throw error;
    }
  };
}
