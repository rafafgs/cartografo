/**
 * Acesso às tabelas `grafo` e `grafo_versao` (t101, FR5/FR6).
 *
 * Recebe o `BancoDeDados` já aberto e nunca toca o driver — o dono do banco é
 * `src/db/` (D1), e `scripts/check-single-writer.mjs` é o portão dessa regra.
 *
 * Append-only por construção: não existe DELETE nem UPDATE de `grafo_versao`
 * neste módulo, e o único UPDATE de `grafo` é o do ponteiro. É o que sustenta o
 * "nada se apaga" da D15 — e o que faz reverter ser mover ponteiro, não desfazer.
 */

import type { BancoDeDados } from '../db/connection.ts';
import type { DocumentoGrafo } from '../dominio/grafo.ts';
import { hashSnapshot, serializarCanonico } from '../dominio/hash.ts';

/** Linhagem de um grafo: a classe e o ponteiro para a versão que vale hoje. */
export interface LinhaGrafo {
  id: string;
  classe: string;
  linhagem_tipo: string;
  base_classe: string | null;
  origem_proposta_id: number | null;
  versao_corrente_id: string | null;
  criado_em: string;
}

/** Uma versão, sem o snapshot — o corpo grande só sai quando alguém pede. */
export interface LinhaGrafoVersao {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

/** Uma versão com o documento inteiro, já parseado. */
export interface LinhaGrafoVersaoComSnapshot extends LinhaGrafoVersao {
  snapshot: DocumentoGrafo;
}

/** Uma classe registrada, na visão de catálogo. */
export interface LinhaClasse {
  classe: string;
  grafo_id: string;
  versao_corrente_id: string | null;
  criado_em: string;
}

const COLUNAS_GRAFO =
  'id, classe, linhagem_tipo, base_classe, origem_proposta_id, versao_corrente_id, criado_em';
const COLUNAS_VERSAO = 'id, grafo_id, versao_pai, origem, proposta_id, criado_em';

/** Momento de gravação, em ISO 8601 — mesmo formato do runner de migração. */
export function agora(): string {
  return new Date().toISOString();
}

/**
 * @param db Banco aberto.
 * @param id Id da linhagem (= classe, para grafo base).
 * @returns A linhagem, ou `undefined` se não existir.
 */
export function buscarGrafo(db: BancoDeDados, id: string): LinhaGrafo | undefined {
  return db.prepare(`SELECT ${COLUNAS_GRAFO} FROM grafo WHERE id = ?`).get(id) as
    | LinhaGrafo
    | undefined;
}

/**
 * @param db Banco aberto.
 * @returns Todas as linhagens, em ordem de criação.
 */
export function listarGrafos(db: BancoDeDados): LinhaGrafo[] {
  return db
    .prepare(`SELECT ${COLUNAS_GRAFO} FROM grafo ORDER BY criado_em, id`)
    .all() as LinhaGrafo[];
}

/**
 * Catálogo de classes (D8: a classe é a identidade nomeada pelo usuário).
 *
 * Só linhagens base entram: variante é fork de projeto (D13), não uma classe
 * nova.
 *
 * @param db Banco aberto.
 * @returns Uma entrada por classe registrada.
 */
export function listarClasses(db: BancoDeDados): LinhaClasse[] {
  return db
    .prepare(
      `SELECT classe, id AS grafo_id, versao_corrente_id, criado_em
         FROM grafo
        WHERE linhagem_tipo = 'base'
        ORDER BY classe`,
    )
    .all() as LinhaClasse[];
}

/**
 * Cadeia inteira de versões de um grafo, inclusive as abandonadas por reversão.
 *
 * @param db Banco aberto.
 * @param grafoId Id da linhagem.
 * @returns Versões em ordem de criação.
 */
export function listarVersoes(db: BancoDeDados, grafoId: string): LinhaGrafoVersao[] {
  return db
    .prepare(`SELECT ${COLUNAS_VERSAO} FROM grafo_versao WHERE grafo_id = ? ORDER BY criado_em, id`)
    .all(grafoId) as LinhaGrafoVersao[];
}

/**
 * @param db Banco aberto.
 * @param id Hash da versão.
 * @returns A versão com o snapshot já parseado, ou `undefined`.
 */
export function buscarVersao(
  db: BancoDeDados,
  id: string,
): LinhaGrafoVersaoComSnapshot | undefined {
  const linha = db
    .prepare(`SELECT ${COLUNAS_VERSAO}, snapshot FROM grafo_versao WHERE id = ?`)
    .get(id) as (LinhaGrafoVersao & { snapshot: string }) | undefined;
  if (linha === undefined) return undefined;
  return { ...linha, snapshot: JSON.parse(linha.snapshot) as DocumentoGrafo };
}

/**
 * A mesma versão de `buscarVersao`, sem carregar o snapshot inteiro.
 *
 * @param db Banco aberto.
 * @param id Hash da versão.
 * @returns Os metadados da versão, ou `undefined`.
 */
export function buscarVersaoResumida(db: BancoDeDados, id: string): LinhaGrafoVersao | undefined {
  return db.prepare(`SELECT ${COLUNAS_VERSAO} FROM grafo_versao WHERE id = ?`).get(id) as
    | LinhaGrafoVersao
    | undefined;
}

/**
 * @param db Banco aberto.
 * @param classe Classe procurada.
 * @returns A linhagem base da classe, se já existir.
 */
export function buscarBaseDaClasse(db: BancoDeDados, classe: string): LinhaGrafo | undefined {
  return db
    .prepare(`SELECT ${COLUNAS_GRAFO} FROM grafo WHERE classe = ? AND linhagem_tipo = 'base'`)
    .get(classe) as LinhaGrafo | undefined;
}

/**
 * Grava uma versão nova. Só INSERT: versão nunca é reescrita.
 *
 * @param db Banco aberto (dentro de uma transação, quando o chamador abre uma).
 * @param dados Linhagem, pai, snapshot já validado e origem.
 */
export function inserirVersao(
  db: BancoDeDados,
  dados: {
    id: string;
    grafo_id: string;
    versao_pai: string | null;
    snapshot: DocumentoGrafo;
    origem: 'manual' | 'sintetizador' | 'proposta';
    proposta_id: number | null;
    criado_em: string;
  },
): void {
  db.prepare(
    `INSERT INTO grafo_versao (id, grafo_id, versao_pai, snapshot, origem, proposta_id, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    dados.id,
    dados.grafo_id,
    dados.versao_pai,
    serializarCanonico(dados.snapshot),
    dados.origem,
    dados.proposta_id,
    dados.criado_em,
  );
}

/**
 * Move o ponteiro de versão corrente da linhagem.
 *
 * É o ÚNICO caminho que muda o que "vale hoje" — tanto aplicar quanto reverter
 * passam por aqui, em direções opostas.
 *
 * @param db Banco aberto.
 * @param grafoId Linhagem.
 * @param versaoId Versão que passa a valer.
 */
export function moverPonteiro(db: BancoDeDados, grafoId: string, versaoId: string): void {
  db.prepare('UPDATE grafo SET versao_corrente_id = ? WHERE id = ?').run(versaoId, grafoId);
}

/**
 * Bootstrap de uma linhagem base nova, em uma transação.
 *
 * Registrar normalmente NÃO move o ponteiro (`especificacoes/eventos/taxonomia.md`),
 * mas aqui move: é a primeira versão da linhagem, não existe "corrente"
 * anterior a preservar, e uma linhagem sem ponteiro seria um grafo que existe
 * sem valer.
 *
 * @param db Banco aberto.
 * @param documento Documento já validado (estrutura + soundness).
 * @returns A linhagem e a versão como ficaram gravadas.
 */
export function registrarGrafoBase(
  db: BancoDeDados,
  documento: DocumentoGrafo,
): { grafo: LinhaGrafo; versao: LinhaGrafoVersao } {
  const classe = documento.classe;
  const versaoId = hashSnapshot(documento);
  const criadoEm = agora();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO grafo (id, classe, linhagem_tipo, base_classe, origem_proposta_id, versao_corrente_id, criado_em)
       VALUES (?, ?, 'base', NULL, NULL, NULL, ?)`,
    ).run(classe, classe, criadoEm);

    inserirVersao(db, {
      id: versaoId,
      grafo_id: classe,
      versao_pai: null,
      snapshot: documento,
      origem: 'manual',
      proposta_id: null,
      criado_em: criadoEm,
    });

    moverPonteiro(db, classe, versaoId);
  })();

  const grafo = buscarGrafo(db, classe);
  const versao = buscarVersaoResumida(db, versaoId);
  if (grafo === undefined || versao === undefined) {
    throw new Error(`grafo "${classe}" não ficou gravado`);
  }

  return { grafo, versao };
}
