/**
 * Acceptance tests of t116 — factory graph 2 (asymmetric bets).
 *
 * They cover the whole bundle: the graph document, the seven skill manifests it
 * pins and the bundle validator. Same mould as `tests/factory-graph-1.test.mjs`
 * (t105), with two tests this graph's problem class demands and the software one
 * did not have:
 *
 * - **AT11** — the crossing by contract: each node's output feeds the next
 *   node's input, and the `decide` node produces no output at all without a
 *   recorded human answer. It is the proof, at contract level, of "a real thesis
 *   crosses all the way to the human decision" — not a live execution, which
 *   depends on t109 (see the bundle's README).
 * - **FR7** — the metrics recorded are process metrics, never a financial
 *   outcome (D14: "P&L is slow validation, never a round's metric").
 * - **FR10** (t145) — the bundle's README is executable documentation: every
 *   path it points at exists, and the command it publishes under `How to validate`
 *   runs green from the bundle directory. The two are separate tests because a
 *   dead link and a dead command are different failures to read.
 *
 * The hash procedure is reimplemented HERE, straight from the specification
 * (`specs/formats/skill-manifest.md`, "Identificação" section),
 * rather than imported from the validator: if the test reused the
 * implementation it checks, a bug in the canonicalizer would go unnoticed on
 * both sides.
 *
 * The schema keys are English since t178, and the CONTENT inside them since
 * t293: node ids, edge labels, domain roles, skill ids and every property name
 * of this bundle's own vocabulary moved with D24's series 1. What is still
 * Portuguese below is what no bundle edit could have changed — the projection
 * roots another package publishes (`perguntas_respondidas`, `pergunta`,
 * `resposta`), the reserved routing key `resultado`, the `problem_class` and the
 * directory (t282's), the crossing fixture's own frame keys and its Portuguese
 * thesis prose — plus the reference validator's pinned exports (t133,
 * exception 5).
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'factory-graphs', 'asymmetric-bets');
const SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');
const README_PATH = path.join(BUNDLE_DIR, 'README.md');
const GRAPH_PATH = path.join(BUNDLE_DIR, 'graph.json');
const GRAPH_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-graph.mjs');
const BUNDLE_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-factory-bundle.mjs');
const GRAPH_SCHEMA_PATH = path.join(ROOT, 'schema', 'graph.schema.json');
const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'specs',
  'formats',
  'skill-manifest.schema.json',
);
const THESIS_FIXTURE_PATH = path.join(
  ROOT,
  'tests',
  'fixtures',
  'bets-asymmetric-thesis-example.json',
);

/** D14's seven nodes: node -> { role, node_type, skill }. */
const NODES = {
  triage: { role: 'triager', node_type: 'gate', skill: 'triage-thesis' },
  'collect-fundamentals': { role: 'researcher', node_type: 'work', skill: 'collect-fundamentals' },
  'analyze-asymmetry': { role: 'analyst', node_type: 'work', skill: 'analyze-asymmetry' },
  'red-team': { role: 'red-team', node_type: 'gate', skill: 'red-team-thesis' },
  'size-risk': {
    role: 'risk-manager',
    node_type: 'work',
    skill: 'size-risk',
  },
  decide: { role: 'decision-maker', node_type: 'gate', skill: 'escalate-decision' },
  'record-monitoring': {
    role: 'recorder',
    node_type: 'work',
    skill: 'record-crossing',
  },
};

/** manifest file -> { id, role } (the manifest's role, not the node's). */
const SKILLS = {
  'triage-thesis.json': { id: 'triage-thesis', role: 'gate' },
  'collect-fundamentals.json': { id: 'collect-fundamentals', role: 'work' },
  'analyze-asymmetry.json': { id: 'analyze-asymmetry', role: 'work' },
  'red-team-thesis.json': { id: 'red-team-thesis', role: 'gate' },
  'size-risk.json': { id: 'size-risk', role: 'work' },
  'escalate-decision.json': { id: 'escalate-decision', role: 'gate' },
  'record-crossing.json': { id: 'record-crossing', role: 'work' },
};

const FILE_BY_SKILL = Object.fromEntries(
  Object.entries(SKILLS).map(([file, { id }]) => [id, file]),
);

/** The three gate skills, by the mandatory enum of `output.outcome`. */
const GATES = ['triage-thesis.json', 'red-team-thesis.json', 'escalate-decision.json'];
const GATE_RESULTS = ['pass', 'fail', 'escalate_human'];

/** FR2's nine edges. Two leave `decide` towards the same final node. */
const EXPECTED_EDGES = [
  { from: 'triage', to: 'collect-fundamentals', condition: 'advance' },
  { from: 'triage', to: 'record-monitoring', condition: 'discard' },
  { from: 'collect-fundamentals', to: 'analyze-asymmetry', condition: 'always' },
  { from: 'analyze-asymmetry', to: 'red-team', condition: 'always' },
  { from: 'red-team', to: 'size-risk', condition: 'survives' },
  { from: 'red-team', to: 'record-monitoring', condition: 'dead' },
  { from: 'size-risk', to: 'decide', condition: 'always' },
  { from: 'decide', to: 'record-monitoring', condition: 'approved' },
  { from: 'decide', to: 'record-monitoring', condition: 'rejected' },
];

/** The crossing order AT11 proves, from `triage` to `decide`. */
const CHAIN = [
  'triage',
  'collect-fundamentals',
  'analyze-asymmetry',
  'red-team',
  'size-risk',
  'decide',
];

/** Reads a JSON file from the repo, failing with its relative path if missing. */
function readJson(filePath) {
  assert.ok(existsSync(filePath), `artifact does not exist yet: ${path.relative(ROOT, filePath)}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

const readManifest = (file) => readJson(path.join(SKILLS_DIR, file));
const readManifestOfSkill = (skill) => readManifest(FILE_BY_SKILL[skill]);

/** Sorts keys recursively (RFC 8785, in the part this format uses). */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Canonical hash of the manifest, by the procedure in
 * `specs/formats/skill-manifest.md`: sha256 of the canonical JSON of
 * `{instructions, input, output, checks, permissions}`.
 */
function hashOfManifest(manifest) {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

let graphValidatorModule = null;
let bundleValidatorModule = null;

/**
 * Imports a validator on demand. The existence check comes before the
 * `import()` so the initial red says which artifact is missing, rather than
 * blowing up with a raw ERR_MODULE_NOT_FOUND.
 */
async function load(filePath, cache) {
  assert.ok(existsSync(filePath), `artifact does not exist yet: ${path.relative(ROOT, filePath)}`);
  return cache ?? (await import(`file://${filePath}`));
}

async function graphValidator() {
  graphValidatorModule = await load(GRAPH_VALIDATOR_PATH, graphValidatorModule);
  return graphValidatorModule;
}

async function bundleValidator() {
  bundleValidatorModule = await load(BUNDLE_VALIDATOR_PATH, bundleValidatorModule);
  return bundleValidatorModule;
}

/** Runs the bundle validator's CLI against a directory. */
function runCli(directory) {
  return spawnSync(process.execPath, [BUNDLE_VALIDATOR_PATH, directory], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

/** The graph document's node, by id. */
const findNode = (doc, id) => doc.nodes.find((node) => node.id === id);

/** Lines of a text that contain every given fragment. */
function linesWith(text, fragments) {
  return text
    .split('\n')
    .filter((line) => fragments.every((fragment) => line.includes(fragment)));
}

test("AT1 — graph.json passes validarEstrutura, validarSoundness and t96's schema", async () => {
  const { validarEstrutura, validarSoundness } = await graphValidator();
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.equal(validarEstrutura(doc).valid, true);
  assert.deepEqual(validarSoundness(doc).violations, []);
  assert.equal(validarSoundness(doc).valid, true);

  // The bundle does not validate shape against `schema/graph.schema.json` —
  // only structure and soundness. This document is new content, so the shape is
  // checked here.
  assert.deepEqual(validateAgainstSchema(doc, readJson(GRAPH_SCHEMA_PATH)), []);
});

test('AT2 — the 7 nodes and 9 edges match the FR1-FR2 tables exactly', () => {
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(doc.nodes.map((node) => node.id).sort(), Object.keys(NODES).sort());
  for (const [id, expected] of Object.entries(NODES)) {
    const node = findNode(doc, id);
    assert.equal(node.role, expected.role, `expected role for node "${id}"`);
    assert.equal(node.node_type, expected.node_type, `expected node_type for node "${id}"`);
    assert.equal(node.skill_ref.id, expected.skill, `expected skill_ref.id for node "${id}"`);
  }

  // The key includes the condition: two edges out of `decide` go to the same
  // final node, and a from/to-only key would collapse both into one.
  const key = (edge) => `${edge.from}>${edge.to}>${edge.condition}`;
  assert.equal(doc.edges.length, EXPECTED_EDGES.length);
  assert.deepEqual(doc.edges.map(key).sort(), EXPECTED_EDGES.map(key).sort());

  assert.equal(doc.initial_node, 'triage');
  assert.deepEqual(doc.final_nodes, ['record-monitoring']);
  assert.equal(doc.problem_class, 'asymmetric-bets');
  assert.equal(doc.lineage.type, 'base');
});

test('AT3 — the seven manifests validate against skill-manifest.schema.json', async () => {
  const { validateManifest } = await bundleValidator();
  const schema = readJson(MANIFEST_SCHEMA_PATH);
  assert.equal(
    typeof validateManifest,
    'function',
    'validate-factory-bundle.mjs has to export validateManifest',
  );

  for (const file of Object.keys(SKILLS)) {
    const { valid, errors } = validateManifest(readManifest(file));
    assert.deepEqual(errors, [], `${file}: schema errors`);
    assert.equal(
      valid,
      true,
      `${file} has to validate against ${path.basename(MANIFEST_SCHEMA_PATH)}`,
    );
  }

  // t97's negative fixture keeps being rejected by the same validator — that is
  // what proves the green above does not come from a permissive validator.
  assert.ok(schema.$defs.check, 'the manifest schema has to declare $defs.check');
  const invalid = readJson(
    path.join(ROOT, 'specs', 'formats', 'examples', 'skill-manifest.invalid.fixture.json'),
  );
  assert.equal(validateManifest(invalid).valid, false, "t97's negative fixture has to be rejected");
});

test('AT4 — the seven manifests exist with the expected kebab-case id and role', () => {
  for (const [file, expected] of Object.entries(SKILLS)) {
    const manifest = readManifest(file);
    assert.equal(manifest.id, expected.id, `${file}: id`);
    assert.equal(manifest.role, expected.role, `${file}: role`);
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.id),
      `${file}: the id has to be pure kebab-case, with no namespace prefix`,
    );
    assert.equal(
      manifest.id,
      path.basename(file, '.json'),
      `${file}: the id is the file name without its extension`,
    );
  }
});

test("AT5 — the three gates declare output.outcome with the enum's three values", () => {
  for (const file of GATES) {
    const manifest = readManifest(file);
    assert.equal(manifest.role, 'gate', `${file}: role`);
    assert.deepEqual(
      manifest.output.properties.outcome.enum,
      GATE_RESULTS,
      `${file}: output.outcome enum`,
    );
    assert.ok(
      manifest.output.required.includes('outcome'),
      `${file}: outcome has to be required in the gate's output`,
    );
  }
});

test("AT6 — the recomputed hash of each manifest matches the node's skill_ref", () => {
  const doc = readJson(GRAPH_PATH);
  const byId = new Map(
    Object.keys(SKILLS).map((file) => {
      const manifest = readManifest(file);
      return [manifest.id, manifest];
    }),
  );

  assert.equal(doc.nodes.length, 7);
  for (const node of doc.nodes) {
    const manifest = byId.get(node.skill_ref.id);
    assert.ok(manifest, `no manifest with id "${node.skill_ref.id}" (node "${node.id}")`);
    assert.equal(manifest.version, node.skill_ref.version, `node "${node.id}": pinned version`);
    assert.equal(
      hashOfManifest(manifest),
      node.skill_ref.hash,
      `node "${node.id}": the pinned hash has to be the manifest's real hash`,
    );
    assert.equal(
      manifest.hash,
      node.skill_ref.hash,
      `node "${node.id}": the manifest has to declare the same hash the node pins`,
    );
    assert.ok(
      /^sha256:[0-9a-f]{64}$/.test(node.skill_ref.hash),
      `node "${node.id}": a real hash, never a placeholder`,
    );
  }
});

test('AT7 — no deterministic check; every manifest has an agentic check with evidence', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.deepEqual(
      manifest.checks.filter((check) => check.type === 'deterministic'),
      [],
      `${file}: this problem class has no shop-floor command`,
    );
    const agentic = manifest.checks.filter((check) => check.type === 'agentic');
    assert.ok(agentic.length >= 1, `${file}: needs at least one agentic check`);
    for (const check of agentic) {
      assert.ok(
        Array.isArray(check.required_evidence) && check.required_evidence.length > 0,
        `${file}: check "${check.id}" needs a non-empty required_evidence`,
      );
    }
  }

  // The graph document cannot reintroduce from behind the deterministic check
  // the manifests refuse.
  const doc = readJson(GRAPH_PATH);
  for (const node of doc.nodes) {
    assert.deepEqual(
      node.contract.checks.filter((check) => check.type === 'deterministic'),
      [],
      `node "${node.id}": the contract cannot declare a deterministic check`,
    );
  }

  // The structural limit that does exist is imposed by JSON Schema, not by a
  // manufactured check (FR8).
  const sizing = readManifest('size-risk.json');
  const size = sizing.output.properties.sizing.properties.position_size_pct;
  assert.equal(typeof size.maximum, 'number', 'the position ceiling is a schema maximum');
  assert.ok(size.maximum > 0);
});

test('AT8 — red-team-thesis forbids "passed" with a high objection the thesis never answered', () => {
  const manifest = readManifest('red-team-thesis.json');

  const objections = manifest.output.properties.objections;
  assert.ok(manifest.output.required.includes('objections'), 'objections is required in the output');
  assert.deepEqual(
    objections.items.required.sort(),
    ['objection', 'severity', 'thesis_answer'],
    'every objection declares objection, severity and thesis_answer',
  );
  assert.deepEqual(
    objections.items.properties.thesis_answer.type,
    ['string', 'null'],
    'thesis_answer is null when the thesis did not answer',
  );

  // The instruction PROSE moved to English with t293, word for word and with
  // the divergence it carries intact: the prohibition still teaches
  // `resultado: "passed"` — the vocabulary from before t178 and t161 — because a
  // translation ticket changes the language and never the behaviour. What is
  // matched here is that prose, in the spelling it has now.
  const prohibition = linesWith(manifest.instructions, [
    'passed',
    'survives',
    'severity',
    'high',
    'thesis_answer',
  ]).filter((line) => /NEVER|never/.test(line));
  assert.ok(
    prohibition.length >= 1,
    'instructions has to explicitly forbid concluding "passed" (edge "survives") while a high-severity objection has no thesis_answer',
  );

  const counterEvidence = manifest.checks
    .filter((check) => check.type === 'agentic')
    .flatMap((check) => check.required_evidence);
  assert.ok(
    counterEvidence.some((item) => /counter_evidence|counter-evidence/.test(item)),
    'the agentic check demands specific researched counter-evidence, not a reread of the analysis',
  );
});

test('AT9 — escalate-decision never produces a result without a recorded human answer', () => {
  const manifest = readManifest('escalate-decision.json');

  assert.ok(
    manifest.input.required.includes('perguntas_respondidas'),
    'the input has to require perguntas_respondidas',
  );
  assert.deepEqual(
    manifest.input.properties.perguntas_respondidas.items.required.sort(),
    ['id', 'pergunta', 'resposta'],
    'every answered question carries id, pergunta and resposta',
  );

  const prohibition = linesWith(manifest.instructions, [
    'perguntas_respondidas',
    'resultado',
  ]).filter((line) => /NEVER|never/.test(line));
  assert.ok(
    prohibition.length >= 1,
    'instructions has to forbid producing a result without an allocation answer in perguntas_respondidas',
  );
  assert.ok(
    manifest.instructions.includes('```input-request'),
    'a session with no recorded answer ends its turn with an input-request block',
  );

  const evidence = manifest.checks
    .filter((check) => check.type === 'agentic')
    .flatMap((check) => check.required_evidence);
  assert.ok(
    evidence.some((item) => /allocation_question_id/.test(item)),
    "the mandatory evidence has to cite the allocation question's id",
  );
  assert.ok(
    evidence.some((item) => /literal_text_of_the_answer/.test(item)),
    'the mandatory evidence has to cite the literal text of the recorded answer',
  );
});

test('AT10 — every instructions carries the escalation block; only collect-fundamentals opens the network', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.ok(
      manifest.instructions.includes('```input-request'),
      `${file}: instructions has to contain the \`\`\`input-request marker`,
    );
    assert.deepEqual(
      manifest.permissions.filesystem.write,
      [],
      `${file}: no node of this graph writes to the investor's repository`,
    );
  }

  const research = readManifest('collect-fundamentals.json');
  assert.equal(research.permissions.network.allowed, true, 'collect-fundamentals needs the network');
  assert.equal(
    research.permissions.network.domains,
    undefined,
    'unrestricted network: a fixed allowlist does not cover fundamentals research (native skill)',
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'collect-fundamentals.json')) {
    assert.equal(readManifest(file).permissions.network.allowed, false, `${file}: network closed`);
  }
});

test('AT11 — the thesis fixture crosses contract by contract up to the human decision', async () => {
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);
  const fixture = readJson(THESIS_FIXTURE_PATH);

  const steps = fixture.travessia;
  assert.deepEqual(
    steps.map((step) => step.no),
    CHAIN,
    "the fixture's crossing follows triage → … → decide",
  );

  // 1. Every payload holds against BOTH of the node's contracts: the graph
  //    document's (what the executor reads) and the manifest's (what the runner
  //    validates).
  for (const step of steps) {
    const node = findNode(doc, step.no);
    const manifest = readManifestOfSkill(NODES[step.no].skill);
    assert.deepEqual(
      validateAgainstSchema(step.entrada, node.contract.input_schema),
      [],
      `node "${step.no}": input against the graph's input_schema`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.entrada, manifest.input),
      [],
      `node "${step.no}": input against the manifest's input`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.saida, node.contract.output_schema),
      [],
      `node "${step.no}": output against the graph's output_schema`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.saida, manifest.output),
      [],
      `node "${step.no}": output against the manifest's output`,
    );
  }

  // 2. A node's output FEEDS the next node's input: every field the next
  //    contract declares and the previous one produced arrives intact.
  for (let i = 0; i < steps.length - 1; i += 1) {
    const previous = steps[i];
    const next = steps[i + 1];
    const declared = Object.keys(readManifestOfSkill(NODES[next.no].skill).input.properties);
    const carried = Object.keys(previous.saida).filter((key) => declared.includes(key));
    assert.ok(
      carried.length >= 1,
      `nothing from "${previous.no}" feeds "${next.no}": the chain is broken`,
    );
    for (const key of carried) {
      assert.deepEqual(
        next.entrada[key],
        previous.saida[key],
        `"${key}" arrives from "${previous.no}" at "${next.no}" unchanged`,
      );
    }
  }

  // 3. Each gate's routing is a declared edge, never a free choice.
  const edgeFrom = (from, condition) =>
    doc.edges.find((edge) => edge.from === from && edge.condition === condition);
  const redTeam = steps.find((step) => step.no === 'red-team');
  assert.equal(redTeam.saida.outcome, 'pass', 'in the fixture the thesis survives the red team');
  assert.ok(edgeFrom('red-team', 'survives'), 'passing the red team follows the "survives" edge');

  // 4. No edge out of `decide` is followed without a human answer.
  const decisionStep = steps.at(-1);
  const decisionManifest = readManifestOfSkill('escalate-decision');
  const question = fixture.pergunta_de_alocacao;

  const withoutAnswer = fixture.decisao_sem_resposta_humana;
  assert.deepEqual(
    withoutAnswer.entrada.perguntas_respondidas,
    [],
    'the no-human-answer variant reaches the node with an empty question queue',
  );
  assert.deepEqual(
    validateAgainstSchema(withoutAnswer.entrada, decisionManifest.input),
    [],
    'entering `decide` without a human answer is legal — the session pauses, it does not fail',
  );
  const errors = validateAgainstSchema(withoutAnswer.saida_tentada, decisionManifest.output);
  assert.ok(
    errors.length > 0 && errors.some((error) => /human_decision/.test(error.message)),
    `a result without the recorded human decision has to be refused by the contract: ${JSON.stringify(errors)}`,
  );

  // 5. With the answer recorded, the result is a literal transcription of it.
  const recorded = decisionStep.entrada.perguntas_respondidas.find(
    (answered) => answered.id === question.id,
  );
  assert.ok(recorded, 'the allocation answer arrives in entrada.perguntas_respondidas');
  assert.equal(decisionStep.saida.human_decision.question_id, question.id);
  assert.equal(
    decisionStep.saida.human_decision.literal_answer,
    recorded.resposta,
    'the result quotes the human answer literally, without interpreting it',
  );
  assert.ok(
    edgeFrom('decide', fixture.aresta_esperada),
    `the "${fixture.aresta_esperada}" edge has to exist out of "decide"`,
  );
});

test('FR7 — record-crossing records process metrics, never a financial outcome', () => {
  const manifest = readManifest('record-crossing.json');
  const metrics = manifest.output.properties.process_metrics;

  assert.ok(manifest.output.required.includes('process_metrics'));
  for (const field of [
    'red_team_ran',
    'sourced_assumptions_fraction',
    'human_decision_id',
    'final_outcome',
  ]) {
    assert.ok(metrics.required.includes(field), `process_metrics has to require "${field}"`);
  }
  assert.equal(metrics.properties.red_team_ran.type, 'boolean');
  assert.equal(metrics.properties.sourced_assumptions_fraction.minimum, 0);
  assert.equal(metrics.properties.sourced_assumptions_fraction.maximum, 1);
  assert.deepEqual(
    metrics.properties.human_decision_id.type,
    ['string', 'null'],
    'null only when the crossing never reached decide',
  );
  assert.deepEqual(metrics.properties.final_outcome.enum, ['monitoring', 'archived']);

  // D14: "P&L is slow long-term validation, never a round's metric".
  const serialized = JSON.stringify(manifest.output);
  for (const forbidden of ['p_l', 'pnl', 'profit', 'realized_return', 'financial_outcome']) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `the output cannot carry a financial-outcome metric ("${forbidden}")`,
    );
  }
});

/*
 * t168 — the fields D14 asks of a thesis that software has no place for.
 *
 * `premise_source` and `asset` (t260) are demanded at `triage`, the one gate
 * that decides whether the idea is worth research at all: a thesis with no
 * declared source has nothing to trust and one with no identified asset has
 * nothing to triage. `downside` and `upside` are the proponent's own numbers,
 * entered before `analyze-asymmetry` produces the real figures — so they are
 * declared without a node demanding them.
 */
test('t168 — the bets graph declares the class custom fields, and the bundle still validates', async () => {
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(
    validateAgainstSchema(doc, readJson(GRAPH_SCHEMA_PATH)),
    [],
    'the document with custom_fields in it still holds against the schema',
  );

  const declarations = new Map(doc.custom_fields.map((entry) => [entry.name, entry]));
  assert.deepEqual([...declarations.keys()].sort(), [
    'asset',
    'downside',
    'intended_size',
    'premise_source',
    'upside',
  ]);

  for (const key of ['premise_source', 'asset']) {
    const demanded = declarations.get(key);
    assert.equal(demanded.type, 'string', `${key}: type`);
    assert.equal(demanded.required_at, 'triage', `${key}: required_at`);
    assert.ok(
      doc.nodes.some((node) => node.id === demanded.required_at),
      'required_at has to name a node this document really has',
    );
  }

  // t263: the intended position size is the class's own field too, and it is
  // demanded at the same gate — without it nobody, neither the triage nor the
  // investor, can tell whether the thesis fits the portfolio's risk ceiling.
  const size = declarations.get('intended_size');
  assert.equal(size.type, 'number', 'intended_size: type');
  assert.equal(size.required_at, 'triage', 'intended_size: required_at');
  assert.ok(
    doc.nodes.some((node) => node.id === size.required_at),
    'required_at has to name a node this document really has',
  );

  for (const key of ['downside', 'upside']) {
    assert.equal(declarations.get(key).type, 'number');
    assert.equal(
      declarations.get(key).required_at,
      null,
      `${key} is informational: no node blocks the crossing on it`,
    );
  }
});

/*
 * t263 — two of the four triage criteria used to come out `undetermined` for
 * data the graph already carried.
 *
 * `project.portfolio` reached the graph's `project` object in t260, but the
 * manifest only ever interpolated `triage_criteria`: the paragraph that
 * spoke of the risk ceiling named `input.project.portfolio` between backticks,
 * and backticks are not double braces — the renderer only substitutes
 * `{{input.…}}` tokens, so the value never left the JSON. The investor's circle
 * of competence had no place at all, and the intended position size had no
 * field. What is asserted here is the pair that makes the criteria judgeable:
 * the shape in `input`, and the three literal tokens in `instructions`.
 *
 * `portfolio` is required AND nullable rather than optional because the
 * placeholder engine fails closed on a missing key
 * (`packages/runner/src/dispatch/render-skill-instructions.ts`): a `project`
 * with no open position has to send `portfolio: null` on purpose, never omit it.
 */
test('t263 — triage-thesis interpolates portfolio, circle of competence and intended size', () => {
  const manifest = readManifest('triage-thesis.json');
  const project = manifest.input.properties.project;

  for (const key of ['portfolio', 'circle_of_competence']) {
    assert.ok(project.required.includes(key), `project.required has to demand ${key}`);
  }
  assert.deepEqual(
    project.properties.portfolio.type,
    ['object', 'null'],
    'portfolio is nullable, never absent: the placeholder engine fails closed on a missing key',
  );
  assert.equal(project.properties.circle_of_competence.type, 'array');
  assert.equal(
    project.properties.circle_of_competence.minItems,
    1,
    'an empty circle of competence is no circle at all',
  );
  assert.equal(project.properties.circle_of_competence.items.type, 'string');

  assert.ok(
    manifest.input.required.includes('intended_size'),
    'the intended size is demanded at the top of the input, beside asset and premise_source',
  );
  assert.equal(
    manifest.input.properties.intended_size.type,
    'number',
    'a class field is a flat scalar at the top, never a nested object (t168)',
  );

  for (const token of [
    '{{input.project.portfolio}}',
    '{{input.project.circle_of_competence}}',
    '{{input.intended_size}}',
  ]) {
    assert.ok(
      manifest.instructions.includes(token),
      `instructions has to really interpolate ${token}, not merely name the path`,
    );
  }
});

test('t263 — the README documents the two new inputs of the triage', () => {
  const text = readFileSync(README_PATH, 'utf8');

  for (const key of ['circle_of_competence', 'intended_size']) {
    assert.ok(
      text.includes(key),
      `the README has to document ${key}: documentation cannot lag the schema`,
    );
  }
});

/**
 * The routing label a gate's report carries, and why the output has to declare
 * it (t276).
 *
 * The report protocol is ONE fenced block (t161, t259): the label of the edge
 * the node took rides INSIDE the object the node's `output` schema declares, and
 * `PATCH /v1/sessions/:id/finish` holds that whole object against the schema of
 * the skill the node pins (`packages/core/src/repositories/session.ts`). Every
 * `output` of this bundle closes with `additionalProperties: false`, so a gate
 * that does not declare `resultado` has its ENTIRE report refused — stored as
 * `null`, with the next node's `input` projected from nothing.
 *
 * `triage-thesis` learned this in t260, when the first live crossing hit it. The
 * other two gates were left as they were and nothing exercised them, so the
 * claim is made here for all three at once: every gate of this graph, against
 * every edge that really leaves it.
 */
test('t276 — every gate declares `resultado`, the edge label its own report carries', async () => {
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);
  const fixture = readJson(THESIS_FIXTURE_PATH);

  const gates = doc.nodes.filter((node) => node.node_type === 'gate');
  assert.deepEqual(
    gates.map((node) => node.id),
    ['triage', 'red-team', 'decide'],
    'the three gates of D14, in document order',
  );

  for (const node of gates) {
    const manifest = readManifestOfSkill(node.skill_ref.id);
    const declared = manifest.output.properties.resultado;

    assert.equal(
      manifest.output.additionalProperties,
      false,
      `${node.skill_ref.id}: the output is closed — which is what makes an undeclared label a refusal`,
    );
    assert.ok(declared, `${node.skill_ref.id}: output has to declare "resultado"`);
    assert.equal(declared.type, 'string', `${node.skill_ref.id}: the label is a plain string`);
    assert.ok(
      !('enum' in declared),
      `${node.skill_ref.id}: no enum — the labels are the GRAPH's vocabulary, and the same skill can live under two graphs`,
    );
    assert.ok(
      !manifest.output.required.includes('resultado'),
      `${node.skill_ref.id}: the label is not required — it is the graph's word, and only a routing node emits one`,
    );

    // What a real session prints: the payload the fixture already proves valid
    // (AT11), plus the label of each edge that leaves this node.
    const conditions = doc.edges.filter((edge) => edge.from === node.id).map((edge) => edge.condition);
    assert.equal(conditions.length, 2, `${node.id}: a gate of this graph has two ways out`);

    const reported = fixture.travessia.find((step) => step.no === node.id).saida;
    for (const condition of conditions) {
      assert.deepEqual(
        validateAgainstSchema({ ...reported, resultado: condition }, manifest.output),
        [],
        `${node.id}: a report carrying the "${condition}" label has to be accepted whole`,
      );
    }
  }
});

test('AT12 — the validator CLI approves the bundle and rejects a tampered hash', () => {
  assert.ok(
    existsSync(BUNDLE_VALIDATOR_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, BUNDLE_VALIDATOR_PATH)}`,
  );

  const good = runCli(BUNDLE_DIR);
  assert.equal(good.status, 0, `the real bundle has to exit 0:\n${good.stdout}${good.stderr}`);

  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-bundle-')), 'bundle');
  cpSync(BUNDLE_DIR, copy, { recursive: true });
  const target = path.join(copy, 'skills', 'red-team-thesis.json');
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

  const bad = runCli(copy);
  assert.notEqual(bad.status, 0, 'a tampered hash has to exit with a non-zero code');
  assert.ok(
    `${bad.stdout}${bad.stderr}`.includes('red-team'),
    `the report has to name the diverging node:\n${bad.stdout}${bad.stderr}`,
  );
});

/**
 * Resolves a path the README names, the way a reader following it does.
 *
 * A `./` or `../` reference is relative to the bundle; a bare one is relative
 * to the repo root when its first segment is a repo entry (`tests/…`,
 * `docs/…`), and to the bundle otherwise (`skills/…`). The `#anchor` and the
 * `file.md:172` line suffix are cut before resolving.
 */
function resolveReference(reference) {
  const target = reference.replace(/[:#].*$/, '');
  if (target.startsWith('.')) return path.resolve(BUNDLE_DIR, target);
  const [head] = target.split('/');
  const base = readdirSync(ROOT).includes(head) ? ROOT : BUNDLE_DIR;
  return path.resolve(base, target);
}

/**
 * Every path the README points at, in the three shapes that carry one: a
 * markdown link target, a backticked inline reference, and the script of a
 * fenced `node …` command.
 *
 * A reference with a `<placeholder>` in it (`factory-graphs/<classe>/`) is
 * a shape, not a path, and is skipped. So is an external URL.
 */
function referencesIn(text) {
  const found = new Set();
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) found.add(target);
  for (const [, target] of text.matchAll(/`([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\/?(?::\d+)?)`/g)) {
    found.add(target);
  }
  for (const [, script] of text.matchAll(/^\s*node\s+(\S+)/gm)) found.add(script);

  return [...found].filter(
    (reference) => !reference.includes('<') && !/^[a-z]+:\/\//.test(reference),
  );
}

/** The first fenced block under a heading, as its lines. */
function fencedBlockUnder(text, heading) {
  const index = text.indexOf(heading);
  assert.notEqual(index, -1, `the README no longer has a "${heading}" section`);
  const block = text.slice(index + heading.length).match(/```[a-z]*\n([\s\S]*?)```/);
  assert.ok(block, `the "${heading}" section has no fenced block in it`);
  return block[1].split('\n');
}

test('FR10 — every path the README points at exists', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const references = referencesIn(text);
  assert.ok(references.length >= 10, `only ${references.length} references read; the sweep is blind`);

  const dead = references.filter((reference) => !existsSync(resolveReference(reference)));

  assert.deepEqual(dead, [], `the README points at files that do not exist:\n${dead.join('\n')}`);
});

test('FR10 — the command the README documents under "How to validate" runs green', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const documented = fencedBlockUnder(text, '## How to validate')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node '));

  assert.ok(documented.length > 0, 'the "How to validate" block no longer documents a node command');

  for (const command of documented) {
    const [, ...argv] = command.split(/\s+/);
    const run = spawnSync(process.execPath, argv, { cwd: BUNDLE_DIR, encoding: 'utf8' });
    assert.equal(
      run.status,
      0,
      `\`${command}\` has to exit 0 from the bundle dir:\n${run.stdout}${run.stderr}`,
    );
  }
});

/*
 * t278 — contract matching, over the bundle's REAL manifests.
 *
 * This bundle is the one that named its own gap: `size-risk` used to
 * require a bare top-level `capital` object nothing in the graph produced
 * (README, "os dois buracos"), and closing it as a declaration under `project`
 * is what makes this case green. The three short paths into
 * `record-monitoring` are the other half of what is proved here: arriving
 * from `triage --discard-->` or `red-team --dead-->` there is no
 * `sizing` and no `human_decision`, and that is legal precisely
 * because `record-crossing` declares them as properties and demands
 * neither.
 */
const CORE_GRAPH_MODULE = path.join(ROOT, 'packages', 'core', 'src', 'domain', 'graph.ts');
let contractValidatorModule = null;

async function contractValidator() {
  contractValidatorModule = await load(CORE_GRAPH_MODULE, contractValidatorModule);
  return contractValidatorModule;
}

/** Resolves a node's pin against the manifests shipped in `skills/`, with overrides. */
function bundleSkillLookup(overrides = {}) {
  const byId = new Map(
    readdirSync(SKILLS_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const manifest = readJson(path.join(SKILLS_DIR, name));
        return [manifest.id, overrides[manifest.id] ?? manifest];
      }),
  );
  return (ref) => {
    const manifest = byId.get(ref.id);
    return manifest === undefined ? undefined : { input: manifest.input, output: manifest.output };
  };
}

test('t278 — every required input of every node has a producer on every path into it', async () => {
  const { validateContracts } = await contractValidator();
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup());

  assert.deepEqual(report.problems, []);
  assert.equal(report.valid, true);
});

test('t283 — the bundle classifies as checked, so an import needs no re-check', async () => {
  // `cartografo import` registers every manifest of `skills/` BEFORE sending the
  // graph, so by the time `POST /v1/graphs` runs the check, every pin resolves
  // and the version is born `checked` — no waiting, no re-check event, and a job
  // may run against it the moment it exists. What that check answers over the
  // registry is what this one answers over the same manifests on disk.
  const { classifyContracts, validateContracts } = await contractValidator();
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup());

  assert.equal(
    classifyContracts(report),
    'checked',
    'an `unchecked` here would mean a bundle whose own manifests do not answer for its pins',
  );
});

test('t278 — the optional keys of record-crossing are what makes the short paths legal', async () => {
  const { validateContracts } = await contractValidator();
  const manifest = readManifest('record-crossing.json');

  for (const key of ['assumptions', 'objections', 'sizing', 'human_decision']) {
    assert.ok(
      Object.hasOwn(manifest.input.properties, key),
      `record-crossing declares "${key}" as a property`,
    );
    assert.ok(
      !manifest.input.required.includes(key),
      `"${key}" cannot be required: three different paths reach this node`,
    );
  }

  // And the check really bites: demanding one of them turns the very same
  // bundle red, naming the node that produces it on the long path only.
  const demanded = {
    ...manifest,
    input: { ...manifest.input, required: [...manifest.input.required, 'sizing'] },
  };
  const report = validateContracts(
    readJson(GRAPH_PATH),
    bundleSkillLookup({ 'record-crossing': demanded }),
  );

  // One problem for the key itself and one for each of its own required
  // sub-keys: the check reads one level into a required object, on both sides.
  assert.ok(report.problems.length > 0);
  for (const problem of report.problems) {
    assert.equal(problem.code, 'unproduced_input');
    assert.equal(problem.node_id, 'record-monitoring');
    assert.ok(problem.key === 'sizing' || problem.key.startsWith('sizing.'));
    assert.deepEqual(problem.produced_elsewhere_by, ['size-risk']);
  }
  assert.equal(report.problems[0].key, 'sizing');
});
