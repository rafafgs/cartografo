/**
 * Testes de aceite da pergunta (t102, AT11–AT14; t106, o wiring do bloqueio).
 *
 * Escalação humana é entidade de primeira classe, não caso especial: pergunta e
 * aprovação são o mesmo animal, e a ORIGEM da resposta é o tipo do evento
 * (`pergunta.respondida` vs `pergunta.auto_resolvida`), não uma coluna. Na
 * projeção a origem volta a ser campo — quem lê estado quer comparar.
 *
 * O t102 parou de propósito antes de ligar pergunta a bloqueio, e o AT11
 * travava essa fronteira afirmando `bloqueado === false`. A t106 é a ficha que
 * fecha o ciclo, então o AT11 muda de lado: criar a pergunta bloqueia o
 * trabalho NA MESMA transação, e responder desbloqueia com o ator de quem
 * respondeu. Quem quer saber por que o ciclo mora aqui, e não no runner, lê
 * `docs/spec/escalacao-humana.md`.
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

test('AT11 — POST /v1/perguntas cria pendente E bloqueia o trabalho dono (t106)', async (t) => {
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

  // A rota não muda de forma: quem quer o bloqueio lê o trabalho. O que muda é
  // que ele JÁ está bloqueado quando a resposta do POST chega — mesma
  // transação, não um segundo passo que alguém pode esquecer de dar.
  const depois = await pedir<Trabalho>(ctx, 'GET', `/v1/trabalhos/${trabalho.id}`);
  assert.equal(depois.status, 200);
  assert.equal(depois.corpo.bloqueado, true, 'criar a pergunta para o trabalho');
  assert.equal(
    depois.corpo.motivo_bloqueio,
    `aguardando resposta da pergunta ${pergunta.id}`,
    'o motivo cita o id da pergunta: quem lê o trabalho sabe o que destrava',
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

  // A linha do tempo do trabalho: a criação, e logo depois o bloqueio. A ordem
  // é a do log (id), e é ela que conta a história — pergunta primeiro, bandeira
  // depois.
  const doTrabalho = buscarEventosPorEntidade(ctx.db, 'trabalho', trabalho.id);
  assert.deepEqual(
    doTrabalho.map((evento) => evento.tipo),
    ['trabalho.criado', 'trabalho.bloqueado'],
  );
  const bloqueio = doTrabalho[1];
  assert.deepEqual(bloqueio.dados, { motivo: `aguardando resposta da pergunta ${pergunta.id}` });
  assert.equal(
    bloqueio.ator.tipo,
    'sistema',
    'quem levanta a bandeira é o wiring, não o humano nem o agente que perguntou',
  );
  assert.equal(bloqueio.ator.ref, 'escalacao-humana');
});

test('t106 — PATCH /resposta desbloqueia o trabalho, com o ator de quem respondeu', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);
  const { buscarEventosPorEntidade } = await carregarEventos();

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const criada = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    ...CORPO_COMPLETO,
  });
  assert.equal(criada.status, 201);

  const bloqueado = await pedir<Trabalho>(ctx, 'GET', `/v1/trabalhos/${trabalho.id}`);
  assert.equal(bloqueado.corpo.bloqueado, true);

  const resposta = await pedir<Pergunta>(
    ctx,
    'PATCH',
    `/v1/perguntas/${criada.corpo.id}/resposta`,
    { resposta: 'Manter 0002', respondido_por: 'rafael' },
  );
  assert.equal(resposta.status, 200);

  const depois = await pedir<Trabalho>(ctx, 'GET', `/v1/trabalhos/${trabalho.id}`);
  assert.equal(depois.corpo.bloqueado, false, 'responder devolve o trabalho à fila');
  assert.equal(depois.corpo.motivo_bloqueio, null);

  const doTrabalho = buscarEventosPorEntidade(ctx.db, 'trabalho', trabalho.id);
  assert.deepEqual(
    doTrabalho.map((evento) => evento.tipo),
    ['trabalho.criado', 'trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  const desbloqueio = doTrabalho[2];
  assert.deepEqual(desbloqueio.dados, {}, 'o fato é a própria queda da bandeira');
  assert.equal(
    desbloqueio.ator.tipo,
    'usuario',
    'quem destravou foi gente, e o desbloqueio carrega o MESMO ator da resposta',
  );
  assert.equal(desbloqueio.ator.ref, 'rafael');
});

test('t106 — PATCH /auto_resolucao desbloqueia com ator que não é usuário', async (t) => {
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

  const depois = await pedir<Trabalho>(ctx, 'GET', `/v1/trabalhos/${trabalho.id}`);
  assert.equal(depois.corpo.bloqueado, false, 'o portão automático também destrava');
  assert.equal(depois.corpo.motivo_bloqueio, null);

  const doTrabalho = buscarEventosPorEntidade(ctx.db, 'trabalho', trabalho.id);
  assert.deepEqual(
    doTrabalho.map((evento) => evento.tipo),
    ['trabalho.criado', 'trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  assert.notEqual(
    doTrabalho[2].ator.tipo,
    'usuario',
    'a auditoria SEMPRE distingue destravado-por-gente de destravado-pelo-sistema',
  );
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
