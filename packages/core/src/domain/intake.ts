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
 * - **A dependency only resolves INSIDE the batch.** `depende_de` cites the
 *   `ref` of a sibling item, never a `trabalho` that already exists — crossing
 *   batches is explicitly out of scope, and the confirmation is what turns each
 *   local `ref` into a real id.
 *
 * What is NOT judged here: whether the class exists (that is a database
 * question, and a 404), and whether the dependency should block anybody (it
 * should not — FR14 only records the edge).
 *
 * The report's keys and codes stay in Portuguese: this report IS the body of the
 * 400 the intake routes answer, the same convention as the graph report
 * (t127, FR8). The message text around them is English since t180 — the codes
 * are what a caller branches on, the prose is what a person reads.
 */

/** An item of the draft, already normalized. */
export interface DraftItem {
  /** Identity of the item INSIDE the batch — what `depende_de` cites. */
  ref: string;
  titulo: string;
  /** Preliminary body; `null` when nobody wrote one. `null` is not `''`. */
  corpo: string | null;
  /**
   * Preliminary acceptance criteria; `null` when none was declared.
   *
   * `null` is not `[]`: the node that refines is the one that produces the real
   * criteria out of the raw request, and it has to be able to tell "nobody wrote
   * any yet" from "it was declared that there are none".
   */
  criterios_de_aceite: string[] | null;
  /** Refs of the OTHER items of the batch this one depends on; `[]` when none. */
  depende_de: string[];
}

/** One problem found in the batch. Same shape as `StructureError` of the graph. */
export interface ItemProblem {
  codigo: string;
  mensagem: string;
  /** The `ref` of the offending item, its position when it has no usable `ref`, or the refs of a cycle. */
  alvo: unknown;
}

/** Verdict over a batch: every problem, and the normalized list when there is none. */
export interface ItemsReport {
  valido: boolean;
  problemas: ItemProblem[];
  /** Normalized items — only filled in when `valido` is true. */
  itens: DraftItem[];
}

/** The codes this validator emits, so callers do not have to spell them. */
export const PROBLEM_CODES = Object.freeze({
  LIST: 'lista_invalida',
  ITEM: 'item_invalido',
  MISSING_FIELD: 'campo_obrigatorio_ausente',
  INVALID_FIELD: 'campo_invalido',
  DUPLICATE_REF: 'ref_duplicado',
  UNKNOWN_DEPENDENCY: 'dependencia_desconhecida',
  SELF_DEPENDENCY: 'dependencia_de_si_mesmo',
  CYCLE: 'ciclo_de_dependencia',
});

type PlainObject = Record<string, unknown>;

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
 * its `depende_de` is usable by the graph pass.
 */
interface ParsedItem {
  item: DraftItem | null;
  /** `ref` when it is usable, `null` otherwise. The dependency graph ignores the rest. */
  ref: string | null;
  /** Declared dependencies, when the field was a well-formed list. */
  depende_de: string[] | null;
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
      codigo: PROBLEM_CODES.ITEM,
      mensagem: `the item at position ${index} has to be an object {ref, titulo, ...}`,
      alvo: index,
    });
    return { item: null, ref: null, depende_de: null };
  }

  const reference = isFilledText(raw.ref) ? raw.ref.trim() : null;
  if (reference === null) {
    note({
      codigo: PROBLEM_CODES.MISSING_FIELD,
      mensagem: `required field missing from the item at position ${index}: "ref" (it is what depende_de cites)`,
      alvo: index,
    });
  }

  // With no usable `ref` the position is the only honest way to point at the item.
  const target: unknown = reference ?? index;
  let broken = reference === null;

  if (!isFilledText(raw.titulo)) {
    note({
      codigo: PROBLEM_CODES.MISSING_FIELD,
      mensagem: `required field missing from item "${String(target)}": "titulo"`,
      alvo: target,
    });
    broken = true;
  }

  if (!isAbsent(raw.corpo) && typeof raw.corpo !== 'string') {
    note({
      codigo: PROBLEM_CODES.INVALID_FIELD,
      mensagem: `"corpo" of item "${String(target)}" has to be text`,
      alvo: target,
    });
    broken = true;
  }

  const criteria = raw.criterios_de_aceite;
  const criteriaValid =
    isAbsent(criteria) || (Array.isArray(criteria) && criteria.every(isFilledText));
  if (!criteriaValid) {
    note({
      codigo: PROBLEM_CODES.INVALID_FIELD,
      mensagem: `"criterios_de_aceite" of item "${String(target)}" has to be a list of filled texts`,
      alvo: target,
    });
    broken = true;
  }

  const dependencies = raw.depende_de;
  const dependenciesValid =
    isAbsent(dependencies) || (Array.isArray(dependencies) && dependencies.every(isFilledText));
  if (!dependenciesValid) {
    note({
      codigo: PROBLEM_CODES.INVALID_FIELD,
      mensagem: `"depende_de" of item "${String(target)}" has to be a list of refs from the batch itself`,
      alvo: target,
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
          titulo: (raw.titulo as string).trim(),
          corpo: isAbsent(raw.corpo) ? null : (raw.corpo as string),
          criterios_de_aceite: isAbsent(criteria) ? null : (criteria as string[]),
          depende_de: declared ?? [],
        },
    ref: reference,
    depende_de: declared,
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
 * Validates the `itens` of a draft: shape, unique refs, dependencies and cycles.
 *
 * @param raw The `itens` list exactly as it came in the request body.
 * @returns Every problem found, and the normalized items when there is none.
 */
export function validateItems(raw: unknown): ItemsReport {
  const problems: ItemProblem[] = [];
  const note = (problem: ItemProblem): void => {
    problems.push(problem);
  };

  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      valido: false,
      problemas: [
        {
          codigo: PROBLEM_CODES.LIST,
          mensagem: '"itens" has to be a non-empty list: intake breaks work down into tickets',
          alvo: null,
        },
      ],
      itens: [],
    };
  }

  const parsed = raw.map((item, index) => parseItem(item, index, note));

  // Unique refs, reported once per repeated ref: the same `ref` twice makes
  // every `depende_de` that cites it ambiguous.
  const known = new Set<string>();
  const alreadyReported = new Set<string>();
  for (const entry of parsed) {
    if (entry.ref === null) continue;
    if (known.has(entry.ref)) {
      if (!alreadyReported.has(entry.ref)) {
        note({
          codigo: PROBLEM_CODES.DUPLICATE_REF,
          mensagem: `two items of the batch use the same ref: "${entry.ref}"`,
          alvo: entry.ref,
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
    if (entry.ref === null || entry.depende_de === null) continue;
    if (!edges.has(entry.ref)) {
      edges.set(entry.ref, []);
      order.push(entry.ref);
    }
    for (const dependency of entry.depende_de) {
      if (dependency === entry.ref) {
        note({
          codigo: PROBLEM_CODES.SELF_DEPENDENCY,
          mensagem: `item "${entry.ref}" declares that it depends on itself`,
          alvo: entry.ref,
        });
        continue;
      }
      if (!known.has(dependency)) {
        note({
          codigo: PROBLEM_CODES.UNKNOWN_DEPENDENCY,
          mensagem: `item "${entry.ref}" depends on "${dependency}", which is not the ref of any item in this batch`,
          alvo: { ref: entry.ref, depende_de: dependency },
        });
        continue;
      }
      edges.get(entry.ref)?.push(dependency);
    }
  }

  for (const cycle of findCycles(edges, order)) {
    note({
      codigo: PROBLEM_CODES.CYCLE,
      mensagem: `the dependencies close a cycle: ${cycle.join(' → ')}`,
      alvo: cycle,
    });
  }

  const valid = problems.length === 0;
  return {
    valido: valid,
    problemas: problems,
    itens: valid ? parsed.map((entry) => entry.item as DraftItem) : [],
  };
}
