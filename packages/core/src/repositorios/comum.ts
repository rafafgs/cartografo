/**
 * O que os três repositórios de domínio compartilham.
 *
 * Nada aqui é regra de negócio: são as conversões de fronteira entre o SQLite
 * (que não tem booleano nem JSON nativo) e o JSON da API, mais os defaults de
 * envelope que a v0 ainda não tem de onde tirar.
 *
 * Sobre os defaults de `ator`: sem autenticação (t124, fora da PoC pela D16) o
 * control plane não tem como saber QUEM está do outro lado. Em vez de inventar
 * um usuário, ele registra honestamente `sistema` + o componente que agiu, e
 * aceita um `ator` explícito no corpo para quando o chamador souber mais do que
 * ele — que é o caso do runner (t103) e da tela (t107).
 */

import { ErroDeValidacao, type Ator } from '../db/validacao-evento.ts';

/**
 * Projeto dono dos eventos quando o chamador não diz qual.
 *
 * A v1 não tem entidade "projeto" nem multi-tenância: o campo existe no
 * envelope desde t98 para que a telemetria já nasça particionável, e um único
 * projeto é a leitura honesta do que a PoC roda.
 */
export const PROJETO_PADRAO = 1;

/** Ator default de uma escrita vinda da API sem dono declarado. */
export const ATOR_API: Ator = Object.freeze({ tipo: 'sistema', ref: 'control-plane' });

/** Ator default de uma sessão: quem despacha é o runner (D5). */
export const ATOR_RUNNER: Ator = Object.freeze({ tipo: 'sistema', ref: 'runner' });

/** Ator do portão de auto-aprovação — nunca `usuario`, por auditoria. */
export const ATOR_AUTO_APROVACAO: Ator = Object.freeze({
  tipo: 'sistema',
  ref: 'portao-auto-aprovacao',
});

/** Instante do fato, ISO 8601. */
export const agora = (): string => new Date().toISOString();

/** SQLite guarda booleano como 0/1. */
export const comoBooleano = (valor: number): boolean => valor !== 0;

/** ...e o caminho de volta. */
export const comoInteiro = (valor: boolean): number => (valor ? 1 : 0);

/**
 * Ator informado pelo chamador, ou o default do caminho.
 *
 * O valor informado passa direto: quem o valida é `validarEvento`, e duplicar a
 * checagem aqui só criaria duas mensagens de erro para o mesmo problema.
 *
 * @param informado O que veio no corpo, se veio.
 * @param padrao Ator do caminho.
 * @returns O ator a registrar.
 */
export function resolverAtor(informado: unknown, padrao: Ator): Ator {
  return informado === undefined || informado === null ? padrao : (informado as Ator);
}

/** Lê um inteiro opcional de um corpo de requisição. */
export function inteiroOuNulo(nome: string, valor: unknown): number | null {
  if (valor === undefined || valor === null) return null;
  if (!Number.isInteger(valor)) throw new ErroDeValidacao([`${nome} precisa ser um inteiro`]);
  return valor as number;
}

/** Lê um inteiro opcional com default. */
export function inteiroOuPadrao(nome: string, valor: unknown, padrao: number): number {
  return inteiroOuNulo(nome, valor) ?? padrao;
}

/** Lê uma string opcional não vazia de um corpo de requisição. */
export function textoOuNulo(nome: string, valor: unknown): string | null {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== 'string' || valor.length === 0) {
    throw new ErroDeValidacao([`${nome} precisa ser uma string não vazia`]);
  }
  return valor;
}

/**
 * Lê um inteiro de um parâmetro de rota ou de query string.
 *
 * Um filtro inválido vira 400, nunca um filtro ignorado em silêncio: "não veio
 * nada" e "veio errado" são perguntas diferentes e merecem respostas
 * diferentes.
 */
export function inteiroDaQuery(nome: string, valor: unknown): number | undefined {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const numero = Number(valor);
  if (!Number.isInteger(numero)) {
    throw new ErroDeValidacao([`${nome} precisa ser um inteiro (recebido: ${String(valor)})`]);
  }
  return numero;
}

/** Decodifica uma coluna que guarda JSON, preservando a diferença entre null e vazio. */
export function jsonOuNulo<T>(bruto: string | null): T | null {
  return bruto === null ? null : (JSON.parse(bruto) as T);
}
