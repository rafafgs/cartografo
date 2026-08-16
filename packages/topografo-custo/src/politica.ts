/**
 * Políticas de custo: de linha agregada a candidata de proposta (t114, FR4).
 *
 * Duas políticas, que dizem coisas diferentes:
 *
 * - **`teto`** é absoluta — "este nó passou de N tokens (ou de N segundos)". Só
 *   existe quando alguém declara o teto; sem teto declarado não há o que
 *   exceder, e a lente fica calada em vez de inventar um número.
 * - **`tier`** é relativa — "este nó custa muito mais que os vizinhos da mesma
 *   versão". Exige base amostral (`tierMinimoNos`): com dois nós medidos,
 *   chamar um deles de outlier é ruído, não sinal.
 *
 * **Por que toda candidata é advisória.** Quando esta ficha rodou, nem o
 * documento de grafo (`schema/grafo.schema.json`, nó com
 * `additionalProperties: false`) nem o manifesto de skill tinham campo de custo
 * ou de tier de modelo, e abrir qualquer um dos dois estava fora dela por
 * critério de aceite — o ponto a provar era que um segundo topógrafo cabe na
 * API que já existe, sem alterar formato compartilhado. Sobrava a única mutação
 * que o vocabulário permitia sobre um nó sem inventar campo:
 * `alterar_campo_no` em `description`, com a recomendação em texto. Os números
 * de verdade vão em `evidencia` e `metrica_esperada`, que são JSON livre por
 * design (D15).
 *
 * **A metade que a t166 destravou.** `no.model` existe desde então, e é
 * proposável (`CHANGEABLE_FIELDS`), então a recomendação "use um modelo menor
 * neste portão" já PODE virar `alterar_campo_no` em `model` em vez de prosa em
 * `description`. Trocar a operação que esta lente emite é ficha própria — ela
 * precisa saber qual modelo propor, e isso quer o catálogo de
 * `GET /v1/engines` e uma noção de tier que ninguém escreveu ainda. O que muda
 * hoje é só isto: o campo deixou de ser o obstáculo.
 *
 * A consequência honesta disso é que aplicar uma proposta desta lente não muda
 * custo nenhum sozinha: ela informa quem lê o nó. Enforcement mecânico espera
 * uma superfície de política de verdade (`notas/2026-08-14-aprendizado.md`,
 * item "Políticas"), que é ficha própria.
 */

import type { LinhaDeCustoIdentificada } from './custo.ts';

export type { LinhaDeCustoIdentificada } from './custo.ts';

/** Fator default de "muito mais caro que a mediana". */
export const TIER_FATOR_PADRAO = 3;

/** Mínimo de nós medidos numa versão para que "outlier" queira dizer algo. */
export const TIER_MINIMO_NOS_PADRAO = 3;

/**
 * Prefixo da recomendação anexada à descrição. É o que a torna reconhecível.
 *
 * `cost-surveyor` desde a t180: o texto da proposta é lido por uma pessoa e por
 * isso está em inglês, e `surveyor` é o termo de glossário para `topógrafo`.
 */
export const MARCA = '[cost-surveyor]';

/**
 * `alterar_campo_no` sobre `description`, com a inversa que a desfaz.
 *
 * Declarado aqui em vez de importado de `packages/core/src/dominio/operacoes.ts`
 * de propósito: o topógrafo é cliente comum da API pública e não depende do
 * pacote do core (D1/D11) — mesma escolha de
 * `packages/runner/src/controller/cliente-controle.ts`, que também redeclara o
 * subconjunto do contrato que consome.
 */
export interface AlterarDescricaoDoNo {
  tipo: 'alterar_campo_no';
  no_id: string;
  campo: 'description';
  de: string;
  para: string;
  inversa: {
    tipo: 'alterar_campo_no';
    no_id: string;
    campo: 'description';
    de: string;
    para: string;
  };
}

/** O que a lente viu, e que sustenta a candidata. */
export interface EvidenciaDeCusto {
  lente: 'custo';
  no_id: string;
  grafo_versao_id: string;
  tokens_total: number;
  tempo_total_segundos: number;
  sessoes_com_uso: number;
  sessoes_sem_uso: number;
  teto_excedido: 'tokens' | 'tempo' | null;
  tipo: 'teto' | 'tier';
}

/** A hipótese: que número se espera mover, e para onde. */
export interface MetricaEsperada {
  descricao: string;
  /** Valor que a métrica deveria alcançar (o teto, ou o limiar do tier). */
  alvo: number;
  /** O botão configurado que produziu o alvo: o teto, ou o fator. */
  teto_ou_fator: number;
}

/** Uma proposta ainda não enviada. */
export interface Candidata {
  tipo: 'teto' | 'tier';
  grafo_versao_id: string;
  no_id: string;
  operacoes: [AlterarDescricaoDoNo];
  evidencia: EvidenciaDeCusto;
  metrica_esperada: MetricaEsperada;
}

/** Botões da avaliação. Todos opcionais; sem teto declarado, `teto` não roda. */
export interface OpcoesDePolitica {
  tetoTokens?: number;
  tetoSegundos?: number;
  /** Default: {@link TIER_FATOR_PADRAO}. */
  tierFator?: number;
  /** Default: {@link TIER_MINIMO_NOS_PADRAO}. */
  tierMinimoNos?: number;
  /**
   * Descrição atual do nó, lida do snapshot da versão. É o `de` da operação, e
   * sem ela a inversa não teria para onde voltar. Default: texto vazio.
   */
  descricaoAtual?: (grafoVersaoId: string, noId: string) => string;
}

/** Mediana de uma lista não vazia. Par: média dos dois do meio. */
function mediana(valores: readonly number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 === 1
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

/** Um nó só tem "dado de uso" se ao menos uma sessão dele reportou `uso`. */
function temDado(linha: LinhaDeCustoIdentificada): boolean {
  return linha.sessoes_com_uso > 0;
}

/** Monta a operação advisória: a recomendação anexada à descrição atual. */
function operacaoDeRecomendacao(
  noId: string,
  descricaoAtual: string,
  recomendacao: string,
): AlterarDescricaoDoNo {
  const texto = `${MARCA} ${recomendacao}`;
  const para = descricaoAtual === '' ? texto : `${descricaoAtual}\n\n${texto}`;
  return {
    tipo: 'alterar_campo_no',
    no_id: noId,
    campo: 'description',
    de: descricaoAtual,
    para,
    inversa: {
      tipo: 'alterar_campo_no',
      no_id: noId,
      campo: 'description',
      de: para,
      para: descricaoAtual,
    },
  };
}

/** Fecha a candidata em torno da linha, da operação e dos números. */
function montarCandidata(
  linha: LinhaDeCustoIdentificada,
  tipo: 'teto' | 'tier',
  tetoExcedido: 'tokens' | 'tempo' | null,
  operacao: AlterarDescricaoDoNo,
  metricaEsperada: MetricaEsperada,
): Candidata {
  return {
    tipo,
    grafo_versao_id: linha.grafo_versao_id,
    no_id: linha.no_id,
    operacoes: [operacao],
    evidencia: {
      lente: 'custo',
      no_id: linha.no_id,
      grafo_versao_id: linha.grafo_versao_id,
      tokens_total: linha.tokens_total,
      tempo_total_segundos: linha.tempo_total_segundos,
      sessoes_com_uso: linha.sessoes_com_uso,
      sessoes_sem_uso: linha.sessoes_sem_uso,
      teto_excedido: tetoExcedido,
      tipo,
    },
    metrica_esperada: metricaEsperada,
  };
}

/**
 * Candidatas de teto: uma por linha que estourou algum limite declarado.
 *
 * Uma linha que estoura os DOIS tetos continua sendo uma candidata só — o alvo
 * é o nó, não o limite. `tokens` ganha o rótulo por ser a métrica primária da
 * lente; o número de tempo continua na evidência de qualquer jeito.
 */
function candidatasDeTeto(
  linhas: readonly LinhaDeCustoIdentificada[],
  opcoes: OpcoesDePolitica,
  descricaoAtual: (grafoVersaoId: string, noId: string) => string,
): Candidata[] {
  const { tetoTokens, tetoSegundos } = opcoes;
  if (tetoTokens === undefined && tetoSegundos === undefined) return [];

  const candidatas: Candidata[] = [];
  for (const linha of linhas) {
    const estourouTokens = tetoTokens !== undefined && linha.tokens_total > tetoTokens;
    const estourouTempo = tetoSegundos !== undefined && linha.tempo_total_segundos > tetoSegundos;
    if (!estourouTokens && !estourouTempo) continue;

    const excedido = estourouTokens ? 'tokens' : 'tempo';
    const teto = (estourouTokens ? tetoTokens : tetoSegundos) as number;
    const observado = estourouTokens ? linha.tokens_total : linha.tempo_total_segundos;
    const metrica = estourouTokens ? 'tokens_total' : 'tempo_total_segundos';
    const unidade = estourouTokens ? 'tokens' : 'seconds';
    // A amostra segue o teto que estourou, como todo o resto da linha. Uma
    // sessão pode ter reportado `uso` e não ter os dois carimbos de tempo, e
    // vice-versa (`custo.ts`), então os dois contadores divergem de propósito:
    // citar `sessoes_com_uso` num teto de tempo declara uma base que a métrica
    // do teto não tem. O nome da amostra vai junto do número para que a frase
    // não possa ficar dizendo uma coisa e contando outra.
    const amostra = estourouTokens ? linha.sessoes_com_uso : linha.sessoes_com_tempo;
    const amostraDe = estourouTokens ? 'usage' : 'time';
    // `excedido` é valor de formato (`evidencia.teto_excedido`) e não vira
    // prosa; o rótulo da frase é dele apartado por isso.
    const rotulo = estourouTokens ? 'token' : 'time';

    candidatas.push(
      montarCandidata(
        linha,
        'teto',
        excedido,
        operacaoDeRecomendacao(
          linha.no_id,
          descricaoAtual(linha.grafo_versao_id, linha.no_id),
          `${rotulo} ceiling exceeded: ${observado} ${unidade} observed against a ceiling of ${teto}, over ${amostra} sessions with ${amostraDe} reported. Reduce the scope of this node, split it, or revisit the ceiling.`,
        ),
        {
          descricao: `${metrica} of node "${linha.no_id}" goes back under the declared ceiling`,
          alvo: teto,
          teto_ou_fator: teto,
        },
      ),
    );
  }
  return candidatas;
}

/**
 * Candidatas de tier: uma por nó muito acima da mediana da própria versão.
 *
 * A comparação é DENTRO da versão de propósito: comparar nós de versões
 * diferentes misturaria mudança de topologia com mudança de custo, e a lente
 * não teria como dizer qual das duas explicou o número.
 *
 * Mediana zero desliga a política — com metade dos nós medidos em zero tokens,
 * qualquer valor positivo passaria em qualquer fator, e todo nó viraria outlier.
 */
function candidatasDeTier(
  linhas: readonly LinhaDeCustoIdentificada[],
  opcoes: OpcoesDePolitica,
  descricaoAtual: (grafoVersaoId: string, noId: string) => string,
): Candidata[] {
  const fator = opcoes.tierFator ?? TIER_FATOR_PADRAO;
  const minimoNos = opcoes.tierMinimoNos ?? TIER_MINIMO_NOS_PADRAO;
  if (fator <= 0) return [];

  const porVersao = new Map<string, LinhaDeCustoIdentificada[]>();
  for (const linha of linhas.filter(temDado)) {
    const grupo = porVersao.get(linha.grafo_versao_id);
    if (grupo === undefined) porVersao.set(linha.grafo_versao_id, [linha]);
    else grupo.push(linha);
  }

  const candidatas: Candidata[] = [];
  for (const grupo of porVersao.values()) {
    if (grupo.length < minimoNos) continue;

    const central = mediana(grupo.map((linha) => linha.tokens_total));
    if (central <= 0) continue;

    const limiar = fator * central;
    for (const linha of grupo) {
      if (linha.tokens_total < limiar) continue;

      const vezes = (linha.tokens_total / central).toFixed(1);
      candidatas.push(
        montarCandidata(
          linha,
          'tier',
          null,
          operacaoDeRecomendacao(
            linha.no_id,
            descricaoAtual(linha.grafo_versao_id, linha.no_id),
            `cost out of line in this version: ${linha.tokens_total} tokens, ${vezes}x the median of ${central} across the ${grupo.length} measured nodes (factor ${fator}). Candidate for a cheaper model tier, or for a split into smaller nodes.`,
          ),
          {
            descricao: `tokens_total of node "${linha.no_id}" falls below ${fator}x the version median`,
            alvo: limiar,
            teto_ou_fator: fator,
          },
        ),
      );
    }
  }
  return candidatas;
}

/**
 * Avalia as duas políticas sobre as linhas identificadas (FR4).
 *
 * @param linhas Saída de `agregarCusto`, já sem os pares com `null` — sem versão
 *   e nó não há alvo de operação nem snapshot em que ler a descrição.
 * @param opcoes Tetos e calibração do tier.
 * @returns Candidatas de `teto` primeiro, `tier` depois, cada grupo na ordem das
 *   linhas recebidas. Um mesmo nó pode aparecer nos dois: são dois julgamentos
 *   diferentes sobre o mesmo fato.
 */
export function avaliarPoliticas(
  linhas: readonly LinhaDeCustoIdentificada[],
  opcoes: OpcoesDePolitica,
): Candidata[] {
  const descricaoAtual = opcoes.descricaoAtual ?? ((): string => '');
  return [
    ...candidatasDeTeto(linhas, opcoes, descricaoAtual),
    ...candidatasDeTier(linhas, opcoes, descricaoAtual),
  ];
}
