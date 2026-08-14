/**
 * Testes de aceite das rotas de execução (t102 AT15; t107 AT1).
 *
 * A primeira é a consulta versão × telemetria: o join que o topógrafo vai
 * precisar depois da PoC, porque D15 põe a versão de grafo como a linha que se
 * cruza com a telemetria para dizer se uma mutação melhorou alguma coisa. Sem
 * ela, "a v2 é melhor que a v1" seria opinião.
 *
 * A segunda é a LISTA de execuções (t107): `execucao_id` é agrupador opaco e
 * até aqui só dava para consultá-lo sabendo o id de antemão — a tela não teria
 * como descobrir quais execuções existem. D11 manda tratar isso como bug da
 * API, não como workaround na tela.
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
  type Pergunta,
} from './apoio.ts';

/**
 * Uma linha de `GET /v1/execucoes` (t107, FR1).
 *
 * Escrita à mão, como as outras deste apoio: ela É o contrato que o teste
 * cobra, e importá-la de `src/` não cobraria nada.
 */
interface ResumoDeExecucao {
  execucao_id: number | null;
  trabalhos: number;
  trabalhos_bloqueados: number;
  perguntas_pendentes: number;
}

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

test('t107 AT1 — GET /v1/execucoes agrupa por execução, conta bloqueados e pendentes, e põe null por último', async (t) => {
  exigirArtefatos(
    ARTEFATOS_T102.migracao,
    ARTEFATOS_T102.repoTrabalho,
    ARTEFATOS_T102.repoPergunta,
    ARTEFATOS_T102.rotasExecucoes,
    ARTEFATOS_T102.rotasPerguntas,
  );
  const ctx = await subirControlPlane(t);

  // A oito é criada ANTES da sete de propósito: a ordenação da resposta é por
  // `execucao_id`, não pela ordem em que os trabalhos entraram.
  await criarTrabalho(ctx, { titulo: 'só da oito', no_entrada_id: 'entrada', execucao_id: 8 });

  const bloqueado = await criarTrabalho(ctx, {
    titulo: 'travado',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const solto = await criarTrabalho(ctx, {
    titulo: 'andando',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  // Trabalho sem execução: cai no grupo `null` em vez de sumir da contagem.
  await criarTrabalho(ctx, { titulo: 'sem rodada', no_entrada_id: 'entrada' });

  await pedir(ctx, 'POST', `/v1/trabalhos/${bloqueado.id}/bloqueios`, { motivo: 'esperando gente' });

  const perguntar = async (trabalhoId: number): Promise<Pergunta> => {
    const resposta = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
      trabalho_id: trabalhoId,
      tipo: 'pergunta',
      pergunta: 'e agora?',
      auto_aprovavel: false,
    });
    assert.equal(resposta.status, 201);
    return resposta.corpo;
  };

  const pendente = await perguntar(bloqueado.id);
  const jaRespondida = await perguntar(solto.id);
  await pedir(ctx, 'PATCH', `/v1/perguntas/${jaRespondida.id}/resposta`, {
    resposta: 'siga',
    respondido_por: 'rafael',
  });
  assert.ok(pendente.id !== jaRespondida.id);

  const resposta = await pedir<{ execucoes: ResumoDeExecucao[] }>(ctx, 'GET', '/v1/execucoes');

  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.corpo.execucoes, [
    { execucao_id: 7, trabalhos: 2, trabalhos_bloqueados: 1, perguntas_pendentes: 1 },
    { execucao_id: 8, trabalhos: 1, trabalhos_bloqueados: 0, perguntas_pendentes: 0 },
    { execucao_id: null, trabalhos: 1, trabalhos_bloqueados: 0, perguntas_pendentes: 0 },
  ]);
});

test('t107 AT1 — sem trabalho nenhum, GET /v1/execucoes devolve lista vazia', async (t) => {
  exigirArtefatos(ARTEFATOS_T102.migracao, ARTEFATOS_T102.rotasExecucoes);
  const ctx = await subirControlPlane(t);

  const resposta = await pedir<{ execucoes: ResumoDeExecucao[] }>(ctx, 'GET', '/v1/execucoes');
  assert.equal(resposta.status, 200);
  assert.deepEqual(resposta.corpo.execucoes, []);
});
