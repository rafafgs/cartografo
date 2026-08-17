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
 * Since t226 the request and response field names are English
 * (`docs/spec/glossario-wire.md` §1), and since t227 so is the one exception
 * that survived it: `POST /intake/:id/confirmations` writes EVENTS through
 * `confirmDraft`, so its body carries `actor` and its `type`/`ref` — the event
 * envelope, D20's second child.
 *
 * The `itens` a draft carries are `domain/intake.ts`'s format, not this API's
 * vocabulary: they pass through byte for byte, keys included, and the glossary
 * maps none of them.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Database } from '../db/connection.ts';
import { validateItems } from '../domain/intake.ts';
import { DEFAULT_PROJECT, resolveActor } from '../repositories/common.ts';
import { getClassBase, getVersion } from '../repositories/graphs.ts';
import {
  amendDraft,
  confirmDraft,
  createDraft,
  discardDraft,
  draftStatusColumn,
  getDraft,
  listDrafts,
  toWireDraft,
  INTAKE_ACTOR,
  type Draft,
} from '../repositories/intake.ts';
import { toWireJob } from '../repositories/job.ts';
import { isObject } from '../util/is-object.ts';
import { refusal, withValidation } from './common.ts';

interface IdParam {
  Params: { id: string };
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
  const unknownDraft = (reply: FastifyReply, raw: string): Record<string, unknown> =>
    refusal(reply, 404, 'unknown_draft', undefined, { id: raw });

  /** The 409 of anything that only holds while the draft is pending. */
  const notPending = (reply: FastifyReply, draft: Draft): Record<string, unknown> => {
    const status = toWireDraft(draft).status;
    return refusal(
      reply,
      409,
      'draft_not_pending',
      `only a pending draft accepts this operation; this one is "${status}"`,
      { status },
    );
  };

  app.post('/intake', async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};

    if (!isFilledText(body.class) || !isFilledText(body.request)) {
      return refusal(reply, 400, 'missing_required_field', '"class" and "request" are required texts', {
        class: body.class ?? null,
      });
    }

    // The class has to name a lineage that already exists: suggesting a class by
    // similarity (D8) and graph variants (D13) are out of scope, so without an
    // exact match there is no entry node to be born on.
    const graph = getClassBase(db, body.class);
    if (graph === undefined) {
      return refusal(reply, 404, 'unknown_graph', `class "${body.class}" has no base graph registered`, {
        class: body.class,
      });
    }

    const report = validateItems(body.items);
    if (!report.valido) {
      return refusal(reply, 400, 'invalid_items', undefined, { problems: report.problemas });
    }

    const projectId = body.project_id;
    if (projectId !== undefined && projectId !== null && !Number.isInteger(projectId)) {
      return refusal(reply, 400, 'invalid_field', '"project_id" has to be an integer');
    }
    const executionId = body.execution_id;
    if (executionId !== undefined && executionId !== null && !Number.isInteger(executionId)) {
      return refusal(reply, 400, 'invalid_field', '"execution_id" has to be an integer');
    }

    const draft = createDraft(db, {
      projeto_id: (projectId as number | undefined | null) ?? DEFAULT_PROJECT,
      execucao_id: (executionId as number | undefined | null) ?? null,
      classe: body.class,
      pedido: body.request,
      itens: report.itens,
    });

    reply.code(201);
    return { draft: toWireDraft(draft) };
  });

  app.get('/intake', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    let projectId: number | undefined;
    if (query.project_id !== undefined && query.project_id !== '') {
      projectId = Number(query.project_id);
      if (!Number.isInteger(projectId)) {
        return refusal(reply, 400, 'invalid_field', '"project_id" has to be an integer');
      }
    }

    const status =
      query.status === undefined ? undefined : (draftStatusColumn(query.status) ?? query.status);
    const drafts = listDrafts(db, {
      status,
      classe: query.class,
      projeto_id: projectId,
    });
    return { drafts: drafts.map(toWireDraft) };
  });

  app.get<IdParam>('/intake/:id', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) return unknownDraft(reply, request.params.id);
    return { draft: toWireDraft(draft) };
  });

  app.patch<IdParam>('/intake/:id', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) return unknownDraft(reply, request.params.id);
    if (draft.status !== 'pendente') return notPending(reply, draft);

    const body = isObject(request.body) ? request.body : {};
    const report = validateItems(body.items);
    if (!report.valido) {
      return refusal(reply, 400, 'invalid_items', undefined, { problems: report.problemas });
    }

    const amended = amendDraft(db, draft.id, report.itens);
    if (amended === null) return notPending(reply, getDraft(db, draft.id) ?? draft);
    return { draft: toWireDraft(amended) };
  });

  app.post<IdParam>('/intake/:id/discards', async (request, reply) => {
    const draft = load(db, request.params.id);
    if (draft === undefined) return unknownDraft(reply, request.params.id);
    if (draft.status !== 'pendente') return notPending(reply, draft);

    const discarded = discardDraft(db, draft.id);
    if (discarded === null) return notPending(reply, getDraft(db, draft.id) ?? draft);
    return { draft: toWireDraft(discarded) };
  });

  // The only intake route that writes an EVENT, and therefore the only one whose
  // body reaches `validateEvent`: `withValidation` is what turns the refusal of a
  // malformed `actor` into the 400 every other route of this API answers with,
  // instead of letting the domain validator's message escape as a 500 (t139).
  app.post<IdParam>('/intake/:id/confirmations', async (request, reply) =>
    withValidation(reply, () => {
      const draft = load(db, request.params.id);
      if (draft === undefined) return unknownDraft(reply, request.params.id);
      if (draft.status !== 'pendente') return notPending(reply, draft);

      // The pointer is read HERE, at confirmation time, and not when the draft was
      // opened: between proposing a breakdown and accepting it the class may have
      // gained a version, and the travellers belong to the one that holds now.
      const graph = getClassBase(db, draft.classe);
      const version =
        graph?.versao_corrente_id === null || graph?.versao_corrente_id === undefined
          ? undefined
          : getVersion(db, graph.versao_corrente_id);
      if (graph === undefined || version === undefined) {
        return refusal(
          reply,
          404,
          'unknown_graph',
          `class "${draft.classe}" has no graph version in force`,
          { class: draft.classe },
        );
      }

      // `actor` is the EVENT envelope's actor, checked by `validateEvent`
      // inside `confirmDraft` (t226, FR2; English since t227). What comes back
      // is translated like every other read.
      const body = isObject(request.body) ? request.body : {};
      const confirmation = confirmDraft(db, {
        draft,
        no_inicial: version.snapshot.initial_node,
        grafo_versao_id: version.id,
        actor: resolveActor(body.actor, INTAKE_ACTOR),
      });

      reply.code(201);
      return {
        draft: toWireDraft(confirmation.rascunho),
        jobs: confirmation.trabalhos.map(toWireJob),
      };
    }),
  );
}
