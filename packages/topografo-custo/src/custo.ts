/**
 * Agregação de custo por `(versão de grafo, nó)` — a lente de custo do topógrafo
 * (t114, FR2).
 *
 * `GET /v1/executions/:id/metrics-by-version` já cruza versão × telemetria, mas
 * só conta trabalhos e eventos por `grafo_versao_id`. Aqui o join desce um nível:
 * o par `(grafo_versao_id, no_id)` é a unidade em que uma política de custo
 * consegue apontar um alvo — "a v2 é mais cara que a v1" é opinião até dizer
 * QUAL nó ficou caro.
 *
 * Duas convenções herdadas do core, e nenhuma delas é detalhe:
 *
 * - **`uso` ausente nunca vale zero** (`packages/core/src/repositorios/sessao.ts:9-11`).
 *   Zero tokens é uma medição; ausência é o engine não ter reportado nada. As
 *   duas viram contadores separados (`sessoes_com_uso`/`sessoes_sem_uso`), e é
 *   o segundo que diz o quanto do total dá para acreditar. O mesmo vale para
 *   tempo: sessão ainda aberta é desconhecida, não instantânea.
 * - **Nada some.** Sessão sem trabalho (descoberta, turno de conversa) ou
 *   trabalho sem versão declarada caem num grupo à parte, ordenado por último —
 *   mesma escolha de `metricasPorVersao`
 *   (`packages/core/src/repositorios/trabalho.ts:386-410`): um relatório que
 *   esconde o que não sabe classificar mente sobre o total.
 *
 * Este módulo é aritmética pura: recebe o que a API devolveu e não fala com
 * ninguém. Quem busca é `cliente.ts`.
 */

/** Totais de tokens congelados no fim da vida da sessão. */
export interface UsoDeSessao {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/**
 * Uma sessão como `GET /v1/sessions` a devolve, no subconjunto que a lente lê.
 *
 * Subconjunto deliberado da projeção de `packages/core/src/repositorios/sessao.ts`:
 * declarar só o que se consome é o que faz esta lente sobreviver a campos novos
 * no core sem mudar uma linha.
 */
export interface SessaoObservada {
  trabalho_id: number | null;
  no_id: string | null;
  uso: UsoDeSessao | null;
  aberta_em: string;
  finalizada_em: string | null;
}

/** De que versão de grafo é cada trabalho (`trabalho.grafo_versao_id`). */
export type VersaoPorTrabalho = ReadonlyMap<number, string | null>;

/** Uma linha do agrupamento custo × versão × nó. */
export interface LinhaDeCusto {
  grafo_versao_id: string | null;
  no_id: string | null;
  /** Soma das quatro subchaves de `uso`, só das sessões que reportaram. */
  tokens_total: number;
  sessoes_com_uso: number;
  sessoes_sem_uso: number;
  /** Soma de `finalizada_em - aberta_em`, só das sessões com os dois carimbos. */
  tempo_total_segundos: number;
  sessoes_com_tempo: number;
  sessoes_sem_tempo: number;
}

/**
 * Uma linha cujo par `(versão, nó)` está identificado.
 *
 * Só estas servem de alvo de operação: sem os dois campos não há nó a apontar
 * nem snapshot em que procurá-lo.
 */
export interface LinhaDeCustoIdentificada extends LinhaDeCusto {
  grafo_versao_id: string;
  no_id: string;
}

/** Soma as quatro subchaves. É a definição inteira de "tokens" nesta lente. */
function totalDeTokens(uso: UsoDeSessao): number {
  return (
    uso.input_tokens + uso.output_tokens + uso.cache_creation_input_tokens + uso.cache_read_input_tokens
  );
}

/**
 * Duração de uma sessão em milissegundos, ou `null` se não dá para saber.
 *
 * Carimbo ausente ou impossível de parsear é desconhecimento, e desconhecimento
 * conta em `sessoes_sem_tempo` — nunca como zero.
 */
function duracaoEmMs(sessao: SessaoObservada): number | null {
  if (sessao.finalizada_em === null || sessao.aberta_em === null) return null;
  const inicio = Date.parse(sessao.aberta_em);
  const fim = Date.parse(sessao.finalizada_em);
  if (!Number.isFinite(inicio) || !Number.isFinite(fim)) return null;
  return fim - inicio;
}

/** Chave de agrupamento que distingue `null` do texto "null". */
function chave(grafoVersaoId: string | null, noId: string | null): string {
  return JSON.stringify([grafoVersaoId, noId]);
}

/** Texto primeiro, `null` por último — a ordem de `metricasPorVersao`. */
function compararComNuloPorUltimo(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/**
 * Agrega as sessões de uma execução por `(versão de grafo, nó)` (FR2).
 *
 * @param sessoes Sessões como `GET /v1/sessions?execucao_id=` as devolveu.
 * @param trabalhoPorId Mapa `trabalho_id -> grafo_versao_id`, montado de
 *   `GET /v1/jobs?execucao_id=`. Trabalho ausente do mapa é tratado como
 *   versão desconhecida, não como erro.
 * @returns Uma linha por par distinto observado; pares identificados primeiro,
 *   o grupo com `null` em qualquer das duas pontas por último.
 */
export function agregarCusto(
  sessoes: readonly SessaoObservada[],
  trabalhoPorId: VersaoPorTrabalho,
): LinhaDeCusto[] {
  const porPar = new Map<string, LinhaDeCusto>();

  for (const sessao of sessoes) {
    const grafoVersaoId =
      sessao.trabalho_id === null ? null : (trabalhoPorId.get(sessao.trabalho_id) ?? null);
    const noId = sessao.no_id;

    let linha = porPar.get(chave(grafoVersaoId, noId));
    if (linha === undefined) {
      linha = {
        grafo_versao_id: grafoVersaoId,
        no_id: noId,
        tokens_total: 0,
        sessoes_com_uso: 0,
        sessoes_sem_uso: 0,
        tempo_total_segundos: 0,
        sessoes_com_tempo: 0,
        sessoes_sem_tempo: 0,
      };
      porPar.set(chave(grafoVersaoId, noId), linha);
    }

    if (sessao.uso === null) {
      linha.sessoes_sem_uso += 1;
    } else {
      linha.sessoes_com_uso += 1;
      linha.tokens_total += totalDeTokens(sessao.uso);
    }

    const duracao = duracaoEmMs(sessao);
    if (duracao === null) {
      linha.sessoes_sem_tempo += 1;
    } else {
      linha.sessoes_com_tempo += 1;
      // Acumula em ms e divide uma vez só no fim: somar frações de segundo a
      // cada sessão iria acumulando ruído de ponto flutuante no total.
      linha.tempo_total_segundos += duracao;
    }
  }

  const linhas = [...porPar.values()].map((linha) => ({
    ...linha,
    tempo_total_segundos: linha.tempo_total_segundos / 1000,
  }));

  return linhas.sort((a, b) => {
    const aIdentificada = ehIdentificada(a);
    const bIdentificada = ehIdentificada(b);
    if (aIdentificada !== bIdentificada) return aIdentificada ? -1 : 1;

    const porVersao = compararComNuloPorUltimo(a.grafo_versao_id, b.grafo_versao_id);
    return porVersao !== 0 ? porVersao : compararComNuloPorUltimo(a.no_id, b.no_id);
  });
}

/** A linha tem versão E nó? É o que a torna alvo possível de uma operação. */
export function ehIdentificada(linha: LinhaDeCusto): linha is LinhaDeCustoIdentificada {
  return linha.grafo_versao_id !== null && linha.no_id !== null;
}

/**
 * Recorta só as linhas identificadas, que são as que `avaliarPoliticas` aceita.
 *
 * @param linhas Saída de `agregarCusto`.
 * @returns As linhas com versão e nó preenchidos, na mesma ordem.
 */
export function linhasIdentificadas(linhas: readonly LinhaDeCusto[]): LinhaDeCustoIdentificada[] {
  return linhas.filter(ehIdentificada);
}
