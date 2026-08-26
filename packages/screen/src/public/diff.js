/**
 * The semantic diff of a proposal, in prose (FR5).
 *
 * D15 chose a semantic diff over a line diff precisely so a proposal could be
 * judged instead of merely read: "adds a red team gate before deploy" is a
 * decision someone can make; a JSON blob is a decision someone approves without
 * understanding. So this module owes one readable line per operation, in the
 * vocabulary of `docs/spec/entities-versioning.md` §3, and never the raw
 * operation object.
 *
 * Pure and side-effect free, for the same reason as `actions.js`: it runs in
 * the browser and is tested in Node (`test/diff.test.ts`).
 *
 * Nothing here throws. The operations come from the API, and a proposal written
 * by a topographer this screen has never seen (`t110`) may carry a type this
 * vocabulary does not know — one strange line is a bad render, an exception is
 * a blank page over the whole inbox.
 *
 * What it READS is §3 English since D20's third child (t228); what it WRITES
 * went English later, with the rest of the screen's copy (t310). The two halves
 * moved for unrelated reasons — one is a wire format, the other is the sentence
 * a person approves a change by — and only one thing here is still passed
 * through untranslated: the `condition` VALUE of an edge, which is free text
 * somebody typed into the graph document and not this module's prose.
 */

/** Shown when a proposal carries no operations at all (AT7). */
export const EMPTY_DIFF_LINE = 'no change';

/** Shown for an entry that is not even an operation object. */
const MALFORMED_LINE = '? malformed operation';

/** Fallback for an operation that does not say which node it is about. */
const MISSING_ID = 'no id';

/** How much of an object value is shown before it stops being readable. */
const VALUE_LIMIT = 60;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A node/edge identifier as text, with an honest fallback.
 *
 * @param {unknown} value Candidate identifier.
 * @returns {string} The identifier, or `no id`.
 */
function asId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : MISSING_ID;
}

/**
 * A field value in one short piece of text.
 *
 * Strings come quoted, so an empty one is visible; objects (a whole `contract`)
 * come as compact JSON, truncated — that is the VALUE being changed, not the
 * operation, and hiding it entirely would make `change_node_field` unjudgeable.
 *
 * @param {unknown} value Value on either side of the change.
 * @returns {string} Readable text.
 */
function describeValue(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'null';
  if (value === undefined) return 'empty';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return 'unprintable value';
  }
  if (typeof json !== 'string') return 'unprintable value';
  return json.length > VALUE_LIMIT ? `${json.slice(0, VALUE_LIMIT)}…` : json;
}

/**
 * One edge, as `from → to`, with the condition when there is one.
 *
 * @param {unknown} edge The `edge` field of the operation.
 * @returns {string} Readable text.
 */
function describeEdge(edge) {
  const source = isObject(edge) ? asId(edge.from) : MISSING_ID;
  const target = isObject(edge) ? asId(edge.to) : MISSING_ID;
  const condition = isObject(edge) ? edge.condition : undefined;
  const suffix =
    typeof condition === 'string' && condition.trim() !== '' ? ` (condition: ${condition})` : '';
  return `${source} → ${target}${suffix}`;
}

/**
 * One operation, as one line.
 *
 * @param {unknown} operation Operation as it came from the API.
 * @returns {string} The line to show.
 */
function renderOperation(operation) {
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

/**
 * The whole diff of a proposal, one line per operation.
 *
 * @param {unknown} operations The `operations` field of the proposal.
 * @returns {string[]} One line per operation, or the explicit empty line.
 */
export function renderOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return [EMPTY_DIFF_LINE];
  return operations.map(renderOperation);
}
