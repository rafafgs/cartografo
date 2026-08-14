/**
 * Endereço de conteúdo de uma versão de grafo (t101, FR3).
 *
 * `grafo_versao.id` é `sha256:` seguido do sha256 da serialização JSON canônica
 * do documento **inteiro** — não de um subconjunto. É a diferença deliberada
 * para o hash de manifesto de skill (`especificacoes/formatos/manifesto-skill.md`),
 * que cobre só `{instrucoes, entrada, saida, checks, permissoes}` porque lá
 * metadado de catálogo não pode invalidar o pino. Aqui vale o contrário: o
 * snapshot de uma versão é o documento inteiro (`docs/spec/grafo.md` §7), e
 * mudar a descrição do grafo É uma versão nova.
 *
 * Canonicalizar é a parte da RFC 8785 que estes formatos usam: chaves ordenadas
 * recursivamente. A ordem das chaves e a formatação do JSON não carregam
 * significado no documento de grafo — dois documentos que só diferem nisso
 * precisam ter o mesmo hash, ou reordenar chave viraria versão nova.
 * Mesma função de `scripts/validar-bundle-fabrica.mjs`.
 */

import { createHash } from 'node:crypto';

/** Prefixo do algoritmo, explícito no valor (como no pino de skill, D4). */
export const PREFIXO_HASH = 'sha256:';

/**
 * Ordena chaves recursivamente.
 *
 * @param valor Valor JSON já parseado.
 * @returns O mesmo valor com todo objeto reescrito em ordem de chave.
 */
export function canonicalizar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonicalizar);
  if (typeof valor === 'object' && valor !== null) {
    const original = valor as Record<string, unknown>;
    const ordenado: Record<string, unknown> = {};
    for (const chave of Object.keys(original).sort()) {
      ordenado[chave] = canonicalizar(original[chave]);
    }
    return ordenado;
  }
  return valor;
}

/**
 * Serialização canônica do documento — é o que vai para a coluna `snapshot`.
 *
 * @param documento Documento de grafo já parseado.
 * @returns JSON com chaves ordenadas, sem espaço supérfluo.
 */
export function serializarCanonico(documento: unknown): string {
  return JSON.stringify(canonicalizar(documento));
}

/**
 * Hash de conteúdo do snapshot.
 *
 * @param documento Documento de grafo já parseado.
 * @returns `sha256:` seguido de 64 hex.
 */
export function hashSnapshot(documento: unknown): string {
  const digest = createHash('sha256').update(serializarCanonico(documento), 'utf8').digest('hex');
  return `${PREFIXO_HASH}${digest}`;
}
