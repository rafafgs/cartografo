/**
 * Testes de aceite da t96 — formato do documento de grafo.
 *
 * Cobrem os três artefatos da ticket: o JSON Schema (`schema/grafo.schema.json`),
 * o validador de referência (`scripts/validar-grafo.mjs`) e os seis fixtures em
 * `schema/exemplos/`. Zero dependências: só `node:test`, `node:assert`, `node:fs`
 * e `node:path` (FR9).
 *
 * Rodar: `node --test tests/`
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const RAIZ = path.resolve(import.meta.dirname, '..');
const CAMINHO_SCHEMA = path.join(RAIZ, 'schema', 'grafo.schema.json');
const CAMINHO_VALIDADOR = path.join(RAIZ, 'scripts', 'validar-grafo.mjs');
const DIR_EXEMPLOS = path.join(RAIZ, 'schema', 'exemplos');

const CHAVES_TOPO = [
  'classe',
  'linhagem',
  'metadata',
  'nos',
  'arestas',
  'no_inicial',
  'nos_finais',
];

/** Lê um JSON do repositório, falhando com o caminho relativo quando ele não existe. */
function lerJson(caminho) {
  assert.ok(
    existsSync(caminho),
    `artefato ainda não existe: ${path.relative(RAIZ, caminho)}`,
  );
  return JSON.parse(readFileSync(caminho, 'utf8'));
}

/** Lê um fixture de `schema/exemplos/` pelo nome do arquivo. */
function lerExemplo(nome) {
  return lerJson(path.join(DIR_EXEMPLOS, nome));
}

let moduloValidador = null;

/**
 * Importa o validador de referência sob demanda.
 *
 * A checagem de existência vem antes do `import()` de propósito: no vermelho
 * inicial o teste falha dizendo qual artefato falta, e não com um
 * ERR_MODULE_NOT_FOUND cru.
 */
async function carregarValidador() {
  assert.ok(
    existsSync(CAMINHO_VALIDADOR),
    `artefato ainda não existe: ${path.relative(RAIZ, CAMINHO_VALIDADOR)}`,
  );
  moduloValidador ??= await import(
    new URL('../scripts/validar-grafo.mjs', import.meta.url)
  );
  return moduloValidador;
}

test('AT1 — o schema é JSON válido, declara draft 2020-12, $id e as sete chaves de topo', () => {
  const schema = lerJson(CAMINHO_SCHEMA);

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(typeof schema.$id, 'string');
  assert.ok(schema.$id.length > 0, '$id precisa ser uma string não vazia');
  assert.ok(schema.$id.includes('1.0.0'), '$id precisa versionar o schema (1.0.0)');

  assert.equal(typeof schema.properties, 'object');
  for (const chave of CHAVES_TOPO) {
    assert.ok(
      Object.hasOwn(schema.properties, chave),
      `properties precisa declarar "${chave}"`,
    );
    assert.ok(
      schema.required.includes(chave),
      `required precisa listar "${chave}"`,
    );
  }
});

test('AT2 — o exemplo mínimo passa em validarEstrutura e validarSoundness', async () => {
  const { validarEstrutura, validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-valido-minimo.json');

  const estrutura = validarEstrutura(doc);
  assert.deepEqual(estrutura.erros, []);
  assert.equal(estrutura.valido, true);

  const soundness = validarSoundness(doc);
  assert.deepEqual(soundness.violacoes, []);
  assert.equal(soundness.valido, true);
});

/*
 * Tabela fixa do flowpilot, copiada à mão de
 * `~/flowpilot/app/services/flow/state_machine.py` (ACTIVITY_STATES, linhas
 * 153-161; ALLOWED_TRANSITIONS, linhas 91-104). O teste NÃO lê o arquivo do
 * flowpilot — D17: referência de comportamento, sem dependência de código.
 *
 * As transições abaixo são as de ALLOWED_TRANSITIONS colapsando os estados de
 * fila (`to_develop`, `to_integrate`, ...), que são plumbing de escalonamento
 * do controller e não viram nó. Colapsadas, sobram CINCO pares atividade →
 * atividade. A ticket diz "6 arestas" nos critérios de aceite; a sexta seria
 * `deploying -> done`, mas `done` não é estado de atividade e FR7 fixa
 * `nos_finais: ["implantar"]` — logo não há nó de destino para ela.
 */
const NO_POR_ESTADO_FLOWPILOT = {
  refining: 'refinar',
  developing: 'desenvolver',
  integrating: 'integrar',
  testing: 'testar',
  deploying: 'implantar',
};

const PAPEL_POR_NO_FLOWPILOT = {
  refinar: 'arquiteto',
  desenvolver: 'desenvolvedor',
  integrar: 'integrador',
  testar: 'tester',
  implantar: 'deployer',
};

const TRANSICOES_ATIVIDADE_FLOWPILOT = [
  ['refining', 'developing'],
  ['developing', 'integrating'],
  ['integrating', 'testing'],
  ['testing', 'deploying'],
  ['testing', 'developing'], // ciclo de retrabalho (state_machine.py:100)
];

test('AT3 — o grafo do flowpilot é sound e corresponde 1:1 aos estados de atividade', async () => {
  const { validarEstrutura, validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-valido-flowpilot.json');

  assert.deepEqual(validarEstrutura(doc).erros, []);
  assert.deepEqual(validarSoundness(doc).violacoes, []);

  const idsEsperados = Object.values(NO_POR_ESTADO_FLOWPILOT).sort();
  assert.deepEqual(doc.nos.map((no) => no.id).sort(), idsEsperados);

  for (const no of doc.nos) {
    assert.equal(
      no.papel,
      PAPEL_POR_NO_FLOWPILOT[no.id],
      `papel esperado para o nó "${no.id}"`,
    );
  }

  const arestasEsperadas = TRANSICOES_ATIVIDADE_FLOWPILOT
    .map(([de, para]) => `${NO_POR_ESTADO_FLOWPILOT[de]}>${NO_POR_ESTADO_FLOWPILOT[para]}`)
    .sort();
  const arestasDoDoc = doc.arestas.map((a) => `${a.de}>${a.para}`).sort();
  assert.deepEqual(arestasDoDoc, arestasEsperadas);

  assert.ok(
    arestasDoDoc.includes('testar>desenvolver'),
    'o ciclo de retrabalho testar → desenvolver precisa existir',
  );
  assert.equal(doc.no_inicial, 'refinar');
  assert.deepEqual(doc.nos_finais, ['implantar']);
});

test('AT4 — nó inalcançável produz exatamente uma violação "alcançável"', async () => {
  const { validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-invalido-no-inalcancavel.json');

  const { valido, violacoes } = validarSoundness(doc);
  assert.equal(valido, false);
  assert.equal(violacoes.length, 1);
  assert.equal(violacoes[0].regra, 'alcançável');
  assert.ok(
    doc.nos.some((no) => no.id === violacoes[0].alvo),
    'o alvo precisa ser o id de um nó do documento',
  );
  assert.ok(
    !doc.arestas.some((a) => a.para === violacoes[0].alvo),
    'o alvo precisa ser o nó órfão (sem aresta de entrada)',
  );
});

test('AT5 — nó preso em ciclo sem saída produz uma violação "termina"', async () => {
  const { validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-invalido-sem-terminacao.json');

  const { valido, violacoes } = validarSoundness(doc);
  assert.equal(valido, false);
  assert.equal(violacoes.length, 1);
  assert.equal(violacoes[0].regra, 'termina');

  const preso = violacoes[0].alvo;
  assert.ok(
    doc.nos.some((no) => no.id === preso),
    'o alvo precisa ser o id de um nó do documento',
  );
  assert.ok(
    !doc.nos_finais.includes(preso),
    'um nó final nunca pode ser o alvo da regra "termina"',
  );
  assert.ok(
    doc.arestas.some((a) => a.de === preso && a.para === preso),
    'o nó preso é o do ciclo sem saída',
  );
});

test('AT6 — aresta sem condição produz uma violação "aresta_com_condicao"', async () => {
  const { validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-invalido-aresta-sem-condicao.json');

  const { valido, violacoes } = validarSoundness(doc);
  assert.equal(valido, false);
  assert.equal(violacoes.length, 1);

  const semCondicao = doc.arestas.find(
    (a) => typeof a.condicao !== 'string' || a.condicao.trim() === '',
  );
  assert.deepEqual(violacoes[0], {
    regra: 'aresta_com_condicao',
    alvo: { de: semCondicao.de, para: semCondicao.para },
  });
});

test('AT7 — nó sem contrato produz uma violação "no_com_contrato"', async () => {
  const { validarSoundness } = await carregarValidador();
  const doc = lerExemplo('grafo-invalido-no-sem-contrato.json');

  const { valido, violacoes } = validarSoundness(doc);
  assert.equal(valido, false);
  assert.equal(violacoes.length, 1);

  const semContrato = doc.nos.find(
    (no) => no.contrato == null || no.skill_ref == null,
  );
  assert.deepEqual(violacoes[0], {
    regra: 'no_com_contrato',
    alvo: semContrato.id,
  });
});

test('AT8 — validarEstrutura rejeita id duplicado e aresta apontando para nó inexistente', async () => {
  const { validarEstrutura } = await carregarValidador();
  const base = lerExemplo('grafo-valido-minimo.json');

  const comIdDuplicado = structuredClone(base);
  comIdDuplicado.nos.push(structuredClone(comIdDuplicado.nos[0]));
  const duplicado = validarEstrutura(comIdDuplicado);
  assert.equal(duplicado.valido, false);
  const erroDuplicado = duplicado.erros.find((e) => e.codigo === 'id_no_duplicado');
  assert.ok(erroDuplicado, 'erro identificável esperado: id_no_duplicado');
  assert.equal(erroDuplicado.alvo, base.nos[0].id);
  assert.ok(
    erroDuplicado.mensagem.includes(base.nos[0].id),
    'a mensagem precisa nomear o id duplicado',
  );

  const comArestaSolta = structuredClone(base);
  comArestaSolta.arestas[0].para = 'no_que_nao_existe';
  const solta = validarEstrutura(comArestaSolta);
  assert.equal(solta.valido, false);
  const erroSolto = solta.erros.find((e) => e.codigo === 'aresta_no_inexistente');
  assert.ok(erroSolto, 'erro identificável esperado: aresta_no_inexistente');
  assert.ok(
    erroSolto.mensagem.includes('no_que_nao_existe'),
    'a mensagem precisa nomear o nó inexistente',
  );
});
