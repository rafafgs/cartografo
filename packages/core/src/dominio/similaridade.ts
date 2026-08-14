/**
 * Similaridade textual entre perguntas — a heurística da base de precedentes
 * (t113).
 *
 * `notas/2026-08-14-aprendizado.md` põe a base de precedentes entre os
 * mecanismos que fazem o aprendizado durar: pergunta respondida vira consulta.
 * Consultar exige um número comparável entre dois textos, e a v1 escolhe o mais
 * transparente que existe — índice de Jaccard sobre os tokens do texto
 * normalizado. Não há embedding nem banco vetorial na pilha decidida (D17), e
 * inventar um aqui seria decidir por fora do registro.
 *
 * O contrato que importa é o INTERVALO, não a fórmula: o escore mora em
 * `[0, 1]`, e é isso que deixa trocar a heurística depois (embedding, BM25, o
 * que for) sem mexer no contrato da rota que a consome.
 *
 * Puro de propósito, como `dominio/operacoes.ts`: nada aqui conhece
 * `BancoDeDados`. Quem lê linha é o repositório; aqui só entra e sai texto.
 */

/**
 * Piso de tamanho do token que pontua.
 *
 * Preposição e artigo do português ("a", "de", "no", "em") aparecem em
 * praticamente toda pergunta: contá-los empurraria o escore de QUALQUER par
 * para longe de zero, e um ranking em que tudo se parece com tudo não ajuda
 * ninguém a decidir. Três caracteres é o corte que mantém o número informativo
 * sem exigir lista de stopwords — que seria mais uma coisa a manter.
 */
const TAMANHO_MINIMO_DE_TOKEN = 3;

/** Tudo o que não é letra nem dígito separa token (e vira um único espaço). */
const SEPARADORES = /[^\p{L}\p{N}]+/gu;

/**
 * Põe o texto na forma em que dois textos são comparáveis.
 *
 * Minúsculas, pontuação fora, espaço colapsado, pontas aparadas — e nada além
 * disso. Sem stemming e sem remoção de acento POR DECISÃO: as duas coisas
 * escondem a heurística atrás de mágica, e "migração" e "migracao" serem
 * palavras diferentes é um comportamento que se explica em uma linha, enquanto
 * um stemmer português mal calibrado não é.
 *
 * @param texto Texto cru, como veio da pergunta.
 * @returns O texto normalizado; string vazia se não sobrou nada.
 */
export function normalizarTexto(texto: string): string {
  return texto.toLowerCase().replace(SEPARADORES, ' ').trim();
}

/** Conjunto de tokens que pontuam — repetição não conta, é Jaccard de CONJUNTO. */
function tokensDe(texto: string): Set<string> {
  const partes = normalizarTexto(texto)
    .split(' ')
    .filter((token) => token.length >= TAMANHO_MINIMO_DE_TOKEN);
  return new Set(partes);
}

/**
 * Índice de Jaccard entre os tokens de dois textos: interseção sobre união.
 *
 * Texto idêntico depois de normalizar vale `1`; sem token em comum vale `0`; no
 * meio, a fração de vocabulário compartilhado. Simétrica (`a, b` == `b, a`) e
 * independente de ordem de palavra — duas propriedades que a tornam previsível
 * para quem lê o ranking.
 *
 * O caso degenerado — nenhum dos dois textos tem token de 3+ caracteres, então
 * a união é vazia e a divisão não existe — cai na comparação direta do texto
 * normalizado. É o que preserva as duas pontas do contrato ao mesmo tempo:
 * idêntico continua valendo `1` e não idêntico continua valendo `0`, em vez de
 * `NaN` vazar para dentro de uma ordenação.
 *
 * @param a Um texto.
 * @param b O outro.
 * @returns Escore em `[0, 1]`.
 */
export function similaridade(a: string, b: string): number {
  const tokensA = tokensDe(a);
  const tokensB = tokensDe(b);

  const uniao = new Set([...tokensA, ...tokensB]);
  if (uniao.size === 0) return normalizarTexto(a) === normalizarTexto(b) ? 1 : 0;

  let intersecao = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersecao += 1;
  }

  return intersecao / uniao.size;
}
