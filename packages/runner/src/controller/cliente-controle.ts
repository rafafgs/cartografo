/**
 * Cliente HTTP do control plane (t103, FR10).
 *
 * Esta é a ÚNICA porta entre o runner e o estado do sistema. O runner não abre
 * o arquivo do banco, não importa nada de `packages/core/src/db` e não declara
 * driver de SQLite: só o control plane escreve (D1), e o runner é um cliente
 * comum da API pública — a mesma fronteira que a tela tem (D11).
 * `scripts/check-single-writer.mjs` é o portão dessa regra, e
 * `test/no-privileged-access.test.ts` o mantém verde.
 *
 * `buscar` é injetável só para teste; em produção é o `fetch` global — mesmo
 * padrão de `packages/tela/src/index.ts`.
 *
 * `GET /v1/jobs` é entrega do t102, hoje já mergeada, e devolve
 * `{trabalhos: [...]}`. O cliente consome apenas o subconjunto do contrato de
 * que precisa para escolher um candidato — `id` e `bloqueado` — e declara os
 * demais campos só para documentar o que chega; os testes seguem simulando a
 * rota, porque o que esta ficha prova é o comportamento do cliente, não o do
 * server do t102.
 */

/**
 * Um trabalho, como `GET /v1/jobs` (t102) o devolve.
 *
 * Subconjunto da projeção de `packages/core/src/repositorios/trabalho.ts`: os
 * opcionais são anuláveis lá, e são anuláveis aqui pela mesma razão (execução e
 * versão de grafo são soltas, D15).
 */
export interface Trabalho {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  execucao_id: number | null;
  grafo_versao_id: string | null;
}

/** Um runner pareado. */
export interface Runner {
  id: string;
  nome: string | null;
  registrado_em: string;
}

/** Estados possíveis de uma lease, no vocabulário do control plane. */
export type StatusDeLease = 'ativa' | 'liberada' | 'expirada';

/** Por que uma lease morreu. */
export type MotivoDeExpiracao = 'heartbeat_perdido' | 'expirou';

/** Por que um pedido não virou lease. Nenhum deles é erro. */
export type MotivoDeRecusa = 'trabalho_ja_leased' | 'teto_runner' | 'teto_projeto';

/** Uma lease, como o control plane a devolve. */
export interface Lease {
  id: number;
  runner_id: string;
  trabalho_id: number;
  projeto_id: number;
  status: StatusDeLease;
  ttl_segundos: number;
  concedida_em: string;
  heartbeat_em: string;
  expira_em: string;
  liberada_em: string | null;
  motivo_expiracao: MotivoDeExpiracao | null;
}

/** O que o runner declara ao disputar um trabalho. */
export interface PedidoDeLease {
  runner_id: string;
  projeto_id: number;
  trabalho_id: number;
  teto_runner: number;
  teto_projeto: number;
  ttl_segundos: number;
}

/** Resposta de `POST /v1/leases`: ou saiu lease, ou saiu o motivo. */
export interface RespostaDeConcessao {
  lease: Lease | null;
  motivo?: MotivoDeRecusa;
}

/** Configuração do cliente. */
export interface OpcoesDoCliente {
  /** URL base do control plane (ex.: `http://127.0.0.1:4317`). */
  urlBase: string;
  /** Implementação de `fetch` a usar. Default: o `fetch` global. */
  buscar?: typeof fetch;
}

/**
 * Resposta de erro do control plane.
 *
 * Carrega o status e o corpo: o controller precisa distinguir "runner não
 * pareado" (404, erro de configuração — insistir não adianta) de uma falha
 * passageira, e quem loga precisa do corpo para saber o quê.
 */
export class ErroDoControlPlane extends Error {
  readonly status: number;
  readonly corpo: unknown;

  constructor(mensagem: string, status: number, corpo: unknown) {
    super(mensagem);
    this.name = 'ErroDoControlPlane';
    this.status = status;
    this.corpo = corpo;
  }
}

/** Cliente fino da API do control plane. */
export class ClienteControle {
  /** URL base já normalizada, sem barra no fim. */
  readonly urlBase: string;
  readonly #buscar: typeof fetch;

  constructor(opcoes: OpcoesDoCliente) {
    this.urlBase = opcoes.urlBase.replace(/\/+$/, '');
    this.#buscar = opcoes.buscar ?? fetch;
  }

  /**
   * Pareia o runner. Idempotente no server: chamar de novo não é erro (D5).
   *
   * @param id Identidade declarada pelo runner.
   * @param nome Nome legível, opcional.
   * @returns O runner como ficou registrado.
   */
  async registrarRunner(id: string, nome?: string): Promise<Runner> {
    const corpo = nome === undefined ? { id } : { id, nome };
    const { runner } = await this.#post<{ runner: Runner }>('/v1/runners', corpo);
    return runner;
  }

  /**
   * Trabalhos que estão prontos para serem despachados.
   *
   * O filtro de `bloqueado` mora aqui, do lado do cliente, para consumir o
   * contrato do t102 sem depender de parâmetro de consulta que aquela ficha não
   * prometeu.
   *
   * @returns Só os trabalhos não bloqueados, na ordem em que o server mandou.
   */
  async listarTrabalhosLiberados(): Promise<Trabalho[]> {
    const { trabalhos } = await this.#get<{ trabalhos: Trabalho[] }>('/v1/jobs');
    return trabalhos.filter((trabalho) => trabalho.bloqueado === false);
  }

  /**
   * Disputa um trabalho.
   *
   * @param pedido Runner, projeto, trabalho, os dois tetos e o TTL.
   * @returns A lease concedida, ou `{lease: null, motivo}` — recusa é resposta
   *   normal, não exceção.
   */
  async pedirLease(pedido: PedidoDeLease): Promise<RespostaDeConcessao> {
    return await this.#post<RespostaDeConcessao>('/v1/leases', pedido);
  }

  /**
   * Empurra o prazo da lease para frente.
   *
   * @param leaseId Lease ativa.
   * @param ttlSegundos TTL novo; sem ele, o server mantém o da própria lease.
   * @returns A lease renovada.
   */
  async heartbeat(leaseId: number, ttlSegundos?: number): Promise<Lease> {
    const corpo = ttlSegundos === undefined ? {} : { ttl_segundos: ttlSegundos };
    const { lease } = await this.#post<{ lease: Lease }>(
      `/v1/leases/${leaseId}/heartbeats`,
      corpo,
    );
    return lease;
  }

  /**
   * Devolve a lease e, com ela, a vaga no teto de concorrência.
   *
   * @param leaseId Lease ativa.
   * @returns A lease liberada.
   */
  async liberar(leaseId: number): Promise<Lease> {
    const { lease } = await this.#post<{ lease: Lease }>(`/v1/leases/${leaseId}/releases`, {});
    return lease;
  }

  async #get<T>(caminho: string): Promise<T> {
    return await this.#interpretar(caminho, 'GET', await this.#buscar(`${this.urlBase}${caminho}`));
  }

  async #post<T>(caminho: string, corpo: unknown): Promise<T> {
    const resposta = await this.#buscar(`${this.urlBase}${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    return await this.#interpretar(caminho, 'POST', resposta);
  }

  async #interpretar<T>(caminho: string, verbo: string, resposta: Response): Promise<T> {
    const texto = await resposta.text();
    const corpo: unknown = texto === '' ? undefined : JSON.parse(texto);

    if (!resposta.ok) {
      throw new ErroDoControlPlane(
        `${verbo} ${caminho} respondeu ${resposta.status}`,
        resposta.status,
        corpo,
      );
    }

    return corpo as T;
  }
}
