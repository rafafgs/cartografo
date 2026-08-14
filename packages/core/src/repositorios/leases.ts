/**
 * Acesso à tabela `lease` (t103, FR3/FR9) — o mecanismo da D5.
 *
 * Uma lease é o direito temporário de um runner sobre um trabalho: nasce com
 * prazo (`expira_em`), é empurrada para frente por heartbeat e termina de três
 * jeitos — liberada pelo dono, expirada por prazo vencido, ou substituída
 * quando o runner morre e outro reivindica o trabalho.
 *
 * Duas garantias moram aqui, e as duas dependem de a transação não ter `await`
 * no meio:
 *
 * 1. **O teto nunca é excedido.** Contar as leases ativas e gravar a nova
 *    precisam ser um passo só. Entre a contagem e a escrita, N requisições
 *    concorrentes contariam todas o mesmo número e todas se achariam dentro do
 *    teto. É o mesmo cuidado (e o mesmo formato: `db.transaction()` síncrona)
 *    de `aplicarProposta` no t101.
 * 2. **Reivindicar expiradas é o primeiro passo de conceder**, na MESMA
 *    transação: o pedido que descobre uma lease morta é o pedido que a
 *    substitui, e não existe janela em que o trabalho está sem dono e ninguém
 *    percebeu.
 *
 * `agora` é injetável (default: relógio real) para que "o prazo venceu" seja
 * testável sem `sleep`. É a única concessão a teste na assinatura, e ela paga:
 * o caminho com tempo real de ponta a ponta continua provado em AT17.
 *
 * Esta ficha NÃO emite `lease.concedida`/`lease.expirada`: os dois dependem da
 * tabela `evento` e de `src/db/eventos.ts`, entregas do t102 (mesmo corte que o
 * t101 fez para `grafo_versao.*`). As colunas abaixo já carregam tudo que os
 * dois eventos pedem.
 */

import type { BancoDeDados } from '../db/connection.ts';
import { agora } from './grafos.ts';

/** Estados possíveis de uma lease. */
export type StatusDeLease = 'ativa' | 'liberada' | 'expirada';

/**
 * Por que uma lease morreu, no vocabulário de
 * `especificacoes/eventos/schemas/lease.expirada.schema.json`.
 */
export type MotivoDeExpiracao = 'heartbeat_perdido' | 'expirou';

/** Por que um pedido de lease não virou lease. Nenhum deles é erro. */
export type MotivoDeRecusa = 'trabalho_ja_leased' | 'teto_runner' | 'teto_projeto';

/** Uma lease, como está no banco. */
export interface LinhaLease {
  id: number;
  runner_id: string;
  trabalho_id: number;
  projeto_id: number;
  status: StatusDeLease;
  ttl_segundos: number;
  concedida_em: string;
  heartbeat_em: string;
  expira_em: string;
  liberada_em: string | null;
  motivo_expiracao: MotivoDeExpiracao | null;
}

/** O que o runner declara ao disputar um trabalho. */
export interface PedidoDeLease {
  runner_id: string;
  projeto_id: number;
  trabalho_id: number;
  /** Teto de leases ativas simultâneas daquele runner. */
  teto_runner: number;
  /** Teto de leases ativas simultâneas daquele projeto, somando os runners. */
  teto_projeto: number;
  ttl_segundos: number;
}

/**
 * Resultado de um pedido: ou saiu lease, ou saiu o motivo de não ter saído.
 *
 * Recusa não é erro — é "agora não", e o runner tenta o próximo candidato.
 */
export type ResultadoDeConcessao =
  | { lease: LinhaLease; motivo?: undefined }
  | { lease: null; motivo: MotivoDeRecusa };

/** Relógio injetável; sem ele, o relógio real. */
export interface OpcoesDeRelogio {
  agora?: () => string;
}

/** Filtros de listagem (FR8). */
export interface FiltrosDeLease {
  projeto_id?: number;
  runner_id?: string;
  status?: StatusDeLease;
}

const COLUNAS = `id, runner_id, trabalho_id, projeto_id, status, ttl_segundos,
                 concedida_em, heartbeat_em, expira_em, liberada_em, motivo_expiracao`;

/** Instante ISO 8601 deslocado em segundos — a aritmética de prazo da lease. */
function somarSegundos(instante: string, segundos: number): string {
  return new Date(Date.parse(instante) + segundos * 1000).toISOString();
}

/**
 * @param db Banco aberto.
 * @param id Id da lease.
 * @returns A lease, ou `undefined`.
 */
export function buscarLease(db: BancoDeDados, id: number): LinhaLease | undefined {
  return db.prepare(`SELECT ${COLUNAS} FROM lease WHERE id = ?`).get(id) as
    | LinhaLease
    | undefined;
}

/**
 * @param db Banco aberto.
 * @param filtros Recorte opcional por projeto, runner e status.
 * @returns As leases que casam, das mais recentes para as mais antigas.
 */
export function listarLeases(db: BancoDeDados, filtros: FiltrosDeLease = {}): LinhaLease[] {
  const condicoes: string[] = [];
  const valores: Array<string | number> = [];

  if (filtros.projeto_id !== undefined) {
    condicoes.push('projeto_id = ?');
    valores.push(filtros.projeto_id);
  }
  if (filtros.runner_id !== undefined) {
    condicoes.push('runner_id = ?');
    valores.push(filtros.runner_id);
  }
  if (filtros.status !== undefined) {
    condicoes.push('status = ?');
    valores.push(filtros.status);
  }

  const onde = condicoes.length === 0 ? '' : ` WHERE ${condicoes.join(' AND ')}`;
  return db
    .prepare(`SELECT ${COLUNAS} FROM lease${onde} ORDER BY id`)
    .all(...valores) as LinhaLease[];
}

/**
 * Marca como expirada toda lease ativa cujo prazo já venceu.
 *
 * Sem transação própria: é chamada dentro da transação de quem reconcilia (a
 * concessão) ou dentro da transação de `reivindicarExpiradas`.
 *
 * O motivo distingue os dois óbitos possíveis, com o vocabulário do evento
 * `lease.expirada`: uma lease que NUNCA foi renovada (`heartbeat_em` ainda igual
 * a `concedida_em`) simplesmente venceu — o runner pode nem ter começado; uma
 * que foi renovada ao menos uma vez e parou perdeu o heartbeat, que é o sinal
 * de runner morto no meio do trabalho.
 *
 * @param db Banco aberto, dentro de uma transação.
 * @param momento Instante de referência.
 * @returns As leases que morreram nesta passagem.
 */
function expirarVencidas(db: BancoDeDados, momento: string): LinhaLease[] {
  const vencidas = db
    .prepare("SELECT id FROM lease WHERE status = 'ativa' AND expira_em < ?")
    .all(momento) as Array<{ id: number }>;
  if (vencidas.length === 0) return [];

  db.prepare(
    `UPDATE lease
        SET status = 'expirada',
            motivo_expiracao = CASE
              WHEN heartbeat_em = concedida_em THEN 'expirou'
              ELSE 'heartbeat_perdido'
            END
      WHERE status = 'ativa' AND expira_em < ?`,
  ).run(momento);

  return vencidas.map(({ id }) => {
    const lease = buscarLease(db, id);
    if (lease === undefined) throw new Error(`lease ${id} sumiu durante a reivindicação`);
    return lease;
  });
}

/**
 * Reivindica, em uma transação, todo trabalho cujo dono deixou o prazo vencer.
 *
 * É o primeiro passo de `concederLease` (FR5/FR9) e está exportada por si só
 * porque é um fato do sistema com valor próprio: "estas leases morreram e por
 * quê" é exatamente o que o evento `lease.expirada` vai carregar quando o t102
 * ligar a telemetria.
 *
 * @param db Banco aberto.
 * @param opcoes Relógio injetável.
 * @returns As leases expiradas nesta chamada.
 */
export function reivindicarExpiradas(
  db: BancoDeDados,
  opcoes: OpcoesDeRelogio = {},
): LinhaLease[] {
  const relogio = opcoes.agora ?? agora;
  return db.transaction(() => expirarVencidas(db, relogio()))();
}

/**
 * Concede uma lease, se houver vaga e o trabalho estiver livre.
 *
 * A transação inteira roda sem `await`: reconciliar expiradas, checar dono,
 * contar os dois tetos e gravar são um passo só. É o que faz AT12 (N pedidos
 * simultâneos contra M trabalhos) terminar com no máximo `teto_projeto` leases
 * ativas — a contagem que decide é a mesma que a escrita usa.
 *
 * `trabalho_id` é inteiro opaco: esta função não lê a tabela `trabalho` (t102).
 * Elegibilidade real (bloqueado, nó atual) é decidida pelo controller antes de
 * chegar aqui.
 *
 * @param db Banco aberto.
 * @param pedido Runner, projeto, trabalho, os dois tetos e o TTL.
 * @param opcoes Relógio injetável.
 * @returns A lease concedida, ou o motivo da recusa.
 */
export function concederLease(
  db: BancoDeDados,
  pedido: PedidoDeLease,
  opcoes: OpcoesDeRelogio = {},
): ResultadoDeConcessao {
  const relogio = opcoes.agora ?? agora;

  return db.transaction((): ResultadoDeConcessao => {
    const momento = relogio();

    // Primeiro passo, sempre: trabalho de runner morto volta à fila antes de
    // qualquer decisão deste pedido (D5).
    expirarVencidas(db, momento);

    const dono = db
      .prepare("SELECT id FROM lease WHERE trabalho_id = ? AND status = 'ativa'")
      .get(pedido.trabalho_id);
    if (dono !== undefined) return { lease: null, motivo: 'trabalho_ja_leased' };

    const doRunner = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE runner_id = ? AND status = 'ativa'")
      .get(pedido.runner_id) as { total: number };
    if (doRunner.total >= pedido.teto_runner) return { lease: null, motivo: 'teto_runner' };

    const doProjeto = db
      .prepare("SELECT COUNT(*) AS total FROM lease WHERE projeto_id = ? AND status = 'ativa'")
      .get(pedido.projeto_id) as { total: number };
    if (doProjeto.total >= pedido.teto_projeto) return { lease: null, motivo: 'teto_projeto' };

    const efeito = db
      .prepare(
        `INSERT INTO lease (runner_id, trabalho_id, projeto_id, status, ttl_segundos,
                            concedida_em, heartbeat_em, expira_em)
         VALUES (?, ?, ?, 'ativa', ?, ?, ?, ?)`,
      )
      .run(
        pedido.runner_id,
        pedido.trabalho_id,
        pedido.projeto_id,
        pedido.ttl_segundos,
        momento,
        // Nasce igual a `concedida_em`: é assim que uma lease nunca renovada se
        // distingue de uma que perdeu o heartbeat, quando o prazo vencer.
        momento,
        somarSegundos(momento, pedido.ttl_segundos),
      );

    const lease = buscarLease(db, Number(efeito.lastInsertRowid));
    if (lease === undefined) throw new Error('a lease não ficou gravada');
    return { lease };
  })();
}

/**
 * Renova o prazo de uma lease ativa (heartbeat).
 *
 * O UPDATE é guardado por `status = 'ativa'`: se a lease morreu entre a
 * checagem da rota e esta escrita, a transação cai em vez de ressuscitar um
 * trabalho que já pode ter outro dono.
 *
 * @param db Banco aberto.
 * @param dados Id e, opcionalmente, um TTL novo (default: o da própria lease).
 * @param opcoes Relógio injetável.
 * @returns A lease renovada.
 */
export function renovarLease(
  db: BancoDeDados,
  dados: { id: number; ttl_segundos?: number },
  opcoes: OpcoesDeRelogio = {},
): LinhaLease {
  const relogio = opcoes.agora ?? agora;

  db.transaction(() => {
    const atual = buscarLease(db, dados.id);
    if (atual === undefined) throw new Error(`lease ${dados.id} sumiu durante o heartbeat`);

    const momento = relogio();
    const ttl = dados.ttl_segundos ?? atual.ttl_segundos;
    const efeito = db
      .prepare(
        `UPDATE lease SET ttl_segundos = ?, heartbeat_em = ?, expira_em = ?
          WHERE id = ? AND status = 'ativa'`,
      )
      .run(ttl, momento, somarSegundos(momento, ttl), dados.id);

    if (efeito.changes !== 1) {
      throw new Error(`lease ${dados.id} deixou de estar ativa durante o heartbeat`);
    }
  })();

  const renovada = buscarLease(db, dados.id);
  if (renovada === undefined) throw new Error(`lease ${dados.id} sumiu`);
  return renovada;
}

/**
 * Libera uma lease ativa: o trabalho acabou (bem ou mal) e a vaga volta.
 *
 * A capacidade volta na hora, não no vencimento do TTL — a próxima concessão do
 * mesmo runner/projeto já não conta esta lease.
 *
 * @param db Banco aberto.
 * @param id Id da lease.
 * @param opcoes Relógio injetável.
 * @returns A lease liberada.
 */
export function liberarLease(
  db: BancoDeDados,
  id: number,
  opcoes: OpcoesDeRelogio = {},
): LinhaLease {
  const relogio = opcoes.agora ?? agora;

  db.transaction(() => {
    const efeito = db
      .prepare("UPDATE lease SET status = 'liberada', liberada_em = ? WHERE id = ? AND status = 'ativa'")
      .run(relogio(), id);

    if (efeito.changes !== 1) {
      throw new Error(`lease ${id} deixou de estar ativa durante a liberação`);
    }
  })();

  const liberada = buscarLease(db, id);
  if (liberada === undefined) throw new Error(`lease ${id} sumiu`);
  return liberada;
}
