/**
 * Testes de aceite da t116 — grafo de fábrica 2 (bets assimétricas).
 *
 * Cobrem o bundle inteiro: o documento de grafo, os sete manifestos de skill
 * que ele pina e o validador de bundle. Mesmo molde de
 * `tests/grafo-fabrica-1.test.mjs` (t105), com dois testes que a classe de
 * problema deste grafo obriga e a de software não tinha:
 *
 * - **AT11** — a travessia por contrato: a saída de cada nó alimenta a entrada
 *   do próximo, e o nó `decisao` não produz saída nenhuma sem uma resposta
 *   humana registrada. É a prova, em nível de contrato, de "uma tese real
 *   atravessa até a decisão humana" — não uma execução ao vivo, que depende da
 *   t109 (ver o README do bundle).
 * - **FR7** — as métricas registradas são de processo, nunca de resultado
 *   financeiro (D14: "P&L é validação lenta, nunca métrica de rodada").
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
const DIR_BUNDLE = path.join(RAIZ, 'grafos-de-fabrica', 'bets-assimetricas');
const DIR_SKILLS = path.join(DIR_BUNDLE, 'skills');
const CAMINHO_GRAFO = path.join(DIR_BUNDLE, 'grafo.json');
const CAMINHO_VALIDADOR_GRAFO = path.join(RAIZ, 'scripts', 'validar-grafo.mjs');
const CAMINHO_VALIDADOR_BUNDLE = path.join(RAIZ, 'scripts', 'validar-bundle-fabrica.mjs');
const CAMINHO_SCHEMA_GRAFO = path.join(RAIZ, 'schema', 'grafo.schema.json');
const CAMINHO_SCHEMA_MANIFESTO = path.join(
  RAIZ,
  'especificacoes',
  'formatos',
  'manifesto-skill.schema.json',
);
const CAMINHO_FIXTURE_TESE = path.join(
  RAIZ,
  'tests',
  'fixtures',
  'tese-exemplo-bets-assimetricas.json',
);

/** Os sete nós de D14: nó -> { papel, tipo_no, skill, arquivo }. */
const NOS = {
  triagem: { papel: 'triador', tipo_no: 'portao', skill: 'triar-tese' },
  'coleta-fundamentos': { papel: 'pesquisador', tipo_no: 'trabalho', skill: 'coletar-fundamentos' },
  'analise-assimetria': { papel: 'analista', tipo_no: 'trabalho', skill: 'analisar-assimetria' },
  'red-team': { papel: 'red-team', tipo_no: 'portao', skill: 'derrubar-tese' },
  'dimensionamento-risco': {
    papel: 'gestor-de-risco',
    tipo_no: 'trabalho',
    skill: 'dimensionar-risco',
  },
  decisao: { papel: 'decisor', tipo_no: 'portao', skill: 'escalar-decisao' },
  'registro-monitoramento': {
    papel: 'registrador',
    tipo_no: 'trabalho',
    skill: 'registrar-travessia',
  },
};

/** arquivo do manifesto -> { id, papel } (papel do manifesto, não do nó). */
const SKILLS = {
  'triar-tese.json': { id: 'triar-tese', papel: 'portao' },
  'coletar-fundamentos.json': { id: 'coletar-fundamentos', papel: 'fazer' },
  'analisar-assimetria.json': { id: 'analisar-assimetria', papel: 'fazer' },
  'derrubar-tese.json': { id: 'derrubar-tese', papel: 'portao' },
  'dimensionar-risco.json': { id: 'dimensionar-risco', papel: 'fazer' },
  'escalar-decisao.json': { id: 'escalar-decisao', papel: 'portao' },
  'registrar-travessia.json': { id: 'registrar-travessia', papel: 'fazer' },
};

const ARQUIVO_POR_SKILL = Object.fromEntries(
  Object.entries(SKILLS).map(([arquivo, { id }]) => [id, arquivo]),
);

/** As três skills de portão, pelo enum obrigatório de `saida.resultado`. */
const PORTOES = ['triar-tese.json', 'derrubar-tese.json', 'escalar-decisao.json'];
const RESULTADOS_DE_PORTAO = ['passou', 'falhou', 'escalar_humano'];

/** As nove arestas de FR2. Duas saem de `decisao` para o mesmo nó final. */
const ARESTAS_ESPERADAS = [
  { de: 'triagem', para: 'coleta-fundamentos', condicao: 'aprofundar' },
  { de: 'triagem', para: 'registro-monitoramento', condicao: 'descartar' },
  { de: 'coleta-fundamentos', para: 'analise-assimetria', condicao: 'sempre' },
  { de: 'analise-assimetria', para: 'red-team', condicao: 'sempre' },
  { de: 'red-team', para: 'dimensionamento-risco', condicao: 'sobrevive' },
  { de: 'red-team', para: 'registro-monitoramento', condicao: 'morta' },
  { de: 'dimensionamento-risco', para: 'decisao', condicao: 'sempre' },
  { de: 'decisao', para: 'registro-monitoramento', condicao: 'aprovado' },
  { de: 'decisao', para: 'registro-monitoramento', condicao: 'recusado' },
];

/** A ordem da travessia provada por AT11, de `triagem` até `decisao`. */
const CADEIA = [
  'triagem',
  'coleta-fundamentos',
  'analise-assimetria',
  'red-team',
  'dimensionamento-risco',
  'decisao',
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
const lerManifestoDaSkill = (skill) => lerManifesto(ARQUIVO_POR_SKILL[skill]);

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

/** O nó do documento de grafo, pelo id. */
const acharNo = (doc, id) => doc.nos.find((no) => no.id === id);

/** Linhas de um texto que contêm todos os fragmentos dados. */
function linhasCom(texto, fragmentos) {
  return texto
    .split('\n')
    .filter((linha) => fragmentos.every((fragmento) => linha.includes(fragmento)));
}

test('AT1 — grafo.json passa em validarEstrutura, validarSoundness e no schema do t96', async () => {
  const { validarEstrutura, validarSoundness } = await validadorDeGrafo();
  const { validarContraSchema } = await validadorDeBundle();
  const doc = lerJson(CAMINHO_GRAFO);

  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.equal(validarEstrutura(doc).valido, true);
  assert.deepEqual(validarSoundness(doc).violacoes, []);
  assert.equal(validarSoundness(doc).valido, true);

  // O bundle não valida forma contra schema/grafo.schema.json — só estrutura e
  // soundness. Este documento é conteúdo novo, então a forma é conferida aqui.
  assert.deepEqual(validarContraSchema(doc, lerJson(CAMINHO_SCHEMA_GRAFO)), []);
});

test('AT2 — os 7 nós e as 9 arestas batem exatamente com as tabelas de FR1-FR2', () => {
  const doc = lerJson(CAMINHO_GRAFO);

  assert.deepEqual(doc.nos.map((no) => no.id).sort(), Object.keys(NOS).sort());
  for (const [id, esperado] of Object.entries(NOS)) {
    const no = acharNo(doc, id);
    assert.equal(no.papel, esperado.papel, `papel esperado para o nó "${id}"`);
    assert.equal(no.tipo_no, esperado.tipo_no, `tipo_no esperado para o nó "${id}"`);
    assert.equal(no.skill_ref.id, esperado.skill, `skill_ref.id esperado para o nó "${id}"`);
  }

  // A chave inclui a condição: duas arestas de `decisao` vão para o mesmo nó
  // final, e uma chave só de/para colapsaria as duas em uma.
  const chave = (a) => `${a.de}>${a.para}>${a.condicao}`;
  assert.equal(doc.arestas.length, ARESTAS_ESPERADAS.length);
  assert.deepEqual(doc.arestas.map(chave).sort(), ARESTAS_ESPERADAS.map(chave).sort());

  assert.equal(doc.no_inicial, 'triagem');
  assert.deepEqual(doc.nos_finais, ['registro-monitoramento']);
  assert.equal(doc.classe, 'bets-assimetricas');
  assert.equal(doc.linhagem.tipo, 'base');
});

test('AT3 — os sete manifestos validam contra manifesto-skill.schema.json', async () => {
  const { validarManifesto } = await validadorDeBundle();
  const schema = lerJson(CAMINHO_SCHEMA_MANIFESTO);
  assert.equal(
    typeof validarManifesto,
    'function',
    'validar-bundle-fabrica.mjs precisa exportar validarManifesto',
  );

  for (const arquivo of Object.keys(SKILLS)) {
    const { valido, erros } = validarManifesto(lerManifesto(arquivo));
    assert.deepEqual(erros, [], `${arquivo}: erros de schema`);
    assert.equal(
      valido,
      true,
      `${arquivo} precisa validar contra ${path.basename(CAMINHO_SCHEMA_MANIFESTO)}`,
    );
  }

  // O fixture negativo do t97 continua sendo rejeitado pelo mesmo validador —
  // é o que prova que o "verde" acima não vem de um validador permissivo.
  assert.ok(schema.$defs.check, 'o schema do manifesto precisa declarar $defs.check');
  const invalido = lerJson(
    path.join(RAIZ, 'especificacoes', 'formatos', 'exemplos', 'manifesto-skill.invalido.fixture.json'),
  );
  assert.equal(validarManifesto(invalido).valido, false, 'o fixture negativo do t97 precisa ser rejeitado');
});

test('AT4 — os sete manifestos existem com id kebab-case e papel esperados', () => {
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

test('AT5 — os três portões declaram saida.resultado com os três valores do enum', () => {
  for (const arquivo of PORTOES) {
    const manifesto = lerManifesto(arquivo);
    assert.equal(manifesto.papel, 'portao', `${arquivo}: papel`);
    assert.deepEqual(
      manifesto.saida.properties.resultado.enum,
      RESULTADOS_DE_PORTAO,
      `${arquivo}: enum de saida.resultado`,
    );
    assert.ok(
      manifesto.saida.required.includes('resultado'),
      `${arquivo}: resultado precisa ser obrigatório na saída do portão`,
    );
  }
});

test('AT6 — o hash recalculado de cada manifesto bate com o skill_ref do nó', () => {
  const doc = lerJson(CAMINHO_GRAFO);
  const porId = new Map(
    Object.keys(SKILLS).map((arquivo) => {
      const manifesto = lerManifesto(arquivo);
      return [manifesto.id, manifesto];
    }),
  );

  assert.equal(doc.nos.length, 7);
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
    assert.ok(
      /^sha256:[0-9a-f]{64}$/.test(no.skill_ref.hash),
      `nó "${no.id}": hash real, nunca placeholder`,
    );
  }
});

test('AT7 — nenhum check determinístico; todo manifesto tem check agêntico com evidência', () => {
  for (const arquivo of Object.keys(SKILLS)) {
    const manifesto = lerManifesto(arquivo);
    assert.deepEqual(
      manifesto.checks.filter((check) => check.tipo === 'deterministico'),
      [],
      `${arquivo}: esta classe de problema não tem comando de chão de fábrica`,
    );
    const agenticos = manifesto.checks.filter((check) => check.tipo === 'agentico');
    assert.ok(agenticos.length >= 1, `${arquivo}: precisa de pelo menos um check agêntico`);
    for (const check of agenticos) {
      assert.ok(
        Array.isArray(check.evidencia_obrigatoria) && check.evidencia_obrigatoria.length > 0,
        `${arquivo}: check "${check.id}" precisa de evidencia_obrigatoria não vazia`,
      );
    }
  }

  // O documento de grafo não pode reintroduzir por trás o check determinístico
  // que os manifestos recusam.
  const doc = lerJson(CAMINHO_GRAFO);
  for (const no of doc.nos) {
    assert.deepEqual(
      no.contrato.verificacoes.filter((v) => v.tipo === 'deterministico'),
      [],
      `nó "${no.id}": contrato não pode declarar check determinístico`,
    );
  }

  // O limite estrutural que existe é imposto por JSON Schema, não por check
  // fabricado (FR8).
  const dimensionar = lerManifesto('dimensionar-risco.json');
  const tamanho = dimensionar.saida.properties.dimensionamento.properties.tamanho_posicao_pct;
  assert.equal(typeof tamanho.maximum, 'number', 'o teto de posição é um maximum de schema');
  assert.ok(tamanho.maximum > 0);
});

test('AT8 — derrubar-tese proíbe "passou" com objeção alta sem resposta da tese', () => {
  const manifesto = lerManifesto('derrubar-tese.json');

  const objecoes = manifesto.saida.properties.objecoes;
  assert.ok(manifesto.saida.required.includes('objecoes'), 'objecoes é obrigatória na saída');
  assert.deepEqual(
    objecoes.items.required.sort(),
    ['gravidade', 'objecao', 'resposta_da_tese'],
    'cada objeção declara objecao, gravidade e resposta_da_tese',
  );
  assert.deepEqual(
    objecoes.items.properties.resposta_da_tese.type,
    ['string', 'null'],
    'resposta_da_tese é nula quando a tese não respondeu',
  );

  const proibicao = linhasCom(manifesto.instrucoes, [
    'passou',
    'sobrevive',
    'gravidade',
    'alta',
    'resposta_da_tese',
  ]).filter((linha) => /NUNCA|nunca|jamais/.test(linha));
  assert.ok(
    proibicao.length >= 1,
    'as instrucoes precisam proibir explicitamente concluir "passou" (aresta "sobrevive") havendo objeção de gravidade alta sem resposta_da_tese',
  );

  const contraEvidencia = manifesto.checks
    .filter((check) => check.tipo === 'agentico')
    .flatMap((check) => check.evidencia_obrigatoria);
  assert.ok(
    contraEvidencia.some((item) => /contra_evidencia|contra-evidencia/.test(item)),
    'o check agêntico exige contra-evidência específica pesquisada, não releitura da análise',
  );
});

test('AT9 — escalar-decisao nunca produz resultado sem resposta humana registrada', () => {
  const manifesto = lerManifesto('escalar-decisao.json');

  assert.ok(
    manifesto.entrada.required.includes('perguntas_respondidas'),
    'entrada precisa exigir perguntas_respondidas',
  );
  assert.deepEqual(
    manifesto.entrada.properties.perguntas_respondidas.items.required.sort(),
    ['id', 'pergunta', 'resposta'],
    'cada pergunta respondida carrega id, pergunta e resposta',
  );

  const proibicao = linhasCom(manifesto.instrucoes, ['perguntas_respondidas', 'resultado']).filter(
    (linha) => /NUNCA|nunca|jamais/.test(linha),
  );
  assert.ok(
    proibicao.length >= 1,
    'as instrucoes precisam proibir produzir resultado sem uma resposta de alocação em perguntas_respondidas',
  );
  assert.ok(
    manifesto.instrucoes.includes('```input-request'),
    'a sessão sem resposta registrada termina o turno com um bloco input-request',
  );

  const evidencias = manifesto.checks
    .filter((check) => check.tipo === 'agentico')
    .flatMap((check) => check.evidencia_obrigatoria);
  assert.ok(
    evidencias.some((item) => /id_da_pergunta/.test(item)),
    'a evidência obrigatória precisa citar o id da pergunta de alocação',
  );
  assert.ok(
    evidencias.some((item) => /texto_literal_da_resposta/.test(item)),
    'a evidência obrigatória precisa citar o texto literal da resposta registrada',
  );
});

test('AT10 — toda instrucoes carrega o bloco de escalação; só coletar-fundamentos abre rede', () => {
  for (const arquivo of Object.keys(SKILLS)) {
    const manifesto = lerManifesto(arquivo);
    assert.ok(
      manifesto.instrucoes.includes('```input-request'),
      `${arquivo}: instrucoes precisa conter o marcador \`\`\`input-request`,
    );
    assert.deepEqual(
      manifesto.permissoes.filesystem.escrita,
      [],
      `${arquivo}: nó nenhum deste grafo escreve no repositório do investidor`,
    );
  }

  const pesquisa = lerManifesto('coletar-fundamentos.json');
  assert.equal(pesquisa.permissoes.rede.permitido, true, 'coletar-fundamentos precisa de rede');
  assert.equal(
    pesquisa.permissoes.rede.dominios,
    undefined,
    'rede irrestrita: allowlist fixa não cobre a pesquisa de fundamentos (skill nativa)',
  );

  for (const arquivo of Object.keys(SKILLS).filter((nome) => nome !== 'coletar-fundamentos.json')) {
    assert.equal(
      lerManifesto(arquivo).permissoes.rede.permitido,
      false,
      `${arquivo}: rede fechada`,
    );
  }
});

test('AT11 — a tese fixture atravessa contrato a contrato até a decisão humana', async () => {
  const { validarContraSchema } = await validadorDeBundle();
  const doc = lerJson(CAMINHO_GRAFO);
  const fixture = lerJson(CAMINHO_FIXTURE_TESE);

  const passos = fixture.travessia;
  assert.deepEqual(
    passos.map((passo) => passo.no),
    CADEIA,
    'a travessia do fixture segue triagem → … → decisao',
  );

  // 1. Cada payload vale contra os DOIS contratos do nó: o do documento de
  //    grafo (o que o executor lê) e o do manifesto (o que o runner valida).
  for (const passo of passos) {
    const no = acharNo(doc, passo.no);
    const manifesto = lerManifestoDaSkill(NOS[passo.no].skill);
    assert.deepEqual(
      validarContraSchema(passo.entrada, no.contrato.entrada_schema),
      [],
      `nó "${passo.no}": entrada contra o entrada_schema do grafo`,
    );
    assert.deepEqual(
      validarContraSchema(passo.entrada, manifesto.entrada),
      [],
      `nó "${passo.no}": entrada contra a entrada do manifesto`,
    );
    assert.deepEqual(
      validarContraSchema(passo.saida, no.contrato.saida_schema),
      [],
      `nó "${passo.no}": saída contra o saida_schema do grafo`,
    );
    assert.deepEqual(
      validarContraSchema(passo.saida, manifesto.saida),
      [],
      `nó "${passo.no}": saída contra a saida do manifesto`,
    );
  }

  // 2. A saída de um nó ALIMENTA a entrada do próximo: todo campo que o
  //    próximo contrato declara e o anterior produziu chega intacto.
  for (let i = 0; i < passos.length - 1; i += 1) {
    const anterior = passos[i];
    const proximo = passos[i + 1];
    const declaradas = Object.keys(
      lerManifestoDaSkill(NOS[proximo.no].skill).entrada.properties,
    );
    const carregados = Object.keys(anterior.saida).filter((chave) => declaradas.includes(chave));
    assert.ok(
      carregados.length >= 1,
      `nada de "${anterior.no}" alimenta "${proximo.no}": a cadeia está partida`,
    );
    for (const chave of carregados) {
      assert.deepEqual(
        proximo.entrada[chave],
        anterior.saida[chave],
        `"${chave}" chega de "${anterior.no}" a "${proximo.no}" sem alteração`,
      );
    }
  }

  // 3. O roteamento de cada portão é uma aresta declarada, nunca escolha livre.
  const arestaDe = (de, condicao) =>
    doc.arestas.find((a) => a.de === de && a.condicao === condicao);
  const redTeam = passos.find((passo) => passo.no === 'red-team');
  assert.equal(redTeam.saida.resultado, 'passou', 'no fixture a tese sobrevive ao red team');
  assert.ok(arestaDe('red-team', 'sobrevive'), 'passou no red team segue pela aresta "sobrevive"');

  // 4. Nenhuma aresta de saída de `decisao` é seguida sem resposta humana.
  const decisao = passos.at(-1);
  const manifestoDecisao = lerManifestoDaSkill('escalar-decisao');
  const pergunta = fixture.pergunta_de_alocacao;

  const semResposta = fixture.decisao_sem_resposta_humana;
  assert.deepEqual(
    semResposta.entrada.perguntas_respondidas,
    [],
    'a variante sem resposta humana chega ao nó com a fila de perguntas vazia',
  );
  assert.deepEqual(
    validarContraSchema(semResposta.entrada, manifestoDecisao.entrada),
    [],
    'entrar em `decisao` sem resposta humana é legal — a sessão pausa, não falha',
  );
  const erros = validarContraSchema(semResposta.saida_tentada, manifestoDecisao.saida);
  assert.ok(
    erros.length > 0 && erros.some((erro) => /decisao_humana/.test(erro.mensagem)),
    `um resultado sem a decisão humana registrada precisa ser recusado pelo contrato: ${JSON.stringify(erros)}`,
  );

  // 5. Com a resposta registrada, o resultado é transcrição literal dela.
  const registrada = decisao.entrada.perguntas_respondidas.find((p) => p.id === pergunta.id);
  assert.ok(registrada, 'a resposta de alocação chega em entrada.perguntas_respondidas');
  assert.equal(decisao.saida.decisao_humana.pergunta_id, pergunta.id);
  assert.equal(
    decisao.saida.decisao_humana.resposta_literal,
    registrada.resposta,
    'o resultado cita a resposta humana literalmente, sem interpretar',
  );
  assert.ok(
    arestaDe('decisao', fixture.aresta_esperada),
    `a aresta "${fixture.aresta_esperada}" precisa existir saindo de "decisao"`,
  );
});

test('FR7 — registrar-travessia grava métricas de processo, nunca resultado financeiro', () => {
  const manifesto = lerManifesto('registrar-travessia.json');
  const metricas = manifesto.saida.properties.metricas_processo;

  assert.ok(manifesto.saida.required.includes('metricas_processo'));
  for (const campo of [
    'red_team_executado',
    'fracao_premissas_com_fonte',
    'decisao_humana_id',
    'desfecho_final',
  ]) {
    assert.ok(metricas.required.includes(campo), `metricas_processo precisa exigir "${campo}"`);
  }
  assert.equal(metricas.properties.red_team_executado.type, 'boolean');
  assert.equal(metricas.properties.fracao_premissas_com_fonte.minimum, 0);
  assert.equal(metricas.properties.fracao_premissas_com_fonte.maximum, 1);
  assert.deepEqual(
    metricas.properties.decisao_humana_id.type,
    ['string', 'null'],
    'nulo só quando a travessia nunca chegou a decisao',
  );
  assert.deepEqual(metricas.properties.desfecho_final.enum, ['monitorando', 'arquivado']);

  // D14: "P&L é validação lenta de longo prazo, nunca métrica de rodada".
  const serializado = JSON.stringify(manifesto.saida);
  for (const proibido of ['p_l', 'pnl', 'lucro', 'retorno_realizado', 'resultado_financeiro']) {
    assert.ok(
      !serializado.includes(`"${proibido}"`),
      `a saída não pode carregar métrica de resultado financeiro ("${proibido}")`,
    );
  }
});

test('AT12 — o CLI do validador aprova o bundle e reprova um hash adulterado', () => {
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
  const alvo = path.join(copia, 'skills', 'derrubar-tese.json');
  const manifesto = JSON.parse(readFileSync(alvo, 'utf8'));
  manifesto.hash = `sha256:${'0'.repeat(64)}`;
  writeFileSync(alvo, `${JSON.stringify(manifesto, null, 2)}\n`);

  const ruim = rodarCli(copia);
  assert.notEqual(ruim.status, 0, 'hash adulterado precisa sair com código diferente de 0');
  assert.ok(
    `${ruim.stdout}${ruim.stderr}`.includes('red-team'),
    `o relatório precisa nomear o nó divergente:\n${ruim.stdout}${ruim.stderr}`,
  );
});
