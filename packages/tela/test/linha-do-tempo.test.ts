/**
 * Testes de aceite da linha do tempo de um trabalho (t107, FR10).
 *
 * O conceito é o "tempo genérico" do t81 do flowpilot, citado no escopo da
 * ficha e em `notas/2026-08-14-aprendizado.md`: separar o tempo do trabalho em
 * FILA, AGENTE TRABALHANDO e ESPERANDO HUMANO. Sem essa separação, "demorou
 * dois dias" não diz nada — e é exatamente ela que o topógrafo vai ler quando
 * for propor mutação de grafo.
 *
 * A reconstrução acontece na TELA, a partir de três respostas HTTP, porque
 * nenhuma rota da API entrega isso pronta:
 *
 * - `GET /v1/trabalhos/:id/eventos` dá as transições, mas EXCLUI de propósito
 *   `sessao.finalizada` e `pergunta.respondida` (os schemas desses eventos não
 *   carregam `trabalho_id`; ver `packages/core/src/db/eventos.ts`);
 * - `GET /v1/sessoes?trabalho_id=` dá o fim das sessões;
 * - `GET /v1/perguntas?trabalho_id=` dá o fim das esperas.
 *
 * Os dois filtros `trabalho_id` são lacuna de API fechada nesta mesma ficha.
 *
 * Este arquivo cobra as duas metades: o cenário real ponta a ponta e a regra
 * dos três baldes como função pura, com instantes fabricados — é a única forma
 * de fixar a política de corte sem depender do relógio.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';

import type * as ModuloLinhaDoTempo from '../src/linha-do-tempo.ts';

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
  type Pergunta,
  type Sessao,
} from './apoio.ts';

/**
 * Folga entre os passos do cenário.
 *
 * Os carimbos do control plane têm precisão de milissegundo; dois pedidos
 * seguidos podem cair no MESMO instante e colapsar um segmento a zero. A folga
 * não é para "dar tempo" de nada — é para que o cenário tenha, de fato, os
 * intervalos que o teste afirma existir.
 */
const FOLGA_MS = 15;

/** Um segmento como a página o publica. */
interface SegmentoLido {
  categoria: string;
  inicio: string;
  fim: string;
}

function segmentosDa(html: string): SegmentoLido[] {
  return blocos(html, 'segmento').map((bloco) => ({
    categoria: bloco.valor,
    inicio: /data-inicio="([^"]*)"/.exec(bloco.trecho)?.[1] ?? '',
    fim: /data-fim="([^"]*)"/.exec(bloco.trecho)?.[1] ?? '',
  }));
}

test('t107 AT7 — GET /trabalhos/:id monta fila, agente e humano em ordem cronológica', async (t) => {
  exigirArtefatos(
    ARTEFATOS_T107.cliente,
    ARTEFATOS_T107.linhaDoTempo,
    ARTEFATOS_T107.paginas,
    ARTEFATOS_T107.servidor,
  );
  const cp = await subirControlPlane(t);

  const trabalho = await criarTrabalho(cp, {
    titulo: 'o trabalho observado',
    no_entrada_id: 'refinar',
    execucao_id: 7,
  });

  await esperar(FOLGA_MS);
  await api(cp, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, { para_no_id: 'implementar' });

  await esperar(FOLGA_MS);
  const sessao = await abrirSessao(cp, { trabalho_id: trabalho.id, no_id: 'implementar' });

  await esperar(FOLGA_MS);
  const finalizada = await api<Sessao>(cp, 'PATCH', `/v1/sessoes/${sessao.id}/finalizar`, {
    status: 'concluida',
    exit_code: 0,
  });
  assert.equal(finalizada.status, 200);

  await esperar(FOLGA_MS);
  const pergunta = await criarPergunta(cp, {
    trabalho_id: trabalho.id,
    pergunta: 'seguir assim?',
  });

  await esperar(FOLGA_MS);
  const respondida = await api<Pergunta>(cp, 'PATCH', `/v1/perguntas/${pergunta.id}/resposta`, {
    resposta: 'siga',
    respondido_por: 'rafael',
  });
  assert.equal(respondida.status, 200);

  const tela = await subirTela(t, cp.url);
  const pagina = await abrirPagina(tela, `/trabalhos/${trabalho.id}`);

  assert.equal(pagina.status, 200);
  assert.ok(pagina.html.includes(trabalho.titulo), 'a página se identifica pelo trabalho');

  const segmentos = segmentosDa(pagina.html);
  assert.ok(segmentos.length >= 3, `esperava ao menos três segmentos, veio ${segmentos.length}`);

  const categorias = segmentos.map((segmento) => segmento.categoria);
  assert.ok(categorias.includes('fila'), 'falta o balde de fila');
  assert.ok(categorias.includes('agente_trabalhando'), 'falta o balde de agente trabalhando');
  assert.ok(categorias.includes('esperando_humano'), 'falta o balde de espera por humano');

  assert.equal(categorias[0], 'fila', 'todo trabalho começa esperando alguém pegá-lo');
  assert.ok(
    categorias.indexOf('agente_trabalhando') < categorias.indexOf('esperando_humano'),
    'o agente trabalhou ANTES de a pergunta existir: a ordem é a dos fatos',
  );

  const instantes = segmentos.map((segmento) => segmento.inicio);
  assert.deepEqual(instantes, [...instantes].sort(), 'os segmentos saem em ordem cronológica');
  assert.equal(
    segmentos[0].inicio,
    trabalho.criado_em,
    'a linha do tempo começa quando o trabalho passou a existir',
  );

  const doAgente = segmentos.filter((segmento) => segmento.categoria === 'agente_trabalhando');
  assert.deepEqual(
    doAgente,
    [
      {
        categoria: 'agente_trabalhando',
        inicio: sessao.aberta_em,
        fim: finalizada.corpo.finalizada_em ?? '',
      },
    ],
    'o balde do agente é exatamente [aberta_em, finalizada_em] da sessão',
  );

  const doHumano = segmentos.filter((segmento) => segmento.categoria === 'esperando_humano');
  assert.deepEqual(
    doHumano,
    [
      {
        categoria: 'esperando_humano',
        inicio: pergunta.criada_em,
        fim: respondida.corpo.respondida_em ?? '',
      },
    ],
    'o balde do humano é exatamente [criada_em, respondida_em] da pergunta',
  );

  // O intervalo entre o agente terminar e a pergunta nascer não é trabalho de
  // ninguém: é fila. É o segmento que só existe porque as três fontes foram
  // cruzadas — a rota de eventos sozinha não conhece o fim da sessão.
  assert.ok(
    segmentos.some(
      (segmento) =>
        segmento.categoria === 'fila' &&
        segmento.inicio === finalizada.corpo.finalizada_em &&
        segmento.fim === pergunta.criada_em,
    ),
    'a folga entre o fim da sessão e a criação da pergunta é fila',
  );

  // Nenhuma leitura de banco: a tela não tem por onde. A prova estática é
  // `no-privileged-access.test.ts` (AT16–AT18), que roda sobre o pacote inteiro.
  assert.ok(
    !pagina.html.includes('cartografo.db'),
    'a tela não conhece — nem menciona — o arquivo do banco',
  );
});

test('t107 AT7 — trabalho inexistente é 404 na tela', async (t) => {
  exigirArtefatos(ARTEFATOS_T107.paginas, ARTEFATOS_T107.servidor);
  const cp = await subirControlPlane(t);
  const tela = await subirTela(t, cp.url);

  const pagina = await abrirPagina(tela, '/trabalhos/424242');
  assert.equal(pagina.status, 404, 'trabalho é entidade: ausência é 404, não página vazia');
});

test('t107 AT7 — a regra dos três baldes, como função pura', async () => {
  exigirArtefatos(ARTEFATOS_T107.linhaDoTempo);
  const { montarLinhaDoTempo } = (await import(
    new URL('../src/linha-do-tempo.ts', import.meta.url).href
  )) as typeof ModuloLinhaDoTempo;

  const instante = (minuto: number): string =>
    `2026-08-14T10:${String(minuto).padStart(2, '0')}:00.000Z`;

  const linha = montarLinhaDoTempo({
    eventos: [
      {
        id: 1,
        tipo: 'trabalho.criado',
        ocorrido_em: instante(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      {
        id: 2,
        tipo: 'trabalho.transicao',
        ocorrido_em: instante(10),
        dados: { de_no_id: null, para_no_id: 'implementar' },
      },
      { id: 3, tipo: 'sessao.aberta', ocorrido_em: instante(20), dados: { trabalho_id: 1 } },
      { id: 4, tipo: 'pergunta.criada', ocorrido_em: instante(40), dados: { trabalho_id: 1 } },
    ],
    sessoes: [{ id: 1, engine: 'claude-code', status: 'concluida', aberta_em: instante(20), finalizada_em: instante(30) }],
    perguntas: [
      { id: 1, status: 'respondida', pergunta: 'e aí?', criada_em: instante(40), respondida_em: instante(50) },
    ],
  });

  assert.deepEqual(
    linha.segmentos.map((segmento) => [segmento.categoria, segmento.inicio, segmento.fim]),
    [
      ['fila', instante(0), instante(10)],
      ['fila', instante(10), instante(20)],
      ['agente_trabalhando', instante(20), instante(30)],
      ['fila', instante(30), instante(40)],
      ['esperando_humano', instante(40), instante(50)],
    ],
    'fila é o complemento: todo intervalo sem sessão aberta e sem pergunta pendente',
  );

  assert.deepEqual(
    linha.segmentos.filter((segmento) => segmento.categoria === 'fila').map((s) => s.no_id),
    ['refinar', 'implementar', 'implementar'],
    'cada fila sabe em que nó o trabalho estava parado — a transição corta o segmento',
  );

  assert.equal(linha.concluido, true, 'sem sessão aberta, sem pendência e sem bloqueio');
  assert.deepEqual(linha.totais, {
    fila: 30 * 60_000,
    agente_trabalhando: 10 * 60_000,
    esperando_humano: 10 * 60_000,
  });
});

test('t107 AT7 — sessão aberta e pergunta pendente ficam em aberto, e o trabalho não é concluído', async () => {
  exigirArtefatos(ARTEFATOS_T107.linhaDoTempo);
  const { montarLinhaDoTempo } = (await import(
    new URL('../src/linha-do-tempo.ts', import.meta.url).href
  )) as typeof ModuloLinhaDoTempo;

  const instante = (minuto: number): string =>
    `2026-08-14T10:${String(minuto).padStart(2, '0')}:00.000Z`;

  const linha = montarLinhaDoTempo({
    eventos: [
      {
        id: 1,
        tipo: 'trabalho.criado',
        ocorrido_em: instante(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      { id: 2, tipo: 'sessao.aberta', ocorrido_em: instante(10), dados: { trabalho_id: 1 } },
      { id: 3, tipo: 'pergunta.criada', ocorrido_em: instante(20), dados: { trabalho_id: 1 } },
    ],
    sessoes: [{ id: 1, engine: 'claude-code', status: 'aberta', aberta_em: instante(10), finalizada_em: null }],
    perguntas: [
      { id: 1, status: 'pendente', pergunta: 'e aí?', criada_em: instante(20), respondida_em: null },
    ],
  });

  assert.deepEqual(
    linha.segmentos.map((segmento) => [segmento.categoria, segmento.inicio, segmento.fim]),
    [
      ['fila', instante(0), instante(10)],
      ['agente_trabalhando', instante(10), null],
      ['esperando_humano', instante(20), null],
    ],
    'o que não terminou fica aberto, e não é fechado com o relógio de quem lê',
  );
  assert.equal(linha.concluido, false);
  assert.deepEqual(
    linha.totais,
    { fila: 10 * 60_000, agente_trabalhando: 0, esperando_humano: 0 },
    'segmento aberto não entra no total: sua duração ainda não é um fato',
  );
});

test('t107 AT7 — trabalho bloqueado e parado continua acumulando fila, em aberto', async () => {
  exigirArtefatos(ARTEFATOS_T107.linhaDoTempo);
  const { montarLinhaDoTempo } = (await import(
    new URL('../src/linha-do-tempo.ts', import.meta.url).href
  )) as typeof ModuloLinhaDoTempo;

  const instante = (minuto: number): string =>
    `2026-08-14T10:${String(minuto).padStart(2, '0')}:00.000Z`;

  const linha = montarLinhaDoTempo({
    eventos: [
      {
        id: 1,
        tipo: 'trabalho.criado',
        ocorrido_em: instante(0),
        dados: { titulo: 'x', no_entrada_id: 'refinar' },
      },
      { id: 2, tipo: 'trabalho.bloqueado', ocorrido_em: instante(5), dados: { motivo: 'travou' } },
    ],
    sessoes: [],
    perguntas: [],
  });

  assert.equal(linha.bloqueado, true);
  assert.equal(linha.concluido, false, 'bloqueado não é concluído, ainda que nada esteja aberto');
  assert.deepEqual(
    linha.segmentos.map((segmento) => [segmento.categoria, segmento.inicio, segmento.fim]),
    [['fila', instante(0), null]],
    'sem nada aberto e sem conclusão, a fila corrente continua correndo',
  );
});
