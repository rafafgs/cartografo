/**
 * Runner de migração: arquivos `.sql` numerados, sem ORM e sem lib de migração.
 *
 * Contrato do diretório de migrações:
 *
 * - todo arquivo `.sql` começa com um número, seguido de `_` e de um nome
 *   (`0001_init.sql`). O número decide a ordem; o nome só documenta;
 * - o arquivo NÃO abre transação própria — quem transaciona é este runner, uma
 *   transação por migração, para que uma migração que quebra no meio não deixe
 *   resíduo;
 * - o que já rodou fica em `schema_migrations`, que é criada pela própria
 *   `0001_init.sql`. Antes dela existir, o conjunto de aplicadas é vazio.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { BancoDeDados } from './connection.ts';

/** Tabela de controle: o que já rodou, e quando. */
export const TABELA_MIGRACOES = 'schema_migrations';

/** Uma migração encontrada no disco. */
export interface Migracao {
  /** Nome do arquivo sem a extensão — é o que vai para `schema_migrations.id`. */
  id: string;
  /** Número do prefixo, já convertido; é o critério de ordenação. */
  numero: number;
  /** Nome do arquivo, como está no disco. */
  arquivo: string;
  /** Caminho absoluto do arquivo. */
  caminho: string;
}

const PADRAO_NOME = /^(\d+)_.+$/;

/**
 * Lê o diretório de migrações e devolve as migrações em ordem numérica.
 *
 * Falha alto (em vez de ignorar em silêncio) em arquivo `.sql` sem prefixo
 * numérico e em número repetido: nos dois casos a ordem de aplicação seria
 * ambígua, e uma migração aplicada fora de ordem é dano difícil de desfazer.
 *
 * @param dir Diretório com os arquivos `.sql`.
 * @returns Migrações ordenadas pelo número do prefixo.
 */
export function listarMigracoes(dir: string): Migracao[] {
  const migracoes: Migracao[] = [];
  const porNumero = new Map<number, string>();

  for (const arquivo of readdirSync(dir)) {
    if (!arquivo.endsWith('.sql')) continue;

    const base = arquivo.slice(0, -'.sql'.length);
    const casamento = PADRAO_NOME.exec(base);
    if (casamento === null) {
      throw new Error(
        `migração com nome fora do padrão "<numero>_<nome>.sql": "${arquivo}" (em ${dir})`,
      );
    }

    const numero = Number.parseInt(casamento[1], 10);
    const conflito = porNumero.get(numero);
    if (conflito !== undefined) {
      throw new Error(
        `duas migrações com o número ${casamento[1]}: "${conflito}" e "${arquivo}" (em ${dir})`,
      );
    }
    porNumero.set(numero, arquivo);

    migracoes.push({ id: base, numero, arquivo, caminho: path.join(dir, arquivo) });
  }

  // Ordem numérica, não alfabética: "10_" vem DEPOIS de "2_".
  return migracoes.sort((a, b) => a.numero - b.numero);
}

/**
 * Ids já registrados em `schema_migrations`.
 *
 * Quando a tabela ainda não existe (banco novo, antes da 0001), o conjunto é
 * vazio — não é erro.
 *
 * @param db Handle aberto.
 * @returns Conjunto de ids aplicados.
 */
export function migracoesAplicadas(db: BancoDeDados): Set<string> {
  const tabela = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(TABELA_MIGRACOES);
  if (tabela === undefined) return new Set();

  const linhas = db.prepare(`SELECT id FROM ${TABELA_MIGRACOES}`).all() as Array<{ id: string }>;
  return new Set(linhas.map((linha) => linha.id));
}

/**
 * Aplica as migrações pendentes, em ordem, uma transação por migração.
 *
 * @param db Handle aberto.
 * @param dir Diretório com os arquivos `.sql`.
 * @returns Ids aplicados NESTA chamada, em ordem. Vazio quando não havia nada
 *   pendente — é o caso da partida idempotente (FR3).
 */
export function migrar(db: BancoDeDados, dir: string): string[] {
  const jaAplicadas = migracoesAplicadas(db);
  const aplicadas: string[] = [];

  for (const migracao of listarMigracoes(dir)) {
    if (jaAplicadas.has(migracao.id)) continue;

    const sql = readFileSync(migracao.caminho, 'utf8');
    const passo = db.transaction(() => {
      db.exec(sql);
      db.prepare(`INSERT INTO ${TABELA_MIGRACOES} (id, applied_at) VALUES (?, ?)`).run(
        migracao.id,
        new Date().toISOString(),
      );
    });

    try {
      passo();
    } catch (erro) {
      throw new Error(`falha ao aplicar a migração "${migracao.arquivo}"`, { cause: erro });
    }

    aplicadas.push(migracao.id);
  }

  return aplicadas;
}
