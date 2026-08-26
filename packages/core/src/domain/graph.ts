/**
 * Graph document validation inside the control plane (t101, FR2).
 *
 * A typed port of `scripts/validate-graph.mjs` (t96). The script is the
 * repository's reference validator, but it lives outside the package's
 * publishable tree (`files` in `package.json`): the core cannot import it without
 * dragging along a dependency `npm pack` does not package. That is why the two
 * functions live here — and why `test/domain-graph.test.ts` runs the same
 * fixtures through both validators and demands identical reports (AT1). Any rule
 * change has to happen in both places, or the parity test fails.
 *
 * That parity is also the rule for the report's own vocabulary. This report IS
 * the wire format of the 422, and t230 — the fifth child of D20 — moved its
 * keys, codes and rule labels to the English of `docs/spec/glossary-wire.md`
 * §5.3/5.4, in the same delivery as the reference validator. A key renamed here
 * and not there is exactly what `deepEqual` catches.
 *
 * It is the last of three moves that had to happen in lockstep for the same
 * reason: the message PROSE went English with t180, the field names quoted
 * INSIDE a message with the DOCUMENT's own keys in t178 (the 2026-08-15 D18
 * amendment), and the report's frame with t230. What used to be two vocabularies
 * side by side — `doc.nodes` read out of an English document, `erros` written
 * into a Portuguese report — is now one, from the document out to the 422.
 *
 * Two checks, deliberately separate:
 *
 * - `validateStructure` — shape and referential integrity, hooks included since
 *   t169: a hook whose `node_id` names nothing is a dangling reference like an
 *   edge's, and a repeated hook id is a repeated name like a node's;
 * - `validateSoundness` — the four formal workflow-net rules.
 *
 * Neither of them throws on a malformed document: the caller needs the whole
 * report of what is wrong, not the first error. That is what the API returns in
 * the 422.
 */

import { isObject } from '../util/is-object.ts';
import type { CustomFieldDefinition } from './custom-fields.ts';

/** Names of the four soundness rules, in the order they run. */
export const RULES = Object.freeze({
  REACHABLE: 'reachable',
  TERMINATES: 'terminates',
  EDGE_WITH_CONDITION: 'edge_with_condition',
  NODE_WITH_CONTRACT: 'node_with_contract',
});

/**
 * A node of the document, already validated.
 *
 * The open drawer (`[key: string]`) is intentional: the graph format has not
 * frozen yet (rule of two consumers), and the snapshot has to cross the database
 * without losing a key this package does not know about yet.
 */
export interface GraphNode {
  id: string;
  role: string;
  node_type: string;
  description?: string;
  /** Which engine runs this node (t141). Absent = the runner's default. */
  engine?: string;
  /**
   * Which model of that engine runs this node (t166). Absent = the engine's
   * own default, and no model flag is assembled at all.
   *
   * Named here even though the open drawer below would already carry it: the
   * field is PROPOSABLE (`CHANGEABLE_FIELDS`), and a field a proposal can swap
   * is a field this package has an opinion about.
   */
  model?: string;
  /**
   * When this node calls a human (t167). Absent = `on_uncertainty`, which is
   * what every node did before the field existed.
   *
   * Named here for the same reason `model` is, and typed `string` rather than
   * the closed union for the same reason too: what refuses a fourth value is
   * `schema/graph.schema.json`, on the way in, and this package reads snapshots
   * that were already validated by it.
   */
  escalation_policy?: string;
  /** Who should be called when this node escalates (t167). Free text. */
  escalation_recipient?: string;
  skill_ref: unknown;
  contract: unknown;
  [key: string]: unknown;
}

/** An edge of the document, already validated. */
export interface GraphEdge {
  from: string;
  to: string;
  condition: string;
  description?: string;
  [key: string]: unknown;
}

/** Where a hook's delivery goes (t169). Today `webhook` and nothing else. */
export interface GraphHookDestination {
  type: string;
  /** Absolute `http:`/`https:` URL the delivery is POSTed to. */
  url: string;
  /**
   * NAME of the HMAC key, never the key (t194).
   *
   * The document is content-addressed and served, exported and published whole,
   * so a value written here is a value every reader of the document has. What it
   * points at lives in `segredo_gancho`, is registered through
   * `PUT /v1/hook-secrets/:nome`, and is resolved by the control plane at
   * enqueue time — the same place `url` is copied from, and the same timing
   * `engine`, `model` and `escalation_policy` already have.
   *
   * That it is PRESENT, and that no raw `secret` sits beside it, is checked by
   * `validateStructure` since t256: the schema said so and nothing enforced it,
   * because `POST /v1/graphs` compiles no ajv against `graph.schema.json`.
   *
   * What is still deliberately NOT done here is RESOLVING it: that pass is pure
   * and DB-free, in byte-for-byte parity with `scripts/validate-graph.mjs`, and a
   * check that consulted a database would break the contract for one sibling
   * and not the other. The CHARSET is the schema's job, as it always was.
   */
  secret_ref: string;
  [key: string]: unknown;
}

/**
 * A reaction the graph declares for itself (t169).
 *
 * It is graph DATA, which is the whole point: the reaction is versioned with
 * the document and proposable like every other part of it (D2, D15), instead of
 * living as an out-of-band subscription only an operator with API access can
 * register. It never participates in the traversal — a hook has no way of
 * changing where the traveller goes, and a hook that fails is an incident, never
 * an outcome.
 */
export interface GraphHook {
  id: string;
  /** One of {@link HOOK_TRIGGERS}; the closed vocabulary is the schema's own. */
  trigger: string;
  /** The node whose entry or block fires this hook. */
  node_id: string;
  destination: GraphHookDestination;
  description?: string;
  [key: string]: unknown;
}

/** Graph document (the same format as `schema/graph.schema.json`). */
export interface GraphDocument {
  problem_class: string;
  lineage: { type: string; base_class?: string; source_proposal_id?: string };
  metadata: Record<string, unknown>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  initial_node: string;
  final_nodes: string[];
  /**
   * Fields this class declares on its own tickets (t168).
   *
   * Required and possibly empty. Typed here rather than left to the open drawer
   * because the transition gate READS it out of the snapshot — a key this
   * package acts on is a key it has an opinion about.
   */
  custom_fields: CustomFieldDefinition[];
  /** Declared reactions (t169). Absent = none, and that is most documents. */
  hooks?: GraphHook[];
  /**
   * How many failed sessions in a row, on the same node, stop the job (t265).
   *
   * Typed here for the same reason `hooks` is: this package ACTS on the key —
   * `repositories/job.ts` reads it out of the snapshot when a session closes
   * `failed`. Absent means the default of 3, and it is resolved THERE and never
   * here: validation refusing a document for a field it has no opinion about
   * would break every graph written before this one existed.
   */
  max_consecutive_failures?: number;
  [key: string]: unknown;
}

/** A shape or referential-integrity problem. */
export interface StructureError {
  code: string;
  message: string;
  target: unknown;
}

/** A broken soundness rule, with the target that broke it. */
export interface SoundnessViolation {
  rule: string;
  target: unknown;
}

export interface StructureReport {
  valid: boolean;
  errors: StructureError[];
}

export interface SoundnessReport {
  valid: boolean;
  violations: SoundnessViolation[];
}

/** Combined report — it is the 422 body of the graph and proposal routes. */
export interface GraphReport {
  valid: boolean;
  structure: StructureReport;
  soundness: SoundnessReport;
}

type PlainObject = Record<string, unknown>;

/**
 * The document's own `required`, node's and edge's — exported so
 * `test/domain-manifest-fields.test.ts` can hold them against
 * `schema/graph.schema.json` and fail the moment one side is renamed alone.
 */
export const REQUIRED_DOCUMENT_FIELDS = [
  'problem_class',
  'lineage',
  'metadata',
  'nodes',
  'edges',
  'initial_node',
  'final_nodes',
  'custom_fields',
];
export const REQUIRED_NODE_FIELDS = ['id', 'role', 'node_type', 'skill_ref', 'contract'];
export const REQUIRED_EDGE_FIELDS = ['from', 'to', 'condition'];
export const REQUIRED_HOOK_FIELDS = ['id', 'trigger', 'node_id', 'destination'];

/**
 * What a hook may react to — `schema/graph.schema.json`'s own closed enum.
 *
 * Written down here because the schema is not what refuses a third value:
 * `POST /v1/graphs` declares no ajv against it (draft 2020-12 against the
 * draft-07 ajv Fastify v5 ships, `routes/graphs.ts`), so until t256 the enum was
 * documentation and this loop was the whole gate.
 */
export const HOOK_TRIGGERS = ['node_entered', 'node_blocked'];

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Checks the document's shape and referential integrity.
 *
 * @param doc Already parsed graph document (untrusted).
 * @returns A report with every problem found.
 */
export function validateStructure(doc: unknown): StructureReport {
  const errors: StructureError[] = [];
  const note = (code: string, message: string, target: unknown = null): void => {
    errors.push({ code, message, target });
  };

  if (!isObject(doc)) {
    note('invalid_document', 'graph document has to be a JSON object');
    return { valid: false, errors };
  }

  for (const field of REQUIRED_DOCUMENT_FIELDS) {
    if (doc[field] === undefined || doc[field] === null) {
      note(
        'missing_required_field',
        `required field missing from the document: "${field}"`,
        field,
      );
    }
  }

  if (doc.nodes !== undefined && !Array.isArray(doc.nodes)) {
    note('invalid_field', '"nodes" has to be a list', 'nodes');
  }
  if (doc.edges !== undefined && !Array.isArray(doc.edges)) {
    note('invalid_field', '"edges" has to be a list', 'edges');
  }
  if (doc.final_nodes !== undefined && !Array.isArray(doc.final_nodes)) {
    note('invalid_field', '"final_nodes" has to be a list', 'final_nodes');
  }
  // The list itself and nothing inside it: what each declaration has to look
  // like is the schema's business, and cross-checking `required_at` against the
  // node ids is deliberately not done here (t168, out of scope) — an unreachable
  // `required_at` fails inertly, demanding nothing of nobody.
  if (doc.custom_fields !== undefined && !Array.isArray(doc.custom_fields)) {
    note('invalid_field', '"custom_fields" has to be a list', 'custom_fields');
  }
  if (doc.hooks !== undefined && !Array.isArray(doc.hooks)) {
    note('invalid_field', '"hooks" has to be a list', 'hooks');
  }

  const nodes: unknown[] = Array.isArray(doc.nodes) ? doc.nodes : [];
  const knownIds = new Set<string>();
  const alreadyReportedIds = new Set<string>();

  nodes.forEach((node, index) => {
    if (!isObject(node)) {
      note('invalid_node', `the node at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_NODE_FIELDS) {
      if (node[field] === undefined || node[field] === null) {
        note(
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
        note(
          'invalid_id',
          `the id of the node at position ${index} has to be a filled text: ${JSON.stringify(node.id)}`,
          index,
        );
      }
      return;
    }
    if (knownIds.has(node.id)) {
      if (!alreadyReportedIds.has(node.id)) {
        note('duplicate_node_id', `duplicate node id in the document: "${node.id}"`, node.id);
        alreadyReportedIds.add(node.id);
      }
      return;
    }
    knownIds.add(node.id);
  });

  const edges: unknown[] = Array.isArray(doc.edges) ? doc.edges : [];
  edges.forEach((edge, index) => {
    if (!isObject(edge)) {
      note('invalid_edge', `the edge at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_EDGE_FIELDS) {
      if (edge[field] === undefined || edge[field] === null) {
        note(
          'missing_required_field',
          `required field missing from edge #${index}: "${field}"`,
          { from: edge.from ?? null, to: edge.to ?? null },
        );
      }
    }
    for (const end of ['from', 'to']) {
      const target = edge[end];
      if (!isFilledText(target)) {
        if (target !== undefined && target !== null) {
          note(
            'invalid_id',
            `edge #${index} needs a filled text in "${end}": ${JSON.stringify(target)}`,
            { from: edge.from ?? null, to: edge.to ?? null },
          );
        }
        continue;
      }
      if (!knownIds.has(target)) {
        note(
          'edge_unknown_node',
          `edge #${index} references in "${end}" a node that does not exist: "${target}"`,
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
      note(
        'invalid_id',
        `initial_node has to be a filled text: ${JSON.stringify(doc.initial_node)}`,
        'initial_node',
      );
    }
  } else if (!knownIds.has(doc.initial_node)) {
    note(
      'unknown_initial_node',
      `initial_node references a node that does not exist: "${doc.initial_node}"`,
      doc.initial_node,
    );
  }

  const finals: unknown[] = Array.isArray(doc.final_nodes) ? doc.final_nodes : [];
  if (Array.isArray(doc.final_nodes) && finals.length === 0) {
    note('invalid_field', '"final_nodes" has to list at least one node', 'final_nodes');
  }
  // No required-fields loop covers an entry of the array, so here the absent
  // value (`null`, `undefined`) is an invalid id like any other.
  finals.forEach((final, index) => {
    if (!isFilledText(final)) {
      note(
        'invalid_id',
        `the id in final_nodes at position ${index} has to be a filled text: ${JSON.stringify(final)}`,
        index,
      );
      return;
    }
    if (!knownIds.has(final)) {
      note('unknown_final_node', `final_nodes references a node that does not exist: "${final}"`, final);
    }
  });

  // Hooks (t169). Referential integrity, exactly like an edge's endpoints: a
  // reaction that names a node the document does not have would be a reaction
  // that can never fire, and a document that declares one is wrong now rather
  // than mysteriously silent later. Uniqueness of the hook id follows the node
  // id's rule for the same reason — it is the name the delivery row carries,
  // and two hooks answering to one name make the log ambiguous.
  const hooks: unknown[] = Array.isArray(doc.hooks) ? doc.hooks : [];
  const knownHookIds = new Set<string>();
  const alreadyReportedHookIds = new Set<string>();

  hooks.forEach((hook, index) => {
    if (!isObject(hook)) {
      note('invalid_hook', `the hook at position ${index} has to be an object`, index);
      return;
    }
    for (const field of REQUIRED_HOOK_FIELDS) {
      if (hook[field] === undefined || hook[field] === null) {
        note(
          'missing_required_field',
          `required field missing from hook "${hook.id ?? `#${index}`}": "${field}"`,
          hook.id ?? index,
        );
      }
    }

    if (!isFilledText(hook.id)) {
      if (hook.id !== undefined && hook.id !== null) {
        note(
          'invalid_id',
          `the id of the hook at position ${index} has to be a filled text: ${JSON.stringify(hook.id)}`,
          index,
        );
      }
    } else if (knownHookIds.has(hook.id)) {
      if (!alreadyReportedHookIds.has(hook.id)) {
        note('duplicate_hook_id', `duplicate hook id in the document: "${hook.id}"`, hook.id);
        alreadyReportedHookIds.add(hook.id);
      }
    } else {
      knownHookIds.add(hook.id);
    }

    // Two things the schema declares and, until t256, nobody enforced: a
    // document with either of them used to get a 201 and then never fire.
    // `repositories/hooks.ts`'s `matches()` compares the trigger against the
    // occurrence's own and demands a filled `secret_ref`, so it simply enqueues
    // nothing — a silent no-op, with no event and no error, in both cases. It
    // stays exactly as it is: defence in depth over a snapshot written before
    // this check existed.
    const trigger = hook.trigger;
    if (trigger !== undefined && trigger !== null && !HOOK_TRIGGERS.includes(trigger as string)) {
      note(
        'invalid_hook_trigger',
        `hook #${index} declares a trigger outside the taxonomy: ${JSON.stringify(trigger)} (expected one of "${HOOK_TRIGGERS.join('", "')}")`,
        hook.id ?? index,
      );
    }

    const destination = hook.destination;
    if (destination !== undefined && destination !== null) {
      if (!isObject(destination)) {
        note(
          'invalid_hook_destination',
          `hook #${index} needs an object in "destination", naming the HMAC key in "secret_ref": ${JSON.stringify(destination)}`,
          hook.id ?? index,
        );
      } else if (Object.hasOwn(destination, 'secret')) {
        // Its own code, and a message that does NOT quote the value: this is the
        // pre-t194 shape, and the document is content-addressed, served whole,
        // exported to disk and published to the atlas — a key written here is a
        // key every reader of the map has. A leak, not a shape mistake.
        note(
          'hook_raw_secret',
          `hook #${index} carries a raw "secret" in "destination": the document is published whole, so what goes on the wire is the NAME of a key registered by PUT /v1/hook-secrets/:name, in "secret_ref"`,
          hook.id ?? index,
        );
      } else if (!isFilledText(destination.secret_ref)) {
        note(
          'invalid_hook_destination',
          `hook #${index} needs a filled text in "destination.secret_ref": ${JSON.stringify(destination.secret_ref)}`,
          hook.id ?? index,
        );
      }
    }

    const target = hook.node_id;
    if (!isFilledText(target)) {
      if (target !== undefined && target !== null) {
        note(
          'invalid_id',
          `hook #${index} needs a filled text in "node_id": ${JSON.stringify(target)}`,
          hook.id ?? index,
        );
      }
      return;
    }
    if (!knownIds.has(target)) {
      note(
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
 * edge-with-condition, node-with-contract.
 *
 * @param doc Already parsed graph document (untrusted).
 * @returns A report with every violation found.
 */
export function validateSoundness(doc: unknown): SoundnessReport {
  const violations: SoundnessViolation[] = [];
  const document = isObject(doc) ? doc : {};
  const nodes = Array.isArray(document.nodes) ? document.nodes.filter(isObject) : [];
  const edges = Array.isArray(document.edges) ? document.edges.filter(isObject) : [];
  const ids = nodes.map((node) => node.id).filter(isFilledText);
  const known = new Set(ids);

  // Only edges between existing nodes enter the topology; a dangling end is a
  // structure problem, and counting it here would invent reachability that does
  // not exist.
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    const from = edge.from;
    const to = edge.to;
    if (!isFilledText(from) || !isFilledText(to)) continue;
    if (!known.has(from) || !known.has(to)) continue;
    outgoing.get(from)?.push(to);
    incoming.get(to)?.push(from);
  }

  // 1. reachable — every node is reachable from initial_node.
  const start = document.initial_node;
  const reached = traverse(
    isFilledText(start) && known.has(start) ? [start] : [],
    (id) => outgoing.get(id) ?? [],
  );
  for (const id of ids) {
    if (!reached.has(id)) violations.push({ rule: RULES.REACHABLE, target: id });
  }

  // 2. terminates — from every node there is a path to some final node. Computed
  // backwards: whoever reaches the end is whoever reaches a final walking the
  // reversed edges. A node stuck in a cycle with no exit is simply never reached.
  const declaredFinals: unknown[] = Array.isArray(document.final_nodes)
    ? document.final_nodes
    : [];
  const finals = declaredFinals.filter(
    (id): id is string => isFilledText(id) && known.has(id),
  );
  const reachTheEnd = traverse(finals, (id) => incoming.get(id) ?? []);
  for (const id of ids) {
    if (!reachTheEnd.has(id)) violations.push({ rule: RULES.TERMINATES, target: id });
  }

  // 3. edge-with-condition — no transition without a label.
  for (const edge of edges) {
    if (!isFilledText(edge.condition)) {
      violations.push({
        rule: RULES.EDGE_WITH_CONDITION,
        target: { from: edge.from ?? null, to: edge.to ?? null },
      });
    }
  }

  // 4. node-with-contract — holds for a gate too, which is a node like any other.
  for (const node of nodes) {
    if (!hasSkillRef(node) || !hasContract(node)) {
      violations.push({ rule: RULES.NODE_WITH_CONTRACT, target: node.id ?? null });
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Runs both validations and returns the combined report.
 *
 * @param doc Already parsed graph document.
 * @returns Structure and soundness reports, with the joint verdict.
 */
export function validateGraph(doc: unknown): GraphReport {
  const structure = validateStructure(doc);
  const soundness = validateSoundness(doc);
  return { valid: structure.valid && soundness.valid, structure, soundness };
}

/** Breadth-first search from several seeds; returns the visited set. */
function traverse(seeds: string[], neighbours: (id: string) => string[]): Set<string> {
  const visited = new Set(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const neighbour of neighbours(current)) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      queue.push(neighbour);
    }
  }
  return visited;
}

function hasSkillRef(node: PlainObject): boolean {
  const ref = node.skill_ref;
  return (
    isObject(ref) &&
    isFilledText(ref.id) &&
    isFilledText(ref.version) &&
    isFilledText(ref.hash)
  );
}

function hasContract(node: PlainObject): boolean {
  const contract = node.contract;
  return (
    isObject(contract) &&
    isObject(contract.input_schema) &&
    isObject(contract.output_schema) &&
    Array.isArray(contract.checks) &&
    contract.checks.length > 0
  );
}

/* -------------------------------------------------- contracts (t278) */

/**
 * What a node can count on because the CONTROL PLANE always projects it.
 *
 * The list is `domain/context.ts`'s `buildNodeInput` read as a promise instead
 * of as code: `job` with the three fields the `job` table always has,
 * `traversal` with the three the walk always carries, `perguntas_respondidas`
 * (a list, empty when nothing was answered) and `project` (an object, `{}` when
 * the class declares none). `job.type` is deliberately NOT here: the column does
 * not exist, so the key simply does not appear, and promising it would hand a
 * skill a guarantee the projection cannot keep.
 *
 * `test/domain-graph-contracts.test.ts` holds the top-level names of this list
 * against `buildNodeInput`'s own output, so the two cannot drift in silence.
 */
export const ALWAYS_AVAILABLE_INPUT_PATHS = Object.freeze([
  'job',
  'job.id',
  'job.title',
  'job.body',
  'traversal',
  'traversal.nodes_visited',
  'traversal.entered_at',
  'traversal.sessions_by_node',
  'perguntas_respondidas',
  'project',
]);

/**
 * What the RUNNER merges into every dispatch, from the machine it runs on.
 *
 * `packages/runner/src/dispatch/resolve-executor-environment.ts` returns exactly
 * this shape, unconditionally, at every dispatch — a filesystem path and a live
 * commit, neither of which can be graph data (`docs/spec/runner-and-controller.md`
 * §"O ambiente de executor"). A runner with no bench configured contributes `{}`
 * instead, and that is a deployment question rather than a document one: what is
 * checked here is what the FORMAT promises a node, which is what the resolver
 * publishes when there is a bench at all.
 */
export const EXECUTOR_PROVIDED_INPUT_PATHS = Object.freeze([
  'banco_de_testes',
  'banco_de_testes.caminho',
  'banco_de_testes.comandos_de_dados',
  'referencia',
  'referencia.commit',
  'referencia.modo',
  'referencia.lido_em',
]);

/** The routing label rides inside the report and is never stored (t269). */
const ROUTE_LABEL_KEY = 'resultado';

/** The two schemas of a registered skill, in the part this check reads. */
export interface SkillContractShape {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

/**
 * Resolves a node's pin into the skill's own contract.
 *
 * Injected rather than looked up here, for the reason `domain/context.ts` holds
 * no `Database` either: the caller knows where its skills live — the registry
 * over `db` (`routes/graphs.ts`), the `skills/` of a bundle on disk
 * (`cli/import.ts`), a fixture map (the tests) — and the rule itself is a
 * question about the document.
 *
 * `undefined` means "this pin resolves to nothing", which is reported and never
 * guessed at.
 */
export type SkillLookup = (ref: {
  id: string;
  version: string;
  hash: string;
}) => SkillContractShape | undefined;

/** A required input key with no producer on every path into its node. */
export interface UnproducedInputProblem {
  code: 'unproduced_input';
  node_id: string;
  /** The dotted path, as the skill's `input` declares it. */
  key: string;
  message: string;
  /**
   * Nodes whose skill output would place this exact path somewhere.
   *
   * "Somewhere" is the point: a node listed here produces the key under a bucket
   * this node does not read, or on a path that does not always reach it. Empty
   * means the key exists nowhere in the document, which is a different mistake —
   * usually a manifest asking for something the class never declared.
   */
  produced_elsewhere_by: string[];
}

/** A node whose pin the lookup could not resolve; nothing else is said about it. */
export interface UnresolvedSkillProblem {
  code: 'skill_ref_unresolved';
  node_id: string;
  message: string;
}

export type ContractProblem = UnproducedInputProblem | UnresolvedSkillProblem;

/** The contract report — the `contracts` key of the 422 (t278). */
export interface ContractReport {
  valid: boolean;
  problems: ContractProblem[];
}

/**
 * Where a stored version stands with respect to its contracts (t283).
 *
 * Three values, because a report answers a question a ROW cannot: `valid` is
 * the verdict of one call over one registry, and a version needs a position in
 * a lifecycle. `unchecked` is not a soft `failed` — it says the question was
 * never answered, and it is the state a version leaves the moment the missing
 * manifest is registered.
 */
export type ContractsState = 'checked' | 'unchecked' | 'failed';

/**
 * The report, read as the state the version carries.
 *
 * An unresolved pin outranks everything else in the report, and it has to: with
 * one ancestor producing nothing, every `unproduced_input` computed downstream
 * of it is an accusation whose only evidence is an unfilled registry (the same
 * reasoning `routes/graphs.ts` writes for what it publishes). So a report with
 * any `skill_ref_unresolved` is `unchecked` whatever else it carries, and only a
 * report where every pin resolved is allowed to say `checked` or `failed`.
 *
 * Pure, and deliberately not folded into `validateContracts`: the check answers
 * what it found, and this is the one sentence three write sites have to agree
 * on about it.
 *
 * @param report What `validateContracts` answered.
 * @returns The state a version born of this report carries.
 */
export function classifyContracts(report: ContractReport): ContractsState {
  if (report.problems.some((problem) => problem.code === 'skill_ref_unresolved')) {
    return 'unchecked';
  }
  return report.valid ? 'checked' : 'failed';
}

/** A node with its pin resolved, plus what it produces and what it demands. */
interface NodeContract {
  id: string;
  /** The bucket its output lands in; `null` for a merge at the top level. */
  bucket: string | null;
  /** Resolved contract, or `null` when the lookup answered nothing. */
  skill: SkillContractShape | null;
  /** Paths this node's output places where a descendant reads them. */
  produced: Set<string>;
  /** The same paths ignoring the bucket — who "would produce" the key at all. */
  placed: Set<string>;
  /** Paths this node's own input demands, in the order the schema declares them. */
  required: string[];
}

/** The `required` list of a JSON Schema object, or an empty one. */
function requiredOf(schema: unknown): string[] {
  if (!isObject(schema)) return [];
  const required = schema.required;
  if (!Array.isArray(required)) return [];
  return required.filter(isFilledText);
}

/** The `properties` map of a JSON Schema object, or an empty one. */
function propertiesOf(schema: unknown): PlainObject {
  if (!isObject(schema)) return {};
  return isObject(schema.properties) ? schema.properties : {};
}

/**
 * The required paths of one schema, one level of nesting deep.
 *
 * `["job", "job.id"]` for a schema requiring `job` whose own `job` property is
 * an object requiring `id`. Deeper than that is out of this check by decision
 * (see {@link validateContracts}).
 */
function requiredPaths(schema: unknown): string[] {
  const properties = propertiesOf(schema);
  const paths: string[] = [];

  for (const name of requiredOf(schema)) {
    paths.push(name);
    const nested = properties[name];
    if (!isObject(nested) || nested.type !== 'object') continue;
    for (const sub of requiredOf(nested)) paths.push(`${name}.${sub}`);
  }

  return paths;
}

/**
 * What one node's output guarantees, as paths in the next node's `input`.
 *
 * Only `required` output properties count: an optional one is a possibility, and
 * a possibility is not something the node downstream can be held to. The bucket
 * prefixes everything, and the bucket path itself is only guaranteed when
 * something lands in it.
 *
 * @param output The pinned skill's `output` schema.
 * @param bucket `contract.produces`, or `null` for the top level.
 * @returns The dotted paths, bucket included.
 */
function producedPaths(output: unknown, bucket: string | null): Set<string> {
  const paths = new Set<string>();
  const prefix = bucket === null ? '' : `${bucket}.`;

  for (const path of requiredPaths(output)) {
    // The routing label is stripped before the report is stored (t269), so it
    // reaches no bucket and no top level — it is graph vocabulary, not data.
    if (path === ROUTE_LABEL_KEY || path.startsWith(`${ROUTE_LABEL_KEY}.`)) continue;
    paths.add(`${prefix}${path}`);
    if (bucket !== null) paths.add(bucket);
  }

  return paths;
}

/** The pin of a node, when it carries a whole one. */
function pinOf(node: PlainObject): { id: string; version: string; hash: string } | null {
  const ref = node.skill_ref;
  if (!isObject(ref)) return null;
  if (!isFilledText(ref.id) || !isFilledText(ref.version) || !isFilledText(ref.hash)) return null;
  return { id: ref.id, version: ref.version, hash: ref.hash };
}

/** `contract.produces`, or `null` when the node merges at the top level. */
function bucketOf(node: PlainObject): string | null {
  const contract = node.contract;
  const declared = isObject(contract) ? contract.produces : undefined;
  return isFilledText(declared) ? declared : null;
}

/**
 * Checks that every required input of every node has a producer (t278).
 *
 * Principle 3 promises contracts are checked at the gate; `validateStructure`
 * and `validateSoundness` check the document's SHAPE and its topology, and
 * neither of them asks the question a session actually depends on: when a job
 * arrives here, will the data this node's skill declares as required be there?
 * Three real crossings answered that at dispatch time, after paying for the
 * sessions.
 *
 * ## What is checked is the PINNED SKILL, never the node's own contract
 *
 * `docs/spec/graph.md` §2 already draws this line for output — the node's
 * `output_schema` documents, the skill's `output` validates — and it holds for
 * input too, where the two have already drifted: the software bundle's `refinar`
 * declares `["ticket_id", "pedido"]` while the skill it pins really requires
 * `["job", "project"]`. Only the skill's is enforced anywhere, so only the
 * skill's is checked here.
 *
 * ## The rule
 *
 * A node can count on three disjoint sources: what the control plane always
 * projects ({@link ALWAYS_AVAILABLE_INPUT_PATHS} plus `project.<key>` for the
 * keys the document's own `project` declares, plus the class's `custom_fields`
 * as top-level scalars), what the executor merges in at every dispatch
 * ({@link EXECUTOR_PROVIDED_INPUT_PATHS}), and what its ANCESTORS produced.
 *
 * A node can be reached by more than one path (a rework edge, three edges into
 * one final node), so "available here" has to mean available on EVERY path that
 * reaches it — a key produced only after a loop is not there the first time
 * through. That makes it the textbook forward, monotone-decreasing dataflow
 * problem, the shape of "available expressions":
 *
 * ```
 * avail(initial) = BASE
 * avail(N)       = BASE ∪ ⋂ over every predecessor P of (avail(P) ∪ produced(P))
 * ```
 *
 * — intersection over predecessors, not union — iterated to a fixed point. The
 * set only shrinks, so it converges in at most `nodes.length` rounds.
 *
 * ## The declared limit: one level of nesting, on both sides
 *
 * A required `project` whose own schema requires `aplicacao` is checked as
 * `project` and `project.aplicacao`, and there it stops: `project.aplicacao.rodando`
 * is NOT checked, on either the producing or the consuming side. Two levels
 * would mean walking arbitrary JSON Schema (`$ref`, `allOf`, `items`) to decide
 * what a path even means, and the gap this ficha closes is one level deep in
 * every incident that motivated it. A real gap deeper than that survives this
 * check.
 *
 * Never throws on a malformed document, like its two siblings: it is only ever
 * called with a document that already passed both of them, and what it hands
 * back is the whole list of what is wrong.
 *
 * @param doc Graph document, already through structure and soundness.
 * @param resolveSkill How a `skill_ref` becomes a contract; see {@link SkillLookup}.
 * @returns Every problem found, with the joint verdict.
 */
export function validateContracts(doc: unknown, resolveSkill: SkillLookup): ContractReport {
  const problems: ContractProblem[] = [];
  const document = isObject(doc) ? doc : {};
  const rawNodes = Array.isArray(document.nodes) ? document.nodes.filter(isObject) : [];

  const contracts: NodeContract[] = [];
  const seen = new Set<string>();
  for (const node of rawNodes) {
    if (!isFilledText(node.id) || seen.has(node.id)) continue;
    seen.add(node.id);

    const bucket = bucketOf(node);
    const pin = pinOf(node);
    const skill = pin === null ? undefined : resolveSkill(pin);

    if (pin === null || skill === undefined) {
      problems.push({
        code: 'skill_ref_unresolved',
        node_id: node.id,
        message:
          pin === null
            ? `node "${node.id}" carries no whole pin, so no contract can be resolved for it`
            : `node "${node.id}" pins the skill "${pin.id}" at version ${pin.version}, which does not resolve: its contract cannot be checked and it produces nothing for the nodes after it`,
      });
      contracts.push({
        id: node.id,
        bucket,
        skill: null,
        produced: new Set(),
        placed: new Set(),
        required: [],
      });
      continue;
    }

    contracts.push({
      id: node.id,
      bucket,
      skill,
      produced: producedPaths(skill.output, bucket),
      placed: producedPaths(skill.output, null),
      required: requiredPaths(skill.input),
    });
  }

  const known = new Set(contracts.map((contract) => contract.id));
  const predecessors = new Map<string, string[]>(contracts.map((contract) => [contract.id, []]));
  const edges = Array.isArray(document.edges) ? document.edges.filter(isObject) : [];
  for (const edge of edges) {
    const from = edge.from;
    const to = edge.to;
    if (!isFilledText(from) || !isFilledText(to)) continue;
    if (!known.has(from) || !known.has(to)) continue;
    predecessors.get(to)?.push(from);
  }

  // BASE: everything a node has before any ancestor ran.
  const base = new Set<string>([
    ...ALWAYS_AVAILABLE_INPUT_PATHS,
    ...EXECUTOR_PROVIDED_INPUT_PATHS,
  ]);
  // One level only, exactly as the consumer side reads it: the document's own
  // `project` keys, and nothing inside them.
  for (const key of Object.keys(isObject(document.project) ? document.project : {})) {
    base.add(`project.${key}`);
  }
  // The class's fields are flat scalars spread at the TOP of `input`
  // (`domain/context.ts`), and `required_at` says when a field is DEMANDED of a
  // person, never when it exists.
  const customFields = Array.isArray(document.custom_fields) ? document.custom_fields : [];
  for (const field of customFields) {
    if (isObject(field) && isFilledText(field.name)) base.add(field.name);
  }

  const initial = isFilledText(document.initial_node) ? document.initial_node : null;

  // The fixed point, from the top: every non-initial node starts holding
  // everything anybody could produce, and each round takes away what some
  // predecessor cannot guarantee. Starting from BASE instead would only ever
  // grow, and a cycle would converge on the wrong (too small) answer.
  const universe = new Set(base);
  for (const contract of contracts) {
    for (const path of contract.produced) universe.add(path);
  }

  const available = new Map<string, Set<string>>();
  for (const contract of contracts) {
    available.set(contract.id, contract.id === initial ? new Set(base) : new Set(universe));
  }

  const producedOf = new Map(contracts.map((contract) => [contract.id, contract.produced]));

  // Round-robin until nothing moves. It terminates on its own arithmetic: a
  // node's set is only ever REPLACED by a subset of itself (it starts at the
  // universe, and every meet is taken over sets that only shrink), so a round
  // that moves anything strictly reduces a total that cannot go below zero. A
  // round cap of `nodes.length` would look safer and be worse — a shrink can
  // cascade around a cycle more than once per node, and stopping early would
  // leave a set too LARGE, which is the direction that stays silent about a real
  // gap instead of inventing one.
  for (let moved = true; moved; ) {
    moved = false;

    for (const contract of contracts) {
      if (contract.id === initial) continue;
      const incoming = predecessors.get(contract.id) ?? [];
      // A node with no predecessor and that is not the initial one is
      // unreachable, which soundness already refused; it holds BASE and nothing
      // more, which is the only honest answer.
      const meet = new Set(base);
      if (incoming.length > 0) {
        const [first, ...rest] = incoming;
        const seed = available.get(first) ?? new Set<string>();
        for (const path of [...seed, ...(producedOf.get(first) ?? [])]) {
          if (
            rest.every((id) => {
              const reaching = available.get(id) ?? new Set<string>();
              return reaching.has(path) || producedOf.get(id)?.has(path) === true;
            })
          ) {
            meet.add(path);
          }
        }
      }

      const current = available.get(contract.id) ?? new Set<string>();
      if (meet.size !== current.size || [...current].some((path) => !meet.has(path))) {
        available.set(contract.id, meet);
        moved = true;
      }
    }
  }

  for (const contract of contracts) {
    if (contract.skill === null) continue;
    const reaching = available.get(contract.id) ?? new Set<string>();

    for (const key of contract.required) {
      if (reaching.has(key)) continue;

      const producers = contracts.filter(
        (candidate) => candidate.placed.has(key) || candidate.produced.has(key),
      );
      const where = producers.map((producer) =>
        producer.bucket === null
          ? `"${producer.id}" places it at the top level`
          : `"${producer.id}" places it under the bucket "${producer.bucket}"`,
      );

      problems.push({
        code: 'unproduced_input',
        node_id: contract.id,
        key,
        message:
          producers.length === 0
            ? `node "${contract.id}" requires the input path "${key}", which nothing supplies: it is not in the control plane's projection, not provided by the executor, not a key of the document's "project" or "custom_fields", and no node's skill output places it`
            : `node "${contract.id}" requires the input path "${key}", which is not guaranteed on every path into it — ${where.join('; ')}`,
        produced_elsewhere_by: producers.map((producer) => producer.id),
      });
    }
  }

  return { valid: problems.length === 0, problems };
}
