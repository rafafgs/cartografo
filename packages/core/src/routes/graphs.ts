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
 * One function per route, and `registerGraphs` is the list of them (t210). This
 * was one function of 333 lines, which meant every graph ticket landed on the
 * same lines and conflicted with every other. The handlers below take `db` as
 * their first parameter instead of closing over it — that is the whole of what
 * the split cost, and no behaviour moved with it.
 *
 * No route here emits a telemetry event, and that is a real gap, not a
 * dependency: the append-only log (`src/db/events.ts`) shipped with t102, and
 * `evento.entidade_tipo` already accepts `grafo_versao`
 * (`migrations/0003_trabalho_sessao_evento_pergunta.sql`), so registering a
 * version could be logged today. Nobody owns that yet — no open ticket declares
 * it — so a graph version born here leaves no trace in the log, and whoever
 * replays the log will not find it. Whoever takes it should know the emission is
 * NOT a copy of what this file returns any more: since t226 the wire is English
 * and the `grafo_versao.*` event schemas are still Portuguese, until D20's
 * second child renames them.
 *
 * What the routes return is the output of `repositories/graphs.ts`'s
 * `toGraph`/`toGraphVersion`/`toClass`, never a row (t226, FR1). The comparisons
 * inside the handlers keep reading the ROW — `base.linhagem_tipo !== 'base'` —
 * because the database is untouched until D20's fourth child; only the boundary
 * translates.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { diffGraphs } from '../domain/diff.ts';
import { validateGraph, type GraphDocument, type StructureReport } from '../domain/graph.ts';
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
  toClass,
  toGraph,
  toGraphVersion,
  toGraphVersionWithSnapshot,
  type GraphRow,
} from '../repositories/graphs.ts';
import { createProposal, getProposal, toProposal } from '../repositories/proposals.ts';
import { isObject } from '../util/is-object.ts';
import { refusal } from './common.ts';

interface IdParam {
  Params: { id: string };
}

/**
 * Contract of `POST /graphs` in the public document (t171, FR4).
 *
 * The body stays `{type: 'object'}` and nothing more, on purpose: the header of
 * this file explains why no ajv schema is declared against
 * `schema/grafo.schema.json`, and pointing a draft-07 compiler at a draft
 * 2020-12 document would reopen exactly that. What goes in is "a JSON object";
 * whether it is a GRAPH is `validateGraph`'s judgement and stays so.
 *
 * The four statuses are the ones the handler already answers — `201` with the
 * lineage and its first version, `422` with the validator's report, `400` for a
 * lineage that is not base, `409` for a class already registered. Since t226 the
 * refusal body is the one envelope of `routes/common.ts`, so this is that
 * schema's shape and not a second one.
 *
 * Only `error` and `message` are typed, and only because every refusal below
 * builds them as string literals. The rest travels through
 * `additionalProperties: true`: a Fastify `response` schema serializes, so a
 * declared type is a COERCION — `lineage_type` echoes back whatever the body
 * carried, and typing it would turn a number into a string on the wire (FR6).
 */
const REFUSAL_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error'],
  additionalProperties: true,
} as const;

const REGISTER_GRAPH_SCHEMA = {
  body: { type: 'object', additionalProperties: true },
  response: {
    201: {
      type: 'object',
      properties: {
        graph: { type: 'object', additionalProperties: true },
        graph_version: { type: 'object', additionalProperties: true },
      },
      required: ['graph', 'graph_version'],
      additionalProperties: true,
    },
    400: REFUSAL_SCHEMA,
    409: REFUSAL_SCHEMA,
    422: REFUSAL_SCHEMA,
  },
} as const;

/**
 * Registers the graph routes in the given scope (which already carries the /v1 prefix).
 *
 * @param app Fastify scope.
 * @param db Already open database; the routes never open their own (D1).
 */
export function registerGraphs(app: FastifyInstance, db: Database): void {
  app.post('/graphs', { schema: REGISTER_GRAPH_SCHEMA }, (request, reply) =>
    create(db, request, reply),
  );

  app.post<IdParam>('/graphs/:id/fork', (request, reply) => fork(db, request, reply));
  app.post<IdParam>('/graphs/:id/promote', (request, reply) => promote(db, request, reply));
  app.post<IdParam>('/graphs/:id/offer', (request, reply) => offer(db, request, reply));

  app.get('/classes', () => readClasses(db));
  app.get('/graphs', () => readGraphs(db));
  app.get<IdParam>('/graphs/:id', (request, reply) => readGraph(db, request, reply));
  app.get<IdParam>('/graphs/:id/versions', (request, reply) => readVersions(db, request, reply));
  app.get<IdParam>('/graph-versions/:id', (request, reply) => readVersion(db, request, reply));
}

/** `POST /graphs` — a graph document becomes a lineage plus its first version. */
async function create(db: Database, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const document = request.body;

  const report = validateGraph(document);
  if (!report.valid) {
    reply.code(422);
    return { error: 'invalid_graph', ...report };
  }

  // The document passed the gate, so it is an object with the seven keys; all
  // that is left is making sure `problem_class` serves as identity (D8:
  // lineage id = class).
  const raw = document as Record<string, unknown>;
  const className = raw.problem_class;
  if (typeof className !== 'string' || className.trim() === '') {
    reply.code(422);
    const structure: StructureReport = {
      valid: false,
      errors: [
        {
          code: 'invalid_field',
          message: '"problem_class" has to be a filled text: it is the identity of the lineage (D8)',
          target: 'problem_class',
        },
      ],
    };
    return { error: 'invalid_graph', valid: false, structure, soundness: report.soundness };
  }

  const lineage = isObject(raw.lineage) ? raw.lineage : {};
  if (lineage.type !== 'base') {
    // `lineage.type` is the DOCUMENT's field (`schema/grafo.schema.json`), so
    // what it carries is echoed back untranslated — it is what the caller sent,
    // and a mapper here would report a value nobody wrote.
    return refusal(
      reply,
      400,
      'lineage_not_base',
      'this route registers only a base graph; a variant is born from POST /v1/graphs/:id/fork (D13)',
      { lineage_type: lineage.type ?? null },
    );
  }

  if (getClassBase(db, className) !== undefined) {
    return refusal(
      reply,
      409,
      'class_already_registered',
      `class "${className}" already has a base graph; a new version over an existing lineage is the proposal flow`,
      { class: className },
    );
  }

  const { graph, version } = registerBaseGraph(db, document as GraphDocument);
  reply.code(201);
  return { graph: toGraph(graph), graph_version: toGraphVersion(version) };
}

/**
 * `POST /graphs/:id/fork` is D13's branch semantics: the variant is born as the
 * base's current snapshot, byte for byte, with `lineage` swapped and nothing
 * else. A `git branch` does not change content either — it creates a pointer
 * and a parenthood, and evolving the two sides apart is the ordinary proposal
 * flow, which needs no special case for a variant.
 *
 * Every check below runs BEFORE any write, and the refusals are ordered from
 * the route's own subject (the base) outwards to the body.
 */
async function fork(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const base = getGraph(db, request.params.id);
  if (base === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: request.params.id });
  }

  if (base.linhagem_tipo !== 'base') {
    return refusal(
      reply,
      400,
      'invalid_base',
      'only a base lineage can be forked; a variant of a variant is out (D13)',
      { lineage_type: toGraph(base).lineage_type },
    );
  }

  const body = isObject(request.body) ? request.body : {};

  // The id of the variant is said by the request, never derived: `class` is
  // the identity of the BASE lineage (D8), and the variant shares the class.
  const id = body.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return refusal(
      reply,
      400,
      'missing_required_field',
      'the fork requires "id": it is the identity of the lineage being born',
    );
  }

  if (getGraph(db, id) !== undefined) {
    return refusal(reply, 409, 'id_already_registered', `a lineage with the id "${id}" already exists`, { id });
  }

  // Existence only, at any status: the topographer does not know how to propose
  // a fork yet, so checking the content of the proposal would be checking a
  // shape nobody writes (out of scope).
  const rawOrigin = body.origin_proposal_id;
  let originProposalId: number | null = null;
  if (rawOrigin !== undefined && rawOrigin !== null) {
    if (typeof rawOrigin !== 'number' || !Number.isInteger(rawOrigin) || rawOrigin <= 0) {
      return refusal(
        reply,
        400,
        'invalid_origin_proposal_id',
        'origin_proposal_id has to be a positive integer',
        { origin_proposal_id: rawOrigin },
      );
    }
    if (getProposal(db, rawOrigin) === undefined) {
      return refusal(
        reply,
        400,
        'unknown_origin_proposal',
        'origin_proposal_id references no proposal',
        { origin_proposal_id: rawOrigin },
      );
    }
    originProposalId = rawOrigin;
  }

  // Defensive invariant: a lineage with no pointer is a graph that exists
  // without holding, which no code path here creates.
  const source =
    base.versao_corrente_id === null ? undefined : getVersion(db, base.versao_corrente_id);
  if (source === undefined) {
    return refusal(
      reply,
      409,
      'graph_without_current_version',
      'the base lineage does not point at a current version; there is nothing to fork from',
      { id: base.id },
    );
  }

  const document: GraphDocument = {
    ...source.snapshot,
    lineage: {
      // The DOCUMENT's vocabulary, not the column's: `schema/grafo.schema.json`
      // says `variante`, and a format value is outside D20 (D18's carve-out).
      // `graph.lineage_type` says `variant` and is written by `forkVariant`.
      type: 'variante',
      base_class: base.classe,
      // Absent, not null: the same elision `base` already does with the two
      // fields the schema forbids it. The column is INTEGER and the document
      // field is a string (`schema/grafo.schema.json`) — hence the `String`.
      ...(originProposalId === null ? {} : { source_proposal_id: String(originProposalId) }),
    },
  };

  // The hash IS the version's identity, and it is global, not scoped per
  // lineage: two forks of the same base with the same origin would produce the
  // same document, and one row cannot belong to two lineages at once.
  const versionId = hashSnapshot(document);
  if (getVersionSummary(db, versionId) !== undefined) {
    return refusal(
      reply,
      409,
      'fork_without_effect',
      'this fork produces a snapshot that already exists; nothing would be recorded',
      { existing_version: versionId },
    );
  }

  const { graph, version } = forkVariant(db, {
    base,
    id,
    originProposalId,
    document,
    versionId,
  });
  reply.code(201);
  return { graph: toGraph(graph), graph_version: toGraphVersion(version) };
}

/**
 * `POST /graphs/:id/promote` is D13's first pending direction: the diff of a
 * variant that beats the base becomes a promotion proposal FOR the base.
 *
 * It proposes and never applies. What comes out is an ordinary pending
 * proposal, judged at the same human gate as any other (README, princípio 5),
 * and applied by the same `POST /proposals/:id/apply` with no special case —
 * the diff never touches `classe`/`linhagem`, so the base stays the base.
 */
async function promote(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const variant = getGraph(db, request.params.id);
  if (variant === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: request.params.id });
  }

  if (variant.linhagem_tipo !== 'variant') {
    return refusal(
      reply,
      400,
      'invalid_variant',
      'only a variant has something to promote; a base does not promote to itself (D13)',
      { lineage_type: toGraph(variant).lineage_type },
    );
  }

  // D13: the variant shares the class of the base it was forked from, so the
  // class IS the pointer back to the base — there is no second column to read.
  const base = getClassBase(db, variant.classe);
  if (base === undefined) {
    return refusal(
      reply,
      404,
      'unknown_graph',
      'the class of this variant has no base lineage; there is nowhere to promote to',
      { class: variant.classe },
    );
  }

  const body = isObject(request.body) ? request.body : {};
  if (missingHypothesis(body)) return missingHypothesisRefusal(reply);

  return openProposal(db, reply, {
    target: base,
    source: variant,
    evidence: body.evidence,
    expectedMetric: body.expected_metric,
  });
}

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
async function offer(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const base = getGraph(db, request.params.id);
  if (base === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: request.params.id });
  }

  if (base.linhagem_tipo !== 'base') {
    return refusal(
      reply,
      400,
      'invalid_base',
      'only a base lineage offers an improvement to its variants (D13)',
      { lineage_type: toGraph(base).lineage_type },
    );
  }

  const body = isObject(request.body) ? request.body : {};

  const variantId = body.variant_id;
  if (typeof variantId !== 'string' || variantId.trim() === '') {
    return refusal(
      reply,
      400,
      'missing_required_field',
      'the offer requires "variant_id": it is the variant that receives the proposal, one per call',
    );
  }

  const variant = getGraph(db, variantId);
  if (variant === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: variantId });
  }

  if (variant.linhagem_tipo !== 'variant' || variant.base_classe !== base.classe) {
    return refusal(
      reply,
      400,
      'invalid_variant',
      `"${variantId}" is not a variant of this base lineage`,
      { base_class: variant.base_classe, class: base.classe },
    );
  }

  if (missingHypothesis(body)) return missingHypothesisRefusal(reply);

  return openProposal(db, reply, {
    target: variant,
    source: base,
    evidence: body.evidence,
    expectedMetric: body.expected_metric,
  });
}

/** `GET /classes` — the class catalogue (D8). */
async function readClasses(db: Database): Promise<unknown> {
  const classes = listClasses(db);
  return { classes: classes.map(toClass) };
}

/** `GET /graphs` — every lineage, base and variant alike. */
async function readGraphs(db: Database): Promise<unknown> {
  const graphs = listGraphs(db);
  return { graphs: graphs.map(toGraph) };
}

/** `GET /graphs/:id` — one lineage. */
async function readGraph(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const graph = getGraph(db, request.params.id);
  if (graph === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: request.params.id });
  }
  return { graph: toGraph(graph) };
}

/**
 * `GET /graphs/:id/versions` — the whole chain, including versions abandoned by
 * a revert: it is the intact history D15 promises, not only the path that
 * survived.
 */
async function readVersions(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const graph = getGraph(db, request.params.id);
  if (graph === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { id: request.params.id });
  }
  const versions = listVersions(db, graph.id);
  return { versions: versions.map(toGraphVersion) };
}

/** `GET /graph-versions/:id` — one version, snapshot included. */
async function readVersion(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const version = getVersion(db, request.params.id);
  if (version === undefined) {
    return refusal(reply, 404, 'unknown_graph_version', undefined, { id: request.params.id });
  }
  return { graph_version: toGraphVersionWithSnapshot(version) };
}

/**
 * The refusal body when the hypothesis fields are missing, or `undefined`.
 *
 * Same demand and same shape as `POST /proposals` (`routes/proposals.ts`):
 * presence only, never the shape of what is inside. Promotion and offer are
 * proposals like any other, and validating them harder here than at the route
 * everyone already uses would be two different contracts for one table.
 */
function missingHypothesis(body: Record<string, unknown>): boolean {
  return body.evidence === undefined || body.expected_metric === undefined;
}

/** The refusal the two routes above share when the hypothesis is incomplete. */
function missingHypothesisRefusal(reply: FastifyReply): Record<string, unknown> {
  return refusal(
    reply,
    400,
    'missing_required_field',
    'a proposal is a hypothesis: evidence and expected_metric are required (D15, learning note)',
  );
}

/** The direction of a promotion or an offer, once the route knows which is which. */
interface Direction {
  /** Lineage that RECEIVES the pending proposal. */
  target: GraphRow;
  /** Lineage whose current snapshot the target would come to match. */
  source: GraphRow;
  evidence: unknown;
  expectedMetric: unknown;
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
    return refusal(
      reply,
      409,
      'graph_without_current_version',
      'both lineages have to point at a current version for there to be a diff',
      { graph_id: from === undefined ? target.id : source.id },
    );
  }

  const operations: Operation[] = diffGraphs(from, to);
  if (operations.length === 0) {
    return refusal(
      reply,
      422,
      'diff_without_effect',
      'the two snapshots already agree on "nodes" and "edges"; there is no diff to propose',
      { graph_id: target.id },
    );
  }

  const proposal = createProposal(db, {
    grafo_id: target.id,
    versao_alvo: target.versao_corrente_id as string,
    operacoes: operations,
    evidencia: data.evidence,
    metrica_esperada: data.expectedMetric,
  });

  reply.code(201);
  return { proposal: toProposal(proposal) };
}

/** The document that holds today for a lineage, or `undefined` if the pointer is empty. */
function current(db: Database, graph: GraphRow): GraphDocument | undefined {
  if (graph.versao_corrente_id === null) return undefined;
  return getVersion(db, graph.versao_corrente_id)?.snapshot;
}
