/**
 * Teste de aceite do quadro (t107, FR5).
 *
 * O critério 1 do corpo original da ficha: "vejo o quadro". Aqui ele é cobrado
 * ponta a ponta — control plane de verdade como processo, tela de verdade
 * lendo dele só por HTTP, e HTML de verdade saindo do outro lado.
 *
 * O agrupamento por `no_atual` é a razão de a tela existir: um quadro que só
 * lista trabalhos em ordem de id não responde "onde o trabalho está travando?",
 * que é a pergunta que D16 quer respondida antes de aceitar a PoC.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTEFATOS_T107,
  abrirPagina,
  api,
  blocos,
  criarTrabalho,
  exigirArtefatos,
  subirControlPlane,
  subirTela,
} from './apoio.ts';

test('t107 AT4 — GET / mostra os trabalhos agrupados por nó, com o motivo do bloqueio', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.cliente, ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  const refinando = await criarTrabalho(cp, {
    titulo: 'Tela mínima de observabilidade',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const implementando = await criarTrabalho(cp, {
    titulo: 'Ciclo de pergunta e retomada',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });
  const travado = await criarTrabalho(cp, {
    titulo: 'Grafo de fábrica 2',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });

  await api(cp, 'POST', `/v1/trabalhos/${implementando.id}/transicoes`, {
    para_no_id: 'implementar',
  });
  await api(cp, 'POST', `/v1/trabalhos/${travado.id}/transicoes`, { para_no_id: 'implementar' });
  await api(cp, 'POST', `/v1/trabalhos/${travado.id}/bloqueios`, {
    motivo: 'esperando decisão do fundador',
  });

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, '/');

  assert.equal(pagina.status, 200);
  assert.match(pagina.tipo ?? '', /text\/html/, 'a tela devolve HTML, não JSON');

  for (const trabalho of [refinando, implementando, travado]) {
    assert.ok(
      pagina.html.includes(trabalho.titulo),
      `o quadro não mostra o título "${trabalho.titulo}"`,
    );
  }

  const grupos = blocos(pagina.html, 'no-atual');
  assert.deepEqual(
    grupos.map((grupo) => grupo.valor),
    ['implementar', 'refinar'],
    'um grupo por nó ocupado, em ordem de nó',
  );

  const [emImplementar, emRefinar] = grupos;
  assert.ok(
    emImplementar.trecho.includes(implementando.titulo) &&
      emImplementar.trecho.includes(travado.titulo),
    'os dois que transicionaram estão sob o grupo "implementar"',
  );
  assert.ok(
    !emImplementar.trecho.includes(refinando.titulo),
    'quem não andou não pode aparecer no grupo do nó seguinte',
  );
  assert.ok(
    emRefinar.trecho.includes(refinando.titulo),
    'quem não andou continua sob o grupo do nó de entrada',
  );

  const cartoes = blocos(pagina.html, 'trabalho');
  assert.deepEqual(
    [...cartoes.map((cartao) => cartao.valor)].sort(),
    [refinando.id, implementando.id, travado.id].map(String).sort(),
    'um cartão por trabalho, marcado com o id',
  );

  const cartaoTravado = cartoes.find((cartao) => cartao.valor === String(travado.id));
  assert.ok(cartaoTravado !== undefined);
  assert.ok(
    cartaoTravado.trecho.includes('esperando decisão do fundador'),
    'o cartão bloqueado precisa dizer POR QUE está bloqueado',
  );

  const cartaoSolto = cartoes.find((cartao) => cartao.valor === String(refinando.id));
  assert.ok(cartaoSolto !== undefined);
  assert.ok(
    !cartaoSolto.trecho.includes('esperando decisão do fundador'),
    'motivo de bloqueio é do trabalho bloqueado, não da página',
  );

  assert.ok(pagina.html.includes('href="/execucoes"'), 'o quadro leva à lista de execuções');
  assert.ok(
    pagina.html.includes(`href="/trabalhos/${refinando.id}"`),
    'cada trabalho leva à sua linha do tempo',
  );
});

test('t107 AT4 — o quadro escapa HTML vindo do control plane', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);

  // O título é dado de usuário e chega por API sem autenticação (t124 é outra
  // ficha): interpolá-lo cru seria injeção de HTML na primeira tela do projeto.
  await criarTrabalho(cp, {
    titulo: '<script>alert("xss")</script> & cia',
    no_entrada_id: 'refinar',
  });

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, '/');

  assert.equal(pagina.status, 200);
  assert.ok(!pagina.html.includes('<script>alert'), 'título de trabalho não pode virar script');
  assert.ok(
    pagina.html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; cia'),
    'o título aparece escapado, e inteiro',
  );
});
