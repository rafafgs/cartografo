/**
 * Intake routes (t122): from a request to a breakdown of tickets on the graph.
 *
 * Two phases, and the boundary between them is the whole feature. `POST /intake`
 * only PROPOSES a breakdown; `POST /intake/:id/confirmations` is the human gate
 * (README, principle 5) that turns the proposal into travellers. Between the two
 * the draft can be amended or discarded, and nothing outside `intake_rascunho`
 * has heard about it.
 *
 * The confirmation is a plural sub-resource, like the job's `/transitions` and
 * `/blocks`, and for the same reason: it corresponds to a distinct FACT, not to
 * a field somebody could flip. `PATCH` is left for what really is editing the
 * draft's content.
 *
 * How the breakdown is PRODUCED out of the request in natural language is out of
 * scope: `itens` arrives already decomposed, whoever wrote it. This route
 * dispatches no session and knows no engine.
 *
 * The request/response field names and the error codes stay in Portuguese: they
 * mirror the untouched migration columns and follow the wire vocabulary of the
 * graph and proposal routes (t127, FR8).
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { validateItems } from '../domain/intake.ts';
import { DEFAULT_PROJECT, resolveActor } from '../repositories/common.ts';
import { getClassBase, getVersion } from '../repositories/graphs.ts';
import {
  amendDraft,
  confirmDraft,
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  INTAKE_ACTOR,
  type Draft,
} from '../repositories/intake.ts';

interface IdParam {
  Params: { id: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The draft named by the route's `:id`, if there is one.
 *
 * An `:id` that is not an integer names no draft either, and comes back as the
 * same `undefined`: whoever asked for `/intake/abc` gets the 404 they deserve,
 * not a 500 from the driver.
 */
function load(db: Database, raw: string): Draft | undefined {
  const id = Number(raw);
  if (!Number.isInteger(id)) return undefined;
  return getDraft(db, id) ?? undefined;
}

/**
 * Registers the intake routes in the given scope (already carrying the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerIntake(app: FastifyInstance, db: Database): void {
  /** The 404 of a draft that does not exist, and of an unusable `:id`. */
  const unknownDraft = (raw: string): { erro: string; id: string } => ({
    erro: 'rascunho_desconhecido',
    id: raw,
  });

  /** The 409 of anything that only holds while the draft is pending. */
  const notPending = (draft: Draft): Record<string, unknown> => ({
    erro: 'rascunho_nao_pendente',
    mensagem: `só rascunho pendente aceita esta operação; este está "${draft.status}"`,
    status: draft.status,
  });

  app.post('/intake', async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};

    if (!isFilledText(body.classe) || !isFilledText(body.pedido)) {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem: '"classe" e "pedido" são textos obrigatórios',
        classe: body.classe ?? null,
      };
    }

    // The class has to name a lineage that already exists: suggesting a class by
    // similarity (D8) and graph variants (D13) are out of scope, so without an
    // exact match there is no entry node to be born on.
    const graph = getClassBase(db, body.classe);
    if (graph === undefined) {
      reply.code(404);
      return {
        erro: 'grafo_desconhecido',
        mensagem: `a classe "${body.classe}" não tem grafo base registrado`,
        classe: body.classe,
      };
    }

    const report = validateItems(body.itens);
    if (!report.valido) {
      reply.code(400);
      return { erro: 'itens_invalidos', problemas: report.problemas };
    }

    const projectId = body.projeto_id;
    if (projectId !== undefined && projectId !== null && !Number.isInteger(projectId)) {
      reply.code(400);
      return { erro: 'campo_invalido', mensagem: '"projeto_id" precisa ser inteiro' };
    }
    const executionId = body.execucao_id;
    if (executionId !== undefined && executionId !== null && !Number.isInteger(executionId)) {
      reply.code(400);
      return { erro: 'campo_invalido', mensagem: '"execucao_id" precisa ser inteiro' };
    }

    const draft = createDraft(db, {
      projeto_id: (projectId as number | undefined | null) ?? DEFAULT_PROJECT,
      execucao_id: (executionId as number | undefined | null) ?? null,
      classe: body.classe,
      pedido: body.pedido,
      itens: report.itens,
    });

    reply.code(201);
    return { rascunho: draft };
  });

  app.get('/intake', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    let projectId: number | undefined;
    if (query.projeto_id !== undefined && query.projeto_id !== '') {
      projectId = Number(query.projeto_id);
      if (!Number.isInteger(projectId)) {
        reply.code(400);
        return { erro: 'campo_invalido', mensagem: '"projeto_id" precisa ser inteiro' };
      }
    }

    return {
      rascunhos: listDrafts(db, {
        status: query.status,
        classe: query.classe,
        projeto_id: projectId,
      }),
    };
  });

  app.get<IdParam>('/intake/:id', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) {
      reply.code(404);
      return unknownDraft(request.params.id);
    }
    return { rascunho: draft };
  });

  app.patch<IdParam>('/intake/:id', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) {
      reply.code(404);
      return unknownDraft(request.params.id);
    }
    if (draft.status !== 'pendente') {
      reply.code(409);
      return notPending(draft);
    }

    const body = isObject(request.body) ? request.body : {};
    const report = validateItems(body.itens);
    if (!report.valido) {
      reply.code(400);
      return { erro: 'itens_invalidos', problemas: report.problemas };
    }

    const amended = amendDraft(db, draft.id, report.itens);
    if (amended === null) {
      reply.code(409);
      return notPending(getDraft(db, draft.id) ?? draft);
    }
    return { rascunho: amended };
  });

  app.post<IdParam>('/intake/:id/discards', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) {
      reply.code(404);
      return unknownDraft(request.params.id);
    }
    if (draft.status !== 'pendente') {
      reply.code(409);
      return notPending(draft);
    }

    const discarded = discardDraft(db, draft.id);
    if (discarded === null) {
      reply.code(409);
      return notPending(getDraft(db, draft.id) ?? draft);
    }
    return { rascunho: discarded };
  });

  app.post<IdParam>('/intake/:id/confirmations', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) {
      reply.code(404);
      return unknownDraft(request.params.id);
    }
    if (draft.status !== 'pendente') {
      reply.code(409);
      return notPending(draft);
    }

    // The pointer is read HERE, at confirmation time, and not when the draft was
    // opened: between proposing a breakdown and accepting it the class may have
    // gained a version, and the travellers belong to the one that holds now.
    const graph = getClassBase(db, draft.classe);
    const version =
      graph?.versao_corrente_id === null || graph?.versao_corrente_id === undefined
        ? undefined
        : getVersion(db, graph.versao_corrente_id);
    if (graph === undefined || version === undefined) {
      reply.code(404);
      return {
        erro: 'grafo_desconhecido',
        mensagem: `a classe "${draft.classe}" não tem versão de grafo vigente`,
        classe: draft.classe,
      };
    }

    const body = isObject(request.body) ? request.body : {};
    const confirmation = confirmDraft(db, {
      draft,
      no_inicial: version.snapshot.no_inicial,
      grafo_versao_id: version.id,
      ator: resolveActor(body.ator, INTAKE_ACTOR),
    });

    reply.code(201);
    return confirmation;
  });
}
