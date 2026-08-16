/**
 * Proposal routes (t101, FR7/FR8/FR9).
 *
 * `POST /proposals/:id/apply` is the whole D15 flow in one handler: apply ops →
 * validate soundness on the RESULT → write the new version → move the pointer.
 * The order is not negotiable: the gate runs over the document that would come
 * out, not over the one that went in, because it is the composition of the
 * operations that breaks the graph — each of them in isolation can be flawless.
 *
 * A rejection does not erase the proposal: it becomes `rejeitada` with the report
 * in `resultado`. A failed hypothesis is evidence for the topographer (t110),
 * not rubbish.
 *
 * Concurrency between proposals is out of scope (t118): if the base moved under
 * the proposal, it is refused with a 409 instead of being rebased automatically.
 *
 * The request/response field names stay in Portuguese: they mirror the untouched
 * migration columns (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { validateGraph } from '../domain/graph.ts';
import { hashSnapshot } from '../domain/hash.ts';
import { isExpectedMetric, validateExpectedMetric, verdictFor } from '../domain/hypothesis.ts';
import {
  applyOperations,
  validateOperation,
  ApplicationError,
  type Operation,
} from '../domain/operations.ts';
import { getGraph, getVersion } from '../repositories/graphs.ts';
import { metricsByVersion } from '../repositories/job.ts';
import {
  applyProposal,
  approveProposal,
  getProposal,
  createProposal,
  listProposals,
  recordVerdict,
  rejectProposal,
  rejectProposalByHuman,
  revertProposal,
  type ProposalRow,
} from '../repositories/proposals.ts';
import { isObject } from '../util/is-object.ts';

interface IdParam {
  Params: { id: string };
}

/**
 * Registers the proposal routes in the given scope (already carrying the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerProposals(app: FastifyInstance, db: Database): void {
  app.post('/proposals', async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};

    const graphId = body.grafo_id;
    if (typeof graphId !== 'string' || getGraph(db, graphId) === undefined) {
      reply.code(400);
      return { erro: 'grafo_desconhecido', grafo_id: graphId ?? null };
    }

    const targetVersion = body.versao_alvo;
    const version = typeof targetVersion === 'string' ? getVersion(db, targetVersion) : undefined;
    if (version === undefined || version.grafo_id !== graphId) {
      reply.code(400);
      return {
        erro: 'versao_alvo_desconhecida',
        mensagem: 'versao_alvo has to exist and belong to grafo_id',
        versao_alvo: targetVersion ?? null,
      };
    }

    if (body.evidencia === undefined || body.metrica_esperada === undefined) {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem:
          'a proposal is a hypothesis: evidencia and metrica_esperada are required (D15, learning note)',
      };
    }

    const rawOperations = body.operacoes;
    if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
      reply.code(400);
      return { erro: 'operacoes_invalidas', mensagem: 'operacoes has to be a non-empty list' };
    }

    const problems = rawOperations
      .map((operation, indice) => ({ indice, ...validateOperation(operation) }))
      .filter((report) => !report.valido)
      .map((report) => ({ indice: report.indice, erros: report.erros }));
    if (problems.length > 0) {
      reply.code(400);
      return { erro: 'operacoes_invalidas', operacoes: problems };
    }

    const proposal = createProposal(db, {
      grafo_id: graphId,
      versao_alvo: targetVersion as string,
      operacoes: rawOperations as Operation[],
      evidencia: body.evidencia,
      metrica_esperada: body.metrica_esperada,
    });

    reply.code(201);
    return { proposta: proposal };
  });

  /* ------------------------------------------------------------------------ */
  /* t165 — the human gate. The tela has offered `Aprovar`/`Rejeitar` since    */
  /* t111 against routes that did not exist; these are them.                   */
  /* ------------------------------------------------------------------------ */

  app.post<IdParam>('/proposals/:id/approve', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    if (proposal.status !== 'pendente') {
      reply.code(409);
      return {
        erro: 'proposta_nao_pendente',
        mensagem: `only a pending proposal can be approved; this one is "${proposal.status}"`,
        status: proposal.status,
      };
    }

    // Approving writes the decision and stops there. Applying is a second,
    // deliberate act — the safety ladder of princípio 5 is that separation, and
    // collapsing the two here would be undoing it in the name of one click less.
    return { proposta: approveProposal(db, proposal.id) };
  });

  app.post<IdParam>('/proposals/:id/reject', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    // Reason before status, like `revert`: a rejected proposal is negative
    // knowledge for the topographer, and "no" with no reason is the half of the
    // fact nobody can learn from.
    const body = isObject(request.body) ? request.body : {};
    const reason = body.motivo;
    if (typeof reason !== 'string' || reason.trim() === '') {
      reply.code(400);
      return {
        erro: 'motivo_obrigatorio',
        mensagem:
          'rejecting requires a reason: a rejected proposal is negative knowledge for the surveyor, and without the why it is not',
      };
    }

    if (proposal.status !== 'pendente') {
      reply.code(409);
      return {
        erro: 'proposta_nao_pendente',
        mensagem: `only a pending proposal can be rejected; this one is "${proposal.status}"`,
        status: proposal.status,
      };
    }

    return { proposta: rejectProposalByHuman(db, proposal.id, reason.trim()) };
  });

  app.post<IdParam>('/proposals/:id/apply', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    // `aprovada`, not `pendente` (t165): a change to the graph passes a human
    // gate, and a proposal that skipped it has to fail loudly. The code is its
    // own — `proposta_nao_pendente` now describes approve/reject's precondition,
    // and reusing it here would say the wrong thing about which step is missing.
    if (proposal.status !== 'aprovada') {
      reply.code(409);
      return {
        erro: 'proposta_nao_aprovada',
        mensagem: `only an approved proposal can be applied; this one is "${proposal.status}"`,
        status: proposal.status,
      };
    }

    const graph = getGraph(db, proposal.grafo_id);
    if (graph === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', grafo_id: proposal.grafo_id };
    }

    if (graph.versao_corrente_id !== proposal.versao_alvo) {
      reply.code(409);
      return {
        erro: 'proposta_desatualizada',
        mensagem: 'the base moved since the proposal was written; redoing the diff is up to the surveyor',
        versao_alvo: proposal.versao_alvo,
        versao_corrente: graph.versao_corrente_id,
      };
    }

    const target = getVersion(db, proposal.versao_alvo);
    if (target === undefined) {
      reply.code(404);
      return { erro: 'grafo_versao_desconhecida', id: proposal.versao_alvo };
    }

    let document;
    try {
      document = applyOperations(target.snapshot, proposal.operacoes);
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      const report = {
        erro: 'operacao_inaplicavel',
        codigo: error.code,
        mensagem: error.message,
        alvo: error.target,
      };
      reply.code(422);
      return { ...report, proposta: rejectProposal(db, proposal.id, report) };
    }

    // The gate: soundness runs BEFORE any write, over the document that would
    // come out. If it fails, nothing enters the database beyond the status and
    // the report.
    const report = validateGraph(document);
    if (!report.valido) {
      reply.code(422);
      return {
        erro: 'grafo_invalido',
        ...report,
        proposta: rejectProposal(db, proposal.id, report),
      };
    }

    const versionId = hashSnapshot(document);
    if (getVersion(db, versionId) !== undefined) {
      // The hash IS the version's identity: a result identical to an already
      // known version is not a new version, it is a proposal with no effect.
      const noEffect = {
        erro: 'versao_sem_efeito',
        mensagem: 'the operations produce a snapshot that already exists in the lineage',
        versao_existente: versionId,
      };
      reply.code(422);
      return { ...noEffect, proposta: rejectProposal(db, proposal.id, noEffect) };
    }

    const written = applyProposal(db, { proposal, versionId, document });
    return {
      proposta: written.proposal,
      grafo: getGraph(db, proposal.grafo_id),
      grafo_versao: written.version,
    };
  });

  app.post<IdParam>('/proposals/:id/revert', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    // Reason before status: it is the field the `grafo_versao.revertida` event
    // demands, and it is the evidence the topographer will cross with the
    // telemetry of the abandoned version. Reverting without saying why loses the
    // useful half of the fact.
    const body = isObject(request.body) ? request.body : {};
    const reason = body.motivo;
    if (typeof reason !== 'string' || reason.trim() === '') {
      reply.code(400);
      return {
        erro: 'motivo_obrigatorio',
        mensagem: 'reverting requires a reason: it is the evidence crossed with the telemetry of the abandoned version',
      };
    }

    if (proposal.status !== 'aplicada') {
      reply.code(409);
      return {
        erro: 'proposta_nao_aplicada',
        mensagem: `only an applied proposal can be reverted; this one is "${proposal.status}"`,
        status: proposal.status,
      };
    }

    const graph = getGraph(db, proposal.grafo_id);
    if (graph === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', grafo_id: proposal.grafo_id };
    }

    // Reverting is the exact counterpart of this proposal. If another version
    // came on top, the pointer would skip intermediate versions — free history
    // navigation is another thing, and it is out of this ticket.
    if (graph.versao_corrente_id !== proposal.versao_aplicada_id) {
      reply.code(409);
      return {
        erro: 'proposta_desatualizada',
        mensagem: 'the version this proposal applied is no longer the current one',
        versao_aplicada_id: proposal.versao_aplicada_id,
        versao_corrente: graph.versao_corrente_id,
      };
    }

    const reverted = revertProposal(db, { proposal, reason });
    return { proposta: reverted, grafo: getGraph(db, proposal.grafo_id) };
  });

  /* ------------------------------------------------------------------------ */
  /* t112 — the next run closes the proposal. Route segments are code and were  */
  /* renamed to English with the rest of the surface (t127, FR3); the payload   */
  /* keys stay in Portuguese, mirroring the untouched column (FR8).             */
  /* ------------------------------------------------------------------------ */

  app.post<IdParam>('/proposals/:id/outcome', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    const body = isObject(request.body) ? request.body : {};
    const executionId = body.execucao_id;
    const after = body.depois;
    if (!Number.isInteger(executionId) || !Number.isFinite(after)) {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem:
          'closing the experiment requires execucao_id (an integer) and depois (a number): whoever computes the metric is whoever calls',
      };
    }

    if (proposal.status !== 'aplicada') {
      reply.code(409);
      return {
        erro: 'proposta_nao_aplicada',
        mensagem: `only an applied proposal has an experiment to close; this one is "${proposal.status}"`,
        status: proposal.status,
      };
    }

    // Only the first call counts. Re-evaluating would be rewriting a hypothesis'
    // past, and the column holds ONE result, the one of the first next round.
    if (proposal.resultado !== null) {
      reply.code(409);
      return {
        erro: 'proposta_ja_avaliada',
        mensagem: 'the outcome of this hypothesis was already recorded by the first next execution',
        resultado: proposal.resultado,
      };
    }

    const metric = proposal.metrica_esperada;
    if (!isExpectedMetric(metric)) {
      // Creation never validated this shape (out of scope here): an applied
      // proposal may perfectly well carry a metric nobody can read. Computing a
      // verdict over incomplete data is worse than not computing one.
      reply.code(422);
      return {
        erro: 'metrica_esperada_invalida',
        mensagem:
          'metrica_esperada has to have the shape {nome, direcao: "sobe"|"cai", de, para} for there to be a verdict',
        detalhes: validateExpectedMetric(metric).map((problem) => problem.message),
      };
    }

    // "The next execution" has to be demonstrable from telemetry (t102's FR17),
    // not claimed in the body: with no job recorded under the version this
    // proposal applied, there is no next round to speak of.
    const appliedVersion = proposal.versao_aplicada_id;
    const evidence =
      appliedVersion === null
        ? undefined
        : metricsByVersion(db, executionId as number).find(
            (row) => row.grafo_versao_id === appliedVersion,
          );
    if (evidence === undefined || evidence.trabalhos < 1) {
      reply.code(422);
      return {
        erro: 'execucao_sem_evidencia',
        mensagem: 'no work item of this execution ran under the version the proposal applied',
        execucao_id: executionId,
        versao_aplicada_id: appliedVersion,
      };
    }

    const written = recordVerdict(db, {
      proposal,
      executionId: executionId as number,
      after: after as number,
      verdict: verdictFor(metric, after as number),
      before: metric.de,
    });

    // The status stays `aplicada` on purpose: "piorou" is data, not an action.
    // Reverting is a human decision, through the revert route (README, princípio 5).
    return { proposta: written };
  });

  app.get('/proposals', async (request) => {
    const filter = request.query as { status?: string; veredito?: string };
    return {
      propostas: listProposals(db, {
        status: optionalFilter(filter.status),
        veredito: optionalFilter(filter.veredito),
      }),
    };
  });

  // The detail read the tela has assumed since t111
  // (`docs/spec/tela-inbox-propostas.md` §2) and that closing the gate finally
  // needs: whoever is about to approve reads ONE proposal, and the script that
  // closes the experiment reads the `metrica_esperada` of ONE proposal (t165,
  // FR5/FR9). Same row the listing returns, `motivo_rejeicao` included.
  app.get<IdParam>('/proposals/:id', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }
    return { proposta: proposal };
  });
}

/** An absent or empty querystring filter means "no filter", not "empty". */
function optionalFilter(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Resolves a route's `:id` into a proposal; a non-numeric id is a 404, not a 500. */
function load(db: Database, id: string): ProposalRow | undefined {
  const parsed = Number(id);
  if (!Number.isInteger(parsed)) return undefined;
  return getProposal(db, parsed);
}
