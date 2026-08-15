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
 * Subconjunto da projeção de `packages/core/src/repositories/job.ts`: os
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

/**
 * Um envelope do log, como a API o devolve (t102).
 *
 * Declarado à mão aqui, como o resto do arquivo: o cliente descreve o CONTRATO
 * que consome, e importar o tipo do core furaria a fronteira que este módulo
 * existe para manter.
 */
export interface Evento {
  id: number;
  tipo: string;
  projeto_id: number;
  execucao_id: number | null;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  ocorrido_em: string;
  dados: Record<string, unknown>;
}

/** Uma linha de `GET /v1/executions/:id/metrics-by-version` (t102, FR17). */
export interface MetricaPorVersao {
  grafo_versao_id: string | null;
  trabalhos: number;
  eventos: number;
}

/**
 * O documento de grafo dentro de uma versão.
 *
 * Só `nos` e `arestas` são nomeados: é o que o topógrafo lê para montar o
 * prompt. O resto do documento chega inteiro e passa direto — o formato é do
 * `schema/grafo.schema.json`, não deste cliente.
 */
export interface SnapshotDeGrafo {
  nos?: Array<{ id: string; [chave: string]: unknown }>;
  arestas?: Array<{ de: string; para: string; condicao?: string; [chave: string]: unknown }>;
  [chave: string]: unknown;
}

/** Uma versão de grafo, como `GET /v1/graph-versions/:id` a devolve (t101). */
export interface VersaoDeGrafo {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  snapshot: SnapshotDeGrafo;
  criado_em: string;
}

/** O que `POST /v1/proposals` exige: um diff semântico com hipótese (D15). */
export interface EntradaDeProposta {
  grafo_id: string;
  versao_alvo: string;
  operacoes: readonly unknown[];
  evidencia: unknown;
  metrica_esperada: unknown;
}

/**
 * Uma proposta, no recorte que o runner precisa da resposta.
 *
 * `metrica_esperada` e `resultado` chegam como `unknown` de propósito: a forma
 * das duas é do control plane (`hypothesis.ts`), e o runner só as repassa ou
 * lê o `nome` de dentro — declarar a forma aqui seria duplicar um contrato do
 * outro lado da fronteira.
 */
export interface Proposta {
  id: number;
  grafo_id: string;
  versao_alvo: string;
  status: string;
  versao_aplicada_id: string | null;
  metrica_esperada?: unknown;
  resultado?: unknown;
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
  /**
   * Credencial apresentada em toda chamada (t124, t143).
   *
   * Genérica de propósito: é um token qualquer que o control plane aceite. Em
   * produção é a credencial que o pareamento emitiu para ESTE runner (`token`
   * no `201` de `POST /v1/runners`), que só alcança as rotas de despacho e só
   * como este `runner_id`; a de operador serve, e é o que os testes mais
   * antigos usam, mas dá ao runner acesso que ele não precisa ter. Sem token
   * nenhum o cliente não manda cabeçalho e toma 401, que é o comportamento
   * honesto: um cabeçalho vazio se pareceria com credencial.
   */
  token?: string;
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

/**
 * Decodifica o corpo de uma resposta de ERRO, sem nunca estourar (t156).
 *
 * Quem responde um erro nem sempre é o control plane: um proxy reverso no meio
 * do caminho responde 502/504 com uma página HTML, e aí o `JSON.parse` estoura
 * um `SyntaxError` cru — que não carrega o status nem o texto, e não é o erro
 * que este módulo promete. Falhar em decodificar o corpo de um erro não é uma
 * segunda falha: é o corpo, do jeito que veio.
 *
 * Não vale para o caminho de sucesso, de propósito: corpo malformado num 2xx é
 * violação de contrato do control plane, e essa tem que aparecer.
 *
 * @param texto O corpo da resposta, como texto.
 * @returns `undefined` para corpo vazio, o valor decodificado quando é JSON, e
 *   o próprio texto cru quando não é.
 */
function corpoDeErro(texto: string): unknown {
  if (texto === '') return undefined;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

/** Cliente fino da API do control plane. */
export class ClienteControle {
  /** URL base já normalizada, sem barra no fim. */
  readonly urlBase: string;
  readonly #buscar: typeof fetch;
  readonly #token: string | undefined;

  constructor(opcoes: OpcoesDoCliente) {
    this.urlBase = opcoes.urlBase.replace(/\/+$/, '');
    this.#buscar = opcoes.buscar ?? fetch;
    this.#token = opcoes.token;
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

  /* ------------------------------------------------------------------------ */
  /* t110 — the three reads and the one write the flow surveyor needs.         */
  /* Same door as everything else: the runner speaks HTTP and nothing else.    */
  /* ------------------------------------------------------------------------ */

  /**
   * O log inteiro de uma execução, em ordem de `id` (t110, FR1).
   *
   * @param execucaoId Agrupador opaco da rodada.
   * @returns Todos os eventos da execução; lista vazia quando não houve nenhum
   *   — execução não é entidade, então não existe 404 aqui.
   */
  async listarEventosDaExecucao(execucaoId: number): Promise<Evento[]> {
    const { eventos } = await this.#get<{ eventos: Evento[] }>(
      `/v1/executions/${execucaoId}/events`,
    );
    return eventos;
  }

  /**
   * Versão de grafo × telemetria daquela execução (t102, FR17).
   *
   * É por aqui que o topógrafo descobre sob QUE versão a rodada correu: o log
   * não carrega `grafo_versao_id` (o schema de `trabalho.criado` não o declara),
   * e essa consulta existe exatamente para o cruzamento.
   *
   * @param execucaoId Agrupador opaco da rodada.
   * @returns Uma linha por versão; a linha `null` agrupa trabalhos sem versão.
   */
  async metricasPorVersao(execucaoId: number): Promise<MetricaPorVersao[]> {
    const { metricas } = await this.#get<{ metricas: MetricaPorVersao[] }>(
      `/v1/executions/${execucaoId}/metrics-by-version`,
    );
    return metricas;
  }

  /**
   * Uma versão de grafo, com o snapshot completo.
   *
   * @param id Id da versão (o hash do snapshot, com `:` — daí o encode).
   * @returns A versão e o documento que ela congela.
   * @throws {ErroDoControlPlane} 404 quando a versão não existe.
   */
  async buscarVersaoDeGrafo(id: string): Promise<VersaoDeGrafo> {
    const { grafo_versao: versao } = await this.#get<{ grafo_versao: VersaoDeGrafo }>(
      `/v1/graph-versions/${encodeURIComponent(id)}`,
    );
    return versao;
  }

  /**
   * Cria uma proposta — que nasce, sempre, `pendente`.
   *
   * Não existe par `aplicar` neste cliente de propósito: aplicar é decisão
   * humana (README, princípio 5), e um cliente que não tem o método não a toma
   * por engano.
   *
   * @param entrada Grafo, versão-alvo, operações, evidência e métrica esperada.
   * @returns A proposta gravada.
   * @throws {ErroDoControlPlane} 400 quando o server recusa a forma.
   */
  async criarProposta(entrada: EntradaDeProposta): Promise<Proposta> {
    const { proposta } = await this.#post<{ proposta: Proposta }>('/v1/proposals', entrada);
    return proposta;
  }

  /**
   * Uma proposta, pelo id (t165, FR9).
   *
   * Quem vai fechar o experimento precisa da `metrica_esperada` que a hipótese
   * declarou — é o `nome` dela que diz QUAL número medir na rodada seguinte.
   *
   * @param id Id da proposta.
   * @returns A proposta, no recorte que o runner consome.
   * @throws {ErroDoControlPlane} 404 quando a proposta não existe.
   */
  async buscarProposta(id: number): Promise<Proposta> {
    const { proposta } = await this.#get<{ proposta: Proposta }>(`/v1/proposals/${id}`);
    return proposta;
  }

  /**
   * Fecha o experimento de uma proposta aplicada (t165, FR7).
   *
   * Este é o ÚNICO write que esta ficha acrescenta ao cliente, e a razão de ele
   * poder existir é que fechar um resultado é relatar um fato medido, não tomar
   * uma decisão com portão. Continua não existindo `aplicar`, `reverter`,
   * `aprovar` nem `rejeitar` aqui, pela mesma razão que `criarProposta` já
   * documenta: essas quatro são decisão humana (README, princípio 5), moram na
   * tela ou no `curl` do operador, e um cliente que não tem o botão não o aperta
   * por engano.
   *
   * O `depois` é de quem chama: não existe motor de métricas nomeadas na v1
   * (`docs/spec/entidades-versionamento.md` §5). Quem calcula é o topógrafo, com
   * `measureForExpectedMetric` sobre a telemetria da rodada seguinte.
   *
   * @param id Proposta aplicada.
   * @param entrada Execução seguinte e o número medido nela.
   * @returns A proposta com o veredito já gravado.
   * @throws {ErroDoControlPlane} 409 quando o resultado já foi gravado
   *   (`proposta_ja_avaliada`) ou a proposta não está aplicada; 422 quando
   *   nenhum trabalho daquela execução rodou sob a versão aplicada.
   */
  async fecharResultadoDeProposta(
    id: number,
    entrada: { execucao_id: number; depois: number },
  ): Promise<Proposta> {
    const { proposta } = await this.#post<{ proposta: Proposta }>(
      `/v1/proposals/${id}/outcome`,
      entrada,
    );
    return proposta;
  }

  /** Cabeçalhos de uma chamada: o `content-type` do corpo, se houver, e a credencial. */
  #cabecalhos(comCorpo: boolean): Record<string, string> {
    const cabecalhos: Record<string, string> = {};
    if (comCorpo) cabecalhos['content-type'] = 'application/json';
    if (this.#token !== undefined) cabecalhos.authorization = `Bearer ${this.#token}`;
    return cabecalhos;
  }

  async #get<T>(caminho: string): Promise<T> {
    const resposta = await this.#buscar(`${this.urlBase}${caminho}`, {
      headers: this.#cabecalhos(false),
    });
    return await this.#interpretar(caminho, 'GET', resposta);
  }

  async #post<T>(caminho: string, corpo: unknown): Promise<T> {
    const resposta = await this.#buscar(`${this.urlBase}${caminho}`, {
      method: 'POST',
      headers: this.#cabecalhos(true),
      body: JSON.stringify(corpo),
    });
    return await this.#interpretar(caminho, 'POST', resposta);
  }

  async #interpretar<T>(caminho: string, verbo: string, resposta: Response): Promise<T> {
    const texto = await resposta.text();

    // O status vem ANTES de qualquer decodificação: sobre um erro, o corpo é
    // material de log e nunca motivo para uma exceção diferente da desta porta.
    if (!resposta.ok) {
      throw new ErroDoControlPlane(
        `${verbo} ${caminho} respondeu ${resposta.status}`,
        resposta.status,
        corpoDeErro(texto),
      );
    }

    return (texto === '' ? undefined : JSON.parse(texto)) as T;
  }
}
