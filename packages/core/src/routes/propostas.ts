/**
 * Rotas de proposta (t101, FR7/FR8/FR9).
 *
 * `POST /propostas/:id/aplicar` é o fluxo inteiro da D15 em um handler:
 * aplicar ops → validar soundness no RESULTADO → gravar versão nova → mover
 * ponteiro. A ordem não é negociável: o portão roda sobre o documento que
 * sairia, não sobre o que entrou, porque é a composição das operações que
 * quebra o grafo — cada uma delas isolada pode ser impecável.
 *
 * Rejeição não apaga a proposta: ela vira `rejeitada` com o relatório em
 * `resultado`. Uma hipótese reprovada é evidência para o topógrafo (t110),
 * não lixo.
 *
 * Concorrência entre propostas é fora de escopo (t118): se a base andou debaixo
 * da proposta, ela é recusada com 409 em vez de rebaseada automaticamente.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { validarGrafo } from '../dominio/grafo.ts';
import { hashSnapshot } from '../dominio/hash.ts';
import { isExpectedMetric, validateExpectedMetric, verdictFor } from '../dominio/hypothesis.ts';
import {
  aplicarOperacoes,
  validarOperacao,
  ErroDeAplicacao,
  type Operacao,
} from '../dominio/operacoes.ts';
import { buscarGrafo, buscarVersao } from '../repositorios/grafos.ts';
import {
  aplicarProposta,
  buscarProposta,
  criarProposta,
  listProposals,
  recordVerdict,
  rejeitarProposta,
  reverterProposta,
  type LinhaProposta,
} from '../repositorios/propostas.ts';
import { metricasPorVersao } from '../repositorios/trabalho.ts';

interface ParametroId {
  Params: { id: string };
}

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Registra as rotas de proposta no escopo recebido (já com o prefixo /v1).
 *
 * @param app Escopo do Fastify.
 * @param db Banco já aberto; as rotas nunca abrem o seu (D1).
 */
export function registrarPropostas(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/propostas', async (requisicao, resposta) => {
    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};

    const grafoId = corpo.grafo_id;
    if (typeof grafoId !== 'string' || buscarGrafo(db, grafoId) === undefined) {
      resposta.code(400);
      return { erro: 'grafo_desconhecido', grafo_id: grafoId ?? null };
    }

    const versaoAlvo = corpo.versao_alvo;
    const versao = typeof versaoAlvo === 'string' ? buscarVersao(db, versaoAlvo) : undefined;
    if (versao === undefined || versao.grafo_id !== grafoId) {
      resposta.code(400);
      return {
        erro: 'versao_alvo_desconhecida',
        mensagem: 'versao_alvo precisa existir e pertencer a grafo_id',
        versao_alvo: versaoAlvo ?? null,
      };
    }

    if (corpo.evidencia === undefined || corpo.metrica_esperada === undefined) {
      resposta.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem:
          'proposta é hipótese: evidencia e metrica_esperada são obrigatórias (D15, nota de aprendizado)',
      };
    }

    const brutas = corpo.operacoes;
    if (!Array.isArray(brutas) || brutas.length === 0) {
      resposta.code(400);
      return { erro: 'operacoes_invalidas', mensagem: 'operacoes precisa ser uma lista não vazia' };
    }

    const problemas = brutas
      .map((operacao, indice) => ({ indice, ...validarOperacao(operacao) }))
      .filter((relatorio) => !relatorio.valido)
      .map((relatorio) => ({ indice: relatorio.indice, erros: relatorio.erros }));
    if (problemas.length > 0) {
      resposta.code(400);
      return { erro: 'operacoes_invalidas', operacoes: problemas };
    }

    const proposta = criarProposta(db, {
      grafo_id: grafoId,
      versao_alvo: versaoAlvo as string,
      operacoes: brutas as Operacao[],
      evidencia: corpo.evidencia,
      metrica_esperada: corpo.metrica_esperada,
    });

    resposta.code(201);
    return { proposta };
  });

  app.post<ParametroId>('/propostas/:id/aplicar', async (requisicao, resposta) => {
    const proposta = carregar(db, requisicao.params.id);
    if (proposta === undefined) {
      resposta.code(404);
      return { erro: 'proposta_desconhecida', id: requisicao.params.id };
    }

    if (proposta.status !== 'pendente') {
      resposta.code(409);
      return {
        erro: 'proposta_nao_pendente',
        mensagem: `só proposta pendente pode ser aplicada; esta está "${proposta.status}"`,
        status: proposta.status,
      };
    }

    const grafo = buscarGrafo(db, proposta.grafo_id);
    if (grafo === undefined) {
      resposta.code(404);
      return { erro: 'grafo_desconhecido', grafo_id: proposta.grafo_id };
    }

    if (grafo.versao_corrente_id !== proposta.versao_alvo) {
      resposta.code(409);
      return {
        erro: 'proposta_desatualizada',
        mensagem: 'a base mudou desde que a proposta foi escrita; refazer o diff é do topógrafo',
        versao_alvo: proposta.versao_alvo,
        versao_corrente: grafo.versao_corrente_id,
      };
    }

    const alvo = buscarVersao(db, proposta.versao_alvo);
    if (alvo === undefined) {
      resposta.code(404);
      return { erro: 'grafo_versao_desconhecida', id: proposta.versao_alvo };
    }

    let documento;
    try {
      documento = aplicarOperacoes(alvo.snapshot, proposta.operacoes);
    } catch (erro) {
      if (!(erro instanceof ErroDeAplicacao)) throw erro;
      const relatorio = {
        erro: 'operacao_inaplicavel',
        codigo: erro.codigo,
        mensagem: erro.message,
        alvo: erro.alvo,
      };
      resposta.code(422);
      return { ...relatorio, proposta: rejeitarProposta(db, proposta.id, relatorio) };
    }

    // O portão: soundness roda ANTES de qualquer gravação, sobre o documento que
    // sairia. Reprovado, nada entra no banco além do status e do relatório.
    const relatorio = validarGrafo(documento);
    if (!relatorio.valido) {
      resposta.code(422);
      return {
        erro: 'grafo_invalido',
        ...relatorio,
        proposta: rejeitarProposta(db, proposta.id, relatorio),
      };
    }

    const versaoId = hashSnapshot(documento);
    if (buscarVersao(db, versaoId) !== undefined) {
      // O hash É a identidade da versão: um resultado idêntico a uma versão já
      // conhecida não é uma versão nova, é uma proposta sem efeito.
      const semEfeito = {
        erro: 'versao_sem_efeito',
        mensagem: 'as operações produzem um snapshot que já existe na linhagem',
        versao_existente: versaoId,
      };
      resposta.code(422);
      return { ...semEfeito, proposta: rejeitarProposta(db, proposta.id, semEfeito) };
    }

    const gravada = aplicarProposta(db, { proposta, versaoId, documento });
    return {
      proposta: gravada.proposta,
      grafo: buscarGrafo(db, proposta.grafo_id),
      grafo_versao: gravada.versao,
    };
  });

  app.post<ParametroId>('/propostas/:id/reverter', async (requisicao, resposta) => {
    const proposta = carregar(db, requisicao.params.id);
    if (proposta === undefined) {
      resposta.code(404);
      return { erro: 'proposta_desconhecida', id: requisicao.params.id };
    }

    // Motivo antes de status: é o campo que o evento `grafo_versao.revertida`
    // exige, e é a evidência que o topógrafo vai cruzar com a telemetria da
    // versão abandonada. Reverter sem dizer por quê perde a metade útil do fato.
    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};
    const motivo = corpo.motivo;
    if (typeof motivo !== 'string' || motivo.trim() === '') {
      resposta.code(400);
      return {
        erro: 'motivo_obrigatorio',
        mensagem: 'reverter exige motivo: é a evidência cruzada com a telemetria da versão abandonada',
      };
    }

    if (proposta.status !== 'aplicada') {
      resposta.code(409);
      return {
        erro: 'proposta_nao_aplicada',
        mensagem: `só proposta aplicada pode ser revertida; esta está "${proposta.status}"`,
        status: proposta.status,
      };
    }

    const grafo = buscarGrafo(db, proposta.grafo_id);
    if (grafo === undefined) {
      resposta.code(404);
      return { erro: 'grafo_desconhecido', grafo_id: proposta.grafo_id };
    }

    // Reverter é o par exato desta proposta. Se outra versão entrou por cima, o
    // ponteiro pularia versões intermediárias — navegação livre de histórico é
    // outra coisa, e está fora desta ticket.
    if (grafo.versao_corrente_id !== proposta.versao_aplicada_id) {
      resposta.code(409);
      return {
        erro: 'proposta_desatualizada',
        mensagem: 'a versão aplicada por esta proposta não é mais a corrente',
        versao_aplicada_id: proposta.versao_aplicada_id,
        versao_corrente: grafo.versao_corrente_id,
      };
    }

    const revertida = reverterProposta(db, { proposta, motivo });
    return { proposta: revertida, grafo: buscarGrafo(db, proposta.grafo_id) };
  });

  /* ------------------------------------------------------------------------ */
  /* t112 — the next run closes the proposal. New identifiers in English (D18); */
  /* route segments and payload keys stay in Portuguese, as already published.  */
  /* ------------------------------------------------------------------------ */

  app.post<ParametroId>('/propostas/:id/resultado', async (requisicao, resposta) => {
    const proposta = carregar(db, requisicao.params.id);
    if (proposta === undefined) {
      resposta.code(404);
      return { erro: 'proposta_desconhecida', id: requisicao.params.id };
    }

    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};
    const execucaoId = corpo.execucao_id;
    const depois = corpo.depois;
    if (!Number.isInteger(execucaoId) || !Number.isFinite(depois)) {
      resposta.code(400);
      return {
        erro: 'campo_obrigatorio_ausente',
        mensagem:
          'fechar o experimento exige execucao_id (inteiro) e depois (número): quem calcula a métrica é quem chama',
      };
    }

    if (proposta.status !== 'aplicada') {
      resposta.code(409);
      return {
        erro: 'proposta_nao_aplicada',
        mensagem: `só proposta aplicada tem experimento a fechar; esta está "${proposta.status}"`,
        status: proposta.status,
      };
    }

    // Só a primeira chamada conta. Reavaliar seria reescrever o passado de uma
    // hipótese, e a coluna guarda UM resultado, o da primeira rodada seguinte.
    if (proposta.resultado !== null) {
      resposta.code(409);
      return {
        erro: 'proposta_ja_avaliada',
        mensagem: 'o resultado desta hipótese já foi gravado pela primeira execução seguinte',
        resultado: proposta.resultado,
      };
    }

    const metrica = proposta.metrica_esperada;
    if (!isExpectedMetric(metrica)) {
      // A criação nunca validou esta forma (fora de escopo aqui): uma proposta
      // aplicada pode perfeitamente carregar métrica que ninguém consegue ler.
      // Calcular veredito sobre dado incompleto é pior do que não calcular.
      resposta.code(422);
      return {
        erro: 'metrica_esperada_invalida',
        mensagem:
          'metrica_esperada precisa ter a forma {nome, direcao: "sobe"|"cai", de, para} para haver veredito',
        detalhes: validateExpectedMetric(metrica).map((problema) => problema.message),
      };
    }

    // "A execução seguinte" tem que ser demonstrável pela telemetria (FR17 do
    // t102), não alegada no corpo: sem trabalho registrado sob a versão que
    // esta proposta aplicou, não há rodada seguinte de que falar.
    const versaoAplicada = proposta.versao_aplicada_id;
    const evidencia = metricasPorVersao(db, execucaoId as number).find(
      (linha) => linha.grafo_versao_id === versaoAplicada,
    );
    if (versaoAplicada === null || evidencia === undefined || evidencia.trabalhos < 1) {
      resposta.code(422);
      return {
        erro: 'execucao_sem_evidencia',
        mensagem: 'nenhum trabalho desta execução rodou sob a versão que a proposta aplicou',
        execucao_id: execucaoId,
        versao_aplicada_id: versaoAplicada,
      };
    }

    const gravada = recordVerdict(db, {
      proposta,
      execucaoId: execucaoId as number,
      depois: depois as number,
      veredito: verdictFor(metrica, depois as number),
      antes: metrica.de,
    });

    // O status continua `aplicada` de propósito: "piorou" é dado, não ação.
    // Reverter é decisão humana, pela rota de reversão (README, princípio 5).
    return { proposta: gravada };
  });

  app.get('/propostas', async (requisicao) => {
    const filtro = requisicao.query as { status?: string; veredito?: string };
    return {
      propostas: listProposals(db, {
        status: optionalFilter(filtro.status),
        veredito: optionalFilter(filtro.veredito),
      }),
    };
  });
}

/** An absent or empty querystring filter means "no filter", not "empty". */
function optionalFilter(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/** Resolve o `:id` da rota em uma proposta; id não numérico é 404, não 500. */
function carregar(db: BancoDeDados, id: string): LinhaProposta | undefined {
  const numero = Number(id);
  if (!Number.isInteger(numero)) return undefined;
  return buscarProposta(db, numero);
}
