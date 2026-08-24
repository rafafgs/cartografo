/**
 * Acceptance tests of t105 — factory graph 1 (software development).
 *
 * They cover the whole bundle: the graph document, the five skill manifests it
 * pins and the bundle validator. Zero dependencies: only `node:test`,
 * `node:assert`, `node:crypto`, `node:fs`, `node:os`, `node:path` and
 * `node:child_process`.
 *
 * The hash procedure is reimplemented HERE, straight from the specification
 * (`especificacoes/formatos/skill-manifest.md`, "Identificação" section),
 * rather than imported from the validator: if the test reused the
 * implementation it checks, a bug in the canonicalizer would go unnoticed on
 * both sides.
 *
 * The schema keys are English since t178, and since t280 (D24) so is everything
 * inside them: the node ids, the domain roles, the edge labels, the skill ids
 * and file names, every check id and the whole of each `instructions`. What is
 * still Portuguese below is not this bundle's to spell — the directory and the
 * class name (t282), the reserved routing key `resultado`
 * (`packages/runner/src/dispatch/parse-node-result.ts`), the projection roots
 * `banco_de_testes`/`referencia`/`perguntas_respondidas` that core and the
 * runner publish, and the reference validator's pinned exports (t133,
 * exception 5).
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');
const SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');
const GRAPH_PATH = path.join(BUNDLE_DIR, 'grafo.json');
const README_PATH = path.join(BUNDLE_DIR, 'README.md');
const GRAPH_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validar-grafo.mjs');
const BUNDLE_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-factory-bundle.mjs');
const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'especificacoes',
  'formatos',
  'skill-manifest.schema.json',
);

/** The bundle's five manifests: file -> { id, role, node }. */
const SKILLS = {
  'refine-ticket.json': { id: 'refine-ticket', role: 'work', node: 'refine' },
  'develop-ticket.json': { id: 'develop-ticket', role: 'work', node: 'develop' },
  'integrate-branch.json': { id: 'integrate-branch', role: 'work', node: 'integrate' },
  'alpha-test.json': { id: 'alpha-test', role: 'gate', node: 'test' },
  'verify-release.json': { id: 'verify-release', role: 'work', node: 'deploy' },
};

/**
 * Topology pinned by t96 (`tests/graph-schema.test.mjs` AT3), repeated here on
 * purpose: this bundle is new content, and its test cannot depend on t96's
 * fixture continuing to exist under the same name.
 */
const EXPECTED_NODES = ['deploy', 'develop', 'integrate', 'refine', 'test'];
const ROLE_BY_NODE = {
  refine: 'architect',
  develop: 'developer',
  integrate: 'integrator',
  test: 'tester',
  deploy: 'deployer',
};
const EXPECTED_EDGES = [
  { from: 'refine', to: 'develop', condition: 'always' },
  { from: 'develop', to: 'integrate', condition: 'always' },
  { from: 'integrate', to: 'test', condition: 'always' },
  { from: 'test', to: 'deploy', condition: 'approved' },
  { from: 'test', to: 'develop', condition: 'rework' },
];

/** Reads a JSON file from the repo, failing with its relative path if missing. */
function readJson(filePath) {
  assert.ok(existsSync(filePath), `artifact does not exist yet: ${path.relative(ROOT, filePath)}`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

const readManifest = (file) => readJson(path.join(SKILLS_DIR, file));

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
 * `especificacoes/formatos/skill-manifest.md`: sha256 of the canonical JSON of
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

test('AT1 — grafo.json passes validarEstrutura and validarSoundness', async () => {
  const { validarEstrutura, validarSoundness } = await graphValidator();
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.equal(validarEstrutura(doc).valid, true);
  assert.deepEqual(validarSoundness(doc).violations, []);
  assert.equal(validarSoundness(doc).valid, true);
});

test('AT2 — ids, roles and edges match the topology pinned by t96', () => {
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(doc.nodes.map((node) => node.id).sort(), EXPECTED_NODES);
  for (const node of doc.nodes) {
    assert.equal(node.role, ROLE_BY_NODE[node.id], `expected role for node "${node.id}"`);
  }

  const key = (edge) => `${edge.from}>${edge.to}`;
  assert.deepEqual(doc.edges.map(key).sort(), EXPECTED_EDGES.map(key).sort());
  for (const expected of EXPECTED_EDGES) {
    const edge = doc.edges.find((e) => e.from === expected.from && e.to === expected.to);
    assert.equal(edge.condition, expected.condition, `expected condition of edge ${key(expected)}`);
  }

  assert.equal(doc.initial_node, 'refine');
  assert.deepEqual(doc.final_nodes, ['deploy']);
  assert.equal(doc.problem_class, 'desenvolvimento-de-software');
});

test('AT3 — the five manifests validate against skill-manifest.schema.json', async () => {
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
    path.join(ROOT, 'especificacoes', 'formatos', 'exemplos', 'skill-manifest.invalid.fixture.json'),
  );
  assert.equal(validateManifest(invalid).valid, false, "t97's negative fixture has to be rejected");
});

test('AT4 — the five manifests exist with the expected id and role', () => {
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

test('AT5 — alpha-test declares output.outcome with the gate\'s three values', () => {
  const manifest = readManifest('alpha-test.json');
  assert.deepEqual(manifest.output.properties.outcome.enum, ['pass', 'fail', 'escalate_human']);
  assert.ok(
    manifest.output.required.includes('outcome'),
    "outcome has to be required in the gate's output",
  );
});

test('AT6 — the recomputed hash of each manifest matches the node\'s skill_ref', () => {
  const doc = readJson(GRAPH_PATH);
  const byId = new Map(
    Object.keys(SKILLS).map((file) => {
      const manifest = readManifest(file);
      return [manifest.id, manifest];
    }),
  );

  assert.equal(doc.nodes.length, 5);
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
  }
});

test('AT7 — alpha-test does not rerun the quality gate; integrate and develop do', () => {
  const gate = readManifest('alpha-test.json');
  const deterministic = gate.checks.filter((check) => check.type === 'deterministic');
  assert.deepEqual(
    deterministic,
    [],
    'alpha-test cannot have a deterministic check: rerunning integration gates is a redundant station',
  );
  assert.ok(
    gate.checks.some((check) => check.type === 'agentic'),
    'alpha-test needs the agentic semantic-walkthrough check',
  );

  const runsProjectCommand = (manifest) =>
    manifest.checks.some(
      (check) =>
        check.type === 'deterministic' &&
        // `project` and not `projeto` since t259: the projection publishes the
        // class's static config at `input.project`
        // (`especificacoes/formatos/skill-manifest.md`), and the bundle's
        // templates were the last thing still spelling it the old way. The two
        // keys inside it are English since t280.
        /\{\{input\.project\.(test_command|quality_commands)\}\}/.test(check.command ?? ''),
    );
  for (const file of ['integrate-branch.json', 'develop-ticket.json']) {
    assert.ok(
      runsProjectCommand(readManifest(file)),
      `${file} needs a deterministic check that runs the project's commands`,
    );
  }
});

test('AT8 — every instructions carries the escalation contract (input-request block)', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.ok(
      manifest.instructions.includes('```input-request'),
      `${file}: instructions has to contain the \`\`\`input-request marker`,
    );
  }
});

/**
 * The declaration used to be `allowed: true` with a loopback allowlist, which
 * reads as the tighter policy and is in fact the unrunnable one: no shipped
 * adapter can scope the network by domain — that would take an egress proxy —
 * so `startSession` refused the gate before opening anything, and the first
 * real crossing of this bundle stopped on the gate node (t271, t109's hole 1).
 *
 * `allowed: true` with NO `domains` is what the manifest format itself calls
 * unrestricted network and declares legal for a native skill
 * (`especificacoes/formatos/skill-manifest.md`). It is a wider grant on paper
 * and a narrower one in practice, because it is the only one that ever gets
 * enforced. Where the network may point is instructions now, not policy — which
 * is why this test also refuses the old sentence.
 */
test('AT9 — alpha-test opens the network, and it is open — not domain-scoped', () => {
  const gate = readManifest('alpha-test.json');
  assert.equal(gate.permissions.network.allowed, true);

  const { domains } = gate.permissions.network;
  assert.ok(
    domains === undefined || domains.length === 0,
    'a domain allowlist is a policy no shipped adapter can enforce, so declaring one is ' +
      'declaring a session that never opens',
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'alpha-test.json')) {
    assert.equal(readManifest(file).permissions.network.allowed, false, `${file}: network closed`);
  }

  // The sentence this refuses was Portuguese until t280 ("aberta só para o
  // endereço de loopback"); what it guards is the claim, not the language, so
  // the translation carried the guard over instead of dropping it.
  assert.ok(
    !gate.instructions.replace(/\s+/g, ' ').includes('open only for the loopback address'),
    'the instructions cannot keep claiming a restriction the manifest no longer declares: a ' +
      'model told its network is scoped will not report the calls it thinks it cannot make',
  );
});

test('AT10 — the validator CLI approves the bundle and rejects a tampered hash', () => {
  assert.ok(
    existsSync(BUNDLE_VALIDATOR_PATH),
    `artifact does not exist yet: ${path.relative(ROOT, BUNDLE_VALIDATOR_PATH)}`,
  );

  const good = runCli(BUNDLE_DIR);
  assert.equal(good.status, 0, `the real bundle has to exit 0:\n${good.stdout}${good.stderr}`);

  const copy = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-bundle-')), 'bundle');
  cpSync(BUNDLE_DIR, copy, { recursive: true });
  const target = path.join(copy, 'skills', 'alpha-test.json');
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

  const bad = runCli(copy);
  assert.notEqual(bad.status, 0, 'a tampered hash has to exit with a non-zero code');
  // The node id is quoted, not searched bare: since t280 it is `test`, and a
  // bare `includes('test')` would be satisfied by the word "test" anywhere in
  // the report — including the file name of the manifest that was tampered with.
  assert.ok(
    `${bad.stdout}${bad.stderr}`.includes('node "test"'),
    `the report has to name the diverging node:\n${bad.stdout}${bad.stderr}`,
  );
});

/**
 * Collapses every whitespace run, so a phrase the source wraps across lines
 * still reads as one string. Without it, "never do X" would silently stop
 * matching the moment someone rewrapped the paragraph it lives in.
 */
const oneLine = (text) => text.replace(/\s+/g, ' ');

/** The check with this id, asserted present before anything reads into it. */
function checkById(file, id) {
  const found = readManifest(file).checks.find((item) => item.id === id);
  assert.ok(found, `${file} has to keep the "${id}" check`);
  return found;
}

/** The graph node with this id, asserted present. */
function nodeById(id) {
  const found = readJson(GRAPH_PATH).nodes.find((item) => item.id === id);
  assert.ok(found, `grafo.json has to keep the "${id}" node`);
  return found;
}

test('AT11 — tdd-order demands a red that failed for the right reason', () => {
  const check = checkById('develop-ticket.json', 'tdd-order');
  const instruction = oneLine(check.instruction);

  assert.match(instruction, /right reason/, 'the check has to ask WHY the red run failed');
  assert.match(
    instruction,
    /missing implementation/,
    'a valid red is missing implementation — not a broken import, a typo or a broken fixture',
  );
  assert.match(
    instruction,
    /does not prove the order/,
    'one commit carrying tests and implementation together still cannot pass',
  );

  const evidence = check.required_evidence;
  assert.ok(
    evidence.some((item) => /output_of_the_test_command/.test(item) && /commit/.test(item)),
    'tdd-order needs the test-command output taken at the tests-only commit',
  );
  assert.ok(
    evidence.some((item) => /missing_implementation/.test(item)),
    'tdd-order needs evidence that the red failed for missing implementation',
  );
});

test('AT12 — specification-gate demands the DoD anchor, TDD exceptions and INVEST', () => {
  const check = checkById('refine-ticket.json', 'specification-gate');
  const instruction = oneLine(check.instruction);

  assert.match(
    instruction,
    /first item of the Definition of done/i,
    'the gate has to read the first item of the definition of done',
  );
  assert.match(
    instruction,
    /TDD exceptions/,
    'anything not driveable by a test has to be listed, with its reason',
  );
  assert.match(instruction, /INVEST/, 'the gate has to check INVEST was really applied');
  assert.doesNotMatch(
    instruction,
    /answer three things/,
    'the gate now asks five questions, not three',
  );
  assert.doesNotMatch(
    instruction,
    /of the three answers/,
    'the closing count has to follow the new questions',
  );

  const evidence = check.required_evidence;
  for (const [what, wanted] of [
    ['the first item of the definition of done', /definition_of_done/],
    ['the justification of each TDD exception', /tdd_exception/],
    ['what supports each INVEST property', /invest/],
  ]) {
    assert.ok(evidence.some((item) => wanted.test(item)), `evidence missing: ${what}`);
  }
});

test('AT13 — integrate-branch says the session never performs the final merge', () => {
  const instructions = oneLine(readManifest('integrate-branch.json').instructions);

  assert.match(
    instructions,
    /you never perform the final merge/i,
    'session proposes, flow disposes: the absolute rule has to be stated',
  );
  assert.doesNotMatch(
    instructions,
    /finish the integration with the main line pointing at the result/i,
    'the reconciliation step cannot tell the session to move the main line',
  );
});

test('AT14 — the refine node requires note in its output contract', () => {
  const shape = nodeById('refine').contract.output_schema;

  assert.ok(
    shape.required.includes('note'),
    "the refine node has to mirror the manifest and require the session's note",
  );
});

test('AT15 — the test node mirrors the manifest: per-criterion verdicts and typed bugs', () => {
  const shape = nodeById('test').contract.output_schema;

  assert.ok(shape.properties.verdicts, 'the test node has to declare verdicts');
  assert.ok(shape.properties.bugs, 'the test node has to declare bugs');
  assert.ok(shape.required.includes('verdicts'), 'a verdict per criterion is not optional');
  assert.deepEqual(shape.properties.verdicts.items.required, ['ref', 'verdict', 'evidence']);
  assert.ok(
    shape.properties.bugs.items.required.includes('severity'),
    'a bug without severity cannot be scheduled by the executor',
  );
  assert.deepEqual(
    shape.properties.outcome.enum,
    ['approved', 'rework', 'escalate'],
    'the node still spells the gate outcome in EDGE vocabulary while the manifest spells it ' +
      'pass/fail/escalate_human — that mismatch is divergence 2, still open. t280 translated ' +
      'the words without closing it',
  );
});

// --------------------------------------------------------------------------
// t176 — one source of truth for how a node verifies itself
//
// The manifest is the only place that declares HOW a node checks its own work;
// `contract.checks` restates the same list in the graph's format, item by
// item. What has to line up is structure — count, sequence of `type`, and the
// `command` of every deterministic item; the prose of an agentic item is
// rewritten on each side on purpose (`packages/runner/src/synthesizer/prompt.ts`).
// --------------------------------------------------------------------------

/** One node of the graph, by id, failing with the id when it is gone. */
function nodeOf(doc, id) {
  const found = doc.nodes.find((candidate) => candidate.id === id);
  assert.ok(found, `the graph no longer has a node "${id}"`);
  return found;
}

/** The `command` of every deterministic item, in order. */
const commandsOf = (items) =>
  items.filter((item) => item.type === 'deterministic').map((item) => item.command);

/** The verifications a node declares, and the checks of the skill it pins. */
function bothSidesOf(id, file) {
  const declared = nodeOf(readJson(GRAPH_PATH), id).contract.checks;
  return { declared, checks: readManifest(file).checks };
}

test('t176 AT4 — the bundle validator CLI exits 0 for this bundle', () => {
  const run = runCli(path.relative(ROOT, BUNDLE_DIR));
  assert.equal(run.status, 0, `the bundle has to validate clean:\n${run.stdout}${run.stderr}`);
});

test('t176 AT5 — "test" verifies with the semantic walkthrough alone', () => {
  const { declared, checks } = bothSidesOf('test', 'alpha-test.json');

  assert.equal(declared.length, 1, 'the gate rerunning the quality commands is a redundant station');
  assert.equal(declared[0].type, 'agentic');
  assert.deepEqual(
    declared.map((item) => item.type),
    checks.map((check) => check.type),
  );
});

test('t176 AT6 — "deploy" declares the two git checks of verify-release', () => {
  const { declared, checks } = bothSidesOf('deploy', 'verify-release.json');

  assert.equal(declared.length, 2);
  assert.deepEqual(
    declared.map((item) => item.type),
    ['deterministic', 'deterministic'],
  );
  assert.deepEqual(commandsOf(declared), commandsOf(checks));
});

test('t176 AT7 — "develop" declares the four checks of develop-ticket', () => {
  const { declared, checks } = bothSidesOf('develop', 'develop-ticket.json');

  assert.equal(declared.length, 4);
  assert.deepEqual(
    declared.map((item) => item.type),
    ['deterministic', 'deterministic', 'deterministic', 'agentic'],
  );
  assert.deepEqual(commandsOf(declared), commandsOf(checks));
});

test('t176 AT8 — "integrate" declares the three checks of integrate-branch', () => {
  const { declared, checks } = bothSidesOf('integrate', 'integrate-branch.json');

  assert.equal(declared.length, 3);
  assert.deepEqual(
    declared.map((item) => item.type),
    ['deterministic', 'deterministic', 'deterministic'],
  );
  assert.deepEqual(commandsOf(declared), commandsOf(checks));
});

test('t176 AT9 — no command in the graph names a stack tool of its own', () => {
  const text = readFileSync(GRAPH_PATH, 'utf8');

  for (const forbidden of ['make check', 'make smoke']) {
    assert.ok(
      !text.includes(forbidden),
      `"${forbidden}" is hardcoded technology copied from the master example; ` +
        "every deterministic command is a profile template or a command the manifest already runs",
    );
  }
});

test('t176 AT10 — the five manifests record flowpilot as a behavioural reference', () => {
  for (const file of Object.keys(SKILLS)) {
    const { origin } = readManifest(file);
    assert.equal(origin.type, 'native', `${file}: no code was imported (D4 would demand its gate)`);
    assert.equal(
      origin.behavioral_reference,
      'flowpilot',
      `${file}: the port has to name the behaviour it came from (D17)`,
    );
  }

  const gate = readManifest('alpha-test.json');
  assert.ok(
    (gate.origin.note ?? '').includes('testing.py:77'),
    'alpha-test has to cite the source rule that settles the contradiction',
  );
});

test('t176 AT11 — the declared hash of each manifest still matches its content', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.equal(
      manifest.hash,
      hashOfManifest(manifest),
      `${file}: touching "origin" cannot invalidate the pin — it is outside the hashed subset`,
    );
  }
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
 * A reference with a `<placeholder>` in it (`grafos-de-fabrica/<classe>/`) is
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

test('t176 AT12 — every path the README points at exists', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const references = referencesIn(text);
  assert.ok(references.length >= 10, `only ${references.length} references read; the sweep is blind`);

  const dead = references.filter((reference) => !existsSync(resolveReference(reference)));

  assert.deepEqual(dead, [], `the README points at files that do not exist:\n${dead.join('\n')}`);
});

test('t176 AT12 — the command the README documents under "How to validate" runs green', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const documented = fencedBlockUnder(text, '## How to validate')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node '));

  assert.ok(
    documented.length > 0,
    'the "How to validate" block no longer documents a node command',
  );

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

test('t176 AT13 — the README no longer claims the contradiction is open', () => {
  // Wrapping is collapsed first: the sentence is broken across two lines in the
  // README, and a raw `includes` would pass without the claim ever leaving.
  const text = readFileSync(README_PATH, 'utf8').replace(/\s+/g, ' ');

  assert.ok(
    !text.includes('because this ticket does not reopen the content of the master example'),
    'the divergence was reconciled in favour of the manifest; the README has to say so',
  );
});

/*
 * t278 — contract matching, over the bundle's REAL manifests.
 *
 * The graph document's own `contract.input_schema` is documentation and has
 * already drifted (`refine` declares `ticket_id`/`request`; the pinned skill
 * really requires `job`/`project`). What a session is held to is the manifest,
 * so that is what this case walks — with the control plane's own function, not
 * a reimplementation, because a second copy of a dataflow computation is a
 * second answer waiting to disagree.
 */
const CORE_GRAPH_MODULE = path.join(ROOT, 'packages', 'core', 'src', 'domain', 'graph.ts');
let contractValidatorModule = null;

async function contractValidator() {
  contractValidatorModule = await load(CORE_GRAPH_MODULE, contractValidatorModule);
  return contractValidatorModule;
}

/** Resolves a node's pin against the manifests shipped in `skills/`. */
function bundleSkillLookup(skillsDir) {
  const byId = new Map(
    readdirSync(skillsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const manifest = readJson(path.join(skillsDir, name));
        return [manifest.id, manifest];
      }),
  );
  return (ref) => {
    const manifest = byId.get(ref.id);
    return manifest === undefined ? undefined : { input: manifest.input, output: manifest.output };
  };
}

test('t278 — every required input of every node has a producer on every path into it', async () => {
  const { validateContracts } = await contractValidator();
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup(SKILLS_DIR));

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
  const report = validateContracts(readJson(GRAPH_PATH), bundleSkillLookup(SKILLS_DIR));

  assert.equal(
    classifyContracts(report),
    'checked',
    'an `unchecked` here would mean a bundle whose own manifests do not answer for its pins',
  );
});

// --------------------------------------------------------------------------
// t277 — a placeholder that names nothing
// --------------------------------------------------------------------------

/**
 * The placeholder grammar of `especificacoes/formatos/skill-manifest.md`,
 * reimplemented here for the same reason the hash procedure above is: a test
 * that imported the runner's own regex would go blind exactly when that regex
 * is what is wrong.
 */
const PLACEHOLDER = /\{\{input\.([^{}]*)\}\}/g;
const PLACEHOLDER_PATH = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Every string in a manifest, with the JSON pointer that leads to it. */
function stringsOf(value, pointer = '') {
  if (typeof value === 'string') return [[pointer, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => stringsOf(item, `${pointer}/${i}`));
  if (value && typeof value === 'object') {
    return Object.keys(value).flatMap((key) => stringsOf(value[key], `${pointer}/${key}`));
  }
  return [];
}

/**
 * Walks a dotted placeholder path through a manifest's own `input` schema, and
 * says whether the schema declares it. `additionalProperties` counts as a
 * declaration: `artefato.gates_declarados` is a declared open map, not a hole.
 */
function declaredByInputSchema(schema, dotted) {
  let current = schema;
  for (const segment of dotted.split('.')) {
    if (!current || current.type !== 'object') return false;
    const property = current.properties?.[segment];
    if (property) {
      current = property;
      continue;
    }
    const open = current.additionalProperties;
    if (open && typeof open === 'object') {
      current = open;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * The whole manifest is swept, not only `instructions` — and that is the point
 * of the ticket. Only `instructions` is interpolated
 * (`render-skill-instructions.ts`); `checks[].instruction` reaches the session
 * as the literal JSON the renderer fences under "Os checks declarados pela
 * skill". So a stale path there is worse than an unresolved one: it never
 * refuses, it just tells the session to go look at an `input.aplicacao` the
 * resolved input has not carried since t270.
 */
test('t277 AT1 — no manifest names an input path its own schema does not declare', () => {
  const stale = [];
  let swept = 0;

  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    for (const [pointer, text] of stringsOf(manifest)) {
      for (const [token, dotted] of text.matchAll(PLACEHOLDER)) {
        swept += 1;
        const declared =
          PLACEHOLDER_PATH.test(dotted) && declaredByInputSchema(manifest.input, dotted);
        if (!declared) stale.push(`${file}${pointer}: ${token}`);
      }
    }
  }

  assert.ok(swept >= 20, `only ${swept} placeholders read across the bundle; the sweep is blind`);
  assert.deepEqual(
    stale,
    [],
    `these placeholders name paths the manifest's own input does not declare:\n${stale.join('\n')}`,
  );
});

// --------------------------------------------------------------------------
// t275 — the gate reports a verdict AND names an edge, and they are two keys
//
// A node with two ways out closes its turn with ONE fenced block, so the label
// of the edge it took rides inside the same object as its report
// (`parse-node-result.ts`). That label is the reserved key `resultado`, its
// vocabulary is the GRAPH's — the `condition` of an edge — and the control
// plane takes it out of the object before holding the rest against the pinned
// skill's `output` (`docs/spec/graph.md`, t269). So the node's own
// `saida_schema` is where it is declared, and the skill's `output` is where it
// never is.
//
// What this bundle did was neither: nothing declared the label anywhere, and
// `alpha-test`'s instructions spent the reserved key on the gate VERDICT —
// `resultado: "passou"`, which is not a value any edge of this graph carries.
// A session that obeyed those instructions named an edge that does not exist
// and left out the `outcome` the manifest requires: no route, and a report the
// control plane refuses. The crossing on the bench never saw it because its
// fake session was hand-written against the schemas instead of against the
// prose.
// --------------------------------------------------------------------------

test('t275 AT1 — the test node declares the routing key its two edges need, and the skill does not', () => {
  const shape = nodeById('test').contract.output_schema;
  const conditions = EXPECTED_EDGES.filter((edge) => edge.from === 'test').map(
    (edge) => edge.condition,
  );

  const route = shape.properties.resultado;
  assert.ok(route, 'a node with two outgoing edges has to declare `resultado` in its output_schema');
  assert.equal(route.type, 'string');
  assert.deepEqual(
    route.enum,
    conditions,
    'the label vocabulary IS the set of conditions of the edges leaving this node',
  );
  assert.ok(
    shape.required.includes('resultado'),
    'a gate that names no edge routes nothing: the label is not optional here',
  );

  assert.equal(
    readManifest('alpha-test.json').output.properties.resultado,
    undefined,
    'and the skill never declares it: the key is taken out before the report is checked (t269)',
  );
});

test('t275 AT2 — alpha-test names the verdict key and the routing key, and never conflates them', () => {
  const manifest = readManifest('alpha-test.json');
  const text = oneLine(manifest.instructions);

  // The pre-t275 spellings AND their t280 translations: a key spent on the
  // verdict names no edge of this graph in either language.
  const spentOnTheVerdict = [
    '`resultado: "passou"`',
    '`resultado: "falhou"`',
    '`resultado: "escalar_humano"`',
    '`resultado: "passed"`',
    '`resultado: "failed"`',
    '`resultado: "escalate_human"`',
  ];
  for (const spent of spentOnTheVerdict) {
    assert.ok(
      !text.includes(spent),
      `the reserved routing key cannot carry the gate verdict: ${spent} names no edge of this graph`,
    );
  }

  for (const [outcome, edge] of [
    ['pass', 'approved'],
    ['fail', 'rework'],
  ]) {
    assert.ok(
      text.includes(`\`outcome: "${outcome}"\``),
      `the verdict travels in the key the manifest declares: outcome: "${outcome}"`,
    );
    assert.ok(
      text.includes(`\`resultado: "${edge}"\``),
      `and the edge in the key the protocol reserves: resultado: "${edge}"`,
    );
  }

  assert.ok(
    text.includes('`outcome: "escalate_human"`'),
    'the third value the gate format demands is named where the format puts it',
  );
  assert.ok(
    (manifest.output.properties.outcome.description ?? '').includes('resultado'),
    'the verdict\'s own description has to point at the routing key instead of claiming to be one',
  );
});
