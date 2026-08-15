/**
 * Graph and graph-version routes (t101, FR5/FR6).
 *
 * `POST /graphs` is the path that turns a graph into DATA: the very same
 * `grafo.json` of the factory bundle goes in raw, passes the validation gate and
 * becomes a lineage plus a first version. It is D16's "graph living as data in
 * the database (not as code)" criterion.
 *
 * The body is the pure graph document, with no envelope. There is no Fastify/ajv
 * schema declared against `schema/grafo.schema.json`: the t96 schema is draft
 * 2020-12 and the ajv shipped with Fastify v5 is configured for draft-07.
 * Instead of reconfiguring the compiler, the gate is the
 * `validateStructure`/`validateSoundness` pair called in the handler — which is
 * the same judgement a proposal suffers when applied, and therefore cannot
 * diverge from it.
 *
 * No route here emits a telemetry event: the append-only event table belongs to
 * t102. The field names are already the ones of the `grafo_versao.*` schemas, so
 * that the future emission is a direct mapping — and they stay in Portuguese for
 * the same reason (t127, FR8).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';

import type { Database } from '../db/connection.ts';
import { diffGraphs } from '../domain/diff.ts';
import { validateGraph, type GraphDocument } from '../domain/graph.ts';
import { hashSnapshot } from '../domain/hash.ts';
import type { Operation } from '../domain/operations.ts';
import {
  forkVariant,
  getClassBase,
  getGraph,
  getVersion,
  getVersionSummary,
  listClasses,
  listGraphs,
  listVersions,
  registerBaseGraph,
  type GraphRow,
} from '../repositories/graphs.ts';
import { createProposal, getProposal } from '../repositories/proposals.ts';

interface IdParam {
  Params: { id: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The refusal body when the hypothesis fields are missing, or `undefined`.
 *
 * Same demand and same shape as `POST /proposals` (`routes/proposals.ts`):
 * presence only, never the shape of what is inside. Promotion and offer are
 * proposals like any other, and validating them harder here than at the route
 * everyone already uses would be two different contracts for one table.
 */
function missingHypothesis(body: Record<string, unknown>): Record<string, unknown> | undefined {
  if (body.evidencia !== undefined && body.metrica_esperada !== undefined) return undefined;
  return {
    erro: 'campo_obrigatorio_ausente',
    mensagem:
      'a proposal is a hypothesis: evidencia and metrica_esperada are required (D15, learning note)',
  };
}

/** The direction of a promotion or an offer, once the route knows which is which. */
interface Direction {
  /** Lineage that RECEIVES the pending proposal. */
  target: GraphRow;
  /** Lineage whose current snapshot the target would come to match. */
  source: GraphRow;
  evidencia: unknown;
  metrica_esperada: unknown;
}

/**
 * Tail shared by `/promote` and `/offer`: diff the two current snapshots in the
 * chosen direction and open the pending proposal.
 *
 * Both refusals happen before any write, like everywhere else in this file. The
 * empty diff is a `422` and not a silent `201`: a proposal with no operation
 * would be a hypothesis about nothing, and it would sit in the human queue
 * asking for a decision that changes no document.
 *
 * @param db Already open database (D1).
 * @param reply Fastify reply, used only to set the status code.
 * @param data Target, source and the two hypothesis fields, already checked for presence.
 * @returns The body to return — the created proposal, or the refusal.
 */
function openProposal(
  db: Database,
  reply: FastifyReply,
  data: Direction,
): Record<string, unknown> {
  const { target, source } = data;

  // Defensive invariant, the same one the fork route guards: a lineage with no
  // pointer is a graph that exists without holding, which no path here creates.
  const to = current(db, source);
  const from = current(db, target);
  if (to === undefined || from === undefined) {
    reply.code(409);
    return {
      erro: 'grafo_sem_versao_corrente',
      mensagem: 'both lineages have to point at a current version for there to be a diff',
      grafo_id: from === undefined ? target.id : source.id,
    };
  }

  const operations: Operation[] = diffGraphs(from, to);
  if (operations.length === 0) {
    reply.code(422);
    return {
      erro: 'diff_sem_efeito',
      mensagem: 'the two snapshots already agree on "nos" and "arestas"; there is no diff to propose',
      grafo_id: target.id,
    };
  }

  const proposal = createProposal(db, {
    grafo_id: target.id,
    versao_alvo: target.versao_corrente_id as string,
    operacoes: operations,
    evidencia: data.evidencia,
    metrica_esperada: data.metrica_esperada,
  });

  reply.code(201);
  return { proposta: proposal };
}

/** The document that holds today for a lineage, or `undefined` if the pointer is empty. */
function current(db: Database, graph: GraphRow): GraphDocument | undefined {
  if (graph.versao_corrente_id === null) return undefined;
  return getVersion(db, graph.versao_corrente_id)?.snapshot;
}

/**
 * Registers the graph routes in the given scope (which already carries the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerGraphs(app: FastifyInstance, db: Database): void {
  app.post('/graphs', async (request, reply) => {
    const document = request.body;

    const report = validateGraph(document);
    if (!report.valido) {
      reply.code(422);
      return { erro: 'grafo_invalido', ...report };
    }

    // The document passed the gate, so it is an object with the seven keys; all
    // that is left is making sure `classe` serves as identity (D8: lineage id =
    // class).
    const raw = document as Record<string, unknown>;
    const className = raw.classe;
    if (typeof className !== 'string' || className.trim() === '') {
      reply.code(422);
      return {
        erro: 'grafo_invalido',
        valido: false,
        estrutura: {
          valido: false,
          erros: [
            {
              codigo: 'campo_invalido',
              mensagem: '"classe" has to be a filled text: it is the identity of the lineage (D8)',
              alvo: 'classe',
            },
          ],
        },
        soundness: report.soundness,
      };
    }

    const lineage = isObject(raw.linhagem) ? raw.linhagem : {};
    if (lineage.tipo !== 'base') {
      reply.code(400);
      return {
        erro: 'linhagem_nao_base',
        mensagem:
          'this route registers only a base graph; a variant is born from POST /v1/graphs/:id/fork (D13)',
        linhagem_tipo: lineage.tipo ?? null,
      };
    }

    if (getClassBase(db, className) !== undefined) {
      reply.code(409);
      return {
        erro: 'classe_ja_registrada',
        mensagem: `class "${className}" already has a base graph; a new version over an existing lineage is the proposal flow`,
        classe: className,
      };
    }

    const { graph, version } = registerBaseGraph(db, document as GraphDocument);
    reply.code(201);
    return { grafo: graph, grafo_versao: version };
  });

  /**
   * `POST /graphs/:id/fork` is D13's branch semantics: the variant is born as the
   * base's current snapshot, byte for byte, with `linhagem` swapped and nothing
   * else. A `git branch` does not change content either — it creates a pointer
   * and a parenthood, and evolving the two sides apart is the ordinary proposal
   * flow, which needs no special case for a variant.
   *
   * Every check below runs BEFORE any write, and the refusals are ordered from
   * the route's own subject (the base) outwards to the body.
   */
  app.post<IdParam>('/graphs/:id/fork', async (request, reply) => {
    const base = getGraph(db, request.params.id);
    if (base === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: request.params.id };
    }

    if (base.linhagem_tipo !== 'base') {
      reply.code(400);
      return {
        erro: 'base_invalida',
        mensagem: 'only a base lineage can be forked; a variant of a variant is out (D13)',
        linhagem_tipo: base.linhagem_tipo,
      };
    }

    const body = isObject(request.body) ? request.body : {};

    // The id of the variant is said by the request, never derived: `classe` is
    // the identity of the BASE lineage (D8), and the variant shares the class.
    const id = body.id;
    if (typeof id !== 'string' || id.trim() === '') {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem: 'the fork requires "id": it is the identity of the lineage being born',
      };
    }

    if (getGraph(db, id) !== undefined) {
      reply.code(409);
      return {
        erro: 'id_ja_registrado',
        mensagem: `a lineage with the id "${id}" already exists`,
        id,
      };
    }

    // Existence only, at any status: the topographer does not know how to propose
    // a fork yet, so checking the content of the proposal would be checking a
    // shape nobody writes (out of scope).
    const rawOrigin = body.origem_proposta_id;
    let originProposalId: number | null = null;
    if (rawOrigin !== undefined && rawOrigin !== null) {
      if (typeof rawOrigin !== 'number' || !Number.isInteger(rawOrigin) || rawOrigin <= 0) {
        reply.code(400);
        return {
          erro: 'origem_proposta_id_invalido',
          mensagem: 'origem_proposta_id has to be a positive integer',
          origem_proposta_id: rawOrigin,
        };
      }
      if (getProposal(db, rawOrigin) === undefined) {
        reply.code(400);
        return {
          erro: 'origem_proposta_desconhecida',
          mensagem: 'origem_proposta_id references no proposal',
          origem_proposta_id: rawOrigin,
        };
      }
      originProposalId = rawOrigin;
    }

    // Defensive invariant: a lineage with no pointer is a graph that exists
    // without holding, which no code path here creates.
    const current =
      base.versao_corrente_id === null ? undefined : getVersion(db, base.versao_corrente_id);
    if (current === undefined) {
      reply.code(409);
      return {
        erro: 'grafo_sem_versao_corrente',
        mensagem: 'the base lineage does not point at a current version; there is nothing to fork from',
        id: base.id,
      };
    }

    const document: GraphDocument = {
      ...current.snapshot,
      linhagem: {
        tipo: 'variante',
        base_classe: base.classe,
        // Absent, not null: the same elision `base` already does with the two
        // fields the schema forbids it. The column is INTEGER and the document
        // field is a string (`schema/grafo.schema.json`) — hence the `String`.
        ...(originProposalId === null ? {} : { origem_proposta_id: String(originProposalId) }),
      },
    };

    // The hash IS the version's identity, and it is global, not scoped per
    // lineage: two forks of the same base with the same origin would produce the
    // same document, and one row cannot belong to two lineages at once.
    const versionId = hashSnapshot(document);
    if (getVersionSummary(db, versionId) !== undefined) {
      reply.code(409);
      return {
        erro: 'bifurcacao_sem_efeito',
        mensagem: 'this fork produces a snapshot that already exists; nothing would be recorded',
        versao_existente: versionId,
      };
    }

    const { graph, version } = forkVariant(db, {
      base,
      id,
      originProposalId,
      document,
      versionId,
    });
    reply.code(201);
    return { grafo: graph, grafo_versao: version };
  });

  /**
   * `POST /graphs/:id/promote` is D13's first pending direction: the diff of a
   * variant that beats the base becomes a promotion proposal FOR the base.
   *
   * It proposes and never applies. What comes out is an ordinary pending
   * proposal, judged at the same human gate as any other (README, princípio 5),
   * and applied by the same `POST /proposals/:id/apply` with no special case —
   * the diff never touches `classe`/`linhagem`, so the base stays the base.
   */
  app.post<IdParam>('/graphs/:id/promote', async (request, reply) => {
    const variant = getGraph(db, request.params.id);
    if (variant === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: request.params.id };
    }

    if (variant.linhagem_tipo !== 'variante') {
      reply.code(400);
      return {
        erro: 'variante_invalida',
        mensagem: 'only a variant has something to promote; a base does not promote to itself (D13)',
        linhagem_tipo: variant.linhagem_tipo,
      };
    }

    // D13: the variant shares the class of the base it was forked from, so the
    // class IS the pointer back to the base — there is no second column to read.
    const base = getClassBase(db, variant.classe);
    if (base === undefined) {
      reply.code(404);
      return {
        erro: 'grafo_desconhecido',
        mensagem: 'the class of this variant has no base lineage; there is nowhere to promote to',
        classe: variant.classe,
      };
    }

    const body = isObject(request.body) ? request.body : {};
    const missing = missingHypothesis(body);
    if (missing !== undefined) {
      reply.code(400);
      return missing;
    }

    return openProposal(db, reply, {
      target: base,
      source: variant,
      evidencia: body.evidencia,
      metrica_esperada: body.metrica_esperada,
    });
  });

  /**
   * `POST /graphs/:id/offer` is the other direction, and the asymmetry is the
   * whole point of D13: an improvement in the base is OFFERED to a variant,
   * never forced on it. The offer lands as a pending proposal ON the variant,
   * which is exactly what makes refusing it a no-op — nobody has to undo
   * anything.
   *
   * One named `variante_id` per call: fanning out to every variant of a base is
   * another decision, and it is not this route's to take silently.
   */
  app.post<IdParam>('/graphs/:id/offer', async (request, reply) => {
    const base = getGraph(db, request.params.id);
    if (base === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: request.params.id };
    }

    if (base.linhagem_tipo !== 'base') {
      reply.code(400);
      return {
        erro: 'base_invalida',
        mensagem: 'only a base lineage offers an improvement to its variants (D13)',
        linhagem_tipo: base.linhagem_tipo,
      };
    }

    const body = isObject(request.body) ? request.body : {};

    const variantId = body.variante_id;
    if (typeof variantId !== 'string' || variantId.trim() === '') {
      reply.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem: 'the offer requires "variante_id": it is the variant that receives the proposal, one per call',
      };
    }

    const variant = getGraph(db, variantId);
    if (variant === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: variantId };
    }

    if (variant.linhagem_tipo !== 'variante' || variant.base_classe !== base.classe) {
      reply.code(400);
      return {
        erro: 'variante_invalida',
        mensagem: `"${variantId}" is not a variant of this base lineage`,
        base_classe: variant.base_classe,
        classe: base.classe,
      };
    }

    const missing = missingHypothesis(body);
    if (missing !== undefined) {
      reply.code(400);
      return missing;
    }

    return openProposal(db, reply, {
      target: variant,
      source: base,
      evidencia: body.evidencia,
      metrica_esperada: body.metrica_esperada,
    });
  });

  app.get('/classes', async () => ({ classes: listClasses(db) }));

  app.get('/graphs', async () => ({ grafos: listGraphs(db) }));

  app.get<IdParam>('/graphs/:id', async (request, reply) => {
    const graph = getGraph(db, request.params.id);
    if (graph === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: request.params.id };
    }
    return { grafo: graph };
  });

  // The whole chain, including versions abandoned by a revert: it is the intact
  // history D15 promises, not only the path that survived.
  app.get<IdParam>('/graphs/:id/versions', async (request, reply) => {
    const graph = getGraph(db, request.params.id);
    if (graph === undefined) {
      reply.code(404);
      return { erro: 'grafo_desconhecido', id: request.params.id };
    }
    return { versoes: listVersions(db, graph.id) };
  });

  app.get<IdParam>('/graph-versions/:id', async (request, reply) => {
    const version = getVersion(db, request.params.id);
    if (version === undefined) {
      reply.code(404);
      return { erro: 'grafo_versao_desconhecida', id: request.params.id };
    }
    return { grafo_versao: version };
  });
}
