/**
 * Testes de aceite do inbox de perguntas (t107, FR8/FR9).
 *
 * O ponto central, e o que distingue esta ficha de uma maquete: o submit do
 * formulário faz a ESCRITA DE VERDADE (`PATCH /v1/perguntas/:id/resposta`)
 * contra o control plane real. Por isso a prova não é o HTML que a tela
 * devolve — é uma leitura independente feita direto no control plane, pela API
 * pública, depois do submit. Uma tela que "respondesse" só no seu próprio
 * estado passaria em qualquer teste que se conformasse com o próprio HTML.
 *
 * O que esta ficha NÃO cobra, de propósito: que responder RETOME a sessão do
 * agente. O wiring pergunta → bloqueio → resposta → desbloqueio → retomada é
 * critério de aceite do t106 (a fronteira está documentada em
 * `packages/core/src/repositorios/pergunta.ts` e travada por AT11 do t102).
 * Quando t106 existir, esta tela não muda uma linha.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T107,
  abrirPagina,
  api,
  blocos,
  criarPergunta,
  criarTrabalho,
  enviarFormulario,
  exigirArtefatos,
  subirControlPlane,
  subirTela,
  type Pergunta,
} from './apoio.ts';

const CORPO_COMPLETO = {
  pergunta: 'Renumerar a migração para 0003?',
  contexto: 'A t101 corre em paralelo e é dona do mesmo espaço de numeração.',
  opcoes: ['Renumerar para 0003', 'Manter 0002'],
  recomendacao: 'Manter 0002 e renumerar só se colidir no merge.',
  resposta_padrao: 'Manter 0002',
};

/** Lê a pergunta direto do control plane, sem passar pela tela. */
async function lerNoControlPlane(
  cp: Parameters<typeof api>[0],
  trabalhoId: number,
  perguntaId: number,
): Promise<Pergunta> {
  const resposta = await api<{ perguntas: Pergunta[] }>(
    cp,
    'GET',
    `/v1/perguntas?trabalho_id=${trabalhoId}`,
  );
  assert.equal(resposta.status, 200);
  const achada = resposta.corpo.perguntas.find((pergunta) => pergunta.id === perguntaId);
  assert.ok(achada !== undefined, `o control plane não conhece a pergunta ${perguntaId}`);
  return achada;
}

test('t107 AT6 — GET /perguntas mostra a pergunta inteira, com o que é preciso para decidir', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.cliente, ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, {
    titulo: 'que pergunta',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const pergunta = await criarPergunta(cp, { trabalho_id: trabalho.id, ...CORPO_COMPLETO });

  const respondida = await criarPergunta(cp, {
    trabalho_id: trabalho.id,
    pergunta: 'esta já foi decidida',
  });
  await api(cp, 'PATCH', `/v1/perguntas/${respondida.id}/resposta`, {
    resposta: 'sim',
    respondido_por: 'rafael',
  });

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, '/perguntas');

  assert.equal(pagina.status, 200);
  const cartoes = blocos(pagina.html, 'pergunta');
  assert.deepEqual(
    cartoes.map((cartao) => cartao.valor),
    [String(pergunta.id)],
    'a fila é só o que está pendente',
  );

  const [cartao] = cartoes;
  assert.ok(cartao.trecho.includes(CORPO_COMPLETO.pergunta), 'mostra a pergunta');
  assert.ok(cartao.trecho.includes(CORPO_COMPLETO.contexto), 'mostra o contexto');
  assert.ok(cartao.trecho.includes(CORPO_COMPLETO.recomendacao), 'mostra a recomendação');
  assert.ok(cartao.trecho.includes(CORPO_COMPLETO.resposta_padrao), 'mostra a resposta padrão');
  for (const opcao of CORPO_COMPLETO.opcoes) {
    assert.ok(cartao.trecho.includes(opcao), `mostra a opção "${opcao}"`);
  }
  assert.ok(
    cartao.trecho.includes(`action="/perguntas/${pergunta.id}/resposta"`),
    'cada pergunta traz o formulário que a responde',
  );
  assert.ok(cartao.trecho.includes('method="post"'), 'responder é escrita, e escrita é POST');
});

test('t107 AT6 — o submit responde DE VERDADE no control plane e some da fila', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.cliente, ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com pergunta', no_entrada_id: 'refinar' });
  const pergunta = await criarPergunta(cp, { trabalho_id: trabalho.id, ...CORPO_COMPLETO });

  const antes = await lerNoControlPlane(cp, trabalho.id, pergunta.id);
  assert.equal(antes.status, 'pendente');

  const tela = await subirTela(t, cp.url);
  const submissao = await enviarFormulario(tela, `/perguntas/${pergunta.id}/resposta`, {
    resposta: 'Manter 0002',
    respondido_por: 'rafael',
  });

  assert.equal(submissao.status, 303, 'POST que escreve responde redirecionando');
  assert.equal(submissao.destino, '/perguntas', 'e volta para a fila recarregada da API');

  // A prova: leitura independente, direto no control plane. O que interessa é
  // que o ESTADO mudou, não que a tela tenha dito que mudou.
  const depois = await lerNoControlPlane(cp, trabalho.id, pergunta.id);
  assert.equal(depois.status, 'respondida');
  assert.equal(depois.resposta, 'Manter 0002');
  assert.equal(depois.respondido_por, 'rafael');
  assert.ok(depois.respondida_em !== null);

  const fila = await abrirPagina(tela, '/perguntas');
  assert.equal(fila.status, 200);
  assert.deepEqual(
    blocos(fila.html, 'pergunta').map((cartao) => cartao.valor),
    [],
    'sumiu da fila porque a fila é relida da API, não porque o formulário a escondeu',
  );
});

test('t107 AT6 — resposta vazia é recusada pela tela, sem escrever nada', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, { titulo: 'com pergunta', no_entrada_id: 'refinar' });
  const pergunta = await criarPergunta(cp, { trabalho_id: trabalho.id, ...CORPO_COMPLETO });

  const tela = await subirTela(t, cp.url);
  const submissao = await enviarFormulario(tela, `/perguntas/${pergunta.id}/resposta`, {
    resposta: '   ',
    respondido_por: 'rafael',
  });

  assert.equal(submissao.status, 400);
  // O schema do evento aceita string vazia; quem tem que barrar o clique
  // acidental é a tela, ANTES de gravar um fato sem conteúdo no log.
  const depois = await lerNoControlPlane(cp, trabalho.id, pergunta.id);
  assert.equal(depois.status, 'pendente', 'nada foi escrito');
});

test('t107 AT6 — responder pergunta inexistente propaga o 404 do control plane', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);
  const tela = await subirTela(t, cp.url);

  const submissao = await enviarFormulario(tela, '/perguntas/424242/resposta', {
    resposta: 'seja lá o que for',
    respondido_por: 'rafael',
  });

  assert.equal(submissao.status, 404, 'a tela não inventa sucesso que a API não deu');
});
