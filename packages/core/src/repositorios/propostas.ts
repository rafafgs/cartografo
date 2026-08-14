/**
 * Acesso à tabela `proposta` (t101, FR7/FR8/FR9).
 *
 * Uma proposta é uma HIPÓTESE (`notas/2026-08-14-aprendizado.md`): artefato-alvo
 * e versão, diff semântico, evidência que a motivou e métrica que se espera
 * mover. As colunas JSON (`operacoes`, `evidencia`, `metrica_esperada`,
 * `resultado`) entram e saem parseadas por este módulo — quem chama nunca vê
 * string.
 *
 * As duas transições de estado que mexem no banco inteiro moram aqui, cada uma
 * em UMA transação: aplicar (grava versão nova + move ponteiro + marca a
 * proposta) e reverter (move o ponteiro de volta + marca a proposta). Meia
 * aplicação — versão gravada com ponteiro parado, ou vice-versa — deixaria o
 * histórico mentindo, que é justamente o que a D15 compra com append-only.
 *
 * Como `repositorios/grafos.ts`, recebe o banco já aberto e nunca toca o driver
 * (D1).
 */

import type { BancoDeDados } from '../db/connection.ts';
import type { DocumentoGrafo } from '../dominio/grafo.ts';
import type { Operacao } from '../dominio/operacoes.ts';
import {
  agora,
  buscarVersaoResumida,
  inserirVersao,
  moverPonteiro,
  type LinhaGrafoVersao,
} from './grafos.ts';

/** Estados possíveis de uma proposta. `aprovada` humana é do inbox (t111). */
export type StatusDeProposta = 'pendente' | 'aplicada' | 'revertida' | 'rejeitada';

/** Uma proposta, com as colunas JSON já parseadas. */
export interface LinhaProposta {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: Operacao[];
  evidencia: unknown;
  metrica_esperada: unknown;
  status: StatusDeProposta;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  resultado: unknown;
  criado_em: string;
  atualizado_em: string;
}

/** A mesma linha como o SQLite a devolve: JSON em TEXT. */
interface LinhaCrua {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  operacoes: string;
  evidencia: string;
  metrica_esperada: string;
  status: StatusDeProposta;
  versao_aplicada_id: string | null;
  motivo_reversao: string | null;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

const COLUNAS = `id, grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada, status,
                 versao_aplicada_id, motivo_reversao, resultado, criado_em, atualizado_em`;

function hidratar(linha: LinhaCrua): LinhaProposta {
  return {
    ...linha,
    operacoes: JSON.parse(linha.operacoes) as Operacao[],
    evidencia: JSON.parse(linha.evidencia),
    metrica_esperada: JSON.parse(linha.metrica_esperada),
    resultado: linha.resultado === null ? null : JSON.parse(linha.resultado),
  };
}

/**
 * @param db Banco aberto.
 * @param id Id da proposta.
 * @returns A proposta hidratada, ou `undefined`.
 */
export function buscarProposta(db: BancoDeDados, id: number): LinhaProposta | undefined {
  const linha = db.prepare(`SELECT ${COLUNAS} FROM proposta WHERE id = ?`).get(id) as
    | LinhaCrua
    | undefined;
  return linha === undefined ? undefined : hidratar(linha);
}

/**
 * Cria uma proposta pendente.
 *
 * @param db Banco aberto.
 * @param dados Alvo (grafo e versão), operações já validadas na forma, e a
 *   hipótese: evidência que motivou e métrica que se espera mover.
 * @returns A proposta como ficou gravada.
 */
export function criarProposta(
  db: BancoDeDados,
  dados: {
    grafo_id: string;
    versao_alvo: string;
    operacoes: Operacao[];
    evidencia: unknown;
    metrica_esperada: unknown;
  },
): LinhaProposta {
  const criadoEm = agora();
  const resultado = db
    .prepare(
      `INSERT INTO proposta (grafo_id, versao_alvo, operacoes, evidencia, metrica_esperada,
                             status, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`,
    )
    .run(
      dados.grafo_id,
      dados.versao_alvo,
      JSON.stringify(dados.operacoes),
      JSON.stringify(dados.evidencia),
      JSON.stringify(dados.metrica_esperada),
      criadoEm,
      criadoEm,
    );

  const proposta = buscarProposta(db, Number(resultado.lastInsertRowid));
  if (proposta === undefined) throw new Error('a proposta não ficou gravada');
  return proposta;
}

/**
 * Marca a proposta como rejeitada e guarda o relatório que a reprovou.
 *
 * O único caminho para `rejeitada` nesta ticket é o portão de soundness — a
 * rejeição humana explícita é do inbox (t111).
 *
 * @param db Banco aberto.
 * @param id Proposta.
 * @param relatorio Relatório de validação, gravado em `resultado`.
 * @returns A proposta atualizada.
 */
export function rejeitarProposta(db: BancoDeDados, id: number, relatorio: unknown): LinhaProposta {
  db.prepare(
    `UPDATE proposta SET status = 'rejeitada', resultado = ?, atualizado_em = ?
      WHERE id = ? AND status = 'pendente'`,
  ).run(JSON.stringify(relatorio), agora(), id);

  const proposta = buscarProposta(db, id);
  if (proposta === undefined) throw new Error(`proposta ${id} sumiu`);
  return proposta;
}

/**
 * Aplica a proposta: versão nova + ponteiro + status, em uma transação (D15).
 *
 * @param db Banco aberto.
 * @param dados Proposta pendente, documento já validado e o hash dele.
 * @returns A proposta e a versão nova, como ficaram gravadas.
 */
export function aplicarProposta(
  db: BancoDeDados,
  dados: { proposta: LinhaProposta; versaoId: string; documento: DocumentoGrafo },
): { proposta: LinhaProposta; versao: LinhaGrafoVersao } {
  const { proposta, versaoId, documento } = dados;
  const momento = agora();

  db.transaction(() => {
    inserirVersao(db, {
      id: versaoId,
      grafo_id: proposta.grafo_id,
      versao_pai: proposta.versao_alvo,
      snapshot: documento,
      origem: 'proposta',
      proposta_id: proposta.id,
      criado_em: momento,
    });

    moverPonteiro(db, proposta.grafo_id, versaoId);

    const efeito = db
      .prepare(
        `UPDATE proposta SET status = 'aplicada', versao_aplicada_id = ?, atualizado_em = ?
          WHERE id = ? AND status = 'pendente'`,
      )
      .run(versaoId, momento, proposta.id);

    // A transação inteira cai se a proposta deixou de estar pendente entre a
    // checagem da rota e este UPDATE: aplicar duas vezes é 409, nunca duas
    // versões (FR8/AT19).
    if (efeito.changes !== 1) {
      throw new Error(`proposta ${proposta.id} deixou de estar pendente durante a aplicação`);
    }
  })();

  const atualizada = buscarProposta(db, proposta.id);
  if (atualizada === undefined) throw new Error(`proposta ${proposta.id} sumiu`);

  const versao = buscarVersaoResumida(db, versaoId);
  if (versao === undefined) throw new Error(`versão ${versaoId} não ficou gravada`);

  return { proposta: atualizada, versao };
}

/**
 * Reverte a proposta: o ponteiro volta para a versão-alvo e nada se apaga.
 *
 * A versão abandonada continua em `grafo_versao`, inclusive na listagem do
 * histórico — é dela que o topógrafo vai puxar telemetria depois, cruzando com
 * o motivo gravado aqui.
 *
 * @param db Banco aberto.
 * @param dados Proposta aplicada e o motivo (obrigatório, D15/evento
 *   `grafo_versao.revertida`).
 * @returns A proposta atualizada.
 */
export function reverterProposta(
  db: BancoDeDados,
  dados: { proposta: LinhaProposta; motivo: string },
): LinhaProposta {
  const { proposta, motivo } = dados;
  const momento = agora();

  db.transaction(() => {
    moverPonteiro(db, proposta.grafo_id, proposta.versao_alvo);

    const efeito = db
      .prepare(
        `UPDATE proposta SET status = 'revertida', motivo_reversao = ?, atualizado_em = ?
          WHERE id = ? AND status = 'aplicada'`,
      )
      .run(motivo, momento, proposta.id);

    if (efeito.changes !== 1) {
      throw new Error(`proposta ${proposta.id} deixou de estar aplicada durante a reversão`);
    }
  })();

  const atualizada = buscarProposta(db, proposta.id);
  if (atualizada === undefined) throw new Error(`proposta ${proposta.id} sumiu`);
  return atualizada;
}
