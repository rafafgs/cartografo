/**
 * Cliente HTTP do topógrafo de custo (t114, FR3).
 *
 * Quatro rotas, e nenhuma a mais — três leituras e uma escrita:
 *
 * | Rota | Para quê |
 * |---|---|
 * | `GET /v1/sessions?execucao_id=` | tokens (`uso`) e tempo (`aberta_em`/`finalizada_em`) por `no_id` |
 * | `GET /v1/jobs?execucao_id=` | o mapa `trabalho_id -> grafo_versao_id` |
 * | `GET /v1/graph-versions/:id` | a `descricao` atual do nó, que vira o `de` da operação |
 * | `POST /v1/proposals` | a candidata, como proposta pendente |
 *
 * O CAMINHO é inglês (D18, t127); as CHAVES do corpo seguem em português
 * (`sessoes`, `trabalhos`, `grafo_versao`, `proposta`), porque são chaves de
 * formato e a D18 as tira explicitamente do escopo do inglês.
 *
 * Não existe `POST /v1/proposals/:id/apply` aqui, e a ausência é a regra:
 * aplicar uma proposta é decisão humana no portão (README, princípio 5).
 *
 * Esta é a ÚNICA superfície entre a lente e o estado do sistema. Nada de banco,
 * nada de `packages/core` (D1/D11) — `buscar` é injetável só para teste e em
 * produção é o `fetch` global, mesmo padrão de `packages/tela/src/index.ts:28`.
 */

import type { SessaoObservada } from './custo.ts';
import type { AlterarDescricaoDoNo, EvidenciaDeCusto, MetricaEsperada } from './politica.ts';

/**
 * Um trabalho, no subconjunto que a lente lê de `GET /v1/jobs`.
 *
 * `grafo_versao_id` é anulável aqui porque é anulável lá: a versão é solta na
 * projeção do trabalho (D15).
 */
export interface TrabalhoObservado {
  id: number;
  grafo_versao_id: string | null;
}

/** Um nó do snapshot, no subconjunto que a lente lê. */
export interface NoDoSnapshot {
  id: string;
  descricao?: string;
}

/** Uma versão de grafo com o snapshot inteiro, como a rota a devolve. */
export interface GrafoVersao {
  id: string;
  grafo_id: string;
  snapshot: { nos?: NoDoSnapshot[] };
}

/** Corpo de `POST /v1/proposals`. As cinco chaves que a rota exige. */
export interface EntradaDeProposta {
  grafo_id: string;
  versao_alvo: string;
  operacoes: AlterarDescricaoDoNo[];
  evidencia: EvidenciaDeCusto | Record<string, unknown>;
  metrica_esperada: MetricaEsperada | Record<string, unknown>;
}

/** Uma proposta, no subconjunto que a lente lê da resposta. */
export interface Proposta {
  id: number;
  status: string;
}

/** Recorte por execução. Sem ele, a rota devolve tudo. */
export interface FiltroDeExecucao {
  execucao_id?: number;
}

/**
 * Resposta de erro da API.
 *
 * Carrega status e corpo: quem chama precisa distinguir "execução não existe"
 * de falha passageira, e quem loga precisa do corpo para saber o quê. Mesma
 * forma de `ErroDoControlPlane` (`packages/runner`).
 */
export class ErroDaApi extends Error {
  readonly status: number;
  readonly corpo: unknown;

  constructor(mensagem: string, status: number, corpo: unknown) {
    super(mensagem);
    this.name = 'ErroDaApi';
    this.status = status;
    this.corpo = corpo;
  }
}

/** Tira a barra final da URL base, para não gerar `//v1/...`. */
function normalizar(urlBase: string): string {
  return urlBase.replace(/\/+$/, '');
}

/** Monta `?execucao_id=N`, ou texto vazio — nunca um `?` pendurado. */
function consulta(filtro: FiltroDeExecucao): string {
  if (filtro.execucao_id === undefined) return '';
  return `?execucao_id=${encodeURIComponent(String(filtro.execucao_id))}`;
}

async function interpretar<T>(caminho: string, verbo: string, resposta: Response): Promise<T> {
  const texto = await resposta.text();
  const corpo: unknown = texto === '' ? undefined : JSON.parse(texto);

  if (!resposta.ok) {
    throw new ErroDaApi(`${verbo} ${caminho} respondeu ${resposta.status}`, resposta.status, corpo);
  }

  return corpo as T;
}

async function pegar<T>(urlBase: string, caminho: string, buscar: typeof fetch): Promise<T> {
  return await interpretar<T>(caminho, 'GET', await buscar(`${normalizar(urlBase)}${caminho}`));
}

/**
 * As sessões de uma execução.
 *
 * @param urlBase URL base do control plane.
 * @param filtro Recorte por execução.
 * @param buscar Implementação de `fetch` a usar.
 * @returns As sessões, na ordem em que o server mandou.
 */
export async function buscarSessoes(
  urlBase: string,
  filtro: FiltroDeExecucao = {},
  buscar: typeof fetch = fetch,
): Promise<SessaoObservada[]> {
  const { sessoes } = await pegar<{ sessoes: SessaoObservada[] }>(
    urlBase,
    `/v1/sessions${consulta(filtro)}`,
    buscar,
  );
  return sessoes;
}

/**
 * Os trabalhos de uma execução — de onde sai a versão de grafo de cada sessão.
 *
 * @param urlBase URL base do control plane.
 * @param filtro Recorte por execução.
 * @param buscar Implementação de `fetch` a usar.
 * @returns Os trabalhos, na ordem em que o server mandou.
 */
export async function buscarTrabalhos(
  urlBase: string,
  filtro: FiltroDeExecucao = {},
  buscar: typeof fetch = fetch,
): Promise<TrabalhoObservado[]> {
  const { trabalhos } = await pegar<{ trabalhos: TrabalhoObservado[] }>(
    urlBase,
    `/v1/jobs${consulta(filtro)}`,
    buscar,
  );
  return trabalhos;
}

/**
 * O snapshot de uma versão, para ler a `descricao` atual dos nós.
 *
 * @param urlBase URL base do control plane.
 * @param id Id da versão (`sha256:...`; os dois-pontos entram escapados).
 * @param buscar Implementação de `fetch` a usar.
 * @returns A versão com o documento inteiro.
 */
export async function buscarGrafoVersao(
  urlBase: string,
  id: string,
  buscar: typeof fetch = fetch,
): Promise<GrafoVersao> {
  const { grafo_versao: versao } = await pegar<{ grafo_versao: GrafoVersao }>(
    urlBase,
    `/v1/graph-versions/${encodeURIComponent(id)}`,
    buscar,
  );
  return versao;
}

/**
 * Cria a proposta. Nasce `pendente`: quem aplica é o portão humano.
 *
 * @param urlBase URL base do control plane.
 * @param entrada As cinco chaves do contrato da rota.
 * @param buscar Implementação de `fetch` a usar.
 * @returns A proposta como o server a gravou.
 */
export async function criarProposta(
  urlBase: string,
  entrada: EntradaDeProposta,
  buscar: typeof fetch = fetch,
): Promise<Proposta> {
  const caminho = '/v1/proposals';
  const resposta = await buscar(`${normalizar(urlBase)}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entrada),
  });
  const { proposta } = await interpretar<{ proposta: Proposta }>(caminho, 'POST', resposta);
  return proposta;
}
