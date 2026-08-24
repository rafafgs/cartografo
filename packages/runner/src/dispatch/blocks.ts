/**
 * The six writes that STOP a work, on the runner's own account (t265, t268,
 * t273).
 *
 * They were four closures in `dispatch.ts` until t202, then four exports of
 * `report.ts` until this ficha, which added the fourth and pushed that module
 * past the 600-line budget `test/dispatch/file-size-budget.test.ts` enforces.
 * The cut is where the module was already largest and most cohesive: every one
 * of these is the same `POST /v1/jobs/:id/blocks`, signed the same way, and what
 * differs between them is only WHICH fact stopped the work — which is exactly
 * why they are five functions and not one helper taking a string. No export was
 * renamed and no behaviour changed; `report.ts` re-exports all of them, so no
 * caller edits an import (the rule both earlier splits ran under).
 *
 * The fifth arrived with t268, and it is the first one whose fact comes from a
 * READ: the other four are decided here, out of what the runner already has in
 * hand, while a report refused by the pinned skill's `output` schema is the
 * control plane's judgement, answered on the very closure that reported it.
 *
 * The sixth arrived with t273, and its fact comes from neither: it is about a
 * directory on this machine — the shared test bench the next nodes observe —
 * that could not be advanced onto the commit an accepted report named.
 *
 * `POST /v1/jobs/:id/blocks` is an unconditional, reason-carrying block that has
 * existed since t102, and every write here uses it unchanged. What the dispatch
 * chooses is not a new mechanism, it is which of the existing ones applies.
 *
 * **One owner per flag.** None of these ever fires for a work that is already
 * stopped by something else: an ordinary escalation is ALREADY a block, posted
 * by the control plane in the same transaction as `pergunta.criada`, and a
 * second one on top of it is how a work ends up blocked with nothing pending.
 * The condition is the orchestrator's to enforce, because it is the only place
 * that knows what else happened in the same dispatch.
 *
 * Nothing here touches the database: the runner is an ordinary client of the
 * public API, same boundary the UI has (D1, D11).
 *
 * English per D18; every route, field and status value is wire vocabulary and
 * stays in Portuguese.
 */

import type { ControlPlaneCall } from './control-plane-client.ts';

/**
 * `actor.ref` of every write the runner makes on its own account.
 *
 * `system` and not `agent`: the fact being recorded is not something the
 * session decided, it is the wiring reporting what happened. Same `ref` the
 * control plane uses by default for a write coming from the runner, on purpose
 * — two spellings for one actor is how a log stops being groupable.
 *
 * Declared here and read by `report.ts` as well: the blocks are the writes it
 * has always described, and one constant for one actor is the whole point.
 */
export const RUNNER_ACTOR_REF = 'runner';

/**
 * The part of a work a report names.
 *
 * Two fields, and declared here rather than imported from `dispatch.ts` (FR4 of
 * t202): this side owes the orchestrator nothing, which is exactly what lets it
 * be unit-tested against a fake client. The dispatch's own `Job` satisfies this
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
 * function of its own all the same: a node with nobody to ask and output that
 * exists in exactly one directory are different facts, and a single helper
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
 * of its own for the reason they are two. The reason itself is composed
 * elsewhere (`pre-session-failure.ts`): classifying is not writing.
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
 * Stops the work because the engine refused to answer (t265, FR6).
 *
 * The fourth block this module makes on the runner's own account, and the one
 * whose justification is the strongest: a refusal is DETERMINISTIC. t198 put a
 * real thesis through `triagem` and got four refused sessions in a row on the
 * same prompt — `stop_reason: "refusal"`, exit 1, zero output tokens, ~23k cache
 * tokens burned each time — before a fifth one worked. What stopped it was the
 * operator watching the log, because nothing in the system counted anything.
 *
 * So it blocks on the FIRST occurrence, instead of riding the consecutive-
 * failure cap the control plane applies to ordinary failures: waiting for three
 * of these buys the same answer three times. That split is also why the two
 * halves live on different sides of the API — this one is decidable here, with
 * no read at all, the moment `onFinished` lands; the cap needs the session
 * history, and only the control plane has it (D1).
 *
 * The reason is composed here, whole, exactly as {@link blockForUncommittedWork}
 * composes its own: a helper taking a ready-made string would make "the engine
 * refused" indistinguishable from "the tree was dirty" at the call site.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param refusalCategory How the engine classified the refusal, when it did.
 *   Absent is ordinary: the refusal itself is the fact, and the category is what
 *   the engine adds to it when it has something to add.
 * @returns The reason that was posted, so the caller can hand it back to the
 *   controller as the block's own — the runner may not tell the API one story
 *   and its caller another.
 */
export async function blockForEngineRefusal(
  call: ControlPlaneCall,
  job: JobRef,
  refusalCategory?: string,
): Promise<string> {
  // Built with concatenation and not with a nested template literal, for the
  // reason `escalateRouting` below already records: the D18 sweep's masking
  // scanner reads one backtick at a time.
  const classified =
    refusalCategory === undefined || refusalCategory === ''
      ? 'O engine não classificou a recusa.'
      : 'O engine classificou a recusa como `' + refusalCategory + '`.';

  const reason =
    `A sessão do nó \`${job.current_node_id}\` não chegou a responder: o engine ` +
    `RECUSOU o pedido antes de trabalhar. ${classified} ` +
    'Recusa é determinística — o mesmo prompt é recusado de novo a cada tentativa ' +
    '—, então o trabalho para aqui em vez de gastar mais sessões: reveja as ' +
    'instruções do nó e a skill que ele fixa antes de desbloquear.';

  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });

  return reason;
}

/**
 * Stops the work because the control plane REFUSED the session's report
 * (t268, FR5).
 *
 * The fifth block of this module, and the one that closes gap 2 of
 * `notas/2026-08-17-second-bets-run.md`. `PATCH /finish` has held a
 * reported `output` against the `output` schema of the skill the node pins since
 * t253 — storing `null` and the reasons when it refuses, because losing the END
 * of a session over a malformed self-report would be strictly worse than losing
 * the report. What nobody did with that verdict was read it: the dispatch
 * re-parsed the session's raw text on its own account and routed the work from
 * the label it found there, so a report the control plane had just rejected
 * still moved it along an edge — and the next node got an `input` projection
 * with nothing in it.
 *
 * It blocks on the FIRST refusal, the same posture {@link blockForEngineRefusal}
 * established and for a related reason: what was refused is the SHAPE of the
 * report, and a second session told exactly what the first one was told is being
 * asked for the same shape again. Retrying with the problems appended to the
 * prompt is a real alternative and a different ficha's — it needs a retry count
 * carried across dispatches and a second decision about how many attempts are
 * enough, for a failure mode with no evidence yet that a second try behaves
 * differently.
 *
 * The reason quotes EVERY problem and not only the first, exactly as
 * `output_schema_error` itself carries all of them: whoever unblocks this work
 * has to fix the report, and a list cut short is a second round of the same
 * conversation.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param sessionId The session whose report was refused — what a reader opens
 *   next, since the reasons live in ITS `session.finished` event.
 * @param problems Every reason the schema gave, verbatim.
 * @returns The reason that was posted, so the caller can hand it back as the
 *   block's own — the runner may not tell the API one story and its caller
 *   another.
 */
export async function blockForOutputSchemaRefusal(
  call: ControlPlaneCall,
  job: JobRef,
  sessionId: number,
  problems: readonly string[],
): Promise<string> {
  // Built with concatenation and not with a nested template literal, for the
  // reason `blockForEngineRefusal` above already records: the D18 sweep's
  // masking scanner reads one backtick at a time.
  const listed =
    problems.length === 0
      ? 'O control plane não detalhou o motivo.'
      : 'Problemas: ' + problems.map((problem) => '`' + problem + '`').join('; ') + '.';

  const reason =
    `A sessão ${String(sessionId)} do nó \`${job.current_node_id}\` terminou, mas o ` +
    'control plane RECUSOU o relato dela: ele não casa com o schema `output` da ' +
    'skill que o nó fixa, então nada foi gravado e o nó seguinte não teria o que ' +
    `ler. ${listed} ` +
    'O trabalho para aqui em vez de seguir por uma aresta escolhida a partir de um ' +
    'relato que não existe: reveja o contrato do nó e a skill que ele fixa antes de ' +
    'desbloquear.';

  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });

  return reason;
}

/**
 * Stops the work because the shared test bench could not be advanced (t273,
 * FR5).
 *
 * The sixth block of this module, and the first one about a checkout NOBODY
 * opened a session in. What it answers is the promise `integrar-branch` has
 * always made — the executor advances the main line, not the session — and what
 * it stops is the failure mode that promise hides when it is not kept: `testar`
 * and `implantar` observe the bench, so a bench that stayed where it was makes
 * the next two nodes measure the commit BEFORE this one and report on it as if
 * it were the work (`notas/2026-08-17-t109-game-feature.md`, gap 3).
 *
 * A block and not a throw, for the reason t252 wrote down: a git that refuses
 * here refuses identically on every retry — the branch is still wrong, the
 * history is still diverged — so a throw would buy the same answer every couple
 * of seconds forever with nothing in anybody's inbox.
 *
 * **This one is written in English**, unlike the four reasons above it. Those
 * predate the 2026-08-18 language rule and stay as they are, in Portuguese;
 * nothing new is born in Portuguese, this text included.
 *
 * @param call The dispatch's control-plane client.
 * @param job The work being dispatched.
 * @param detail What went wrong, as the step that tried it reported — the
 *   command as it was issued and what it printed. It is the whole of what a
 *   person acts on, so it is quoted and never summarized away.
 * @returns The reason that was posted, so the caller can hand it back to the
 *   controller as the block's own — the runner may not tell the API one story
 *   and its caller another.
 */
export async function blockForMainLineAdvanceFailure(
  call: ControlPlaneCall,
  job: JobRef,
  detail: string,
): Promise<string> {
  const reason =
    `The session of node \`${job.current_node_id}\` reported an integration, but the shared ` +
    `test bench could NOT be advanced onto the commit it named: ${detail}. ` +
    'The work stays on this node instead of moving on, because the nodes after it observe ' +
    'that bench: a gate that ran against a stale or half-prepared checkout would be measuring ' +
    'the commit before this one and reporting on it as the work. Put the bench back on the ' +
    'main line, reconcile whatever diverged in it, or fix what the install command needs — ' +
    'and unblock.';

  await call(`/v1/jobs/${job.id}/blocks`, 'POST', {
    reason,
    actor: { type: 'system', ref: RUNNER_ACTOR_REF },
  });

  return reason;
}
