/**
 * Prova de consistência entre log e projeção (t102, AT17 / FR19).
 *
 * O inegociável de qualidade é reprodutibilidade por event sourcing: o estado
 * final tem que sair do LOG e de mais nada. `reducers/reconstruir-estado.mjs`
 * (t98) é a referência executável disso — foi escrito antes do control plane
 * existir, justamente para ser o contrato que as tabelas de projeção desta
 * ficha teriam que respeitar.
 *
 * Este teste fecha o círculo: roda uma execução pela API, dobra o log com o
 * reducer da especificação e exige que o resultado bata, campo a campo, com o
 * que as tabelas respondem. Se um dia a projeção souber algo que o log não
 * conta, é aqui que aparece.
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
  type Evento,
  type Pergunta,
  type Sessao,
  type Trabalho,
} from './apoio.ts';

/** O reducer vive na especificação, fora do pacote — é a referência, não código do core. */
const REDUCER = '../../../especificacoes/eventos/reducers/reconstruir-estado.mjs';

interface EstadoReconstruido {
  trabalhos: Record<string, { no_atual: string; bloqueado: boolean; historico_nos: string[] }>;
  sessoes: Record<string, { status: string; exit_code: number | null }>;
  perguntas: Record<
    string,
    { status: string; resposta: string | null; origem: string | null }
  >;
}

const EXECUCAO = 7;

/** Histórico de nós de um trabalho, derivado só da API (criado + transições). */
async function historicoPelaApi(ctx: ContextoTeste, trabalhoId: number): Promise<string[]> {
  const resposta = await pedir<{ eventos: Evento[] }>(
    ctx,
    'GET',
    `/v1/trabalhos/${trabalhoId}/eventos`,
  );
  assert.equal(resposta.status, 200);

  const historico: string[] = [];
  for (const evento of resposta.corpo.eventos) {
    if (evento.tipo === 'trabalho.criado') historico.push(evento.dados.no_entrada_id as string);
    if (evento.tipo === 'trabalho.transicao') historico.push(evento.dados.para_no_id as string);
  }
  return historico;
}

test('AT17 — o reducer da especificação reproduz exatamente as tabelas de projeção', async (t) => {
  exigirArtefatos(...Object.values(ARTEFATOS_T102));
  const ctx = await subirControlPlane(t);
  const { listarEventos } = await carregarEventos();
  const { reconstruirEstado } = (await import(new URL(REDUCER, import.meta.url).href)) as {
    reconstruirEstado: (eventos: Evento[]) => EstadoReconstruido;
  };

  // --- a execução, ponta a ponta, só pela API --------------------------------
  const trabalho = await criarTrabalho(ctx, {
    titulo: 'trabalho que anda',
    no_entrada_id: 'entrada',
    execucao_id: EXECUCAO,
    grafo_versao_id: 'v1',
  });
  await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, {
    para_no_id: 'refinamento',
  });
  await pedir(ctx, 'POST', `/v1/trabalhos/${trabalho.id}/transicoes`, {
    para_no_id: 'desenvolvimento',
  });
  await pedir(ctx, 'PATCH', `/v1/trabalhos/${trabalho.id}`, { titulo: 'título emendado' });

  const sessao = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
    trabalho_id: trabalho.id,
    no_id: 'desenvolvimento',
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'implemente a ficha',
    timeout_seconds: 5400,
  });
  assert.equal(sessao.status, 201);

  const pergunta = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: trabalho.id,
    sessao_id: sessao.corpo.id,
    tipo: 'pergunta',
    pergunta: 'renumerar a migração?',
    recomendacao: 'manter 0002',
    auto_aprovavel: true,
  });
  assert.equal(pergunta.status, 201);

  await pedir(ctx, 'PATCH', `/v1/perguntas/${pergunta.corpo.id}/resposta`, {
    resposta: 'manter 0002',
    respondido_por: 'rafael',
  });
  await pedir(ctx, 'PATCH', `/v1/sessoes/${sessao.corpo.id}/finalizar`, {
    status: 'concluida',
    exit_code: 0,
    uso: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });

  // Um segundo trabalho, bloqueado e auto-resolvido: cobre as pontas que a
  // sequência principal não toca (bandeira de bloqueio, origem automática).
  const parado = await criarTrabalho(ctx, {
    titulo: 'trabalho que para',
    no_entrada_id: 'entrada',
    execucao_id: EXECUCAO,
    grafo_versao_id: 'v2',
  });
  const auto = await pedir<Pergunta>(ctx, 'POST', '/v1/perguntas', {
    trabalho_id: parado.id,
    tipo: 'aprovacao',
    pergunta: 'aprova o artefato?',
    resposta_padrao: 'aprovar',
    auto_aprovavel: true,
  });
  assert.equal(auto.status, 201);
  await pedir(ctx, 'PATCH', `/v1/perguntas/${auto.corpo.id}/auto_resolucao`, {
    resposta: 'aprovar',
    baseada_em: 'resposta_padrao',
  });
  // O bloqueio manual vem DEPOIS da auto-resolução desde t106: perguntar já
  // bloqueia e responder já desbloqueia (na mesma transação), então bloquear
  // antes deixaria o trabalho destravado no fim e a ponta "bandeira levantada"
  // sem cobertura nenhuma. A sequência de agora exercita as duas origens de
  // bloqueio — a automática da escalação e a manual.
  await pedir(ctx, 'POST', `/v1/trabalhos/${parado.id}/bloqueios`, { motivo: 'esperando humano' });
  const outraSessao = await pedir<Sessao>(ctx, 'POST', '/v1/sessoes', {
    execucao_id: EXECUCAO,
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'sessão que fica aberta',
  });
  assert.equal(outraSessao.status, 201);

  // --- o estado, reconstruído só a partir do log ----------------------------
  const eventos = listarEventos(ctx.db);
  assert.ok(eventos.length > 0, 'o log não pode estar vazio');
  const estado = reconstruirEstado(eventos);

  // --- o estado, como as tabelas de projeção o respondem --------------------
  const trabalhos = await pedir<{ trabalhos: Trabalho[] }>(
    ctx,
    'GET',
    `/v1/trabalhos?execucao_id=${EXECUCAO}`,
  );
  const sessoes = await pedir<{ sessoes: Sessao[] }>(
    ctx,
    'GET',
    `/v1/sessoes?execucao_id=${EXECUCAO}`,
  );
  const perguntas = await pedir<{ perguntas: Pergunta[] }>(
    ctx,
    'GET',
    `/v1/perguntas?execucao_id=${EXECUCAO}`,
  );

  const projetadoTrabalhos: EstadoReconstruido['trabalhos'] = {};
  for (const linha of trabalhos.corpo.trabalhos) {
    projetadoTrabalhos[String(linha.id)] = {
      no_atual: linha.no_atual,
      bloqueado: linha.bloqueado,
      historico_nos: await historicoPelaApi(ctx, linha.id),
    };
  }

  const projetadoSessoes: EstadoReconstruido['sessoes'] = {};
  for (const linha of sessoes.corpo.sessoes) {
    projetadoSessoes[String(linha.id)] = { status: linha.status, exit_code: linha.exit_code };
  }

  const projetadoPerguntas: EstadoReconstruido['perguntas'] = {};
  for (const linha of perguntas.corpo.perguntas) {
    projetadoPerguntas[String(linha.id)] = {
      status: linha.status,
      resposta: linha.resposta,
      origem: linha.origem,
    };
  }

  // --- e os dois têm que ser a mesma coisa ----------------------------------
  assert.deepEqual(estado.trabalhos, projetadoTrabalhos);
  assert.deepEqual(estado.sessoes, projetadoSessoes);
  assert.deepEqual(estado.perguntas, projetadoPerguntas);

  // Guardas contra um acerto vazio dos três deepEqual acima.
  assert.equal(Object.keys(estado.trabalhos).length, 2);
  assert.equal(Object.keys(estado.sessoes).length, 2);
  assert.equal(Object.keys(estado.perguntas).length, 2);
  assert.deepEqual(estado.trabalhos[String(trabalho.id)].historico_nos, [
    'entrada',
    'refinamento',
    'desenvolvimento',
  ]);
  assert.equal(estado.trabalhos[String(parado.id)].bloqueado, true);
  assert.equal(estado.perguntas[String(auto.corpo.id)].origem, 'auto');
  assert.equal(estado.sessoes[String(outraSessao.corpo.id)].status, 'aberta');
});
