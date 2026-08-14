/**
 * Acesso à tabela `runner` (t103, FR2).
 *
 * Pareamento é só identidade: um runner declara um id e passa a existir para o
 * control plane. Não há escopo de projeto aqui — `projeto_id` é declarado a
 * cada pedido de lease, porque um runner físico pode servir projetos
 * diferentes ao longo do tempo.
 *
 * Registrar é idempotente por construção, e isso é o ponto: a D5 exige
 * "registros idempotentes na API", e o caso comum de um runner é justamente
 * reiniciar — crash, deploy, máquina que voltou — e se apresentar de novo com o
 * MESMO id. Erro na segunda vez transformaria um evento rotineiro em incidente.
 *
 * Como os demais repositórios, recebe o banco já aberto e nunca toca o driver
 * (D1).
 */

import type { BancoDeDados } from '../db/connection.ts';
import { agora } from './grafos.ts';

/** Um runner pareado. */
export interface LinhaRunner {
  id: string;
  nome: string | null;
  registrado_em: string;
}

const COLUNAS = 'id, nome, registrado_em';

/**
 * @param db Banco aberto.
 * @param id Id declarado pelo runner.
 * @returns O runner, ou `undefined` se nunca se registrou.
 */
export function buscarRunner(db: BancoDeDados, id: string): LinhaRunner | undefined {
  return db.prepare(`SELECT ${COLUNAS} FROM runner WHERE id = ?`).get(id) as
    | LinhaRunner
    | undefined;
}

/**
 * @param db Banco aberto.
 * @returns Todos os runners pareados, na ordem em que se registraram.
 */
export function listarRunners(db: BancoDeDados): LinhaRunner[] {
  return db
    .prepare(`SELECT ${COLUNAS} FROM runner ORDER BY registrado_em, id`)
    .all() as LinhaRunner[];
}

/**
 * Registra (ou re-registra) um runner.
 *
 * A segunda chamada com o mesmo id NÃO é erro nem duplica linha: atualiza o
 * nome, se veio um, e devolve a linha. `registrado_em` continua sendo o
 * primeiro pareamento — é a data em que aquele id apareceu no sistema, e
 * reescrevê-la a cada reinício apagaria o único traço da idade do runner.
 *
 * @param db Banco aberto.
 * @param dados Id declarado e, opcionalmente, um nome legível.
 * @returns A linha gravada e se ESTA chamada foi a que criou o registro — é o
 *   que separa `201` de `200` na rota (FR4).
 */
export function registrarRunner(
  db: BancoDeDados,
  dados: { id: string; nome?: string | null },
): { runner: LinhaRunner; criado: boolean } {
  const criado = db.transaction(() => {
    const existente = buscarRunner(db, dados.id);

    if (existente === undefined) {
      db.prepare('INSERT INTO runner (id, nome, registrado_em) VALUES (?, ?, ?)').run(
        dados.id,
        dados.nome ?? null,
        agora(),
      );
      return true;
    }

    if (dados.nome !== undefined && dados.nome !== null) {
      db.prepare('UPDATE runner SET nome = ? WHERE id = ?').run(dados.nome, dados.id);
    }
    return false;
  })();

  const runner = buscarRunner(db, dados.id);
  if (runner === undefined) throw new Error(`runner "${dados.id}" não ficou gravado`);
  return { runner, criado };
}
