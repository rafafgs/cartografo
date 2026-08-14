/**
 * Teste de aceite da consulta versão × telemetria (t102, AT15).
 *
 * É o join que o topógrafo vai precisar depois da PoC: D15 põe a versão de
 * grafo como a linha que se cruza com a telemetria para dizer se uma mutação
 * melhorou alguma coisa. Sem esta consulta, "a v2 é melhor que a v1" seria
 * opinião.
 *
 * `grafo_versao_id` é `TEXT` solto de propósito (a tabela `grafo_versao` é de
 * t101): aqui ele é dado de entrada do trabalho, não FK.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T102,
  criarTrabalho,
  exigirArtefatos,
  pedir,
  subirControlPlane,
  type MetricaPorVersao,
} from './apoio.ts';

test('AT15 — GET /v1/execucoes/:id/metricas-por-versao agrupa trabalhos e eventos por versão', async (t) => {
  exigirArtefatos(
    ARTEFATOS_T102.migracao,
    ARTEFATOS_T102.eventos,
    ARTEFATOS_T102.repoTrabalho,
    ARTEFATOS_T102.rotasTrabalhos,
    ARTEFATOS_T102.rotasExecucoes,
  );
  const ctx = await subirControlPlane(t);

  // Execução 7: dois trabalhos na v1, um na v2.
  const v1a = await criarTrabalho(ctx, {
    titulo: 'v1 a',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  const v1b = await criarTrabalho(ctx, {
    titulo: 'v1 b',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  const v2 = await criarTrabalho(ctx, {
    titulo: 'v2',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v2',
  });

  // Execução 8, mesma versão: não pode vazar para o relatório da 7.
  await criarTrabalho(ctx, {
    titulo: 'de outra execução',
    no_entrada_id: 'entrada',
    execucao_id: 8,
    grafo_versao_id: 'v1',
  });

  // v1: 2 criados + 2 transições + 1 sessão = 5 eventos.
  await pedir(ctx, 'POST', `/v1/trabalhos/${v1a.id}/transicoes`, { para_no_id: 'implementacao' });
  await pedir(ctx, 'POST', `/v1/trabalhos/${v1b.id}/transicoes`, { para_no_id: 'implementacao' });
  await pedir(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: v1a.id,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'trabalhe',
  });

  // v2: 1 criado + 1 bloqueio = 2 eventos.
  await pedir(ctx, 'POST', `/v1/trabalhos/${v2.id}/bloqueios`, { motivo: 'travou' });

  const resposta = await pedir<{ execucao_id: number; metricas: MetricaPorVersao[] }>(
    ctx,
    'GET',
    '/v1/execucoes/7/metricas-por-versao',
  );

  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.execucao_id, 7);
  assert.deepEqual(resposta.corpo.metricas, [
    { grafo_versao_id: 'v1', trabalhos: 2, eventos: 5 },
    { grafo_versao_id: 'v2', trabalhos: 1, eventos: 2 },
  ]);
});

test('AT15 — execução sem trabalho nenhum devolve lista vazia, não 404', async (t) => {
  exigirArtefatos(ARTEFATOS_T102.migracao, ARTEFATOS_T102.rotasExecucoes);
  const ctx = await subirControlPlane(t);

  const resposta = await pedir<{ execucao_id: number; metricas: MetricaPorVersao[] }>(
    ctx,
    'GET',
    '/v1/execucoes/99/metricas-por-versao',
  );

  assert.equal(resposta.status, 200, 'execução é agrupador opaco: não há o que existir ou não');
  assert.deepEqual(resposta.corpo.metricas, []);
});
