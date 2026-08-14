/**
 * Testes de aceite das duas telas de execução (t107, FR6/FR7).
 *
 * A lista de execuções só existe porque a API ganhou `GET /v1/executions` nesta
 * mesma ficha: `execucao_id` é agrupador opaco, e até aqui só dava para
 * consultá-lo já sabendo o id. D11 é explícita — "se a tela precisa de algo que
 * a API não dá, o bug é da API" —, então a lacuna foi fechada no core e a tela
 * é cliente comum dela, sem atalho.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T107,
  abrirPagina,
  abrirSessao,
  api,
  blocos,
  criarPergunta,
  criarTrabalho,
  exigirArtefatos,
  subirControlPlane,
  subirTela,
} from './apoio.ts';

test('t107 AT5 — GET /execucoes lista as execuções com as contagens certas', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.cliente, ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const daSete = await criarTrabalho(cp, {
    titulo: 'primeiro da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  await criarTrabalho(cp, {
    titulo: 'segundo da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  await criarTrabalho(cp, { titulo: 'único da oito', no_entrada_id: 'refinar', execucao_id: 8 });

  await api(cp, 'POST', `/v1/jobs/${daSete.id}/blocks`, { motivo: 'travou' });
  await criarPergunta(cp, { trabalho_id: daSete.id, pergunta: 'renumerar?' });

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, '/execucoes');

  assert.equal(pagina.status, 200);
  const linhas = blocos(pagina.html, 'execucao');
  assert.deepEqual(
    linhas.map((linha) => linha.valor),
    ['7', '8'],
    'uma linha por execução, em ordem crescente',
  );

  const [sete, oito] = linhas;
  assert.match(sete.trecho, /data-campo="trabalhos">\s*2\s*</, 'a sete tem dois trabalhos');
  assert.match(
    sete.trecho,
    /data-campo="trabalhos_bloqueados">\s*1\s*</,
    'a sete tem um trabalho bloqueado',
  );
  assert.match(
    sete.trecho,
    /data-campo="perguntas_pendentes">\s*1\s*</,
    'a sete tem uma pergunta pendente',
  );
  assert.match(oito.trecho, /data-campo="trabalhos">\s*1\s*</);
  assert.match(oito.trecho, /data-campo="trabalhos_bloqueados">\s*0\s*</);
  assert.match(oito.trecho, /data-campo="perguntas_pendentes">\s*0\s*</);

  assert.ok(sete.trecho.includes('href="/execucoes/7"'), 'cada execução leva à sua página');
});

test('t107 AT5 — GET /execucoes/:id recorta trabalhos, sessões e perguntas daquela execução', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.cliente, ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const daSete = await criarTrabalho(cp, {
    titulo: 'o trabalho da sete',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const daOito = await criarTrabalho(cp, {
    titulo: 'o trabalho da oito',
    no_entrada_id: 'refinar',
    execucao_id: 8,
  });

  const sessaoDaSete = await abrirSessao(cp, { trabalho_id: daSete.id, no_id: 'refinar' });
  const sessaoDaOito = await abrirSessao(cp, { trabalho_id: daOito.id, no_id: 'refinar' });
  await api(cp, 'PATCH', `/v1/sessions/${sessaoDaSete.id}/finish`, {
    status: 'concluida',
    exit_code: 0,
  });

  const perguntaDaSete = await criarPergunta(cp, {
    trabalho_id: daSete.id,
    pergunta: 'seguir pelo caminho curto?',
  });
  const perguntaDaOito = await criarPergunta(cp, {
    trabalho_id: daOito.id,
    pergunta: 'pergunta da outra execução',
  });

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, '/execucoes/7');

  assert.equal(pagina.status, 200);
  assert.ok(pagina.html.includes(daSete.titulo), 'o quadro da execução mostra o trabalho dela');
  assert.ok(!pagina.html.includes(daOito.titulo), 'trabalho de outra execução não pode vazar');

  const sessoes = blocos(pagina.html, 'sessao');
  assert.deepEqual(
    sessoes.map((sessao) => sessao.valor),
    [String(sessaoDaSete.id)],
    'só as sessões daquela execução',
  );
  assert.ok(
    !pagina.html.includes(`data-sessao="${sessaoDaOito.id}"`),
    'sessão de outra execução não pode vazar',
  );
  assert.ok(sessoes[0].trecho.includes('claude-code'), 'a sessão mostra o engine');
  assert.ok(sessoes[0].trecho.includes('concluida'), 'a sessão mostra o status');
  assert.ok(sessoes[0].trecho.includes(sessaoDaSete.aberta_em), 'a sessão mostra quando abriu');

  const perguntas = blocos(pagina.html, 'pergunta');
  assert.deepEqual(
    perguntas.map((pergunta) => pergunta.valor),
    [String(perguntaDaSete.id)],
    'só as perguntas pendentes daquela execução',
  );
  assert.ok(!pagina.html.includes(perguntaDaOito.pergunta), 'pergunta de outra execução não vaza');
});

test('t107 AT5 — execução sem nada é 200 com página vazia, não erro', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);
  const tela = await subirTela(t, cp.url);

  // Execução é agrupador opaco: não existe objeto para faltar (mesma leitura
  // que `GET /v1/executions/:id/metrics-by-version` já faz no core).
  const pagina = await abrirPagina(tela, '/execucoes/99');
  assert.equal(pagina.status, 200);
  assert.deepEqual(blocos(pagina.html, 'trabalho'), []);
});
