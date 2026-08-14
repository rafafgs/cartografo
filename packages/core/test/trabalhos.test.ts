/**
 * Testes de aceite do trabalho (t102, AT1–AT7).
 *
 * O trabalho é o "viajante" do grafo: nasce num nó de entrada, anda por
 * transições, levanta e baixa a bandeira de bloqueio, e tem o conteúdo
 * emendado. Cada um desses fatos é um evento do log (t98) — e é o log, não a
 * linha da tabela, que estes testes tratam como fonte de verdade.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T102,
  contarEventos,
  criarTrabalho,
  exigirArtefatos,
  pedir,
  subirControlPlane,
  type ContextoTeste,
  type Evento,
  type Trabalho,
} from './apoio.ts';

const ARTEFATOS = [
  ARTEFATOS_T102.migracao,
  ARTEFATOS_T102.eventos,
  ARTEFATOS_T102.validacao,
  ARTEFATOS_T102.repoTrabalho,
  ARTEFATOS_T102.rotasTrabalhos,
];

/** Eventos de um trabalho, na ordem do log. */
async function linhaDoTempo(ctx: ContextoTeste, trabalhoId: number): Promise<Evento[]> {
  const resposta = await pedir<{ eventos: Evento[] }>(
    ctx,
    'GET',
    `/v1/trabalhos/${trabalhoId}/eventos`,
  );
  assert.equal(resposta.status, 200);
  return resposta.corpo.eventos;
}

test('AT1 — POST /v1/trabalhos cria o trabalho e grava trabalho.criado', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const resposta = await pedir<Trabalho>(ctx, 'POST', '/v1/trabalhos', {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  assert.equal(resposta.status, 201);
  const trabalho = resposta.corpo;
  assert.ok(Number.isInteger(trabalho.id) && trabalho.id >= 1, 'id atribuído pelo servidor');
  assert.equal(trabalho.no_atual, 'entrada', 'no_atual nasce igual ao no_entrada_id');
  assert.equal(trabalho.no_entrada_id, 'entrada');
  assert.equal(trabalho.bloqueado, false);
  assert.equal(trabalho.motivo_bloqueio, null);
  assert.equal(trabalho.execucao_id, 7);

  const eventos = await linhaDoTempo(ctx, trabalho.id);
  assert.equal(eventos.length, 1);
  const [evento] = eventos;
  assert.equal(evento.tipo, 'trabalho.criado');
  assert.ok(Number.isInteger(evento.id) && evento.id >= 1, 'id do evento é do servidor');
  assert.deepEqual(evento.entidade, { tipo: 'trabalho', id: trabalho.id });
  assert.equal(evento.execucao_id, 7);
  assert.ok(Number.isInteger(evento.projeto_id));
  assert.ok(typeof evento.ator.ref === 'string' && evento.ator.ref.length > 0);
  assert.ok(['usuario', 'agente', 'sistema'].includes(evento.ator.tipo));
  assert.ok(!Number.isNaN(Date.parse(evento.ocorrido_em)), 'ocorrido_em é ISO 8601');
  assert.deepEqual(evento.dados, {
    titulo: 'Entidades e API: trabalho, sessão, evento e pergunta',
    no_entrada_id: 'entrada',
  });
});

test('AT2 — POST /v1/trabalhos/:id/transicoes anda no grafo e grava trabalho.transicao', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'andar', no_entrada_id: 'entrada' });

  const primeira = await pedir<Trabalho>(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, {
    para_no_id: 'implementacao',
  });
  assert.equal(primeira.status, 200);
  assert.equal(primeira.corpo.no_atual, 'implementacao');

  const segunda = await pedir<Trabalho>(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, {
    para_no_id: 'revisao',
  });
  assert.equal(segunda.status, 200);
  assert.equal(segunda.corpo.no_atual, 'revisao');

  const transicoes = (await linhaDoTempo(ctx, trabalho.id)).filter(
    (evento) => evento.tipo === 'trabalho.transicao',
  );
  assert.equal(transicoes.length, 2);
  assert.deepEqual(
    transicoes[0].dados,
    { de_no_id: null, para_no_id: 'implementacao' },
    'na primeira transição o trabalho sai do nó de entrada: de_no_id é null',
  );
  assert.deepEqual(transicoes[1].dados, { de_no_id: 'implementacao', para_no_id: 'revisao' });
});

test('AT3 — bloqueio e desbloqueio movem a bandeira e gravam os dois eventos', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'parar', no_entrada_id: 'entrada' });

  const bloqueado = await pedir<Trabalho>(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/bloqueios`, {
    motivo: 'esperando resposta do humano',
  });
  assert.equal(bloqueado.status, 200);
  assert.equal(bloqueado.corpo.bloqueado, true);
  assert.equal(bloqueado.corpo.motivo_bloqueio, 'esperando resposta do humano');
  assert.equal(bloqueado.corpo.no_atual, 'entrada', 'bloqueio não move o trabalho de nó');

  const desbloqueado = await pedir<Trabalho>(
    ctx,
    'POST',
    `/v1/trabalhos/${trabalho.id}/desbloqueios`,
    {},
  );
  assert.equal(desbloqueado.status, 200);
  assert.equal(desbloqueado.corpo.bloqueado, false);
  assert.equal(desbloqueado.corpo.motivo_bloqueio, null);

  const eventos = await linhaDoTempo(ctx, trabalho.id);
  const bandeiras = eventos.filter((evento) =>
    ['trabalho.bloqueado', 'trabalho.desbloqueado'].includes(evento.tipo),
  );
  assert.deepEqual(
    bandeiras.map((evento) => evento.tipo),
    ['trabalho.bloqueado', 'trabalho.desbloqueado'],
  );
  assert.deepEqual(bandeiras[0].dados, { motivo: 'esperando resposta do humano' });
  assert.deepEqual(bandeiras[1].dados, {}, 'o fato é a própria queda da bandeira: sem payload');
});

test('AT4 — PATCH /v1/trabalhos/:id emenda o título e grava só o NOME do campo', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'título velho', no_entrada_id: 'entrada' });

  const resposta = await pedir<Trabalho>(ctx, 'PATCH', `/v1/trabalhos/${trabalho.id}`, {
    titulo: 'título novo, com segredo dentro',
  });
  assert.equal(resposta.status, 200);
  assert.equal(resposta.corpo.titulo, 'título novo, com segredo dentro');

  const emendas = (await linhaDoTempo(ctx, trabalho.id)).filter(
    (evento) => evento.tipo === 'trabalho.emendado',
  );
  assert.equal(emendas.length, 1);
  assert.deepEqual(emendas[0].dados, { campos_alterados: ['titulo'] });
  assert.ok(
    !JSON.stringify(emendas[0].dados).includes('segredo'),
    'o log diz o que foi mexido, nunca o conteúdo novo (taxonomia: registro de auditoria)',
  );
});

test('AT5 — GET /v1/trabalhos devolve o quadro atual, com filtro por execução', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const um = await criarTrabalho(ctx, {
    titulo: 'na execução 7, versão v1',
    no_entrada_id: 'entrada',
    execucao_id: 7,
    grafo_versao_id: 'v1',
  });
  await pedir(ctx, 'POST', `/v1/trabalhos/${um.id}/transicoes`, { para_no_id: 'implementacao' });
  await pedir(ctx, 'POST', `/v1/trabalhos/${um.id}/bloqueios`, { motivo: 'travou' });

  const dois = await criarTrabalho(ctx, {
    titulo: 'na execução 8',
    no_entrada_id: 'entrada',
    execucao_id: 8,
  });

  const todos = await pedir<{ trabalhos: Trabalho[] }>(ctx, 'GET', '/v1/trabalhos');
  assert.equal(todos.status, 200);
  assert.equal(todos.corpo.trabalhos.length, 2, 'um trabalho por linha');

  const quadro = todos.corpo.trabalhos.find((linha) => linha.id === um.id);
  assert.ok(quadro !== undefined);
  assert.equal(quadro.no_atual, 'implementacao');
  assert.equal(quadro.bloqueado, true);
  assert.equal(quadro.execucao_id, 7);
  assert.equal(quadro.grafo_versao_id, 'v1');

  const filtrado = await pedir<{ trabalhos: Trabalho[] }>(
    ctx,
    'GET',
    '/v1/trabalhos?execucao_id=8',
  );
  assert.equal(filtrado.status, 200);
  assert.deepEqual(
    filtrado.corpo.trabalhos.map((linha) => linha.id),
    [dois.id],
  );
});

test('AT6 — GET /v1/trabalhos/:id/eventos é a linha do tempo, em ordem de id', async (t) => {
  exigirArtefatos(...ARTEFATOS, ARTEFATOS_T102.rotasSessoes, ARTEFATOS_T102.rotasPerguntas);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, {
    titulo: 'com sessão e pergunta',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });
  const vizinho = await criarTrabalho(ctx, {
    titulo: 'o do lado, que não pode vazar',
    no_entrada_id: 'entrada',
    execucao_id: 7,
  });

  await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, { para_no_id: 'refinamento' });

  const sessao = await pedir<{ id: number }>(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: trabalho.id,
    no_id: 'refinamento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'refine o trabalho',
  });
  assert.equal(sessao.status, 201);

  const pergunta = await pedir<{ id: number }>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    sessao_id: sessao.corpo.id,
    tipo: 'pergunta',
    pergunta: 'renumerar a migração?',
    auto_aprovavel: false,
  });
  assert.equal(pergunta.status, 201);

  // Ruído do vizinho: mesma execução, mesmo tipo de evento, outro trabalho.
  await pedir(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: vizinho.id,
    engine: 'claude-code',
    working_dir: '/tmp/vizinho',
    prompt: 'outra coisa',
  });

  const eventos = await linhaDoTempo(ctx, trabalho.id);
  assert.deepEqual(
    eventos.map((evento) => evento.tipo),
    [
      'trabalho.criado',
      'trabalho.transicao',
      'sessao.aberta',
      'pergunta.criada',
      // Criar a pergunta bloqueia o trabalho na mesma transação desde t106; a
      // bandeira aparece aqui porque `trabalho.bloqueado` é evento DO trabalho.
      'trabalho.bloqueado',
    ],
    'os do trabalho mais os de sessão/pergunta que o citam via dados.trabalho_id',
  );
  assert.deepEqual(
    [...eventos].sort((a, b) => a.id - b.id).map((evento) => evento.id),
    eventos.map((evento) => evento.id),
    'a ordem é a do id do evento',
  );
  assert.equal(eventos[2].entidade.id, sessao.corpo.id, 'entidade.id é o da sessão, não o do trabalho');
  assert.equal(eventos[3].entidade.id, pergunta.corpo.id);
});

test('AT7 — transição/bloqueio contra trabalho inexistente é 404 e não grava evento', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const trabalho = await criarTrabalho(ctx, { titulo: 'o único', no_entrada_id: 'entrada' });
  const antes = contarEventos(ctx);

  const inexistente = trabalho.id + 999;
  for (const [caminho, corpo] of [
    [`/v1/trabalhos/${inexistente}/transicoes`, { para_no_id: 'implementacao' }],
    [`/v1/trabalhos/${inexistente}/bloqueios`, { motivo: 'travou' }],
    [`/v1/trabalhos/${inexistente}/desbloqueios`, {}],
  ] as const) {
    const resposta = await pedir(ctx, 'POST', caminho, corpo);
    assert.equal(resposta.status, 404, `${caminho} devia ser 404`);
  }

  const patch = await pedir(ctx, 'PATCH', `/v1/trabalhos/${inexistente}`, { titulo: 'x' });
  assert.equal(patch.status, 404);

  assert.equal(contarEventos(ctx), antes, 'nenhum evento gravado para trabalho que não existe');
});

test('FR3 — corpo sem campo obrigatório responde 400 e não grava evento', async (t) => {
  exigirArtefatos(...ARTEFATOS);
  const ctx = await subirControlPlane(t);

  const antes = contarEventos(ctx);

  const semNoEntrada = await pedir(ctx, 'POST', '/v1/trabalhos', { titulo: 'sem nó de entrada' });
  assert.equal(semNoEntrada.status, 400);

  const semTitulo = await pedir(ctx, 'POST', '/v1/trabalhos', { no_entrada_id: 'entrada' });
  assert.equal(semTitulo.status, 400);

  const trabalho = await criarTrabalho(ctx, { titulo: 'válido', no_entrada_id: 'entrada' });
  const depoisDoValido = contarEventos(ctx);

  const semDestino = await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, {});
  assert.equal(semDestino.status, 400);

  const semMotivo = await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/bloqueios`, {});
  assert.equal(semMotivo.status, 400);

  assert.equal(contarEventos(ctx), depoisDoValido, 'requisição inválida não deixa rastro no log');
  assert.equal(depoisDoValido, antes + 1, 'só o trabalho válido gravou evento');
});
