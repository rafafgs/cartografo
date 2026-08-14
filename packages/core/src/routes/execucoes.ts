/**
 * Rota da execução (t102, FR17).
 *
 * Não existe entidade "execução" nesta v1: `execucao_id` é um agrupador
 * INTEGER opaco, e a taxonomia nunca o listou como `entidade.tipo` válido
 * (`especificacoes/eventos/schemas/envelope.schema.json:41`). Por isso aqui só
 * existe leitura, e por isso uma execução sem trabalho nenhum responde 200 com
 * lista vazia em vez de 404: não há objeto para existir ou deixar de existir.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { metricasPorVersao } from '../repositorios/trabalho.ts';
import { comValidacao, idDaRota } from './comum.ts';

/**
 * Registra as rotas de execução no escopo `/v1`.
 *
 * @param app Escopo já prefixado.
 * @param db Banco aberto.
 */
export function registrarExecucoes(app: FastifyInstance, db: BancoDeDados): void {
  app.get('/execucoes/:id/metricas-por-versao', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const execucaoId = idDaRota(requisicao.params);
      return { execucao_id: execucaoId, metricas: metricasPorVersao(db, execucaoId) };
    }),
  );
}
