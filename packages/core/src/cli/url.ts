/**
 * Endereço do control plane, e o acesso HTTP até ele (t108, FR6).
 *
 * `import`, `export` e `status` são clientes da API como qualquer outro (D1,
 * D11): falam `/health` e `/v1/*` por HTTP e não abrem banco nenhum. Este
 * módulo é toda a rede que os três conhecem — resolver o endereço e fazer o
 * pedido moram juntos porque são a mesma pergunta ("como eu alcanço o control
 * plane?"), e porque manter o `fetch` em um lugar só é o que garante que erro
 * de conexão sempre vire a MESMA mensagem acionável, em vez de um stack trace
 * de `TypeError: fetch failed` vazando para o usuário.
 *
 * Precedência do endereço: `--url` > `CARTOGRAFO_URL` > `http://127.0.0.1:PORTA`.
 * A porta do default vem de `portaDoServidor` (`src/index.ts`), a mesma função
 * que decide onde a partida escuta — assim `CARTOGRAFO_PORT=5000 cartografo up`
 * em um terminal e `CARTOGRAFO_PORT=5000 cartografo status` em outro se
 * encontram sem ninguém precisar repetir `--url`.
 */

import { HOST_PADRAO, portaDoServidor } from '../index.ts';

/** Variável de ambiente que sobrescreve a URL base do control plane. */
export const ENV_URL = 'CARTOGRAFO_URL';

/** Falha em ALCANÇAR o control plane — distinta de uma resposta de erro dele. */
export class ErroDeRede extends Error {
  readonly url: string;

  constructor(url: string, causa: unknown) {
    super(`não deu para falar com o control plane em ${url}`, { cause: causa });
    this.name = 'ErroDeRede';
    this.url = url;
  }
}

/** Uso do comando errado — o chamador vira mensagem, nunca stack trace. */
export class ErroDeUso extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroDeUso';
  }
}

/**
 * A mensagem de servidor fora do ar. Sempre esta, e sempre com o que fazer a
 * seguir: quem roda `import` num terminal limpo não erra por falta de servidor,
 * erra por não saber que precisava subir um.
 *
 * @param url Endereço que não respondeu.
 * @returns Linha única para stderr.
 */
export function mensagemDeServidorFora(url: string): string {
  return `cartografo: não deu para falar com o control plane em ${url} — rode \`cartografo up\` primeiro (ou aponte outro endereço com --url)`;
}

/**
 * Resolve a URL base do control plane.
 *
 * @param opcao Valor de `--url`, quando veio na linha de comando.
 * @param env Ambiente de onde ler `CARTOGRAFO_URL` e `CARTOGRAFO_PORT`.
 * @returns URL base sem barra final.
 */
export function resolverUrlBase(opcao?: string, env: NodeJS.ProcessEnv = process.env): string {
  const doAmbiente = env[ENV_URL]?.trim();
  const escolhida =
    opcao !== undefined && opcao.trim() !== ''
      ? opcao.trim()
      : doAmbiente !== undefined && doAmbiente !== ''
        ? doAmbiente
        : `http://${HOST_PADRAO}:${portaDoServidor(env)}`;

  let analisada: URL;
  try {
    analisada = new URL(escolhida);
  } catch {
    throw new ErroDeUso(`URL inválida: "${escolhida}" (esperado algo como http://127.0.0.1:4317)`);
  }
  if (analisada.protocol !== 'http:' && analisada.protocol !== 'https:') {
    throw new ErroDeUso(`URL precisa ser http ou https: "${escolhida}"`);
  }

  return escolhida.replace(/\/+$/, '');
}

/** Resposta já lida: status e corpo parseado (texto cru, se não for JSON). */
export interface RespostaHttp {
  status: number;
  corpo: unknown;
}

/**
 * Faz um pedido e lê a resposta inteira.
 *
 * Não lança por status de erro — 404 e 422 são resposta, não exceção, e cada
 * subcomando decide o que fazer com o corpo. Só falha em não alcançar o
 * servidor, e aí sempre com `ErroDeRede`.
 *
 * @param url URL completa.
 * @param opcoes Método e corpo JSON, quando houver.
 * @returns Status e corpo já parseado.
 */
export async function pedirJson(
  url: string,
  opcoes: { metodo?: string; corpo?: unknown } = {},
): Promise<RespostaHttp> {
  const temCorpo = opcoes.corpo !== undefined;
  let resposta: Response;
  let texto: string;
  try {
    resposta = await fetch(url, {
      method: opcoes.metodo ?? 'GET',
      headers: temCorpo ? { 'content-type': 'application/json' } : undefined,
      body: temCorpo ? JSON.stringify(opcoes.corpo) : undefined,
    });
    texto = await resposta.text();
  } catch (causa) {
    throw new ErroDeRede(url, causa);
  }

  if (texto === '') return { status: resposta.status, corpo: undefined };
  try {
    return { status: resposta.status, corpo: JSON.parse(texto) };
  } catch {
    return { status: resposta.status, corpo: texto };
  }
}
