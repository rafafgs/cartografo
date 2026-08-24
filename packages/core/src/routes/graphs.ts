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
 * t200 CLOSED that question rather than leaving it open. Ajv v8 does ship a
 * 2020-12 compiler (`ajv/dist/2020.js`), but Fastify only reaches it by replacing
 * the whole app's `schemaController.compilersFactory`, which would put every
 * other route's body under a different validator — a blast radius out of all
 * proportion to documenting one endpoint, and one no route needs, since
 * `validateGraph` below already enforces the real contract. So the body stays
 * open and `POST /graphs` NAMES `schema/grafo.schema.json` in its own
 * `schema.description`, where a reader of the public document (not of this file)
 * finds it. Reopening it means enforcing the schema for real, which is a decision
 * with its own ticket and its own analysis of every other route.
 *
 * One function per route, and `registerGraphs` is the list of them (t210). This
 * was one function of 333 lines, which meant every graph ticket landed on the
 * same lines and conflicted with every other. The handlers below take `db` as
 * their first parameter instead of closing over it — that is the whole of what
 * the split cost, and no behaviour moved with it.
 *
 * No route here builds a telemetry event, and since t196 that is no longer a
 * gap: `POST /graphs` and `POST /graphs/:id/fork` write `graph_version.registered`
 * + `graph_version.applied` through `repositories/graphs.ts`, in the same
 * transaction as the row, which is where an event belongs — a route that
 * recorded it afterwards could record a fact whose write had been rolled back.
 * `/promote` and `/offer` emit nothing, and correctly so: they only open a
 * pending proposal, with no version written and no pointer moved.
 *
 * What the routes return is what `repositories/graphs.ts` returns, handed back
 * untouched (t226 FR1, t289). There used to be a `toGraph`/`toGraphVersion`/
 * `toClass` wrapper around every one of them, translating a Portuguese-spelled
 * row into the API's names; the row spells them that way itself now, so the
 * comparisons inside the handlers — `base.lineage_type !== 'base'` — and the
 * objects the handlers return read the same words.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/connection.ts';
import { diffGraphs } from '../domain/diff.ts';
import {
  classifyContracts,
  validateContracts,
  validateGraph,
  type ContractProblem,
  type ContractReport,
  type GraphDocument,
  type StructureReport,
} from '../domain/graph.ts';
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
  type Graph,
} from '../repositories/graphs.ts';
import { createProposal, getProposal } from '../repositories/proposals.ts';
import { getSkill } from '../repositories/skill.ts';
import { isObject } from '../util/is-object.ts';
import { ERROR_RESPONSE_SCHEMA, OPEN_OBJECT_SCHEMA, refusal } from './common.ts';

interface IdParam {
  Params: { id: string };
}

/**
 * A lineage's `:id` on the wire, for the six routes that take one.
 *
 * Declared a STRING, deliberately, the same call `routes/input-requests.ts`
 * makes: a path segment IS text, and any other type here would put Fastify's ajv
 * in front of handlers that answer their own `404` for an id nobody registered.
 * A graph id is a problem class (`nota-curta`) and a version id is a hash
 * (`sha256:…`), so there is nothing to coerce even in principle.
 */
const ID_PARAM_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
} as const;

/**
 * What `POST /graphs` accepts, said in prose because ajv cannot say it (t200, FR3).
 *
 * The file header explains the whole decision; this is the half of it a client
 * reads. The description travels into the public document as the operation's own
 * `description`, which is the only place a consumer who never opens this
 * repository would look.
 */
const GRAPH_DOCUMENT_DESCRIPTION =
  'The body is the pure graph document, with no envelope — the same `grafo.json` of the factory bundle. ' +
  'Its real contract is `schema/grafo.schema.json` (`$id: urn:cartografo:schema:grafo:1.0.0`), which a client has to read separately: ' +
  'that schema is JSON Schema draft 2020-12 and the validator wired into this API compiles draft-07, so the body is declared here as a plain object and judged by the server\'s own structure/soundness gate instead.';

/**
 * Contract of `POST /graphs` in the public document (t171, FR4; t200, FR2/FR3).
 *
 * The body stays `{type: 'object'}` and nothing more, on purpose — see the file
 * header, and `GRAPH_DOCUMENT_DESCRIPTION` for what a client is told instead.
 * What goes in is "a JSON object"; whether it is a GRAPH is `validateGraph`'s
 * judgement and stays so.
 *
 * The four statuses are the ones the handler already answers — `201` with the
 * lineage and its first version, `422` with the validator's report, `400` for a
 * lineage that is not base, `409` for a class already registered. Since t226 the
 * refusal body is the one envelope of `routes/common.ts`, and since t200 this
 * file no longer keeps a second copy of that envelope's schema: the local
 * `REFUSAL_SCHEMA` was `ERROR_RESPONSE_SCHEMA` minus `details`, which is one
 * shape too many for one wire contract.
 *
 * The `201` keeps naming its properties, and all of them are open objects: a
 * Fastify `response` schema serializes, so a declared type is a COERCION —
 * `lineage_type` echoes back whatever the body carried, and typing it would turn
 * a number into a string on the wire (FR6). `contracts` is the third gate's
 * outcome (t284) and is named here for the same reason the other two are: a
 * property a client is meant to read belongs in the public document, even when
 * the schema says nothing about its shape.
 */
const REGISTER_GRAPH_SCHEMA = {
  description: GRAPH_DOCUMENT_DESCRIPTION,
  body: OPEN_OBJECT_SCHEMA,
  response: {
    201: {
      type: 'object',
      properties: {
        graph: OPEN_OBJECT_SCHEMA,
        graph_version: OPEN_OBJECT_SCHEMA,
        contracts: OPEN_OBJECT_SCHEMA,
      },
      required: ['graph', 'graph_version'],
      additionalProperties: true,
    },
    400: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
    422: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/**
 * `POST /graphs/:id/fork` — D13's branch, and the statuses it already answers.
 *
 * No `422`: forking judges the base and the body, never a document's soundness —
 * the snapshot it copies passed the gate when it was registered.
 */
const FORK_GRAPH_SCHEMA = {
  params: ID_PARAM_SCHEMA,
  body: OPEN_OBJECT_SCHEMA,
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/**
 * `POST /graphs/:id/promote` and `POST /graphs/:id/offer`, which answer the same
 * five statuses because they share `openProposal` — the `422` is its empty diff.
 *
 * One constant for both: the two directions of D13 are one contract read from
 * either end, and giving them separate schemas would let them drift apart on
 * paper while the handler kept them together.
 */
const OPEN_PROPOSAL_SCHEMA = {
  params: ID_PARAM_SCHEMA,
  body: OPEN_OBJECT_SCHEMA,
  response: {
    201: OPEN_OBJECT_SCHEMA,
    400: ERROR_RESPONSE_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
    409: ERROR_RESPONSE_SCHEMA,
    422: ERROR_RESPONSE_SCHEMA,
  },
} as const;

/** The two listings, which take nothing and cannot refuse. */
const LIST_SCHEMA = {
  response: { 200: OPEN_OBJECT_SCHEMA },
} as const;

/** The three reads by id: the row, or the `404` that says there is none. */
const READ_BY_ID_SCHEMA = {
  params: ID_PARAM_SCHEMA,
  response: {
    200: OPEN_OBJECT_SCHEMA,
    404: ERROR_RESPONSE_SCHEMA,
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

  app.post<IdParam>('/graphs/:id/fork', { schema: FORK_GRAPH_SCHEMA }, (request, reply) =>
    fork(db, request, reply),
  );
  app.post<IdParam>('/graphs/:id/promote', { schema: OPEN_PROPOSAL_SCHEMA }, (request, reply) =>
    promote(db, request, reply),
  );
  app.post<IdParam>('/graphs/:id/offer', { schema: OPEN_PROPOSAL_SCHEMA }, (request, reply) =>
    offer(db, request, reply),
  );

  app.get('/classes', { schema: LIST_SCHEMA }, () => readClasses(db));
  app.get('/graphs', { schema: LIST_SCHEMA }, () => readGraphs(db));
  app.get<IdParam>('/graphs/:id', { schema: READ_BY_ID_SCHEMA }, (request, reply) =>
    readGraph(db, request, reply),
  );
  app.get<IdParam>('/graphs/:id/versions', { schema: READ_BY_ID_SCHEMA }, (request, reply) =>
    readVersions(db, request, reply),
  );
  app.get<IdParam>('/graph-versions/:id', { schema: READ_BY_ID_SCHEMA }, (request, reply) =>
    readVersion(db, request, reply),
  );
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

  // The third gate (t278): every required input of every node's PINNED SKILL has
  // to have a producer on every path into that node. It runs here — after the
  // document is known to be a sound base graph, before anything is written —
  // because it is the one check that needs the REGISTRY: the contract a session
  // is held to is the skill's, resolved by `(id, version)` off the pin, the same
  // read `repositories/session.ts` does when a report comes back.
  const contracts = validateContracts(document, (ref) => {
    const skill = getSkill(db, ref.id, { version: ref.version });
    return skill === null ? undefined : { input: skill.input, output: skill.output };
  });

  // A pin this registry cannot resolve does not refuse the document, and the
  // reason is what this route IS: `POST /v1/graphs` takes a raw document, and
  // a graph whose skills are registered afterwards is the ordinary case — the
  // screen's editor, a forked example, every fixture in `schema/exemplos`. The
  // path that gets the whole judgement is `cartografo import`, which registers
  // every manifest of the bundle BEFORE sending the graph (`cli/import.ts`), and
  // which also runs this very check offline against the bundle's own `skills/`.
  //
  // It is skipped rather than downgraded: with one ancestor unresolved, the
  // availability of everything downstream of it is unknown, and reporting those
  // keys as unproduced would accuse a node of a defect whose evidence is only
  // that the registry has not been filled yet. So the check runs when it can be
  // performed — every pin resolved — and stands aside when it cannot.
  //
  // Standing aside is SAID and no longer silent (t284): `contractsOutcome` turns
  // the report into what the answer publishes, on the refusal and on the success
  // alike, so a client reads which of the two happened instead of inferring a
  // clean pass from a missing key.
  //
  // And since t283 it is REMEMBERED as well as said: the classified state goes
  // onto the row, `POST /v1/jobs` refuses to run anything against a version that
  // is not `checked`, and registering the missing manifest re-runs the check and
  // moves the version on its own. Permissive here, strict at execution — which
  // is where the promise that a contract is checked and not merely declared has
  // to hold (D9).
  const outcome = contractsOutcome(contracts);
  const state = classifyContracts(contracts);
  if (state === 'failed') {
    reply.code(422);
    // The same envelope as the structure/soundness refusal, with the two of them
    // marked as what they are — they passed — so a reader of the 422 can tell
    // which gate refused without diffing three reports.
    return {
      error: 'invalid_graph',
      valid: false,
      structure: report.structure,
      soundness: report.soundness,
      contracts: outcome,
    };
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

  // Stored, not merely reported (t283). `state` is `checked` or `unchecked`
  // here — `failed` returned above — and it is what `POST /v1/jobs` reads
  // before letting anything run against this version. A version is never
  // WRITTEN `failed` from this route: that state is only ever reached later, by
  // a re-check that finally had every manifest to judge with.
  const { graph, version } = registerBaseGraph(db, document as GraphDocument, {
    state,
    problems: contracts.problems,
  });
  reply.code(201);
  // The report rides on the SUCCESS too (t284). A skip that says nothing is
  // indistinguishable from a clean pass on the wire, and the two mean opposite
  // things to whoever reads the 201: one graph is known to hold together, the
  // other has simply not been judged yet.
  return {
    graph,
    graph_version: version,
    contracts: outcome,
  };
}

/**
 * The third gate's outcome as `POST /graphs` publishes it (t284).
 *
 * Two shapes, because two things can happen and they are not degrees of one
 * another. `checked` carries the report `validateContracts` produced, verdict
 * included. `skipped` carries no verdict at all: the check did not run, and a
 * `valid` here — either value — would be read as one, which is the whole defect
 * this shape exists to close.
 *
 * `problems` is on both, and on the skipped one it is ONLY the unresolved pins:
 * see {@link contractsOutcome} for why the rest of that report is dropped.
 */
type ContractsOutcome =
  | ({ status: 'checked' } & ContractReport)
  | {
      status: 'skipped';
      reason: 'skill_ref_unresolved';
      problems: ContractProblem[];
    };

/**
 * Says which of the two happened, and what a client is allowed to read from it.
 *
 * A pin the registry cannot resolve does not refuse the document — see the
 * comment at the call site for why that is what this route IS — but until t284
 * it did not say so either: the `201` was `{graph, graph_version}` whether every
 * contract had been checked and passed or none of them had been read at all. Two
 * opposite facts, one body.
 *
 * The skipped outcome publishes the unresolved pins and DROPS every
 * `unproduced_input` computed in the same pass. Those findings were computed
 * with an unresolved ancestor producing nothing, so a required key of a
 * descendant looks unsupplied whether or not the missing manifest supplies it —
 * publishing them would accuse a node of a defect whose only evidence is that
 * the registry has not been filled yet. What survives is the fact that IS known:
 * these pins resolve to nothing here.
 *
 * @param report What `validateContracts` answered over the registry.
 * @returns The outcome, ready to serialize on the `201` or inside the `422`.
 */
function contractsOutcome(report: ContractReport): ContractsOutcome {
  // The predicate is `classifyContracts` and no longer an inline filter (t283):
  // this route, the fork and the proposal apply all have to agree on what "the
  // check could not run" means, and three copies of one `some()` is how they
  // would stop agreeing.
  if (classifyContracts(report) !== 'unchecked') return { status: 'checked', ...report };
  return {
    status: 'skipped',
    reason: 'skill_ref_unresolved',
    problems: report.problems.filter((problem) => problem.code === 'skill_ref_unresolved'),
  };
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

  if (base.lineage_type !== 'base') {
    return refusal(
      reply,
      400,
      'invalid_base',
      'only a base lineage can be forked; a variant of a variant is out (D13)',
      { lineage_type: base.lineage_type },
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
    base.current_version_id === null ? undefined : getVersion(db, base.current_version_id);
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
      base_class: base.class,
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
    // Copied off the row this route already fetched, with no registry call
    // (t283): the forked document IS the base's snapshot with `lineage` swapped,
    // and `validateContracts` never reads `lineage`. Recomputing here would ask
    // the registry a question whose input did not change.
    contracts: source.contracts,
  });
  reply.code(201);
  return { graph, graph_version: version };
}

/**
 * `POST /graphs/:id/promote` is D13's first pending direction: the diff of a
 * variant that beats the base becomes a promotion proposal FOR the base.
 *
 * It proposes and never applies. What comes out is an ordinary pending
 * proposal, judged at the same human gate as any other (README, princípio 5),
 * and applied by the same `POST /proposals/:id/apply` with no special case —
 * the diff never touches `class`/`lineage_type`, so the base stays the base.
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

  if (variant.lineage_type !== 'variant') {
    return refusal(
      reply,
      400,
      'invalid_variant',
      'only a variant has something to promote; a base does not promote to itself (D13)',
      { lineage_type: variant.lineage_type },
    );
  }

  // D13: the variant shares the class of the base it was forked from, so the
  // class IS the pointer back to the base — there is no second column to read.
  const base = getClassBase(db, variant.class);
  if (base === undefined) {
    return refusal(
      reply,
      404,
      'unknown_graph',
      'the class of this variant has no base lineage; there is nowhere to promote to',
      { class: variant.class },
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

  if (base.lineage_type !== 'base') {
    return refusal(
      reply,
      400,
      'invalid_base',
      'only a base lineage offers an improvement to its variants (D13)',
      { lineage_type: base.lineage_type },
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

  if (variant.lineage_type !== 'variant' || variant.base_class !== base.class) {
    return refusal(
      reply,
      400,
      'invalid_variant',
      `"${variantId}" is not a variant of this base lineage`,
      { base_class: variant.base_class, class: base.class },
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
  return { classes: listClasses(db) };
}

/** `GET /graphs` — every lineage, base and variant alike. */
async function readGraphs(db: Database): Promise<unknown> {
  return { graphs: listGraphs(db) };
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
  return { graph };
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
  return { versions: listVersions(db, graph.id) };
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
  return { graph_version: version };
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
  target: Graph;
  /** Lineage whose current snapshot the target would come to match. */
  source: Graph;
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
    graph_id: target.id,
    target_version: target.current_version_id as string,
    operations,
    evidence: data.evidence,
    expected_metric: data.expectedMetric,
  });

  reply.code(201);
  return { proposal };
}

/** The document that holds today for a lineage, or `undefined` if the pointer is empty. */
function current(db: Database, graph: Graph): GraphDocument | undefined {
  if (graph.current_version_id === null) return undefined;
  return getVersion(db, graph.current_version_id)?.snapshot;
}
