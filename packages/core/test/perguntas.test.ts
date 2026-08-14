/**
 * Testes de aceite da pergunta (t102, AT11–AT14).
 *
 * Escalação humana é entidade de primeira classe, não caso especial: pergunta e
 * aprovação são o mesmo animal, e a ORIGEM da resposta é o tipo do evento
 * (`pergunta.respondida` vs `pergunta.auto_resolvida`), não uma coluna. Na
 * projeção a origem volta a ser campo — quem lê estado quer comparar.
 *
 * O que esta ficha NÃO faz: bloquear o trabalho ao criar a pergunta. Esse
 * wiring é o critério de aceite de t106, e AT11 existe para travar a fronteira.
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
  type Pergunta,
  type Trabalho,
} from './apoio.ts';

const ARTEFATOS = [
  ARTEFATOS_T102.migracao,
  ARTEFATOS_T102.eventos,
  ARTEFATOS_T102.validacao,
  ARTEFATOS_T102.repoPergunta,
  ARTEFATOS_T102.repoTrabalho,
  ARTEFATOS_T102.rotasPerguntas,
  ARTEFATOS_T102.rotasTrabalhos,
];

const CORPO_COMPLETO = {
  tipo: 'pergunta',
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
  auto_aprovavel: true,
};

test('AT11 — POST /v1/perguntas cria pendente e NÃO bloqueia o trabalho', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const trabalho = await criarTrabalho(ctx, {
    titulo: 'que pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  const resposta = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    ...CORPO_COMPLETO,
  });

  assert.equal(resposta.status, 201);
  const pergunta = resposta.corpo;
  assert.ok(Number.isInteger(pergunta.id) && pergunta.id >= 1);
  assert.equal(pergunta.status, 'pendente');
  assert.equal(pergunta.origem, null);
  assert.equal(pergunta.resposta, null);
  assert.equal(pergunta.respondida_em, null);
  assert.equal(pergunta.auto_aprovavel, true);
  assert.deepEqual(pergunta.opcoes, CORPO_COMPLETO.opcoes);
  assert.equal(pergunta.execucao_id, 7, 'a execução vem do trabalho que espera');

  const depois = await pedir<Trabalho>(ctx, 'GET', `/v1/trabalhos/${trabalho.id}`);
  assert.equal(depois.status, 200);
  assert.equal(
    depois.corpo.bloqueado,
    false,
    'o wiring pergunta→bloqueio é de t106; esta ficha só registra o pedido',
  );

  const eventos = buscarEventosPorEntidade(ctx.db, 'pergunta', pergunta.id);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].tipo, 'pergunta.criada');
  assert.deepEqual(eventos[0].entidade, { tipo: 'pergunta', id: pergunta.id });
  assert.deepEqual(eventos[0].dados, {
    trabalho_id: trabalho.id,
    sessao_id: null,
    tipo: 'pergunta',
    pergunta: CORPO_COMPLETO.pergunta,
    contexto: CORPO_COMPLETO.contexto,
    opcoes: CORPO_COMPLETO.opcoes,
    recomendacao: CORPO_COMPLETO.recomendacao,
    resposta_padrao: CORPO_COMPLETO.resposta_padrao,
    auto_aprovavel: true,
  });
});

test('AT12 — PATCH /v1/perguntas/:id/resposta registra a resposta do humano', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const criada = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    ...CORPO_COMPLETO,
  });
  assert.equal(criada.status, 201);

  const resposta = await pedir<Pergunta>(
    ctx,
    'PATCH',
    `/v1/perguntas/${criada.corpo.id}/resposta`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );

  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.status, 'respondida');
  assert.equal(resposta.corpo.origem, 'usuario');
  assert.equal(resposta.corpo.resposta, 'Manter 0002');
  assert.equal(resposta.corpo.respondido_por, 'rafael');
  assert.ok(!Number.isNaN(Date.parse(resposta.corpo.respondida_em ?? '')));

  const eventos = buscarEventosPorEntidade(ctx.db, 'pergunta', criada.corpo.id);
  assert.deepEqual(
    eventos.map((evento) => evento.tipo),
    ['pergunta.criada', 'pergunta.respondida'],
  );
  assert.deepEqual(eventos[1].dados, { resposta: 'Manter 0002', respondido_por: 'rafael' });
  assert.equal(eventos[1].ator.tipo, 'usuario', 'quem respondeu foi gente');
});

test('AT13 — PATCH /v1/perguntas/:id/auto_resolucao registra a origem automática', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const criada = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    ...CORPO_COMPLETO,
  });
  assert.equal(criada.status, 201);

  const resposta = await pedir<Pergunta>(
    ctx,
    'PATCH',
    `/v1/perguntas/${criada.corpo.id}/auto_resolucao`,
    { resposta: 'Manter 0002', baseada_em: 'resposta_padrao' },
  );

  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.status, 'respondida');
  assert.equal(resposta.corpo.origem, 'auto');
  assert.equal(resposta.corpo.resposta, 'Manter 0002');

  const eventos = buscarEventosPorEntidade(ctx.db, 'pergunta', criada.corpo.id);
  assert.deepEqual(
    eventos.map((evento) => evento.tipo),
    ['pergunta.criada', 'pergunta.auto_resolvida'],
  );
  assert.deepEqual(eventos[1].dados, {
    resposta: 'Manter 0002',
    baseada_em: 'resposta_padrao',
  });
  assert.notEqual(
    eventos[1].ator.tipo,
    'usuario',
    'a auditoria SEMPRE distingue aprovado-por-usuário de aprovado-pelo-sistema',
  );

  const invalida = await pedir(ctx, 'PATCH', `/v1/perguntas/${criada.corpo.id}/auto_resolucao`, {
    resposta: 'seja lá o que for',
    baseada_em: 'palpite',
  });
  assert.equal(invalida.status, 400, 'baseada_em é enum fechado');
});

test('AT14 — GET /v1/perguntas?status=pendente&execucao_id=7 dá o suficiente para responder', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const daSete = await criarTrabalho(ctx, {
    titulo: 'da sete',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const daOito = await criarTrabalho(ctx, {
    titulo: 'da oito',
    no_entrada_id: 'entrada',
    execucao_id: 8,
  });

  const criar = async (trabalhoId: number): Promise<Pergunta> => {
    const resposta = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
      trabalho_id: trabalhoId,
      ...CORPO_COMPLETO,
    });
    assert.equal(resposta.status, 201);
    return resposta.corpo;
  };

  const pendente = await criar(daSete.id);
  const respondida = await criar(daSete.id);
  await criar(daOito.id);

  await pedir(ctx, 'PATCH', `/v1/perguntas/${respondida.id}/resposta`, {
    resposta: 'ok',
    respondido_por: 'rafael',
  });

  const resposta = await pedir<{ perguntas: Pergunta[] }>(
    ctx,
    'GET',
    '/v1/perguntas?status=pendente&execucao_id=7',
  );
  assert.equal(resposta.status, 200);
  assert.deepEqual(
    resposta.corpo.perguntas.map((linha) => linha.id),
    [pendente.id],
  );

  const [fila] = resposta.corpo.perguntas;
  assert.equal(fila.pergunta, CORPO_COMPLETO.pergunta);
  assert.equal(fila.contexto, CORPO_COMPLETO.contexto);
  assert.deepEqual(fila.opcoes, CORPO_COMPLETO.opcoes);
  assert.equal(fila.recomendacao, CORPO_COMPLETO.recomendacao);
  assert.equal(fila.resposta_padrao, CORPO_COMPLETO.resposta_padrao);
  assert.equal(fila.trabalho_id, daSete.id);
});
