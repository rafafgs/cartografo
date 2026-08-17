/**
 * Validation of the items of an intake draft (t122, FR3/FR4).
 *
 * A pure function, with no `Database` and no clock, in the spirit of
 * `domain/graph.ts` and `domain/operations.ts`: the judgement of "is this
 * breakdown well formed?" is structural, and keeping it here is what lets the
 * routes, and one day the screen, ask the same question of the same code.
 *
 * Two rules give this module its shape:
 *
 * - **The whole report, never the first problem.** Whoever submits a batch of
 *   eight tickets with three broken references wants three lines back, not three
 *   round trips. Same discipline as the graph report and as event validation.
 * - **A dependency only resolves INSIDE the batch.** `depends_on` cites the
 *   `ref` of a sibling item, never a `trabalho` that already exists — crossing
 *   batches is explicitly out of scope, and the confirmation is what turns each
 *   local `ref` into a real id.
 *
 * What is NOT judged here: whether the class exists (that is a database
 * question, and a 404), and whether the dependency should block anybody (it
 * should not — FR14 only records the edge).
 *
 * The item's keys and the report's are the WIRE, and are English since t255.
 * `DraftItem` is the body of `POST /v1/intake` and `ItemProblem[]` is the body of
 * that route's 400, which is D20's own first sentence — "campos e parâmetros de
 * query do JSON da API". Three comments used to claim the opposite here and in
 * `routes/intake.ts`; they were t226 and t229 narrowing their own delivery, not a
 * decision, and the founder settled it on 2026-08-17. The message text around the
 * codes has been English since t180 — the code is what a caller branches on, the
 * prose is what a person reads.
 *
 * Two codes did not survive the translation: `campo_obrigatorio_ausente` and
 * `campo_invalido` became `missing_required_field` and `invalid_field`, which the
 * route beside this one already answered (`routes/intake.ts:100`). One item
 * coming back with two spellings of the same problem was the reason to fold them
 * rather than translate them twice.
 */

import { isObject } from '../util/is-object.ts';
import { isScalarMap, type ScalarMap } from './custom-fields.ts';

/** An item of the draft, already normalized. */
export interface DraftItem {
  /** Identity of the item INSIDE the batch — what `depends_on` cites. */
  ref: string;
  title: string;
  /** Preliminary body; `null` when nobody wrote one. `null` is not `''`. */
  body: string | null;
  /**
   * Preliminary acceptance criteria; `null` when none was declared.
   *
   * `null` is not `[]`: the node that refines is the one that produces the real
   * criteria out of the raw request, and it has to be able to tell "nobody wrote
   * any yet" from "it was declared that there are none".
   */
  acceptance_criteria: string[] | null;
  /**
   * Values of the fields the CLASS declares in its graph (`custom_fields`, t168);
   * `null` when the item declares none.
   *
   * Only the SHAPE is judged here — a map of scalars, like `acceptance_criteria`
   * beside it is a list of texts. Whether the class really declares a field by
   * that name is a graph question, and demanding a mandatory one is the
   * transition gate's business, one layer down and one decision later.
   */
  fields: Record<string, string | number | boolean> | null;
  /**
   * What this item costs to RUN, as the session triaged it (t175); `null` when
   * it did not classify this one.
   *
   * The classification rides the session that already proposes the breakdown —
   * no second session, no extra call — and it is carried onto the job at
   * confirmation. `null` is "unclassified", never "trivial": reading absence as
   * cheap would put every untriaged ticket on a smaller model than anybody
   * chose, which is the same distinction `acceptance_criteria` draws between
   * `null` and `[]` above.
   */
  tier: 'trivial' | 'standard' | null;
  /** Refs of the OTHER items of the batch this one depends on; `[]` when none. */
  depends_on: string[];
}

/**
 * The two tiers, closed here rather than left open like `fields`' keys.
 *
 * This vocabulary is the triage's own — not the class's, not the engine's — so
 * a third value is a mistake by whoever wrote it and not a value some consumer
 * might understand. The same closed set is mirrored in the event contract
 * (`db/event-validation.ts`) and in the migration's `CHECK`.
 */
const TIERS: readonly string[] = ['trivial', 'standard'];

/** One problem found in the batch. Same shape as `StructureError` of the graph. */
export interface ItemProblem {
  code: string;
  message: string;
  /** The `ref` of the offending item, its position when it has no usable `ref`, or the refs of a cycle. */
  target: unknown;
}

/** Verdict over a batch: every problem, and the normalized list when there is none. */
export interface ItemsReport {
  valid: boolean;
  problems: ItemProblem[];
  /** Normalized items — only filled in when `valid` is true. */
  items: DraftItem[];
}

/** The codes this validator emits, so callers do not have to spell them. */
export const PROBLEM_CODES = Object.freeze({
  LIST: 'invalid_list',
  ITEM: 'invalid_item',
  MISSING_FIELD: 'missing_required_field',
  INVALID_FIELD: 'invalid_field',
  DUPLICATE_REF: 'duplicate_ref',
  UNKNOWN_DEPENDENCY: 'unknown_dependency',
  SELF_DEPENDENCY: 'self_dependency',
  CYCLE: 'dependency_cycle',
});

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** A list of filled strings, with no repeats, keeping the order it came in. */
function uniqueTexts(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * One item as it comes out of the shape pass: what could be read, plus whether
 * its `depends_on` is usable by the graph pass.
 */
interface ParsedItem {
  item: DraftItem | null;
  /** `ref` when it is usable, `null` otherwise. The dependency graph ignores the rest. */
  ref: string | null;
  /** Declared dependencies, when the field was a well-formed list. */
  depends_on: string[] | null;
}

/**
 * Checks the shape of one item and reads what it can out of it.
 *
 * A problem does not stop the reading: the goal is to gather EVERY problem of
 * the batch, and an item with a bad body still has a `ref` that the next items'
 * dependencies may cite.
 */
function parseItem(raw: unknown, index: number, note: (problem: ItemProblem) => void): ParsedItem {
  if (!isObject(raw)) {
    note({
      code: PROBLEM_CODES.ITEM,
      message: `the item at position ${index} has to be an object {ref, title, ...}`,
      target: index,
    });
    return { item: null, ref: null, depends_on: null };
  }

  const reference = isFilledText(raw.ref) ? raw.ref.trim() : null;
  if (reference === null) {
    note({
      code: PROBLEM_CODES.MISSING_FIELD,
      message: `required field missing from the item at position ${index}: "ref" (it is what depends_on cites)`,
      target: index,
    });
  }

  // With no usable `ref` the position is the only honest way to point at the item.
  const target: unknown = reference ?? index;
  let broken = reference === null;

  if (!isFilledText(raw.title)) {
    note({
      code: PROBLEM_CODES.MISSING_FIELD,
      message: `required field missing from item "${String(target)}": "title"`,
      target: target,
    });
    broken = true;
  }

  if (!isAbsent(raw.body) && typeof raw.body !== 'string') {
    note({
      code: PROBLEM_CODES.INVALID_FIELD,
      message: `"body" of item "${String(target)}" has to be text`,
      target: target,
    });
    broken = true;
  }

  const criteria = raw.acceptance_criteria;
  const criteriaValid =
    isAbsent(criteria) || (Array.isArray(criteria) && criteria.every(isFilledText));
  if (!criteriaValid) {
    note({
      code: PROBLEM_CODES.INVALID_FIELD,
      message: `"acceptance_criteria" of item "${String(target)}" has to be a list of filled texts`,
      target: target,
    });
    broken = true;
  }

  const fields = raw.fields;
  const fieldsValid = isAbsent(fields) || isScalarMap(fields);
  if (!fieldsValid) {
    note({
      code: PROBLEM_CODES.INVALID_FIELD,
      message: `"fields" of item "${String(target)}" has to be a map of string, number or boolean values`,
      target: target,
    });
    broken = true;
  }

  const tier = raw.tier;
  const tierValid = isAbsent(tier) || (typeof tier === 'string' && TIERS.includes(tier));
  if (!tierValid) {
    note({
      code: PROBLEM_CODES.INVALID_FIELD,
      message: `"tier" of item "${String(target)}" has to be one of: ${TIERS.join(', ')}`,
      target: target,
    });
    broken = true;
  }

  const dependencies = raw.depends_on;
  const dependenciesValid =
    isAbsent(dependencies) || (Array.isArray(dependencies) && dependencies.every(isFilledText));
  if (!dependenciesValid) {
    note({
      code: PROBLEM_CODES.INVALID_FIELD,
      message: `"depends_on" of item "${String(target)}" has to be a list of refs from the batch itself`,
      target: target,
    });
    broken = true;
  }

  const declared = dependenciesValid
    ? uniqueTexts((isAbsent(dependencies) ? [] : (dependencies as string[])).map((ref) => ref.trim()))
    : null;

  return {
    item: broken
      ? null
      : {
          ref: reference as string,
          title: (raw.title as string).trim(),
          body: isAbsent(raw.body) ? null : (raw.body as string),
          acceptance_criteria: isAbsent(criteria) ? null : (criteria as string[]),
          fields: isAbsent(fields) ? null : (fields as ScalarMap),
          tier: isAbsent(tier) ? null : (tier as DraftItem['tier']),
          depends_on: declared ?? [],
        },
    ref: reference,
    depends_on: declared,
  };
}

/**
 * Looks for a cycle walking the declared dependencies (depth-first, three colours).
 *
 * Grey = on the current path, black = already closed. Hitting a GREY node is a
 * cycle; hitting a black one is just a node reached twice — a diamond
 * (`a` depends on `b` and `c`, both depending on `d`) is a perfectly good
 * breakdown, and a walk that confuses the two rejects it.
 *
 * @param edges Dependencies of each ref, already resolved inside the batch.
 * @param order Refs in the order they were declared, so the report is deterministic.
 * @returns The cycles found, each as the path that closes it.
 */
function findCycles(edges: Map<string, string[]>, order: string[]): string[][] {
  const cycles: string[][] = [];
  const closed = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  const walk = (ref: string): void => {
    if (closed.has(ref)) return;
    if (onPath.has(ref)) {
      // The cycle is the tail of the path from the repeated ref onwards, closed
      // by the ref itself: `a → b → a` comes back as ["a", "b", "a"].
      cycles.push([...path.slice(path.indexOf(ref)), ref]);
      return;
    }

    onPath.add(ref);
    path.push(ref);
    for (const next of edges.get(ref) ?? []) walk(next);
    path.pop();
    onPath.delete(ref);
    closed.add(ref);
  };

  for (const ref of order) walk(ref);
  return cycles;
}

/**
 * Validates the `items` of a draft: shape, unique refs, dependencies and cycles.
 *
 * @param raw The `items` list exactly as it came in the request body.
 * @returns Every problem found, and the normalized items when there is none.
 */
export function validateItems(raw: unknown): ItemsReport {
  const problems: ItemProblem[] = [];
  const note = (problem: ItemProblem): void => {
    problems.push(problem);
  };

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      valid: false,
      problems: [
        {
          code: PROBLEM_CODES.LIST,
          message: '"items" has to be a non-empty list: intake breaks work down into tickets',
          target: null,
        },
      ],
      items: [],
    };
  }

  const parsed = raw.map((item, index) => parseItem(item, index, note));

  // Unique refs, reported once per repeated ref: the same `ref` twice makes
  // every `depends_on` that cites it ambiguous.
  const known = new Set<string>();
  const alreadyReported = new Set<string>();
  for (const entry of parsed) {
    if (entry.ref === null) continue;
    if (known.has(entry.ref)) {
      if (!alreadyReported.has(entry.ref)) {
        note({
          code: PROBLEM_CODES.DUPLICATE_REF,
          message: `two items of the batch use the same ref: "${entry.ref}"`,
          target: entry.ref,
        });
        alreadyReported.add(entry.ref);
      }
      continue;
    }
    known.add(entry.ref);
  }

  // Dependency resolution. Only edges between two known refs enter the graph: a
  // dangling end is the problem reported right here, and walking it would invent
  // a cycle that does not exist.
  const edges = new Map<string, string[]>();
  const order: string[] = [];
  for (const entry of parsed) {
    if (entry.ref === null || entry.depends_on === null) continue;
    if (!edges.has(entry.ref)) {
      edges.set(entry.ref, []);
      order.push(entry.ref);
    }
    for (const dependency of entry.depends_on) {
      if (dependency === entry.ref) {
        note({
          code: PROBLEM_CODES.SELF_DEPENDENCY,
          message: `item "${entry.ref}" declares that it depends on itself`,
          target: entry.ref,
        });
        continue;
      }
      if (!known.has(dependency)) {
        note({
          code: PROBLEM_CODES.UNKNOWN_DEPENDENCY,
          message: `item "${entry.ref}" depends on "${dependency}", which is not the ref of any item in this batch`,
          target: { ref: entry.ref, depends_on: dependency },
        });
        continue;
      }
      edges.get(entry.ref)?.push(dependency);
    }
  }

  for (const cycle of findCycles(edges, order)) {
    note({
      code: PROBLEM_CODES.CYCLE,
      message: `the dependencies close a cycle: ${cycle.join(' → ')}`,
      target: cycle,
    });
  }

  const valid = problems.length === 0;
  return {
    valid: valid,
    problems: problems,
    items: valid ? parsed.map((entry) => entry.item as DraftItem) : [],
  };
}
