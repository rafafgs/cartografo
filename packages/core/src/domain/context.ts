/**
 * The `input` a node's skill reads, assembled from what the board already knows
 * (t253, FR6/FR7).
 *
 * This is step 2 of `especificacoes/formatos/manifesto-skill.md`'s renderization
 * pipeline — the one that until now did not exist. `render-skill-instructions.ts`
 * has interpolated `{{input.<path>}}` and failed closed on an unresolved
 * placeholder since t204; what it was never handed was a correctly shaped
 * `input`, because nothing carried a node's structured output. With
 * `session.output` stored (`repositories/session.ts`) this module is what turns
 * those rows into the object the next node's `input` schema declares.
 *
 * A pure module, with no `Database` and no clock, in the spirit of
 * `domain/graph.ts` and `domain/custom-fields.ts`: the merge is a structural
 * question over four pieces of data, and keeping it here is what lets a test ask
 * it without a server — including the awkward cases a live traversal would take
 * six sessions to reach.
 *
 * ## The rule, in one paragraph
 *
 * A node's structured output lands where the node's own `contract.produces`
 * says, and `produces` names a BUCKET rather than a box: two nodes declaring the
 * same name write into the same object, so `integrar`'s `merge_commit` lands
 * beside `desenvolver`'s `branch` and survives the `testar` gate, which produces
 * no artifact of its own. A node that declares nothing merges at the top level,
 * which is what both factory bundles did implicitly before the field existed —
 * and is why the field is additive and breaks no graph.
 *
 * ## The keys are the FORMAT's, not this package's
 *
 * `perguntas_respondidas` is spelled the way the twelve registered manifests
 * spell it, because it is their `input` schemas that declare it and their
 * `instructions` that interpolate it. Same for whatever the class writes inside
 * `project` and inside its own `custom_fields`: those are the class's
 * vocabulary, exactly as `domain/custom-fields.ts` says of the names it carries
 * through to a 400. The CODE around them is English (D18).
 */

import type { ScalarMap } from './custom-fields.ts';
import { isObject } from '../util/is-object.ts';

/**
 * One node of the snapshot, in the part this projection reads.
 *
 * `contract` is `unknown` and not a shape, deliberately: a snapshot is JSON
 * read back out of `graph_version`, frozen when it was written, and this module
 * reads it without vouching for it — the same posture `resolve-node.ts` takes
 * on the runner's side of the same document. What is looked for inside is
 * `produces`, the bucket name of `schema/grafo.schema.json`'s `$defs.contract`;
 * absent means "merge at the top level of `input`", which is what every graph
 * written before the field does and what `bets-assimetricas` still wants, node
 * for node.
 */
export interface ProjectedNode {
  id: string;
  contract?: unknown;
}

/** The frozen document, in the part this projection reads. */
export interface ProjectedSnapshot {
  nodes?: ProjectedNode[];
  /**
   * The class's static configuration, published at `input.project`.
   *
   * Optional in the document and never optional in the answer: a graph that
   * declares none projects `{}`, so a placeholder resolves to an honest empty
   * object instead of refusing the dispatch of a class that has no project
   * config yet. `unknown` for the reason `contract` above is.
   */
  project?: unknown;
}

/** The job's own identity, as the projection seeds it. */
export interface ProjectedJob {
  id: number;
  title: string;
  /** `null` when the job was born with a title and nothing else (t122). */
  body: string | null;
  /**
   * The job's type, when it carries one.
   *
   * Optional and absent-when-absent, deliberately: the `job` table has no such
   * column today, so nothing fills it and the key simply does not appear —
   * which is the behaviour every field nothing produces already has. Writing
   * `type: null` instead would hand a skill a key it would have to know to
   * ignore.
   */
  type?: string | null;
  /** The values of the fields the CLASS declares (t168); `null` when none. */
  fields: ScalarMap | null;
}

/** One completed session's structured report, as the projection reads it. */
export interface ProjectedOutput {
  /** The node that produced it; `null` for a session with no node. */
  node_id: string | null;
  /** What `/finish` stored; `null` when nothing structured was reported. */
  output: Record<string, unknown> | null;
  /** When the session closed — the ordering key of the walk. */
  finished_at: string | null;
  /** The session id, which breaks a tie between two identical instants. */
  session_id: number;
}

/**
 * One answered escalation, in the shape the manifests declare.
 *
 * `id` is a STRING because that is what `bets-assimetricas` requires of it
 * (`triar-tese`, `coletar-fundamentos`, `escalar-decisao` all pin
 * `{"type": "string", "minLength": 1}`), and the software bundle asks for no
 * `id` at all — so one shape serves both.
 */
export interface AnsweredRequest {
  id: string;
  pergunta: string;
  resposta: string;
}

/** Everything the projection is built out of. */
export interface ContextSources {
  job: ProjectedJob;
  /** The version's snapshot; `null` for a job with no graph behind it. */
  snapshot: ProjectedSnapshot | null;
  /** One entry per COMPLETED session of the job, in any order. */
  outputs: ProjectedOutput[];
  /** The answered escalations of the job, in the order they were answered. */
  answered: AnsweredRequest[];
}

/** The bucket a node's output goes into, or `null` for the top level. */
function bucketOf(snapshot: ProjectedSnapshot | null, nodeId: string | null): string | null {
  if (nodeId === null) return null;
  const node = snapshot?.nodes?.find((candidate) => candidate.id === nodeId);
  const contract = node?.contract;
  const declared = isObject(contract) ? contract.produces : undefined;
  return typeof declared === 'string' && declared !== '' ? declared : null;
}

/**
 * Orders two reports by when their sessions closed.
 *
 * `finished_at` first, because that is the order the traversal really happened
 * in; the session id breaks a tie, and an unfinished-looking `null` sorts last
 * rather than jumping the queue. Ordering matters because the last writer wins
 * on a key collision, and "last" has to mean "latest in the traversal" and not
 * "whatever the query returned".
 */
function byClosingTime(a: ProjectedOutput, b: ProjectedOutput): number {
  const left = a.finished_at ?? '';
  const right = b.finished_at ?? '';
  if (left !== right) return left < right ? -1 : 1;
  return a.session_id - b.session_id;
}

/**
 * Builds the `input` object for the node a job is standing on (FR7).
 *
 * The four steps, in this order, later ones winning on a key collision:
 *
 * 1. the job's own identity at `input.job`, and the job's `custom_fields`
 *    spread at the TOP level — beside `input.job`, never inside it. That is
 *    what keeps bets' scalar fields resolving with no bucket to declare;
 * 2. the snapshot's `project` object at `input.project`, `{}` when the class
 *    declares none;
 * 3. every completed session's `output`, in closing order, merged into the
 *    bucket its node's `contract.produces` names, or at the top level when it
 *    names none. Shallow: a bucket is a flat accumulation of what the nodes
 *    reported, and a deep merge would silently braid two nodes' nested objects
 *    into a third that neither of them declared;
 * 4. the answered escalations at `input.perguntas_respondidas`, always a list —
 *    an empty one is a legal answer ("no decision recorded yet") and every
 *    manifest that reads the key says so.
 *
 * `contexto_falha` is deliberately absent (FR8): deriving it means reading the
 * job's transition history as a loop-detection question, and it belongs to the
 * ticket that wires the runner and can exercise a rework loop end to end.
 *
 * @param sources The job, the snapshot, the completed reports and the answers.
 * @returns The `input` object, ready for `{{input.<path>}}` resolution.
 */
export function buildNodeInput(sources: ContextSources): Record<string, unknown> {
  const { job, snapshot, outputs, answered } = sources;

  const input: Record<string, unknown> = { ...(job.fields ?? {}) };

  input.job = {
    id: job.id,
    title: job.title,
    body: job.body,
    ...(job.type === undefined || job.type === null ? {} : { type: job.type }),
  };

  input.project = isObject(snapshot?.project) ? { ...snapshot.project } : {};

  for (const reported of [...outputs].sort(byClosingTime)) {
    if (!isObject(reported.output)) continue;

    const bucket = bucketOf(snapshot, reported.node_id);
    if (bucket === null) {
      Object.assign(input, reported.output);
      continue;
    }

    const existing = input[bucket];
    input[bucket] = { ...(isObject(existing) ? existing : {}), ...reported.output };
  }

  input.perguntas_respondidas = answered.map((request) => ({
    id: request.id,
    pergunta: request.pergunta,
    resposta: request.resposta,
  }));

  return input;
}
