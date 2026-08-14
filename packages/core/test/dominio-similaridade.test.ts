/**
 * Testes de aceite da similaridade textual (t113, AT1–AT2).
 *
 * A base de precedentes precisa de UM número comparável entre duas perguntas, e
 * a v1 escolhe o mais transparente que existe: Jaccard sobre tokens do texto
 * normalizado. Não há embeddings na pilha decidida (D17), e o contrato do escore
 * (`[0, 1]`) é justamente o que deixa trocar a heurística depois sem mexer na
 * rota.
 *
 * Duas fronteiras deliberadas, provadas aqui:
 *
 * - **Normalizar não é interpretar.** Minúsculas, pontuação fora, espaço
 *   colapsado, `trim` — e nada de stemming ou remoção de acento: "migração" e
 *   "migracao" são palavras diferentes para esta v1, e fingir o contrário
 *   esconderia a heurística atrás de mágica.
 * - **Token curto não pontua.** Preposição e artigo do português ("a", "de",
 *   "no") apareceriam em toda pergunta e empurrariam o escore de qualquer par
 *   para longe de zero; o corte em 3 caracteres é o que mantém o número
 *   informativo.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloSimilaridade from '../src/dominio/similaridade.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

let cache: typeof ModuloSimilaridade | null = null;

/** Carrega o módulo sob demanda: no vermelho inicial a falha NOMEIA o artefato. */
async function carregarSimilaridade(): Promise<typeof ModuloSimilaridade> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'dominio', 'similaridade.ts');
  assert.ok(
    existsSync(caminho),
    'artefato ainda não existe: packages/core/src/dominio/similaridade.ts',
  );
  cache ??= (await import(
    new URL('../src/dominio/similaridade.ts', import.meta.url).href
  )) as typeof ModuloSimilaridade;
  return cache;
}

test('AT1 — normalizarTexto baixa a caixa, tira pontuação, colapsa espaço e apara', async () => {
  const { normalizarTexto } = await carregarSimilaridade();

  assert.equal(normalizarTexto('  Unifico O Trio, de tabelas?!  '), 'unifico o trio de tabelas');

  assert.equal(
    normalizarTexto('Renumerar   a\n migração  para 0003?'),
    'renumerar a migração para 0003',
    'o acento SOBREVIVE: normalizar não é interpretar',
  );
  assert.equal(normalizarTexto(''), '');
});

test('AT2 — similaridade é 1 no idêntico, 0 no disjunto e fica no meio no parcial', async () => {
  const { similaridade } = await carregarSimilaridade();

  assert.equal(
    similaridade('Unifico o trio de tabelas?', '  UNIFICO O TRIO DE TABELAS  '),
    1,
    'mesmo texto depois de normalizar é o mesmo texto',
  );

  assert.equal(
    similaridade('Renumerar a migração para 0003?', 'Qual engine adapter usar no despacho?'),
    0,
    'sem token em comum, o escore é zero — e não um número pequeno qualquer',
  );

  const parcial = similaridade('renumerar a migração para 0003', 'renumerar a migração para 0004');
  assert.ok(parcial > 0 && parcial < 1, `esperava 0 < escore < 1, veio ${parcial}`);

  // O escore mora no intervalo fechado [0, 1] — é o contrato que deixa trocar a
  // heurística depois sem mexer no contrato da rota.
  for (const par of [
    ['', ''],
    ['a de no', 'a de no'],
    ['tudo diferente aqui', ''],
  ] as const) {
    const escore = similaridade(par[0], par[1]);
    assert.ok(escore >= 0 && escore <= 1, `escore fora de [0, 1]: ${escore}`);
  }
});
