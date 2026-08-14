/**
 * `GET /health` — probe de infraestrutura do control plane.
 *
 * Fica FORA do prefixo `/v1` de propósito (FR10): quem consulta saúde é
 * supervisor de processo, orquestrador ou script de partida, e nenhum deles
 * deve ter que acompanhar a versão da API de negócio.
 *
 * O campo `db` é o resultado de um `SELECT 1` de verdade — a rota responde 503
 * quando o banco não responde, para que um supervisor consiga distinguir
 * "processo vivo" de "processo útil".
 */

import type { FastifyInstance } from 'fastify';

import { checarBanco, type BancoDeDados } from '../db/connection.ts';

/** Corpo da resposta de `/health`. A ordem das chaves é parte do contrato. */
export interface RespostaSaude {
  status: 'ok' | 'erro';
  db: 'ok' | 'erro';
}

/**
 * Schema de resposta declarado (D9: contrato explícito em toda rota). Além de
 * documentar, é ele que fixa a ordem das chaves na serialização — o teste de
 * aceite compara o corpo byte a byte.
 */
const SCHEMA_RESPOSTA = {
  type: 'object',
  properties: {
    status: { type: 'string' },
    db: { type: 'string' },
  },
  required: ['status', 'db'],
  additionalProperties: false,
} as const;

/**
 * Registra `GET /health` na instância dada.
 *
 * @param app Instância do Fastify (a raiz, não o escopo do `/v1`).
 * @param db Banco já aberto, de quem a rota só usa a checagem de saúde.
 */
export function registrarSaude(app: FastifyInstance, db: BancoDeDados): void {
  app.get(
    '/health',
    { schema: { response: { 200: SCHEMA_RESPOSTA, 503: SCHEMA_RESPOSTA } } },
    async (_requisicao, resposta): Promise<RespostaSaude> => {
      const banco = checarBanco(db);
      resposta.code(banco === 'ok' ? 200 : 503);
      return { status: banco === 'ok' ? 'ok' : 'erro', db: banco };
    },
  );
}
