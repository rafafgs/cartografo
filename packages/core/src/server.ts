/**
 * Fábrica do app HTTP do control plane.
 *
 * Recebe o banco já aberto em vez de abri-lo: quem decide o caminho do arquivo
 * e quando migrar é a partida (`src/index.ts`), e é o que deixa os testes
 * subirem o app contra um banco arbitrário — inclusive um corrompido de
 * propósito, para provar que `/health` checa mesmo.
 */

import Fastify, { type FastifyInstance } from 'fastify';

import type { BancoDeDados } from './db/connection.ts';
import { registrarSaude } from './routes/health.ts';

/**
 * Prefixo das rotas de negócio. Nasce vazio: as rotas entram nas tickets de
 * schema de domínio, na ordem da D6. `/health` fica fora dele (FR10).
 */
export const PREFIXO_API = '/v1';

/** Opções da fábrica do app. */
export interface OpcoesApp {
  /** Banco já aberto; o app nunca abre o seu. */
  db: BancoDeDados;
  /** Nível de log do Fastify. `false` desliga (default nos testes silenciosos). */
  logger?: boolean;
}

/**
 * Monta o app com a rota de saúde e o escopo versionado.
 *
 * @param opcoes Banco aberto e configuração de log.
 * @returns Instância do Fastify pronta para `listen`.
 */
export function criarApp(opcoes: OpcoesApp): FastifyInstance {
  const app = Fastify({ logger: opcoes.logger ?? false });

  registrarSaude(app, opcoes.db);

  // Escopo versionado, ainda sem rotas: existe desde já para que toda rota de
  // negócio nasça dentro dele, sem ninguém ter que lembrar da convenção.
  app.register(
    async () => {
      /* rotas de negócio entram aqui nas tickets seguintes (D6) */
    },
    { prefix: PREFIXO_API },
  );

  return app;
}
