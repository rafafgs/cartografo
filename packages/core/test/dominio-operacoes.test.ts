/**
 * Testes de aceite do vocabulário de operações semânticas (t101, FR4).
 *
 * D15 pede "operações semânticas tipadas + inversas": o diff de uma proposta é
 * uma lista de operações sobre o documento, não um diff de linha. Aqui se prova
 * a forma (validação estrutural, inversa obrigatória) e a aplicação (ordem,
 * cópia profunda, alvo exato).
 *
 * O que NÃO se prova aqui: que o resultado é sound. Isso é papel exclusivo do
 * portão do FR8, e é deliberado — uma operação estruturalmente correta pode
 * produzir um grafo quebrado, e é justamente esse caso que os testes de
 * proposta (AT14–AT17) exercitam.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type { DocumentoGrafo, NoGrafo } from '../src/dominio/grafo.ts';
import type * as ModuloOperacoes from '../src/dominio/operacoes.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const EXEMPLO_MINIMO = path.join(RAIZ_REPO, 'schema', 'exemplos', 'grafo-valido-minimo.json');

let cacheOperacoes: typeof ModuloOperacoes | null = null;

async function carregarOperacoes(): Promise<typeof ModuloOperacoes> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'dominio', 'operacoes.ts');
  assert.ok(existsSync(caminho), 'artefato ainda não existe: packages/core/src/dominio/operacoes.ts');
  cacheOperacoes ??= (await import(
    new URL('../src/dominio/operacoes.ts', import.meta.url).href
  )) as typeof ModuloOperacoes;
  return cacheOperacoes;
}

function grafoMinimo(): DocumentoGrafo {
  return JSON.parse(readFileSync(EXEMPLO_MINIMO, 'utf8')) as DocumentoGrafo;
}

function exigirNo(doc: DocumentoGrafo, id: string): NoGrafo {
  const no = doc.nos.find((candidato) => candidato.id === id);
  if (no === undefined) throw new Error(`fixture mudou: o nó "${id}" sumiu`);
  return no;
}

/** Nó novo completo: papel, tipo, skill pinada e contrato com verificação. */
const NO_NOVO: NoGrafo = {
  id: 'checar_fatos',
  papel: 'revisor',
  tipo_no: 'trabalho',
  descricao: 'Confere cada afirmação da nota contra a fonte citada.',
  skill_ref: {
    id: 'cartografo/checar-fatos',
    versao: '1.0.0',
    hash: `sha256:${'0'.repeat(64)}`,
  },
  contrato: {
    entrada_schema: {
      type: 'object',
      required: ['texto'],
      properties: { texto: { type: 'string', minLength: 1 } },
    },
    saida_schema: {
      type: 'object',
      required: ['aprovado'],
      properties: { aprovado: { type: 'boolean' } },
    },
    verificacoes: [
      {
        tipo: 'deterministico',
        comando: 'test -s checagem.md',
        descricao: 'O relatório de checagem existe e não está vazio.',
      },
    ],
  },
};

test('AT3 — adicionar_no + adicionar_aresta acrescentam o alvo sem mutar a entrada', async () => {
  const { aplicarOperacoes } = await carregarOperacoes();

  const entrada = grafoMinimo();
  const operacoes: ModuloOperacoes.Operacao[] = [
    {
      tipo: 'adicionar_no',
      no: structuredClone(NO_NOVO),
      inversa: { tipo: 'remover_no', no_id: NO_NOVO.id },
    },
    {
      tipo: 'adicionar_aresta',
      aresta: { de: 'redigir', para: NO_NOVO.id, condicao: 'sempre' },
      inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: NO_NOVO.id } },
    },
  ];

  const resultado = aplicarOperacoes(entrada, operacoes);

  assert.ok(
    resultado.nos.some((no) => no.id === NO_NOVO.id),
    'o nó novo precisa estar no documento resultante',
  );
  assert.ok(
    resultado.arestas.some((aresta) => aresta.de === 'redigir' && aresta.para === NO_NOVO.id),
    'a aresta nova precisa estar no documento resultante',
  );

  assert.notEqual(resultado, entrada, 'o resultado precisa ser um documento novo');
  assert.deepEqual(entrada, grafoMinimo(), 'aplicarOperacoes não pode mutar o documento de entrada');
});

test('AT4 — remover_no e remover_aresta removem exatamente o alvo', async () => {
  const { aplicarOperacoes } = await carregarOperacoes();

  const entrada = grafoMinimo();
  const revisar = exigirNo(entrada, 'revisar');
  const arestaOriginal = entrada.arestas[0];

  // O resultado é deliberadamente NÃO-sound (nos_finais aponta para um nó que
  // deixou de existir): aplicar não valida — quem valida é o portão do FR8.
  const resultado = aplicarOperacoes(entrada, [
    {
      tipo: 'remover_aresta',
      aresta: { de: 'redigir', para: 'revisar' },
      inversa: { tipo: 'adicionar_aresta', aresta: structuredClone(arestaOriginal) },
    },
    {
      tipo: 'remover_no',
      no_id: 'revisar',
      inversa: { tipo: 'adicionar_no', no: structuredClone(revisar) },
    },
  ]);

  assert.deepEqual(
    resultado.nos.map((no) => no.id),
    ['redigir'],
    'só o nó alvo pode sair',
  );
  assert.deepEqual(resultado.arestas, [], 'só a aresta alvo pode sair');
  assert.deepEqual(entrada, grafoMinimo(), 'aplicarOperacoes não pode mutar o documento de entrada');
});

test('AT4 — alterar_campo_no troca o campo declarado e nada mais', async () => {
  const { aplicarOperacoes } = await carregarOperacoes();

  const entrada = grafoMinimo();
  assert.equal(exigirNo(entrada, 'revisar').papel, 'revisor');

  const resultado = aplicarOperacoes(entrada, [
    {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'papel',
      de: 'revisor',
      para: 'red-team',
      inversa: {
        tipo: 'alterar_campo_no',
        no_id: 'revisar',
        campo: 'papel',
        de: 'red-team',
        para: 'revisor',
      },
    },
  ]);

  assert.equal(exigirNo(resultado, 'revisar').papel, 'red-team');
  assert.deepEqual(
    resultado.nos.map((no) => no.id),
    entrada.nos.map((no) => no.id),
    'alterar campo não mexe na topologia',
  );
  assert.deepEqual(entrada, grafoMinimo(), 'aplicarOperacoes não pode mutar o documento de entrada');
});

test('AT5 — tipo desconhecido, inversa ausente e inversa incompatível reprovam com erro identificável', async () => {
  const { validarOperacao } = await carregarOperacoes();

  const valida = validarOperacao({
    tipo: 'adicionar_no',
    no: structuredClone(NO_NOVO),
    inversa: { tipo: 'remover_no', no_id: NO_NOVO.id },
  });
  assert.deepEqual(valida, { valido: true, erros: [] }, 'a operação bem formada precisa passar');

  const desconhecida = validarOperacao({
    tipo: 'renomear_no',
    no_id: 'revisar',
    inversa: { tipo: 'renomear_no', no_id: 'revisar' },
  });
  assert.equal(desconhecida.valido, false);
  assert.ok(
    desconhecida.erros.some((erro) => erro.codigo === 'tipo_desconhecido'),
    `esperado tipo_desconhecido, veio ${JSON.stringify(desconhecida.erros)}`,
  );

  const semInversa = validarOperacao({ tipo: 'adicionar_no', no: structuredClone(NO_NOVO) });
  assert.equal(semInversa.valido, false);
  assert.ok(
    semInversa.erros.some((erro) => erro.codigo === 'inversa_ausente'),
    `esperado inversa_ausente, veio ${JSON.stringify(semInversa.erros)}`,
  );

  const inversaErrada = validarOperacao({
    tipo: 'adicionar_no',
    no: structuredClone(NO_NOVO),
    inversa: { tipo: 'remover_aresta', aresta: { de: 'redigir', para: 'revisar' } },
  });
  assert.equal(inversaErrada.valido, false);
  assert.ok(
    inversaErrada.erros.some((erro) => erro.codigo === 'inversa_incompativel'),
    `esperado inversa_incompativel, veio ${JSON.stringify(inversaErrada.erros)}`,
  );

  const inversaDeOutroAlvo = validarOperacao({
    tipo: 'adicionar_no',
    no: structuredClone(NO_NOVO),
    inversa: { tipo: 'remover_no', no_id: 'outro_no' },
  });
  assert.equal(inversaDeOutroAlvo.valido, false, 'a inversa precisa desfazer O MESMO alvo');
  assert.ok(inversaDeOutroAlvo.erros.some((erro) => erro.codigo === 'inversa_incompativel'));

  const campoNaoAlteravel = validarOperacao({
    tipo: 'alterar_campo_no',
    no_id: 'revisar',
    campo: 'id',
    de: 'revisar',
    para: 'revisar_tudo',
    inversa: {
      tipo: 'alterar_campo_no',
      no_id: 'revisar',
      campo: 'id',
      de: 'revisar_tudo',
      para: 'revisar',
    },
  });
  assert.equal(campoNaoAlteravel.valido, false, 'trocar id é operação própria, não troca de campo');
  assert.ok(campoNaoAlteravel.erros.some((erro) => erro.codigo === 'campo_nao_alteravel'));
});

test('AT5 — aplicar operação sobre alvo inexistente estoura em vez de virar no-op silencioso', async () => {
  const { aplicarOperacoes, ErroDeAplicacao } = await carregarOperacoes();

  assert.throws(
    () =>
      aplicarOperacoes(grafoMinimo(), [
        {
          tipo: 'remover_no',
          no_id: 'nao_existe',
          inversa: { tipo: 'adicionar_no', no: structuredClone(NO_NOVO) },
        },
      ]),
    (erro: unknown) => erro instanceof ErroDeAplicacao && erro.codigo === 'no_inexistente',
  );

  assert.throws(
    () =>
      aplicarOperacoes(grafoMinimo(), [
        {
          tipo: 'adicionar_no',
          no: structuredClone(exigirNo(grafoMinimo(), 'redigir')),
          inversa: { tipo: 'remover_no', no_id: 'redigir' },
        },
      ]),
    (erro: unknown) => erro instanceof ErroDeAplicacao && erro.codigo === 'no_duplicado',
  );
});
