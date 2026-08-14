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
  rejeitarProposta,
  reverterProposta,
  type LinhaProposta,
} from '../repositorios/propostas.ts';

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
}

/** Resolve o `:id` da rota em uma proposta; id não numérico é 404, não 500. */
function carregar(db: BancoDeDados, id: string): LinhaProposta | undefined {
  const numero = Number(id);
  if (!Number.isInteger(numero)) return undefined;
  return buscarProposta(db, numero);
}
