/**
 * Acceptance tests of t116 — factory graph 2 (asymmetric bets).
 *
 * They cover the whole bundle: the graph document, the seven skill manifests it
 * pins and the bundle validator. Same mould as `tests/factory-graph-1.test.mjs`
 * (t105), with two tests this graph's problem class demands and the software one
 * did not have:
 *
 * - **AT11** — the crossing by contract: each node's output feeds the next
 *   node's input, and the `decisao` node produces no output at all without a
 *   recorded human answer. It is the proof, at contract level, of "a real thesis
 *   crosses all the way to the human decision" — not a live execution, which
 *   depends on t109 (see the bundle's README).
 * - **FR7** — the metrics recorded are process metrics, never a financial
 *   outcome (D14: "P&L is slow validation, never a round's metric").
 * - **FR10** (t145) — the bundle's README is executable documentation: every
 *   path it points at exists, and the command it publishes under `Como validar`
 *   runs green from the bundle directory. The two are separate tests because a
 *   dead link and a dead command are different failures to read.
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
const BUNDLE_DIR = path.join(ROOT, 'grafos-de-fabrica', 'bets-assimetricas');
const SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');
const README_PATH = path.join(BUNDLE_DIR, 'README.md');
const GRAPH_PATH = path.join(BUNDLE_DIR, 'grafo.json');
const GRAPH_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validar-grafo.mjs');
const BUNDLE_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-factory-bundle.mjs');
const GRAPH_SCHEMA_PATH = path.join(ROOT, 'schema', 'grafo.schema.json');
const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);
const THESIS_FIXTURE_PATH = path.join(
  ROOT,
  'tests',
  'fixtures',
  'tese-exemplo-bets-assimetricas.json',
);

/** D14's seven nodes: node -> { role, node_type, skill }. */
const NODES = {
  triagem: { role: 'triador', node_type: 'gate', skill: 'triar-tese' },
  'coleta-fundamentos': { role: 'pesquisador', node_type: 'work', skill: 'coletar-fundamentos' },
  'analise-assimetria': { role: 'analista', node_type: 'work', skill: 'analisar-assimetria' },
  'red-team': { role: 'red-team', node_type: 'gate', skill: 'derrubar-tese' },
  'dimensionamento-risco': {
    role: 'gestor-de-risco',
    node_type: 'work',
    skill: 'dimensionar-risco',
  },
  decisao: { role: 'decisor', node_type: 'gate', skill: 'escalar-decisao' },
  'registro-monitoramento': {
    role: 'registrador',
    node_type: 'work',
    skill: 'registrar-travessia',
  },
};

/** manifest file -> { id, role } (the manifest's role, not the node's). */
const SKILLS = {
  'triar-tese.json': { id: 'triar-tese', role: 'gate' },
  'coletar-fundamentos.json': { id: 'coletar-fundamentos', role: 'work' },
  'analisar-assimetria.json': { id: 'analisar-assimetria', role: 'work' },
  'derrubar-tese.json': { id: 'derrubar-tese', role: 'gate' },
  'dimensionar-risco.json': { id: 'dimensionar-risco', role: 'work' },
  'escalar-decisao.json': { id: 'escalar-decisao', role: 'gate' },
  'registrar-travessia.json': { id: 'registrar-travessia', role: 'work' },
};

const FILE_BY_SKILL = Object.fromEntries(
  Object.entries(SKILLS).map(([file, { id }]) => [id, file]),
);

/** The three gate skills, by the mandatory enum of `output.outcome`. */
const GATES = ['triar-tese.json', 'derrubar-tese.json', 'escalar-decisao.json'];
const GATE_RESULTS = ['pass', 'fail', 'escalate_human'];

/** FR2's nine edges. Two leave `decisao` towards the same final node. */
const EXPECTED_EDGES = [
  { from: 'triagem', to: 'coleta-fundamentos', condition: 'aprofundar' },
  { from: 'triagem', to: 'registro-monitoramento', condition: 'descartar' },
  { from: 'coleta-fundamentos', to: 'analise-assimetria', condition: 'sempre' },
  { from: 'analise-assimetria', to: 'red-team', condition: 'sempre' },
  { from: 'red-team', to: 'dimensionamento-risco', condition: 'sobrevive' },
  { from: 'red-team', to: 'registro-monitoramento', condition: 'morta' },
  { from: 'dimensionamento-risco', to: 'decisao', condition: 'sempre' },
  { from: 'decisao', to: 'registro-monitoramento', condition: 'aprovado' },
  { from: 'decisao', to: 'registro-monitoramento', condition: 'recusado' },
];

/** The crossing order AT11 proves, from `triagem` to `decisao`. */
const CHAIN = [
  'triagem',
  'coleta-fundamentos',
  'analise-assimetria',
  'red-team',
  'dimensionamento-risco',
  'decisao',
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

/** The graph document's node, by id. */
const findNode = (doc, id) => doc.nodes.find((node) => node.id === id);

/** Lines of a text that contain every given fragment. */
function linesWith(text, fragments) {
  return text
    .split('\n')
    .filter((line) => fragments.every((fragment) => line.includes(fragment)));
}

test("AT1 — grafo.json passes validarEstrutura, validarSoundness and t96's schema", async () => {
  const { validarEstrutura, validarSoundness } = await graphValidator();
  const { validateAgainstSchema } = await bundleValidator();
  const doc = readJson(GRAPH_PATH);

  assert.deepEqual(validarEstrutura(doc).errors, []);
  assert.equal(validarEstrutura(doc).valid, true);
  assert.deepEqual(validarSoundness(doc).violations, []);
  assert.equal(validarSoundness(doc).valid, true);

  // The bundle does not validate shape against `schema/grafo.schema.json` —
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

  // The key includes the condition: two edges out of `decisao` go to the same
  // final node, and a from/to-only key would collapse both into one.
  const key = (edge) => `${edge.from}>${edge.to}>${edge.condition}`;
  assert.equal(doc.edges.length, EXPECTED_EDGES.length);
  assert.deepEqual(doc.edges.map(key).sort(), EXPECTED_EDGES.map(key).sort());

  assert.equal(doc.initial_node, 'triagem');
  assert.deepEqual(doc.final_nodes, ['registro-monitoramento']);
  assert.equal(doc.problem_class, 'bets-assimetricas');
  assert.equal(doc.lineage.type, 'base');
});

test('AT3 — the seven manifests validate against manifesto-skill.schema.json', async () => {
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
  const sizing = readManifest('dimensionar-risco.json');
  const size = sizing.output.properties.dimensionamento.properties.tamanho_posicao_pct;
  assert.equal(typeof size.maximum, 'number', 'the position ceiling is a schema maximum');
  assert.ok(size.maximum > 0);
});

test('AT8 — derrubar-tese forbids "passou" with a high objection the thesis never answered', () => {
  const manifest = readManifest('derrubar-tese.json');

  const objections = manifest.output.properties.objecoes;
  assert.ok(manifest.output.required.includes('objecoes'), 'objecoes is required in the output');
  assert.deepEqual(
    objections.items.required.sort(),
    ['gravidade', 'objecao', 'resposta_da_tese'],
    'every objection declares objecao, gravidade and resposta_da_tese',
  );
  assert.deepEqual(
    objections.items.properties.resposta_da_tese.type,
    ['string', 'null'],
    'resposta_da_tese is null when the thesis did not answer',
  );

  // The instruction PROSE is untouched by t178 — the bundle-regeneration slice
  // owns it, citations included — so the words matched here are still the ones
  // the manifest says.
  const prohibition = linesWith(manifest.instructions, [
    'passou',
    'sobrevive',
    'gravidade',
    'alta',
    'resposta_da_tese',
  ]).filter((line) => /NUNCA|nunca|jamais/.test(line));
  assert.ok(
    prohibition.length >= 1,
    'instructions has to explicitly forbid concluding "passou" (edge "sobrevive") while a high-severity objection has no resposta_da_tese',
  );

  const counterEvidence = manifest.checks
    .filter((check) => check.type === 'agentic')
    .flatMap((check) => check.required_evidence);
  assert.ok(
    counterEvidence.some((item) => /contra_evidencia|contra-evidencia/.test(item)),
    'the agentic check demands specific researched counter-evidence, not a reread of the analysis',
  );
});

test('AT9 — escalar-decisao never produces a result without a recorded human answer', () => {
  const manifest = readManifest('escalar-decisao.json');

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
  ]).filter((line) => /NUNCA|nunca|jamais/.test(line));
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
    evidence.some((item) => /id_da_pergunta/.test(item)),
    "the mandatory evidence has to cite the allocation question's id",
  );
  assert.ok(
    evidence.some((item) => /texto_literal_da_resposta/.test(item)),
    'the mandatory evidence has to cite the literal text of the recorded answer',
  );
});

test('AT10 — every instructions carries the escalation block; only coletar-fundamentos opens the network', () => {
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

  const research = readManifest('coletar-fundamentos.json');
  assert.equal(research.permissions.network.allowed, true, 'coletar-fundamentos needs the network');
  assert.equal(
    research.permissions.network.domains,
    undefined,
    'unrestricted network: a fixed allowlist does not cover fundamentals research (native skill)',
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'coletar-fundamentos.json')) {
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
    "the fixture's crossing follows triagem → … → decisao",
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
  assert.ok(edgeFrom('red-team', 'sobrevive'), 'passing the red team follows the "sobrevive" edge');

  // 4. No edge out of `decisao` is followed without a human answer.
  const decisionStep = steps.at(-1);
  const decisionManifest = readManifestOfSkill('escalar-decisao');
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
    'entering `decisao` without a human answer is legal — the session pauses, it does not fail',
  );
  const errors = validateAgainstSchema(withoutAnswer.saida_tentada, decisionManifest.output);
  assert.ok(
    errors.length > 0 && errors.some((error) => /decisao_humana/.test(error.message)),
    `a result without the recorded human decision has to be refused by the contract: ${JSON.stringify(errors)}`,
  );

  // 5. With the answer recorded, the result is a literal transcription of it.
  const recorded = decisionStep.entrada.perguntas_respondidas.find(
    (answered) => answered.id === question.id,
  );
  assert.ok(recorded, 'the allocation answer arrives in entrada.perguntas_respondidas');
  assert.equal(decisionStep.saida.decisao_humana.pergunta_id, question.id);
  assert.equal(
    decisionStep.saida.decisao_humana.resposta_literal,
    recorded.resposta,
    'the result quotes the human answer literally, without interpreting it',
  );
  assert.ok(
    edgeFrom('decisao', fixture.aresta_esperada),
    `the "${fixture.aresta_esperada}" edge has to exist out of "decisao"`,
  );
});

test('FR7 — registrar-travessia records process metrics, never a financial outcome', () => {
  const manifest = readManifest('registrar-travessia.json');
  const metrics = manifest.output.properties.metricas_processo;

  assert.ok(manifest.output.required.includes('metricas_processo'));
  for (const field of [
    'red_team_executado',
    'fracao_premissas_com_fonte',
    'decisao_humana_id',
    'desfecho_final',
  ]) {
    assert.ok(metrics.required.includes(field), `metricas_processo has to require "${field}"`);
  }
  assert.equal(metrics.properties.red_team_executado.type, 'boolean');
  assert.equal(metrics.properties.fracao_premissas_com_fonte.minimum, 0);
  assert.equal(metrics.properties.fracao_premissas_com_fonte.maximum, 1);
  assert.deepEqual(
    metrics.properties.decisao_humana_id.type,
    ['string', 'null'],
    'null only when the crossing never reached decisao',
  );
  assert.deepEqual(metrics.properties.desfecho_final.enum, ['monitorando', 'arquivado']);

  // D14: "P&L is slow long-term validation, never a round's metric".
  const serialized = JSON.stringify(manifest.output);
  for (const forbidden of ['p_l', 'pnl', 'lucro', 'retorno_realizado', 'resultado_financeiro']) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `the output cannot carry a financial-outcome metric ("${forbidden}")`,
    );
  }
});

/*
 * t168 — the fields D14 asks of a thesis that software has no place for.
 *
 * `premise_source` and `asset` (t260) are demanded at `triagem`, the one gate
 * that decides whether the idea is worth research at all: a thesis with no
 * declared source has nothing to trust and one with no identified asset has
 * nothing to triage. `downside` and `upside` are the proponent's own numbers,
 * entered before `analise-assimetria` produces the real figures — so they are
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
    'premise_source',
    'tamanho_pretendido',
    'upside',
  ]);

  for (const key of ['premise_source', 'asset']) {
    const demanded = declarations.get(key);
    assert.equal(demanded.type, 'string', `${key}: type`);
    assert.equal(demanded.required_at, 'triagem', `${key}: required_at`);
    assert.ok(
      doc.nodes.some((node) => node.id === demanded.required_at),
      'required_at has to name a node this document really has',
    );
  }

  // t263: the intended position size is the class's own field too, and it is
  // demanded at the same gate — without it nobody, neither the triage nor the
  // investor, can tell whether the thesis fits the portfolio's risk ceiling.
  const size = declarations.get('tamanho_pretendido');
  assert.equal(size.type, 'number', 'tamanho_pretendido: type');
  assert.equal(size.required_at, 'triagem', 'tamanho_pretendido: required_at');
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
 * t263 — two of the four triage criteria used to come out `indeterminado` for
 * data the graph already carried.
 *
 * `project.carteira` reached the graph's `project` object in t260, but the
 * manifest only ever interpolated `criterios_de_triagem`: the paragraph that
 * spoke of the risk ceiling named `input.project.carteira` between backticks,
 * and backticks are not double braces — the renderer only substitutes
 * `{{input.…}}` tokens, so the value never left the JSON. The investor's circle
 * of competence had no place at all, and the intended position size had no
 * field. What is asserted here is the pair that makes the criteria judgeable:
 * the shape in `input`, and the three literal tokens in `instructions`.
 *
 * `carteira` is required AND nullable rather than optional because the
 * placeholder engine fails closed on a missing key
 * (`packages/runner/src/dispatch/render-skill-instructions.ts`): a `project`
 * with no open position has to send `carteira: null` on purpose, never omit it.
 */
test('t263 — triar-tese interpola carteira, círculo de competência e tamanho pretendido', () => {
  const manifest = readManifest('triar-tese.json');
  const project = manifest.input.properties.project;

  for (const key of ['carteira', 'circulo_de_competencia']) {
    assert.ok(project.required.includes(key), `project.required has to demand ${key}`);
  }
  assert.deepEqual(
    project.properties.carteira.type,
    ['object', 'null'],
    'carteira is nullable, never absent: the placeholder engine fails closed on a missing key',
  );
  assert.equal(project.properties.circulo_de_competencia.type, 'array');
  assert.equal(
    project.properties.circulo_de_competencia.minItems,
    1,
    'an empty circle of competence is no circle at all',
  );
  assert.equal(project.properties.circulo_de_competencia.items.type, 'string');

  assert.ok(
    manifest.input.required.includes('tamanho_pretendido'),
    'the intended size is demanded at the top of the input, beside asset and premise_source',
  );
  assert.equal(
    manifest.input.properties.tamanho_pretendido.type,
    'number',
    'a class field is a flat scalar at the top, never a nested object (t168)',
  );

  for (const token of [
    '{{input.project.carteira}}',
    '{{input.project.circulo_de_competencia}}',
    '{{input.tamanho_pretendido}}',
  ]) {
    assert.ok(
      manifest.instructions.includes(token),
      `instructions has to really interpolate ${token}, not merely name the path`,
    );
  }
});

test('t263 — the README documents the two new inputs of the triage', () => {
  const text = readFileSync(README_PATH, 'utf8');

  for (const key of ['circulo_de_competencia', 'tamanho_pretendido']) {
    assert.ok(
      text.includes(key),
      `the README has to document ${key}: documentation cannot lag the schema`,
    );
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
  const target = path.join(copy, 'skills', 'derrubar-tese.json');
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

test('FR10 — every path the README points at exists', () => {
  const text = readFileSync(README_PATH, 'utf8');
  const references = referencesIn(text);
  assert.ok(references.length >= 10, `only ${references.length} references read; the sweep is blind`);

  const dead = references.filter((reference) => !existsSync(resolveReference(reference)));

  assert.deepEqual(dead, [], `the README points at files that do not exist:\n${dead.join('\n')}`);
});

test('FR10 — the command the README documents under "Como validar" runs green', () => {
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

/*
 * t278 — contract matching, over the bundle's REAL manifests.
 *
 * This bundle is the one that named its own gap: `dimensionar-risco` used to
 * require a bare top-level `capital` object nothing in the graph produced
 * (README, "os dois buracos"), and closing it as a declaration under `project`
 * is what makes this case green. The three short paths into
 * `registro-monitoramento` are the other half of what is proved here: arriving
 * from `triagem --descartar-->` or `red-team --morta-->` there is no
 * `dimensionamento` and no `decisao_humana`, and that is legal precisely
 * because `registrar-travessia` declares them as properties and demands
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

test('t278 — the optional keys of registrar-travessia are what makes the short paths legal', async () => {
  const { validateContracts } = await contractValidator();
  const manifest = readManifest('registrar-travessia.json');

  for (const key of ['premissas', 'objecoes', 'dimensionamento', 'decisao_humana']) {
    assert.ok(
      Object.hasOwn(manifest.input.properties, key),
      `registrar-travessia declares "${key}" as a property`,
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
    input: { ...manifest.input, required: [...manifest.input.required, 'dimensionamento'] },
  };
  const report = validateContracts(
    readJson(GRAPH_PATH),
    bundleSkillLookup({ 'registrar-travessia': demanded }),
  );

  // One problem for the key itself and one for each of its own required
  // sub-keys: the check reads one level into a required object, on both sides.
  assert.ok(report.problems.length > 0);
  for (const problem of report.problems) {
    assert.equal(problem.code, 'unproduced_input');
    assert.equal(problem.node_id, 'registro-monitoramento');
    assert.ok(problem.key === 'dimensionamento' || problem.key.startsWith('dimensionamento.'));
    assert.deepEqual(problem.produced_elsewhere_by, ['dimensionamento-risco']);
  }
  assert.equal(report.problems[0].key, 'dimensionamento');
});
