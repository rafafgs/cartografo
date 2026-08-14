/**
 * Testes de aceite da t105 — grafo de fábrica 1 (desenvolvimento de software).
 *
 * Cobrem o bundle inteiro: o documento de grafo, os cinco manifestos de skill
 * que ele pina e o validador de bundle. Zero dependências: só `node:test`,
 * `node:assert`, `node:crypto`, `node:fs`, `node:os`, `node:path` e
 * `node:child_process`.
 *
 * O procedimento de hash é reimplementado AQUI, direto da especificação
 * (`especificacoes/formatos/manifesto-skill.md`, seção "Identificação"), e não
 * importado do validador: se o teste reusasse a implementação que ele confere,
 * um erro no canonicalizador passaria despercebido pelos dois lados.
 *
 * Rodar: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const RAIZ = path.resolve(import.meta.dirname, '..');
const DIR_BUNDLE = path.join(RAIZ, 'grafos-de-fabrica', 'desenvolvimento-de-software');
const DIR_SKILLS = path.join(DIR_BUNDLE, 'skills');
const CAMINHO_GRAFO = path.join(DIR_BUNDLE, 'grafo.json');
const CAMINHO_VALIDADOR_GRAFO = path.join(RAIZ, 'scripts', 'validar-grafo.mjs');
const CAMINHO_VALIDADOR_BUNDLE = path.join(RAIZ, 'scripts', 'validar-bundle-fabrica.mjs');
const CAMINHO_SCHEMA_MANIFESTO = path.join(
  RAIZ,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);

/** Os cinco manifestos do bundle: arquivo -> { id, papel, no }. */
const SKILLS = {
  'refinar-ticket.json': { id: 'refinar-ticket', papel: 'fazer', no: 'refinar' },
  'desenvolver-ticket.json': { id: 'desenvolver-ticket', papel: 'fazer', no: 'desenvolver' },
  'integrar-branch.json': { id: 'integrar-branch', papel: 'fazer', no: 'integrar' },
  'testar-alpha.json': { id: 'testar-alpha', papel: 'portao', no: 'testar' },
  'implantar-release.json': { id: 'implantar-release', papel: 'fazer', no: 'implantar' },
};

/**
 * Topologia travada pela t96 (`tests/schema-grafo.test.mjs` AT3), repetida aqui
 * de propósito: este bundle é conteúdo novo, e o teste dele não pode depender
 * de o fixture do t96 continuar existindo com o mesmo nome.
 */
const NOS_ESPERADOS = ['desenvolver', 'implantar', 'integrar', 'refinar', 'testar'];
const PAPEL_POR_NO = {
  refinar: 'arquiteto',
  desenvolver: 'desenvolvedor',
  integrar: 'integrador',
  testar: 'tester',
  implantar: 'deployer',
};
const ARESTAS_ESPERADAS = [
  { de: 'refinar', para: 'desenvolver', condicao: 'sempre' },
  { de: 'desenvolver', para: 'integrar', condicao: 'sempre' },
  { de: 'integrar', para: 'testar', condicao: 'sempre' },
  { de: 'testar', para: 'implantar', condicao: 'aprovado' },
  { de: 'testar', para: 'desenvolver', condicao: 'retrabalho' },
];

/** Lê um JSON do repositório, falhando com o caminho relativo quando não existe. */
function lerJson(caminho) {
  assert.ok(
    existsSync(caminho),
    `artefato ainda não existe: ${path.relative(RAIZ, caminho)}`,
  );
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

const lerManifesto = (arquivo) => lerJson(path.join(DIR_SKILLS, arquivo));

/** Ordena chaves recursivamente (RFC 8785 na parte que este formato usa). */
function canonicalizar(valor) {
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (valor && typeof valor === 'object') {
    return Object.keys(valor)
      .sort()
      .reduce((acc, chave) => {
        acc[chave] = canonicalizar(valor[chave]);
        return acc;
      }, {});
  }
  return valor;
}

/**
 * Hash canônico do manifesto, pelo procedimento de
 * `especificacoes/formatos/manifesto-skill.md`: sha256 do JSON canônico de
 * `{instrucoes, entrada, saida, checks, permissoes}`.
 */
function hashDoManifesto(manifesto) {
  const subconjunto = {
    instrucoes: manifesto.instrucoes,
    entrada: manifesto.entrada,
    saida: manifesto.saida,
    checks: manifesto.checks,
    permissoes: manifesto.permissoes,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalizar(subconjunto)), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

let moduloValidadorGrafo = null;
let moduloValidadorBundle = null;

/**
 * Importa um validador sob demanda. A checagem de existência vem antes do
 * `import()` para que o vermelho inicial diga qual artefato falta, em vez de
 * estourar um ERR_MODULE_NOT_FOUND cru.
 */
async function carregar(caminho, cache) {
  assert.ok(
    existsSync(caminho),
    `artefato ainda não existe: ${path.relative(RAIZ, caminho)}`,
  );
  return cache ?? (await import(`file://${caminho}`));
}

async function validadorDeGrafo() {
  moduloValidadorGrafo = await carregar(CAMINHO_VALIDADOR_GRAFO, moduloValidadorGrafo);
  return moduloValidadorGrafo;
}

async function validadorDeBundle() {
  moduloValidadorBundle = await carregar(CAMINHO_VALIDADOR_BUNDLE, moduloValidadorBundle);
  return moduloValidadorBundle;
}

/** Roda o CLI do validador de bundle contra um diretório. */
function rodarCli(diretorio) {
  return spawnSync(process.execPath, [CAMINHO_VALIDADOR_BUNDLE, diretorio], {
    cwd: RAIZ,
    encoding: 'utf8',
  });
}

test('AT1 — grafo.json passa em validarEstrutura e validarSoundness', async () => {
  const { validarEstrutura, validarSoundness } = await validadorDeGrafo();
  const doc = lerJson(CAMINHO_GRAFO);

  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.equal(validarEstrutura(doc).valido, true);
  assert.deepEqual(validarSoundness(doc).violacoes, []);
  assert.equal(validarSoundness(doc).valido, true);
});

test('AT2 — ids, papéis e arestas batem com a topologia fixada pela t96', () => {
  const doc = lerJson(CAMINHO_GRAFO);

  assert.deepEqual(doc.nos.map((no) => no.id).sort(), NOS_ESPERADOS);
  for (const no of doc.nos) {
    assert.equal(no.papel, PAPEL_POR_NO[no.id], `papel esperado para o nó "${no.id}"`);
  }

  const chave = (a) => `${a.de}>${a.para}`;
  assert.deepEqual(
    doc.arestas.map(chave).sort(),
    ARESTAS_ESPERADAS.map(chave).sort(),
  );
  for (const esperada of ARESTAS_ESPERADAS) {
    const aresta = doc.arestas.find((a) => a.de === esperada.de && a.para === esperada.para);
    assert.equal(
      aresta.condicao,
      esperada.condicao,
      `condição esperada da aresta ${chave(esperada)}`,
    );
  }

  assert.equal(doc.no_inicial, 'refinar');
  assert.deepEqual(doc.nos_finais, ['implantar']);
  assert.equal(doc.classe, 'desenvolvimento-de-software');
});

test('AT3 — os cinco manifestos validam contra manifesto-skill.schema.json', async () => {
  const { validarManifesto } = await validadorDeBundle();
  const schema = lerJson(CAMINHO_SCHEMA_MANIFESTO);
  assert.equal(typeof validarManifesto, 'function', 'validar-bundle-fabrica.mjs precisa exportar validarManifesto');

  for (const arquivo of Object.keys(SKILLS)) {
    const { valido, erros } = validarManifesto(lerManifesto(arquivo));
    assert.deepEqual(erros, [], `${arquivo}: erros de schema`);
    assert.equal(valido, true, `${arquivo} precisa validar contra ${path.basename(CAMINHO_SCHEMA_MANIFESTO)}`);
  }

  // O fixture negativo do t97 continua sendo rejeitado pelo mesmo validador —
  // é o que prova que o "verde" acima não vem de um validador permissivo.
  assert.ok(schema.$defs.check, 'o schema do manifesto precisa declarar $defs.check');
  const invalido = lerJson(
    path.join(RAIZ, 'especificacoes', 'formatos', 'exemplos', 'manifesto-skill.invalido.fixture.json'),
  );
  assert.equal(validarManifesto(invalido).valido, false, 'o fixture negativo do t97 precisa ser rejeitado');
});

test('AT4 — os cinco manifestos existem com id e papel esperados', () => {
  for (const [arquivo, esperado] of Object.entries(SKILLS)) {
    const manifesto = lerManifesto(arquivo);
    assert.equal(manifesto.id, esperado.id, `${arquivo}: id`);
    assert.equal(manifesto.papel, esperado.papel, `${arquivo}: papel`);
    assert.ok(
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifesto.id),
      `${arquivo}: id precisa ser kebab-case puro, sem prefixo de namespace`,
    );
    assert.equal(
      manifesto.id,
      path.basename(arquivo, '.json'),
      `${arquivo}: o id é o nome do arquivo sem extensão`,
    );
  }
});

test('AT5 — testar-alpha declara saida.resultado com os três valores do portão', () => {
  const manifesto = lerManifesto('testar-alpha.json');
  assert.deepEqual(manifesto.saida.properties.resultado.enum, [
    'passou',
    'falhou',
    'escalar_humano',
  ]);
  assert.ok(
    manifesto.saida.required.includes('resultado'),
    'resultado precisa ser obrigatório na saída do portão',
  );
});

test('AT6 — o hash recalculado de cada manifesto bate com o skill_ref do nó', () => {
  const doc = lerJson(CAMINHO_GRAFO);
  const porId = new Map(
    Object.keys(SKILLS).map((arquivo) => {
      const manifesto = lerManifesto(arquivo);
      return [manifesto.id, manifesto];
    }),
  );

  assert.equal(doc.nos.length, 5);
  for (const no of doc.nos) {
    const manifesto = porId.get(no.skill_ref.id);
    assert.ok(manifesto, `nenhum manifesto com id "${no.skill_ref.id}" (nó "${no.id}")`);
    assert.equal(manifesto.versao, no.skill_ref.versao, `nó "${no.id}": versão pinada`);
    assert.equal(
      hashDoManifesto(manifesto),
      no.skill_ref.hash,
      `nó "${no.id}": o hash pinado precisa ser o hash real do manifesto`,
    );
    assert.equal(
      manifesto.hash,
      no.skill_ref.hash,
      `nó "${no.id}": o manifesto precisa declarar o mesmo hash que o nó pina`,
    );
  }
});

test('AT7 — testar-alpha não reroda gate de qualidade; integrar e desenvolver rerodam', () => {
  const testar = lerManifesto('testar-alpha.json');
  const deterministicos = testar.checks.filter((check) => check.tipo === 'deterministico');
  assert.deepEqual(
    deterministicos,
    [],
    'testar-alpha não pode ter check determinístico: rerodar os gates da integração é estação redundante',
  );
  assert.ok(
    testar.checks.some((check) => check.tipo === 'agentico'),
    'testar-alpha precisa do check agêntico de caminhada semântica',
  );

  const rodaComandoDoProjeto = (manifesto) =>
    manifesto.checks.some(
      (check) =>
        check.tipo === 'deterministico' &&
        /\{\{entrada\.projeto\.(comando_testes|comandos_qualidade)\}\}/.test(check.comando ?? ''),
    );
  for (const arquivo of ['integrar-branch.json', 'desenvolver-ticket.json']) {
    assert.ok(
      rodaComandoDoProjeto(lerManifesto(arquivo)),
      `${arquivo} precisa de um check determinístico que rode os comandos do projeto`,
    );
  }
});

test('AT8 — toda instrucoes carrega o contrato de escalação (bloco input-request)', () => {
  for (const arquivo of Object.keys(SKILLS)) {
    const manifesto = lerManifesto(arquivo);
    assert.ok(
      manifesto.instrucoes.includes('```input-request'),
      `${arquivo}: instrucoes precisa conter o marcador \`\`\`input-request`,
    );
  }
});

test('AT9 — só testar-alpha abre rede, e restrita a loopback', () => {
  const testar = lerManifesto('testar-alpha.json');
  assert.equal(testar.permissoes.rede.permitido, true);
  assert.ok(
    Array.isArray(testar.permissoes.rede.dominios) && testar.permissoes.rede.dominios.length > 0,
    'testar-alpha precisa restringir a rede a uma lista de domínios',
  );

  for (const arquivo of Object.keys(SKILLS).filter((nome) => nome !== 'testar-alpha.json')) {
    assert.equal(
      lerManifesto(arquivo).permissoes.rede.permitido,
      false,
      `${arquivo}: rede fechada`,
    );
  }
});

test('AT10 — o CLI do validador aprova o bundle e reprova um hash adulterado', () => {
  assert.ok(
    existsSync(CAMINHO_VALIDADOR_BUNDLE),
    `artefato ainda não existe: ${path.relative(RAIZ, CAMINHO_VALIDADOR_BUNDLE)}`,
  );

  const bom = rodarCli(DIR_BUNDLE);
  assert.equal(
    bom.status,
    0,
    `o bundle real precisa sair com código 0:\n${bom.stdout}${bom.stderr}`,
  );

  const copia = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-bundle-')), 'bundle');
  cpSync(DIR_BUNDLE, copia, { recursive: true });
  const alvo = path.join(copia, 'skills', 'testar-alpha.json');
  const manifesto = JSON.parse(readFileSync(alvo, 'utf8'));
  manifesto.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(alvo, `${JSON.stringify(manifesto, null, 2)}\n`);

  const ruim = rodarCli(copia);
  assert.notEqual(ruim.status, 0, 'hash adulterado precisa sair com código diferente de 0');
  assert.ok(
    `${ruim.stdout}${ruim.stderr}`.includes('testar'),
    `o relatório precisa nomear o nó divergente:\n${ruim.stdout}${ruim.stderr}`,
  );
});
