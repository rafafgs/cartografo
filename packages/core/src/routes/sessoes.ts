/**
 * Rotas da sessão (t102, FR10–FR12).
 *
 * Quem chama estas rotas é o runner (t103): ele despacha a CLI pelo
 * EngineAdapter e reporta a abertura e o fim ao control plane, que é o único
 * que escreve no banco (D1). O runner nunca abre o SQLite.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { inteiroDaQuery } from '../repositorios/comum.ts';
import { abrirSessao, finalizarSessao, listarSessoes } from '../repositorios/sessao.ts';
import { comValidacao, idDaRota, naoEncontrado } from './comum.ts';

/**
 * Registra as rotas de sessão no escopo `/v1`.
 *
 * @param app Escopo já prefixado.
 * @param db Banco aberto.
 */
export function registrarSessoes(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/sessoes', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const sessao = abrirSessao(db, (requisicao.body ?? {}) as Record<string, unknown>);
      if (sessao === null) return naoEncontrado(resposta, 'trabalho');
      resposta.code(201);
      return sessao;
    }),
  );

  app.patch('/sessoes/:id/finalizar', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const sessao = finalizarSessao(
        db,
        idDaRota(requisicao.params),
        (requisicao.body ?? {}) as Record<string, unknown>,
      );
      return sessao ?? naoEncontrado(resposta, 'sessão');
    }),
  );

  app.get('/sessoes', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const consulta = requisicao.query as { execucao_id?: string; trabalho_id?: string };
      return {
        sessoes: listarSessoes(db, {
          execucao_id: inteiroDaQuery('execucao_id', consulta.execucao_id),
          trabalho_id: inteiroDaQuery('trabalho_id', consulta.trabalho_id),
        }),
      };
    }),
  );
}
