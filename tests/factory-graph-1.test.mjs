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
 * The Portuguese names below are data: the bundle's directory, the schema keys
 * (`nos`, `arestas`, `skill_ref`, `instrucoes`, `permissoes`, …), the node ids
 * and the enum values are all frozen by D18's own carve-out, and so are the
 * reference validator's pinned exports (t133, exception 5).
 *
 * Run with: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'grafos-de-fabrica', 'desenvolvimento-de-software');
const SKILLS_DIR = path.join(BUNDLE_DIR, 'skills');
const GRAPH_PATH = path.join(BUNDLE_DIR, 'grafo.json');
const GRAPH_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validar-grafo.mjs');
const BUNDLE_VALIDATOR_PATH = path.join(ROOT, 'scripts', 'validate-factory-bundle.mjs');
const MANIFEST_SCHEMA_PATH = path.join(
  ROOT,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);

/** The bundle's five manifests: file -> { id, papel, node }. */
const SKILLS = {
  'refinar-ticket.json': { id: 'refinar-ticket', papel: 'fazer', node: 'refinar' },
  'desenvolver-ticket.json': { id: 'desenvolver-ticket', papel: 'fazer', node: 'desenvolver' },
  'integrar-branch.json': { id: 'integrar-branch', papel: 'fazer', node: 'integrar' },
  'testar-alpha.json': { id: 'testar-alpha', papel: 'portao', node: 'testar' },
  'implantar-release.json': { id: 'implantar-release', papel: 'fazer', node: 'implantar' },
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
  { de: 'refinar', para: 'desenvolver', condicao: 'sempre' },
  { de: 'desenvolver', para: 'integrar', condicao: 'sempre' },
  { de: 'integrar', para: 'testar', condicao: 'sempre' },
  { de: 'testar', para: 'implantar', condicao: 'aprovado' },
  { de: 'testar', para: 'desenvolver', condicao: 'retrabalho' },
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
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 */
function hashOfManifest(manifest) {
  const subset = {
    instrucoes: manifest.instrucoes,
    entrada: manifest.entrada,
    saida: manifest.saida,
    checks: manifest.checks,
    permissoes: manifest.permissoes,
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

  assert.deepEqual(doc.nos.map((node) => node.id).sort(), EXPECTED_NODES);
  for (const node of doc.nos) {
    assert.equal(node.papel, ROLE_BY_NODE[node.id], `expected role for node "${node.id}"`);
  }

  const key = (edge) => `${edge.de}>${edge.para}`;
  assert.deepEqual(doc.arestas.map(key).sort(), EXPECTED_EDGES.map(key).sort());
  for (const expected of EXPECTED_EDGES) {
    const edge = doc.arestas.find((e) => e.de === expected.de && e.para === expected.para);
    assert.equal(edge.condicao, expected.condicao, `expected condition of edge ${key(expected)}`);
  }

  assert.equal(doc.no_inicial, 'refinar');
  assert.deepEqual(doc.nos_finais, ['implantar']);
  assert.equal(doc.classe, 'desenvolvimento-de-software');
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
    assert.equal(manifest.papel, expected.papel, `${file}: papel`);
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

test('AT5 — testar-alpha declares saida.resultado with the gate\'s three values', () => {
  const manifest = readManifest('testar-alpha.json');
  assert.deepEqual(manifest.saida.properties.resultado.enum, [
    'passou',
    'falhou',
    'escalar_humano',
  ]);
  assert.ok(
    manifest.saida.required.includes('resultado'),
    "resultado has to be required in the gate's output",
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

  assert.equal(doc.nos.length, 5);
  for (const node of doc.nos) {
    const manifest = byId.get(node.skill_ref.id);
    assert.ok(manifest, `no manifest with id "${node.skill_ref.id}" (node "${node.id}")`);
    assert.equal(manifest.versao, node.skill_ref.versao, `node "${node.id}": pinned version`);
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
  const deterministic = gate.checks.filter((check) => check.tipo === 'deterministico');
  assert.deepEqual(
    deterministic,
    [],
    'testar-alpha cannot have a deterministic check: rerunning integration gates is a redundant station',
  );
  assert.ok(
    gate.checks.some((check) => check.tipo === 'agentico'),
    'testar-alpha needs the agentic semantic-walkthrough check',
  );

  const runsProjectCommand = (manifest) =>
    manifest.checks.some(
      (check) =>
        check.tipo === 'deterministico' &&
        /\{\{entrada\.projeto\.(comando_testes|comandos_qualidade)\}\}/.test(check.comando ?? ''),
    );
  for (const file of ['integrar-branch.json', 'desenvolver-ticket.json']) {
    assert.ok(
      runsProjectCommand(readManifest(file)),
      `${file} needs a deterministic check that runs the project's commands`,
    );
  }
});

test('AT8 — every instrucoes carries the escalation contract (input-request block)', () => {
  for (const file of Object.keys(SKILLS)) {
    const manifest = readManifest(file);
    assert.ok(
      manifest.instrucoes.includes('```input-request'),
      `${file}: instrucoes has to contain the \`\`\`input-request marker`,
    );
  }
});

test('AT9 — only testar-alpha opens the network, and only to loopback', () => {
  const gate = readManifest('testar-alpha.json');
  assert.equal(gate.permissoes.rede.permitido, true);
  assert.ok(
    Array.isArray(gate.permissoes.rede.dominios) && gate.permissoes.rede.dominios.length > 0,
    'testar-alpha has to restrict the network to a list of domains',
  );

  for (const file of Object.keys(SKILLS).filter((name) => name !== 'testar-alpha.json')) {
    assert.equal(readManifest(file).permissoes.rede.permitido, false, `${file}: network closed`);
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
