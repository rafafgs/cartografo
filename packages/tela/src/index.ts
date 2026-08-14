/**
 * Tela do cartografo — placeholder.
 *
 * Existe nesta fase só para provar a fronteira da D11: a tela é um cliente
 * comum da API pública, sem privilégio nenhum sobre o core. Ela não conhece o
 * banco, não importa nada de `packages/core/src/db` e não declara o driver do
 * SQLite — fala com o control plane exclusivamente por HTTP.
 *
 * O conteúdo de verdade (observabilidade e inbox de propostas, D11) entra nas
 * tickets seguintes.
 */

/** Resposta de `GET /health` do control plane. */
export interface Saude {
  status: string;
  db: string;
}

/**
 * Consulta a saúde do control plane pela rota pública.
 *
 * `buscar` é injetável só para teste; em produção é o `fetch` global.
 *
 * @param urlBase URL base do control plane (ex.: `http://127.0.0.1:4317`).
 * @param buscar Implementação de `fetch` a usar.
 * @returns Corpo da resposta de `/health`.
 */
export async function consultarSaude(urlBase: string, buscar: typeof fetch = fetch): Promise<Saude> {
  const resposta = await buscar(`${urlBase.replace(/\/+$/, '')}/health`);
  return (await resposta.json()) as Saude;
}
