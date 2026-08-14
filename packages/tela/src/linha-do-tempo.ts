/**
 * A linha do tempo de um trabalho, em três baldes (t107, FR10).
 *
 * É o "tempo genérico" do t81 do flowpilot, o aprendizado registrado em
 * `notas/2026-08-14-aprendizado.md`: o tempo total de um trabalho não diz nada;
 * o que diz é COMO ele se reparte entre esperar na fila, ter um agente
 * trabalhando nele e esperar um humano. Essas três curvas são o insumo do
 * topógrafo — sem elas, propor mutação de grafo é chute.
 *
 * ## Por que isto mora na tela
 *
 * Porque nenhuma rota entrega isso pronto, e porque montá-lo exige cruzar três
 * respostas que o control plane, de propósito, mantém separadas:
 *
 * | Fonte | O que só ela tem |
 * |---|---|
 * | `GET /v1/trabalhos/:id/eventos` | as transições — onde o trabalho esteve |
 * | `GET /v1/sessoes?trabalho_id=` | o FIM das sessões |
 * | `GET /v1/perguntas?trabalho_id=` | o FIM das esperas |
 *
 * A rota de eventos exclui `sessao.finalizada` e `pergunta.respondida` porque
 * os payloads desses eventos não carregam `trabalho_id` — o vínculo foi
 * declarado na abertura, e repeti-lo seria dado duplicado no log
 * (`packages/core/src/db/eventos.ts`). "Quem quer o fim da sessão pergunta pela
 * sessão", diz o comentário de lá; é exatamente o que este módulo faz.
 *
 * ## As regras, em uma frase cada
 *
 * - **`agente_trabalhando`** é `[aberta_em, finalizada_em]` de cada sessão.
 * - **`esperando_humano`** é `[criada_em, respondida_em]` de cada pergunta.
 * - **`fila`** é o COMPLEMENTO: todo intervalo em que não há sessão aberta nem
 *   pergunta pendente. Uma transição CORTA a fila em dois, mesmo sem nada
 *   acontecer no meio — "parado dois dias no refinamento e uma hora na
 *   implementação" e "parado dois dias e uma hora" são diagnósticos diferentes.
 * - O que **não terminou fica aberto** (`fim: null`) e não entra nos totais:
 *   fechar um segmento com o relógio de quem abriu a página inventaria um fato
 *   que o log não tem.
 *
 * **Trabalho concluído** é derivado, porque a API não tem campo de estado
 * terminal: sem sessão aberta, sem pergunta pendente e sem bloqueio. É esse o
 * critério — e só ele — que fecha o último segmento de fila.
 *
 * A função é pura e não olha o relógio: mesmas três respostas, mesma linha do
 * tempo, hoje e daqui a um mês. É o que a torna testável sem tempo real.
 */

/** Os três baldes. */
export type CategoriaDeSegmento = 'fila' | 'agente_trabalhando' | 'esperando_humano';

/** Evento, na fatia que a reconstrução lê. */
export interface EventoDaLinha {
  id: number;
  tipo: string;
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Sessão, na fatia que a reconstrução lê. */
export interface SessaoDaLinha {
  id: number;
  engine: string;
  status: string;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Pergunta, na fatia que a reconstrução lê. */
export interface PerguntaDaLinha {
  id: number;
  status: string;
  pergunta: string;
  criada_em: string;
  respondida_em: string | null;
}

/** Um pedaço da vida do trabalho, em um dos três baldes. */
export interface Segmento {
  categoria: CategoriaDeSegmento;
  inicio: string;
  /** `null` = ainda aberto no instante em que as fontes foram lidas. */
  fim: string | null;
  /** `null` enquanto o segmento estiver aberto: duração ainda não é fato. */
  duracao_ms: number | null;
  /** Nó em que o trabalho estava quando o segmento começou. */
  no_id: string | null;
  /** Id da sessão ou da pergunta que originou o segmento; `null` para fila. */
  ref: number | null;
  /** Rótulo curto para a tela (engine e status, ou o texto da pergunta). */
  detalhe: string | null;
}

/** Tempo fechado acumulado em cada balde, em milissegundos. */
export interface TotaisPorBalde {
  fila: number;
  agente_trabalhando: number;
  esperando_humano: number;
}

/** O que `montarLinhaDoTempo` devolve. */
export interface LinhaDoTempo {
  segmentos: Segmento[];
  totais: TotaisPorBalde;
  /** Bandeira de bloqueio, reduzida do log (não lida da projeção). */
  bloqueado: boolean;
  /** Sem sessão aberta, sem pergunta pendente e sem bloqueio. */
  concluido: boolean;
}

/** As três respostas HTTP de onde tudo isto sai. */
export interface FontesDaLinhaDoTempo {
  eventos: EventoDaLinha[];
  sessoes: SessaoDaLinha[];
  perguntas: PerguntaDaLinha[];
}

/** Ordem de desempate quando dois segmentos começam no mesmo instante. */
const ORDEM_DA_CATEGORIA: Record<CategoriaDeSegmento, number> = {
  fila: 0,
  agente_trabalhando: 1,
  esperando_humano: 2,
};

/** Um instante, com o texto original preservado para sair na página. */
interface Instante {
  texto: string;
  ms: number;
}

/** Intervalo ocupado por alguém — sessão ou espera. */
interface Ocupacao {
  inicio: Instante;
  fim: Instante | null;
}

function instante(texto: string): Instante {
  return { texto, ms: Date.parse(texto) };
}

function instanteOuNulo(texto: string | null): Instante | null {
  return texto === null ? null : instante(texto);
}

/** O nó corrente em cada momento, na ordem em que o trabalho os visitou. */
interface Marco {
  em: Instante;
  no_id: string | null;
}

/**
 * Os pontos em que a fila é cortada: a criação e cada transição.
 *
 * Bloqueio e desbloqueio NÃO cortam: são bandeira, não movimento — o trabalho
 * não sai do nó, e a espera continua sendo a mesma espera.
 */
function marcosDeNo(eventos: EventoDaLinha[]): Marco[] {
  const marcos: Marco[] = [];
  for (const evento of eventos) {
    if (evento.tipo === 'trabalho.criado') {
      marcos.push({ em: instante(evento.ocorrido_em), no_id: textoOuNulo(evento.dados.no_entrada_id) });
    } else if (evento.tipo === 'trabalho.transicao') {
      marcos.push({ em: instante(evento.ocorrido_em), no_id: textoOuNulo(evento.dados.para_no_id) });
    }
  }
  return marcos.sort((a, b) => a.em.ms - b.em.ms);
}

function textoOuNulo(valor: unknown): string | null {
  return typeof valor === 'string' ? valor : null;
}

/** O nó em que o trabalho estava em um instante — o último marco até ali. */
function noEm(marcos: Marco[], ms: number): string | null {
  let atual: string | null = null;
  for (const marco of marcos) {
    if (marco.em.ms > ms) break;
    atual = marco.no_id;
  }
  return atual;
}

/** A bandeira de bloqueio, reduzida do log na ordem dos fatos. */
function bloqueadoNoFim(eventos: EventoDaLinha[]): boolean {
  let bloqueado = false;
  for (const evento of eventos) {
    if (evento.tipo === 'trabalho.bloqueado') bloqueado = true;
    if (evento.tipo === 'trabalho.desbloqueado') bloqueado = false;
  }
  return bloqueado;
}

function segmentoFechado(
  categoria: CategoriaDeSegmento,
  inicio: Instante,
  fim: Instante | null,
  extras: { no_id: string | null; ref: number | null; detalhe: string | null },
): Segmento {
  return {
    categoria,
    inicio: inicio.texto,
    fim: fim?.texto ?? null,
    duracao_ms: fim === null ? null : fim.ms - inicio.ms,
    ...extras,
  };
}

/**
 * Monta a linha do tempo de UM trabalho a partir das três respostas da API.
 *
 * @param fontes Eventos do trabalho, suas sessões e suas perguntas.
 * @returns Segmentos em ordem cronológica, totais por balde e o estado
 *   derivado (bloqueado, concluído).
 */
export function montarLinhaDoTempo(fontes: FontesDaLinhaDoTempo): LinhaDoTempo {
  const marcos = marcosDeNo(fontes.eventos);
  const bloqueado = bloqueadoNoFim(fontes.eventos);

  const ocupacoes: Ocupacao[] = [
    ...fontes.sessoes.map((sessao) => ({
      inicio: instante(sessao.aberta_em),
      fim: instanteOuNulo(sessao.finalizada_em),
    })),
    ...fontes.perguntas.map((pergunta) => ({
      inicio: instante(pergunta.criada_em),
      fim: instanteOuNulo(pergunta.respondida_em),
    })),
  ];

  const segmentos: Segmento[] = [
    ...fontes.sessoes.map((sessao) => {
      const inicio = instante(sessao.aberta_em);
      return segmentoFechado('agente_trabalhando', inicio, instanteOuNulo(sessao.finalizada_em), {
        no_id: noEm(marcos, inicio.ms),
        ref: sessao.id,
        detalhe: `${sessao.engine} · ${sessao.status}`,
      });
    }),
    ...fontes.perguntas.map((pergunta) => {
      const inicio = instante(pergunta.criada_em);
      return segmentoFechado('esperando_humano', inicio, instanteOuNulo(pergunta.respondida_em), {
        no_id: noEm(marcos, inicio.ms),
        ref: pergunta.id,
        detalhe: pergunta.pergunta,
      });
    }),
  ];

  const temAbertos = ocupacoes.some((ocupacao) => ocupacao.fim === null);
  const concluido =
    !temAbertos && !bloqueado && (fontes.eventos.length > 0 || ocupacoes.length > 0);

  const conhecidos = [
    ...fontes.eventos.map((evento) => instante(evento.ocorrido_em)),
    ...ocupacoes.flatMap((ocupacao) => (ocupacao.fim === null ? [ocupacao.inicio] : [ocupacao.inicio, ocupacao.fim])),
  ].sort((a, b) => a.ms - b.ms);

  if (conhecidos.length > 0) {
    const inicio = conhecidos[0];
    const fim = concluido ? conhecidos[conhecidos.length - 1] : null;

    // Os cortes: começo, cada transição, e cada borda de ocupação. Entre dois
    // cortes vizinhos nada muda — ou o trecho está ocupado inteiro, ou é fila
    // inteiro. É o que permite decidir balde por comparação simples.
    const cortes = new Map<number, Instante>();
    const cortar = (ponto: Instante): void => {
      if (ponto.ms < inicio.ms) return;
      if (fim !== null && ponto.ms > fim.ms) return;
      if (!cortes.has(ponto.ms)) cortes.set(ponto.ms, ponto);
    };
    cortar(inicio);
    for (const marco of marcos) cortar(marco.em);
    for (const ocupacao of ocupacoes) {
      cortar(ocupacao.inicio);
      if (ocupacao.fim !== null) cortar(ocupacao.fim);
    }
    if (fim !== null) cortar(fim);

    const ordenados = [...cortes.values()].sort((a, b) => a.ms - b.ms);
    const ocupado = (de: Instante, ate: Instante): boolean =>
      ocupacoes.some(
        (ocupacao) =>
          ocupacao.inicio.ms <= de.ms && (ocupacao.fim === null || ocupacao.fim.ms >= ate.ms),
      );

    for (let indice = 0; indice + 1 < ordenados.length; indice += 1) {
      const de = ordenados[indice];
      const ate = ordenados[indice + 1];
      if (de.ms === ate.ms || ocupado(de, ate)) continue;
      segmentos.push(
        segmentoFechado('fila', de, ate, { no_id: noEm(marcos, de.ms), ref: null, detalhe: null }),
      );
    }

    // A ponta aberta: o trabalho não acabou e ninguém está com ele. Acontece
    // com trabalho bloqueado — e é justamente o tempo que ninguém quer ver
    // crescendo sem explicação.
    const ultimo = ordenados[ordenados.length - 1];
    if (fim === null && !temAbertos) {
      segmentos.push(
        segmentoFechado('fila', ultimo, null, {
          no_id: noEm(marcos, ultimo.ms),
          ref: null,
          detalhe: null,
        }),
      );
    }
  }

  segmentos.sort((a, b) => {
    const porInicio = Date.parse(a.inicio) - Date.parse(b.inicio);
    if (porInicio !== 0) return porInicio;
    return ORDEM_DA_CATEGORIA[a.categoria] - ORDEM_DA_CATEGORIA[b.categoria];
  });

  const totais: TotaisPorBalde = { fila: 0, agente_trabalhando: 0, esperando_humano: 0 };
  for (const segmento of segmentos) {
    totais[segmento.categoria] += segmento.duracao_ms ?? 0;
  }

  return { segmentos, totais, bloqueado, concluido };
}
