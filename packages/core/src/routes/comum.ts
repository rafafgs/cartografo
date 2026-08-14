/**
 * O que as rotas de domínio compartilham: tradução de erro para HTTP.
 *
 * Duas respostas de falha existem nesta ficha, e nenhuma delas é 500:
 *
 * - **400** quando o corpo não fecha com o contrato do evento. A lista INTEIRA
 *   de problemas vai no corpo, não só o primeiro — quem monta um envelope
 *   errado costuma errar em mais de um campo;
 * - **404** quando a entidade não existe. Nesse caso nada é gravado: nem linha
 *   de projeção, nem evento (FR5, AT7).
 */

import type { FastifyReply } from 'fastify';

import { ErroDeValidacao } from '../db/validacao-evento.ts';

/** Corpo de uma resposta de erro. */
export interface RespostaDeErro {
  erro: string;
  detalhes?: string[];
}

/**
 * Roda o corpo de uma rota traduzindo `ErroDeValidacao` em 400.
 *
 * @param resposta Resposta do Fastify.
 * @param acao O trabalho da rota.
 * @returns O que a ação devolveu, ou o corpo do 400.
 */
export async function comValidacao<T>(
  resposta: FastifyReply,
  acao: () => T | Promise<T>,
): Promise<T | RespostaDeErro> {
  try {
    return await acao();
  } catch (erro) {
    if (erro instanceof ErroDeValidacao) {
      resposta.code(400);
      return { erro: 'validacao', detalhes: erro.erros };
    }
    throw erro;
  }
}

/**
 * Marca a resposta como 404.
 *
 * @param resposta Resposta do Fastify.
 * @param entidade Nome da entidade que não foi encontrada.
 * @returns Corpo do 404.
 */
export function naoEncontrado(resposta: FastifyReply, entidade: string): RespostaDeErro {
  resposta.code(404);
  return { erro: 'nao_encontrado', detalhes: [`${entidade} não existe`] };
}

/** Lê o `:id` de uma rota como inteiro. */
export function idDaRota(parametros: unknown): number {
  const bruto = (parametros as { id?: string }).id;
  const numero = Number(bruto);
  if (!Number.isInteger(numero)) {
    throw new ErroDeValidacao([`id precisa ser um inteiro (recebido: ${String(bruto)})`]);
  }
  return numero;
}
