/**
 * The surveyor's proposal: evidence built by us, operations chosen by one
 * session, nothing applied (t110, FR5–FR9).
 *
 * This is D16's next milestone — "beating the flowpilot is the next mark (the
 * surveyor's first proposal with evidence)" — assembled out of machinery that
 * already existed and had no caller. `POST /v1/proposals` has always
 * validated the semantic diff, demanded `evidencia` and `metrica_esperada`, and
 * landed the row as `pendente`; what was missing was somebody with something to
 * say.
 *
 * The division of labour is the whole design, and it is deliberate:
 *
 * - **We** compute the numbers ({@link buildEvidence}) and the hypothesis
 *   ({@link buildExpectedMetric}) from the log, deterministically. The
 *   evidence carries the ids of the events it came from, so "evidence traceable
 *   to numbers in the log" is true by construction and not by the agent's
 *   memory.
 * - **The session** does exactly one thing: turn a named bottleneck into
 *   `operations`, in the vocabulary of `docs/spec/entities-versioning.md`
 *   §3. It writes JSON to a file in its own working directory and is handed no
 *   URL, no token and no write access to anything else. The only `POST` in this
 *   ticket is ours.
 * - **Nobody applies.** There is no apply call here and no client method for
 *   one: a surveyor proposal only ever reaches `pendente`, which is the safety
 *   ladder of README principle 5 in code rather than in prose.
 *
 * A run with no signal (`gargalo === null`) opens no session at all and posts
 * nothing. "Nothing to propose" is a valid, silent outcome.
 *
 * English per D18. The proposal's outer keys went English with t226 and the
 * OPERATIONS with t228 (`docs/spec/glossary-wire.md` §3) — mirror validator and
 * session prompt together, because a prompt teaching the old spelling would
 * produce exactly the 400 the mirror exists to prevent. What travels INSIDE
 * `evidence` followed with t264 (§5.6), for the reason t255 set on the cost
 * lens: the two lenses write into the same free-JSON column (D15), and free
 * JSON is not a reason to write it in two languages. `fonte` is the one
 * deliberate exception — see {@link FlowEvidence.fonte}.
 *
 * `evidencia`, `metrica_esperada` and `proposta` on {@link SurveyorResult} are
 * NOT that surface: they are this module's own return value, read by
 * `cli.mjs` and by `packages/surveyor`, and renaming them is identifier debt
 * of another ficha (`test/no-portuguese-wire.test.ts`'s own exemption says so).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ControlPlaneClient,
  Proposal,
  GraphVersion,
} from '../controller/control-plane-client.ts';

/**
 * The one client this lens runs on, re-exported (t247).
 *
 * `packages/surveyor` calls `proposeFlowImprovement` across the package
 * boundary and has to hand it a client; without this line the only way to build
 * one would be a fourth entry in this package's `exports`, publishing the whole
 * controller so that a caller can reach one constructor. The lens is what needs
 * a client, so the lens is where it is offered — and the exported surface stays
 * the three subpaths that ticket named.
 */
export { ControlPlaneClient } from '../controller/control-plane-client.ts';
import type { EngineAdapter, SessionSpec, SessionStatus } from '../engine/types.ts';
import {
  calculateFlowMetrics,
  type NodeMetric,
  type FlowMetrics,
} from './metrics.ts';

/**
 * Where the session writes its answer.
 *
 * A file in the working directory, not stdout: the output of a real CLI is a
 * stream of frames with prose in between (`docs/spec/human-escalation.md` §4),
 * and a contract that survives that is one the session can fulfil with a single
 * write. The file NAME stays as it is: it is data the session is told to write,
 * not a code identifier.
 */
export const OUTPUT_FILE = 'proposta-topografo.json';

/** Wall-clock limit of the surveyor's session, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * How much of the bottleneck's dominant number the proposal claims to shave.
 *
 * Declared, not measured: it is the ambition of the hypothesis. The verdict of
 * t112 compares the next run against `de`, never against `para`
 * (`packages/core/src/domain/hypothesis.ts`), so this number decides nothing
 * on its own — it says out loud what "worth it" would look like.
 */
const EXPECTED_REDUCTION = 0.2;

/** The five operation types, as `domain/operations.ts` defines them. */
const OPERATION_TYPES = ['add_node', 'remove_node', 'add_edge', 'remove_edge', 'change_node_field'];

/** Which type undoes which. `change_node_field` is its own inverse. */
const EXPECTED_INVERSE: Record<string, string> = {
  add_node: 'remove_node',
  remove_node: 'add_node',
  add_edge: 'remove_edge',
  remove_edge: 'add_edge',
  change_node_field: 'change_node_field',
};

/** Node fields `change_node_field` may swap. */
const MUTABLE_FIELDS = ['role', 'description', 'skill_ref', 'contract'];

/** The evidence a flow proposal carries into the book. */
export interface FlowEvidence {
  /**
   * The lens, as the control plane's deduplication key reads it (t246, D21).
   *
   * `POST /v1/proposals` keys a proposal by `(lens, target_version, operations)`
   * and takes the lens off `evidence.lens` — the one place both lenses can carry
   * it without widening the wire shape. The cost lens has sent it since t255;
   * this is the flow lens joining the same dimension, so that two surveyors
   * proposing the same diff stay two proposals and the SAME surveyor running
   * twice over the same signal does not clone one.
   *
   * It does not replace {@link FlowEvidence.fonte}, which is untouched: `fonte`
   * is this module's own provenance string and `lens` is the control plane's
   * discriminator, and collapsing them would tie a server-side key to a label
   * nobody promised to keep stable.
   */
  lens: 'flow';
  /** Which surveyor produced this. The second one (custo) will say otherwise. */
  fonte: string;
  execution_id: number;
  graph_version_id: string;
  /** The bottleneck these numbers are about. */
  node_id: string;
  agent_ms: number;
  blocked_ms: number;
  queue_ms: number;
  total_ms: number;
  input_requests: number;
  /** Ids of the events the numbers were computed from — never a summary alone. */
  event_ids: number[];
  /** The whole ranking, so "why this node" is answerable without a re-run. */
  by_node: NodeMetric[];
}

/** The hypothesis, in the shape t112's verdict can read. */
export interface ExpectedMetric {
  nome: string;
  direcao: 'cai' | 'sobe';
  de: number;
  para: number;
}

/**
 * What one surveyor run did.
 *
 * These four names are this module's OWN — the runner-internal result its two
 * callers destructure — and not the book's. What goes into the book is what
 * `evidencia` and `metrica_esperada` CARRY, and that vocabulary went English
 * with t264; these keys did not, and renaming them is the identifier debt
 * `test/no-portuguese-wire.test.ts` already exempts by name.
 */
export interface SurveyorResult {
  metricas: FlowMetrics;
  /** `null` when the run had no time signal at all. */
  gargalo: NodeMetric | null;
  evidencia: FlowEvidence | null;
  metrica_esperada: ExpectedMetric | null;
  /** The proposal, always `pendente`; `null` when there was nothing to propose. */
  proposta: Proposal | null;
  /**
   * Whether THIS run is what put {@link SurveyorResult.proposta} in the book.
   *
   * `true` when the control plane created it (`201`), `false` when t246's
   * deduplication matched a still-pending proposal on
   * `(lens, target_version, operations)` and strengthened its evidence instead
   * (`200`), and `null` when there was nothing to propose at all.
   *
   * The three-way answer is the point. A caller reading only `proposta` cannot
   * tell the first two apart — a deduplicated proposal reads `pendente`
   * exactly like a fresh one — and `false` would be a lie for the third: a run
   * with no bottleneck was not deduplicated, it never proposed anything. The
   * unattended trigger of D21 writes one line per outcome, and this is the
   * field that decides which.
   */
  criada: boolean | null;
}

/** Configuration of one surveyor run. */
export interface SurveyorOptions {
  /** The runner's one HTTP door to the control plane. */
  client: ControlPlaneClient;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass the fake. */
  adapter: EngineAdapter;
  /** The execution to read. */
  executionId: number;
  /** Scratch directory the session runs in, and writes its answer to. */
  workingDir: string;
  /** Wall-clock limit of the session. Default: 15 minutes. */
  timeoutSeconds?: number;
  /**
   * Opaque additions to the engine's environment.
   *
   * Never the control plane: the session has no business talking to it, and
   * this ticket's only `POST` is the orchestrator's. In production nothing is
   * passed here; it is the seam the fake engine of the suite is driven by.
   */
  envOverrides?: Readonly<Record<string, string>>;
  /** Where progress goes. Default: nowhere — this is a library, not a CLI. */
  log?: (message: string) => void;
}

/** A run that could not produce a proposal. Never a partial one. */
export class SurveyorError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'SurveyorError';
    this.code = code;
    this.details = details;
  }
}

type PlainObject = Record<string, unknown>;

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Client-side mirror of the server's `validateOperation`
 * (`packages/core/src/domain/operations.ts`).
 *
 * The server remains the authority — every operation is validated again there,
 * and a disagreement is a `400` we would rather read than route around. The
 * mirror exists for one reason: FR7 requires a bad session to make **zero**
 * `POST /v1/proposals` calls, and "let the server decide" would spend a write
 * to find that out.
 *
 * Structural only, exactly like the original: it checks keys, types and that
 * the inverse undoes the same target. Whether the result is a sound graph is
 * the soundness gate's judgement, at apply time — a different layer.
 *
 * @param operation One operation, straight out of the session's JSON.
 * @returns Every problem found; empty means well formed.
 */
export function validateOperation(operation: unknown): string[] {
  if (!isObject(operation)) return ['an operation has to be a JSON object'];

  const type = operation.type;
  if (typeof type !== 'string' || !OPERATION_TYPES.includes(type)) {
    return [
      `unknown operation type: ${JSON.stringify(type)} (known: ${OPERATION_TYPES.join(', ')})`,
    ];
  }

  const problems = checkBody(type, operation, 'operation');

  const inverse = operation.inverse;
  if (!isObject(inverse)) {
    problems.push(`operation "${type}" has to declare its own "inverse" (D15)`);
    return problems;
  }
  if (inverse.type !== EXPECTED_INVERSE[type]) {
    problems.push(
      `the inverse of "${type}" has to be of type "${EXPECTED_INVERSE[type]}", got ${JSON.stringify(inverse.type)}`,
    );
    return problems;
  }

  problems.push(...checkBody(EXPECTED_INVERSE[type], inverse, 'inverse'));
  problems.push(...checkInverseTarget(type, operation, inverse));
  return problems;
}

/** Keys and types each operation type demands of itself. */
function checkBody(type: string, body: PlainObject, role: string): string[] {
  const problems: string[] = [];
  const edge = body.edge;

  switch (type) {
    case 'add_node':
      if (!isObject(body.node) || !isFilledText(body.node.id)) {
        problems.push(`${role} "${type}": "node" has to be an object with an "id"`);
      }
      break;
    case 'remove_node':
      if (!isFilledText(body.node_id)) {
        problems.push(`${role} "${type}": "node_id" has to be a filled node id`);
      }
      break;
    case 'add_edge':
    case 'remove_edge':
      if (!isObject(edge) || !isFilledText(edge.from) || !isFilledText(edge.to)) {
        problems.push(`${role} "${type}": "edge" has to have "from" and "to"`);
        break;
      }
      // `condition` is only demanded of the edge that ENTERS the document, and
      // as a string (even an empty one): a missing label is the soundness
      // gate's rejection, with the name of the rule, not a generic 400.
      if (type === 'add_edge' && typeof edge.condition !== 'string') {
        problems.push(`${role} "${type}": "edge.condition" has to be a string`);
      }
      break;
    case 'change_node_field':
      if (!isFilledText(body.node_id)) {
        problems.push(`${role} "${type}": "node_id" has to be a filled node id`);
      }
      if (typeof body.field !== 'string' || !MUTABLE_FIELDS.includes(body.field)) {
        problems.push(
          `${role} "change_node_field": "field" has to be one of ${MUTABLE_FIELDS.join(', ')}`,
        );
      }
      for (const key of ['from', 'to']) {
        if (!Object.hasOwn(body, key)) {
          problems.push(`${role} "change_node_field": "${key}" is missing`);
        }
      }
      break;
    default:
      break;
  }

  return problems;
}

/** The inverse has to undo THE SAME target — another node's inverse is not one. */
function checkInverseTarget(type: string, operation: PlainObject, inverse: PlainObject): string[] {
  const ends = (value: unknown): string =>
    isObject(value) ? `${String(value.from)}→${String(value.to)}` : 'invalid';

  switch (type) {
    case 'add_node': {
      const id = isObject(operation.node) ? operation.node.id : undefined;
      return inverse.node_id === id ? [] : [`the inverse has to remove node "${String(id)}"`];
    }
    case 'remove_node': {
      const id = isObject(inverse.node) ? inverse.node.id : undefined;
      return id === operation.node_id
        ? []
        : [`the inverse has to add node "${String(operation.node_id)}" back`];
    }
    case 'add_edge':
    case 'remove_edge':
      return ends(operation.edge) === ends(inverse.edge)
        ? []
        : [`the inverse has to point at the same edge (${ends(operation.edge)})`];
    case 'change_node_field':
      return inverse.node_id === operation.node_id && inverse.field === operation.field
        ? []
        : [
            `the inverse has to change the same field of the same node ("${String(operation.node_id)}"."${String(operation.field)}")`,
          ];
    default:
      return [];
  }
}

/**
 * Assembles the evidence of a bottleneck — the four numbers and the ids.
 *
 * @param bottleneck The worst node of the run.
 * @param metrics The whole ranking, carried along as context.
 * @param executionId The execution read.
 * @param versionId The graph version it ran under.
 * @returns The `evidencia` payload, ready for the book.
 */
export function buildEvidence(
  bottleneck: NodeMetric,
  metrics: FlowMetrics,
  executionId: number,
  versionId: string,
): FlowEvidence {
  return {
    lens: 'flow',
    fonte: 'topografo/fluxo',
    execution_id: executionId,
    graph_version_id: versionId,
    node_id: bottleneck.node_id,
    agent_ms: bottleneck.agent_ms,
    blocked_ms: bottleneck.blocked_ms,
    queue_ms: bottleneck.queue_ms,
    total_ms: bottleneck.total_ms,
    input_requests: bottleneck.input_requests,
    event_ids: [...bottleneck.event_ids],
    by_node: metrics.by_node,
  };
}

/**
 * Names the number the next run should move, and which way.
 *
 * The dominant component of the bottleneck, not the total: "the node costs
 * 159s" is not actionable, "the node spends two minutes blocked on a human" is.
 * Ties fall to waiting, then queueing, then agent time — the order in which a
 * change to the graph can plausibly help.
 *
 * @param bottleneck The worst node of the run.
 * @returns The declared hypothesis.
 */
export function buildExpectedMetric(bottleneck: NodeMetric): ExpectedMetric {
  const components = [
    { name: 'blocked_ms', value: bottleneck.blocked_ms },
    { name: 'queue_ms', value: bottleneck.queue_ms },
    { name: 'agent_ms', value: bottleneck.agent_ms },
  ];
  const dominant = components.reduce((biggest, current) =>
    current.value > biggest.value ? current : biggest,
  );

  return {
    nome: `${dominant.name}:${bottleneck.node_id}`,
    direcao: 'cai',
    de: dominant.value,
    para: Math.round(dominant.value * (1 - EXPECTED_REDUCTION)),
  };
}

/**
 * The output contract of the session, as its system prompt.
 *
 * It says what to write and where, and it says what NOT to do: the session has
 * no access to the control plane and no business editing the repository. The
 * five operation types are listed literally because the vocabulary is closed
 * (`docs/spec/entities-versioning.md` §3) and this ticket adds none.
 *
 * The CONTENT is English (D24, t309). It used to be Portuguese on the grounds
 * that it stands in for the skill manifest the graph will inject (t101/t105),
 * "and those are written in Portuguese" — which stopped being true before t309
 * looked: the manifests under `specs/formats/examples/` and every skill of the
 * factory bundles are English, and have been for several tickets. The
 * stand-in now matches what it stands in for.
 */
export const INSTRUCTIONS = [
  'You are the flow topographer of cartografo, analysing ONE execution that has',
  'already finished.',
  '',
  'You are given: the graph that ran (nodes and edges) and the measurement of the',
  'most expensive node of the execution, already computed — the numbers are not',
  'yours to recompute.',
  '',
  'Your only task: propose a SEMANTIC diff on the graph that attacks that',
  'bottleneck.',
  '',
  `Write the result to the file \`${OUTPUT_FILE}\`, in the current directory, with`,
  'exactly this shape and nothing else:',
  '',
  '```json',
  '{"operations": [ ... ]}',
  '```',
  '',
  'Each operation is of ONE of these five types, and carries its own inverse:',
  '',
  '- `add_node`          {"type","node",   "inverse": {"type":"remove_node","node_id"}}',
  '- `remove_node`       {"type","node_id","inverse": {"type":"add_node","node"}}',
  '- `add_edge`          {"type","edge":{"from","to","condition"}, "inverse":{"type":"remove_edge","edge":{"from","to"}}}',
  '- `remove_edge`       {"type","edge":{"from","to"}, "inverse":{"type":"add_edge","edge":{"from","to","condition"}}}',
  '- `change_node_field` {"type","node_id","field","from","to", "inverse": the same one with from/to swapped}',
  '',
  '`field` can only be role, description, skill_ref or contract. Changing `id` or',
  '`node_type` is not a field change, and there is no operation for it here.',
  '',
  'Hard rules:',
  '',
  '- the list cannot be empty — if there is no change that would help, say so in',
  '  your turn and write the file anyway, with the best proposal you have;',
  '- every new node needs an incoming AND an outgoing edge, or the soundness gate',
  '  fails the whole proposal;',
  '- do not edit anything else in the directory, do not run git and do not call',
  '  any API. Your output is the file, and the proposal is recorded by whoever',
  '  dispatched you.',
].join('\n');

/**
 * The prompt: the graph that ran, and the measurement of its worst node.
 *
 * English for the same reason {@link INSTRUCTIONS} is: content handed to a
 * session is still content somebody reads.
 */
export function buildPrompt(version: GraphVersion, evidence: FlowEvidence): string {
  const nodes = version.snapshot.nodes ?? [];
  const edges = version.snapshot.edges ?? [];

  const parts = [
    `# Graph \`${version.graph_id}\`, version \`${version.id}\``,
    '',
    '## Nodes',
    '',
    ...nodes.map((node) => {
      const role = typeof node.role === 'string' ? node.role : '—';
      const nodeType = typeof node.node_type === 'string' ? node.node_type : '—';
      const description = typeof node.description === 'string' ? node.description : '';
      return `- \`${node.id}\` (${nodeType}, role: ${role}) — ${description}`;
    }),
    '',
    '## Edges',
    '',
    ...edges.map(
      (edge) =>
        `- \`${edge.from}\` → \`${edge.to}\` when: ${edge.condition ?? '(no condition)'}`,
    ),
    '',
    `## Measurement of execution ${evidence.execution_id}`,
    '',
    `Bottleneck: **\`${evidence.node_id}\`**.`,
    '',
    '| node | agent (ms) | blocked (ms) | queue (ms) | total (ms) | questions |',
    '|---|---|---|---|---|---|',
    ...evidence.by_node.map(
      (row) =>
        `| \`${row.node_id}\` | ${row.agent_ms} | ${row.blocked_ms} | ${row.queue_ms} | ${row.total_ms} | ${row.input_requests} |`,
    ),
    '',
    'Reading the columns: **agent** is time with a session open on the node;',
    '**blocked** is time with the work blocked at that node (typically waiting on',
    'people); **queue** is the time between the work reaching the node and its',
    'session opening.',
    '',
    `Propose the diff that attacks the bottleneck and write it to \`${OUTPUT_FILE}\`.`,
  ];

  return parts.join('\n');
}

/** What the session reported when it ended. */
interface Outcome {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Runs the one agentic step and returns the operations it chose.
 *
 * Everything that can go wrong here ends in `SurveyorError` and no `POST`: a
 * session that dies, one that writes nothing, one that writes something that is
 * not a well-formed semantic diff.
 */
async function chooseOperations(
  options: SurveyorOptions,
  version: GraphVersion,
  evidence: FlowEvidence,
  log: (message: string) => void,
): Promise<unknown[]> {
  const spec: SessionSpec = {
    workingDir: options.workingDir,
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(version, evidence),
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
  };

  const lines: string[] = [];
  let announceEnd: (outcome: Outcome) => void = () => undefined;
  const end = new Promise<Outcome>((resolve) => {
    announceEnd = resolve;
  });

  await options.adapter.startSession(spec, {
    onOutput(line) {
      lines.push(line);
    },
    onFinished(status, exitCode) {
      announceEnd({ status, exitCode });
    },
  });

  const outcome = await end;
  log(`session ended as "${outcome.status}" (exit ${String(outcome.exitCode)})`);

  if (outcome.status !== 'completed') {
    throw new SurveyorError(
      'session_failed',
      `the surveyor's session ended as "${outcome.status}" (exit ${String(outcome.exitCode)}); no proposal was written`,
      lines.slice(-10),
    );
  }

  const outputPath = path.join(options.workingDir, OUTPUT_FILE);
  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch {
    throw new SurveyorError(
      'missing_output',
      `the session ended without writing ${OUTPUT_FILE} in ${options.workingDir}: with no "operations", there is no proposal`,
      lines.slice(-10),
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new SurveyorError(
      'invalid_output',
      `${OUTPUT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const operations = isObject(document) ? document.operations : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new SurveyorError(
      'missing_operations',
      `${OUTPUT_FILE} has to carry "operations" as a non-empty list — a proposal that changes nothing is not a proposal`,
    );
  }

  // Same structural rules the server enforces, applied before spending a write
  // to discover them (FR7).
  const problems = operations.flatMap((operation, index) =>
    validateOperation(operation).map((problem) => `operation #${index}: ${problem}`),
  );
  if (problems.length > 0) {
    throw new SurveyorError(
      'invalid_operations',
      `the session returned ${problems.length} shape problem(s) in "operations"; nothing was written`,
      problems,
    );
  }

  return operations;
}

/**
 * Which graph version this execution ran under.
 *
 * The log does not carry it (`trabalho.criado` has no `graph_version_id` in its
 * schema — it is projection, not fact), so the answer comes from the
 * version × telemetry join of t102. The version with the most works wins a run
 * that spans two of them: the proposal has to target one, and the majority is
 * the one the evidence is mostly about.
 */
async function resolveVersion(options: SurveyorOptions): Promise<string> {
  const rows = await options.client.metricsByVersion(options.executionId);
  const declared = rows.filter(
    (row): row is { graph_version_id: string; jobs: number; events: number } =>
      row.graph_version_id !== null,
  );

  if (declared.length === 0) {
    throw new SurveyorError(
      'execution_without_version',
      `execution ${options.executionId} has no work declaring a graph_version_id: there is no graph to propose a change to`,
    );
  }

  return declared.reduce((biggest, current) =>
    current.jobs > biggest.jobs ? current : biggest,
  ).graph_version_id;
}

/**
 * Reads one execution and, if it had a bottleneck, lands exactly one pending
 * proposal about it.
 *
 * @param options Control plane, engine, execution and scratch directory.
 * @returns The metrics, the bottleneck and the proposal — the last two `null`
 *   when the run had no time signal at all.
 * @throws {SurveyorError} When the execution declares no version, or the
 *   session failed to produce a well-formed diff. Nothing is posted in either
 *   case.
 * @throws {ControlPlaneClientError} When the API refuses a call.
 */
export async function proposeFlowImprovement(
  options: SurveyorOptions,
): Promise<SurveyorResult> {
  const log = options.log ?? ((): void => undefined);

  const versionId = await resolveVersion(options);
  const version = await options.client.getGraphVersion(versionId);
  const events = await options.client.listExecutionEvents(options.executionId);
  log(`execution ${options.executionId}: ${events.length} events under version ${versionId}`);

  const nodeIds = (version.snapshot.nodes ?? []).map((node) => node.id);
  const metrics = calculateFlowMetrics(events, nodeIds);

  const bottleneck = metrics.gargalo;
  if (bottleneck === null) {
    // No session, no proposal, no error: with nothing to explain, nobody gets
    // paid to explain it.
    log('no node cost any time in this execution; nothing to propose');
    return {
      metricas: metrics,
      gargalo: null,
      evidencia: null,
      metrica_esperada: null,
      proposta: null,
      criada: null,
    };
  }

  const evidence = buildEvidence(bottleneck, metrics, options.executionId, versionId);
  const expectedMetric = buildExpectedMetric(bottleneck);
  log(
    `bottleneck: ${bottleneck.node_id} (${bottleneck.total_ms}ms, ${bottleneck.input_requests} question(s)), over events ${bottleneck.event_ids.join(', ')}`,
  );

  const operations = await chooseOperations(options, version, evidence, log);

  // The outer keys went English with t226 and what is inside `operations` with
  // t228 (D20's third child). What `evidence` and `expected_metric` carry is the
  // frozen hypothesis shape (FR5), which is nobody's surface in D20.
  const { proposal, created } = await options.client.createProposal({
    graph_id: version.graph_id,
    target_version: version.id,
    operations,
    evidence,
    expected_metric: expectedMetric,
  });
  // "created" and not "written": since t246 a repeat over the same signal comes
  // back as the proposal that was already there, and saying otherwise in a log
  // is how a person concludes the lens is looping.
  log(
    `proposal ${proposal.id} ${created ? 'created' : 'already pending (deduplicated)'} as "${proposal.status}"`,
  );

  return {
    metricas: metrics,
    gargalo: bottleneck,
    evidencia: evidence,
    metrica_esperada: expectedMetric,
    proposta: proposal,
    criada: created,
  };
}
