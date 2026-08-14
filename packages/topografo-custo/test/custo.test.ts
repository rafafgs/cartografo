/**
 * Testes de aceite da agregação de custo (t114, AT1–AT4).
 *
 * A regra que atravessa os quatro: **ausência não é zero**. Sessão sem `uso` não
 * baixa a média de tokens e sessão sem `finalizada_em` não baixa o tempo — elas
 * entram nos contadores `sessoes_sem_*`, que é onde a incerteza fica visível.
 * É a mesma convenção de `packages/core/src/repositorios/sessao.ts:9-11`, e o
 * motivo é o mesmo: colapsar as duas coisas destrói a única métrica de custo que
 * a PoC tem.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloCusto from '../src/custo.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

let cache: typeof ModuloCusto | null = null;

async function carregar(): Promise<typeof ModuloCusto> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'custo.ts')),
    'artefato ainda não existe: packages/topografo-custo/src/custo.ts',
  );
  cache ??= (await import(new URL('../src/custo.ts', import.meta.url).href)) as typeof ModuloCusto;
  return cache;
}

/** Um `uso` com as quatro subchaves; o total é a soma delas. */
function uso(
  entrada: number,
  saida: number,
  criacaoDeCache: number,
  leituraDeCache: number,
): ModuloCusto.UsoDeSessao {
  return {
    input_tokens: entrada,
    output_tokens: saida,
    cache_creation_input_tokens: criacaoDeCache,
    cache_read_input_tokens: leituraDeCache,
  };
}

/** Uma sessão como `GET /v1/sessions` a devolve, no subconjunto que a lente lê. */
function sessao(parcial: Partial<ModuloCusto.SessaoObservada>): ModuloCusto.SessaoObservada {
  return {
    trabalho_id: 1,
    no_id: 'redigir',
    uso: null,
    aberta_em: '2026-08-14T10:00:00.000Z',
    finalizada_em: '2026-08-14T10:00:30.000Z',
    ...parcial,
  };
}

test('AT1 — soma as quatro subchaves de uso de duas sessões do mesmo par num único total', async () => {
  const { agregarCusto } = await carregar();

  const linhas = agregarCusto(
    [
      sessao({ trabalho_id: 1, no_id: 'redigir', uso: uso(100, 20, 3, 7) }),
      sessao({ trabalho_id: 1, no_id: 'redigir', uso: uso(1, 2, 3, 4) }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(linhas.length, 1, 'duas sessões do mesmo (versão, nó) são UMA linha');
  assert.equal(linhas[0].grafo_versao_id, 'sha256:v1');
  assert.equal(linhas[0].no_id, 'redigir');
  assert.equal(linhas[0].tokens_total, 140, '100+20+3+7 + 1+2+3+4');
  assert.equal(linhas[0].sessoes_com_uso, 2);
  assert.equal(linhas[0].sessoes_sem_uso, 0);
});

test('AT2 — sessão com uso null não muda tokens_total e conta em sessoes_sem_uso', async () => {
  const { agregarCusto } = await carregar();

  const linhas = agregarCusto(
    [
      sessao({ trabalho_id: 1, no_id: 'redigir', uso: uso(10, 10, 10, 10) }),
      sessao({ trabalho_id: 1, no_id: 'redigir', uso: null }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].tokens_total, 40, 'uso ausente NUNCA entra como zero tokens');
  assert.equal(linhas[0].sessoes_com_uso, 1);
  assert.equal(linhas[0].sessoes_sem_uso, 1, 'a ausência fica visível no contador próprio');
});

test('AT3 — sessão sem finalizada_em fica fora do tempo e conta em sessoes_sem_tempo', async () => {
  const { agregarCusto } = await carregar();

  const linhas = agregarCusto(
    [
      sessao({
        trabalho_id: 1,
        no_id: 'redigir',
        aberta_em: '2026-08-14T10:00:00.000Z',
        finalizada_em: '2026-08-14T10:00:30.000Z',
      }),
      sessao({
        trabalho_id: 1,
        no_id: 'redigir',
        aberta_em: '2026-08-14T11:00:00.000Z',
        finalizada_em: null,
      }),
    ],
    new Map([[1, 'sha256:v1']]),
  );

  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].tempo_total_segundos, 30, 'só a sessão fechada entra na soma');
  assert.equal(linhas[0].sessoes_com_tempo, 1);
  assert.equal(linhas[0].sessoes_sem_tempo, 1, 'sessão aberta é desconhecida, não instantânea');
});

test('AT4 — pares com grafo_versao_id ou no_id nulo ficam num grupo à parte, por último', async () => {
  const { agregarCusto } = await carregar();

  const linhas = agregarCusto(
    [
      // Trabalho sem versão de grafo declarada: a versão sai nula.
      sessao({ trabalho_id: 9, no_id: 'redigir', uso: uso(1, 1, 1, 1) }),
      // Sessão de descoberta: nenhum nó, nenhum trabalho.
      sessao({ trabalho_id: null, no_id: null, uso: uso(2, 2, 2, 2) }),
      sessao({ trabalho_id: 1, no_id: 'revisar', uso: uso(3, 3, 3, 3) }),
      sessao({ trabalho_id: 1, no_id: 'redigir', uso: uso(4, 4, 4, 4) }),
    ],
    new Map<number, string | null>([
      [1, 'sha256:v1'],
      [9, null],
    ]),
  );

  const identificadas = linhas.filter(
    (linha) => linha.grafo_versao_id !== null && linha.no_id !== null,
  );
  const soltas = linhas.filter((linha) => linha.grafo_versao_id === null || linha.no_id === null);

  assert.equal(identificadas.length, 2);
  assert.equal(soltas.length, 2);
  assert.deepEqual(
    linhas.slice(0, identificadas.length),
    identificadas,
    'as linhas identificadas vêm primeiro; o grupo solto é o rabo da lista',
  );
  assert.deepEqual(
    identificadas.map((linha) => linha.no_id),
    ['redigir', 'revisar'],
    'dentro da versão, ordem estável por nó',
  );
  // Nenhuma linha some: um relatório que esconde o que não sabe classificar
  // mente sobre o total (mesma convenção de `metricasPorVersao`).
  assert.equal(
    linhas.reduce((soma, linha) => soma + linha.tokens_total, 0),
    4 + 8 + 12 + 16,
  );
});
