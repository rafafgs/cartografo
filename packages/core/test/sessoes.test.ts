/**
 * Testes de aceite da sessão (t102, AT8–AT10).
 *
 * A sessão é a execução de um agente por um EngineAdapter. No flowpilot ela era
 * uma linha mutável que nascia `pending` e era atualizada até `completed`; aqui
 * são dois eventos (`sessao.aberta`, `sessao.finalizada`) e uma projeção — a
 * consequência 2 da regra append-only da taxonomia.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T102,
  carregarEventos,
  criarTrabalho,
  exigirArtefatos,
  pedir,
  subirControlPlane,
  type Evento,
  type Sessao,
} from './apoio.ts';

const ARTEFATOS = [
  ARTEFATOS_T102.migracao,
  ARTEFATOS_T102.eventos,
  ARTEFATOS_T102.validacao,
  ARTEFATOS_T102.repoSessao,
  ARTEFATOS_T102.rotasSessoes,
];

const USO = {
  input_tokens: 18422,
  output_tokens: 3110,
  cache_creation_input_tokens: 9004,
  cache_read_input_tokens: 120344,
};

test('AT8 — POST /v1/sessoes grava sessao.aberta e cria a linha aberta', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATOS_T102.repoTrabalho, ARTEFATOS_T102.rotasTrabalhos);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const trabalho = await criarTrabalho(ctx, {
    titulo: 'com sessão',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const resposta = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: trabalho.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
  });

  assert.equal(resposta.status, 201);
  const sessao = resposta.corpo;
  assert.ok(Number.isInteger(sessao.id) && sessao.id >= 1);
  assert.equal(sessao.status, 'aberta');
  assert.equal(sessao.trabalho_id, trabalho.id);
  assert.equal(sessao.execucao_id, 7, 'a execução vem do trabalho servido');
  assert.equal(sessao.exit_code, null);
  assert.equal(sessao.uso, null);
  assert.equal(sessao.finalizada_em, null);
  assert.ok(!Number.isNaN(Date.parse(sessao.aberta_em)));

  const eventos = buscarEventosPorEntidade(ctx.db, 'sessao', sessao.id);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'sessao.aberta');
  assert.deepEqual(eventos[0].entidade, { tipo: 'sessao', id: sessao.id });
  assert.deepEqual(eventos[0].dados, {
    trabalho_id: trabalho.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    engine_session_ref: 'cc-9f2b41d0',
    working_dir: '/Users/rafael/cartografo-ticket-102',
    prompt: 'Refine o trabalho 102 contra as convenções do projeto.',
    timeout_seconds: 5400,
  });
});

test('AT9 — PATCH /v1/sessoes/:id/finalizar fecha a sessão; uso ausente vira null, nunca 0', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const abrir = async (): Promise<Sessao> => {
    const resposta = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
      execucao_id: 7,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt: 'faça algo',
    });
    assert.equal(resposta.status, 201);
    return resposta.corpo;
  };

  const comUso = await abrir();
  const finalizada = await pedir<Sessao>(ctx, 'PATCH', `/v1/sessoes/${comUso.id}/finalizar`, {
    status: 'concluida',
    exit_code: 0,
    uso: USO,
  });
  assert.equal(finalizada.status, 200);
  assert.equal(finalizada.corpo.status, 'concluida');
  assert.equal(finalizada.corpo.exit_code, 0, 'zero é código de saída de sucesso, não ausência');
  assert.deepEqual(finalizada.corpo.uso, USO);
  assert.ok(!Number.isNaN(Date.parse(finalizada.corpo.finalizada_em ?? '')));

  const semUso = await abrir();
  const pausada = await pedir<Sessao>(ctx, 'PATCH', `/v1/sessoes/${semUso.id}/finalizar`, {
    status: 'pausada_cota',
  });
  assert.equal(pausada.status, 200);
  assert.equal(pausada.corpo.status, 'pausada_cota');
  assert.equal(pausada.corpo.uso, null, 'o engine não reportou nada: null');
  assert.notEqual(pausada.corpo.uso, 0, 'nunca colapsar uso ausente em zero');
  assert.equal(pausada.corpo.exit_code, null);

  const eventos = buscarEventosPorEntidade(ctx.db, 'sessao', comUso.id);
  assert.deepEqual(
    eventos.map((evento: Evento) => evento.tipo),
    ['sessao.aberta', 'sessao.finalizada'],
  );
  assert.deepEqual(eventos[1].dados, { status: 'concluida', exit_code: 0, uso: USO });

  const doSemUso = buscarEventosPorEntidade(ctx.db, 'sessao', semUso.id);
  assert.deepEqual(doSemUso[1].dados, { status: 'pausada_cota', exit_code: null, uso: null });
});

test('AT10 — GET /v1/sessoes?execucao_id=7 devolve só as sessões daquela execução', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const abrir = async (execucaoId: number, prompt: string): Promise<Sessao> => {
    const resposta = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
      execucao_id: execucaoId,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt,
    });
    assert.equal(resposta.status, 201);
    return resposta.corpo;
  };

  const uma = await abrir(7, 'da sete');
  const outra = await abrir(7, 'também da sete');
  await abrir(8, 'da oito');

  const resposta = await pedir<{ sessoes: Sessao[] }>(ctx, 'GET', '/v1/sessoes?execucao_id=7');
  assert.equal(resposta.status, 200);
  assert.deepEqual(
    resposta.corpo.sessoes.map((sessao) => sessao.id).sort((a, b) => a - b),
    [uma.id, outra.id].sort((a, b) => a - b),
  );
});

test('t107 AT2 — GET /v1/sessoes?trabalho_id= recorta por trabalho dentro da mesma execução', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATOS_T102.repoTrabalho, ARTEFATOS_T102.rotasTrabalhos);
  const ctx = await subirControlPlane(t);

  // Os dois trabalhos moram na MESMA execução: é o que faz o teste provar o
  // filtro novo, e não o `execucao_id` que já existia.
  const observado = await criarTrabalho(ctx, {
    titulo: 'o que a tela abre',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const vizinho = await criarTrabalho(ctx, {
    titulo: 'o outro da mesma rodada',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const abrir = async (trabalhoId: number, prompt: string): Promise<Sessao> => {
    const resposta = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
      trabalho_id: trabalhoId,
      engine: 'claude-code',
      working_dir: '/tmp/cartografo',
      prompt,
    });
    assert.equal(resposta.status, 201);
    return resposta.corpo;
  };

  const primeira = await abrir(observado.id, 'primeira passada');
  const segunda = await abrir(observado.id, 'segunda passada');
  const doVizinho = await abrir(vizinho.id, 'do vizinho');

  const resposta = await pedir<{ sessoes: Sessao[] }>(
    ctx,
    'GET',
    `/v1/sessoes?trabalho_id=${observado.id}`,
  );
  assert.equal(resposta.status, 200);
  assert.deepEqual(
    resposta.corpo.sessoes.map((sessao) => sessao.id),
    [primeira.id, segunda.id],
    'só as sessões do trabalho pedido, em ordem de id',
  );
  assert.ok(
    !resposta.corpo.sessoes.some((sessao) => sessao.id === doVizinho.id),
    'a sessão do vizinho compartilha a execução, mas não o trabalho',
  );

  const combinado = await pedir<{ sessoes: Sessao[] }>(
    ctx,
    'GET',
    `/v1/sessoes?execucao_id=7&trabalho_id=${observado.id}`,
  );
  assert.equal(combinado.status, 200);
  assert.deepEqual(
    combinado.corpo.sessoes.map((sessao) => sessao.id),
    [primeira.id, segunda.id],
    'os dois filtros juntos são AND',
  );

  const semCasamento = await pedir<{ sessoes: Sessao[] }>(
    ctx,
    'GET',
    `/v1/sessoes?execucao_id=8&trabalho_id=${observado.id}`,
  );
  assert.deepEqual(semCasamento.corpo.sessoes, [], 'AND, não OR');

  const invalido = await pedir(ctx, 'GET', '/v1/sessoes?trabalho_id=abc');
  assert.equal(invalido.status, 400, 'filtro inválido é 400, nunca filtro ignorado em silêncio');
});
