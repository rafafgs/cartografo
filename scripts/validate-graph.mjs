/**
 * Reference validator of the graph document (t96).
 *
 * Two checks, deliberately kept apart:
 *
 * - `validarEstrutura(doc)` — shape and referential integrity: required keys
 *   present, node ids unique, every edge and every id in
 *   `initial_node`/`final_nodes` pointing at a node that exists, and — since
 *   t169 — every hook id unique with its `node_id` pointing at a node that
 *   exists too. Since t256 a hook also answers for its own content: a `trigger`
 *   inside the taxonomy and a `destination` naming the HMAC key instead of
 *   carrying it.
 * - `validarSoundness(doc)` — the four formal workflow-net rules (van der
 *   Aalst) the graph validation gate applies: reachable, terminates,
 *   edge with condition, node with contract.
 *
 * The two run independently and neither throws on a malformed document: the
 * synthesizer (D10) builds graphs in memory and needs a report of everything
 * that is wrong, not the first error.
 *
 * Zero dependencies: only Node built-ins. Full SHAPE validation against
 * `schema/graph.schema.json` (via ajv or equivalent) arrives with the control
 * plane's TypeScript scaffold — here the validator covers what it takes to
 * prove the fixtures.
 *
 * ## Why the four exported names stay in Portuguese, and nothing else does
 *
 * `packages/core/test/domain-graph.test.ts` imports this file BY PATH,
 * destructures it by the names `validarEstrutura` / `validarSoundness`, and
 * `deepEqual`s its report against the TypeScript port in
 * `packages/core/src/domain/graph.ts` on every fixture in `schema/examples/`.
 * Renaming one of the four exports turns core's suite red without a line of core
 * changing, so they stay until `scripts/`' own D18 identifier migration — a
 * ticket that does not exist yet (t133, exception 5).
 *
 * Everything else here is English, and the REPORT is the newest half of that.
 * Its keys, codes and rule-name values (`valid`, `errors`, `violations`, `code`,
 * `message`, `target`, `rule`, `structure`) moved with t230, the fifth child of
 * D20, out of `docs/spec/glossary-wire.md` §5.3/5.4. That parity above is why
 * it moved in LOCKSTEP with the port, in one delivery: the test compares the two
 * reports whole, so a key renamed on one side and not the other fails there,
 * loudly, on the next run.
 *
 * The same lockstep already applied to what the report CARRIES: the message
 * prose moved to English with t180, and the field names quoted inside those
 * messages with the document's own keys in t178. What used to be an asymmetry —
 * an English document described by a Portuguese report — is now one vocabulary
 * from the document all the way out to the 422.
 *
 * CLI use: `node scripts/validate-graph.mjs schema/examples/*.json`
 */

import { readFileSync } from 'node:fs';

/**
 * Names of the four soundness rules, in the order they run.
 *
 * The KEYS match `packages/core/src/domain/graph.ts`'s `RULES` so the two
 * byte-for-byte siblings read the same side by side; the VALUES are what the
 * reports compare on, so they move in the same delivery on both sides or not
 * at all (t230, glossary §5.4).
 */
export const RULES = Object.freeze({
  REACHABLE: 'reachable',
  TERMINATES: 'terminates',
  EDGE_WITH_CONDITION: 'edge_with_condition',
  NODE_WITH_CONTRACT: 'node_with_contract',
});

const REQUIRED_DOC_FIELDS = [
  'problem_class',
  'lineage',
  'metadata',
  'nodes',
  'edges',
  'initial_node',
  'final_nodes',
  'custom_fields',
];
const REQUIRED_NODE_FIELDS = ['id', 'role', 'node_type', 'skill_ref', 'contract'];
const REQUIRED_EDGE_FIELDS = ['from', 'to', 'condition'];
const REQUIRED_HOOK_FIELDS = ['id', 'trigger', 'node_id', 'destination'];

/**
 * What a hook may react to — `schema/graph.schema.json`'s own closed enum.
 *
 * Written down here because the schema is not what refuses a third value:
 * `POST /v1/graphs` declares no ajv against it (draft 2020-12 against the
 * draft-07 ajv Fastify v5 ships), so until t256 the enum was documentation and
 * the hooks loop below was the whole gate.
 */
const HOOK_TRIGGERS = ['node_entered', 'node_blocked'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFilledText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Checks the document's shape and referential integrity.
 *
 * @param {unknown} doc Graph document, already parsed.
 * @returns {{valid: boolean, errors: Array<{code: string, message: string, target: unknown}>}}
 */
export function validarEstrutura(doc) {
  const errors = [];
  const annotate = (code, message, target = null) =>
    errors.push({ code, message, target });

  if (!isObject(doc)) {
    annotate('invalid_document', 'graph document has to be a JSON object');
    return { valid: false, errors };
  }

  for (const field of REQUIRED_DOC_FIELDS) {
    if (doc[field] === undefined || doc[field] === null) {
      annotate('missing_required_field', `required field missing from the document: "${field}"`, field);
    }
  }

  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    annotate('invalid_field', '"nodes" has to be a list', 'nodes');
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    annotate('invalid_field', '"edges" has to be a list', 'edges');
  }
  if (doc.final_nodes !== undefined && !Array.isArray(doc.final_nodes)) {
    annotate('invalid_field', '"final_nodes" has to be a list', 'final_nodes');
  }
  // The list itself and nothing inside it: what each declaration has to look
  // like is the schema's business, and cross-checking `required_at` against the
  // node ids is deliberately not done here (t168, out of scope) — an unreachable
  // `required_at` fails inertly, demanding nothing of nobody.
  if (doc.custom_fields !== undefined && !Array.isArray(doc.custom_fields)) {
    annotate('invalid_field', '"custom_fields" has to be a list', 'custom_fields');
  }
  if (doc.hooks !== undefined && !Array.isArray(doc.hooks)) {
    annotate('invalid_field', '"hooks" has to be a list', 'hooks');
  }

  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const knownIds = new Set();
  const reportedIds = new Set();

  nodes.forEach((node, index) => {
    if (!isObject(node)) {
      annotate('invalid_node', `the node at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        annotate(
          'missing_required_field',
          `required field missing from node "${node.id ?? `#${index}`}": "${field}"`,
          node.id ?? index,
        );
      }
    }
    if (!isFilledText(node.id)) {
      // Present but not a filled text: the loop above only catches the ABSENT
      // id, and without this the node would leave the scene in silence —
      // never entering `knownIds`, never being checked by soundness.
      if (node.id !== undefined && node.id !== null) {
        annotate(
          'invalid_id',
          `the id of the node at position ${index} has to be a filled text: ${JSON.stringify(node.id)}`,
          index,
        );
      }
      return;
    }
    if (knownIds.has(node.id)) {
      if (!reportedIds.has(node.id)) {
        annotate('duplicate_node_id', `duplicate node id in the document: "${node.id}"`, node.id);
        reportedIds.add(node.id);
      }
      return;
    }
    knownIds.add(node.id);
  });

  const edges = Array.isArray(doc.edges) ? doc.edges : [];
  edges.forEach((edge, index) => {
    if (!isObject(edge)) {
      annotate('invalid_edge', `the edge at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_EDGE_FIELDS) {
      if (edge[field] === undefined || edge[field] === null) {
        annotate(
          'missing_required_field',
          `required field missing from edge #${index}: "${field}"`,
          { from: edge.from ?? null, to: edge.to ?? null },
        );
      }
    }
    for (const side of ['from', 'to']) {
      const target = edge[side];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          annotate(
            'invalid_id',
            `edge #${index} needs a filled text in "${side}": ${JSON.stringify(target)}`,
            { from: edge.from ?? null, to: edge.to ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        annotate(
          'edge_unknown_node',
          `edge #${index} references in "${side}" a node that does not exist: "${target}"`,
          { from: edge.from ?? null, to: edge.to ?? null },
        );
      }
    }
  });

  // The two are mutually exclusive: an id of the wrong type is not an id
  // pointing at a missing node, and only the second one gets to be a reference
  // problem.
  if (!isFilledText(doc.initial_node)) {
    if (doc.initial_node !== undefined && doc.initial_node !== null) {
      annotate(
        'invalid_id',
        `initial_node has to be a filled text: ${JSON.stringify(doc.initial_node)}`,
        'initial_node',
      );
    }
  } else if (!knownIds.has(doc.initial_node)) {
    annotate('unknown_initial_node', `initial_node references a node that does not exist: "${doc.initial_node}"`, doc.initial_node);
  }

  const finals = Array.isArray(doc.final_nodes) ? doc.final_nodes : [];
  if (Array.isArray(doc.final_nodes) && finals.length === 0) {
    annotate('invalid_field', '"final_nodes" has to list at least one node', 'final_nodes');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((finalId, index) => {
    if (!isFilledText(finalId)) {
      annotate(
        'invalid_id',
        `the id in final_nodes at position ${index} has to be a filled text: ${JSON.stringify(finalId)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(finalId)) {
      annotate('unknown_final_node', `final_nodes references a node that does not exist: "${finalId}"`, finalId);
    }
  });

  // Hooks (t169). Referential integrity, exactly like an edge's endpoints: a
  // reaction that names a node the document does not have would be a reaction
  // that can never fire, and a document that declares one is wrong now rather
  // than mysteriously silent later. Uniqueness of the hook id follows the node
  // id's rule for the same reason — it is the name the delivery row carries,
  // and two hooks answering to one name make the log ambiguous.
  const hooks = Array.isArray(doc.hooks) ? doc.hooks : [];
  const knownHookIds = new Set();
  const reportedHookIds = new Set();

  hooks.forEach((hook, index) => {
    if (!isObject(hook)) {
      annotate('invalid_hook', `the hook at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_HOOK_FIELDS) {
      if (hook[field] === undefined || hook[field] === null) {
        annotate(
          'missing_required_field',
          `required field missing from hook "${hook.id ?? `#${index}`}": "${field}"`,
          hook.id ?? index,
        );
      }
    }

    if (!isFilledText(hook.id)) {
      if (hook.id !== undefined && hook.id !== null) {
        annotate(
          'invalid_id',
          `the id of the hook at position ${index} has to be a filled text: ${JSON.stringify(hook.id)}`,
          index,
        );
      }
    } else if (knownHookIds.has(hook.id)) {
      if (!reportedHookIds.has(hook.id)) {
        annotate('duplicate_hook_id', `duplicate hook id in the document: "${hook.id}"`, hook.id);
        reportedHookIds.add(hook.id);
      }
    } else {
      knownHookIds.add(hook.id);
    }

    // Two things the schema declares and, until t256, nobody enforced: a
    // document with either of them used to get a 201 out of `POST /v1/graphs`
    // and then never fire. The control plane's delivery-time filter compares the
    // trigger against the occurrence's own and demands a filled `secret_ref`, so
    // it simply enqueues nothing — a silent no-op, with no event and no error,
    // in both cases.
    const trigger = hook.trigger;
    if (trigger !== undefined && trigger !== null && !HOOK_TRIGGERS.includes(trigger)) {
      annotate(
        'invalid_hook_trigger',
        `hook #${index} declares a trigger outside the taxonomy: ${JSON.stringify(trigger)} (expected one of "${HOOK_TRIGGERS.join('", "')}")`,
        hook.id ?? index,
      );
    }

    const destination = hook.destination;
    if (destination !== undefined && destination !== null) {
      if (!isObject(destination)) {
        annotate(
          'invalid_hook_destination',
          `hook #${index} needs an object in "destination", naming the HMAC key in "secret_ref": ${JSON.stringify(destination)}`,
          hook.id ?? index,
        );
      } else if (Object.hasOwn(destination, 'secret')) {
        // Its own code, and a message that does NOT quote the value: this is the
        // pre-t194 shape, and the document is content-addressed, served whole,
        // exported to disk and published to the atlas — a key written here is a
        // key every reader of the map has. A leak, not a shape mistake.
        annotate(
          'hook_raw_secret',
          `hook #${index} carries a raw "secret" in "destination": the document is published whole, so what goes on the wire is the NAME of a key registered by PUT /v1/hook-secrets/:name, in "secret_ref"`,
          hook.id ?? index,
        );
      } else if (!isFilledText(destination.secret_ref)) {
        annotate(
          'invalid_hook_destination',
          `hook #${index} needs a filled text in "destination.secret_ref": ${JSON.stringify(destination.secret_ref)}`,
          hook.id ?? index,
        );
      }
    }

    const target = hook.node_id;
    if (!isFilledText(target)) {
      if (target !== undefined && target !== null) {
        annotate(
          'invalid_id',
          `hook #${index} needs a filled text in "node_id": ${JSON.stringify(target)}`,
          hook.id ?? index,
        );
      }
      return;
    }
    if (!knownIds.has(target)) {
      annotate(
        'hook_unknown_node',
        `hook #${index} references a node that does not exist: "${target}"`,
        hook.id ?? index,
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Runs the four soundness rules, in this order: reachable, terminates,
 * edge with condition, node with contract.
 *
 * @param {unknown} doc Graph document, already parsed.
 * @returns {{valid: boolean, violations: Array<{rule: string, target: unknown}>}}
 */
export function validarSoundness(doc) {
  const violations = [];
  const nodes = isObject(doc) && Array.isArray(doc.nodes) ? doc.nodes.filter(isObject) : [];
  const edges = isObject(doc) && Array.isArray(doc.edges) ? doc.edges.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structural problem, and counting it here would invent reachability that
  // does not exist.
  const outgoing = new Map(ids.map((id) => [id, []]));
  const incoming = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }

  // 1. reachable — every node is reachable from initial_node.
  const reached = traverse(
    known.has(doc?.initial_node) ? [doc.initial_node] : [],
    (id) => outgoing.get(id) ?? [],
  );
  for (const id of ids) {
    if (!reached.has(id)) violations.push({ rule: RULES.REACHABLE, target: id });
  }

  // 2. terminates — from every node there is a path to some final node.
  // Computed backwards: whoever reaches the end is whoever reaches a final node
  // walking the reversed edges. A node stuck in a cycle with no way out is
  // simply never reached.
  const finals = (Array.isArray(doc?.final_nodes) ? doc.final_nodes : []).filter((id) => known.has(id));
  const reachEnd = traverse(finals, (id) => incoming.get(id) ?? []);
  for (const id of ids) {
    if (!reachEnd.has(id)) violations.push({ rule: RULES.TERMINATES, target: id });
  }

  // 3. edge with condition — no transition without a label.
  for (const edge of edges) {
    if (!isFilledText(edge.condition)) {
      violations.push({
        rule: RULES.EDGE_WITH_CONDITION,
        target: { from: edge.from ?? null, to: edge.to ?? null },
      });
    }
  }

  // 4. node with contract — holds for a gate too, which is a node like any other.
  for (const node of nodes) {
    if (!hasSkillRef(node) || !hasContract(node)) {
      violations.push({ rule: RULES.NODE_WITH_CONTRACT, target: node.id ?? null });
    }
  }

  return { valid: violations.length === 0, violations };
}

/** Breadth-first search from several seeds; returns the visited set. */
function traverse(seeds, neighbours) {
  const visited = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    for (const neighbour of neighbours(queue.shift())) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      queue.push(neighbour);
    }
  }
  return visited;
}

function hasSkillRef(node) {
  const ref = node.skill_ref;
  return isObject(ref) && isFilledText(ref.id) && isFilledText(ref.version) && isFilledText(ref.hash);
}

function hasContract(node) {
  const contract = node.contract;
  return (
    isObject(contract) &&
    isObject(contract.input_schema) &&
    isObject(contract.output_schema) &&
    Array.isArray(contract.checks) &&
    contract.checks.length > 0
  );
}

/**
 * Reads and parses a graph document from disk.
 *
 * @param {string} filePath Path of the JSON file.
 * @returns {unknown} The parsed document.
 */
export function carregarGrafo(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Runs both validations and returns the combined report. */
export function validarGrafo(doc) {
  const structure = validarEstrutura(doc);
  const soundness = validarSoundness(doc);
  return { valid: structure.valid && soundness.valid, structure, soundness };
}

function main(paths) {
  if (paths.length === 0) {
    console.error('usage: node scripts/validate-graph.mjs <graph.json> [...]');
    return 2;
  }
  let failed = false;
  for (const filePath of paths) {
    let report;
    try {
      report = validarGrafo(carregarGrafo(filePath));
    } catch (error) {
      console.error(`✖ ${filePath}: could not read the document — ${error.message}`);
      failed = true;
      continue;
    }
    if (report.valid) {
      console.log(`✔ ${filePath}`);
      continue;
    }
    failed = true;
    console.error(`✖ ${filePath}`);
    for (const problem of report.structure.errors) {
      console.error(`  structure  ${problem.code}: ${problem.message}`);
    }
    for (const violation of report.soundness.violations) {
      console.error(`  soundness  ${violation.rule}: ${JSON.stringify(violation.target)}`);
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
