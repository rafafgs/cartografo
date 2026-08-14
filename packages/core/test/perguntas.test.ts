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
 *
 * A t113 acrescenta a base de precedentes (AT3–AT7): pergunta respondida vira
 * consulta, para quem responde a próxima ver o que foi decidido da última vez
 * (`notas/2026-08-14-aprendizado.md`). É superfície de LEITURA e só isso — a
 * política de auto-resposta é ficha separada, porque a escada de segurança
 * (princípio 5) pede que o precedente exista e acumule história ANTES de
 * qualquer portão responder sozinho.
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
  type ContextoTeste,
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

/** Artefato próprio da t113; os testes de precedente o exigem pelo nome. */
const ARTEFATO_SIMILARIDADE = 'src/dominio/similaridade.ts';

const CORPO_COMPLETO = {
  tipo: 'pergunta',
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
  auto_aprovavel: true,
};

/**
 * Um precedente, como a API o devolve (t113).
 *
 * Escrito à mão, e não importado de `src/`: esta interface É o contrato que o
 * teste cobra, e contrato importado da implementação não cobra nada.
 */
interface Precedente {
  id: number;
  pergunta: string;
  resposta: string | null;
  origem: string | null;
  respondido_por: string | null;
  tipo: string;
  criada_em: string;
  respondida_em: string | null;
  similaridade: number;
}

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

/** Cria uma pergunta com o texto pedido e devolve a projeção pendente. */
async function perguntar(
  ctx: ContextoTeste,
  trabalhoId: number,
  texto: string,
): Promise<Pergunta> {
  const resposta = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalhoId,
    ...CORPO_COMPLETO,
    pergunta: texto,
  });
  assert.equal(resposta.status, 201);
  return resposta.corpo;
}

/** Cria e já responde — o formato de tudo o que pode virar precedente. */
async function perguntarEResponder(
  ctx: ContextoTeste,
  trabalhoId: number,
  texto: string,
  resposta: string,
): Promise<Pergunta> {
  const criada = await perguntar(ctx, trabalhoId, texto);
  const fechada = await pedir<Pergunta>(ctx, 'PATCH', `/v1/perguntas/${criada.id}/resposta`, {
    resposta,
    respondido_por: 'rafael',
  });
  assert.equal(fechada.status, 200);
  return fechada.corpo;
}

/** Consulta a base de precedentes de uma pergunta. */
async function precedentesDe(
  ctx: ContextoTeste,
  id: number,
  consulta = '',
): Promise<{ status: number; corpo: { precedentes: Precedente[] } }> {
  return await pedir<{ precedentes: Precedente[] }>(
    ctx,
    'GET',
    `/v1/perguntas/${id}/precedentes${consulta}`,
  );
}

test('AT3 — GET /v1/perguntas/:id/precedentes de pergunta inexistente é 404', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATO_SIMILARIDADE);
  const ctx = await subirControlPlane(t);

  const resposta = await precedentesDe(ctx, 99999);
  assert.equal(resposta.status, 404);
  assert.equal(
    (resposta.corpo as unknown as { erro: string }).erro,
    'nao_encontrado',
    'o 404 é o da casa (`naoEncontrado`), não o genérico do roteador',
  );
});

test('AT4 — sem nenhuma pergunta respondida no projeto, precedentes é lista vazia', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATO_SIMILARIDADE);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });
  const pendente = await perguntar(ctx, trabalho.id, 'Renumerar a migração para 0004?');

  const resposta = await precedentesDe(ctx, pendente.id);
  assert.equal(resposta.status, 200, '"não achei nada" é 200 com lista vazia, nunca 404 nem 500');
  assert.deepEqual(resposta.corpo, { precedentes: [] });
});

test('AT5 — precedente é a respondida parecida, e a própria pergunta nunca entra', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATO_SIMILARIDADE);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });

  const parecida = await perguntarEResponder(
    ctx,
    trabalho.id,
    'Renumerar a migração para 0003?',
    'Manter 0002',
  );
  await perguntarEResponder(
    ctx,
    trabalho.id,
    'Qual engine adapter usar no despacho?',
    'Claude Code',
  );

  const consultada = await perguntar(ctx, trabalho.id, 'Renumerar a migração para 0004?');

  const resposta = await precedentesDe(ctx, consultada.id);
  assert.equal(resposta.status, 200);
  assert.deepEqual(
    resposta.corpo.precedentes.map((linha) => linha.id),
    [parecida.id],
    'a respondida sem token em comum não é precedente de nada',
  );

  const [precedente] = resposta.corpo.precedentes;
  assert.ok(precedente.similaridade > 0, 'o escore é o que torna o ranking auditável');
  assert.ok(precedente.similaridade <= 1);
  assert.equal(precedente.pergunta, 'Renumerar a migração para 0003?');
  assert.equal(precedente.resposta, 'Manter 0002', 'o precedente serve para ver O QUE se decidiu');
  assert.equal(precedente.origem, 'usuario');
  assert.equal(precedente.respondido_por, 'rafael');
  assert.equal(precedente.tipo, 'pergunta');
  assert.ok(!Number.isNaN(Date.parse(precedente.criada_em)));
  assert.ok(!Number.isNaN(Date.parse(precedente.respondida_em ?? '')));

  // Depois de respondida, ela vira candidata a precedente das OUTRAS — nunca de
  // si mesma, que seria sempre o topo do ranking com escore 1.
  const fechada = await pedir<Pergunta>(ctx, 'PATCH', `/v1/perguntas/${consultada.id}/resposta`, {
    resposta: 'Renumerar para 0004',
    respondido_por: 'rafael',
  });
  assert.equal(fechada.status, 200);

  const depois = await precedentesDe(ctx, consultada.id);
  assert.equal(depois.status, 200);
  assert.deepEqual(
    depois.corpo.precedentes.map((linha) => linha.id),
    [parecida.id],
  );
});

test('AT6 — respondida de outro projeto nunca é precedente, nem com texto idêntico', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATO_SIMILARIDADE);
  const ctx = await subirControlPlane(t);

  const texto = 'Renumerar a migração para 0003?';

  const doOutro = await criarTrabalho(ctx, {
    titulo: 'de outro projeto',
    no_entrada_id: 'entrada',
    projeto_id: 42,
  });
  const alheia = await perguntarEResponder(ctx, doOutro.id, texto, 'Manter 0002');

  const meu = await criarTrabalho(ctx, { titulo: 'meu', no_entrada_id: 'entrada' });
  const consultada = await perguntar(ctx, meu.id, texto);

  const resposta = await precedentesDe(ctx, consultada.id);
  assert.equal(resposta.status, 200);
  assert.deepEqual(
    resposta.corpo.precedentes,
    [],
    'precedente é do projeto de quem pergunta; texto idêntico não fura o isolamento',
  );

  // E o espelho: quem pergunta do lado de lá enxerga a própria história.
  const deLa = await perguntar(ctx, doOutro.id, texto);
  const dele = await precedentesDe(ctx, deLa.id);
  assert.deepEqual(
    dele.corpo.precedentes.map((linha) => linha.id),
    [alheia.id],
  );
});

test('AT7 — limite corta pelo topo do ranking, e valor acima do teto é aparado', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATO_SIMILARIDADE);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'x', no_entrada_id: 'entrada' });

  const maisParecida = await perguntarEResponder(
    ctx,
    trabalho.id,
    'Renumerar a migração para 0003?',
    'Manter 0002',
  );
  const menosParecida = await perguntarEResponder(
    ctx,
    trabalho.id,
    'Renumerar tudo?',
    'Não renumerar',
  );

  const consultada = await perguntar(ctx, trabalho.id, 'Renumerar a migração para 0004?');

  const ambas = await precedentesDe(ctx, consultada.id);
  assert.equal(ambas.status, 200);
  assert.deepEqual(
    ambas.corpo.precedentes.map((linha) => linha.id),
    [maisParecida.id, menosParecida.id],
    'a ordem é a do escore, decrescente',
  );
  assert.ok(
    ambas.corpo.precedentes[0].similaridade > ambas.corpo.precedentes[1].similaridade,
    'o ranking é explicável pelo próprio corpo da resposta',
  );

  const cortada = await precedentesDe(ctx, consultada.id, '?limite=1');
  assert.equal(cortada.status, 200);
  assert.deepEqual(
    cortada.corpo.precedentes.map((linha) => linha.id),
    [maisParecida.id],
    'cortar pelo limite corta a cauda, não o topo',
  );

  // O limite é botão de tamanho de tela, não regra de correção: valor fora da
  // faixa é aparado para o teto, e não vira 400.
  const acimaDoTeto = await precedentesDe(ctx, consultada.id, '?limite=999');
  assert.equal(acimaDoTeto.status, 200);
  assert.deepEqual(
    acimaDoTeto.corpo.precedentes.map((linha) => linha.id),
    [maisParecida.id, menosParecida.id],
  );

  const abaixoDoPiso = await precedentesDe(ctx, consultada.id, '?limite=0');
  assert.equal(abaixoDoPiso.status, 200);
  assert.deepEqual(
    abaixoDoPiso.corpo.precedentes.map((linha) => linha.id),
    [maisParecida.id],
    'zero e negativo são aparados para o piso de 1, pela mesma razão',
  );
});
