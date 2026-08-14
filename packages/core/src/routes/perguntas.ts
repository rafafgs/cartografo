/**
 * Rotas da pergunta (t102, FR13–FR16).
 *
 * As duas formas de responder são rotas SEPARADAS de propósito
 * (`/resposta` e `/auto_resolucao`), e não uma rota com um campo `origem`: a
 * distinção entre aprovado-por-gente e aprovado-pelo-sistema é justamente a que
 * ninguém pode conseguir apagar passando um parâmetro diferente.
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { inteiroDaQuery } from '../repositorios/comum.ts';
import {
  autoResolverPergunta,
  buscarPrecedentes,
  criarPergunta,
  listarPerguntas,
  responderPergunta,
} from '../repositorios/pergunta.ts';
import { comValidacao, idDaRota, naoEncontrado } from './comum.ts';

/**
 * Registra as rotas de pergunta no escopo `/v1`.
 *
 * @param app Escopo já prefixado.
 * @param db Banco aberto.
 */
export function registrarPerguntas(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/perguntas', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const pergunta = criarPergunta(db, (requisicao.body ?? {}) as Record<string, unknown>);
      if (pergunta === null) return naoEncontrado(resposta, 'trabalho');
      resposta.code(201);
      return pergunta;
    }),
  );

  app.patch('/perguntas/:id/resposta', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const pergunta = responderPergunta(
        db,
        idDaRota(requisicao.params),
        (requisicao.body ?? {}) as Record<string, unknown>,
      );
      return pergunta ?? naoEncontrado(resposta, 'pergunta');
    }),
  );

  app.patch('/perguntas/:id/auto_resolucao', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const pergunta = autoResolverPergunta(
        db,
        idDaRota(requisicao.params),
        (requisicao.body ?? {}) as Record<string, unknown>,
      );
      return pergunta ?? naoEncontrado(resposta, 'pergunta');
    }),
  );

  app.get('/perguntas', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const consulta = requisicao.query as { status?: string; execucao_id?: string };
      return {
        perguntas: listarPerguntas(db, {
          status: consulta.status,
          execucao_id: inteiroDaQuery('execucao_id', consulta.execucao_id),
        }),
      };
    }),
  );

  // A base de precedentes é rota PRÓPRIA, e não um campo de `GET /perguntas`:
  // embutida na lista, ela custaria uma varredura de similaridade de toda
  // pergunta contra toda respondida a cada chamada, para servir uma informação
  // que só interessa quando alguém abre UMA pergunta para responder.
  app.get('/perguntas/:id/precedentes', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const consulta = requisicao.query as { limite?: string };
      const precedentes = buscarPrecedentes(db, idDaRota(requisicao.params), {
        limite: inteiroDaQuery('limite', consulta.limite),
      });
      // Lista vazia é resposta legítima: "ninguém perguntou isso antes" é um
      // fato sobre o projeto, não uma falha da consulta.
      return precedentes === null ? naoEncontrado(resposta, 'pergunta') : { precedentes };
    }),
  );
}
