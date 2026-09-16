/**
 * `cartografo proposals <verb>` — the CLI's own inbox (t584, D26).
 *
 * D26 makes the CLI (and the MCP server) the complete operator surface and
 * retires the screen after parity. Deciding a proposal was the one thing the
 * terminal could not do: the MCP server excludes approve/apply/reject/revert on
 * purpose (principle 5 — the judge stays outside the model), and until t583 a
 * decision carried no real actor for a CLI to attribute. t583 landed that
 * plumbing on `/v1/proposals/:id/{approve,apply,reject,revert}`: an optional
 * `actor: {type: 'user', ref: <string>}` in the body, an `agent` actor refused
 * with `400 agent_actor_not_allowed`, and a bodyless call to approve/apply still
 * answering `200`. This module is a thin HTTP client of exactly that contract.
 *
 * The section split of `list` and the semantic-diff lines of `show` are PORTED
 * from `packages/screen/src/public/actions.js` (`OPEN_STATUSES`/`isOpen`) and
 * `packages/screen/src/public/diff.js` (`renderOperations`), not imported:
 * `packages/core` has never depended on `packages/screen`, and D11's direction
 * (the screen depends on nothing from core) does not reverse just because this
 * reader moved into core.
 *
 * `extractValue`/`extractFlag`/`requireNothingElse` are likewise a small,
 * deliberate copy of `cli/index.ts`'s own option-parsing primitives rather than
 * an import from it: `index.ts` calls `runProposals` from this file, and
 * importing back from it would make the two modules circular for the sake of
 * three tiny, side-effect-free functions.
 *
 * A wrong-state decision (approving twice, applying a proposal still pending) is
 * left entirely to the control plane's own `409` — this module does not
 * replicate `actions.js`'s `resolveActionsForStatus` gating table client-side.
 * One arbiter, not two copies of the same rule that could drift.
 */

import os from 'node:os';

import { isObject } from '../util/is-object.ts';
import { UsageError, requestJson, type HttpResponse } from './url.ts';

/** Context the router has already resolved before handing off to this module. */
export interface ProposalsContext {
  url: string;
  projectId: number;
}

/** A proposal, in the fields this surface reads (`repositories/proposals.ts`'s `Proposal`). */
interface ProposalRead {
  id: number;
  status: string;
  graph_id: string;
  target_version: string;
  operations: unknown;
  evidence: unknown;
  expected_metric: unknown;
  result: unknown;
  rejection_reason: string | null;
  revert_reason: string | null;
}

/* --------------------------------------------------------- option parsing */
/* Copied from `cli/index.ts` (see the header comment for why). */

interface Extraction {
  value?: string;
  rest: string[];
}

function extractValue(args: string[], name: string): Extraction {
  const rest: string[] = [];
  let value: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === name) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${name} needs a value`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      value = current.slice(name.length + 1);
      if (value === '') throw new UsageError(`${name} needs a value`);
      continue;
    }
    rest.push(current);
  }

  return { value, rest };
}

function extractFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((argument) => argument !== name);
  return { present: rest.length !== args.length, rest };
}

function requireNothingElse(left: string[], positionalCount: number, subcommand: string): void {
  const extras = left.slice(positionalCount);
  if (extras.length > 0) {
    throw new UsageError(`${subcommand} does not understand: ${extras.map((extra) => `"${extra}"`).join(', ')}`);
  }
}

/* ------------------------------------------------------------------ wire */

function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

function proposalsOf(body: unknown): ProposalRead[] {
  const record = isObject(body) ? body : {};
  return Array.isArray(record.proposals) ? (record.proposals as ProposalRead[]) : [];
}

/**
 * The wire's `error`/`message`, joined the way `inbox.js`'s `messageOf` does
 * (FR7): `"<error>: <message>"` when both are there, whichever one is there
 * alone otherwise, and a generic fallback when the body carries neither.
 */
function errorText(body: unknown, status: number): string {
  if (!isObject(body)) return `failure ${status}`;
  const error = typeof body.error === 'string' ? body.error : undefined;
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : undefined;
  if (message !== undefined) return error === undefined ? message : `${error}: ${message}`;
  if (error !== undefined) return error;
  return `failure ${status}`;
}

/**
 * The uniform ending every verb shares (FR7/FR8): `--json` always prints the
 * raw wire body, success or refusal alike; the exit code is `0` on a `2xx` and
 * `1` otherwise, with the body's own error printed to stderr — never reworded.
 */
function finish(response: HttpResponse, json: boolean): number {
  if (json) process.stdout.write(`${JSON.stringify(response.body)}\n`);
  if (response.status >= 200 && response.status < 300) return 0;
  process.stderr.write(`cartografo: ${errorText(response.body, response.status)}\n`);
  return 1;
}

/* -------------------------------------------------------- semantic diff */
/* Ported from `packages/screen/src/public/diff.js`'s `renderOperations`. */

const EMPTY_DIFF_LINE = 'no change';
const MALFORMED_LINE = '? malformed operation';
const MISSING_ID = 'no id';
const VALUE_LIMIT = 60;

function asId(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : MISSING_ID;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (value === undefined) return 'empty';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let json: string;
  try {
    json = JSON.stringify(value) ?? 'unprintable value';
  } catch {
    return 'unprintable value';
  }
  return json.length > VALUE_LIMIT ? `${json.slice(0, VALUE_LIMIT)}…` : json;
}

function describeEdge(edge: unknown): string {
  const source = isObject(edge) ? asId(edge.from) : MISSING_ID;
  const target = isObject(edge) ? asId(edge.to) : MISSING_ID;
  const condition = isObject(edge) ? edge.condition : undefined;
  const suffix = typeof condition === 'string' && condition.trim() !== '' ? ` (condition: ${condition})` : '';
  return `${source} → ${target}${suffix}`;
}

function renderOperation(operation: unknown): string {
  if (!isObject(operation)) return MALFORMED_LINE;

  switch (operation.type) {
    case 'add_node': {
      const node = operation.node;
      const id = asId(isObject(node) ? node.id : undefined);
      const kind = isObject(node) && typeof node.node_type === 'string' ? node.node_type : '';
      return `+ node "${id}"${kind === '' ? '' : ` (type ${kind})`}`;
    }
    case 'remove_node':
      return `- node "${asId(operation.node_id)}"`;
    case 'add_edge':
      return `+ edge ${describeEdge(operation.edge)}`;
    case 'remove_edge':
      return `- edge ${describeEdge(operation.edge)}`;
    case 'change_node_field':
      return `~ node "${asId(operation.node_id)}": field "${asId(operation.field)}" from ${describeValue(operation.from)} to ${describeValue(operation.to)}`;
    default:
      return typeof operation.type === 'string' && operation.type.trim() !== ''
        ? `? operation of unknown type ("${operation.type}")`
        : MALFORMED_LINE;
  }
}

function renderOperations(operations: unknown): string[] {
  if (!Array.isArray(operations) || operations.length === 0) return [EMPTY_DIFF_LINE];
  return operations.map(renderOperation);
}

/* ------------------------------------------------------------------ list */
/* The open/history split, ported from `actions.js`'s `OPEN_STATUSES`/`isOpen`. */

const OPEN_STATUSES = new Set(['pending', 'approved']);

function isOpenStatus(status: string): boolean {
  return OPEN_STATUSES.has(status);
}

function proposalLine(proposal: ProposalRead): string {
  return `#${proposal.id}  ${proposal.status}  ${proposal.graph_id}  ${proposal.target_version}`;
}

function printProposalList(proposals: ProposalRead[], status: string | undefined): void {
  if (status !== undefined) {
    process.stdout.write(`${(proposals.length === 0 ? ['(none)'] : proposals.map(proposalLine)).join('\n')}\n`);
    return;
  }

  const pending = proposals.filter((proposal) => isOpenStatus(proposal.status));
  const history = proposals.filter((proposal) => !isOpenStatus(proposal.status));
  const section = (title: string, rows: ProposalRead[]): string[] => [
    title,
    ...(rows.length === 0 ? ['  (none)'] : rows.map((proposal) => `  ${proposalLine(proposal)}`)),
  ];

  process.stdout.write(`${[...section('PENDING', pending), '', ...section('HISTORY', history)].join('\n')}\n`);
}

/**
 * `cartografo proposals list [--status <status>] [--json]`.
 *
 * Human output, with no `--status`: two sections, `PENDING` then `HISTORY`, the
 * same two-way split the inbox page draws (FR2). With `--status`, the server
 * already narrowed the set to one status, so the output is the flat list — a
 * section header naming the one status everything already has would say
 * nothing a person does not already know from having typed the flag.
 */
async function runList(args: string[], ctx: ProposalsContext): Promise<number> {
  const fromStatus = extractValue(args, '--status');
  const fromJson = extractFlag(fromStatus.rest, '--json');
  requireNothingElse(fromJson.rest, 0, 'proposals list');

  const response = await requestJson(
    `${ctx.url}/v1/proposals${queryString({ project_id: ctx.projectId, status: fromStatus.value })}`,
  );

  if (!fromJson.present && response.status >= 200 && response.status < 300) {
    printProposalList(proposalsOf(response.body), fromStatus.value);
  }
  return finish(response, fromJson.present);
}

function printProposalDetail(proposal: ProposalRead): void {
  const lines: string[] = [`#${proposal.id}  ${proposal.status}`];
  lines.push(`graph: ${proposal.graph_id}`);
  lines.push(`target version: ${proposal.target_version}`);
  lines.push('');
  lines.push('diff:');
  for (const line of renderOperations(proposal.operations)) lines.push(`  ${line}`);
  lines.push('');
  lines.push(`evidence: ${JSON.stringify(proposal.evidence)}`);
  lines.push(`expected_metric: ${JSON.stringify(proposal.expected_metric)}`);
  if (proposal.result !== null && proposal.result !== undefined) {
    lines.push(`result: ${JSON.stringify(proposal.result)}`);
  }
  if (proposal.rejection_reason !== null) lines.push(`rejection_reason: ${proposal.rejection_reason}`);
  if (proposal.revert_reason !== null) lines.push(`revert_reason: ${proposal.revert_reason}`);

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * `cartografo proposals show <id> [--json]`.
 *
 * A `404` prints `unknown_proposal` verbatim (FR3) — that IS `errorText`'s
 * output for this route's refusal, which carries no `message`, only `error`.
 */
async function runShow(args: string[], ctx: ProposalsContext): Promise<number> {
  const fromJson = extractFlag(args, '--json');
  requireNothingElse(fromJson.rest, 1, 'proposals show');
  const id = fromJson.rest[0];
  if (id === undefined) throw new UsageError('proposals show needs a proposal id');

  const response = await requestJson(
    `${ctx.url}/v1/proposals/${encodeURIComponent(id)}${queryString({ project_id: ctx.projectId })}`,
  );

  if (!fromJson.present && response.status >= 200 && response.status < 300) {
    const body = response.body as { proposal: ProposalRead };
    printProposalDetail(body.proposal);
  }
  return finish(response, fromJson.present);
}

/* -------------------------------------------------------------- decide */

/**
 * `--by`'s default (FR6): the OS user, guarded — some containers have no
 * passwd entry for the uid the process runs as — falling back to
 * `$USER`/`$USERNAME`, the same identity read `cli/up.ts`'s `os.homedir()`
 * already leans on elsewhere in this CLI.
 */
function resolveOperator(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;

  try {
    const { username } = os.userInfo();
    if (username !== '') return username;
  } catch {
    // No passwd entry for this uid — fall through to the environment.
  }

  const fromEnv = process.env.USER ?? process.env.USERNAME;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  throw new UsageError(
    'could not resolve an operator name for --by (no OS user, and neither USER nor USERNAME is set) — pass --by explicitly',
  );
}

/**
 * `approve`, `apply`, `reject` and `revert` — one function, since all four are
 * `POST /proposals/:id/<verb>` with `{actor}` and, for the reasoned two,
 * `{reason}` (FR4/FR5).
 *
 * Whether `--reason` is even PARSED is what tells the two families apart: for
 * `approve`/`apply` it is left in the argument stream on purpose, so a stray
 * `--reason` falls through to `requireNothingElse` as an extra it does not
 * understand — the same refusal shape every other subcommand already uses
 * (FR4). For `reject`/`revert` it is extracted and checked BEFORE the request
 * goes out: missing or blank is a `UsageError`, never the control plane's own
 * `400 reason_required` (FR5).
 */
async function decide(
  verb: 'approve' | 'apply' | 'reject' | 'revert',
  args: string[],
  ctx: ProposalsContext,
  reasoned: boolean,
): Promise<number> {
  const fromBy = extractValue(args, '--by');
  const fromReason = reasoned ? extractValue(fromBy.rest, '--reason') : { value: undefined, rest: fromBy.rest };
  const fromJson = extractFlag(fromReason.rest, '--json');
  requireNothingElse(fromJson.rest, 1, `proposals ${verb}`);

  const id = fromJson.rest[0];
  if (id === undefined) throw new UsageError(`proposals ${verb} needs a proposal id`);

  const body: Record<string, unknown> = { actor: { type: 'user', ref: resolveOperator(fromBy.value) } };
  if (reasoned) {
    const reason = fromReason.value?.trim();
    if (reason === undefined || reason === '') {
      throw new UsageError(`proposals ${verb} needs --reason`);
    }
    body.reason = reason;
  }

  const response = await requestJson(`${ctx.url}/v1/proposals/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST',
    body,
  });
  return finish(response, fromJson.present);
}

/* --------------------------------------------------------------- router */

const VERBS = ['list', 'show', 'approve', 'apply', 'reject', 'revert'] as const;

/**
 * Dispatches one verb of `cartografo proposals` (FR1).
 *
 * @param verb First positional argument after `proposals`, or `undefined` when
 *   there was none.
 * @param args Everything after the verb.
 * @param ctx `url` and the already-resolved `projectId`.
 * @throws {UsageError} When `verb` is missing or not one of the six words.
 */
export async function runProposals(
  verb: string | undefined,
  args: string[],
  ctx: ProposalsContext,
): Promise<number> {
  switch (verb) {
    case 'list':
      return await runList(args, ctx);
    case 'show':
      return await runShow(args, ctx);
    case 'approve':
      return await decide('approve', args, ctx, false);
    case 'apply':
      return await decide('apply', args, ctx, false);
    case 'reject':
      return await decide('reject', args, ctx, true);
    case 'revert':
      return await decide('revert', args, ctx, true);
    default:
      throw new UsageError(`proposals needs a verb: ${VERBS.join(', ').replace(/, ([^,]+)$/, ' or $1')}`);
  }
}
