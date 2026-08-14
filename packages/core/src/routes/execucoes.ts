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
import { listarEventos } from '../db/eventos.ts';
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

  /**
   * O log inteiro da execução, em ordem de `id` (t110, FR1).
   *
   * A linha do tempo por trabalho (`GET /v1/trabalhos/:id/eventos`) e a
   * contagem por versão (a rota acima) já existiam; o que faltava era o fluxo
   * ordenado da rodada INTEIRA, que é o que permite comparar nós entre si —
   * tempo por estado, gargalo, perguntas por nó. Leitura pura: `evento`
   * continua tendo um único escritor (`src/db/eventos.ts`).
   *
   * Sem paginação de propósito: uma execução da PoC cabe folgada numa resposta,
   * e um cursor que ninguém precisa é contrato para manter para sempre.
   */
  app.get('/execucoes/:id/eventos', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const execucaoId = idDaRota(requisicao.params);
      return { execucao_id: execucaoId, eventos: listarEventos(db, { execucao_id: execucaoId }) };
    }),
  );
}
