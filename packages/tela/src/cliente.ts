/**
 * Cliente HTTP da API pública — a única porta entre a tela e o estado (t107).
 *
 * A tela é cliente comum da API, sem privilégio nenhum (D11): não abre banco,
 * não importa nada de `packages/core`, e sequer sabe onde o arquivo do SQLite
 * mora. Tudo o que ela mostra passou por aqui, e o que não existe aqui a tela
 * não tem como inventar — foi por isso que esta ficha fechou três lacunas na
 * API em vez de contorná-las (`GET /v1/execucoes` e o filtro `trabalho_id` em
 * sessões e perguntas).
 *
 * As interfaces declaram só o SUBCONJUNTO do contrato que a tela consome, no
 * mesmo espírito de `packages/runner/src/controller/cliente-controle.ts`: um
 * campo a mais na resposta do control plane não quebra nada aqui, e um campo a
 * menos quebra no lugar certo — na fronteira, com o nome da rota no erro.
 *
 * `buscar` é injetável só para teste; em produção é o `fetch` global.
 */

/** Projeção do trabalho, como `GET /v1/trabalhos` a devolve. */
export interface Trabalho {
  id: number;
  execucao_id: number | null;
  titulo: string;
  no_entrada_id: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  grafo_versao_id: string | null;
  criado_em: string;
  atualizado_em: string;
}

/** Uma linha de `GET /v1/execucoes`. */
export interface ResumoDeExecucao {
  execucao_id: number | null;
  trabalhos: number;
  trabalhos_bloqueados: number;
  perguntas_pendentes: number;
}

/** Totais de tokens de uma sessão; `null` quando o engine não reportou nada. */
export interface UsoDeSessao {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Projeção da sessão, como `GET /v1/sessoes` a devolve. */
export interface Sessao {
  id: number;
  trabalho_id: number | null;
  execucao_id: number | null;
  no_id: string | null;
  engine: string;
  status: string;
  exit_code: number | null;
  uso: UsoDeSessao | null;
  aberta_em: string;
  finalizada_em: string | null;
}

/** Projeção da pergunta, como `GET /v1/perguntas` a devolve. */
export interface Pergunta {
  id: number;
  trabalho_id: number;
  execucao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  criada_em: string;
  respondida_em: string | null;
}

/** Envelope de evento, na fatia que a linha do tempo lê. */
export interface Evento {
  id: number;
  tipo: string;
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Recorte pedido a uma rota de listagem. */
export interface Filtro {
  execucao_id?: number;
  trabalho_id?: number;
  status?: string;
}

/**
 * O control plane respondeu, mas com erro.
 *
 * Carrega o status porque a tela precisa distinguir "não existe" (404, que ela
 * repassa como 404 ao navegador) de qualquer outra falha (que vira 502: o
 * problema não é de quem pediu a página).
 */
export class ErroDaApi extends Error {
  readonly status: number;
  readonly corpo: unknown;

  constructor(caminho: string, status: number, corpo: unknown) {
    super(`o control plane respondeu ${status} em ${caminho}`);
    this.name = 'ErroDaApi';
    this.status = status;
    this.corpo = corpo;
  }
}

/** Falha em ALCANÇAR o control plane — distinta de uma resposta de erro dele. */
export class ErroDeRede extends Error {
  readonly url: string;

  constructor(url: string, causa: unknown) {
    super(`não deu para falar com o control plane em ${url}`, { cause: causa });
    this.name = 'ErroDeRede';
    this.url = url;
  }
}

/** Configuração do cliente. */
export interface OpcoesDoCliente {
  /** URL base do control plane (ex.: `http://127.0.0.1:4317`). */
  urlBase: string;
  /** Implementação de `fetch` a usar. Default: o `fetch` global. */
  buscar?: typeof fetch;
}

function consulta(filtro: Filtro): string {
  const parametros = new URLSearchParams();
  if (filtro.status !== undefined) parametros.set('status', filtro.status);
  if (filtro.execucao_id !== undefined) parametros.set('execucao_id', String(filtro.execucao_id));
  if (filtro.trabalho_id !== undefined) parametros.set('trabalho_id', String(filtro.trabalho_id));
  const texto = parametros.toString();
  return texto === '' ? '' : `?${texto}`;
}

/** Cliente fino da fatia da API pública que a tela lê. */
export class ClienteApi {
  /** URL base já normalizada, sem barra no fim. */
  readonly urlBase: string;
  readonly #buscar: typeof fetch;

  constructor(opcoes: OpcoesDoCliente) {
    this.urlBase = opcoes.urlBase.replace(/\/+$/, '');
    this.#buscar = opcoes.buscar ?? fetch;
  }

  /**
   * O quadro: todos os trabalhos, ou os de uma execução.
   *
   * @param filtro Recorte opcional por execução.
   * @returns Trabalhos na ordem em que o control plane mandou.
   */
  async listarTrabalhos(filtro: Filtro = {}): Promise<Trabalho[]> {
    const { trabalhos } = await this.#get<{ trabalhos: Trabalho[] }>(
      `/v1/trabalhos${consulta(filtro)}`,
    );
    return trabalhos;
  }

  /**
   * Um trabalho.
   *
   * @param id Id do trabalho.
   * @returns O trabalho, ou `null` quando o control plane diz que não existe.
   */
  async buscarTrabalho(id: number): Promise<Trabalho | null> {
    return await this.#getOuNulo<Trabalho>(`/v1/trabalhos/${id}`);
  }

  /**
   * A linha do tempo bruta de um trabalho, do log de eventos.
   *
   * @param id Id do trabalho.
   * @returns Eventos em ordem, ou `null` se o trabalho não existe.
   */
  async eventosDoTrabalho(id: number): Promise<Evento[] | null> {
    const corpo = await this.#getOuNulo<{ eventos: Evento[] }>(`/v1/trabalhos/${id}/eventos`);
    return corpo === null ? null : corpo.eventos;
  }

  /**
   * As execuções que existem, com as contagens de cada uma.
   *
   * @returns Uma linha por execução, com o grupo `null` por último.
   */
  async listarExecucoes(): Promise<ResumoDeExecucao[]> {
    const { execucoes } = await this.#get<{ execucoes: ResumoDeExecucao[] }>('/v1/execucoes');
    return execucoes;
  }

  /**
   * As sessões de uma execução ou de um trabalho.
   *
   * @param filtro Recortes opcionais; sem nenhum, todas.
   * @returns Sessões em ordem de id.
   */
  async listarSessoes(filtro: Filtro = {}): Promise<Sessao[]> {
    const { sessoes } = await this.#get<{ sessoes: Sessao[] }>(`/v1/sessoes${consulta(filtro)}`);
    return sessoes;
  }

  /**
   * As perguntas, pelo recorte pedido.
   *
   * @param filtro Recortes opcionais por status, execução e trabalho.
   * @returns Perguntas em ordem de id.
   */
  async listarPerguntas(filtro: Filtro = {}): Promise<Pergunta[]> {
    const { perguntas } = await this.#get<{ perguntas: Pergunta[] }>(
      `/v1/perguntas${consulta(filtro)}`,
    );
    return perguntas;
  }

  /**
   * Responde uma pergunta — a ÚNICA escrita da tela.
   *
   * Escrita de verdade, contra o control plane de verdade: a tela não guarda
   * estado próprio, e a fila só encolhe porque a próxima leitura vem da API.
   * O que acontece DEPOIS desta escrita (desbloquear o trabalho, retomar a
   * sessão do agente) é o ciclo do t106 e não passa por aqui.
   *
   * @param id Id da pergunta.
   * @param resposta O que foi respondido.
   * @param respondidoPor Quem respondeu (obrigatório no payload do evento).
   * @returns A pergunta como ficou.
   * @throws {ErroDaApi} Quando o control plane recusa — 404 inclusive.
   */
  async responderPergunta(id: number, resposta: string, respondidoPor: string): Promise<Pergunta> {
    return await this.#pedir<Pergunta>(`/v1/perguntas/${id}/resposta`, {
      metodo: 'PATCH',
      corpo: { resposta, respondido_por: respondidoPor },
    });
  }

  async #get<T>(caminho: string): Promise<T> {
    return await this.#pedir<T>(caminho, {});
  }

  /** Como `#get`, mas 404 é resposta esperada e vira `null`. */
  async #getOuNulo<T>(caminho: string): Promise<T | null> {
    try {
      return await this.#pedir<T>(caminho, {});
    } catch (erro) {
      if (erro instanceof ErroDaApi && erro.status === 404) return null;
      throw erro;
    }
  }

  async #pedir<T>(
    caminho: string,
    opcoes: { metodo?: string; corpo?: unknown },
  ): Promise<T> {
    const url = `${this.urlBase}${caminho}`;
    const temCorpo = opcoes.corpo !== undefined;

    let resposta: Response;
    let texto: string;
    try {
      resposta = await this.#buscar(url, {
        method: opcoes.metodo ?? 'GET',
        headers: temCorpo ? { 'content-type': 'application/json' } : undefined,
        body: temCorpo ? JSON.stringify(opcoes.corpo) : undefined,
      });
      texto = await resposta.text();
    } catch (causa) {
      throw new ErroDeRede(url, causa);
    }

    const corpo: unknown = texto === '' ? undefined : JSON.parse(texto);
    if (!resposta.ok) throw new ErroDaApi(caminho, resposta.status, corpo);
    return corpo as T;
  }
}
