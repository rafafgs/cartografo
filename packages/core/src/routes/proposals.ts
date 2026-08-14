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
import {
  applyOperations,
  validateOperation,
  ApplicationError,
  type Operation,
} from '../domain/operations.ts';
import { getGraph, getVersion } from '../repositories/graphs.ts';
import {
  applyProposal,
  getProposal,
  createProposal,
  rejectProposal,
  revertProposal,
  type ProposalRow,
} from '../repositories/proposals.ts';

interface IdParam {
  Params: { id: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        mensagem: 'versao_alvo precisa existir e pertencer a grafo_id',
        versao_alvo: targetVersion ?? null,
      };
    }

    if (body.evidencia === undefined || body.metrica_esperada === undefined) {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem:
          'proposta é hipótese: evidencia e metrica_esperada são obrigatórias (D15, nota de aprendizado)',
      };
    }

    const rawOperations = body.operacoes;
    if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
      reply.code(400);
      return { erro: 'operacoes_invalidas', mensagem: 'operacoes precisa ser uma lista não vazia' };
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

  app.post<IdParam>('/proposals/:id/apply', async (request, reply) => {
    const proposal = load(db, request.params.id);
    if (proposal === undefined) {
      reply.code(404);
      return { erro: 'proposta_desconhecida', id: request.params.id };
    }

    if (proposal.status !== 'pendente') {
      reply.code(409);
      return {
        erro: 'proposta_nao_pendente',
        mensagem: `só proposta pendente pode ser aplicada; esta está "${proposal.status}"`,
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
        mensagem: 'a base mudou desde que a proposta foi escrita; refazer o diff é do topógrafo',
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
        mensagem: 'as operações produzem um snapshot que já existe na linhagem',
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
        mensagem: 'reverter exige motivo: é a evidência cruzada com a telemetria da versão abandonada',
      };
    }

    if (proposal.status !== 'aplicada') {
      reply.code(409);
      return {
        erro: 'proposta_nao_aplicada',
        mensagem: `só proposta aplicada pode ser revertida; esta está "${proposal.status}"`,
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
        mensagem: 'a versão aplicada por esta proposta não é mais a corrente',
        versao_aplicada_id: proposal.versao_aplicada_id,
        versao_corrente: graph.versao_corrente_id,
      };
    }

    const reverted = revertProposal(db, { proposal, reason });
    return { proposta: reverted, grafo: getGraph(db, proposal.grafo_id) };
  });
}

/** Resolves a route's `:id` into a proposal; a non-numeric id is a 404, not a 500. */
function load(db: Database, id: string): ProposalRow | undefined {
  const parsed = Number(id);
  if (!Number.isInteger(parsed)) return undefined;
  return getProposal(db, parsed);
}
