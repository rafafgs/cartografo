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

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/connection.ts';
import { validateGraph, type GraphDocument } from '../domain/graph.ts';
import {
  getClassBase,
  getGraph,
  getVersion,
  listClasses,
  listGraphs,
  listVersions,
  registerBaseGraph,
} from '../repositories/graphs.ts';

interface IdParam {
  Params: { id: string };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
              mensagem: '"classe" precisa ser um texto preenchido: é a identidade da linhagem (D8)',
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
          'esta rota registra apenas grafo base; variante nasce de fork com proposta (D13, t118)',
        linhagem_tipo: lineage.tipo ?? null,
      };
    }

    if (getClassBase(db, className) !== undefined) {
      reply.code(409);
      return {
        erro: 'classe_ja_registrada',
        mensagem: `a classe "${className}" já tem um grafo base; versão nova sobre linhagem existente é fluxo de proposta`,
        classe: className,
      };
    }

    const { graph, version } = registerBaseGraph(db, document as GraphDocument);
    reply.code(201);
    return { grafo: graph, grafo_versao: version };
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
