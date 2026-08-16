/**
 * Testes de aceite das políticas de custo (t114, AT5–AT7).
 *
 * As duas políticas dizem coisas diferentes. `teto` é absoluta ("este nó passou
 * de N tokens") e só existe quando alguém declara o teto; `tier` é relativa
 * ("este nó custa muito mais que os vizinhos da mesma versão") e exige base
 * amostral para não chamar de outlier o único nó medido.
 *
 * AT7 guarda a fronteira desta ficha: nem o documento de grafo nem o manifesto
 * de skill têm campo de custo ou tier hoje, e abrir esses schemas é proibido
 * pelo AC1. Logo, toda candidata é advisória — uma recomendação anexada à
 * `description` do nó, com os números de verdade em `evidencia`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloPolitica from '../src/politica.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

let cache: typeof ModuloPolitica | null = null;

async function carregar(): Promise<typeof ModuloPolitica> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'politica.ts')),
    'artefato ainda não existe: packages/topografo-custo/src/politica.ts',
  );
  cache ??= (await import(
    new URL('../src/politica.ts', import.meta.url).href
  )) as typeof ModuloPolitica;
  return cache;
}

/** Uma linha de custo já identificada (versão e nó não nulos). */
function linha(
  noId: string,
  tokens: number,
  parcial: Partial<ModuloPolitica.LinhaDeCustoIdentificada> = {},
): ModuloPolitica.LinhaDeCustoIdentificada {
  return {
    grafo_versao_id: 'sha256:v1',
    no_id: noId,
    tokens_total: tokens,
    sessoes_com_uso: 1,
    sessoes_sem_uso: 0,
    tempo_total_segundos: 10,
    sessoes_com_tempo: 1,
    sessoes_sem_tempo: 0,
    ...parcial,
  };
}

test('AT5 — teto gera candidata quando tokens_total excede, e nada sem teto declarado', async () => {
  const { avaliarPoliticas } = await carregar();

  const comTeto = avaliarPoliticas([linha('redigir', 5000)], { tetoTokens: 1000 });
  assert.equal(comTeto.length, 1);
  assert.equal(comTeto[0].tipo, 'teto');
  assert.equal(comTeto[0].no_id, 'redigir');
  assert.equal(comTeto[0].evidencia.lente, 'custo');
  assert.equal(comTeto[0].evidencia.teto_excedido, 'tokens');
  assert.equal(comTeto[0].evidencia.tokens_total, 5000);
  assert.equal(comTeto[0].metrica_esperada.teto_ou_fator, 1000);

  const semTeto = avaliarPoliticas([linha('redigir', 5000)], {});
  assert.deepEqual(semTeto, [], 'sem teto declarado não há o que exceder');

  const abaixo = avaliarPoliticas([linha('redigir', 999)], { tetoTokens: 1000 });
  assert.deepEqual(abaixo, [], 'excede é estritamente maior que o teto');
});

test('AT6 — tier gera candidata sobre a mediana da versão, e só com base amostral', async () => {
  const { avaliarPoliticas } = await carregar();

  const versao = [linha('a', 100), linha('b', 100), linha('c', 1000)];

  // Mediana de [100, 100, 1000] é 100; o fator 3 pede 300, e só "c" passa.
  const comBase = avaliarPoliticas(versao, { tierFator: 3, tierMinimoNos: 3 });
  assert.equal(comBase.length, 1);
  assert.equal(comBase[0].tipo, 'tier');
  assert.equal(comBase[0].no_id, 'c');
  assert.equal(comBase[0].evidencia.teto_excedido, null, 'tier não é violação de teto');
  assert.equal(comBase[0].metrica_esperada.teto_ou_fator, 3);

  const semBase = avaliarPoliticas(versao, { tierFator: 3, tierMinimoNos: 4 });
  assert.deepEqual(semBase, [], 'com menos nós medidos que o mínimo não há outlier a declarar');

  // Um nó sem nenhuma sessão com uso não é "nó com dado": não conta para o
  // mínimo nem entra na mediana.
  const comUmNoCego = avaliarPoliticas(
    [linha('a', 100), linha('b', 100), linha('c', 0, { sessoes_com_uso: 0, sessoes_sem_uso: 2 })],
    { tierFator: 3, tierMinimoNos: 3 },
  );
  assert.deepEqual(comUmNoCego, [], 'nó sem uso reportado não vira base amostral');
});

test('AT7 — toda candidata carrega um único alterar_campo_no sobre description, com inversa trocada', async () => {
  const { avaliarPoliticas } = await carregar();

  const candidatas = avaliarPoliticas([linha('a', 100), linha('b', 100), linha('c', 9000)], {
    tetoTokens: 1000,
    tierFator: 3,
    tierMinimoNos: 3,
    descricaoAtual: (grafoVersaoId, noId) => `descrição de ${noId} em ${grafoVersaoId}`,
  });

  assert.ok(
    candidatas.some((candidata) => candidata.tipo === 'teto'),
    'o cenário precisa produzir os dois tipos para a regra valer para os dois',
  );
  assert.ok(candidatas.some((candidata) => candidata.tipo === 'tier'));

  for (const candidata of candidatas) {
    assert.equal(candidata.operacoes.length, 1, 'uma recomendação é uma operação');

    const operacao = candidata.operacoes[0];
    assert.equal(operacao.tipo, 'alterar_campo_no');
    assert.equal(operacao.campo, 'description');
    assert.equal(operacao.no_id, candidata.no_id);
    assert.equal(operacao.de, `descrição de ${candidata.no_id} em sha256:v1`);
    assert.notEqual(operacao.para, operacao.de, 'a recomendação precisa mudar alguma coisa');
    assert.ok(
      String(operacao.para).startsWith(String(operacao.de)),
      'a recomendação é anexada à descrição atual, não a substitui',
    );

    assert.equal(operacao.inversa.tipo, 'alterar_campo_no');
    assert.equal(operacao.inversa.no_id, operacao.no_id);
    assert.equal(operacao.inversa.campo, 'description');
    assert.equal(operacao.inversa.de, operacao.para, 'a inversa desfaz: de/para trocados');
    assert.equal(operacao.inversa.para, operacao.de);
  }
});

test('t158 — teto de tempo cita a amostra de tempo, não a de tokens', async () => {
  const { avaliarPoliticas } = await carregar();

  // Cinco sessões reportaram uso, duas reportaram os dois carimbos de tempo:
  // as duas amostras divergem de propósito (`custo.ts`), que é exatamente o
  // caso em que citar a errada engana quem lê a recomendação.
  const candidatas = avaliarPoliticas(
    [
      linha('redigir', 100, {
        sessoes_com_uso: 5,
        sessoes_sem_uso: 0,
        tempo_total_segundos: 900,
        sessoes_com_tempo: 2,
        sessoes_sem_tempo: 3,
      }),
    ],
    { tetoSegundos: 600 },
  );

  assert.equal(candidatas.length, 1);
  assert.equal(candidatas[0].evidencia.teto_excedido, 'tempo', 'só o teto de tempo estourou');

  const { para } = candidatas[0].operacoes[0];
  assert.ok(
    para.includes('2 sessions with time reported'),
    `a recomendação de tempo se apoia na amostra de tempo; veio: ${para}`,
  );
  assert.ok(
    !para.includes('5 sessions'),
    'a amostra de tokens não sustenta uma recomendação de teto de tempo',
  );
});

/* -------------------------------------------------------------------------- */
/* t180 — o texto que uma pessoa lê na proposta é inglês; as chaves, não.      */
/* -------------------------------------------------------------------------- */

test('t180 — a marca e as recomendações de teto e tier estão em inglês', async () => {
  const { avaliarPoliticas, MARCA } = await carregar();

  assert.equal(MARCA, '[cost-surveyor]', 'a marca usa o termo de glossário de topógrafo');

  const candidatas = avaliarPoliticas([linha('a', 100), linha('b', 100), linha('c', 9000)], {
    tetoTokens: 1000,
    tierFator: 3,
    tierMinimoNos: 3,
  });

  const teto = candidatas.find((candidata) => candidata.tipo === 'teto');
  assert.ok(teto !== undefined, 'o cenário tem de produzir uma candidata de teto');
  assert.equal(
    teto.operacoes[0].para,
    '[cost-surveyor] token ceiling exceeded: 9000 tokens observed against a ceiling of 1000, ' +
      'over 1 sessions with usage reported. Reduce the scope of this node, split it, or revisit the ceiling.',
  );
  assert.equal(
    teto.metrica_esperada.descricao,
    'tokens_total of node "c" goes back under the declared ceiling',
    'o nome da métrica é chave de formato e não se traduz',
  );

  const tier = candidatas.find((candidata) => candidata.tipo === 'tier');
  assert.ok(tier !== undefined, 'o cenário tem de produzir uma candidata de tier');
  assert.equal(
    tier.operacoes[0].para,
    '[cost-surveyor] cost out of line in this version: 9000 tokens, 90.0x the median of 100 ' +
      'across the 3 measured nodes (factor 3). Candidate for a cheaper model tier, or for a split into smaller nodes.',
  );
  assert.equal(
    tier.metrica_esperada.descricao,
    'tokens_total of node "c" falls below 3x the version median',
  );
});
