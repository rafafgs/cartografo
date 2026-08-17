/**
 * Proposal routes (t101, FR7/FR8/FR9).
 *
 * `POST /proposals/:id/apply` is the whole D15 flow in one handler: apply ops →
 * validate soundness on the RESULT → write the new version → move the pointer.
 * The order is not negotiable: the gate runs over the document that would come
 * out, not over the one that went in, because it is the composition of the
 * operations that breaks the graph — each of them in isolation can be flawless.
 *
 * A rejection does not erase the proposal: it becomes `rejected` with the report
 * in `result`. A failed hypothesis is evidence for the topographer (t110),
 * not rubbish.
 *
 * Concurrency between proposals is out of scope (t118): if the base moved under
 * the proposal, it is refused with a 409 instead of being rebased automatically.
 *
 * One function per route, and `registerProposals` is the list of them (t210).
 * This was one function of 377 lines, which meant every proposal ticket landed
 * on the same lines and conflicted with every other. The handlers below take
 * `db` as their first parameter instead of closing over it — that is the whole
 * of what the split cost, and no behaviour moved with it.
 *
 * What the routes return is the output of `repositories/proposals.ts`'s
 * `toProposal`, never a row (t226, FR1); the comparisons inside the handlers keep
 * reading the ROW (`proposal.status !== 'pendente'`), because the column is
 * untouched until D20's fourth child.
 *
 * ONE flow here stays Portuguese on the way in, and it is deliberate:
 * `POST /proposals/:id/outcome` takes `{execucao_id, depois}` and
 * `GET /proposals?veredito=` filters on the Portuguese verdict. Both are the
 * hypothesis vocabulary of `domain/hypothesis.ts` — `{nome, direcao, de, para}`
 * and `{veredito, antes, depois, …}` — which that file documents as a frozen
 * data format D18 left out of the English rule, which the glossary maps nowhere,
 * and which D20's list of what it unfreezes does not mention. t226 translates
 * the KEYS that carry those blobs (`evidence`, `expected_metric`, `result`) and
 * not one byte of what is inside them (FR5). Whoever renames them does it on
 * purpose, in a ticket that says so.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

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
import { getGraph, getVersion, toGraph, toGraphVersion } from '../repositories/graphs.ts';
import { metricsByVersion } from '../repositories/job.ts';
import {
  applyProposal,
  approveProposal,
  getProposal,
  createProposal,
  listProposals,
  proposalStatusColumn,
  recordVerdict,
  rejectProposal,
  rejectProposalByHuman,
  revertProposal,
  toProposal,
  type ProposalRow,
} from '../repositories/proposals.ts';
import { isObject } from '../util/is-object.ts';
import { refusal } from './common.ts';

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
  app.post('/proposals', (request, reply) => create(db, request, reply));

  /* ------------------------------------------------------------------------ */
  /* t165 — the human gate. The tela has offered `Aprovar`/`Rejeitar` since     */
  /* t111 against routes that did not exist; these are them.                    */
  /* ------------------------------------------------------------------------ */

  app.post<IdParam>('/proposals/:id/approve', (request, reply) => approve(db, request, reply));
  app.post<IdParam>('/proposals/:id/reject', (request, reply) => reject(db, request, reply));
  app.post<IdParam>('/proposals/:id/apply', (request, reply) => apply(db, request, reply));
  app.post<IdParam>('/proposals/:id/revert', (request, reply) => revert(db, request, reply));

  /* ------------------------------------------------------------------------ */
  /* t112 — the next run closes the proposal. Route segments are code and were  */
  /* renamed to English with the rest of the surface (t127, FR3); the payload   */
  /* keys of THIS one stay Portuguese, because they are the frozen hypothesis   */
  /* vocabulary the file header explains (t226, FR5).                           */
  /* ------------------------------------------------------------------------ */

  app.post<IdParam>('/proposals/:id/outcome', (request, reply) => outcome(db, request, reply));

  app.get('/proposals', (request) => list(db, request));
  app.get<IdParam>('/proposals/:id', (request, reply) => read(db, request, reply));
}

/** `POST /proposals` — opens a hypothesis over a version that exists. */
async function create(db: Database, request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const body = isObject(request.body) ? request.body : {};

  const graphId = body.graph_id;
  if (typeof graphId !== 'string' || getGraph(db, graphId) === undefined) {
    return refusal(reply, 400, 'unknown_graph', undefined, { graph_id: graphId ?? null });
  }

  const targetVersion = body.target_version;
  const version = typeof targetVersion === 'string' ? getVersion(db, targetVersion) : undefined;
  if (version === undefined || version.grafo_id !== graphId) {
    return refusal(
      reply,
      400,
      'unknown_target_version',
      'target_version has to exist and belong to graph_id',
      { target_version: targetVersion ?? null },
    );
  }

  if (body.evidence === undefined || body.expected_metric === undefined) {
    return refusal(
      reply,
      400,
      'missing_required_field',
      'a proposal is a hypothesis: evidence and expected_metric are required (D15, learning note)',
    );
  }

  const rawOperations = body.operations;
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
    return refusal(reply, 400, 'invalid_operations', 'operations has to be a non-empty list');
  }

  // The report's own vocabulary is English since D20's third child (t228). What
  // stays is `indice`: it is this route's index into the list it received, not a
  // §3 term, and the glossary has no row for it.
  const problems = rawOperations
    .map((operation, indice) => ({ indice, ...validateOperation(operation) }))
    .filter((report) => !report.valid)
    .map((report) => ({ indice: report.indice, errors: report.errors }));
  if (problems.length > 0) {
    return refusal(reply, 400, 'invalid_operations', undefined, { operations: problems });
  }

  const proposal = createProposal(db, {
    grafo_id: graphId,
    versao_alvo: targetVersion as string,
    operacoes: rawOperations as Operation[],
    evidencia: body.evidence,
    metrica_esperada: body.expected_metric,
  });

  reply.code(201);
  return { proposal: toProposal(proposal) };
}

/**
 * `POST /proposals/:id/approve` — the human gate says yes.
 *
 * Approving writes the decision and stops there. Applying is a second,
 * deliberate act — the safety ladder of princípio 5 is that separation, and
 * collapsing the two here would be undoing it in the name of one click less.
 */
async function approve(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }

  if (proposal.status !== 'pendente') {
    return notPending(reply, proposal, 'approved');
  }

  return { proposal: toProposal(approveProposal(db, proposal.id)) };
}

/** `POST /proposals/:id/reject` — the human gate says no, and says why. */
async function reject(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }

  // Reason before status, like `revert`: a rejected proposal is negative
  // knowledge for the topographer, and "no" with no reason is the half of the
  // fact nobody can learn from.
  const body = isObject(request.body) ? request.body : {};
  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return refusal(
      reply,
      400,
      'reason_required',
      'rejecting requires a reason: a rejected proposal is negative knowledge for the surveyor, and without the why it is not',
    );
  }

  if (proposal.status !== 'pendente') {
    return notPending(reply, proposal, 'rejected');
  }

  return { proposal: toProposal(rejectProposalByHuman(db, proposal.id, reason.trim())) };
}

/** `POST /proposals/:id/apply` — the D15 flow: apply ops, gate, write, move. */
async function apply(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }

  // `aprovada`, not `pendente` (t165): a change to the graph passes a human
  // gate, and a proposal that skipped it has to fail loudly. The code is its
  // own — `proposal_not_pending` now describes approve/reject's precondition,
  // and reusing it here would say the wrong thing about which step is missing.
  if (proposal.status !== 'aprovada') {
    return refusal(
      reply,
      409,
      'proposal_not_approved',
      `only an approved proposal can be applied; this one is "${wireStatus(proposal)}"`,
      { status: wireStatus(proposal) },
    );
  }

  const graph = getGraph(db, proposal.grafo_id);
  if (graph === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { graph_id: proposal.grafo_id });
  }

  if (graph.versao_corrente_id !== proposal.versao_alvo) {
    return refusal(
      reply,
      409,
      'stale_proposal',
      'the base moved since the proposal was written; redoing the diff is up to the surveyor',
      { target_version: proposal.versao_alvo, current_version: graph.versao_corrente_id },
    );
  }

  const target = getVersion(db, proposal.versao_alvo);
  if (target === undefined) {
    return refusal(reply, 404, 'unknown_graph_version', undefined, { id: proposal.versao_alvo });
  }

  let document;
  try {
    document = applyOperations(target.snapshot, proposal.operacoes);
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    // `code`/`target` come off `ApplicationError`, which already spells them in
    // English; what is stored in `resultado` is this same object, because the
    // column holds an opaque JSON blob and D20 gives its NAME — not its
    // content — to the database child.
    const report = {
      error: 'inapplicable_operation',
      code: error.code,
      message: error.message,
      target: error.target,
    };
    reply.code(422);
    return { ...report, proposal: toProposal(rejectProposal(db, proposal.id, report)) };
  }

  // The gate: soundness runs BEFORE any write, over the document that would
  // come out. If it fails, nothing enters the database beyond the status and
  // the report.
  const report = validateGraph(document);
  if (!report.valido) {
    reply.code(422);
    // The validator's report keeps its Portuguese keys: it is D20's fifth child
    // (routes, flags and report), even riding inside a `/v1` 422.
    return {
      error: 'invalid_graph',
      ...report,
      proposal: toProposal(rejectProposal(db, proposal.id, report)),
    };
  }

  const versionId = hashSnapshot(document);
  if (getVersion(db, versionId) !== undefined) {
    // The hash IS the version's identity: a result identical to an already
    // known version is not a new version, it is a proposal with no effect.
    const noEffect = {
      error: 'version_without_effect',
      message: 'the operations produce a snapshot that already exists in the lineage',
      existing_version: versionId,
    };
    reply.code(422);
    return { ...noEffect, proposal: toProposal(rejectProposal(db, proposal.id, noEffect)) };
  }

  const written = applyProposal(db, { proposal, versionId, document });
  const graphAfter = getGraph(db, proposal.grafo_id);
  return {
    proposal: toProposal(written.proposal),
    graph: graphAfter === undefined ? undefined : toGraph(graphAfter),
    graph_version: toGraphVersion(written.version),
  };
}

/** `POST /proposals/:id/revert` — moves the pointer back, and records why. */
async function revert(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }

  // Reason before status: it is the field the `grafo_versao.revertida` event
  // demands, and it is the evidence the topographer will cross with the
  // telemetry of the abandoned version. Reverting without saying why loses the
  // useful half of the fact.
  const body = isObject(request.body) ? request.body : {};
  const reason = body.reason;
  if (typeof reason !== 'string' || reason.trim() === '') {
    return refusal(
      reply,
      400,
      'reason_required',
      'reverting requires a reason: it is the evidence crossed with the telemetry of the abandoned version',
    );
  }

  if (proposal.status !== 'aplicada') {
    return refusal(
      reply,
      409,
      'proposal_not_applied',
      `only an applied proposal can be reverted; this one is "${wireStatus(proposal)}"`,
      { status: wireStatus(proposal) },
    );
  }

  const graph = getGraph(db, proposal.grafo_id);
  if (graph === undefined) {
    return refusal(reply, 404, 'unknown_graph', undefined, { graph_id: proposal.grafo_id });
  }

  // Reverting is the exact counterpart of this proposal. If another version
  // came on top, the pointer would skip intermediate versions — free history
  // navigation is another thing, and it is out of this ticket.
  if (graph.versao_corrente_id !== proposal.versao_aplicada_id) {
    return refusal(
      reply,
      409,
      'stale_proposal',
      'the version this proposal applied is no longer the current one',
      {
        applied_version_id: proposal.versao_aplicada_id,
        current_version: graph.versao_corrente_id,
      },
    );
  }

  const reverted = revertProposal(db, { proposal, reason });
  const graphAfter = getGraph(db, proposal.grafo_id);
  return {
    proposal: toProposal(reverted),
    graph: graphAfter === undefined ? undefined : toGraph(graphAfter),
  };
}

/** `POST /proposals/:id/outcome` — the next execution closes the experiment. */
async function outcome(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }

  // `execucao_id` and `depois` are the frozen hypothesis vocabulary (FR5): this
  // body is the other half of the `{veredito, antes, depois, execucao_id,
  // avaliado_em}` shape `domain/hypothesis.ts` owns, and t226 renames neither
  // side of it. The refusals below still speak the one envelope, and the ones
  // that echo a field of THIS body echo the name it was sent under.
  const body = isObject(request.body) ? request.body : {};
  const executionId = body.execucao_id;
  const after = body.depois;
  if (!Number.isInteger(executionId) || !Number.isFinite(after)) {
    return refusal(
      reply,
      400,
      'missing_required_field',
      'closing the experiment requires execucao_id (an integer) and depois (a number): whoever computes the metric is whoever calls',
    );
  }

  if (proposal.status !== 'aplicada') {
    return refusal(
      reply,
      409,
      'proposal_not_applied',
      `only an applied proposal has an experiment to close; this one is "${wireStatus(proposal)}"`,
      { status: wireStatus(proposal) },
    );
  }

  // Only the first call counts. Re-evaluating would be rewriting a hypothesis'
  // past, and the column holds ONE result, the one of the first next round.
  if (proposal.resultado !== null) {
    return refusal(
      reply,
      409,
      'proposal_already_reviewed',
      'the outcome of this hypothesis was already recorded by the first next execution',
      { result: proposal.resultado },
    );
  }

  const metric = proposal.metrica_esperada;
  if (!isExpectedMetric(metric)) {
    // Creation never validated this shape (out of scope here): an applied
    // proposal may perfectly well carry a metric nobody can read. Computing a
    // verdict over incomplete data is worse than not computing one.
    return refusal(
      reply,
      422,
      'invalid_expected_metric',
      'expected_metric has to have the shape {nome, direcao: "sobe"|"cai", de, para} for there to be a verdict',
      { details: validateExpectedMetric(metric).map((problem) => problem.message) },
    );
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
    return refusal(
      reply,
      422,
      'execution_without_evidence',
      'no work item of this execution ran under the version the proposal applied',
      // `execucao_id` echoes the field this body was sent under (FR5), so it is
      // the one context key here that is not English.
      { execucao_id: executionId, applied_version_id: appliedVersion },
    );
  }

  const written = recordVerdict(db, {
    proposal,
    executionId: executionId as number,
    after: after as number,
    verdict: verdictFor(metric, after as number),
    before: metric.de,
  });

  // The status stays `applied` on purpose: "piorou" is data, not an action.
  // Reverting is a human decision, through the revert route (README, princípio 5).
  return { proposal: toProposal(written) };
}

/** `GET /proposals` — the listing, with its two optional filters. */
async function list(db: Database, request: FastifyRequest): Promise<unknown> {
  const filter = request.query as { status?: string; veredito?: string };
  // `?status=` speaks the wire's five values and is translated back to the
  // column's; `?veredito=` is the frozen hypothesis vocabulary and is not (FR5).
  // A status nobody publishes matches nothing rather than everything: passing it
  // through unmapped would silently widen the query.
  const status = optionalFilter(filter.status);
  const proposals = listProposals(db, {
    status: status === undefined ? undefined : (proposalStatusColumn(status) ?? status),
    veredito: optionalFilter(filter.veredito),
  });
  return { proposals: proposals.map(toProposal) };
}

/**
 * `GET /proposals/:id` — the detail read.
 *
 * The one the tela has assumed since t111
 * (`docs/spec/tela-inbox-propostas.md` §2) and that closing the gate finally
 * needed: whoever is about to approve reads ONE proposal, and the script that
 * closes the experiment reads the `metrica_esperada` of ONE proposal (t165,
 * FR5/FR9). Same row the listing returns, `motivo_rejeicao` included.
 */
async function read(
  db: Database,
  request: FastifyRequest<IdParam>,
  reply: FastifyReply,
): Promise<unknown> {
  const proposal = load(db, request.params.id);
  if (proposal === undefined) {
    return refusal(reply, 404, 'unknown_proposal', undefined, { id: request.params.id });
  }
  return { proposal: toProposal(proposal) };
}

/** The proposal's status as the wire spells it — never the column's value. */
function wireStatus(proposal: ProposalRow): string {
  return toProposal(proposal).status;
}

/**
 * The 409 that approve and reject share: this proposal already left `pending`.
 *
 * @param reply Fastify reply, marked 409.
 * @param proposal The proposal, still in its row form.
 * @param verb What could not be done to it, in the past participle.
 * @returns The refusal body.
 */
function notPending(
  reply: FastifyReply,
  proposal: ProposalRow,
  verb: string,
): Record<string, unknown> {
  return refusal(
    reply,
    409,
    'proposal_not_pending',
    `only a pending proposal can be ${verb}; this one is "${wireStatus(proposal)}"`,
    { status: wireStatus(proposal) },
  );
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
