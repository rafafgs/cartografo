/**
 * Testes de aceite do validador de grafo portado para TypeScript (t101, FR2).
 *
 * O control plane não pode importar `scripts/validar-grafo.mjs`: o script fica
 * fora da árvore publicável do pacote (`files` em `packages/core/package.json`).
 * Por isso as duas funções foram portadas — e por isso este arquivo é o único
 * lugar do pacote que importa o validador de referência: para travar paridade
 * entre os dois, fixture a fixture, em vez de confiar que a cópia continua fiel.
 *
 * Convenção do repo (mesma de `migrate.test.ts`): o módulo sob teste é
 * importado sob demanda, depois de um `existsSync` explícito, para que o
 * vermelho inicial diga qual artefato falta em vez de estourar um
 * ERR_MODULE_NOT_FOUND cru.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import type * as ModuloGrafo from '../src/dominio/grafo.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const DIR_EXEMPLOS = path.join(RAIZ_REPO, 'schema', 'exemplos');
const VALIDADOR_DE_REFERENCIA = path.join(RAIZ_REPO, 'scripts', 'validar-grafo.mjs');

/** Forma do validador de referência, que é JavaScript sem tipos declarados. */
interface ValidadorDeReferencia {
  validarEstrutura: (doc: unknown) => { valido: boolean; erros: unknown[] };
  validarSoundness: (doc: unknown) => { valido: boolean; violacoes: unknown[] };
}

let cacheGrafo: typeof ModuloGrafo | null = null;
let cacheReferencia: ValidadorDeReferencia | null = null;

async function carregarDominioGrafo(): Promise<typeof ModuloGrafo> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'dominio', 'grafo.ts');
  assert.ok(existsSync(caminho), 'artefato ainda não existe: packages/core/src/dominio/grafo.ts');
  cacheGrafo ??= (await import(
    new URL('../src/dominio/grafo.ts', import.meta.url).href
  )) as typeof ModuloGrafo;
  return cacheGrafo;
}

async function carregarReferencia(): Promise<ValidadorDeReferencia> {
  assert.ok(existsSync(VALIDADOR_DE_REFERENCIA), 'validador de referência sumiu do repositório');
  cacheReferencia ??= (await import(
    pathToFileURL(VALIDADOR_DE_REFERENCIA).href
  )) as ValidadorDeReferencia;
  return cacheReferencia;
}

/** Todos os fixtures do t96, em ordem estável. */
function exemplos(): string[] {
  return readdirSync(DIR_EXEMPLOS)
    .filter((nome) => nome.endsWith('.json'))
    .sort();
}

function lerExemplo(nome: string): unknown {
  return JSON.parse(readFileSync(path.join(DIR_EXEMPLOS, nome), 'utf8'));
}

test('AT1 — o módulo TS concorda com scripts/validar-grafo.mjs em todos os fixtures', async () => {
  const portado = await carregarDominioGrafo();
  const referencia = await carregarReferencia();

  const arquivos = exemplos();
  assert.ok(arquivos.length >= 6, 'os fixtures do t96 precisam estar no lugar');

  for (const arquivo of arquivos) {
    const doc = lerExemplo(arquivo);

    assert.deepEqual(
      portado.validarEstrutura(doc),
      referencia.validarEstrutura(doc),
      `estrutura divergiu em ${arquivo}`,
    );
    assert.deepEqual(
      portado.validarSoundness(doc),
      referencia.validarSoundness(doc),
      `soundness divergiu em ${arquivo}`,
    );
  }
});

test('AT2 — os quatro contraexemplos falham com a regra esperada, uma cada', async () => {
  const { validarSoundness, REGRAS } = await carregarDominioGrafo();

  const esperado: Array<[string, { regra: string; alvo: unknown }]> = [
    ['grafo-invalido-no-inalcancavel.json', { regra: REGRAS.ALCANCAVEL, alvo: 'revisar_lote' }],
    ['grafo-invalido-sem-terminacao.json', { regra: REGRAS.TERMINA, alvo: 'reprocessar_item' }],
    [
      'grafo-invalido-aresta-sem-condicao.json',
      {
        regra: REGRAS.ARESTA_COM_CONDICAO,
        alvo: { de: 'coletar_fontes', para: 'resumir_fontes' },
      },
    ],
    ['grafo-invalido-no-sem-contrato.json', { regra: REGRAS.NO_COM_CONTRATO, alvo: 'publicar_texto' }],
  ];

  for (const [arquivo, violacao] of esperado) {
    const relatorio = validarSoundness(lerExemplo(arquivo));
    assert.equal(relatorio.valido, false, `${arquivo} precisa continuar reprovando`);
    // Cada contraexemplo do t96 viola exatamente UMA regra — é o que torna cada
    // regra demonstrável isolada (docs/spec/grafo.md §6).
    assert.deepEqual(relatorio.violacoes, [violacao], `regra errada em ${arquivo}`);
  }
});

test('AT2 — os dois grafos válidos continuam passando nas duas validações', async () => {
  const { validarGrafo } = await carregarDominioGrafo();

  for (const arquivo of ['grafo-valido-minimo.json', 'grafo-valido-flowpilot.json']) {
    const relatorio = validarGrafo(lerExemplo(arquivo));
    assert.equal(relatorio.valido, true, `${arquivo} precisa continuar válido`);
    assert.deepEqual(relatorio.estrutura.erros, []);
    assert.deepEqual(relatorio.soundness.violacoes, []);
  }
});
