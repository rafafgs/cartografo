/**
 * Comando `topografo-custo` (t114, FR5).
 *
 * Um subcomando só: `avaliar`. Ele lê a telemetria de uma execução pela API
 * pública, agrega custo por `(versão, nó)`, aplica as políticas e cria uma
 * proposta **pendente** por candidata.
 *
 * ```
 * topografo-custo avaliar --url http://127.0.0.1:4317 --execucao 7 --teto-tokens 200000
 * ```
 *
 * O que ele deliberadamente NÃO faz:
 *
 * - **não aplica nada.** `POST /v1/proposals/:id/apply` não é chamado em lugar
 *   nenhum deste pacote: aplicar é decisão humana no portão (README, princípio 5),
 *   e o inbox é ficha própria (`t111`).
 * - **não deduplica.** Rodar duas vezes sobre a mesma telemetria cria propostas
 *   repetidas. `GET /v1/proposals` existe e daria para checar, mas idempotência
 *   não é o que esta ficha prova e nada aqui a implementa: fora de escopo
 *   declarado (ficha, §6), não bug silencioso.
 *
 * Códigos de saída, na mesma convenção da CLI `cartografo`
 * (`packages/core/src/cli/index.ts`):
 *
 * - `0` — o comando fez o que prometeu (inclusive quando não havia candidata);
 * - `1` — rodou e o resultado foi negativo (servidor fora, API recusou);
 * - `2` — a linha de comando está errada.
 */

import {
  buscarGrafoVersao,
  buscarSessoes,
  buscarTrabalhos,
  criarProposta,
  ErroDaApi,
  type GrafoVersao,
} from './cliente.ts';
import { agregarCusto, linhasIdentificadas } from './custo.ts';
import { avaliarPoliticas } from './politica.ts';

/**
 * Texto de uso. É o mesmo em `--help` (stdout) e em erro de uso (stderr).
 *
 * Em inglês desde a t180, como toda saída de comando do repositório. O que uma
 * pessoa DIGITA — o subcomando `avaliar` e as opções `--teto-tokens`,
 * `--tier-minimo-nos`, ... — continua como está: é superfície publicada, e
 * renomeá-la é outra ficha, com a varredura de identificadores deste pacote.
 */
export const USO = `usage: topografo-custo avaliar --url <url> --execucao <id> [options]

subcommands:
  avaliar                reads the telemetry of an execution, aggregates cost by
                         (graph version, node) and creates one pending proposal
                         per policy candidate. It never applies a proposal.

options:
  --url <url>            control plane to query (required)
  --execucao <id>        execution to evaluate (required)
  --teto-tokens <n>      a candidate when tokens_total of the node passes <n>
  --teto-segundos <n>    a candidate when tempo_total_segundos of the node
                         passes <n>
  --tier-fator <n>       multiple of the version median that makes an outlier
                         (default 3)
  --tier-minimo-nos <n>  fewest measured nodes in a version for tier to be
                         evaluated (default 3)
  --token <token>        control plane credential (env CARTOGRAFO_TOKEN); it is
                         printed the first time the control plane starts
  -h, --help             this text

With no ceiling declared, the ceiling policy does not run: there is nothing to
exceed.`;

/** A linha de comando está errada. Sai 2, como em `cartografo`. */
export class ErroDeUso extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDeUso';
  }
}

/** O que `avaliar` precisa saber. */
export interface OpcoesDeAvaliacao {
  url: string;
  execucaoId: number;
  tetoTokens?: number;
  tetoSegundos?: number;
  tierFator?: number;
  tierMinimoNos?: number;
  /** Implementação de `fetch` a usar. Default: o `fetch` global. */
  buscar?: typeof fetch;
}

/** Uma proposta que este comando acabou de criar. */
export interface PropostaCriada {
  id: number;
  status: string;
  no_id: string;
  grafo_versao_id: string;
  tipo: 'teto' | 'tier';
}

/** O que dá para injetar na execução do comando. Tudo só para teste. */
export interface ContextoDaCli {
  buscar?: typeof fetch;
  escrever?: (texto: string) => void;
}

/** O que sobrou da linha de comando depois de tirar uma opção. */
interface Extracao {
  valor?: string;
  restante: string[];
}

/**
 * Tira uma opção com valor (`--nome valor` ou `--nome=valor`) da lista.
 *
 * @param argumentos Argumentos do subcomando.
 * @param nome Nome longo da opção, com os dois traços.
 * @returns O valor, quando presente, e a lista sem ela.
 */
function extrairValor(argumentos: string[], nome: string): Extracao {
  const restante: string[] = [];
  let valor: string | undefined;

  for (let indice = 0; indice < argumentos.length; indice += 1) {
    const atual = argumentos[indice];
    if (atual === nome) {
      const proximo = argumentos[indice + 1];
      if (proximo === undefined || proximo.startsWith('--')) {
        throw new ErroDeUso(`${nome} needs a value`);
      }
      valor = proximo;
      indice += 1;
      continue;
    }
    if (atual.startsWith(`${nome}=`)) {
      valor = atual.slice(nome.length + 1);
      if (valor === '') throw new ErroDeUso(`${nome} needs a value`);
      continue;
    }
    restante.push(atual);
  }

  return { valor, restante };
}

/** Converte uma opção numérica, recusando lixo em vez de virar `NaN`. */
function comoNumero(nome: string, bruto: string | undefined): number | undefined {
  if (bruto === undefined) return undefined;
  const numero = Number(bruto);
  if (!Number.isFinite(numero) || numero < 0) {
    throw new ErroDeUso(`${nome} needs a non-negative number, got "${bruto}"`);
  }
  return numero;
}

/** A descrição atual de um nó dentro de um snapshot já buscado. */
function descricaoNoSnapshot(versao: GrafoVersao | undefined, noId: string): string {
  const no = versao?.snapshot?.nodes?.find((candidato) => candidato.id === noId);
  return no?.description ?? '';
}

/**
 * O corpo do subcomando `avaliar` (FR5).
 *
 * Busca sessões e trabalhos da execução, monta o mapa
 * `trabalho_id -> grafo_versao_id`, agrega, lê o snapshot de cada versão distinta
 * para saber a descrição atual dos nós, avalia as políticas e cria uma proposta
 * por candidata.
 *
 * @param opcoes URL, execução e calibração das políticas.
 * @returns As propostas criadas, na ordem em que foram criadas.
 * @throws {ErroDaApi} Quando a API recusa alguma das chamadas.
 */
export async function avaliarExecucao(opcoes: OpcoesDeAvaliacao): Promise<PropostaCriada[]> {
  const { url, execucaoId, buscar } = opcoes;
  const filtro = { execucao_id: execucaoId };

  const [sessoes, trabalhos] = await Promise.all([
    buscarSessoes(url, filtro, buscar),
    buscarTrabalhos(url, filtro, buscar),
  ]);

  const versaoPorTrabalho = new Map(
    trabalhos.map((trabalho) => [trabalho.id, trabalho.grafo_versao_id] as const),
  );
  const linhas = linhasIdentificadas(agregarCusto(sessoes, versaoPorTrabalho));

  // Um snapshot por versão distinta, não um por candidata: a mesma versão
  // costuma explicar vários nós caros, e buscá-la de novo a cada um seria
  // barulho na API sem nenhuma informação nova.
  const snapshots = new Map<string, GrafoVersao>();
  for (const versaoId of new Set(linhas.map((linha) => linha.grafo_versao_id))) {
    snapshots.set(versaoId, await buscarGrafoVersao(url, versaoId, buscar));
  }

  const candidatas = avaliarPoliticas(linhas, {
    tetoTokens: opcoes.tetoTokens,
    tetoSegundos: opcoes.tetoSegundos,
    tierFator: opcoes.tierFator,
    tierMinimoNos: opcoes.tierMinimoNos,
    descricaoAtual: (grafoVersaoId, noId) => descricaoNoSnapshot(snapshots.get(grafoVersaoId), noId),
  });

  const criadas: PropostaCriada[] = [];
  for (const candidata of candidatas) {
    const versao = snapshots.get(candidata.grafo_versao_id);
    if (versao === undefined) continue;

    const proposta = await criarProposta(
      url,
      {
        grafo_id: versao.grafo_id,
        versao_alvo: versao.id,
        operacoes: candidata.operacoes,
        evidencia: candidata.evidencia,
        metrica_esperada: candidata.metrica_esperada,
      },
      buscar,
    );

    criadas.push({
      id: proposta.id,
      status: proposta.status,
      no_id: candidata.no_id,
      grafo_versao_id: candidata.grafo_versao_id,
      tipo: candidata.tipo,
    });
  }

  return criadas;
}

/** Uma linha de relatório por proposta criada. */
function linhaDeRelatorio(criada: PropostaCriada): string {
  return `proposal ${criada.id} · node ${criada.no_id} · ${criada.tipo} · ${criada.status}\n`;
}

/**
 * Ponto de entrada do comando: decide o subcomando e devolve o código de saída.
 *
 * Não chama `process.exit`: quem decide isso é quem invoca — mesma escolha de
 * `executarCli` do pacote core.
 *
 * @param argumentos `process.argv.slice(2)`.
 * @param contexto Injeções de teste (`fetch` e escritor de saída).
 * @returns Código de saída.
 */
export async function executarCli(
  argumentos: string[],
  contexto: ContextoDaCli = {},
): Promise<number> {
  const escrever = contexto.escrever ?? ((texto: string) => void process.stdout.write(texto));

  if (argumentos.some((argumento) => argumento === '--help' || argumento === '-h')) {
    escrever(`${USO}\n`);
    return 0;
  }

  const subcomando = argumentos[0];
  if (subcomando !== 'avaliar') {
    process.stderr.write(
      `topografo-custo: unknown subcommand: "${subcomando ?? ''}"\n${USO}\n`,
    );
    return 2;
  }

  try {
    const opcoes = interpretarArgumentos(argumentos.slice(1), contexto.buscar);
    const criadas = await avaliarExecucao(opcoes);

    if (criadas.length === 0) {
      escrever('no candidate: the telemetry of this execution broke no policy\n');
      return 0;
    }
    for (const criada of criadas) escrever(linhaDeRelatorio(criada));
    return 0;
  } catch (erro) {
    if (erro instanceof ErroDeUso) {
      process.stderr.write(`topografo-custo: ${erro.message}\n`);
      process.stderr.write('topografo-custo: run `topografo-custo --help` for the usage\n');
      return 2;
    }
    if (erro instanceof ErroDaApi) {
      process.stderr.write(
        `topografo-custo: ${erro.message}\n${JSON.stringify(erro.corpo ?? null)}\n`,
      );
      return 1;
    }
    // `fetch` estoura TypeError quando não há ninguém escutando na porta. É
    // resultado negativo (servidor fora), não bug — e é o caso mais comum de
    // todos na primeira vez que alguém roda o comando.
    if (erro instanceof TypeError) {
      process.stderr.write(`topografo-custo: could not reach the control plane: ${erro.message}\n`);
      return 1;
    }
    throw erro;
  }
}

/**
 * Variável de ambiente que carrega a credencial do control plane (t124).
 *
 * A mesma do `cartografo`: quem exporta o token uma vez no shell usa o comando
 * daquele control plane sem repetir nada.
 */
export const ENV_TOKEN = 'CARTOGRAFO_TOKEN';

/**
 * Envolve o `fetch` para apresentar a credencial em toda chamada (t124).
 *
 * O ponto de injeção já existia — `buscar` — e é por ele que a credencial entra:
 * as quatro funções de `cliente.ts` continuam sem saber que existe autenticação,
 * do mesmo jeito que não sabem que existe rede além do `fetch` que recebem.
 *
 * @param buscar Implementação base (default: o `fetch` global).
 * @param token Token a apresentar; sem ele, nada é acrescentado ao pedido.
 * @returns O `fetch` que a lente vai usar.
 */
export function comCredencial(buscar: typeof fetch = fetch, token?: string): typeof fetch {
  if (token === undefined || token === '') return buscar;

  return async (entrada, init) => {
    const cabecalhos = new Headers(init?.headers);
    cabecalhos.set('authorization', `Bearer ${token}`);
    return await buscar(entrada, { ...init, headers: cabecalhos });
  };
}

/** Lê as opções de `avaliar`, recusando o que não entende. */
function interpretarArgumentos(
  argumentos: string[],
  buscar?: typeof fetch,
  ambiente: NodeJS.ProcessEnv = process.env,
): OpcoesDeAvaliacao {
  const daUrl = extrairValor(argumentos, '--url');
  const doToken = extrairValor(daUrl.restante, '--token');
  const daExecucao = extrairValor(doToken.restante, '--execucao');
  const doTetoTokens = extrairValor(daExecucao.restante, '--teto-tokens');
  const doTetoSegundos = extrairValor(doTetoTokens.restante, '--teto-segundos');
  const doFator = extrairValor(doTetoSegundos.restante, '--tier-fator');
  const doMinimo = extrairValor(doFator.restante, '--tier-minimo-nos');

  if (doMinimo.restante.length > 0) {
    throw new ErroDeUso(
      `avaliar does not understand: ${doMinimo.restante.map((extra) => `"${extra}"`).join(', ')}`,
    );
  }

  if (daUrl.valor === undefined) throw new ErroDeUso('avaliar needs --url');
  if (daExecucao.valor === undefined) throw new ErroDeUso('avaliar needs --execucao');

  const execucaoId = Number(daExecucao.valor);
  if (!Number.isInteger(execucaoId)) {
    throw new ErroDeUso(`--execucao needs an integer id, got "${daExecucao.valor}"`);
  }

  return {
    url: daUrl.valor,
    execucaoId,
    tetoTokens: comoNumero('--teto-tokens', doTetoTokens.valor),
    tetoSegundos: comoNumero('--teto-segundos', doTetoSegundos.valor),
    tierFator: comoNumero('--tier-fator', doFator.valor),
    tierMinimoNos: comoNumero('--tier-minimo-nos', doMinimo.valor),
    buscar: comCredencial(buscar, doToken.valor?.trim() ?? ambiente[ENV_TOKEN]?.trim()),
  };
}

// Rodar o arquivo direto é o caminho de produção enquanto o pacote não publica
// um `bin` próprio: `node --import tsx src/cli.ts avaliar --url ... --execucao ...`.
if (import.meta.filename === process.argv[1]) {
  process.exitCode = await executarCli(process.argv.slice(2));
}
