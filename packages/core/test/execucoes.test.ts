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
  type ContextoTeste,
  type Evento,
  type MetricaPorVersao,
  type Pergunta,
  type Sessao,
  type Trabalho,
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

/* -------------------------------------------------------------------------- */
/* t110 — the execution-wide event stream the flow surveyor reads              */
/*                                                                            */
/* From here down the test names and identifiers are in English (D18); the     */
/* route segments and payload keys stay in Portuguese, as already published.   */
/* -------------------------------------------------------------------------- */

/** What `GET /v1/execucoes/:id/eventos` gives back (FR1). */
interface ExecutionLog {
  execucao_id: number;
  eventos: Evento[];
}

/**
 * Seeds one execution with all three event-bearing entities.
 *
 * The surveyor's numbers cross trabalho, sessão and pergunta — time in node,
 * time blocked, questions per node — so a log that only proves one of them
 * proves nothing about the query this ticket needs.
 */
async function seedExecution(ctx: ContextoTeste, execucaoId: number): Promise<Trabalho> {
  const trabalho = await criarTrabalho(ctx, {
    titulo: `travessia da execução ${execucaoId}`,
    no_entrada_id: 'redigir',
    execucao_id: execucaoId,
    grafo_versao_id: 'sha256:t110',
  });

  await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, { para_no_id: 'revisar' });

  const sessao = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: trabalho.id,
    no_id: 'revisar',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'revise',
  });
  await pedir(ctx, 'PATCH', `/v1/sessoes/${sessao.corpo.id}/finalizar`, {
    status: 'concluida',
    exit_code: 0,
    uso: null,
  });

  // Asking also blocks the work, in the same transaction (t106) — two more
  // events, both carrying the owner's `execucao_id`.
  await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    sessao_id: sessao.corpo.id,
    tipo: 'pergunta',
    pergunta: 'sigo com a nota curta?',
    auto_aprovavel: true,
  });

  return trabalho;
}

test('t110 — GET /v1/execucoes/:id/eventos returns the execution log in ascending id order', async (t) => {
  exigirArtefatos(
    ARTEFATOS_T102.migracao,
    ARTEFATOS_T102.eventos,
    ARTEFATOS_T102.rotasExecucoes,
    ARTEFATOS_T102.rotasSessoes,
    ARTEFATOS_T102.rotasPerguntas,
  );
  const ctx = await subirControlPlane(t);

  await seedExecution(ctx, 11);
  // A second execution, seeded the same way: nothing of it may leak into 11.
  const outra = await seedExecution(ctx, 12);

  const resposta = await pedir<ExecutionLog>(ctx, 'GET', '/v1/execucoes/11/eventos');

  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.execucao_id, 11);

  const eventos = resposta.corpo.eventos;
  assert.deepEqual(
    eventos.map((evento) => evento.tipo),
    [
      'trabalho.criado',
      'trabalho.transicao',
      'sessao.aberta',
      'sessao.finalizada',
      'pergunta.criada',
      'trabalho.bloqueado',
    ],
    'the stream crosses trabalho, sessão and pergunta, in the order the log recorded them',
  );

  const ids = eventos.map((evento) => evento.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ordered by id, the only total ordering');

  for (const evento of eventos) {
    assert.equal(evento.execucao_id, 11, 'no event of another execution may leak in');
    assert.notEqual(
      evento.entidade.id,
      outra.id,
      'the other execution has its own work; this one never mentions it',
    );
  }

  // The envelope arrives whole: the surveyor computes intervals from
  // `ocorrido_em` and attributes them by `dados`.
  const aberta = eventos.find((evento) => evento.tipo === 'sessao.aberta');
  assert.ok(aberta !== undefined);
  assert.equal(aberta.dados.no_id, 'revisar');
  assert.equal(typeof aberta.ocorrido_em, 'string');

  const daOutra = await pedir<ExecutionLog>(ctx, 'GET', '/v1/execucoes/12/eventos');
  assert.equal(daOutra.corpo.eventos.length, eventos.length, 'each execution sees only its own');
});

test('t110 — an execution with no events answers 200 with an empty list, never 404', async (t) => {
  exigirArtefatos(ARTEFATOS_T102.migracao, ARTEFATOS_T102.rotasExecucoes);
  const ctx = await subirControlPlane(t);

  const resposta = await pedir<ExecutionLog>(ctx, 'GET', '/v1/execucoes/99/eventos');

  assert.equal(resposta.status, 200, 'execução é agrupador opaco: não há o que existir ou não');
  assert.equal(resposta.corpo.execucao_id, 99);
  assert.deepEqual(resposta.corpo.eventos, []);
});
