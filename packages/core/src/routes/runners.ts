/**
 * Rota de pareamento de runner (t103, FR4).
 *
 * Um verbo só, e ele é idempotente: `201` quando o id aparece pela primeira
 * vez, `200` quando já era conhecido. A distinção existe para o operador
 * (saber se um runner é novo é informação), nunca para o runner — que trata os
 * dois como sucesso e segue para a fila.
 *
 * Autenticação do pareamento é t124: nesta fase o id é declarado pelo próprio
 * runner, como o resto da API pré-autorização (mesmo corte de t101/t102).
 */

import type { FastifyInstance } from 'fastify';

import type { BancoDeDados } from '../db/connection.ts';
import { registrarRunner } from '../repositorios/runners.ts';

function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Registra as rotas de runner no escopo recebido (já com o prefixo /v1).
 *
 * @param app Escopo do Fastify.
 * @param db Banco já aberto; as rotas nunca abrem o seu (D1).
 */
export function registrarRunners(app: FastifyInstance, db: BancoDeDados): void {
  app.post('/runners', async (requisicao, resposta) => {
    const corpo = ehObjeto(requisicao.body) ? requisicao.body : {};

    const id = corpo.id;
    if (typeof id !== 'string' || id.trim() === '') {
      resposta.code(400);
      return {
        erro: 'id_obrigatorio',
        mensagem: 'runner declara a própria identidade: id precisa ser uma string não vazia',
      };
    }

    const nome = corpo.nome;
    if (nome !== undefined && nome !== null && typeof nome !== 'string') {
      resposta.code(400);
      return { erro: 'nome_invalido', mensagem: 'nome, quando enviado, precisa ser string' };
    }

    const { runner, criado } = registrarRunner(db, { id, nome: nome ?? null });
    resposta.code(criado ? 201 : 200);
    return { runner };
  });
}
