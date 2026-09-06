/**
 * Acceptance tests of t406 — factory graph 3 (B3 flow radar).
 *
 * Same mould as `tests/factory-graph-2.test.mjs` (t116), for the third bundle
 * RF-13 asked for: a runnable example map outside software, importable with no
 * extra configuration and with no network at any point (RF-28). What this
 * bundle adds to the mould, and what the tests below therefore say that no
 * earlier bundle's did:
 *
 * - **AT7** — this is the first bundle that MIXES the two check types. Bundle 2
 *   is all-agentic because its class has no shop floor; this one has one, and
 *   it is `check-intake`: a `shell` node whose verification is the same command
 *   the node itself runs. The test asserts which node is which, so a later
 *   edit cannot quietly turn the deterministic gate into a judgement.
 * - **AT10** — the shipped script is exercised as a script, four verdicts and
 *   one crash, because a deterministic gate whose failure mode nobody ran is
 *   not deterministic, it is untested.
 * - **AT12** — the row-count ranges are declared once, in `graph.json`'s
 *   `project.expected_row_counts`, and both the shipped fixtures and the
 *   shipped script are held against THAT declaration. It is what stops the
 *   fixtures and the check from drifting apart in silence.
 * - **AT5** — the `resultado` divergence bundle 2 accumulated across `t260`
 *   and `t276` is asserted here before any manifest exists, for all three
 *   gates at once (FR17).
 * - **AT9** — stricter than bundle 1's and bundle 2's AT10, which each allow
 *   one node to open the network. Here no node does: the fixture is all the
 *   data any node reads, and a closed network is the whole bundle's posture.
 *
 * The hash procedure is reimplemented HERE, straight from the specification
 * (`specs/formats/skill-manifest.md`, "Identification" section), rather than
 * imported from the validator: if the test reused the implementation it checks,
 * a bug in the canonicalizer would go unnoticed on both sides. Note that this
 * bundle is the first whose subset is not academic — `check-flow-intake`
 * carries a `command`, and on a shell skill the argv IS the behaviour.
 *
 * Everything this bundle writes is English (D24). What is Portuguese below is
 * what no bundle may spell otherwise: the reserved routing key `resultado`
 * (`packages/runner/src/dispatch/parse-node-result.ts`) and the projection
 * vocabulary another package publishes (`perguntas_respondidas`).
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'factory-graphs', 'b3-flow-radar');
const SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');
const FIXTURES_DIR = path.join(BUNDLE_DIR, 'fixtures');
const README_PATH = path.join(BUNDLE_DIR, 'README.md');
const GRAPH_PATH = path.join(BUNDLE_DIR, 'graph.json');
const DEMO_JOB_PATH = path.join(BUNDLE_DIR, 'demo', 'job.json');
const INTAKE_SCRIPT_PATH = path.join(BUNDLE_DIR, 'scripts', 'check-intake.mjs');
const GRAPH_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-graph.mjs');
const BUNDLE_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-factory-bundle.mjs');
const GRAPH_SCHEMA_PATH = path.join(ROOT, 'schema', 'graph.schema.json');
const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'specs',
  'formats',
  'skill-manifest.schema.json',
);
const CROSSING_FIXTURE_PATH = path.join(
  ROOT,
  'tests',
  'fixtures',
  'b3-flow-radar-crossing.fixture.json',
);
const ROOT_README_PATH = path.join(ROOT, 'README.md');
const WHAT_IT_IS_PATH = path.join(ROOT, 'docs', 'what-cartografo-is.md');

/** FR2's seven nodes: node -> { role, node_type, engine, skill }. */
const NODES = {
  'check-intake': {
    role: 'intake-gate',
    node_type: 'gate',
    engine: 'shell',
    skill: 'check-flow-intake',
  },
  triage: { role: 'triager', node_type: 'gate', engine: null, skill: 'triage-flow-signals' },
  contextualize: {
    role: 'researcher',
    node_type: 'work',
    engine: null,
    skill: 'contextualize-flow-signals',
  },
  hypothesize: {
    role: 'analyst',
    node_type: 'work',
    engine: null,
    skill: 'hypothesize-flow-driver',
  },
  'red-team': {
    role: 'red-team',
    node_type: 'gate',
    engine: null,
    skill: 'red-team-flow-hypothesis',
  },
  'compose-brief': { role: 'writer', node_type: 'work', engine: null, skill: 'compose-flow-brief' },
  scorecard: { role: 'recorder', node_type: 'work', engine: null, skill: 'record-flow-scorecard' },
};

/** manifest file -> { id, role } (the manifest's role, not the node's). */
const SKILLS = {
  'check-flow-intake.json': { id: 'check-flow-intake', role: 'gate' },
  'triage-flow-signals.json': { id: 'triage-flow-signals', role: 'gate' },
  'contextualize-flow-signals.json': { id: 'contextualize-flow-signals', role: 'work' },
  'hypothesize-flow-driver.json': { id: 'hypothesize-flow-driver', role: 'work' },
  'red-team-flow-hypothesis.json': { id: 'red-team-flow-hypothesis', role: 'gate' },
  'compose-flow-brief.json': { id: 'compose-flow-brief', role: 'work' },
  'record-flow-scorecard.json': { id: 'record-flow-scorecard', role: 'work' },
};

const FILE_BY_SKILL = Object.fromEntries(
  Object.entries(SKILLS).map(([file, { id }]) => [id, file]),
);

/** The three gates, by the mandatory enum of `output.outcome` (FR17). */
const GATES = [
  'check-flow-intake.json',
  'triage-flow-signals.json',
  'red-team-flow-hypothesis.json',
];
const GATE_RESULTS = ['pass', 'fail', 'escalate_human'];

/** FR3's nine edges. Four of them reach the single final node. */
const EXPECTED_EDGES = [
  { from: 'check-intake', to: 'triage', condition: 'pass' },
  { from: 'check-intake', to: 'scorecard', condition: 'fail' },
  { from: 'triage', to: 'contextualize', condition: 'advance' },
  { from: 'triage', to: 'scorecard', condition: 'discard' },
  { from: 'contextualize', to: 'hypothesize', condition: 'always' },
  { from: 'hypothesize', to: 'red-team', condition: 'always' },
  { from: 'red-team', to: 'compose-brief', condition: 'survives' },
  { from: 'red-team', to: 'scorecard', condition: 'dead' },
  { from: 'compose-brief', to: 'scorecard', condition: 'always' },
];

/** The crossing order AT13 proves, from `check-intake` to `compose-brief`. */
const CHAIN = [
  'check-intake',
  'triage',
  'contextualize',
  'hypothesize',
  'red-team',
  'compose-brief',
];

/** The three days the bundle ships, and the four files each of them holds. */
const DAYS = ['day-1', 'day-2', 'day-3'];

/** fixture file -> the key of `project.expected_row_counts` that ranges it. */
const FIXTURE_FILES = {
  'daily-figures.json': 'daily_figures',
  'broker-flow.json': 'broker_flow',
  'signals.json': 'signals',
  'facts.json': 'facts',
};

/** FR8's ceilings, in bytes. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;

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
 * `{instructions, input, output, checks, permissions, budgets, command}`.
 *
 * `command` is in the subset and it matters here for the first time in a
 * bundle: `check-flow-intake` declares one, and on a shell skill the argv is
 * not a note about the behaviour, it IS the behaviour (D4).
 */
function hashOfManifest(manifest) {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
    command: manifest.command,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(subset)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

let graphValidatorModule = null;
let bundleValidatorModule = null;
let contractValidatorModule = null;

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

const CORE_GRAPH_MODULE = path.join(ROOT, 'packages', 'core', 'src', 'domain', 'graph.ts');

async function contractValidator() {
  contractValidatorModule = await load(CORE_GRAPH_MODULE, contractValidatorModule);
  return contractValidatorModule;
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

  assert.deepEqual(validateAgainstSchema(doc, readJson(GRAPH_SCHEMA_PATH)), []);
});

test('AT2 — the 7 nodes and 9 edges match the FR2/FR3 tables exactly', () => {
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(doc.nodes.map((node) => node.id).sort(), Object.keys(NODES).sort());
  for (const [id, expected] of Object.entries(NODES)) {
    const node = findNode(doc, id);
    assert.equal(node.role, expected.role, `expected role for node "${id}"`);
    assert.equal(node.node_type, expected.node_type, `expected node_type for node "${id}"`);
    assert.equal(node.skill_ref.id, expected.skill, `expected skill_ref.id for node "${id}"`);

    // `check-intake` is this bundle's — and the repository's — first real
    // consumer of the `shell` engine (t332). Every other node stays silent
    // about the engine, which is what makes it the runner's default.
    if (expected.engine === null) {
      assert.ok(
        !Object.hasOwn(node, 'engine'),
        `node "${id}" declares an engine; only "check-intake" does`,
      );
    } else {
      assert.equal(node.engine, expected.engine, `node "${id}": engine`);
    }
  }

  const key = (edge) => `${edge.from}>${edge.to}>${edge.condition}`;
  assert.equal(doc.edges.length, EXPECTED_EDGES.length);
  assert.deepEqual(doc.edges.map(key).sort(), EXPECTED_EDGES.map(key).sort());

  assert.equal(doc.initial_node, 'check-intake');
  assert.deepEqual(doc.final_nodes, ['scorecard']);
  assert.equal(doc.problem_class, 'b3-flow-radar');
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

    // FR2: the ids are domain-suffixed, so a project importing two bundles
    // never collides in the registry. `triage` alone would.
    assert.ok(
      /-flow(-|$)/.test(manifest.id),
      `${file}: the id has to carry this bundle's domain suffix, never a bare verb`,
    );
  }
});

/*
 * FR17 — the defect bundle 2 accumulated in `t260` and repaired in `t276`,
 * written down here before a single manifest exists.
 *
 * The report protocol is ONE fenced block: the label of the edge the node took
 * rides INSIDE the object the node's `output` declares, and `PATCH /finish`
 * holds that whole object against the pinned skill's schema. With
 * `additionalProperties: false` — which every `output` of this bundle uses — a
 * gate that does not declare `resultado` has its ENTIRE report refused, stored
 * as `null`, and the next node projects its input from nothing.
 */
test('AT5 — the three gates declare outcome (enum, required) AND resultado (optional, no enum)', async () => {
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);
  const fixture = readJson(CROSSING_FIXTURE_PATH);

  const gates = doc.nodes.filter((node) => node.node_type === 'gate');
  assert.deepEqual(
    gates.map((node) => node.id),
    ['check-intake', 'triage', 'red-team'],
    'the three gates of this graph, in document order',
  );

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

    const declared = manifest.output.properties.resultado;
    assert.equal(
      manifest.output.additionalProperties,
      false,
      `${file}: the output is closed — which is what makes an undeclared label a refusal`,
    );
    assert.ok(declared, `${file}: output has to declare "resultado"`);
    assert.equal(declared.type, 'string', `${file}: the label is a plain string`);
    assert.ok(
      !('enum' in declared),
      `${file}: no enum — the labels are the GRAPH's vocabulary, and the same skill can live ` +
        'under two graphs',
    );
    assert.ok(
      !manifest.output.required.includes('resultado'),
      `${file}: the label is not required — only a routing node emits one`,
    );
  }

  // What a real session prints: the payload the crossing fixture already proves
  // valid (AT13), plus the label of each edge that leaves this gate.
  for (const node of gates) {
    const manifest = readManifestOfSkill(node.skill_ref.id);
    const conditions = doc.edges
      .filter((edge) => edge.from === node.id)
      .map((edge) => edge.condition);
    assert.equal(conditions.length, 2, `${node.id}: a gate of this graph has two ways out`);

    const reported = fixture.crossing.find((step) => step.node === node.id).output;
    for (const condition of conditions) {
      assert.deepEqual(
        validateAgainstSchema({ ...reported, resultado: condition }, manifest.output),
        [],
        `${node.id}: a report carrying the "${condition}" label has to be accepted whole`,
      );
    }
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

test('AT7 — check-flow-intake is the one deterministic check; the other six are agentic', () => {
  const intake = readManifest('check-flow-intake.json');
  assert.equal(intake.checks.length, 1, 'the shell gate declares exactly one check');
  assert.equal(intake.checks[0].type, 'deterministic');
  assert.equal(
    typeof intake.checks[0].command,
    'string',
    'a deterministic check is a command, and the command is what it declares',
  );

  // FR10: the check restates the invocation the node itself runs, joined with
  // spaces — which is what makes t176's graph/manifest parity meaningful here.
  assert.equal(
    intake.checks[0].command,
    intake.command.argv.join(' '),
    "the check's command is the same invocation command.argv runs",
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'check-flow-intake.json')) {
    const manifest = readManifest(file);
    assert.deepEqual(
      manifest.checks.filter((check) => check.type === 'deterministic'),
      [],
      `${file}: no command answers this node's question — the check is a judgement`,
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

  // The graph document says the same thing about the same nodes: only
  // `check-intake` may carry a deterministic verification.
  const doc = readJson(GRAPH_PATH);
  for (const node of doc.nodes) {
    const deterministic = node.contract.checks.filter((check) => check.type === 'deterministic');
    assert.equal(
      deterministic.length,
      node.id === 'check-intake' ? 1 : 0,
      `node "${node.id}": only the shell gate declares a deterministic verification`,
    );
  }
});

test('AT8 — red-team-flow-hypothesis forbids "pass" with a high objection nobody answered', () => {
  const manifest = readManifest('red-team-flow-hypothesis.json');

  const objections = manifest.output.properties.objections;
  assert.ok(
    manifest.output.required.includes('objections'),
    'objections is required in the output',
  );
  assert.deepEqual(
    objections.items.required.sort(),
    ['hypothesis_answer', 'hypothesis_id', 'objection', 'severity'],
    'every objection names the hypothesis, the objection, its severity and the answer',
  );
  assert.deepEqual(
    objections.items.properties.hypothesis_answer.type,
    ['string', 'null'],
    'hypothesis_answer is null when the hypothesis did not answer',
  );

  const prohibition = linesWith(manifest.instructions, [
    'pass',
    'survives',
    'severity',
    'high',
    'hypothesis_answer',
  ]).filter((line) => /NEVER|never/.test(line));
  assert.ok(
    prohibition.length >= 1,
    'instructions has to explicitly forbid concluding "pass" (edge "survives") while a ' +
      'high-severity objection has no hypothesis_answer',
  );

  // FR14: the counter-evidence comes out of the fixture, cited by file and
  // record. There is no "researched" counter-evidence in this bundle — every
  // manifest closes the network, so a researched field would name a capability
  // the manifest forbids itself.
  assert.ok(
    Object.hasOwn(manifest.output.properties, 'counter_evidence'),
    'the output declares counter_evidence',
  );
  assert.ok(
    !Object.hasOwn(manifest.output.properties, 'researched_counter_evidence'),
    'nothing in this bundle researches: the network is closed on all seven nodes',
  );
  assert.deepEqual(
    manifest.output.properties.counter_evidence.items.required.sort(),
    ['evidence', 'file', 'hypothesis_id', 'record'],
    'counter-evidence is cited by file and record, never as a claim about the world',
  );

  const evidence = manifest.checks
    .filter((check) => check.type === 'agentic')
    .flatMap((check) => check.required_evidence);
  assert.ok(
    evidence.some((item) => /counter_evidence|counter-evidence/.test(item)),
    'the agentic check demands the counter-evidence itself, not a reread of the hypotheses',
  );
});

test('AT9 — all seven carry the escalation block, write nothing and open no network', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.ok(
      manifest.instructions.includes('```input-request'),
      `${file}: instructions has to contain the \`\`\`input-request marker`,
    );
    assert.deepEqual(
      manifest.permissions.filesystem.write,
      [],
      `${file}: no node of this graph writes into the target repository`,
    );
    assert.equal(
      manifest.permissions.network.allowed,
      false,
      `${file}: the fixture is all the data any node reads (RF-28) — the network stays closed`,
    );
  }
});

/*
 * AT10 — the shipped script, as a script.
 *
 * `check-intake` is a gate whose verdict is a command's, so the four verdicts
 * and the one crash are what "deterministic" means here. The temp directory is
 * the whole point: the script resolves `fixtures/<trading_day>` against its
 * working directory, so a fixture tree that is not the shipped one exercises
 * the failure modes the shipped one must never have.
 */
const RANGES = {
  daily_figures: [40, 60],
  broker_flow: [80, 200],
  signals: [5, 25],
  facts: [1, 10],
};

/** Rows of an array of `count` placeholder objects. */
const rows = (count) => Array.from({ length: count }, (_, index) => ({ row: index }));

/** Builds a temp fixture tree for `day-1`, then applies the given mutation. */
function temporaryFixture(mutate = () => {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'cartografo-intake-'));
  const day = path.join(home, 'fixtures', 'day-1');
  mkdirSync(day, { recursive: true });

  const content = {
    'daily-figures.json': rows(50),
    'broker-flow.json': rows(120),
    'signals.json': rows(12),
    'facts.json': rows(4),
  };
  mutate(content);
  for (const [name, value] of Object.entries(content)) {
    if (value === undefined) continue;
    writeFileSync(
      path.join(day, name),
      typeof value === 'string' ? value : `${JSON.stringify(value)}\n`,
    );
  }
  return home;
}

/** Runs the shipped script from `home`, and reads back its fenced block. */
function runIntake(home, day = 'day-1', ranges = RANGES) {
  assert.ok(
    existsSync(INTAKE_SCRIPT_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, INTAKE_SCRIPT_PATH)}`,
  );
  const run = spawnSync(
    process.execPath,
    [INTAKE_SCRIPT_PATH, day, JSON.stringify(ranges)],
    { cwd: home, encoding: 'utf8' },
  );
  const block = run.stdout.match(/```resultado\n([\s\S]*?)```/);
  return { run, report: block === null ? null : JSON.parse(block[1]) };
}

test('AT10 — check-intake.mjs passes, fails with a reason, and crashes only on broken JSON', () => {
  const good = runIntake(temporaryFixture());
  assert.equal(good.run.status, 0, `a reached verdict exits 0:\n${good.run.stderr}`);
  assert.ok(good.report, `the script has to print one fenced resultado block:\n${good.run.stdout}`);
  assert.equal(good.report.outcome, 'pass');
  assert.equal(good.report.fixture.trading_day, 'day-1');
  assert.deepEqual(
    Object.keys(good.report.fixture.paths).sort(),
    ['broker_flow', 'daily_figures', 'facts', 'signals'],
    'the report names the four paths it read',
  );
  assert.equal(good.report.fixture.row_counts.daily_figures, 50);
  assert.equal(good.report.fixture.row_counts.broker_flow, 120);
  assert.equal(good.report.fixture.row_counts.signals, 12);
  assert.equal(good.report.fixture.row_counts.facts, 4);

  const cases = [
    {
      name: 'a missing file',
      mutate: (content) => {
        delete content['facts.json'];
      },
      names: ['facts'],
    },
    {
      name: 'a row count under the minimum',
      mutate: (content) => {
        content['signals.json'] = rows(2);
      },
      names: ['signals', '5'],
    },
    {
      name: 'a row count over the maximum',
      mutate: (content) => {
        content['broker-flow.json'] = rows(500);
      },
      names: ['broker_flow', '200'],
    },
  ];

  for (const { name, mutate, names } of cases) {
    const { run, report } = runIntake(temporaryFixture(mutate));
    assert.equal(run.status, 0, `${name}: a fail is a verdict, not a crash:\n${run.stderr}`);
    assert.ok(report, `${name}: the script still reports a block`);
    assert.equal(report.outcome, 'fail', `${name}: outcome`);
    assert.equal(typeof report.note, 'string');
    for (const fragment of names) {
      assert.ok(
        report.note.includes(fragment),
        `${name}: the note has to name "${fragment}":\n${report.note}`,
      );
    }
  }

  // A file that is not JSON at all is a genuine execution error: there is no
  // verdict to reach, and pretending to have reached one is the failure mode
  // `verify-release.json` documents for its own deterministic checks.
  const broken = runIntake(
    temporaryFixture((content) => {
      content['signals.json'] = 'not json at all';
    }),
  );
  assert.notEqual(broken.run.status, 0, 'unparseable JSON exits non-zero');
  assert.equal(broken.report, null, 'and prints no resultado block at all');

  // So is a missing argument.
  const noArgs = spawnSync(process.execPath, [INTAKE_SCRIPT_PATH], { encoding: 'utf8' });
  assert.notEqual(noArgs.status, 0, 'a missing argument exits non-zero');
  assert.ok(!noArgs.stdout.includes('```resultado'), 'and prints no resultado block');
});

test('AT11 — no fixture file exceeds 2 MB and the whole tree stays under 8 MB', () => {
  assert.ok(
    existsSync(FIXTURES_DIR),
    `artifact does not exist yet: ${path.relative(ROOT, FIXTURES_DIR)}`,
  );

  let total = 0;
  let counted = 0;
  for (const day of DAYS) {
    for (const name of Object.keys(FIXTURE_FILES)) {
      const file = path.join(FIXTURES_DIR, day, name);
      assert.ok(existsSync(file), `missing fixture: ${path.relative(ROOT, file)}`);
      const { size } = statSync(file);
      assert.ok(size <= MAX_FILE_BYTES, `${day}/${name} is ${size} B, over the 2 MB ceiling`);
      total += size;
      counted += 1;
    }
  }

  assert.equal(counted, 12, 'three days of four files each');
  assert.ok(total <= MAX_TREE_BYTES, `the fixture tree is ${total} B, over the 8 MB ceiling`);
});

test("AT12 — every fixture file is an array inside graph.json's declared range", () => {
  const doc = readJson(GRAPH_PATH);
  const ranges = doc.project.expected_row_counts;

  assert.deepEqual(
    Object.keys(ranges).sort(),
    ['broker_flow', 'daily_figures', 'facts', 'signals'],
    'the ranges are declared as graph data, so check-intake reads them instead of hardcoding them',
  );

  for (const [name, key] of Object.entries(FIXTURE_FILES)) {
    const [min, max] = ranges[key];
    assert.ok(Number.isInteger(min) && Number.isInteger(max) && min <= max, `${key}: range`);

    for (const day of DAYS) {
      const rowsRead = readJson(path.join(FIXTURES_DIR, day, name));
      assert.ok(Array.isArray(rowsRead), `${day}/${name} has to be a JSON array at the top level`);
      assert.ok(
        rowsRead.length >= min && rowsRead.length <= max,
        `${day}/${name}: ${rowsRead.length} rows, outside the declared range [${min}, ${max}]`,
      );
    }
  }

  // The same declaration, read by the shipped script over the shipped
  // fixtures: the check at rest and the check at runtime cannot diverge.
  const { run, report } = runIntake(BUNDLE_DIR, 'day-2', ranges);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(report.outcome, 'pass', `the shipped day-2 has to pass its own gate: ${report.note}`);
});

test('AT13 — the crossing fixture crosses contract by contract, intake to brief', async () => {
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);
  const fixture = readJson(CROSSING_FIXTURE_PATH);

  const steps = fixture.crossing;
  assert.deepEqual(
    steps.map((step) => step.node),
    CHAIN,
    "the fixture's crossing follows check-intake → … → compose-brief",
  );

  // 1. Every payload holds against BOTH of the node's contracts: the graph
  //    document's (what a reader of the map reads) and the manifest's (what the
  //    control plane validates).
  for (const step of steps) {
    const node = findNode(doc, step.node);
    const manifest = readManifestOfSkill(NODES[step.node].skill);
    assert.deepEqual(
      validateAgainstSchema(step.input, node.contract.input_schema),
      [],
      `node "${step.node}": input against the graph's input_schema`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.input, manifest.input),
      [],
      `node "${step.node}": input against the manifest's input`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.output, node.contract.output_schema),
      [],
      `node "${step.node}": output against the graph's output_schema`,
    );
    assert.deepEqual(
      validateAgainstSchema(step.output, manifest.output),
      [],
      `node "${step.node}": output against the manifest's output`,
    );
  }

  // 2. A node's output FEEDS the next node's input: every field the next
  //    contract declares and the previous one produced arrives intact.
  for (let i = 0; i < steps.length - 1; i += 1) {
    const previous = steps[i];
    const next = steps[i + 1];
    const declared = Object.keys(readManifestOfSkill(NODES[next.node].skill).input.properties);
    const carried = Object.keys(previous.output).filter((key) => declared.includes(key));
    assert.ok(
      carried.length >= 1,
      `nothing from "${previous.node}" feeds "${next.node}": the chain is broken`,
    );
    for (const key of carried) {
      assert.deepEqual(
        next.input[key],
        previous.output[key],
        `"${key}" arrives from "${previous.node}" at "${next.node}" unchanged`,
      );
    }
  }

  // 3. The routing at each of the three gates follows a declared edge.
  const edgeFrom = (from, condition) =>
    doc.edges.find((edge) => edge.from === from && edge.condition === condition);
  for (const [node, condition] of Object.entries(fixture.expected_edges)) {
    const step = steps.find((entry) => entry.node === node);
    assert.equal(step.output.outcome, 'pass', `in the fixture "${node}" passes`);
    assert.ok(edgeFrom(node, condition), `passing "${node}" follows the "${condition}" edge`);
  }
  assert.deepEqual(
    Object.keys(fixture.expected_edges).sort(),
    ['check-intake', 'red-team', 'triage'],
    'the three gates route, and only they',
  );
});

/*
 * t278's check, over this bundle's real manifests — and here it runs BEFORE the
 * bundle exists rather than after a live crossing found the gap.
 *
 * Bundle 2 learned this twice the expensive way: a manifest requiring a bare
 * top-level `capital` nothing produced, and gates whose closed `output` refused
 * their own report. Both are static properties of the documents, and both are
 * what this test answers.
 */
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

test('AT14 — every required input of every node has a producer on every path into it', async () => {
  const { validateContracts } = await contractValidator();
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup());

  assert.deepEqual(report.problems, []);
  assert.equal(report.valid, true);

  // The three short paths into `scorecard` are legal precisely because the
  // final node demands `fixture` — which every path carries, `check-intake`
  // being the initial node — and nothing else the long path alone produces.
  const manifest = readManifest('record-flow-scorecard.json');
  assert.ok(manifest.input.required.includes('fixture'), 'scorecard requires the fixture');
  for (const key of ['triaged_signals', 'hypotheses', 'objections', 'counter_evidence', 'brief']) {
    assert.ok(
      Object.hasOwn(manifest.input.properties, key),
      `record-flow-scorecard declares "${key}" as a property`,
    );
    assert.ok(
      !manifest.input.required.includes(key),
      `"${key}" cannot be required: four different paths reach this node`,
    );
  }

  // And the check really bites: demanding one of them turns this very bundle
  // red, naming the node that produces it on the long path only.
  const demanded = {
    ...manifest,
    input: { ...manifest.input, required: [...manifest.input.required, 'brief'] },
  };
  const tightened = validateContracts(
    readJson(GRAPH_PATH),
    bundleSkillLookup({ 'record-flow-scorecard': demanded }),
  );
  assert.ok(tightened.problems.length > 0);
  for (const problem of tightened.problems) {
    assert.equal(problem.code, 'unproduced_input');
    assert.equal(problem.node_id, 'scorecard');
    assert.ok(problem.key === 'brief' || problem.key.startsWith('brief.'));
    assert.deepEqual(problem.produced_elsewhere_by, ['compose-brief']);
  }
});

/*
 * FR20 — the scorecard records PROCESS metrics, and this class's process is
 * detecting a signal, never instructing a trade.
 *
 * D14 states the principle for bets ("P&L is slow validation, never a round's
 * metric") and bundle 2 pins it in its own FR7 test. It is stated here for the
 * radar, where the temptation is a different one: a brief that reads like
 * research is one `price_target` key away from reading like an order.
 */
test('FR20 — record-flow-scorecard records process metrics, never a trade instruction', () => {
  const manifest = readManifest('record-flow-scorecard.json');
  const metrics = manifest.output.properties.process_metrics;

  assert.ok(manifest.output.required.includes('process_metrics'));
  for (const field of ['intake_passed', 'signals_triaged_count', 'red_team_ran', 'final_outcome']) {
    assert.ok(metrics.required.includes(field), `process_metrics has to require "${field}"`);
  }
  assert.equal(metrics.properties.intake_passed.type, 'boolean');
  assert.equal(metrics.properties.red_team_ran.type, 'boolean');
  assert.equal(metrics.properties.signals_triaged_count.type, 'integer');
  assert.equal(metrics.properties.signals_triaged_count.minimum, 0);
  assert.deepEqual(metrics.properties.final_outcome.enum, [
    'published',
    'no_signal',
    'dead_hypothesis',
    'intake_failed',
  ]);

  const serialized = JSON.stringify(manifest.output);
  for (const forbidden of [
    'buy',
    'sell',
    'price_target',
    'expected_return',
    'recommendation',
    'position_size_pct',
  ]) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `this is signal detection, not a trade instruction: the output cannot carry "${forbidden}"`,
    );
  }
});

test('AT15 — the bundle classifies as checked, so an import needs no re-check', async () => {
  const { classifyContracts, validateContracts } = await contractValidator();
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup());

  assert.equal(
    classifyContracts(report),
    'checked',
    'an `unchecked` here would mean a bundle whose own manifests do not answer for its pins',
  );
});

test('AT16 — demo/job.json is a POST /v1/jobs body naming a day this bundle ships', () => {
  const job = readJson(DEMO_JOB_PATH);

  assert.equal(job.entry_node_id, 'check-intake');
  assert.equal(typeof job.title, 'string');
  assert.ok(job.title.length > 0, 'a job has a title');
  assert.equal(typeof job.body, 'string');

  assert.ok(DAYS.includes(job.fields.trading_day), 'fields.trading_day names a shipped day');
  assert.ok(
    existsSync(path.join(FIXTURES_DIR, job.fields.trading_day)),
    'and that day really has a fixture directory',
  );

  // The field is the one this class declares, demanded at the entry node.
  const doc = readJson(GRAPH_PATH);
  assert.equal(doc.custom_fields.length, 1, 'this class declares exactly one field');
  const [field] = doc.custom_fields;
  assert.equal(field.name, 'trading_day');
  assert.equal(field.type, 'string');
  assert.equal(field.required_at, 'check-intake');
});

test('AT17 — the validator CLI approves the bundle and rejects a tampered hash', () => {
  assert.ok(
    existsSync(BUNDLE_VALIDATOR_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, BUNDLE_VALIDATOR_PATH)}`,
  );

  const good = runCli(BUNDLE_DIR);
  assert.equal(good.status, 0, `the real bundle has to exit 0:\n${good.stdout}${good.stderr}`);

  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-bundle-')), 'bundle');
  cpSync(BUNDLE_DIR, copy, { recursive: true });
  const target = path.join(copy, 'skills', 'red-team-flow-hypothesis.json');
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

test('AT18 — every path the bundle README points at exists', () => {
  assert.ok(existsSync(README_PATH), `artifact does not exist yet: ${path.relative(ROOT, README_PATH)}`);
  const text = readFileSync(README_PATH, 'utf8');
  const references = referencesIn(text);
  assert.ok(references.length >= 10, `only ${references.length} references read; the sweep is blind`);

  const dead = references.filter((reference) => !existsSync(resolveReference(reference)));
  assert.deepEqual(dead, [], `the README points at files that do not exist:\n${dead.join('\n')}`);
});

test('AT18 — the command the README documents under "How to validate" runs green', () => {
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

/**
 * The README as paragraphs: runs of lines separated by a blank line, each
 * joined into one string.
 *
 * Joined, and that is not cosmetic: this repository wraps at eighty columns, so
 * a sentence arrives split across a line break and no expression looking for it
 * in the raw block would ever match.
 */
function paragraphsOf(markdown) {
  return markdown
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').join(' ').trim())
    .filter((block) => block !== '');
}

test('AT19 — the README disclaims investment advice, between the blockquote and the state', () => {
  const paragraphs = paragraphsOf(readFileSync(README_PATH, 'utf8'));

  const quote = paragraphs.findIndex((block) => block.startsWith('>'));
  const state = paragraphs.findIndex((block) => block.startsWith('**State:'));

  assert.notEqual(quote, -1, 'the README no longer opens with the blockquote that summarizes it');
  assert.notEqual(state, -1, 'the README no longer carries the "**State:**" paragraph');
  assert.equal(
    state - quote,
    2,
    'exactly one paragraph belongs between the opening blockquote and the state line, and it ' +
      'is the disclaimer; anything else there has pushed it out of the place it has to be in',
  );

  const disclaimer = paragraphs[quote + 1];
  assert.match(
    disclaimer,
    /not (a )?(trading signal|investment advice)/i,
    `the paragraph between the blockquote and the state line does not disclaim what it must:\n${disclaimer}`,
  );
  assert.match(
    disclaimer,
    /\bexample\b/i,
    'the disclaimer has to say what the bundle IS as well as what it is not: an example',
  );
  assert.match(
    disclaimer,
    /\bgraph\b/i,
    'the disclaimer has to name what the example is an example OF — the graph structure',
  );
});

test('AT20 — the root README and docs/what-cartografo-is.md name the third bundle', () => {
  const readme = readFileSync(ROOT_README_PATH, 'utf8');
  const factoryGraphs = readme.slice(readme.indexOf('## The factory graphs'));
  assert.ok(factoryGraphs.length > 0, 'the root README no longer has a "factory graphs" section');
  assert.ok(
    factoryGraphs.includes('factory-graphs/b3-flow-radar'),
    'the section has to link the third bundle',
  );
  assert.ok(
    /three bundles/i.test(factoryGraphs.slice(0, factoryGraphs.indexOf('## Take the patterns'))),
    'the section still announces two bundles while shipping three',
  );

  const paragraph = paragraphsOf(readFileSync(WHAT_IT_IS_PATH, 'utf8')).find((block) =>
    block.includes('Start from ready-made maps'),
  );
  assert.ok(paragraph, 'docs/what-cartografo-is.md no longer has the "ready-made maps" paragraph');
  assert.match(paragraph, /three/i, 'the paragraph has to name three factory graphs');
  assert.match(paragraph, /flow radar/i, 'and one of the three is the B3 flow radar');
});
