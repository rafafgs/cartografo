/**
 * Rotas do trabalho (t102, FR4–FR9).
 *
 * As escritas são sub-recursos no plural (`/transicoes`, `/bloqueios`,
 * `/desbloqueios`) em vez de um `PATCH` com campo de estado: cada uma
 * corresponde a um FATO distinto do log, e uma rota por fato é o que impede
 * alguém de "corrigir" a posição de um trabalho no grafo sem deixar rastro. O
 * `PATCH` fica só para o que é de fato edição de conteúdo (FR7).
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { inteiroDaQuery } from '../repositorios/comum.ts';
import {
  bloquearTrabalho,
  buscarTrabalho,
  criarTrabalho,
  desbloquearTrabalho,
  emendarTrabalho,
  linhaDoTempoDoTrabalho,
  listarTrabalhos,
  transicionarTrabalho,
  type Trabalho,
} from '../repositorios/trabalho.ts';
import { comValidacao, idDaRota, naoEncontrado } from './comum.ts';

/**
 * Registra as rotas de trabalho no escopo `/v1`.
 *
 * @param app Escopo já prefixado.
 * @param db Banco aberto.
 */
export function registrarTrabalhos(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/trabalhos', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const trabalho = criarTrabalho(db, (requisicao.body ?? {}) as Record<string, unknown>);
      resposta.code(201);
      return trabalho;
    }),
  );

  app.get('/trabalhos', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const execucaoId = inteiroDaQuery(
        'execucao_id',
        (requisicao.query as { execucao_id?: string }).execucao_id,
      );
      return { trabalhos: listarTrabalhos(db, { execucao_id: execucaoId }) };
    }),
  );

  app.get('/trabalhos/:id', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const trabalho = buscarTrabalho(db, idDaRota(requisicao.params));
      return trabalho ?? naoEncontrado(resposta, 'trabalho');
    }),
  );

  app.get('/trabalhos/:id/eventos', async (requisicao, resposta) =>
    comValidacao(resposta, () => {
      const eventos = linhaDoTempoDoTrabalho(db, idDaRota(requisicao.params));
      return eventos === null ? naoEncontrado(resposta, 'trabalho') : { eventos };
    }),
  );

  /** As três escritas que só mudam a projeção de um trabalho existente. */
  const escrita = (
    caminho: string,
    metodo: 'post' | 'patch',
    aplicar: (id: number, corpo: Record<string, unknown>) => Trabalho | null,
  ): void => {
    app[metodo](caminho, async (requisicao, resposta) =>
      comValidacao(resposta, () => {
        const atualizado = aplicar(
          idDaRota(requisicao.params),
          (requisicao.body ?? {}) as Record<string, unknown>,
        );
        return atualizado ?? naoEncontrado(resposta, 'trabalho');
      }),
    );
  };

  escrita('/trabalhos/:id/transicoes', 'post', (id, corpo) =>
    transicionarTrabalho(db, id, corpo),
  );
  escrita('/trabalhos/:id/bloqueios', 'post', (id, corpo) => bloquearTrabalho(db, id, corpo));
  escrita('/trabalhos/:id/desbloqueios', 'post', (id, corpo) =>
    desbloquearTrabalho(db, id, corpo),
  );
  escrita('/trabalhos/:id', 'patch', (id, corpo) => emendarTrabalho(db, id, corpo));
}
