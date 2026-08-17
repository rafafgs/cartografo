/**
 * Which pre-session failures are worth blocking a work over, and with what
 * reason (t252, FR1/FR2).
 *
 * A dispatch does four reads before it acquires a worktree — the work, the graph
 * version, the engine route and the pinned skill — and four of them can throw an
 * error that will reproduce IDENTICALLY on every retry: a placeholder the input
 * does not carry, a skill nobody registered, a pin that stopped matching, an
 * engine with no route, and a `graph_version_id` the control plane no longer
 * has. Until this ficha every one of them travelled up through `tick()` into
 * `cli/run.ts`, which logged one line and turned the loop again — and two
 * seconds later the same job was at the head of the same queue, being dispatched
 * into the same throw. Forever, with nothing a human could see, and with no
 * other job of the project ever tried, because the queue's head never moved.
 *
 * **The whole subject of this module is that boundary.** A reason means the work
 * gets blocked: it leaves the candidate list (`GET /v1/jobs` filters
 * `blocked === false`), somebody reads `block_reason` in the inbox, and the
 * existing `POST /v1/jobs/:id/unblocks` is how it comes back. `null` means the
 * failure is transient — a 5xx, a network timeout, a control plane restarting —
 * and for those the retry IS the right answer; blocking one would make a person
 * undo a hiccup by hand.
 *
 * So the five are a CLOSED set, matching exactly the reproduction the ficha was
 * opened over. Everything else classifies to `null`, including the two error
 * families' own siblings: a wider net here is a work blocked over something that
 * would have healed itself, which is the failure mode in the other direction.
 *
 * **Why an `ErroDoControlPlane` with `status === 404` can only be the graph
 * version.** The skill registry's 404 is translated into
 * {@link SkillNotRegisteredError} inside `renderSkillInstructions` before it can
 * reach this function, and the work's own read happens outside the window this
 * classifies. What is left in the window is `resolveNode`, which rethrows
 * whatever the read threw (`resolve-node.ts`) — so a raw 404 arriving here is a
 * dangling `graph_version_id` and nothing else.
 *
 * Pure by construction: no HTTP, no client, no state. Who posts the block is
 * `report.ts`, who decides to is `dispatch.ts`, and this module only answers what
 * happened — which is what makes the boundary testable without a server.
 *
 * English per D18. The reasons are Portuguese, and deliberately so: they are
 * content a PERSON reads in the inbox, in the same voice
 * `blockForUncommittedWork` and `blockWithNobodyToAsk` already write in — never
 * the English `Error.message` these classes carry for a log.
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import {
  SkillNotRegisteredError,
  SkillPinMismatchError,
  UnresolvedPlaceholderError,
} from './render-skill-instructions.ts';
import { UnknownEngineError } from './resolve-engine.ts';

/**
 * The part of a work this classification names.
 *
 * Declared here rather than imported from `options.ts`, the same rule
 * `report.ts`'s {@link JobRef} follows: this module owes the orchestrator
 * nothing, and structural typing means the dispatch's own `Job` satisfies it
 * without either file naming the other.
 */
export interface PreSessionJob {
  /** The node the work is standing on. */
  current_node_id: string;
  /** The version it traverses, which is the one that may be dangling. */
  graph_version_id?: string | null;
}

/**
 * What the reason calls a graph version the work points at.
 *
 * The absent case cannot happen through `resolveNode` — a work with no version
 * resolves `null` without reading anything, so nothing 404s — and it is written
 * out anyway: a reason that renders `undefined` into the text a person reads is
 * worse than one that says out loud it has no id to show.
 */
function versionOf(job: PreSessionJob): string {
  const declared = job.graph_version_id;
  return declared === undefined || declared === null || declared === ''
    ? 'que o trabalho não declara'
    : '`' + declared + '`';
}

/**
 * Classifies an error thrown between the work being read and the worktree being
 * acquired.
 *
 * @param error Whatever the window threw, unopened.
 * @param job The work being dispatched.
 * @returns The block reason, in Portuguese, when the failure will reproduce on
 *   every retry; `null` when it will not, and the dispatch should keep throwing.
 */
export function classifyPreSessionFailure(error: unknown, job: PreSessionJob): string | null {
  if (error instanceof UnresolvedPlaceholderError) {
    return (
      `A skill \`${error.skillId}\` do nó \`${error.nodeId}\` nomeia entrada que este ` +
      `despacho não carrega: ${error.paths.join(', ')}. Nenhuma sessão foi aberta — um ` +
      'placeholder que não resolve nunca chega ao modelo como texto, e nada nisso muda ' +
      'entre um tick e o próximo. Monte a entrada do nó (ou corrija o manifesto) e desbloqueie.'
    );
  }

  if (error instanceof SkillNotRegisteredError) {
    return (
      `O nó \`${error.nodeId}\` fixa a skill \`${error.skillId}\`, que não está no ` +
      'registro. Nenhuma sessão foi aberta: uma skill que ninguém registrou não vira ' +
      'instrução genérica (D4). Registre o manifesto e desbloqueie.'
    );
  }

  if (error instanceof SkillPinMismatchError) {
    return (
      `O nó \`${error.nodeId}\` fixa a skill \`${error.skillId}\` no hash ` +
      `\`${error.declared}\`, mas o registro carrega \`${error.registered}\`. Nenhuma ` +
      'sessão foi aberta: um pin que parou de casar quer dizer que o conteúdo se moveu ' +
      'debaixo de um grafo que alguém validou (D4). Confira qual dos dois mudou e desbloqueie.'
    );
  }

  if (error instanceof UnknownEngineError) {
    const known = error.known.length === 0 ? 'nenhum' : error.known.join(', ');
    return (
      `O nó \`${error.nodeId}\` pede o engine \`${error.engine}\`, que não tem rota neste ` +
      `runner (registrados: ${known}). Nenhuma sessão foi aberta: despachar em outro ` +
      'engine rodaria o trabalho num motor que ninguém escolheu, e ainda registraria esse ' +
      'motor como se o grafo o tivesse pedido. Configure a rota (ou corrija o grafo) e desbloqueie.'
    );
  }

  // The status is what decides, and only this one: every other refusal is the
  // control plane having a bad day, and a bad day passes.
  if (error instanceof ErroDoControlPlane && error.status === 404) {
    return (
      `O trabalho aponta para a versão de grafo ${versionOf(job)}, e o control plane ` +
      'respondeu 404: a referência está pendurada. Nenhuma sessão foi aberta — sem o ' +
      'snapshot não há nó, nem contrato, nem aresta de saída, e a leitura responde o ' +
      'mesmo 404 em toda retentativa. Aponte o trabalho para uma versão registrada e desbloqueie.'
    );
  }

  return null;
}
