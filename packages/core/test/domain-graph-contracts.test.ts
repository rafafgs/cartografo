/**
 * Static contract matching at import (t278).
 *
 * Principle 3 promises contracts are checked at the gate, and until this ficha
 * nothing checked the one thing a session actually needs: that the DATA a
 * node's pinned skill declares as required `input` will be there when a job
 * arrives. Three real crossings found it out at dispatch time, after paying for
 * the sessions (`notas/2026-08-17-segunda-execucao-bets.md` gap 5,
 * `notas/2026-08-17-t109-feature-do-jogo.md` gap 4).
 *
 * What is checked here is the PINNED SKILL's `input`/`output`, never the node's
 * own `contract.input_schema`/`output_schema` — `docs/spec/grafo.md` §2 already
 * draws that line for output, and the two have already drifted in the software
 * bundle (`refinar` declares `["ticket_id", "pedido"]`; the skill really
 * requires `["job", "project"]`).
 *
 * The fixtures below are hand-built rather than read off a bundle on purpose:
 * every case is one rule of the availability computation, and the real bundles
 * exercise the whole of it in `tests/factory-graph-1.test.mjs` and
 * `tests/factory-graph-2.test.mjs`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNodeInput } from '../src/domain/context.ts';
import type { CustomFieldDefinition } from '../src/domain/custom-fields.ts';
import {
  ALWAYS_AVAILABLE_INPUT_PATHS,
  EXECUTOR_PROVIDED_INPUT_PATHS,
  classifyContracts,
  validateContracts,
  type ContractProblem,
  type SkillContractShape,
  type SkillLookup,
} from '../src/domain/graph.ts';

/** One node of a fixture, in the part these tests care about. */
interface NodeSpec {
  id: string;
  /** The bucket this node's output lands in; absent = the top level. */
  produces?: string;
  /** The pinned skill's `input` schema. */
  input?: Record<string, unknown>;
  /** The pinned skill's `output` schema. */
  output?: Record<string, unknown>;
  /** When true the pin resolves to nothing: a skill nobody registered. */
  unregistered?: boolean;
}

/** A JSON Schema object with a `required` list, which is all this check reads. */
function objectSchema(
  required: string[],
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'object', required, properties };
}

/** The pin of a fixture node — one skill lineage per node, same version. */
function skillRef(id: string): { id: string; version: string; hash: string } {
  return { id: `${id}-skill`, version: '1.0.0', hash: `sha256:${id}` };
}

/**
 * Builds the document and the lookup of one fixture.
 *
 * Edges default to a straight chain in the order the nodes are declared, which
 * is what most of the cases below want; the two that care about topology pass
 * their own.
 */
function fixture(options: {
  nodes: NodeSpec[];
  edges?: Array<{ from: string; to: string }>;
  project?: Record<string, unknown>;
  custom_fields?: CustomFieldDefinition[];
}): { doc: Record<string, unknown>; resolveSkill: SkillLookup } {
  const { nodes, project, custom_fields: customFields } = options;
  const edges =
    options.edges ??
    nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id }));

  const doc: Record<string, unknown> = {
    problem_class: 'fixture',
    lineage: { type: 'base' },
    metadata: {},
    nodes: nodes.map((node) => ({
      id: node.id,
      role: 'fixture',
      node_type: 'work',
      skill_ref: skillRef(node.id),
      contract: {
        input_schema: { type: 'object' },
        output_schema: { type: 'object' },
        checks: [{ type: 'agentic', instruction: 'check', required_evidence: true }],
        ...(node.produces === undefined ? {} : { produces: node.produces }),
      },
    })),
    edges: edges.map((edge) => ({ ...edge, condition: 'sempre' })),
    initial_node: nodes[0].id,
    final_nodes: [nodes[nodes.length - 1].id],
    custom_fields: customFields ?? [],
    ...(project === undefined ? {} : { project }),
  };

  const registry = new Map<string, SkillContractShape>();
  for (const node of nodes) {
    if (node.unregistered === true) continue;
    const ref = skillRef(node.id);
    registry.set(`${ref.id}@${ref.version}`, {
      input: node.input ?? { type: 'object' },
      output: node.output ?? { type: 'object' },
    });
  }

  return { doc, resolveSkill: (ref) => registry.get(`${ref.id}@${ref.version}`) };
}

/** The problems of one fixture, in the order the function reports them. */
function problemsOf(options: Parameters<typeof fixture>[0]): ContractProblem[] {
  const { doc, resolveSkill } = fixture(options);
  return validateContracts(doc, resolveSkill).problems;
}

/** The `tese_triada` a producer declares and a consumer reads back. */
const THESIS = objectSchema(['id', 'titulo'], {
  id: { type: 'string' },
  titulo: { type: 'string' },
});

test('a key produced under a bucket the reader does not open is unproduced', () => {
  const problems = problemsOf({
    nodes: [
      {
        id: 'A',
        produces: 'analise',
        output: objectSchema(['tese_triada'], { tese_triada: { type: 'object' } }),
      },
      { id: 'B', input: objectSchema(['tese_triada'], { tese_triada: { type: 'object' } }) },
    ],
  });

  assert.equal(problems.length, 1, JSON.stringify(problems));
  const [problem] = problems;
  assert.equal(problem.code, 'unproduced_input');
  assert.equal(problem.node_id, 'B');
  assert.equal('key' in problem ? problem.key : null, 'tese_triada');
  assert.deepEqual(
    'produced_elsewhere_by' in problem ? problem.produced_elsewhere_by : null,
    ['A'],
    'the report names who does produce the key, even from a bucket B never reads',
  );
  for (const quoted of ['B', 'tese_triada', 'A', 'analise']) {
    assert.ok(
      problem.message.includes(quoted),
      `the message has to name "${quoted}": ${problem.message}`,
    );
  }
});

test('the same key merged at the top level is available to the node that reads it', () => {
  const problems = problemsOf({
    nodes: [
      { id: 'A', output: objectSchema(['tese_triada'], { tese_triada: { type: 'object' } }) },
      { id: 'B', input: objectSchema(['tese_triada'], { tese_triada: { type: 'object' } }) },
    ],
  });

  assert.deepEqual(problems, []);
});

test('a nested required key is available only when the producer declares it too', () => {
  const bare = problemsOf({
    nodes: [
      { id: 'A', output: objectSchema(['tese_triada'], { tese_triada: { type: 'object' } }) },
      { id: 'B', input: objectSchema(['tese_triada'], { tese_triada: THESIS }) },
    ],
  });

  assert.deepEqual(
    bare.map((problem) => ('key' in problem ? problem.key : problem.code)),
    ['tese_triada.id', 'tese_triada.titulo'],
    'an ancestor that produces a bare object guarantees none of the keys inside it',
  );

  const declared = problemsOf({
    nodes: [
      { id: 'A', output: objectSchema(['tese_triada'], { tese_triada: THESIS }) },
      { id: 'B', input: objectSchema(['tese_triada'], { tese_triada: THESIS }) },
    ],
  });

  assert.deepEqual(declared, [], "the producer's own nested `required` is what carries the key");
});

test('a key produced on only one of two paths into a node is not available there', () => {
  const problems = problemsOf({
    nodes: [
      { id: 'A' },
      { id: 'B', output: objectSchema(['dossie'], { dossie: { type: 'object' } }) },
      { id: 'C' },
      { id: 'D', input: objectSchema(['dossie'], { dossie: { type: 'object' } }) },
    ],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ],
  });

  assert.equal(problems.length, 1, JSON.stringify(problems));
  const [problem] = problems;
  assert.equal(problem.code, 'unproduced_input');
  assert.equal(problem.node_id, 'D');
  assert.equal('key' in problem ? problem.key : null, 'dossie');
  assert.deepEqual(
    'produced_elsewhere_by' in problem ? problem.produced_elsewhere_by : null,
    ['B'],
    'available on SOME path is not available at the node: the meet is an intersection',
  );
});

test('a pin the lookup does not resolve is its own code, and stops there', () => {
  const problems = problemsOf({
    nodes: [
      { id: 'A', unregistered: true, input: objectSchema(['nada_disso']) },
      { id: 'B' },
    ],
  });

  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0].code, 'skill_ref_unresolved');
  assert.equal(problems[0].node_id, 'A');
  assert.ok(problems[0].message.includes('A-skill'), problems[0].message);
});

test('an unresolved ancestor contributes nothing to whoever comes after it', () => {
  const problems = problemsOf({
    nodes: [
      {
        id: 'A',
        unregistered: true,
        output: objectSchema(['dossie'], { dossie: { type: 'object' } }),
      },
      { id: 'B', input: objectSchema(['dossie'], { dossie: { type: 'object' } }) },
    ],
  });

  assert.deepEqual(
    problems.map((problem) => [problem.code, problem.node_id]),
    [
      ['skill_ref_unresolved', 'A'],
      ['unproduced_input', 'B'],
    ],
    'a skill nobody can read declares no output either',
  );
});

test('the job the projection always publishes is available at the initial node', () => {
  const available = problemsOf({
    nodes: [{ id: 'A', input: objectSchema(['job'], { job: objectSchema(['id', 'title', 'body']) }) }],
  });
  assert.deepEqual(available, [], 'id, title and body are the three the projection always writes');

  const optional = problemsOf({
    nodes: [{ id: 'A', input: objectSchema(['job'], { job: objectSchema(['id', 'type']) }) }],
  });
  assert.deepEqual(
    optional.map((problem) => ('key' in problem ? problem.key : problem.code)),
    ['job.type'],
    '`job.type` is absent-when-absent in the projection, so nothing guarantees it — even first',
  );
});

test('project keys are available exactly as the document declares them', () => {
  const declared = problemsOf({
    nodes: [{ id: 'A', input: objectSchema(['project'], { project: objectSchema(['repo']) }) }],
    project: { repo: '.', branch_principal: 'main' },
  });
  assert.deepEqual(declared, []);

  const undeclared = problemsOf({
    nodes: [{ id: 'A', input: objectSchema(['project'], { project: objectSchema(['aplicacao']) }) }],
    project: { repo: '.' },
  });
  assert.deepEqual(
    undeclared.map((problem) => ('key' in problem ? problem.key : problem.code)),
    ['project.aplicacao'],
    'the class publishes the keys it wrote down, and a variant that adds one is another document',
  );
});

test('a class field is a top-level scalar wherever it is demanded', () => {
  const problems = problemsOf({
    nodes: [
      { id: 'A' },
      { id: 'B', input: objectSchema(['asset', 'downside']) },
    ],
    custom_fields: [
      { name: 'asset', type: 'string', required_at: 'A' },
      { name: 'downside', type: 'number', required_at: null },
    ],
  });

  assert.deepEqual(problems, [], '`required_at` says when it is DEMANDED, never when it exists');
});

test('what the executor merges in is available at every node, first one included', () => {
  const required = [...EXECUTOR_PROVIDED_INPUT_PATHS].filter((path) => !path.includes('.'));
  const nested = [...EXECUTOR_PROVIDED_INPUT_PATHS].filter((path) => path.includes('.'));

  const properties: Record<string, unknown> = {};
  for (const path of required) {
    properties[path] = objectSchema(
      nested
        .filter((candidate) => candidate.startsWith(`${path}.`))
        .map((candidate) => candidate.slice(path.length + 1)),
    );
  }

  const problems = problemsOf({
    nodes: [
      { id: 'A', input: objectSchema(required, properties) },
      { id: 'B', input: objectSchema(required, properties) },
    ],
  });

  assert.ok(nested.length > 0, 'the constant carries nested paths, or this case proves nothing');
  assert.deepEqual(problems, []);
});

test('the routing label of an ancestor is never counted as produced', () => {
  const problems = problemsOf({
    nodes: [
      { id: 'A', output: objectSchema(['resultado', 'nota'], { resultado: { type: 'string' } }) },
      { id: 'B', input: objectSchema(['resultado']) },
    ],
  });

  assert.deepEqual(
    problems.map((problem) => [problem.code, 'key' in problem ? problem.key : null]),
    [['unproduced_input', 'resultado']],
    '`resultado` is stripped before storage (t269), so it reaches nobody',
  );
});

test("the always-available constant does not drift from the projection's own keys", () => {
  const projected = buildNodeInput({
    job: { id: 1, title: 'a job with nothing on it', body: null, fields: null },
    snapshot: null,
    outputs: [],
    answered: [],
    traversal: { nodes_visited: [], entered_at: '2026-08-18T00:00:00.000Z' },
  });

  assert.deepEqual(
    [...ALWAYS_AVAILABLE_INPUT_PATHS].filter((path) => !path.includes('.')).sort(),
    Object.keys(projected).sort(),
    'a key `buildNodeInput` stops publishing is a key this check must stop promising',
  );
});

/*
 * t283 — the three-valued state a version carries.
 *
 * `validateContracts` answers a binary verdict about ONE call; a stored version
 * needs a lifecycle position, because "the check ran and passed", "the check
 * could not run" and "the check ran and refused" are three different facts and
 * only the third one may never carry a job. `classifyContracts` is that
 * translation, and it is pure: the same report always classifies the same way,
 * whoever is asking.
 */

test('t283 — an unresolved pin classifies as unchecked, whatever else is in the report', () => {
  // The ancestor is not registered, so `B`'s availability is computed with a
  // node that produces nothing: the report carries BOTH the unresolved pin and
  // an `unproduced_input` that only exists because of it.
  const { doc, resolveSkill } = fixture({
    nodes: [
      { id: 'A', unregistered: true, output: objectSchema(['tese_triada']) },
      { id: 'B', input: objectSchema(['tese_triada']) },
    ],
  });
  const report = validateContracts(doc, resolveSkill);

  assert.deepEqual(
    report.problems.map((problem) => problem.code).sort(),
    ['skill_ref_unresolved', 'unproduced_input'],
    'this case only proves what it claims if both codes are present',
  );
  assert.equal(report.valid, false);
  assert.equal(
    classifyContracts(report),
    'unchecked',
    'an unresolved pin outranks everything computed against it',
  );
});

test('t283 — a fully resolved report classifies as failed when it is invalid', () => {
  const { doc, resolveSkill } = fixture({
    nodes: [
      { id: 'A', produces: 'analise', output: objectSchema(['tese_triada']) },
      { id: 'B', input: objectSchema(['tese_triada']) },
    ],
  });
  const report = validateContracts(doc, resolveSkill);

  assert.deepEqual(
    report.problems.map((problem) => problem.code),
    ['unproduced_input'],
  );
  assert.equal(classifyContracts(report), 'failed');
});

test('t283 — a fully resolved report with no problem classifies as checked', () => {
  const { doc, resolveSkill } = fixture({
    nodes: [
      { id: 'A', output: objectSchema(['tese_triada']) },
      { id: 'B', input: objectSchema(['tese_triada']) },
    ],
  });
  const report = validateContracts(doc, resolveSkill);

  assert.deepEqual(report.problems, []);
  assert.equal(report.valid, true);
  assert.equal(classifyContracts(report), 'checked');
});

test('t283 — the classifier reads the report and nothing else', () => {
  // Hand-built reports, not fixtures: the contract of `classifyContracts` is a
  // function of the report alone, and a case that could only be produced by a
  // document would not say so.
  assert.equal(classifyContracts({ valid: true, problems: [] }), 'checked');
  assert.equal(
    classifyContracts({
      valid: false,
      problems: [
        { code: 'skill_ref_unresolved', node_id: 'A', message: 'nothing resolves this pin' },
      ],
    }),
    'unchecked',
  );
  assert.equal(
    classifyContracts({
      valid: false,
      problems: [
        {
          code: 'unproduced_input',
          node_id: 'B',
          key: 'tese_triada',
          message: 'nobody supplies it',
          produced_elsewhere_by: [],
        },
      ],
    }),
    'failed',
  );
});
