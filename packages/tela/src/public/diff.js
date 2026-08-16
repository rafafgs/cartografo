/**
 * The semantic diff of a proposal, in prose (FR5).
 *
 * D15 chose a semantic diff over a line diff precisely so a proposal could be
 * judged instead of merely read: "adds a red team gate before deploy" is a
 * decision someone can make; a JSON blob is a decision someone approves without
 * understanding. So this module owes one readable line per operation, in the
 * vocabulary of `docs/spec/entidades-versionamento.md` §3, and never the raw
 * operation object.
 *
 * Pure and side-effect free, for the same reason as `actions.js`: it runs in
 * the browser and is tested in Node (`test/diff.test.ts`).
 *
 * Nothing here throws. The operations come from the API, and a proposal written
 * by a topographer this screen has never seen (`t110`) may carry a type this
 * vocabulary does not know — one strange line is a bad render, an exception is
 * a blank page over the whole inbox.
 */

/** Shown when a proposal carries no operations at all (AT7). */
export const EMPTY_DIFF_LINE = 'nenhuma alteração';

/** Shown for an entry that is not even an operation object. */
const MALFORMED_LINE = '? operação malformada';

/** Fallback for an operation that does not say which node it is about. */
const MISSING_ID = 'sem id';

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
 * @returns {string} The identifier, or `sem id`.
 */
function asId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : MISSING_ID;
}

/**
 * A field value in one short piece of text.
 *
 * Strings come quoted, so an empty one is visible; objects (a whole `contract`)
 * come as compact JSON, truncated — that is the VALUE being changed, not the
 * operation, and hiding it entirely would make `alterar_campo_no` unjudgeable.
 *
 * @param {unknown} value Value on either side of the change.
 * @returns {string} Readable text.
 */
function describeValue(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (value === null) return 'nulo';
  if (value === undefined) return 'vazio';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return 'valor não exibível';
  }
  if (typeof json !== 'string') return 'valor não exibível';
  return json.length > VALUE_LIMIT ? `${json.slice(0, VALUE_LIMIT)}…` : json;
}

/**
 * One edge, as `de → para`, with the condition when there is one.
 *
 * @param {unknown} edge The `aresta` field of the operation.
 * @returns {string} Readable text.
 */
function describeEdge(edge) {
  const source = isObject(edge) ? asId(edge.from) : MISSING_ID;
  const target = isObject(edge) ? asId(edge.to) : MISSING_ID;
  const condition = isObject(edge) ? edge.condition : undefined;
  const suffix =
    typeof condition === 'string' && condition.trim() !== '' ? ` (condição: ${condition})` : '';
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

  switch (operation.tipo) {
    case 'adicionar_no': {
      const node = operation.no;
      const id = asId(isObject(node) ? node.id : undefined);
      const kind = isObject(node) && typeof node.node_type === 'string' ? node.node_type : '';
      return `+ nó "${id}"${kind === '' ? '' : ` (tipo ${kind})`}`;
    }
    case 'remover_no':
      return `- nó "${asId(operation.no_id)}"`;
    case 'adicionar_aresta':
      return `+ aresta ${describeEdge(operation.aresta)}`;
    case 'remover_aresta':
      return `- aresta ${describeEdge(operation.aresta)}`;
    case 'alterar_campo_no':
      return `~ nó "${asId(operation.no_id)}": campo "${asId(operation.campo)}" de ${describeValue(operation.de)} para ${describeValue(operation.para)}`;
    default:
      return typeof operation.tipo === 'string' && operation.tipo.trim() !== ''
        ? `? operação de tipo desconhecido ("${operation.tipo}")`
        : MALFORMED_LINE;
  }
}

/**
 * The whole diff of a proposal, one line per operation.
 *
 * @param {unknown} operations The `operacoes` field of the proposal.
 * @returns {string[]} One line per operation, or the explicit empty line.
 */
export function renderOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) return [EMPTY_DIFF_LINE];
  return operations.map(renderOperation);
}
