/**
 * Roteador do comando `cartografo` (t108, FR1/FR7).
 *
 * O comando nasceu fazendo uma coisa só — subir o control plane — e continua
 * fazendo exatamente isso quando chamado sem argumento. Isso não é
 * retrocompatibilidade por educação: `npx cartografo` é a porta de entrada do
 * projeto, e time-to-first-graph é inegociável de qualidade
 * (`notas/2026-08-14-extensao-e-qualidade.md`). Um subcomando obrigatório
 * acrescentaria uma palavra ao caminho mais percorrido do produto para benefício
 * de ninguém.
 *
 * Os outros três (`import`, `export`, `status`) são clientes HTTP puros da API
 * pública: não abrem banco, não importam `src/db/**` e não têm privilégio
 * nenhum sobre a tela ou o runner (D1, D11). O que eles conhecem do control
 * plane cabe em `cli/url.ts`.
 *
 * Convenção única de código de saída:
 *
 * - `0` — o comando fez o que prometeu;
 * - `1` — o comando rodou e o resultado foi negativo (servidor fora, grafo
 *   recusado, classe desconhecida);
 * - `2` — a linha de comando está errada (subcomando inexistente, argumento
 *   faltando). É o mesmo `2` que `scripts/validar-bundle-fabrica.mjs` usa para
 *   uso incorreto.
 */

import { PORTA_PADRAO, principal } from '../index.ts';
import { executarExport } from './exportar.ts';
import { executarImport } from './importar.ts';
import { executarStatus } from './status.ts';
import { ENV_URL, ErroDeRede, ErroDeUso, mensagemDeServidorFora, resolverUrlBase } from './url.ts';

/** Texto de uso. É o mesmo em `--help` (stdout) e em subcomando errado (stderr). */
export const USO = `uso: cartografo [subcomando] [opções]

subcomandos:
  up                     sobe o control plane: banco, migrações e HTTP. É o
                         default — \`cartografo\` sem argumento faz isto.
  import <caminho>       registra um grafo como linhagem base nova. <caminho> é
                         um arquivo de grafo ou um diretório de bundle (com
                         grafo.json e, opcionalmente, skills/ para conferir).
  export <classe>        grava a versão corrente da classe em um arquivo, no
                         mesmo formato que import aceita de volta.
  status                 relata servidor e projetos registrados.

opções:
  --url <url>            control plane a consultar (env ${ENV_URL};
                         default http://127.0.0.1:${PORTA_PADRAO})
  --out <caminho>        (export) arquivo de saída; default ./<classe>.grafo.json
  --json                 (status) imprime o relatório como um objeto JSON único
  -h, --help             este texto

Configuração da partida: CARTOGRAFO_DB_PATH, CARTOGRAFO_PORT.`;

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

/** Tira uma bandeira booleana da lista. */
function extrairBandeira(argumentos: string[], nome: string): { presente: boolean; restante: string[] } {
  const restante = argumentos.filter((argumento) => argumento !== nome);
  return { presente: restante.length !== argumentos.length, restante };
}

/** Recusa o que sobrou na linha de comando em vez de ignorar em silêncio. */
function exigirNadaAlem(sobrou: string[], quantosPosicionais: number, subcomando: string): void {
  const extras = sobrou.slice(quantosPosicionais);
  if (extras.length > 0) {
    throw new ErroDeUso(`${subcomando} não entende: ${extras.map((extra) => `"${extra}"`).join(', ')}`);
  }
}

/** Sobe o control plane, preservando a mensagem de falha que a partida já tinha. */
async function subirControlPlane(): Promise<number> {
  try {
    await principal();
    return 0;
  } catch (erro) {
    console.error('cartografo: falha na partida');
    console.error(erro);
    return 1;
  }
}

/**
 * Roteia um dos subcomandos que falam com a API.
 *
 * @param subcomando `import`, `export` ou `status`.
 * @param argumentos Argumentos depois do subcomando.
 * @param env Ambiente de onde sai a URL default.
 * @returns Código de saída do processo.
 */
async function rodarClienteDaApi(
  subcomando: string,
  argumentos: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const daUrl = extrairValor(argumentos, '--url');
  const url = resolverUrlBase(daUrl.valor, env);

  if (subcomando === 'import') {
    exigirNadaAlem(daUrl.restante, 1, 'import');
    const caminho = daUrl.restante[0];
    if (caminho === undefined) {
      throw new ErroDeUso('import precisa de um caminho: um arquivo de grafo ou um diretório de bundle');
    }
    return await executarImport({ caminho, url });
  }

  if (subcomando === 'export') {
    const daSaida = extrairValor(daUrl.restante, '--out');
    exigirNadaAlem(daSaida.restante, 1, 'export');
    const classe = daSaida.restante[0];
    if (classe === undefined) throw new ErroDeUso('export precisa da classe do grafo');
    return await executarExport({ classe, url, saida: daSaida.valor });
  }

  const daBandeira = extrairBandeira(daUrl.restante, '--json');
  exigirNadaAlem(daBandeira.restante, 0, 'status');
  return await executarStatus({ url, json: daBandeira.presente });
}

/**
 * Ponto de entrada do comando: decide o subcomando e devolve o código de saída.
 *
 * Não chama `process.exit`: quem decide isso é o `bin`, e `up` precisa que o
 * processo continue vivo servindo HTTP depois que esta função retorna.
 *
 * @param argumentos `process.argv.slice(2)`.
 * @param env Ambiente do processo.
 * @returns Código de saída.
 */
export async function executarCli(
  argumentos: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argumentos.some((argumento) => argumento === '--help' || argumento === '-h' || argumento === 'help')) {
    process.stdout.write(`${USO}\n`);
    return 0;
  }

  const subcomando = argumentos[0] ?? 'up';
  const resto = argumentos.slice(1);

  if (subcomando === 'up') return await subirControlPlane();

  if (subcomando !== 'import' && subcomando !== 'export' && subcomando !== 'status') {
    process.stderr.write(`cartografo: subcomando desconhecido: "${subcomando}"\n${USO}\n`);
    return 2;
  }

  try {
    return await rodarClienteDaApi(subcomando, resto, env);
  } catch (erro) {
    if (erro instanceof ErroDeRede) {
      process.stderr.write(`${mensagemDeServidorFora(erro.url)}\n`);
      return 1;
    }
    if (erro instanceof ErroDeUso) {
      process.stderr.write(`cartografo: ${erro.message}\n`);
      process.stderr.write('cartografo: rode `cartografo --help` para o uso\n');
      return 2;
    }
    throw erro;
  }
}
