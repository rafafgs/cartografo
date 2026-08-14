/**
 * Conexão com o SQLite embarcado.
 *
 * Este é o ÚNICO módulo do repositório autorizado a importar o driver do
 * SQLite (D1: só o control plane escreve no banco). Quem precisa do banco fora
 * daqui recebe um `BancoDeDados` já aberto e usa o tipo re-exportado abaixo —
 * nunca o pacote do driver. `scripts/check-single-writer.mjs` transforma essa
 * regra em portão de lint.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import type { Database as BancoDoDriver } from 'better-sqlite3';

/** Handle de banco visto pelo resto do core, sem vazar o nome do driver. */
export type BancoDeDados = BancoDoDriver;

/** Caminho default do arquivo do banco, relativo ao diretório de trabalho. */
export const CAMINHO_BANCO_PADRAO = path.join('.cartografo', 'cartografo.db');

/** Variável de ambiente que sobrescreve o caminho default. */
export const ENV_CAMINHO_BANCO = 'CARTOGRAFO_DB_PATH';

/**
 * Resolve o caminho absoluto do arquivo do banco.
 *
 * @param env Ambiente de onde ler `CARTOGRAFO_DB_PATH`.
 * @returns Caminho absoluto do arquivo.
 */
export function caminhoDoBanco(env: NodeJS.ProcessEnv = process.env): string {
  const configurado = env[ENV_CAMINHO_BANCO]?.trim();
  return path.resolve(
    configurado !== undefined && configurado !== '' ? configurado : CAMINHO_BANCO_PADRAO,
  );
}

/**
 * Abre (criando o arquivo e o diretório, se faltarem) o banco no caminho dado.
 *
 * Deliberadamente NÃO valida o conteúdo do arquivo nem roda pragma nenhum: o
 * SQLite só lê o cabeçalho na primeira consulta, e é isso que faz o `SELECT 1`
 * de `checarBanco` ser uma checagem de verdade em `/health` (FR4), em vez de
 * uma constante disfarçada.
 *
 * @param caminho Caminho do arquivo do banco.
 * @returns Handle aberto.
 */
export function abrirBanco(caminho: string): BancoDeDados {
  mkdirSync(path.dirname(caminho), { recursive: true });
  return new Database(caminho);
}

/**
 * Liga os pragmas de operação do control plane.
 *
 * Fica fora de `abrirBanco` de propósito: pragma é a primeira coisa que toca o
 * arquivo, e juntar as duas coisas faria um banco corrompido estourar já na
 * abertura, antes de existir rota de saúde para reportar o problema.
 *
 * @param db Handle aberto.
 */
export function aplicarPragmas(db: BancoDeDados): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

/**
 * Checagem de saúde do banco: um `SELECT 1` de verdade.
 *
 * @param db Handle aberto.
 * @returns `'ok'` quando a consulta responde, `'erro'` quando o driver estoura.
 */
export function checarBanco(db: BancoDeDados): 'ok' | 'erro' {
  try {
    const linha = db.prepare('SELECT 1 AS um').get() as { um: number } | undefined;
    return linha?.um === 1 ? 'ok' : 'erro';
  } catch {
    return 'erro';
  }
}
