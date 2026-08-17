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
 * it declares them ({@link JobRef}) rather than naming the orchestrator's type —
 * structural typing does the rest.
 *
 * **Who signs each write, and why it differs.** Everything the wiring does on
 * its own account is signed `sistema/runner`: the transition, both blocks and
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

/**
 * `actor.ref` of every write this module makes on the runner's own account.
 *
 * `system` and not `agent`: the fact being recorded is not something the
 * session decided, it is the wiring reporting what happened. Same `ref` the
 * control plane uses by default for a write coming from the runner, on purpose
 * — two spellings for one actor is how a log stops being groupable.
 */
const RUNNER_ACTOR_REF = 'runner';

/** `parse-permission-denial.ts`'s two resources, as the taxonomy spells them. */
const DENIAL_RESOURCE: Readonly<Record<'filesystem' | 'rede', string>> = Object.freeze({
  filesystem: 'filesystem',
  rede: 'network',
});

/**
 * The part of a work a report names.
 *
 * Two fields, and declared here rather than imported from `dispatch.ts` (FR4):
 * this module owes the orchestrator nothing, which is exactly what lets it be
 * unit-tested against a fake client. The dispatch's own `Job` satisfies this
 * shape without either module naming the other.
 */
export interface JobRef {
  /** The id every route below is addressed by. */
  id: number;
  /**
   * The node whose session produced what is being reported.
   *
   * Named after the JOB PROJECTION this module is handed, which went English
   * with the API in t226 — not after anything this file writes. Every payload
   * built below is still Portuguese, and deliberately so: this is the client of
   * the EVENT surface, which is D20's second child.
   */
  current_node_id: string;
}

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
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param reason Why it stopped — it quotes the node and what walled the
 *   session, because `trabalho.motivo_bloqueio` is what whoever opens the work
 *   reads first.
 */
export async function blockWithNobodyToAsk(
  call: ControlPlaneCall,
  job: JobRef,
  reason: string,
): Promise<void> {
  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Stops the work because a session that finished left work it never committed
 * (t207-B).
 *
 * The same route and the same actor as {@link blockWithNobodyToAsk}, and a
 * function of its own all the same: the two reasons a dispatch stops a work on
 * its own account are different facts — one is a node with nobody to ask, the
 * other is output that exists in exactly one directory — and a single helper
 * taking a string would make them indistinguishable at every call site.
 *
 * No new field on `/finish` and no new schema: `POST /v1/jobs/:id/blocks` has
 * existed since t102 and takes a free `reason` (`motivo` until t227), and the
 * finish route's vocabulary was the t213/D20 migration's to touch.
 *
 * The reason names the tree, because that path is the whole point — whoever
 * opens the work reads `trabalho.motivo_bloqueio` first, and what they have to
 * do next is go and look at that directory.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param worktreePath The tree that was retained, absolute.
 */
export async function blockForUncommittedWork(
  call: ControlPlaneCall,
  job: JobRef,
  worktreePath: string,
): Promise<void> {
  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason:
      `A sessão do nó \`${job.current_node_id}\` terminou como concluída, mas deixou ` +
      `trabalho não commitado em \`${worktreePath}\` — o \`git status\` da árvore ` +
      'não estava limpo. A árvore foi RETIDA em vez de removida, e o trabalho ' +
      'não avançou: o que essa sessão produziu só existe nesse diretório. ' +
      'Commite o que valer a pena, descarte o resto e desbloqueie.',
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });
}

/**
 * Stops the work because the dispatch could not even get to a session (t252, FR3).
 *
 * The third reason a dispatch stops a work on its own account, and the one that
 * happens EARLIEST: before a worktree, before a session, before a token is
 * spent. What it is for is a failure that will reproduce identically on every
 * retry — a placeholder that does not resolve, a skill nobody registered, a pin
 * that stopped matching, an engine with no route, a `graph_version_id` the
 * control plane no longer has. Until this ficha each of those was thrown, logged
 * by `cli/run.ts` and retried two seconds later, forever, with nothing in
 * anybody's inbox and no other job of the project ever reached.
 *
 * Same route, same actor and same shape as the two blocks above, and a function
 * of its own for the same reason they are two: a single helper taking a string
 * would make three different facts indistinguishable at the call site. The
 * reason itself is composed elsewhere (`pre-session-failure.ts`) — WHICH failure
 * this was is a classification, and posting it is a write.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param reason Why it stopped, naming the cause concretely: it is what whoever
 *   opens the work reads first, and what tells them which of the five it was.
 */
export async function blockForPreSessionFailure(
  call: ControlPlaneCall,
  job: JobRef,
  reason: string,
): Promise<void> {
  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason,
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
 * Advances the work to the next node, or asks (t161, FR8/FR9).
 *
 * Only ever called for a session that ended `completed` AND asked nothing:
 * advancing a work that escalated would answer its own question by walking
 * away from it, and advancing one whose session died would record progress
 * that never happened. That gate belongs to the orchestrator, which is the only
 * place that knows all four of its conditions.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param resolved Its node and the edges leaving it.
 * @param sessionId The session that just finished, for the question's trail.
 * @param output Everything the session printed, decoded.
 */
export async function advance(
  call: ControlPlaneCall,
  job: JobRef,
  resolved: ResolvedNode,
  sessionId: number,
  output: string,
): Promise<void> {
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
    await transition(call, job, edges[0]);
    return;
  }

  const observed = parseNodeResult(output)?.resultado ?? null;
  const chosen = edges.find((edge) => edge.condition === observed);
  if (chosen === undefined) {
    await escalateRouting(call, job, sessionId, edges, observed, resolveEscalationPolicy(resolved));
    return;
  }

  await transition(call, job, chosen);
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
 * @returns `null` when the write went through, and whatever it threw otherwise.
 */
export async function finishSession(
  call: ControlPlaneCall,
  sessionId: number,
  outcome: Outcome,
  transcript: string,
): Promise<unknown> {
  try {
    await call(`/v1/sessions/${sessionId}/finish`, 'PATCH', {
      status: TAXONOMY_STATUS[outcome.status],
      exit_code: outcome.exitCode,
      // Both watchdogs land on `timed_out`; this is what tells them
      // apart. `null` is "the adapter reported no cause" — for a cancel
      // somebody else drove, or for an adapter that predates the field —
      // and it may never be filled in with a guess.
      timeout_reason: outcome.timeoutReason ?? null,
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
    });
  } catch (error) {
    return error;
  }
  return null;
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
