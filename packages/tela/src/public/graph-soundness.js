/**
 * The refusal of the soundness gate, in prose (t170, FR6).
 *
 * `POST /v1/proposals/:id/apply` validates the document that WOULD come out,
 * before writing anything, and answers `422 grafo_invalido` with the whole
 * report when it fails. That report is the most useful thing this page can show
 * — it is the only moment where the system says, in the graph's own vocabulary,
 * why an edit cannot exist — and dumping its JSON on the screen would waste it
 * exactly the way a line diff wastes a semantic one (D15, and §4 of
 * `docs/spec/tela-inbox-propostas.md`).
 *
 * So: one line per problem, each one naming the node or the edge it is about.
 * Structure errors already carry a written `message` and are shown as they
 * came — the control plane wrote them and this page has nothing to add. The
 * four soundness rules carry only a name and a `target`, and turning that pair
 * into a sentence is this module's whole reason to exist.
 *
 * Pure and side-effect free, like `diff.js`, and tested in Node
 * (`test/graph-soundness.test.ts`) even though it runs in the browser. Nothing
 * here throws, for the same reason nothing in `diff.js` does: the report comes
 * from a control plane this page does not control, and one strange line is a
 * bad render while an exception is a refusal nobody gets to read.
 *
 * The report's keys (`structure`, `errors`, `soundness`, `violations`, `rule`,
 * `target`, `message`) and the rule names are the wire format of the 422, and
 * speak English since t230 (`docs/spec/glossario-wire.md` §5.3/5.4) — in
 * lockstep on both sides of the parity between `packages/core` and
 * `scripts/validar-grafo.mjs`. Every LINE this file writes out of them does
 * not: it is product surface in Portuguese (t133, exceptions 9 and 10), which
 * D20 does not touch.
 */

/** Shown when the report carries no problem at all. */
export const NO_PROBLEMS_LINE = 'nenhum problema';

/** Used when a target is there but unnamed — a node with no id, say. */
const MISSING_ID = 'sem id';

/**
 * One sentence per rule, in the order `validateSoundness` runs them.
 *
 * The names are the control plane's own (`RULES` in
 * `packages/core/src/domain/graph.ts`), and `test/graph-soundness.test.ts`
 * holds this table against the four counterexamples of `schema/exemplos/` run
 * through the reference validator — a rule renamed on that side and not here
 * stops producing a sentence, and the test says so instead of the page quietly
 * showing "unknown rule" to whoever is trying to save.
 */
const RULE_LINES = Object.freeze({
  reachable: (target) =>
    `o nó ${nodeName(target)} não é alcançável a partir do nó inicial: falta uma aresta que chegue até ele`,
  terminates: (target) =>
    `do nó ${nodeName(target)} não há caminho até um nó final: quem cair nele não conclui a travessia`,
  edge_with_condition: (target) =>
    `a aresta ${edgeName(target)} está sem condição: uma transição sem rótulo é um caminho que o executor não sabe quando tomar`,
  node_with_contract: (target) =>
    `o nó ${nodeName(target)} não declara skill_ref e contract completos: sem contrato não há como verificar o que ele produziu`,
});

/** The four rule names this mapping covers, in the order the gate runs them. */
export const SOUNDNESS_RULES = Object.freeze(Object.keys(RULE_LINES));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A node id, quoted so an empty one is visible. */
function nodeName(target) {
  return typeof target === 'string' && target.trim() !== '' ? `"${target}"` : `"${MISSING_ID}"`;
}

/**
 * An edge, as `from → to`.
 *
 * The two ends arrive under the document's own keys (`from`/`to`), which is how
 * `validateSoundness` writes the `target` of this one rule since t230.
 */
function edgeName(target) {
  if (!isObject(target)) return `${MISSING_ID} → ${MISSING_ID}`;
  const source = typeof target.from === 'string' && target.from !== '' ? target.from : MISSING_ID;
  const destination = typeof target.to === 'string' && target.to !== '' ? target.to : MISSING_ID;
  return `${source} → ${destination}`;
}

/**
 * One violated rule, as one line.
 *
 * @param {unknown} violation One entry of `soundness.violations`.
 * @returns {string} The line to show.
 */
function renderViolation(violation) {
  if (!isObject(violation)) return 'regra de soundness desconhecida: violação malformada';

  const rule = violation.rule;
  const line = typeof rule === 'string' ? RULE_LINES[rule] : undefined;
  if (line === undefined) {
    const name = typeof rule === 'string' && rule.trim() !== '' ? rule : MISSING_ID;
    return `regra de soundness desconhecida ("${name}") sobre ${JSON.stringify(violation.target ?? null)}`;
  }
  return line(violation.target);
}

/**
 * The whole refusal, one line per problem.
 *
 * @param {unknown} report The 422 body, or anything at all.
 * @returns {string[]} Structure errors first, then soundness violations.
 */
export function renderReport(report) {
  const document = isObject(report) ? report : {};

  const structure = isObject(document.structure) ? document.structure.errors : undefined;
  const lines = (Array.isArray(structure) ? structure : []).map((problem) => {
    if (isObject(problem) && typeof problem.message === 'string' && problem.message !== '') {
      return problem.message;
    }
    return 'problema de estrutura sem mensagem declarada';
  });

  const soundness = isObject(document.soundness) ? document.soundness.violations : undefined;
  for (const violation of Array.isArray(soundness) ? soundness : []) {
    lines.push(renderViolation(violation));
  }

  return lines.length === 0 ? [NO_PROBLEMS_LINE] : lines;
}
