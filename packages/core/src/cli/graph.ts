/**
 * `cartografo graph <verb>` — editing a graph from the terminal (t545, D26).
 *
 * `export` writes a lineage's current snapshot to a file and `import` registers a
 * NEW lineage from one; what neither does is push an edit to an EXISTING lineage.
 * The graph editor page does that through exactly one door, a proposal — created,
 * approved and applied (`packages/screen/src/public/graph-editor.js`) — and
 * `graph propose` goes through the same door: the person who edited the file is
 * the judge, so approve and apply both carry that person as the actor.
 *
 * The operations come from `domain/diff.ts`'s `diffGraphs`, the same semantic
 * diff `routes/proposals.ts` trusts, and `--dry-run` runs the core's own
 * `applyOperations` + `validateGraph` locally, so its verdict is the one `/apply`
 * would reach. Importing from `../domain/` is `import.ts`'s precedent.
 *
 * The frozen fields are the page's (`FROZEN_NODE_FIELDS`), but a file has no
 * missing control to enforce them, so they are checked here before any diff:
 *
 * - `id` is paired by ARRAY POSITION over the shared prefix — the only
 *   correlation a raw file offers across an edit. Known limitation: inserting or
 *   deleting a node mid-array shifts the positions after it and trips the same
 *   refusal; append at the end and delete from the end.
 * - `engine` is compared on every id both documents share. The core allows a
 *   `change_node_field` on it; the page treats it as execution policy, and this
 *   command matches the page.
 * - `node_type` is not refused: `diffGraphs` already turns a changed type into a
 *   `remove_node` + `add_node` pair, which is the page's own escape hatch.
 *
 * The option-parsing primitives, `errorText`, `renderOperations` and
 * `resolveOperator` come from `cli/proposals.ts`: that module does not import
 * from this one, so unlike `index.ts` the import is not circular. The manual
 * evidence and metric are a local copy of the page's constants rather than an
 * import — `packages/core` never depends on `packages/screen` (D11).
 */

import { readFileSync } from 'node:fs';

import { diffGraphs } from '../domain/diff.ts';
import { validateGraph, type GraphDocument, type GraphNode } from '../domain/graph.ts';
import { ApplicationError, applyOperations, type Operation } from '../domain/operations.ts';
import { isObject } from '../util/is-object.ts';
import {
  errorText,
  extractFlag,
  extractValue,
  renderOperations,
  requireNothingElse,
  resolveOperator,
} from './proposals.ts';
import { UsageError, requestJson, type HttpResponse } from './url.ts';

/** Context the router has already resolved before handing off to this module. */
export interface GraphContext {
  url: string;
  projectId: number;
}

/** A version, in the fields this surface reads (`repositories/graphs.ts`'s `GraphVersion`). */
interface VersionRead {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  contracts?: { state?: string };
  snapshot?: unknown;
}

/** `graph-editor.js`'s `MANUAL_METRIC`, byte for byte: a manual edit measures nothing. */
const MANUAL_METRIC = { nome: 'manual edit (no metric)', direcao: 'sobe', de: 0, para: 0 };

const EVIDENCE_SOURCE = 'cli-graph-propose';
const DEFAULT_EVIDENCE_NOTE = 'manual edit via cartografo graph propose';

/* ------------------------------------------------------------------ wire */

function isSuccess(response: HttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** The control plane's own refusal, printed verbatim (FR8). */
function refused(response: HttpResponse): number {
  process.stderr.write(`cartografo: ${errorText(response.body, response.status)}\n`);
  return 1;
}

function scoped(ctx: GraphContext, route: string): string {
  return `${ctx.url}/v1${route}?project_id=${ctx.projectId}`;
}

/** `{graph_version}` out of a `GET /graph-versions/:id` body. */
function versionOf(response: HttpResponse): VersionRead {
  const body = isObject(response.body) ? response.body : {};
  return (isObject(body.graph_version) ? body.graph_version : {}) as unknown as VersionRead;
}

/**
 * The two reads `export.ts` makes: the lineage, then its current version.
 *
 * @returns The version, or the exit code of a refusal already printed.
 */
async function currentVersion(id: string, ctx: GraphContext): Promise<{ response: HttpResponse } | number> {
  const lineage = await requestJson(scoped(ctx, `/graphs/${encodeURIComponent(id)}`));
  if (!isSuccess(lineage)) return refused(lineage);

  const body = isObject(lineage.body) ? lineage.body : {};
  const graph = isObject(body.graph) ? body.graph : {};
  const versionId = graph.current_version_id;
  if (typeof versionId !== 'string' || versionId === '') {
    process.stderr.write(`cartografo: graph "${id}" has no current version\n`);
    return 1;
  }

  const response = await requestJson(scoped(ctx, `/graph-versions/${encodeURIComponent(versionId)}`));
  if (!isSuccess(response)) return refused(response);
  return { response };
}

/**
 * A graph report's reasons, in `import.ts`'s own vocabulary — the local
 * `validateGraph` result and the `422 invalid_graph` body share this shape.
 */
function printReport(report: unknown): void {
  const body = isObject(report) ? report : {};
  const structure = isObject(body.structure) ? body.structure : {};
  const soundness = isObject(body.soundness) ? body.soundness : {};
  for (const error of Array.isArray(structure.errors) ? structure.errors : []) {
    const item = isObject(error) ? error : {};
    process.stderr.write(`  structure  ${String(item.code)}: ${String(item.message)}\n`);
  }
  for (const violation of Array.isArray(soundness.violations) ? soundness.violations : []) {
    const item = isObject(violation) ? violation : {};
    process.stderr.write(`  soundness  ${String(item.rule)}: ${JSON.stringify(item.target)}\n`);
  }
}

/* ------------------------------------------------------------ frozen fields */

function nodesOf(document: unknown): GraphNode[] {
  if (!isObject(document) || !Array.isArray(document.nodes)) return [];
  return document.nodes.filter(isObject) as GraphNode[];
}

function quoted(value: unknown): string {
  return value === undefined ? 'absent' : JSON.stringify(value);
}

/**
 * The frozen-field refusals (FR3), all of them, so that one run names every
 * violation in the file.
 *
 * @param loaded The snapshot of the lineage's current version.
 * @param edited The document read from the file.
 * @returns One message per violation; empty when the edit touches no frozen field.
 */
function frozenViolations(loaded: unknown, edited: unknown): string[] {
  const before = nodesOf(loaded);
  const after = nodesOf(edited);
  const problems: string[] = [];

  for (let position = 0; position < Math.min(before.length, after.length); position += 1) {
    if (before[position].id !== after[position].id) {
      problems.push(
        `node at position ${position} appears to have been renamed from ${quoted(before[position].id)} to ${quoted(after[position].id)} — id is frozen; remove the node and add a new one instead`,
      );
    }
  }

  const engines = new Map(before.map((node) => [node.id, node.engine]));
  for (const node of after) {
    if (!engines.has(node.id)) continue;
    const was = engines.get(node.id);
    if (was !== node.engine) {
      problems.push(
        `node ${quoted(node.id)}: engine changed from ${quoted(was)} to ${quoted(node.engine)} — engine is frozen; remove the node and add a new one instead`,
      );
    }
  }

  return problems;
}

/* ---------------------------------------------------------------- propose */

function readDocument(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`could not read "${filePath}"`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new UsageError(`"${filePath}" is not valid JSON — ${(error as Error).message}`);
  }
}

/**
 * `--dry-run`: the operations, then the core's own apply and gate, locally.
 * Nothing is sent.
 */
function dryRun(loaded: GraphDocument, operations: Operation[]): number {
  for (const line of renderOperations(operations)) process.stdout.write(`${line}\n`);

  let document: GraphDocument;
  try {
    document = applyOperations(loaded, operations);
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    process.stderr.write(`cartografo: inapplicable_operation: ${error.message}\n`);
    return 1;
  }

  const report = validateGraph(document);
  if (!report.valid) {
    process.stderr.write('cartografo: invalid_graph — the edited graph would be refused at apply\n');
    printReport(report);
    return 1;
  }
  process.stdout.write('dry run: the edit applies and passes the soundness gate; nothing was sent\n');
  return 0;
}

/**
 * `cartografo graph propose <file> [--graph <id>] [--by <name>]
 * [--evidence <text>] [--dry-run] [--no-apply] [--json]`.
 *
 * `--json` prints each wire body the command received (the created proposal,
 * then approve's, then apply's), one per line.
 */
async function runPropose(args: string[], ctx: GraphContext): Promise<number> {
  const fromGraph = extractValue(args, '--graph');
  const fromBy = extractValue(fromGraph.rest, '--by');
  const fromEvidence = extractValue(fromBy.rest, '--evidence');
  const fromDryRun = extractFlag(fromEvidence.rest, '--dry-run');
  const fromNoApply = extractFlag(fromDryRun.rest, '--no-apply');
  const fromJson = extractFlag(fromNoApply.rest, '--json');
  requireNothingElse(fromJson.rest, 1, 'graph propose');

  const file = fromJson.rest[0];
  if (file === undefined) throw new UsageError('graph propose needs the path of an edited graph file');
  if (fromDryRun.present && fromNoApply.present) {
    throw new UsageError(
      'graph propose: --dry-run and --no-apply contradict each other (--dry-run never contacts the server to create anything)',
    );
  }
  // Resolved before any request: an unresolvable operator is a wrong command line.
  const actor = fromDryRun.present || fromNoApply.present ? undefined : { type: 'user', ref: resolveOperator(fromBy.value) };

  const edited = readDocument(file);
  if (!isObject(edited)) throw new UsageError(`"${file}" is not a graph document (expected a JSON object)`);
  const graphId = fromGraph.value ?? edited.problem_class;
  if (typeof graphId !== 'string' || graphId === '') {
    throw new UsageError('graph propose needs --graph: the file carries no problem_class to default to');
  }

  const found = await currentVersion(graphId, ctx);
  if (typeof found === 'number') return found;
  const target = versionOf(found.response);
  const loaded = target.snapshot as GraphDocument;

  const frozen = frozenViolations(loaded, edited);
  if (frozen.length > 0) {
    for (const problem of frozen) process.stderr.write(`cartografo: ${problem}\n`);
    process.stderr.write('cartografo: nothing was sent to the control plane\n');
    return 1;
  }

  const operations = diffGraphs(loaded, edited as unknown as GraphDocument);
  if (operations.length === 0) {
    process.stdout.write('no change to propose\n');
    return 0;
  }

  if (fromDryRun.present) return dryRun(loaded, operations);

  const created = await requestJson(scoped(ctx, '/proposals'), {
    method: 'POST',
    body: {
      graph_id: graphId,
      target_version: target.id,
      operations,
      evidence: { source: EVIDENCE_SOURCE, note: fromEvidence.value ?? DEFAULT_EVIDENCE_NOTE },
      expected_metric: MANUAL_METRIC,
    },
  });
  if (fromJson.present) process.stdout.write(`${JSON.stringify(created.body)}\n`);
  if (!isSuccess(created)) return refused(created);

  const createdBody = isObject(created.body) ? created.body : {};
  const proposal = isObject(createdBody.proposal) ? createdBody.proposal : {};
  const proposalId = String(proposal.id);

  if (actor === undefined) {
    if (!fromJson.present) process.stdout.write(`proposal #${proposalId} created, pending\n`);
    return 0;
  }

  for (const verb of ['approve', 'apply'] as const) {
    const response = await requestJson(`${ctx.url}/v1/proposals/${encodeURIComponent(proposalId)}/${verb}`, {
      method: 'POST',
      body: { actor },
    });
    if (fromJson.present) process.stdout.write(`${JSON.stringify(response.body)}\n`);
    if (isSuccess(response)) continue;

    const body = isObject(response.body) ? response.body : {};
    refused(response);
    if (body.error === 'stale_proposal') {
      process.stderr.write(
        'cartografo: the graph base moved while you were editing — re-export and redo the edit\n',
      );
    }
    if (body.error === 'invalid_graph') printReport(body);
    process.stderr.write(`cartografo: proposal #${proposalId} was not applied\n`);
    return 1;
  }

  if (!fromJson.present) {
    const lineage = await requestJson(scoped(ctx, `/graphs/${encodeURIComponent(graphId)}`));
    const body = isObject(lineage.body) ? lineage.body : {};
    const graph = isObject(body.graph) ? body.graph : {};
    process.stdout.write(
      `proposal #${proposalId} applied — ${graphId} is now at ${String(graph.current_version_id)}\n`,
    );
  }
  return 0;
}

/* ---------------------------------------------------------------- reads */

/** `cartografo graph versions <id> [--json]` — the whole chain, oldest first. */
async function runVersions(args: string[], ctx: GraphContext): Promise<number> {
  const fromJson = extractFlag(args, '--json');
  requireNothingElse(fromJson.rest, 1, 'graph versions');
  const id = fromJson.rest[0];
  if (id === undefined) throw new UsageError('graph versions needs a graph id');

  const response = await requestJson(scoped(ctx, `/graphs/${encodeURIComponent(id)}/versions`));
  if (fromJson.present) process.stdout.write(`${JSON.stringify(response.body)}\n`);
  if (!isSuccess(response)) return refused(response);
  if (fromJson.present) return 0;

  const body = isObject(response.body) ? response.body : {};
  const versions = (Array.isArray(body.versions) ? body.versions : []) as VersionRead[];
  const lines = versions.map(
    (version) =>
      `${version.id}  parent=${version.parent_version ?? 'none'}  source=${version.source}  contracts=${version.contracts?.state ?? 'unknown'}`,
  );
  process.stdout.write(`${(lines.length === 0 ? ['(none)'] : lines).join('\n')}\n`);
  return 0;
}

function printVersion(version: VersionRead): void {
  const nodes = nodesOf(version.snapshot);
  const snapshot = isObject(version.snapshot) ? version.snapshot : {};
  const edges = (Array.isArray(snapshot.edges) ? snapshot.edges : []).filter(isObject);

  const lines = [
    `version: ${version.id}`,
    `graph: ${version.graph_id}`,
    `nodes: ${nodes.length}`,
    `edges: ${edges.length}`,
    '',
    ...nodes.map((node) => `  ${node.id}  ${node.role}  ${node.node_type}  ${node.engine ?? 'default'}`),
    '',
    ...edges.map((edge) => `  ${String(edge.from)} → ${String(edge.to)}  (${String(edge.condition)})`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * `cartografo graph show <id> [--version <version-id>] [--json]`.
 *
 * `GET /graph-versions/:id` is not scoped to a lineage — a version hash is
 * unique per project — so a `--version` from another lineage is refused here.
 */
async function runShow(args: string[], ctx: GraphContext): Promise<number> {
  const fromVersion = extractValue(args, '--version');
  const fromJson = extractFlag(fromVersion.rest, '--json');
  requireNothingElse(fromJson.rest, 1, 'graph show');
  const id = fromJson.rest[0];
  if (id === undefined) throw new UsageError('graph show needs a graph id');

  let response: HttpResponse;
  if (fromVersion.value === undefined) {
    const found = await currentVersion(id, ctx);
    if (typeof found === 'number') return found;
    response = found.response;
  } else {
    response = await requestJson(scoped(ctx, `/graph-versions/${encodeURIComponent(fromVersion.value)}`));
    if (!isSuccess(response)) return refused(response);
  }

  const version = versionOf(response);
  if (version.graph_id !== id) {
    process.stderr.write(
      `cartografo: version ${version.id} belongs to graph "${version.graph_id}", not to "${id}"\n`,
    );
    return 1;
  }

  if (fromJson.present) process.stdout.write(`${JSON.stringify(version)}\n`);
  else printVersion(version);
  return 0;
}

/* --------------------------------------------------------------- router */

/**
 * Dispatches one verb of `cartografo graph` (FR1).
 *
 * @param verb First positional argument after `graph`, or `undefined`.
 * @param args Everything after the verb.
 * @param ctx `url` and the already-resolved `projectId`.
 * @throws {UsageError} When `verb` is missing or not one of the three words.
 */
export async function runGraph(verb: string | undefined, args: string[], ctx: GraphContext): Promise<number> {
  switch (verb) {
    case 'propose':
      return await runPropose(args, ctx);
    case 'versions':
      return await runVersions(args, ctx);
    case 'show':
      return await runShow(args, ctx);
    default:
      throw new UsageError('graph needs a verb: propose, versions or show');
  }
}
