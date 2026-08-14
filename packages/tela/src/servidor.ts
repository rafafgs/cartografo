/**
 * O servidor da tela (t107, FR4) — e a porta única das duas metades dela.
 *
 * `node:http` puro, nenhuma dependência de runtime. Este é o ÚNICO módulo que
 * sabe o endereço do control plane — todo o resto recebe um `ClienteApi` já
 * apontado —, e é também o único que conhece HTTP de entrada: `paginas.ts`
 * devolve `{status, html}` e não sabe que existe um `ServerResponse`.
 *
 * **As duas metades da D11 dividem este servidor.** O inbox de propostas
 * (`t111`) é página estática mais proxy same-origin; a observabilidade
 * (`t107`) é renderizada no servidor. As duas moram no mesmo pacote e na mesma
 * porta, então um handler só decide entre elas, nesta ordem:
 *
 * | Caminho | Quem responde |
 * |---|---|
 * | `/v1/*` | proxy verbatim para o control plane (`proxy.ts`) |
 * | arquivo de `src/public/` (`/`, `/inbox.js`, `/style.css`, …) | `static.ts` |
 * | qualquer outro | as views renderizadas aqui (`/quadro`, `/execucoes`, …) |
 *
 * A ordem é o contrato: o proxy vem primeiro porque `/v1` é da API e não da
 * tela; o estático vem antes do render porque `resolveStaticFile` só devolve
 * caminho para extensão conhecida, e é justamente o `null` dele que entrega
 * `/execucoes` e `/trabalhos/7` para as views em vez de 404-á-los como
 * arquivo faltando.
 *
 * A fronteira da D11 se lê inteira aqui: nenhum import de `packages/core`,
 * nenhum driver de banco, nenhum caminho de arquivo. A tela sobe em outra
 * porta, em outro processo, e pode morrer sem o control plane notar — é a
 * prova, e não só a promessa, de que ela é cliente comum da API pública.
 *
 * Precedência do endereço do control plane, igual à da CLI do core
 * (`packages/core/src/cli/url.ts`): `--url` > `CARTOGRAFO_URL` >
 * `http://127.0.0.1:4317`. Assim quem sobe o control plane em outra porta não
 * precisa repetir a configuração em dois vocabulários diferentes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { ClienteApi, ErroDaApi, ErroDeRede } from './cliente.ts';
import { API_PREFIX, forwardRequest, type ProxiedResponse } from './proxy.ts';
import { resolveStaticFile, serveStatic } from './static.ts';
import {
  RESPONDIDO_POR_PADRAO,
  paginaDeErro,
  paginaExecucao,
  paginaExecucoes,
  paginaPerguntas,
  paginaQuadro,
  paginaTrabalho,
  type Pagina,
} from './paginas.ts';

/** Porta default da tela. Vizinha da do control plane, e nunca a mesma. */
export const PORTA_PADRAO = 4318;

/** Variável de ambiente que sobrescreve a porta da tela. */
export const ENV_PORTA = 'CARTOGRAFO_TELA_PORT';

/** Variável de ambiente que aponta o control plane (a mesma que a CLI usa). */
export const ENV_URL = 'CARTOGRAFO_URL';

/** Endereço default do control plane. */
export const URL_CONTROL_PLANE_PADRAO = 'http://127.0.0.1:4317';

/** Endereço de escuta. Loopback, como o control plane: não há autenticação (t124). */
export const HOST_PADRAO = '127.0.0.1';

/**
 * Nome do evento da linha de prontidão impressa em stdout.
 *
 * Um só para o pacote inteiro, e é o da `t111`, que chegou primeiro: as duas
 * metades da tela são UM processo em UMA porta, então duas linhas de prontidão
 * diferentes conforme o ponto de entrada seria a mesma tela mentindo sobre si
 * mesma para quem a supervisiona. `server.ts` o reexporta como `READY_EVENT`.
 */
export const EVENTO_PRONTO = 'cartografo.tela.pronta';

/** Corpo de formulário maior que isto é recusado sem ser lido inteiro. */
const LIMITE_DO_CORPO = 64 * 1024;

/** Erro de uso do comando — vira mensagem, nunca stack trace. */
export class ErroDeUso extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDeUso';
  }
}

/**
 * Resolve a porta em que a tela escuta.
 *
 * @param env Ambiente de onde ler `CARTOGRAFO_TELA_PORT`.
 * @returns Porta válida.
 */
export function portaDaTela(env: NodeJS.ProcessEnv = process.env): number {
  const configurada = env[ENV_PORTA]?.trim();
  if (configurada === undefined || configurada === '') return PORTA_PADRAO;

  const porta = Number(configurada);
  if (!Number.isInteger(porta) || porta < 0 || porta > 65535) {
    throw new ErroDeUso(`${ENV_PORTA} inválida: "${configurada}" (esperado um inteiro de 0 a 65535)`);
  }
  return porta;
}

/**
 * Resolve o endereço do control plane.
 *
 * @param opcao Valor de `--url`, quando veio na linha de comando.
 * @param env Ambiente de onde ler `CARTOGRAFO_URL`.
 * @returns URL base sem barra final.
 */
export function resolverUrlDoControlPlane(
  opcao?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const doAmbiente = env[ENV_URL]?.trim();
  const escolhida =
    opcao !== undefined && opcao.trim() !== ''
      ? opcao.trim()
      : doAmbiente !== undefined && doAmbiente !== ''
        ? doAmbiente
        : URL_CONTROL_PLANE_PADRAO;

  let analisada: URL;
  try {
    analisada = new URL(escolhida);
  } catch {
    throw new ErroDeUso(`URL inválida: "${escolhida}" (esperado algo como ${URL_CONTROL_PLANE_PADRAO})`);
  }
  if (analisada.protocol !== 'http:' && analisada.protocol !== 'https:') {
    throw new ErroDeUso(`URL precisa ser http ou https: "${escolhida}"`);
  }
  return escolhida.replace(/\/+$/, '');
}

/** Lê um `:id` de rota como inteiro positivo; `null` quando não é um. */
function idDaRota(bruto: string): number | null {
  if (!/^[0-9]+$/.test(bruto)) return null;
  const numero = Number(bruto);
  return Number.isSafeInteger(numero) ? numero : null;
}

/** Lê o corpo de um formulário, com teto. */
async function lerFormulario(requisicao: IncomingMessage): Promise<URLSearchParams> {
  const pedacos: Buffer[] = [];
  let tamanho = 0;

  for await (const pedaco of requisicao) {
    const bloco = pedaco as Buffer;
    tamanho += bloco.length;
    if (tamanho > LIMITE_DO_CORPO) throw new ErroDeUso('formulário grande demais');
    pedacos.push(bloco);
  }

  return new URLSearchParams(Buffer.concat(pedacos).toString('utf8'));
}

/** Resposta de uma rota: uma página, ou um redirecionamento. */
type Resultado = Pagina | { redirecionar: string };

/**
 * Traduz uma falha da API em página, sem inventar sucesso.
 *
 * As três traduções, e por que cada uma:
 * - **404 da API vira 404 da tela** — a entidade não existe, e mentir aqui
 *   esconderia o único caso em que o usuário digitou o endereço errado;
 * - **qualquer outro erro do control plane vira 502** — quem falhou foi o
 *   servidor de trás, e o navegador precisa saber que não foi ele;
 * - **não alcançar o control plane vira 502 com o comando que resolve** — a
 *   falha característica desta tela é ser aberta sem o control plane no ar.
 */
function paginaDaFalha(erro: unknown, urlControlPlane: string): Pagina {
  if (erro instanceof ErroDeRede) {
    return paginaDeErro(
      502,
      'control plane fora do ar',
      `Não deu para falar com ${urlControlPlane}. Rode \`npx cartografo\` em outro terminal (ou aponte outro endereço com --url).`,
    );
  }
  if (erro instanceof ErroDaApi) {
    if (erro.status === 404) {
      return paginaDeErro(404, 'não encontrado', 'O control plane não conhece este endereço.');
    }
    return paginaDeErro(
      502,
      'o control plane recusou',
      `${erro.message}. Nada foi alterado por esta tela.`,
    );
  }
  if (erro instanceof ErroDeUso) return paginaDeErro(400, 'pedido inválido', erro.message);
  return paginaDeErro(500, 'erro na tela', 'Algo quebrou ao montar esta página.');
}

/**
 * Decide qual view responde a um pedido.
 *
 * @param cliente Cliente da API pública, já apontado ao control plane.
 * @param requisicao Pedido cru.
 * @returns A página, ou o destino do redirecionamento.
 */
async function rotear(cliente: ClienteApi, requisicao: IncomingMessage): Promise<Resultado> {
  const caminho = new URL(requisicao.url ?? '/', 'http://tela.local').pathname.replace(/\/+$/, '');
  const metodo = requisicao.method ?? 'GET';

  if (metodo === 'GET') {
    // `/quadro`, e não `/`: a raiz é do inbox de propostas (t111), que já era o
    // `index.html` estático deste pacote quando esta metade chegou. As duas
    // metades se linkam pela navegação; nenhuma some.
    if (caminho === '/quadro') return await paginaQuadro(cliente);
    if (caminho === '/execucoes') return await paginaExecucoes(cliente);
    if (caminho === '/perguntas') return await paginaPerguntas(cliente);

    const daExecucao = /^\/execucoes\/([^/]+)$/.exec(caminho);
    if (daExecucao !== null) {
      const id = idDaRota(daExecucao[1]);
      return id === null
        ? paginaDeErro(404, 'execução inválida', 'O id de uma execução é um inteiro.')
        : await paginaExecucao(cliente, id);
    }

    const doTrabalho = /^\/trabalhos\/([^/]+)$/.exec(caminho);
    if (doTrabalho !== null) {
      const id = idDaRota(doTrabalho[1]);
      return id === null
        ? paginaDeErro(404, 'trabalho inválido', 'O id de um trabalho é um inteiro.')
        : await paginaTrabalho(cliente, id);
    }
  }

  if (metodo === 'POST') {
    const daResposta = /^\/perguntas\/([^/]+)\/resposta$/.exec(caminho);
    if (daResposta !== null) {
      const id = idDaRota(daResposta[1]);
      if (id === null) {
        return paginaDeErro(404, 'pergunta inválida', 'O id de uma pergunta é um inteiro.');
      }
      return await responder(cliente, id, requisicao);
    }
  }

  return paginaDeErro(404, 'página não encontrada', `Não existe ${caminho === '' ? '/' : caminho}.`);
}

/**
 * `POST /perguntas/:id/resposta` — a única escrita da tela (FR9).
 *
 * Escreve no control plane DE VERDADE e redireciona (303) para a fila, que é
 * recarregada da API. A pergunta some porque o estado mudou, não porque o
 * formulário a escondeu — e é essa diferença que o teste de aceite cobra, com
 * uma leitura independente no control plane depois do submit.
 *
 * Resposta em branco é recusada aqui, antes da rede: o schema do evento aceita
 * string vazia, e gravar um `pergunta.respondida` sem conteúdo poluiria a
 * auditoria com um fato que não decide nada.
 */
async function responder(
  cliente: ClienteApi,
  perguntaId: number,
  requisicao: IncomingMessage,
): Promise<Resultado> {
  const campos = await lerFormulario(requisicao);
  const resposta = (campos.get('resposta') ?? '').trim();
  if (resposta === '') {
    return paginaDeErro(
      400,
      'resposta em branco',
      'Escreva a resposta (ou clique numa das opções) antes de enviar.',
    );
  }

  const respondidoPor = (campos.get('respondido_por') ?? '').trim();
  await cliente.responderPergunta(
    perguntaId,
    resposta,
    respondidoPor === '' ? RESPONDIDO_POR_PADRAO : respondidoPor,
  );

  // 303 e não 302: depois de um POST, a volta é um GET — é o que impede o
  // navegador de reenviar a resposta quando alguém recarrega a página.
  return { redirecionar: '/perguntas' };
}

/** A tela no ar. */
export interface TelaNoAr {
  servidor: Server;
  /** URL base da tela. */
  url: string;
  /** Control plane que ela lê. */
  urlControlPlane: string;
  encerrar: () => Promise<void>;
}

/** Opções de partida da tela. */
export interface OpcoesDaTela {
  /** Control plane a ler. Default: a precedência de `resolverUrlDoControlPlane`. */
  urlControlPlane?: string;
  /** Porta de escuta. `0` pede uma porta livre ao sistema (uso de teste). */
  porta?: number;
  /** Endereço de escuta. */
  host?: string;
  /** Implementação de `fetch` a usar. Default: o `fetch` global. */
  buscar?: typeof fetch;
}

/** É este caminho da API, ou da tela? */
function ehCaminhoDaApi(caminho: string): boolean {
  return caminho === API_PREFIX || caminho.startsWith(`${API_PREFIX}/`);
}

/** Lê o corpo inteiro de um pedido; o proxy encaminha bytes, não stream. */
async function lerCorpo(requisicao: IncomingMessage): Promise<Buffer> {
  const pedacos: Buffer[] = [];
  for await (const pedaco of requisicao) {
    pedacos.push(Buffer.isBuffer(pedaco) ? pedaco : Buffer.from(pedaco as string));
  }
  return Buffer.concat(pedacos);
}

/**
 * Cria o servidor das duas metades, sem escutar.
 *
 * A ordem das três decisões é o contrato descrito no cabeçalho deste arquivo:
 * API, arquivo, view. Nada aqui inventa sucesso — uma falha ao montar a página
 * vira `paginaDaFalha`, e uma falha ao alcançar o control plane vira a resposta
 * que o próprio `proxy.ts` escreve.
 *
 * @param opcoes Control plane e `fetch` a usar.
 * @returns Servidor pronto para `listen`.
 */
export function criarServidorDaTela(opcoes: OpcoesDaTela = {}): Server {
  const urlControlPlane = opcoes.urlControlPlane ?? resolverUrlDoControlPlane();
  const cliente = new ClienteApi({ urlBase: urlControlPlane, buscar: opcoes.buscar });

  return createServer((requisicao: IncomingMessage, resposta: ServerResponse) => {
    void (async () => {
      const alvo = requisicao.url ?? '/';
      const { pathname } = new URL(alvo, 'http://tela.local');

      // 1. A API é do control plane; a tela só repassa, verbatim.
      if (ehCaminhoDaApi(pathname)) {
        const encaminhada: ProxiedResponse = await forwardRequest(urlControlPlane, {
          method: requisicao.method ?? 'GET',
          target: alvo,
          headers: requisicao.headers,
          body: await lerCorpo(requisicao),
        });
        resposta.writeHead(encaminhada.status, encaminhada.headers);
        resposta.end(encaminhada.body);
        return;
      }

      // 2. Arquivo de `src/public/` — a página do inbox e seus módulos.
      if (resolveStaticFile(pathname) !== null) {
        const arquivo = await serveStatic(pathname);
        resposta.writeHead(arquivo.status, arquivo.headers);
        resposta.end(arquivo.body);
        return;
      }

      // 3. O que sobra é view renderizada aqui.
      let resultado: Resultado;
      try {
        resultado = await rotear(cliente, requisicao);
      } catch (erro) {
        resultado = paginaDaFalha(erro, urlControlPlane);
      }

      if ('redirecionar' in resultado) {
        resposta.writeHead(303, { location: resultado.redirecionar });
        resposta.end();
        return;
      }

      resposta.writeHead(resultado.status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      resposta.end(resultado.html);
    })();
  });
}

/**
 * Sobe a tela.
 *
 * @param opcoes Control plane, porta e host.
 * @returns A tela no ar, com o que é preciso para encerrá-la.
 */
export async function iniciarTela(opcoes: OpcoesDaTela = {}): Promise<TelaNoAr> {
  const urlControlPlane = opcoes.urlControlPlane ?? resolverUrlDoControlPlane();
  const host = opcoes.host ?? HOST_PADRAO;
  const servidor = criarServidorDaTela({ ...opcoes, urlControlPlane });

  await new Promise<void>((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(opcoes.porta ?? portaDaTela(), host, () => {
      servidor.removeListener('error', reject);
      resolve();
    });
  });

  const endereco = servidor.address();
  const porta = endereco !== null && typeof endereco !== 'string' ? endereco.port : 0;

  return {
    servidor,
    url: `http://${host}:${porta}`,
    urlControlPlane,
    encerrar: async () => {
      await new Promise<void>((resolve) => servidor.close(() => resolve()));
    },
  };
}

/**
 * Lê `--url <endereço>` dos argumentos.
 *
 * @param argumentos Argumentos depois do nome do comando.
 * @returns O endereço pedido, ou `undefined`.
 */
export function urlDosArgumentos(argumentos: string[]): string | undefined {
  const indice = argumentos.indexOf('--url');
  if (indice === -1) {
    const colado = argumentos.find((argumento) => argumento.startsWith('--url='));
    return colado?.slice('--url='.length);
  }
  const valor = argumentos[indice + 1];
  if (valor === undefined || valor.startsWith('-')) throw new ErroDeUso('--url exige um endereço');
  return valor;
}

/**
 * Ponto de entrada do comando `cartografo-tela`.
 *
 * Imprime uma linha JSON de prontidão em stdout — o mesmo contrato da partida
 * do control plane, para que um supervisor (ou um teste) saiba que a tela está
 * no ar e contra qual control plane.
 *
 * @param argumentos Argumentos depois do nome do comando.
 * @param env Ambiente de onde ler a configuração.
 */
export async function principal(
  argumentos: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const tela = await iniciarTela({
    urlControlPlane: resolverUrlDoControlPlane(urlDosArgumentos(argumentos), env),
    porta: portaDaTela(env),
  });

  process.stdout.write(
    `${JSON.stringify({
      evento: EVENTO_PRONTO,
      url: tela.url,
      control_plane: tela.urlControlPlane,
    })}\n`,
  );

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void tela
        .encerrar()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}
