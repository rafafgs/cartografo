/**
 * Everything the dispatch owes the control plane once a session's outcome is
 * being processed (t202, FR4).
 *
 * Nine writes, and until the split every one of them was a closure inside
 * `createClaudeCodeDispatch`, reading `call` off the enclosing scope. Here each
 * one takes its client as an explicit parameter instead. That is not a style
 * preference — it is the whole reason this module can be tested at all: with no
 * closure over dispatch-local state there is nothing to boot, and a fake `call`
 * that records what it was handed pins a body that used to cost a control plane,
 * a fake engine and a database to read back. Eleven fichas shipped
 * `usage: null` hardcoded because nobody could ask that question cheaply (t172).
 *
 * The same rule is what keeps the dependency arrow pointing one way: this module
 * imports NOTHING from `dispatch.ts`. What it needs of a work is two fields, and
 * `blocks.ts` declares them ({@link JobRef}) rather than naming the
 * orchestrator's type — structural typing does the rest.
 *
 * **And the writes that STOP a work live next door since t265** (`blocks.ts`),
 * re-exported below so that no caller had to move with them. What is left here
 * is what a work that keeps going owes: the transition, the escalations, the
 * denials and the closure.
 *
 * **Who signs each write, and why it differs.** Everything the wiring does on
 * its own account is signed `sistema/runner`: the transition, every block and
 * the routing escalation are the runner reporting, never a model deciding. The
 * ordinary question is the one exception and it is signed `agente`, because that
 * one IS a model asking — two spellings for two different facts, in a log
 * somebody has to be able to group.
 *
 * **What propagates and what is captured.** {@link transition} — and everything
 * that leads to it — throws. The closure and the denials do not: they are
 * telemetry the runner owes after the fact, a work that keeps moving with a gap
 * in its log is recoverable, and a work that stopped without recording its
 * transition is not. That asymmetry is deliberate and predates this split; it is
 * preserved here signature by signature.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API, same boundary the UI has (D1, D11).
 *
 * English per D18; every route, field and status value is wire vocabulary and
 * stays in Portuguese.
 */

import type { SessionFinishDetail, SessionStatus } from '../engine/types.ts';
import { advanceMainLineForReport, type MainLineAdvancer } from './advance-main-line.ts';
import { blockWithNobodyToAsk, RUNNER_ACTOR_REF, type JobRef } from './blocks.ts';
import type { ControlPlaneCall } from './control-plane-client.ts';
import type { InputRequest } from './parse-input-request.ts';
import { parseNodeResult } from './parse-node-result.ts';
import type { PermissionDenial } from './parse-permission-denial.ts';
import {
  resolveEscalationPolicy,
  type EscalationPolicy,
  type GraphEdge,
  type ResolvedNode,
} from './resolve-node.ts';

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
  pending: 'stuck',
  running: 'stuck',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stuck',
  timed_out: 'timed_out',
});

/** `parse-permission-denial.ts`'s two resources, as the taxonomy spells them. */
const DENIAL_RESOURCE: Readonly<Record<'filesystem' | 'rede', string>> = Object.freeze({
  filesystem: 'filesystem',
  rede: 'network',
});

/**
 * The writes that stop a work, re-exported from the module that owns them now
 * (t265, t268, t273).
 *
 * Four of them were declared here until t265, and moved together when the fourth
 * one pushed this file past the 600-line budget; the fifth and the sixth were
 * born next door.
 * Re-exporting rather than asking each caller to follow the declaration is the
 * rule both earlier splits ran under: a refactor that renames nothing may not
 * make anybody edit an import.
 */
export {
  blockForEngineRefusal,
  blockForMainLineAdvanceFailure,
  blockForOutputSchemaRefusal,
  blockForPreSessionFailure,
  blockForUncommittedWork,
  blockWithNobodyToAsk,
  type JobRef,
} from './blocks.ts';

/** What the session reported when it ended. */
export interface Outcome {
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
  /**
   * What KIND of failure this was, when the status alone does not say (t265).
   *
   * Today one value: the engine refused to answer. Same reading as the two
   * fields above — absent is "the adapter reported no kind", it is recorded as
   * `null`, and it is never inferred from the exit code.
   */
  failureKind?: SessionFinishDetail['failureKind'];
  /** How the engine classified its own refusal, when it did (t265). */
  refusalCategory?: SessionFinishDetail['refusalCategory'];
}

/**
 * Moves the work along the edge the traversal chose (t161, FR10).
 *
 * The one write of this module that PROPAGATES on failure, and the asymmetry
 * with the denial and the closure is deliberate: those are telemetry the runner
 * owes after the fact, and a work that keeps moving with a gap in its log is
 * recoverable. A transition that was not recorded is a work that stopped,
 * standing on a node it already finished, with nobody able to tell that from a
 * work that is merely slow. That is the single failure mode t161 exists to
 * close, so it may not be swallowed into a report at the end.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param edge The edge to take.
 */
export async function transition(
  call: ControlPlaneCall,
  job: JobRef,
  edge: GraphEdge,
): Promise<void> {
  await call(`/v1/jobs/${job.id}/transitions`, 'POST', {
    to_node_id: edge.to,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}


/**
 * Asks a human which way the work goes (t161, FR9).
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
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param sessionId The session that just finished, for the question's trail.
 * @param edges The edges leaving the node, in document order.
 * @param observed What the session named as its result, or `null`.
 * @param policy The escalation policy the node runs under.
 */
export async function escalateRouting(
  call: ControlPlaneCall,
  job: JobRef,
  sessionId: number,
  edges: readonly GraphEdge[],
  observed: string | null,
  policy: EscalationPolicy,
): Promise<void> {
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
    `O nó \`${job.current_node_id}\` tem mais de uma saída e a sessão não escolheu ` +
    `nenhuma delas: o resultado observado foi ${seen}, e ele não casa com ` +
    'aresta nenhuma deste nó. Por qual aresta o trabalho segue?';

  if (policy === 'never') {
    await blockWithNobodyToAsk(call, job, `${question} Este nó não tem a quem perguntar.`);
    return;
  }

  await call('/v1/input-requests', 'POST', {
    job_id: job.id,
    session_id: sessionId,
    kind: 'question',
    question,
    context:
      `Arestas que saem de \`${job.current_node_id}\`: ${routes}. ` +
      'A sessão terminou sem falhar; o que falta é a decisão de rota.',
    options: labels,
    recommendation: null,
    default_answer: null,
    // Written as `true` since t102, and nothing reads it to answer on its own:
    // a routing escalation is resolved by a person, same as every other
    // pending question today.
    auto_approvable: true,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Advances the BENCH and then the work, or asks (t161, FR8/FR9; t273, FR1).
 *
 * Only ever called for a session that ended `completed` AND asked nothing:
 * advancing a work that escalated would answer its own question by walking
 * away from it, and advancing one whose session died would record progress
 * that never happened. That gate belongs to the orchestrator, which is the only
 * place that knows all four of its conditions.
 *
 * **The shared test bench moves first, and it moves HERE** (t273). A report
 * that named a `merge_commit` is an integration, and the nodes after it observe
 * a checkout that has to carry that commit before they open — `testar` and
 * `implantar` read it as `input.banco_de_testes.caminho`. Doing it inside this
 * function rather than beside its call site is what makes the order structural:
 * there is no way to move the work without having moved the bench first, and no
 * second caller can get that sequence wrong. The step itself, and every reason
 * it can refuse, is `advance-main-line.ts`.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param resolved Its node and the edges leaving it.
 * @param sessionId The session that just finished, for the question's trail.
 * @param output Everything the session printed, decoded.
 * @param advanceMainLine What moves the bench, when this runner has one.
 *   Absent is ordinary — a bets runner has no bench — and then this behaves
 *   exactly as it did before t273.
 * @returns `null` when the work moved, or had nowhere to move to; the block's
 *   own reason when the bench could not be advanced and the work was stopped on
 *   the node instead. The transition itself still THROWS on failure, which is
 *   the asymmetry this module has had since t161.
 */
export async function advance(
  call: ControlPlaneCall,
  job: JobRef,
  resolved: ResolvedNode,
  sessionId: number,
  output: string,
  advanceMainLine?: MainLineAdvancer,
): Promise<string | null> {
  // Before every branch below, the final node included: what triggers it is the
  // SHAPE of the report and not the topology, so a node that reports an
  // integration and happens to end the traversal advances the bench too.
  const stale = await advanceMainLineForReport(call, job, output, advanceMainLine);
  if (stale !== null) return stale;

  const { edges } = resolved;

  // Nothing to do: a node with no way out is a final node by the graph's own
  // `termina` rule, and there is nowhere to move the work to. What marks it
  // finished is `concluido`, derived by the control plane (t152) — and since
  // t262 that is not arrival: a final node with a skill needs its own report.
  if (edges.length === 0) return null;

  // Deterministic by construction: one way out is taken whatever the label
  // says. Every non-gate node of the reference graph labels it `sempre`, and
  // that string is not special-cased — a node with a single edge has no
  // decision to report, so asking it for one would invent a decision and then
  // escalate for the lack of an answer to it.
  if (edges.length === 1) {
    await transition(call, job, edges[0]);
    return null;
  }

  const observed = parseNodeResult(output)?.resultado ?? null;
  const chosen = edges.find((edge) => edge.condition === observed);
  if (chosen === undefined) {
    await escalateRouting(call, job, sessionId, edges, observed, resolveEscalationPolicy(resolved));
    return null;
  }

  await transition(call, job, chosen);
  return null;
}

/**
 * Reports every attempt at a tool the session's permission policy denied
 * (t125, FR6).
 *
 * A class and no longer four loose variables, for the one thing that makes this
 * write different from every other in this module: a denial can happen before
 * `POST /v1/sessions` has answered, and there is no id to post it against until
 * then. So it holds a queue, an id that starts absent, a serialization chain and
 * the first failure — state that has to survive between calls, which is exactly
 * what an object is for.
 *
 * **A denial is an incident, never a reason to fail the dispatch.** The rejection
 * is captured and read at the very end, next to the closure's and the release's;
 * escalating on repeated denials is a decision nobody has taken yet.
 */
export class PermissionDenialReporter {
  readonly #call: ControlPlaneCall;

  /**
   * Denials that happened before there was a session to post them against.
   *
   * Drained by {@link bindSession}, in the order they were observed: the log of
   * an incident is only worth reading if it happened in the order it says.
   */
  readonly #queued: PermissionDenial[] = [];

  /** The session, once `POST /v1/sessions` has answered. */
  #sessionId: number | null = null;

  /**
   * The writes, chained.
   *
   * Serialized and not raced, for the same reason the queue is ordered — and
   * with the catch attached the moment each link is made: a rejection with
   * nobody listening yet would take the whole process down as an unhandled
   * rejection, long before anyone could report it.
   */
  #writes: Promise<void> = Promise.resolve();

  /** The FIRST refusal, which is the one that surfaces. */
  #failure: unknown = null;

  constructor(call: ControlPlaneCall) {
    this.#call = call;
  }

  /**
   * What the control plane refused, if it refused anything.
   *
   * `null` while every write went through. Read by the orchestrator at the end
   * of the dispatch, where it takes precedence over the closure's failure and
   * the release's — a denial happens DURING the session, and the first one
   * captured is the one that explains it.
   */
  get failure(): unknown {
    return this.#failure;
  }

  /**
   * Records one denial, now or as soon as there is a session id.
   *
   * @param denial What the engine refused, already parsed.
   */
  record(denial: PermissionDenial): void {
    const id = this.#sessionId;
    if (id === null) {
      this.#queued.push(denial);
      return;
    }
    this.#writes = this.#writes
      .then(() =>
        this.#call(`/v1/sessions/${id}/permission-denials`, 'POST', {
          // The parsed denial's own vocabulary is the engine's (`rede`), and
          // the log's is the taxonomy's (`network`) since t227. One word maps
          // to the other HERE, at the call, exactly like `TAXONOMY_STATUS`
          // above: the parser answers what the CLI said, this module answers
          // what `session.permission_denied` declares.
          resource: DENIAL_RESOURCE[denial.recurso],
          tool: denial.ferramenta,
          reason: denial.motivo,
          actor: { type: 'system', ref: RUNNER_ACTOR_REF },
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#failure ??= error;
      });
  }

  /**
   * Names the session every denial is posted against, and flushes what waited.
   *
   * @param sessionId The session `POST /v1/sessions` just gave back.
   */
  bindSession(sessionId: number): void {
    this.#sessionId = sessionId;
    for (const denial of this.#queued.splice(0)) this.record(denial);
  }

  /**
   * Waits for every write recorded so far to settle.
   *
   * Awaited BEFORE the end of the session is reported, so the log reads in the
   * order things happened: the session opened, it was denied, it finished.
   * Never rejects — what went wrong is in {@link failure}.
   */
  async drain(): Promise<void> {
    await this.#writes;
  }
}

/**
 * What the runner reads back from `PATCH /finish` (t268).
 *
 * Two keys of a body that carries the whole session projection beside them, and
 * only these two are named: the closure is a write, and what it answers about
 * the SESSION the runner already knows. Both optional, because a control plane
 * older than this ficha answers neither — and an absent answer is not a refusal.
 */
interface FinishResponse {
  output_accepted?: boolean;
  output_schema_error?: string[];
}

/**
 * What closing a session tells the dispatch (t268).
 *
 * Two facts that fail independently, which is why they travel together and not
 * as one value: the WRITE can be refused (and then there is no verdict to read),
 * and the REPORT can be refused (and then the write went through perfectly). The
 * first is all this function answered until t268; the second is what the
 * orchestrator needs before it decides whether the work may move.
 */
export interface FinishVerdict {
  /** `null` when the write went through, and whatever it threw otherwise. */
  failure: unknown;
  /**
   * Whether the control plane took the reported `output`.
   *
   * Three-state on purpose: `true` accepted — including the vacuous case of a
   * session that reported nothing —, `false` refused by the pinned skill's own
   * `output` schema, and ABSENT for "there was no answer to read": the write
   * failed, or the control plane predates the field. Only `false` stops a work.
   */
  outputAccepted?: boolean;
  /** Every reason the schema gave, when it refused. */
  outputSchemaError?: string[];
}

/**
 * Records the end of the session, in the taxonomy's vocabulary (t98, t159, t172).
 *
 * The failure is GIVEN BACK rather than thrown, exactly as the denials' is: a
 * closure the control plane refused may not cancel the question that comes after
 * it. "Asking is not failing" is not a rule about happy paths — a question
 * dropped here is a human who is never called, and the work stays unblocked with
 * nobody knowing what it needed.
 *
 * @param call The dispatch's control-plane client.
 * @param sessionId The session that ended.
 * @param outcome What it reported when it ended.
 * @param transcript The raw stream, exactly as `onOutput` reported it —
 *   undecoded, frames and dying screams alike (t159). The decoder the routing
 *   and escalation parsers read is a READER of this same buffer, and its
 *   frame-decoding is lossy by design: what gets persisted is the material
 *   before that, because a session that died is diagnosed from what it printed,
 *   not from what parsed.
 * @param output What the session reported in its `` ```resultado `` block, as
 *   the object its node's `output_schema` declares (t259) — the value the next
 *   node's `input` is projected from. Absent when it printed no usable block,
 *   and then the KEY is omitted: a `null` there is what the control plane
 *   writes for a report the skill's schema REFUSED
 *   (`packages/core/src/repositories/session.ts`), which is a different fact.
 * @returns The closure's verdict: the write failure when there was one, and what
 *   the control plane answered about the report when there was a response.
 */
export async function finishSession(
  call: ControlPlaneCall,
  sessionId: number,
  outcome: Outcome,
  transcript: string,
  output?: Record<string, unknown>,
): Promise<FinishVerdict> {
  let answer: FinishResponse | undefined;
  try {
    answer = await call<FinishResponse>(`/v1/sessions/${sessionId}/finish`, 'PATCH', {
      status: TAXONOMY_STATUS[outcome.status],
      exit_code: outcome.exitCode,
      // Both watchdogs land on `timed_out`; this is what tells them
      // apart. `null` is "the adapter reported no cause" — for a cancel
      // somebody else drove, or for an adapter that predates the field —
      // and it may never be filled in with a guess.
      timeout_reason: outcome.timeoutReason ?? null,
      // ...and the same discipline for the other cause a status cannot carry
      // (t265): `failed` is one word for a crash and for an engine that refused
      // to answer, and only the second one reproduces on every retry. `null` is
      // "the adapter reported no kind", never "it was an ordinary crash" —
      // an adapter that does not read the frame and a frame that said nothing
      // are the same absence, and neither is a measurement.
      failure_kind: outcome.failureKind ?? null,
      refusal_category: outcome.refusalCategory ?? null,
      // What the session actually cost, as the engine counted it (t172).
      // Until that ficha these two lines were a hardcoded `usage: null` and no
      // `models` key at all, and every session this system ever ran
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
      usage: outcome.usage ?? null,
      models: outcome.models ?? null,
      transcript,
      ...(output === undefined ? {} : { output }),
    });
  } catch (error) {
    // No response to read, so no verdict either — and that absence is the whole
    // point of the two fields being optional: an unreachable control plane may
    // not be read as a refused report, which would stop a work over a hiccup.
    return { failure: error };
  }

  return {
    failure: null,
    // Guarded rather than trusted: a control plane older than t268 answers the
    // bare projection, and "nobody said" is not `false`. Only `false` stops a work.
    ...(typeof answer?.output_accepted === 'boolean'
      ? { outputAccepted: answer.output_accepted }
      : {}),
    ...(Array.isArray(answer?.output_schema_error)
      ? { outputSchemaError: answer.output_schema_error }
      : {}),
  };
}

/**
 * Posts the question the SESSION itself wrote (t106, FR1).
 *
 * This POST is what blocks the work, inside the control plane and in the same
 * transaction as `pergunta.criada`. The runner never posts a block of its own
 * for an ordinary question — two owners for one flag is how a work ends up
 * blocked with nothing pending.
 *
 * `actor.type` is `agent` here and `system` everywhere else in this module,
 * and that is the whole distinction: this one is a model asking for a decision.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param sessionId The session that asked.
 * @param request The escalation block, already parsed.
 */
export async function postSessionQuestion(
  call: ControlPlaneCall,
  job: JobRef,
  sessionId: number,
  request: InputRequest,
): Promise<void> {
  await call('/v1/input-requests', 'POST', {
    job_id: job.id,
    session_id: sessionId,
    kind: 'question',
    question: request.question,
    context: request.context ?? null,
    options: request.options ?? null,
    recommendation: request.recommendation ?? null,
    default_answer: request.default ?? null,
    // The field exists since t102; nothing reads it to answer on its own —
    // the auto-answer policy is still outside the PoC.
    auto_approvable: true,
    actor: { type: 'agent', ref: job.current_node_id === '' ? 'sessao' : job.current_node_id },
  });
}
