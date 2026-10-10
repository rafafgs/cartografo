/**
 * The placeholders of a subgraph node, resolved (t638, FR10/FR11).
 *
 * A subgraph node's `subgraph` block says three things in strings: what each
 * child job is created with (`input_map`), which list the node fans out over
 * (`fan_out.over`), and what the node's own output collects from each child
 * (`output_map`). This module turns those strings into values, and does
 * nothing else — no I/O, no client, no clock. `subgraph-run.ts` reads the
 * control plane and hands the results in.
 *
 * **The grammar is `docs/spec/graph.md`'s, and only that.** A token is
 * `{{<root>}}` or `{{<root>.<path>}}`, the path written exactly as
 * `interpolate-input.ts` writes it (segments `[a-zA-Z0-9_]+` joined by `.`,
 * walked through objects only). A value that is EXACTLY one token keeps the
 * resolved value's type, so `{{input.n}}` stays a number and `{{child.items}}`
 * stays a list. A token inside text is stringified — strings as they are,
 * anything else as JSON, `interpolate()`'s own rule. A value with no token is a
 * literal. Registration has already refused a token that does not fit its
 * position (t637), so a root this module does not expect is read as a path
 * that does not resolve, never as text.
 *
 * **Every problem, not the first.** A mapping that fails is reported whole, in
 * one {@link SubgraphMappingError}: whoever unblocks the work has to fix the
 * map, and a list cut short is a second round of the same conversation — the
 * posture `blockForOutputSchemaRefusal` already takes.
 */

/** The `subgraph` block of a node, in the part this module reads. */
export interface SubgraphCall {
  /** The called problem class. */
  class?: unknown;
  /** The child job's creation payload: `title`, `body`, `fields`. */
  input_map?: Record<string, unknown>;
  /** Keys of this node's own output, each read from the child. */
  output_map?: Record<string, unknown>;
  /** One child per element of the list at `over`; `ordered` chains them. */
  fan_out?: { over?: unknown; ordered?: unknown };
}

/** What one child job is created with, already resolved. */
export interface ChildPayload {
  title: string;
  body?: string;
  fields?: Record<string, string | number | boolean>;
}

/** What one child handed back, as the assembly reads it. */
export interface ChildState {
  /** The child job's id, named in a problem. */
  jobId: number;
  /** Its `sibling_position` under the parent; the output is in this order. */
  position: number;
  /** Its own node input (`GET /v1/jobs/:id/context`), what `{{child.…}}` reads. */
  input: Record<string, unknown>;
}

/** A mapping that does not resolve, with every reason it gave. */
export class SubgraphMappingError extends Error {
  /** Each problem, readable on its own. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the subgraph mapping does not resolve: ${problems.join('; ')}`);
    this.name = 'SubgraphMappingError';
    this.problems = problems;
  }
}

/** Every token, anywhere in a string. */
const TOKEN = /\{\{([^{}]*)\}\}/g;

/** A string that is one token and nothing else. */
const WHOLE_TOKEN = /^\{\{([^{}]*)\}\}$/;

/** The path grammar the manifest format declares (`interpolate-input.ts`). */
const PATH = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Nothing resolved. */
const UNRESOLVED = Symbol('unresolved');

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walks a dotted path through objects, `interpolate-input.ts`'s walk. */
function walk(from: unknown, path: string): unknown {
  let current = from;
  for (const segment of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return UNRESOLVED;
    current = current[segment];
  }
  return current === undefined ? UNRESOLVED : current;
}

/**
 * Resolves one token's inside — `item`, `input.job.title` — against the roots
 * this position allows. A root that is bare (`{{item}}`) is the root's value.
 */
function resolveToken(inside: string, roots: Readonly<Record<string, unknown>>): unknown {
  if (!PATH.test(inside)) return UNRESOLVED;
  const [root, ...rest] = inside.split('.');
  if (!Object.hasOwn(roots, root)) return UNRESOLVED;
  const value = roots[root];
  if (rest.length === 0) return value === undefined ? UNRESOLVED : value;
  return walk(value, rest.join('.'));
}

/** Stringified the way `interpolate()` stringifies a placeholder. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Resolves one mapped value. Unresolved paths are pushed to `unresolved` (once
 * each) and the caller decides what to throw.
 */
function resolveValue(
  value: unknown,
  roots: Readonly<Record<string, unknown>>,
  unresolved: string[],
): unknown {
  if (typeof value !== 'string') return value;
  const note = (inside: string): void => {
    const token = `{{${inside}}}`;
    if (!unresolved.includes(token)) unresolved.push(token);
  };

  const whole = WHOLE_TOKEN.exec(value);
  if (whole !== null) {
    const resolved = resolveToken(whole[1], roots);
    if (resolved === UNRESOLVED) note(whole[1]);
    return resolved;
  }
  return value.replace(TOKEN, (token, inside: string) => {
    const resolved = resolveToken(inside, roots);
    if (resolved !== UNRESOLVED) return asText(resolved);
    note(inside);
    return token;
  });
}

/**
 * The list a fan-out walks, or `null` when the node declares none.
 *
 * `over` is a dotted path into the parent node's input — `plan.items`, with no
 * `input.` prefix, the way the format writes it.
 *
 * @param call The node's `subgraph` block.
 * @param input The parent node's input.
 * @returns The elements, in order; `null` without a `fan_out`.
 * @throws {SubgraphMappingError} When `over` does not resolve or is not a list.
 */
export function fanOutItems(
  call: SubgraphCall,
  input: Record<string, unknown>,
): readonly unknown[] | null {
  if (call.fan_out === undefined) return null;
  const over = call.fan_out.over;
  const resolved = typeof over === 'string' && PATH.test(over) ? walk(input, over) : UNRESOLVED;
  if (resolved === UNRESOLVED) {
    throw new SubgraphMappingError([`fan_out.over \`${String(over)}\` does not resolve`]);
  }
  if (!Array.isArray(resolved)) {
    throw new SubgraphMappingError([
      `fan_out.over \`${String(over)}\` resolves to ${resolved === null ? 'null' : typeof resolved}, ` +
        'not a list',
    ]);
  }
  return resolved;
}

/**
 * The creation payload of one child, out of `input_map`.
 *
 * `title` has to come out a non-empty string, `body` a string, and each
 * `fields` value a text, number or boolean — the shapes `POST /v1/jobs`
 * accepts. Every unresolved path and every wrong type is collected first.
 *
 * @param call The node's `subgraph` block.
 * @param input The parent node's input, what `{{input.…}}` reads.
 * @param item The current list element, what `{{item…}}` reads; absent
 *   without a fan-out.
 * @returns The payload.
 * @throws {SubgraphMappingError} With every problem found.
 */
export function childPayload(
  call: SubgraphCall,
  input: Record<string, unknown>,
  item?: unknown,
): ChildPayload {
  const map = call.input_map ?? {};
  const roots: Record<string, unknown> = item === undefined ? { input } : { input, item };
  const unresolved: string[] = [];
  const problems: string[] = [];

  const title = resolveValue(map.title, roots, unresolved);
  const body = map.body === undefined ? undefined : resolveValue(map.body, roots, unresolved);
  const fields: Record<string, unknown> = {};
  if (isObject(map.fields)) {
    for (const [key, value] of Object.entries(map.fields)) {
      fields[key] = resolveValue(value, roots, unresolved);
    }
  }

  for (const token of unresolved) problems.push(`input_map: \`${token}\` does not resolve`);
  if (problems.length > 0) throw new SubgraphMappingError(problems);

  if (typeof title !== 'string' || title.trim() === '') {
    problems.push('input_map.title has to resolve to a non-empty text');
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    problems.push('input_map.body has to resolve to a text');
  }
  for (const [key, value] of Object.entries(fields)) {
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      problems.push(`input_map.fields.${key} has to resolve to a text, a number or a boolean`);
    }
  }
  if (problems.length > 0) throw new SubgraphMappingError(problems);

  return {
    title: title as string,
    ...(typeof body === 'string' ? { body } : {}),
    ...(Object.keys(fields).length === 0
      ? {}
      : { fields: fields as Record<string, string | number | boolean> }),
  };
}

/**
 * The node's own output, out of `output_map` and what the children hold.
 *
 * One key per `output_map` key. Without a fan-out the value is the single
 * child's; with one it is a list with one entry per child, in
 * `sibling_position` order — so with a fan-out every mapped property is a list,
 * including when there are no children at all.
 *
 * @param call The node's `subgraph` block.
 * @param children Every child of this node, in any order.
 * @returns The output object.
 * @throws {SubgraphMappingError} Naming each child job and path that did not
 *   resolve.
 */
export function assembleOutput(
  call: SubgraphCall,
  children: readonly ChildState[],
): Record<string, unknown> {
  const ordered = [...children].sort((a, b) => a.position - b.position);
  const map = call.output_map ?? {};
  const problems: string[] = [];
  const perChild = ordered.map((child) => {
    const unresolved: string[] = [];
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(map)) {
      values[key] = resolveValue(value, { child: child.input }, unresolved);
    }
    for (const token of unresolved) {
      problems.push(`child job ${String(child.jobId)}: \`${token}\` does not resolve`);
    }
    return values;
  });
  if (problems.length > 0) throw new SubgraphMappingError(problems);

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    output[key] =
      call.fan_out === undefined ? perChild[0]?.[key] : perChild.map((values) => values[key]);
  }
  return output;
}
