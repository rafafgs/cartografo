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
 * - **não aplica nada.** `POST /v1/propostas/:id/aplicar` não é chamado em lugar
 *   nenhum deste pacote: aplicar é decisão humana no portão (README, princípio 5),
 *   e o inbox é ficha própria (`t111`).
 * - **não deduplica.** Rodar duas vezes sobre a mesma telemetria cria propostas
 *   repetidas. Checar duplicidade exigiria uma rota `GET /v1/propostas` que não
 *   existe, e criá-la seria mudança no core — o oposto do que esta ficha prova.
 *   Fora de escopo declarado, não bug silencioso.
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

/** Texto de uso. É o mesmo em `--help` (stdout) e em erro de uso (stderr). */
export const USO = `uso: topografo-custo avaliar --url <url> --execucao <id> [opções]

subcomandos:
  avaliar                lê a telemetria de uma execução, agrega custo por
                         (versão de grafo, nó) e cria uma proposta pendente por
                         candidata de política. Nunca aplica proposta.

opções:
  --url <url>            control plane a consultar (obrigatória)
  --execucao <id>        execução a avaliar (obrigatória)
  --teto-tokens <n>      candidata quando tokens_total do nó passa de <n>
  --teto-segundos <n>    candidata quando tempo_total_segundos do nó passa de <n>
  --tier-fator <n>       múltiplo da mediana da versão que caracteriza outlier
                         (default 3)
  --tier-minimo-nos <n>  mínimo de nós medidos na versão para avaliar tier
                         (default 3)
  -h, --help             este texto

Sem nenhum teto declarado, a política de teto não roda: não há o que exceder.`;

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
        throw new ErroDeUso(`${nome} precisa de um valor`);
      }
      valor = proximo;
      indice += 1;
      continue;
    }
    if (atual.startsWith(`${nome}=`)) {
      valor = atual.slice(nome.length + 1);
      if (valor === '') throw new ErroDeUso(`${nome} precisa de um valor`);
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
    throw new ErroDeUso(`${nome} precisa de um número não negativo, veio "${bruto}"`);
  }
  return numero;
}

/** A descrição atual de um nó dentro de um snapshot já buscado. */
function descricaoNoSnapshot(versao: GrafoVersao | undefined, noId: string): string {
  const no = versao?.snapshot?.nos?.find((candidato) => candidato.id === noId);
  return no?.descricao ?? '';
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
  return `proposta ${criada.id} · nó ${criada.no_id} · ${criada.tipo} · ${criada.status}\n`;
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
      `topografo-custo: subcomando desconhecido: "${subcomando ?? ''}"\n${USO}\n`,
    );
    return 2;
  }

  try {
    const opcoes = interpretarArgumentos(argumentos.slice(1), contexto.buscar);
    const criadas = await avaliarExecucao(opcoes);

    if (criadas.length === 0) {
      escrever('nenhuma candidata: a telemetria desta execução não estourou nenhuma política\n');
      return 0;
    }
    for (const criada of criadas) escrever(linhaDeRelatorio(criada));
    return 0;
  } catch (erro) {
    if (erro instanceof ErroDeUso) {
      process.stderr.write(`topografo-custo: ${erro.message}\n`);
      process.stderr.write('topografo-custo: rode `topografo-custo --help` para o uso\n');
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
      process.stderr.write(`topografo-custo: não consegui falar com o control plane: ${erro.message}\n`);
      return 1;
    }
    throw erro;
  }
}

/** Lê as opções de `avaliar`, recusando o que não entende. */
function interpretarArgumentos(argumentos: string[], buscar?: typeof fetch): OpcoesDeAvaliacao {
  const daUrl = extrairValor(argumentos, '--url');
  const daExecucao = extrairValor(daUrl.restante, '--execucao');
  const doTetoTokens = extrairValor(daExecucao.restante, '--teto-tokens');
  const doTetoSegundos = extrairValor(doTetoTokens.restante, '--teto-segundos');
  const doFator = extrairValor(doTetoSegundos.restante, '--tier-fator');
  const doMinimo = extrairValor(doFator.restante, '--tier-minimo-nos');

  if (doMinimo.restante.length > 0) {
    throw new ErroDeUso(
      `avaliar não entende: ${doMinimo.restante.map((extra) => `"${extra}"`).join(', ')}`,
    );
  }

  if (daUrl.valor === undefined) throw new ErroDeUso('avaliar precisa de --url');
  if (daExecucao.valor === undefined) throw new ErroDeUso('avaliar precisa de --execucao');

  const execucaoId = Number(daExecucao.valor);
  if (!Number.isInteger(execucaoId)) {
    throw new ErroDeUso(`--execucao precisa de um id inteiro, veio "${daExecucao.valor}"`);
  }

  return {
    url: daUrl.valor,
    execucaoId,
    tetoTokens: comoNumero('--teto-tokens', doTetoTokens.valor),
    tetoSegundos: comoNumero('--teto-segundos', doTetoSegundos.valor),
    tierFator: comoNumero('--tier-fator', doFator.valor),
    tierMinimoNos: comoNumero('--tier-minimo-nos', doMinimo.valor),
    buscar,
  };
}

// Rodar o arquivo direto é o caminho de produção enquanto o pacote não publica
// um `bin` próprio: `node --import tsx src/cli.ts avaliar --url ... --execucao ...`.
if (import.meta.filename === process.argv[1]) {
  process.exitCode = await executarCli(process.argv.slice(2));
}
