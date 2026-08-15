/**
 * Acceptance tests of t105 — factory graph 1 (software development).
 *
 * They cover the whole bundle: the graph document, the five skill manifests it
 * pins and the bundle validator. Zero dependencies: only `node:test`,
 * `node:assert`, `node:crypto`, `node:fs`, `node:os`, `node:path` and
 * `node:child_process`.
 *
 * The hash procedure is reimplemented HERE, straight from the specification
 * (`especificacoes/formatos/manifesto-skill.md`, "Identificação" section),
 * rather than imported from the validator: if the test reused the
 * implementation it checks, a bug in the canonicalizer would go unnoticed on
 * both sides.
 *
 * The schema keys are English since t178: the 2026-08-15 D18 amendment lifted
 * the carve-out that used to keep the graph-document and skill-manifest keys in
 * Portuguese. What is still Portuguese below is data the amendment did not
 * reopen — the bundle's directory, the node ids, the domain roles and the edge
 * labels — and the reference validator's pinned exports (t133, exception 5).
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
  'manifesto-skill.schema.json',
);

/** The bundle's five manifests: file -> { id, role, node }. */
const SKILLS = {
  'refinar-ticket.json': { id: 'refinar-ticket', role: 'work', node: 'refinar' },
  'desenvolver-ticket.json': { id: 'desenvolver-ticket', role: 'work', node: 'desenvolver' },
  'integrar-branch.json': { id: 'integrar-branch', role: 'work', node: 'integrar' },
  'testar-alpha.json': { id: 'testar-alpha', role: 'gate', node: 'testar' },
  'implantar-release.json': { id: 'implantar-release', role: 'work', node: 'implantar' },
};

/**
 * Topology pinned by t96 (`tests/graph-schema.test.mjs` AT3), repeated here on
 * purpose: this bundle is new content, and its test cannot depend on t96's
 * fixture continuing to exist under the same name.
 */
const EXPECTED_NODES = ['desenvolver', 'implantar', 'integrar', 'refinar', 'testar'];
const ROLE_BY_NODE = {
  refinar: 'arquiteto',
  desenvolver: 'desenvolvedor',
  integrar: 'integrador',
  testar: 'tester',
  implantar: 'deployer',
};
const EXPECTED_EDGES = [
  { from: 'refinar', to: 'desenvolver', condition: 'sempre' },
  { from: 'desenvolver', to: 'integrar', condition: 'sempre' },
  { from: 'integrar', to: 'testar', condition: 'sempre' },
  { from: 'testar', to: 'implantar', condition: 'aprovado' },
  { from: 'testar', to: 'desenvolver', condition: 'retrabalho' },
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
 * `especificacoes/formatos/manifesto-skill.md`: sha256 of the canonical JSON of
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

  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.equal(validarEstrutura(doc).valido, true);
  assert.deepEqual(validarSoundness(doc).violacoes, []);
  assert.equal(validarSoundness(doc).valido, true);
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

  assert.equal(doc.initial_node, 'refinar');
  assert.deepEqual(doc.final_nodes, ['implantar']);
  assert.equal(doc.problem_class, 'desenvolvimento-de-software');
});

test('AT3 — the five manifests validate against manifesto-skill.schema.json', async () => {
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
    path.join(ROOT, 'especificacoes', 'formatos', 'exemplos', 'manifesto-skill.invalido.fixture.json'),
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

test('AT5 — testar-alpha declares output.outcome with the gate\'s three values', () => {
  const manifest = readManifest('testar-alpha.json');
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

test('AT7 — testar-alpha does not rerun the quality gate; integrar and desenvolver do', () => {
  const gate = readManifest('testar-alpha.json');
  const deterministic = gate.checks.filter((check) => check.type === 'deterministic');
  assert.deepEqual(
    deterministic,
    [],
    'testar-alpha cannot have a deterministic check: rerunning integration gates is a redundant station',
  );
  assert.ok(
    gate.checks.some((check) => check.type === 'agentic'),
    'testar-alpha needs the agentic semantic-walkthrough check',
  );

  const runsProjectCommand = (manifest) =>
    manifest.checks.some(
      (check) =>
        check.type === 'deterministic' &&
        /\{\{input\.projeto\.(comando_testes|comandos_qualidade)\}\}/.test(check.command ?? ''),
    );
  for (const file of ['integrar-branch.json', 'desenvolver-ticket.json']) {
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

test('AT9 — only testar-alpha opens the network, and only to loopback', () => {
  const gate = readManifest('testar-alpha.json');
  assert.equal(gate.permissions.network.allowed, true);
  assert.ok(
    Array.isArray(gate.permissions.network.domains) && gate.permissions.network.domains.length > 0,
    'testar-alpha has to restrict the network to a list of domains',
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'testar-alpha.json')) {
    assert.equal(readManifest(file).permissions.network.allowed, false, `${file}: network closed`);
  }
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
  const target = path.join(copy, 'skills', 'testar-alpha.json');
  const manifest = JSON.parse(readFileSync(target, 'utf8'));
  manifest.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);

  const bad = runCli(copy);
  assert.notEqual(bad.status, 0, 'a tampered hash has to exit with a non-zero code');
  assert.ok(
    `${bad.stdout}${bad.stderr}`.includes('testar'),
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

test('AT11 — ordem-tdd demands a red that failed for the right reason', () => {
  const check = checkById('desenvolver-ticket.json', 'ordem-tdd');
  const instruction = oneLine(check.instruction);

  assert.match(instruction, /motivo certo/, 'the check has to ask WHY the red run failed');
  assert.match(
    instruction,
    /implementação ausente/,
    'a valid red is missing implementation — not a broken import, a typo or a broken fixture',
  );
  assert.match(
    instruction,
    /não prova a ordem/,
    'one commit carrying tests and implementation together still cannot pass',
  );

  const evidence = check.required_evidence;
  assert.ok(
    evidence.some((item) => /saida_do_comando_de_testes/.test(item) && /commit/.test(item)),
    'ordem-tdd needs the test-command output taken at the tests-only commit',
  );
  assert.ok(
    evidence.some((item) => /implementacao_ausente/.test(item)),
    'ordem-tdd needs evidence that the red failed for missing implementation',
  );
});

test('AT12 — portao-de-especificacao demands the DoD anchor, TDD exceptions and INVEST', () => {
  const check = checkById('refinar-ticket.json', 'portao-de-especificacao');
  const instruction = oneLine(check.instruction);

  assert.match(
    instruction,
    /primeiro item da Definição de pronto/i,
    'the gate has to read the first item of the definition of done',
  );
  assert.match(
    instruction,
    /Exceções ao TDD/,
    'anything not driveable by a test has to be listed, with its reason',
  );
  assert.match(instruction, /INVEST/, 'the gate has to check INVEST was really applied');
  assert.doesNotMatch(
    instruction,
    /responda três coisas/,
    'the gate now asks five questions, not three',
  );
  assert.doesNotMatch(
    instruction,
    /das três respostas/,
    'the closing count has to follow the new questions',
  );

  const evidence = check.required_evidence;
  for (const [what, wanted] of [
    ['the first item of the definition of done', /definicao_de_pronto/],
    ['the justification of each TDD exception', /excecoes_ao_tdd/],
    ['what supports each INVEST property', /invest/],
  ]) {
    assert.ok(evidence.some((item) => wanted.test(item)), `evidence missing: ${what}`);
  }
});

test('AT13 — integrar-branch says the session never performs the final merge', () => {
  const instructions = oneLine(readManifest('integrar-branch.json').instructions);

  assert.match(
    instructions,
    /você nunca executa o merge final/i,
    'session proposes, flow disposes: the absolute rule has to be stated',
  );
  assert.doesNotMatch(
    instructions,
    /conclua a integração com a linha principal apontando para o resultado/i,
    'the reconciliation step cannot tell the session to move the main line',
  );
});

test('AT14 — the refinar node requires nota in its output contract', () => {
  const shape = nodeById('refinar').contract.output_schema;

  assert.ok(
    shape.required.includes('nota'),
    "the refinar node has to mirror the manifest and require the session's note",
  );
});

test('AT15 — the testar node mirrors the manifest: per-criterion verdicts and typed bugs', () => {
  const shape = nodeById('testar').contract.output_schema;

  assert.ok(shape.properties.vereditos, 'the testar node has to declare vereditos');
  assert.ok(shape.properties.bugs, 'the testar node has to declare bugs');
  assert.ok(shape.required.includes('vereditos'), 'a verdict per criterion is not optional');
  assert.deepEqual(shape.properties.vereditos.items.required, ['ref', 'veredito', 'evidencia']);
  assert.ok(
    shape.properties.bugs.items.required.includes('severidade'),
    'a bug without severity cannot be scheduled by the executor',
  );
  assert.deepEqual(
    shape.properties.resultado.enum,
    ['aprovado', 'retrabalho', 'escala'],
    'the edge vocabulary stays as it is — that is divergence 2, out of scope here',
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

test('t176 AT5 — "testar" verifies with the semantic walkthrough alone', () => {
  const { declared, checks } = bothSidesOf('testar', 'testar-alpha.json');

  assert.equal(declared.length, 1, 'the gate rerunning the quality commands is a redundant station');
  assert.equal(declared[0].type, 'agentic');
  assert.deepEqual(
    declared.map((item) => item.type),
    checks.map((check) => check.type),
  );
});

test('t176 AT6 — "implantar" declares the two git checks of implantar-release', () => {
  const { declared, checks } = bothSidesOf('implantar', 'implantar-release.json');

  assert.equal(declared.length, 2);
  assert.deepEqual(
    declared.map((item) => item.type),
    ['deterministic', 'deterministic'],
  );
  assert.deepEqual(commandsOf(declared), commandsOf(checks));
});

test('t176 AT7 — "desenvolver" declares the four checks of desenvolver-ticket', () => {
  const { declared, checks } = bothSidesOf('desenvolver', 'desenvolver-ticket.json');

  assert.equal(declared.length, 4);
  assert.deepEqual(
    declared.map((item) => item.type),
    ['deterministic', 'deterministic', 'deterministic', 'agentic'],
  );
  assert.deepEqual(commandsOf(declared), commandsOf(checks));
});

test('t176 AT8 — "integrar" declares the three checks of integrar-branch', () => {
  const { declared, checks } = bothSidesOf('integrar', 'integrar-branch.json');

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
      origin.referencia_comportamental,
      'flowpilot',
      `${file}: the port has to name the behaviour it came from (D17)`,
    );
  }

  const gate = readManifest('testar-alpha.json');
  assert.ok(
    (gate.origin.nota ?? '').includes('testing.py:77'),
    "testar-alpha has to cite the source rule that settles the contradiction",
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

test('t176 AT12 — the command the README documents under "Como validar" runs green', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const documented = fencedBlockUnder(text, '## Como validar')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('node '));

  assert.ok(documented.length > 0, 'the "Como validar" block no longer documents a node command');

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
    !text.includes('porque esta ticket não reabre o conteúdo do exemplo-mestre'),
    'the divergence was reconciled in favour of the manifest; the README has to say so',
  );
});
