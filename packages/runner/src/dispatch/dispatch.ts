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
 * 2. builds the prompt — the node's instruction plus every question already
 *    asked AND answered for this work. That block is what keeps a re-dispatch
 *    from asking the same thing forever: engine-native resume is out of scope
 *    for the v0 adapter (`docs/formatos/engine-adapter.md`), so "resuming" is
 *    always a fresh session that was told what happened;
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
 * completed. There is no static working directory to fall back to, which is the
 * point: with one, every session of every job wrote in the operator's own tree.
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
 * **And a placeholder never reaches a model as text** (t204, t259). A manifest
 * body may name this node's input — `{{input.<caminho>}}` — and those are
 * resolved before the session is built, against what
 * `GET /v1/jobs/:id/context` projects: the job, the class config, and every
 * node before this one, in the bucket each declared. A path that projection does
 * not carry fails the dispatch closed instead of opening a session on a
 * half-written prompt.
 *
 * **And a REFUSAL after the session is one too** (t265). An engine that refused
 * the request reproduces its refusal on every retry — measured, four in a row on
 * one prompt — so it stops the work on the first occurrence instead of throwing
 * into a loop that buys the same answer again. Every other failed session still
 * throws, and the CAP on those lives in the control plane, which is the only
 * side that can count across leases.
 *
 * **And so is a report the CONTROL PLANE refused** (t268). The closure answers
 * whether what the session reported survived the `output` schema of the skill
 * its node pins; when it did not, nothing was stored, and this file stops the
 * work on the node instead of routing from a result that exists nowhere. Until
 * that ficha the verdict was thrown away and the advance was decided from this
 * side's own parse of the same block — two readings of one report, never
 * compared.
 *
 * **And a failure BEFORE the session is a block, not a throw** (t252). Five of
 * the ways the window below can fail reproduce identically on every retry — a
 * dangling `graph_version_id`, an engine with no route, an unregistered skill,
 * a pin that stopped matching, a placeholder that does not resolve. Thrown, each
 * of them was a job retried every two seconds forever, invisibly, with the rest
 * of the project's queue stuck behind it. So they stop the work with a reason a
 * person can read and resolve `{blocked: true}`; everything else still throws,
 * because a 5xx heals itself and the retry is the right answer for it.
 *
 * **And since t202 this file is the ORCHESTRATOR and nothing else.** It had
 * grown to 1,333 lines owning five jobs at once, and every ficha that touched
 * dispatch touched it. What is left here is the worktree bracketing, the
 * session's own lifecycle and the SEQUENCE — the order the writes happen in and
 * the precedence of what failed, which is the part with the load-bearing
 * guarantees (t148, t207-B). Everything that was only ever a passenger is
 * imported back: the prompt, the HTTP client, every write the runner owes once
 * an outcome is known (`report.ts`), and — since t223, which brought the file
 * under the 600-line budget FR9 declared and nobody enforced — the routing
 * decisions (`resolve-engine.ts`) and the configuration surface (`options.ts`).
 * No export was renamed and no behaviour changed in either split, and the
 * re-exports below are what makes that true for every caller.
 *
 * English per D18. The prompt and instruction CONTENT stays in Portuguese: it
 * is — since t161 — the registered skill manifest itself, and those are written
 * in Portuguese (`especificacoes/formatos/exemplos/`); what is left of the old
 * fixed literal is `DEFAULT_INSTRUCTIONS`, in `options.ts`.
 */

import { resolvePermissions } from '../engine/permission-policy.ts';
import { resolveBudget } from '../engine/resolve-budget.ts';
import { createDispatchControlPlaneClient } from './control-plane-client.ts';
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_SILENCE_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  type ClaudeCodeDispatchOptions,
  type Job,
} from './options.ts';
import { DispatchError, type DispatchOutcome } from './outcome.ts';
import { parseInputRequest, type InputRequest } from './parse-input-request.ts';
import { parseNodeResult } from './parse-node-result.ts';
import { PermissionDenialTracker } from './parse-permission-denial.ts';
import { classifyPreSessionFailure } from './pre-session-failure.ts';
import {
  PermissionDenialReporter,
  advance,
  blockForEngineRefusal,
  blockForOutputSchemaRefusal,
  blockForPreSessionFailure,
  blockForUncommittedWork,
  blockWithNobodyToAsk,
  finishSession,
  postSessionQuestion,
  type Outcome,
} from './report.ts';
import {
  renderSkillInstructions,
  type RegisteredSkill,
  type RenderedSkill,
} from './render-skill-instructions.ts';
import { UnknownEngineError, resolveEngine, type EngineRoute } from './resolve-engine.ts';
import { createNodeInputResolver } from './resolve-input.ts';
import {
  resolveEscalationPolicy,
  resolveNode,
  type GraphVersionBody,
  type ResolvedNode,
} from './resolve-node.ts';
import { buildSessionSpec } from './session-spec.ts';
import { decodeClaudeCodeSessionText } from './session-text.ts';

/**
 * The surface this module has always had, whole, from the file that lists it
 * since t268 (`surface.ts`).
 *
 * A re-export of a list of re-exports, and the reasoning is that module's own:
 * every name is still imported from HERE by `cli/run.ts`, by the spikes and by
 * this package's tests, and a refactor that renames nothing may not make
 * anybody edit an import.
 */
export * from './surface.ts';

/** A session, as `POST /v1/sessions` gives it back. */
interface Session {
  id: number;
}

/**
 * Everything the session said, with Claude Code's frames decoded back into text.
 *
 * @deprecated Moved to `./session-text.ts` as `decodeClaudeCodeSessionText`
 * (t141, FR6) — one decoder per engine. Re-exported unchanged all the same.
 */
export const sessionText = decodeClaudeCodeSessionText;

/**
 * Builds the controller's `dispatch` callback (t103), with a real engine behind
 * it.
 *
 * @param options Control plane, engine, working directory and session limits.
 * @returns The exact signature `ControllerOptions.dispatch` expects.
 */
export function createClaudeCodeDispatch(
  options: ClaudeCodeDispatchOptions,
): (jobId: number) => Promise<DispatchOutcome> {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const silenceSeconds = resolveBudget(options.silenceSeconds, DEFAULT_SILENCE_SECONDS);
  // ONE client, built once and handed to everything that writes (t202, FR3).
  // The seven routes below and the nine in `report.ts` are the same client on
  // purpose: a route that assembled its own headers is a route that could
  // forget the credential.
  const call = createDispatchControlPlaneClient(options);

  const resolveInput = options.resolveInput ?? createNodeInputResolver(call);

  return async (jobId: number): Promise<DispatchOutcome> => {
    const job = await call<Job>(`/v1/jobs/${jobId}`, 'GET');

    let resolved: ResolvedNode | null;
    let route: EngineRoute;
    let rendered: RenderedSkill | null;

    // The whole window before a worktree exists, under ONE catch (t252). Which
    // of its failures blocks the work instead of throwing — and why exactly
    // five — is the paragraph at the top of this file; where the line is drawn
    // is `pre-session-failure.ts`, and nothing but that module draws it.
    try {
      // ONE read of the graph version, and it is the first thing the dispatch
      // does: the engine, the skill, the contract and the edges all come out of
      // this (FR1). A version the work points at and that does not resolve
      // stops right here, which is where stopping is cheapest.
      resolved = await resolveNode(job, (versionRoute) =>
        call<GraphVersionBody>(versionRoute, 'GET'),
      );

      // Resolved before anything is read for the prompt and long before a
      // session opens: an engine nobody registered has to stop the dispatch
      // while stopping it is still free (t141, FR5).
      const engineName = resolveEngine(resolved);
      const registered = options.engines[engineName];
      if (registered === undefined) {
        throw new UnknownEngineError(engineName, job.current_node_id, Object.keys(options.engines));
      }
      route = registered;

      // Then the skill, in the same window and for the same reason: an
      // unregistered skill, a pin that stopped matching, or — since t204 — a
      // body whose placeholders this dispatch cannot resolve stops it before a
      // worktree is cut, before a session exists and before a single token is
      // spent (FR3). A refusal after the engine is running is a refusal that
      // already let the instructions out.
      rendered =
        resolved === null
          ? null
          : await renderSkillInstructions(
              resolved,
              (skillRoute) => call<RegisteredSkill>(skillRoute, 'GET'),
              await resolveInput(job, resolved),
            );
    } catch (error) {
      // `null` is "this one may well work next time": it goes up untouched, the
      // controller's tick rejects, and the loop retries. A reason is the other
      // half, and the block is what makes the work stop being a candidate at
      // all — no new bookkeeping, just the filter `GET /v1/jobs` already has.
      const reason = classifyPreSessionFailure(error, job);
      if (reason === null) throw error;
      await blockForPreSessionFailure(call, job, reason);
      return { blocked: true, reason };
    }

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
     * What the manager ANSWERED, when it answered at all (t207-B).
     *
     * `null` while no release has completed — including a release that threw.
     * That distinction is the point: a `true` here is the manager saying "I
     * looked and I kept it", which is what the work gets blocked on below, and a
     * release that blew up is a fault with an owner already (`releaseFailure`).
     * Collapsing the two would block a work over a broken `git`.
     */
    let keptByManager: boolean | null = null;

    /**
     * Gives the worktree back, exactly once, on whatever path leaves here.
     *
     * Idempotent because the paths overlap on purpose: the terminal path
     * releases with the fate the outcome earned, and the catch below releases
     * whatever it finds still held — including what the terminal path already
     * handed over on its way to throwing. The failure is captured and never
     * thrown from here, exactly as `denialFailure` and `finishFailure` are: a
     * cleanup that could not be done is a fault worth reporting, never a reason
     * to replace the error already unwinding with a symptom of it.
     */
    const release = async (keep: boolean): Promise<void> => {
      if (released) return;
      released = true;
      try {
        keptByManager = (await options.worktrees.release(worktree, { keep })).kept;
      } catch (error) {
        releaseFailure = error;
      }
    };

    try {
      // The two reads the prompt needs, and the spec they get packed into
      // (`session-spec.ts`). Inside the `try` and after the worktree, where they
      // have always been: a read that fails here retains the tree and opens no
      // session, which is the cheapest failure this dispatch still has left.
      const spec = await buildSessionSpec(call, job, resolved, {
        workingDir: worktree.path,
        instructions,
        timeoutSeconds,
        silenceSeconds,
        ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
        ...(permissions === undefined ? {} : { permissions }),
      });

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
      // no id to post it against until then. It waits inside the reporter, and
      // the queue is drained as soon as the id exists (`report.ts`).
      const denials = new PermissionDenialReporter(call);

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
          for (const denial of tracker.observe(line)) denials.record(denial);
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
            failureKind: detail?.failureKind,
            refusalCategory: detail?.refusalCategory,
          });
        },
      });

      // Announced the moment there is something to announce, and taken back
      // once there is not (t193, FR9). The two calls bracket the whole window in
      // which a process is alive on the other side — which is the only window in
      // which cancelling means anything.
      let ended = false;
      const announceSessionEnd = (): void => {
        if (ended) return;
        ended = true;
        options.onSessionEnded?.();
      };
      options.onSessionStarted?.(async () => {
        await route.adapter.cancel(handle);
      });

      let session: Session;
      let outcome: Outcome;
      try {
        // Recorded as soon as the session is up, with whatever ref is known by
        // then. There is no endpoint to fill `engine_session_ref` in later (out
        // of scope), so `null` here means "the engine had not said it yet" and
        // never "this engine has no ref".
        session = await call<Session>('/v1/sessions', 'POST', {
          job_id: job.id,
          node_id: job.current_node_id,
          engine: route.adapter.engineName,
          engine_session_ref: engineRef,
          working_dir: spec.workingDir,
          prompt: spec.prompt,
          timeout_seconds: spec.timeoutSeconds,
          silence_seconds: spec.silenceSeconds,
        });

        denials.bindSession(session.id);

        outcome = await end;
        announceSessionEnd();
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
        // After the cancel and not before it: what the hook says is "there is no
        // live session to take down anymore", and until that line there still
        // was one.
        announceSessionEnd();
        throw error;
      }

      // Past this line the session is terminal on its own account and `cancel` is
      // never called again (FR3): what is left is telemetry the runner owes, and
      // each write is attempted even when the one before it failed.

      // The tree goes back HERE, the moment the outcome is known and before a
      // single decision is taken on top of it (t207-B). It used to happen at the
      // very end, after the advance, and the order was not neutral: what the
      // manager answers — did the directory survive? — is an input to that
      // advance, and a decision taken before the answer exists cannot use it.
      //
      // The OUTCOME is still what decides the fate asked for (FR8): what a
      // completed session produced belongs in its branch's history, so the
      // directory is scratch; anything else is the only evidence there is of
      // what went wrong, and it stays on disk until a human — or
      // `cartografo-runner prune` — decides otherwise.
      await release(outcome.status !== 'completed');

      // A session that ended `completed` and whose tree was kept ANYWAY: the
      // manager looked at `git status --porcelain` and found work nobody
      // committed (`session-worktree.ts`). The premise the old cleanup ran on —
      // "committed work already lives in the branch's history" — is false here,
      // and everything that session produced exists in exactly one directory.
      // It is not the machine's to reconcile: no commit and no discard is made
      // on anybody's behalf, whether the dirt is a forgotten `git commit` or
      // scratch the node legitimately produces.
      const dirtyDespiteCompleted = outcome.status === 'completed' && keptByManager === true;

      // Drained BEFORE the end of the session, so the log reads in the order
      // things happened: the session opened, it was denied, it finished. A
      // failure here is remembered and surfaced at the very end — telemetry of an
      // incident may not cost the session its closure nor its question.
      await denials.drain();

      // Decoded ONCE and read three times: the escalation block, the routing
      // block and — since t259 — the report that rides on the closure. Decoding
      // it again would let the three disagree about what the session said, and
      // it happens BEFORE the closure now because the closure is one of them.
      const output = route.decodeSessionText(lines);

      // Captured rather than thrown, exactly as the denials' failure already is:
      // a closure the control plane refused may not cancel the question that
      // comes after it. "Asking is not failing" is not a rule about happy paths
      // — a question dropped here is a human who is never called, and the work
      // stays unblocked with nobody knowing what it needed. So `report.ts` hands
      // the failure back rather than throwing it, and it surfaces below.
      const verdict = await finishSession(
        call,
        session.id,
        outcome,
        // The raw stream as `onOutput` reported it, undecoded (t159), and then
        // what the session reported INSIDE it (t259) — absent when it printed
        // no usable block. Both arguments are argued in `report.ts`.
        lines.join('\n'),
        parseNodeResult(output) ?? undefined,
      );

      const request: InputRequest | null = parseInputRequest(output);
      if (request !== null && resolveEscalationPolicy(resolved) === 'never') {
        // The node declares it has nobody to ask, and the session asked anyway
        // (t167, FR6). The work stops either way — what it does not do is put a
        // question in a queue nobody is watching. There is exactly one owner for
        // the flag here too: this route blocks and nothing else does.
        await blockWithNobodyToAsk(
          call,
          job,
          `O nó \`${job.current_node_id}\` não tem a quem perguntar, e a sessão travou em: ` +
            request.question,
        );
      } else if (request !== null) {
        // That POST is what blocks the work, inside the control plane and in the
        // same transaction as `pergunta.criada` (FR1). The runner never posts a
        // block of its own for an ordinary question — two owners for one flag is
        // how a work ends up blocked with nothing pending.
        await postSessionQuestion(call, job, session.id, request);
      }

      // The other two reasons a dispatch stops a work on its own account
      // (t207-B, t268), and neither fires when something has stopped it
      // already: an ordinary escalation is ALREADY a block, posted by the
      // control plane in the same transaction as `pergunta.criada`, and a
      // second one on top of it would be two owners for one flag — which is how
      // a work ends up blocked with nothing pending. And exclusive between
      // themselves, refusal first: a report the control plane refused is the more
      // fundamental fact — there is no result to have committed anything about —
      // and the same rule that forbids a second owner forbids posting both.
      // `blocks.ts` argues each write, next to the write itself.
      const refusedReport = outcome.status === 'completed' && verdict.outputAccepted === false;
      if (request === null && refusedReport) {
        await blockForOutputSchemaRefusal(call, job, session.id, verdict.outputSchemaError ?? []);
      } else if (request === null && dirtyDespiteCompleted) {
        await blockForUncommittedWork(call, job, worktree.path);
      }

      // And here is where a traversal stops needing an operator (FR7-FR10).
      //
      // Five conditions, and each one is a different way of not having earned
      // an advance. No resolved node: there is no graph to say where "next" even
      // is. A session that did not complete: recording progress for work that
      // died would make the log claim something that did not happen. A session
      // that asked: it is blocked behind a person now, and the next dispatch
      // re-enters this same node with the answer already in the prompt — moving
      // it on would answer its question by walking away from it
      // (`docs/spec/escalacao-humana.md`). Since t207-B, a session whose tree
      // was retained: its output is uncommitted, so advancing would move the
      // work off a node whose result lives nowhere the next node can read it —
      // and would clear the very state a human has to look at. And, since t268,
      // a report the control plane REFUSED: it stored `null` in place of it, so
      // an edge chosen from that report is chosen from a value nobody has.
      //
      // BEFORE the captured failures are rethrown, on purpose: a denial or a
      // closure the control plane refused is telemetry the runner owes, and
      // letting either of them strand a work that finished cleanly would trade
      // the recoverable problem for the unrecoverable one.
      if (
        resolved !== null &&
        outcome.status === 'completed' &&
        request === null &&
        !dirtyDespiteCompleted &&
        !refusedReport
      ) {
        await advance(call, job, resolved, session.id, output);
      }

      // A write that could not be made is not the session's fault, but it is a
      // fault: the control plane refused something the runner owes it, and a
      // silent swallow here would leave the log claiming a clean session. The
      // FIRST one captured is the one that surfaces — a denial happens during
      // the session, the closure after it, the cleanup last of all — which is
      // the precedent the denials' failure set when it was alone. Reporting more
      // than one at a time is a multi-error type nobody has needed yet.
      const failure = denials.failure ?? verdict.failure ?? releaseFailure;
      if (failure !== null) throw failure;

      // The engine refused to answer, which is not a session that died — it is a
      // session that was never going to happen (t265, FR7): throwing would put
      // the work back in the pool to buy the same refusal again, forever, with
      // nothing in anybody's inbox. The runner decides it alone, with no read at
      // all, because `onFinished` already handed it the fact.
      //
      // After the failure precedence above, so a refused write still surfaces as
      // itself, and before the throw below, which is the behaviour being
      // replaced. `controller.ts` needs nothing new: `attempt.blocked` already
      // means "keep going with the next candidate".
      if (outcome.failureKind === 'engine_refusal') {
        const reason = await blockForEngineRefusal(call, job, outcome.refusalCategory);
        return { blocked: true, reason };
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

      // A session ran and everything it owed was written. Said out loud since
      // t252, because the caller now has two normal endings to tell apart.
      return { blocked: false };
    } catch (error) {
      // Every exit that is not the terminal one lands here — a read that failed
      // before the session opened, the control-plane failure that cancels a live
      // session, a throw from the telemetry the runner owes, and since t161 a
      // transition the control plane refused. The tree stays on disk for all of
      // them: a work whose advance did not record is a work standing on a node
      // it already finished (FR8).
      //
      // A no-op for anything that threw AFTER the terminal release above, which
      // since t207-B includes the refused transition: that release already ran
      // with the outcome's own fate, and a clean tree it removed took nothing
      // with it. The one case where the directory really was the only copy is
      // the dirty one, and the manager retains that before any of this.
      await release(true);
      throw error;
    }
  };
}
