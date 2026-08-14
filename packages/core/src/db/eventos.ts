/**
 * O log de eventos — a fonte de verdade do control plane (t102, FR2).
 *
 * Este módulo é o ÚNICO que toca a tabela `evento`, e a superfície dele é a
 * regra append-only da taxonomia transformada em código: um insert e duas
 * leituras, mais nada. Não existe `atualizarEvento`, não existe
 * `apagarEvento`, e não é por esquecimento — um fato registrado errado é
 * corrigido por OUTRO fato, nunca por sobrescrita.
 *
 * É a mesma disciplina do `TicketEventRepository` do flowpilot (regra 10),
 * inclusive na forma de garanti-la: `test/evento-append-only.test.ts` cobra a
 * lista de exports daqui e varre o resto do `src/` atrás de update/delete
 * contra a tabela. Acrescentar uma quarta função exportada quebra o teste de
 * propósito.
 *
 * As funções são síncronas porque o driver é síncrono: chamar `registrarEvento`
 * de dentro de um `db.transaction(...)` do chamador é o caminho normal, e é o
 * que faz projeção e evento caírem juntos ou não caírem (FR18).
 */

import type { BancoDeDados } from './connection.ts';
import {
  exigirEventoValido,
  type Entidade,
  type Evento,
  type TipoEntidade,
} from './validacao-evento.ts';

/** Linha crua da tabela, antes de virar envelope. */
interface LinhaEvento {
  id: number;
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade_tipo: string;
  entidade_id: string;
  ator_tipo: string;
  ator_ref: string;
  ocorrido_em: string;
  dados: string;
}

const COLUNAS = `
  id, tipo, projeto_id, execucao_id, entidade_tipo, entidade_id,
  ator_tipo, ator_ref, ocorrido_em, dados
`;

/**
 * Devolve o id da entidade no tipo que o envelope promete.
 *
 * A coluna é TEXT (um log só para cinco entidades, e uma delas tem hash por
 * id — D15), mas o contrato lido pelo cliente diz inteiro para
 * trabalho/sessao/pergunta/lease. A conversão é aqui, na fronteira, e não na
 * cabeça de cada consumidor.
 */
function idDaEntidade(tipo: string, bruto: string): number | string {
  return tipo === 'grafo_versao' ? bruto : Number(bruto);
}

/** Traduz a linha do banco para o envelope da taxonomia. */
function paraEvento(linha: LinhaEvento): Evento {
  return {
    id: linha.id,
    tipo: linha.tipo,
    projeto_id: linha.projeto_id,
    execucao_id: linha.execucao_id,
    entidade: {
      tipo: linha.entidade_tipo as TipoEntidade,
      id: idDaEntidade(linha.entidade_tipo, linha.entidade_id),
    },
    ator: { tipo: linha.ator_tipo as Evento['ator']['tipo'], ref: linha.ator_ref },
    ocorrido_em: linha.ocorrido_em,
    dados: JSON.parse(linha.dados) as Record<string, unknown>,
  };
}

/**
 * Insere um evento no log e devolve o evento já com o id do servidor.
 *
 * Valida antes de gravar (FR3): nada entra no log sem contrato. Rodar dentro de
 * uma transação do chamador é o uso normal — quem grava projeção grava o evento
 * na mesma transação.
 *
 * @param db Handle aberto.
 * @param entrada Envelope sem `id`.
 * @returns O evento gravado, com `id` e `dados` normalizados.
 * @throws {ErroDeValidacao} Quando o envelope ou o payload não fecham.
 */
export function registrarEvento(db: BancoDeDados, entrada: unknown): Evento {
  const evento = exigirEventoValido(entrada);

  const resultado = db
    .prepare(
      `INSERT INTO evento (
         tipo, projeto_id, execucao_id, entidade_tipo, entidade_id,
         ator_tipo, ator_ref, ocorrido_em, dados
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evento.tipo,
      evento.projeto_id,
      evento.execucao_id,
      evento.entidade.tipo,
      String(evento.entidade.id),
      evento.ator.tipo,
      evento.ator.ref,
      evento.ocorrido_em,
      JSON.stringify(evento.dados),
    );

  return { ...evento, id: Number(resultado.lastInsertRowid) };
}

/** Recorte do log pedido a `listarEventos`. */
export interface FiltroDeEventos {
  /**
   * A linha do tempo de um trabalho (FR9): os eventos DELE, mais os de sessão
   * e pergunta que o citam em `dados.trabalho_id`.
   *
   * Note que `sessao.finalizada`, `pergunta.respondida` e
   * `pergunta.auto_resolvida` NÃO aparecem: os schemas daqueles tipos não têm
   * `trabalho_id` no payload (o vínculo foi declarado na abertura/criação, e
   * repeti-lo seria dado duplicado no log). Quem quer o fim da sessão pergunta
   * pela sessão.
   */
  trabalho_id?: number;
}

/**
 * O log, em ordem de `id`.
 *
 * A ordem é a do id porque `ocorrido_em` não é ordenação total: dois eventos
 * podem carregar o mesmo carimbo.
 *
 * @param db Handle aberto.
 * @param filtro Recorte opcional; sem ele, o log inteiro.
 * @returns Eventos do mais antigo para o mais novo.
 */
export function listarEventos(db: BancoDeDados, filtro: FiltroDeEventos = {}): Evento[] {
  if (filtro.trabalho_id === undefined) {
    const todos = db.prepare(`SELECT ${COLUNAS} FROM evento ORDER BY id`).all() as LinhaEvento[];
    return todos.map(paraEvento);
  }

  const linhas = db
    .prepare(
      `SELECT ${COLUNAS} FROM evento
        WHERE (entidade_tipo = 'trabalho' AND entidade_id = @id_texto)
           OR (entidade_tipo IN ('sessao','pergunta')
               AND json_extract(dados, '$.trabalho_id') = @id)
        ORDER BY id`,
    )
    .all({ id: filtro.trabalho_id, id_texto: String(filtro.trabalho_id) }) as LinhaEvento[];
  return linhas.map(paraEvento);
}

/**
 * Os eventos de uma entidade, em ordem de `id`.
 *
 * @param db Handle aberto.
 * @param tipo Tipo da entidade (`trabalho`, `sessao`, `pergunta`, ...).
 * @param id Id da entidade; inteiro para todas menos `grafo_versao`.
 * @returns Eventos daquela entidade, do mais antigo para o mais novo.
 */
export function buscarEventosPorEntidade(
  db: BancoDeDados,
  tipo: Entidade['tipo'],
  id: number | string,
): Evento[] {
  const linhas = db
    .prepare(
      `SELECT ${COLUNAS} FROM evento
        WHERE entidade_tipo = ? AND entidade_id = ?
        ORDER BY id`,
    )
    .all(tipo, String(id)) as LinhaEvento[];
  return linhas.map(paraEvento);
}
