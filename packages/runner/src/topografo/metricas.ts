/**
 * The flow lens: one execution's event log folded into time per node (t110,
 * FR3/FR4).
 *
 * This module is the half of the surveyor that no agent touches. It reads the
 * append-only log of a whole execution (`GET /v1/execucoes/:id/eventos`) and
 * answers four questions per node — how long agents were busy on it, how long
 * work sat blocked on it, how long work waited in the dispatch queue for it,
 * and how many questions it escalated — then names the worst one.
 *
 * Computing this here instead of asking the session for it is the point of the
 * whole ticket: the evidence a proposal carries has to be traceable to numbers
 * in the log BY CONSTRUCTION, not by an agent's recall. The agent gets exactly
 * one job later (choosing the `operacoes`), and it gets these numbers as input.
 *
 * Three rules the fold obeys, each of them load-bearing:
 *
 * - **Order is `id`, never `ocorrido_em`.** Two events can carry the same
 *   timestamp; only the server-assigned id is a total ordering. Same rule as
 *   `especificacoes/eventos/reducers/reconstruir-estado.mjs`.
 * - **The node a work sat on is reconstructed from the log**, by folding
 *   `trabalho.criado` and `trabalho.transicao` — the projection only knows
 *   where the work is NOW, and "where was it when it blocked?" is a question
 *   about the past.
 * - **What cannot be attributed is not counted.** A question with no session, a
 *   session on a node the graph no longer has, an interval that runs backwards:
 *   all dropped. A number invented to avoid a gap is worse than the gap.
 *
 * Pure: no HTTP, no clock, no filesystem. Its only input is the log and the
 * node ids of the graph version that ran.
 *
 * English per D18; the metric names stay in Portuguese because they are payload
 * keys of `proposta.evidencia` and land in the book that way.
 */

/** One envelope of the log, reduced to what the fold reads. */
export interface EventoDeFluxo {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** What one node cost in one execution. */
export interface MetricaDeNo {
  no_id: string;
  /** Sum of `sessao.aberta` → `sessao.finalizada` for sessions on this node. */
  tempo_agente_ms: number;
  /** Sum of `trabalho.bloqueado` → `trabalho.desbloqueado`, attributed to the node the work sat on. */
  tempo_espera_ms: number;
  /** Sum of `trabalho.transicao` → the next `sessao.aberta` for the same work and node. */
  tempo_fila_ms: number;
  /** The three above. It is what the ranking sorts by. */
  total_ms: number;
  /** `pergunta.criada` events whose session ran on this node. */
  perguntas: number;
  /** The ids of the events every number above was computed from, ascending. */
  eventos: number[];
}

/** The ranking, plus the node at the top of it. */
export interface MetricasDeFluxo {
  /** Every node of the graph, worst total first, ties broken by node id. */
  por_no: MetricaDeNo[];
  /** The worst node, or `null` when nothing in this run cost any time. */
  gargalo: MetricaDeNo | null;
}

/** Mutable accumulator of one node, before it becomes a `MetricaDeNo`. */
interface Acumulador {
  no_id: string;
  tempo_agente_ms: number;
  tempo_espera_ms: number;
  tempo_fila_ms: number;
  perguntas: number;
  eventos: Set<number>;
}

/** A session, from `sessao.aberta` until its `sessao.finalizada` shows up. */
interface SessaoAberta {
  no_id: string | null;
  trabalho_id: number | null;
  abertaEm: number;
  evento: number;
}

/** An interval that started and is waiting for the event that closes it. */
interface Pendencia {
  no_id: string;
  desde: number;
  evento: number;
}

const texto = (valor: unknown): string | null => (typeof valor === 'string' ? valor : null);

const inteiro = (valor: unknown): number | null =>
  typeof valor === 'number' && Number.isInteger(valor) ? valor : null;

/** Milliseconds of an ISO instant, or `null` when it cannot be read. */
function instante(evento: EventoDeFluxo): number | null {
  const carimbo = Date.parse(evento.ocorrido_em);
  return Number.isNaN(carimbo) ? null : carimbo;
}

/** The entity id as an integer; `trabalho`, `sessao` and `pergunta` all use one. */
function idDaEntidade(evento: EventoDeFluxo): number | null {
  const numero = Number(evento.entidade.id);
  return Number.isInteger(numero) ? numero : null;
}

/**
 * Folds an execution's log into per-node metrics and picks the bottleneck.
 *
 * @param eventos The execution's events, in any order — they are sorted by id
 *   here, so a paginated or out-of-order read reaches the same numbers.
 * @param nos Node ids of the graph version the execution ran under. Only these
 *   are reported; telemetry of a node the graph no longer has is dropped rather
 *   than attributed to something else.
 * @returns The ranking and the worst node, or `gargalo: null` when every total
 *   is zero — "nothing to propose" is a valid outcome, not an error.
 */
export function calcularMetricasDeFluxo(
  eventos: readonly EventoDeFluxo[],
  nos: readonly string[],
): MetricasDeFluxo {
  const acumuladores = new Map<string, Acumulador>();
  for (const no of nos) {
    if (acumuladores.has(no)) continue;
    acumuladores.set(no, {
      no_id: no,
      tempo_agente_ms: 0,
      tempo_espera_ms: 0,
      tempo_fila_ms: 0,
      perguntas: 0,
      eventos: new Set<number>(),
    });
  }

  /** Adds an interval to a node, ignoring what the graph does not have. */
  const somar = (
    no_id: string | null,
    campo: 'tempo_agente_ms' | 'tempo_espera_ms' | 'tempo_fila_ms',
    ms: number,
    origem: readonly number[],
  ): void => {
    const acumulador = no_id === null ? undefined : acumuladores.get(no_id);
    if (acumulador === undefined) return;
    // An interval that runs backwards is a clock disagreement, not negative
    // time: `ocorrido_em` is not a total ordering, and subtracting here would
    // let one bad timestamp erase a real cost.
    acumulador[campo] += Math.max(0, ms);
    for (const id of origem) acumulador.eventos.add(id);
  };

  const noAtual = new Map<number, string>();
  const naFila = new Map<number, Pendencia>();
  const bloqueado = new Map<number, Pendencia>();
  const sessoes = new Map<number, SessaoAberta>();

  for (const evento of [...eventos].sort((a, b) => a.id - b.id)) {
    const quando = instante(evento);
    const entidade = idDaEntidade(evento);
    if (quando === null || entidade === null) continue;

    switch (evento.tipo) {
      case 'trabalho.criado': {
        const entrada = texto(evento.dados.no_entrada_id);
        if (entrada !== null) noAtual.set(entidade, entrada);
        break;
      }

      case 'trabalho.transicao': {
        const destino = texto(evento.dados.para_no_id);
        if (destino === null) break;
        noAtual.set(entidade, destino);
        // Landing on a node starts the dispatch clock. A previous landing that
        // never got a session is overwritten: the work left without one, and
        // there is no queue time to charge anyone.
        naFila.set(entidade, { no_id: destino, desde: quando, evento: evento.id });
        break;
      }

      case 'trabalho.bloqueado': {
        const onde = noAtual.get(entidade);
        if (onde === undefined) break;
        bloqueado.set(entidade, { no_id: onde, desde: quando, evento: evento.id });
        break;
      }

      case 'trabalho.desbloqueado': {
        const espera = bloqueado.get(entidade);
        if (espera === undefined) break;
        bloqueado.delete(entidade);
        somar(espera.no_id, 'tempo_espera_ms', quando - espera.desde, [espera.evento, evento.id]);
        break;
      }

      case 'sessao.aberta': {
        const no_id = texto(evento.dados.no_id);
        const trabalho_id = inteiro(evento.dados.trabalho_id);
        sessoes.set(entidade, { no_id, trabalho_id, abertaEm: quando, evento: evento.id });

        if (trabalho_id === null || no_id === null) break;
        const fila = naFila.get(trabalho_id);
        // Only the session that opens ON THE NODE the work landed on closes the
        // queue interval; anything else is a different node's business.
        if (fila === undefined || fila.no_id !== no_id) break;
        naFila.delete(trabalho_id);
        somar(no_id, 'tempo_fila_ms', quando - fila.desde, [fila.evento, evento.id]);
        break;
      }

      case 'sessao.finalizada': {
        const sessao = sessoes.get(entidade);
        if (sessao === undefined) break;
        somar(sessao.no_id, 'tempo_agente_ms', quando - sessao.abertaEm, [
          sessao.evento,
          evento.id,
        ]);
        break;
      }

      case 'pergunta.criada': {
        // The node comes from the session that asked. A question with no
        // session (`sessao_id: null` is allowed by the taxonomy) belongs to no
        // node, and guessing one would be inventing a number.
        const sessaoId = inteiro(evento.dados.sessao_id);
        const sessao = sessaoId === null ? undefined : sessoes.get(sessaoId);
        const acumulador =
          sessao?.no_id === undefined || sessao.no_id === null
            ? undefined
            : acumuladores.get(sessao.no_id);
        if (acumulador === undefined) break;
        acumulador.perguntas += 1;
        acumulador.eventos.add(evento.id);
        break;
      }

      default:
        break;
    }
  }

  const por_no = [...acumuladores.values()]
    .map((acumulador) => ({
      no_id: acumulador.no_id,
      tempo_agente_ms: acumulador.tempo_agente_ms,
      tempo_espera_ms: acumulador.tempo_espera_ms,
      tempo_fila_ms: acumulador.tempo_fila_ms,
      total_ms:
        acumulador.tempo_agente_ms + acumulador.tempo_espera_ms + acumulador.tempo_fila_ms,
      perguntas: acumulador.perguntas,
      eventos: [...acumulador.eventos].sort((a, b) => a - b),
    }))
    // Ties broken by node id so the ranking is a function of the log alone —
    // two runs with the same numbers must name the same bottleneck.
    .sort((a, b) => b.total_ms - a.total_ms || (a.no_id < b.no_id ? -1 : 1));

  const primeiro = por_no[0];
  return {
    por_no,
    gargalo: primeiro !== undefined && primeiro.total_ms > 0 ? primeiro : null,
  };
}
