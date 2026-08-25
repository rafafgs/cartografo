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
 * `GET /v1/jobs` é entrega do t102, hoje já mergeada, e devolve `{jobs: [...]}`
 * desde a t226. O cliente consome apenas o subconjunto do contrato de que
 * precisa para escolher um candidato — `id` e `blocked` — e declara os demais
 * campos só para documentar o que chega; os testes seguem simulando a rota,
 * porque o que esta ficha prova é o comportamento do cliente, não o do server
 * do t102.
 *
 * Os NOMES DE CAMPO desta arquivo são o fio, e viraram inglês com a t226
 * (`docs/spec/glossario-wire.md` §1). Os nomes de método e de classe continuam
 * em português: é dívida de identificador de uma outra ficha, como o comentário
 * de {@link ReportedModel} já dizia, e a D18 vale para código escrito daqui em
 * diante.
 *
 * O que este cliente ESCREVE em `packages/runner/src/dispatch/report.ts` não
 * passa por aqui e segue em português inteiro: aquele é o cliente da superfície
 * de EVENTOS, que é o segundo filho da D20.
 */

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  decodeErrorBody,
  requestJsonWithStatus,
  type JsonAnswer,
} from './http-client.ts';

/**
 * Um trabalho, como `GET /v1/jobs` (t102) o devolve.
 *
 * Subconjunto da projeção de `packages/core/src/repositories/job.ts`: os
 * opcionais são anuláveis lá, e são anuláveis aqui pela mesma razão (execução e
 * versão de grafo são soltas, D15).
 */
export interface Trabalho {
  id: number;
  title: string;
  current_node_id: string;
  blocked: boolean;
  /**
   * "O viajante chegou": o `current_node_id` é um dos `final_nodes` da versão
   * do trabalho (t152).
   *
   * Derivado na leitura pelo control plane, nunca gravado: um trabalho sem
   * grafo, ou cuja versão não resolve, não tem estado terminal a que chegar e
   * responde `false`. Aqui ele existe por um motivo só — é o que tira um
   * trabalho que terminou da fila de despacho (ver
   * {@link ClienteControle.listarTrabalhosLiberados}).
   */
  completed: boolean;
  execution_id: number | null;
  graph_version_id: string | null;
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
  type: string;
  project_id: number;
  execution_id: number | null;
  entity: { type: string; id: number | string };
  actor: { type: string; ref: string };
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Uma linha de `GET /v1/executions/:id/metrics-by-version` (t102, FR17). */
export interface MetricaPorVersao {
  graph_version_id: string | null;
  jobs: number;
  events: number;
}

/**
 * O documento de grafo dentro de uma versão.
 *
 * Só `nodes` e `edges` são nomeados: é o que o topógrafo lê para montar o
 * prompt. O resto do documento chega inteiro e passa direto — o formato é do
 * `schema/graph.schema.json`, não deste cliente.
 */
export interface SnapshotDeGrafo {
  nodes?: Array<{ id: string; [chave: string]: unknown }>;
  edges?: Array<{ from: string; to: string; condition?: string; [chave: string]: unknown }>;
  [chave: string]: unknown;
}

/** Uma versão de grafo, como `GET /v1/graph-versions/:id` a devolve (t101). */
export interface VersaoDeGrafo {
  id: string;
  graph_id: string;
  parent_version: string | null;
  source: string;
  proposal_id: number | null;
  snapshot: SnapshotDeGrafo;
  created_at: string;
}

/** O que `POST /v1/proposals` exige: um diff semântico com hipótese (D15). */
export interface EntradaDeProposta {
  graph_id: string;
  target_version: string;
  /** O vocabulário DENTRO da operação é o terceiro filho da D20, e não move. */
  operations: readonly unknown[];
  evidence: unknown;
  expected_metric: unknown;
}

/**
 * Uma proposta, no recorte que o runner precisa da resposta.
 *
 * `expected_metric` e `result` chegam como `unknown` de propósito: a forma das
 * duas é do control plane (`hypothesis.ts`) e a D20 não a descongela — as CHAVES
 * viraram inglês na t226, o conteúdo delas não moveu um byte. O runner só as
 * repassa ou lê o `nome` de dentro.
 */
export interface Proposta {
  id: number;
  graph_id: string;
  target_version: string;
  status: string;
  applied_version_id: string | null;
  expected_metric?: unknown;
  result?: unknown;
}

/**
 * O que `POST /v1/intake` exige (t122): a classe, o pedido e a quebra em itens.
 *
 * `itens` é `unknown[]` de propósito, como `operacoes` em
 * {@link EntradaDeProposta}. A forma de um item é do control plane
 * (`domain/intake.ts`, `validateItems`), que devolve o relatório inteiro de
 * problemas num 400 — e um rascunho ruim é barato e reversível, então espelhar
 * aquele julgamento aqui seria uma segunda cópia que pode divergir.
 *
 * `projeto_id` e `execucao_id` não aparecem: a rota tem default para os dois, e
 * o campo entra no dia em que alguém precisar dele.
 */
export interface EntradaDeIntake {
  /** Classe cujo grafo registrado o lote vai atravessar. */
  class: string;
  /** O pedido em linguagem natural, como chegou. */
  request: string;
  /** A quebra proposta, exatamente como quem a escreveu a declarou. */
  items: readonly unknown[];
}

/**
 * Um rascunho de intake, como a API o devolve (t122).
 *
 * Projeção completa de `intake_rascunho`, porque é ela que chega no `201`.
 * `itens` chega como objeto aberto pela mesma razão de {@link EntradaDeIntake}:
 * o contrato do item é do outro lado da fronteira.
 */
export interface Rascunho {
  id: number;
  project_id: number;
  execution_id: number | null;
  class: string;
  request: string;
  items: Array<Record<string, unknown>>;
  /** `pending` ao nascer; `confirmed`/`discarded` só por decisão humana. */
  status: string;
  /** `ref` → id real do trabalho; `null` enquanto ninguém confirmou. */
  created_jobs: Record<string, number> | null;
  created_at: string;
  updated_at: string;
}

/** Um runner pareado. */
export interface Runner {
  id: string;
  name: string | null;
  registered_at: string;
}

/**
 * Um modelo, no corpo que `POST /v1/engines/:name/models` recebe (t166).
 *
 * As chaves são as da API, como o resto deste cliente: o vocabulário do
 * `EngineAdapter` (`id`, `label`, `origin`) morre no runner, e o que atravessa a
 * fronteira é o formato de dado da API. Os dois VALORES de `source` seguem em
 * inglês, porque são vocabulário do adapter — quem os produziu foi ele.
 *
 * Nome de método e de tipo em inglês, contra o resto deste arquivo: a D18 vale
 * para código escrito daqui em diante, e o português que sobrou aqui é dívida
 * de uma ficha de renomeação, não convenção a imitar.
 */
export interface ReportedModel {
  model_id: string;
  label?: string | null;
  source: 'cli' | 'catalog';
}

/** O catálogo de um motor, como o control plane o devolve. */
export interface EngineCatalog {
  engine: string;
  models: Array<ReportedModel & { updated_at: string }>;
}

/** Estados possíveis de uma lease, no vocabulário do control plane. */
export type StatusDeLease = 'active' | 'released' | 'expired';

/** Por que uma lease morreu. */
export type MotivoDeExpiracao = 'heartbeat_lost' | 'ttl_elapsed';

/** Por que um pedido não virou lease. Nenhum deles é erro. */
export type MotivoDeRecusa = 'job_already_leased' | 'runner_cap' | 'project_cap';

/** Uma lease, como o control plane a devolve. */
export interface Lease {
  id: number;
  runner_id: string;
  job_id: number;
  project_id: number;
  status: StatusDeLease;
  ttl_seconds: number;
  granted_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  expiration_reason: MotivoDeExpiracao | null;
}

/** O que o runner declara ao disputar um trabalho. */
export interface PedidoDeLease {
  runner_id: string;
  project_id: number;
  job_id: number;
  runner_cap: number;
  project_cap: number;
  ttl_seconds: number;
}

/** Resposta de `POST /v1/leases`: ou saiu lease, ou saiu o motivo. */
export interface RespostaDeConcessao {
  lease: Lease | null;
  reason?: MotivoDeRecusa;
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
  /**
   * Prazo de cada chamada, em milissegundos (t193, FR2).
   *
   * Default: {@link DEFAULT_REQUEST_TIMEOUT_MS}. O que ele existe para pegar
   * não é control plane fora do ar — esse responde, e cada método aqui já sabe
   * o que fazer com a resposta —, e sim um que aceita a conexão e não escreve
   * nada: sem prazo, a chamada espera para sempre, e com ela o tick que a fez,
   * o loop que espera o tick e o desligamento que espera o loop.
   */
  requestTimeoutMs?: number;
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
  readonly #token: string | undefined;
  readonly #requestTimeoutMs: number;

  constructor(opcoes: OpcoesDoCliente) {
    this.urlBase = opcoes.urlBase.replace(/\/+$/, '');
    this.#buscar = opcoes.buscar ?? fetch;
    this.#token = opcoes.token;
    this.#requestTimeoutMs = opcoes.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * Pareia o runner. Idempotente no server: chamar de novo não é erro (D5).
   *
   * @param id Identidade declarada pelo runner.
   * @param nome Nome legível, opcional.
   * @returns O runner como ficou registrado.
   */
  async registrarRunner(id: string, nome?: string): Promise<Runner> {
    const corpo = nome === undefined ? { id } : { id, name: nome };
    const { runner } = await this.#post<{ runner: Runner }>('/v1/runners', corpo);
    return runner;
  }

  /**
   * Relata quais modelos o motor deste runner oferece (t166, FR11).
   *
   * Substitui o catálogo guardado para aquele motor, e é essa a semântica que o
   * chamador precisa saber: relatar de novo não soma, sobrescreve. "Atualizar"
   * é reiniciar o processo — não há timer, não há TTL, e é a mesma postura que
   * `registrarRunner` já tem para o pareamento.
   *
   * @param motor Nome que o adapter dá a si mesmo.
   * @param modelos O catálogo, já traduzido do vocabulário do adapter.
   * @returns O catálogo como ficou gravado.
   * @throws {ErroDoControlPlane} Quando o control plane recusa a forma (400) ou
   *   a credencial (401/403). Quem chama decide se isso para a subida — e no
   *   `run.ts` não para.
   */
  async reportEngineModels(
    motor: string,
    modelos: readonly ReportedModel[],
  ): Promise<EngineCatalog> {
    return await this.#post<EngineCatalog>(
      `/v1/engines/${encodeURIComponent(motor)}/models`,
      { models: modelos },
    );
  }

  /**
   * Trabalhos que estão prontos para serem despachados.
   *
   * Os dois filtros moram aqui, do lado do cliente, para consumir o contrato do
   * t102 sem depender de parâmetro de consulta que aquela ficha não prometeu.
   *
   * `bloqueado` tira quem está esperando uma pessoa; `concluido` tira quem
   * chegou (t161). O segundo é a diferença entre uma travessia que termina e um
   * laço: sem ele, um trabalho que pousa num nó final continua liberado para
   * sempre, e o controller o redespacha para o mesmo nó a cada tick. O campo sai
   * de `GET /v1/jobs` desde a t152 — o que faltava era alguém lê-lo.
   *
   * @returns Só os trabalhos que ainda podem andar, na ordem em que o server
   *   mandou.
   */
  async listarTrabalhosLiberados(): Promise<Trabalho[]> {
    const { jobs } = await this.#get<{ jobs: Trabalho[] }>('/v1/jobs');
    return jobs.filter((trabalho) => trabalho.blocked === false && trabalho.completed === false);
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
   * @param timeoutMs Prazo DESTA chamada, em milissegundos (t193, FR3). Sem
   *   ele, o do cliente. Existe porque a batida é a única chamada deste cliente
   *   que tem um prazo natural mais curto que o geral: quem a arma sabe de
   *   quanto em quanto tempo a próxima vence, e uma batida que ainda estivesse
   *   no ar quando a seguinte vencesse é uma que já não serve para nada.
   * @returns A lease renovada.
   */
  async heartbeat(leaseId: number, ttlSegundos?: number, timeoutMs?: number): Promise<Lease> {
    const corpo = ttlSegundos === undefined ? {} : { ttl_seconds: ttlSegundos };
    const { lease } = await this.#post<{ lease: Lease }>(
      `/v1/leases/${leaseId}/heartbeats`,
      corpo,
      timeoutMs,
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
    const { events } = await this.#get<{ events: Evento[] }>(
      `/v1/executions/${execucaoId}/events`,
    );
    return events;
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
    const { metrics } = await this.#get<{ metrics: MetricaPorVersao[] }>(
      `/v1/executions/${execucaoId}/metrics-by-version`,
    );
    return metrics;
  }

  /**
   * Uma versão de grafo, com o snapshot completo.
   *
   * @param id Id da versão (o hash do snapshot, com `:` — daí o encode).
   * @returns A versão e o documento que ela congela.
   * @throws {ErroDoControlPlane} 404 quando a versão não existe.
   */
  async buscarVersaoDeGrafo(id: string): Promise<VersaoDeGrafo> {
    const { graph_version: versao } = await this.#get<{ graph_version: VersaoDeGrafo }>(
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
   * O `created` é da t247, e o que ele resolve é uma ambiguidade que a t246
   * criou: a deduplicação do control plane responde `200` com a proposta
   * pendente que já existia, em vez de `201` com um clone, e essa proposta lê
   * `pending` exatamente como uma recém-criada. Quem chama por engano duas vezes
   * não precisa saber a diferença; quem dispara sozinho, sem ninguém lendo
   * relatório (D21), precisa — é a diferença entre "propus" e "isto já estava
   * proposto".
   *
   * @param entrada Grafo, versão-alvo, operações, evidência e métrica esperada.
   * @returns A proposta gravada, e se esta chamada foi a que a criou (`201`) ou
   *   se ela casou com uma pendente e só reforçou a evidência (`200`, t246).
   * @throws {ErroDoControlPlane} 400 quando o server recusa a forma.
   */
  async criarProposta(entrada: EntradaDeProposta): Promise<{
    proposal: Proposta;
    created: boolean;
  }> {
    const { body, status } = await this.#postComStatus<{ proposal: Proposta }>(
      '/v1/proposals',
      entrada,
    );
    return { proposal: body.proposal, created: status === 201 };
  }

  /**
   * Uma proposta, pelo id (t165, FR9).
   *
   * Quem vai fechar o experimento precisa da `expected_metric` que a hipótese
   * declarou — é o `nome` dela que diz QUAL número medir na rodada seguinte.
   *
   * @param id Id da proposta.
   * @returns A proposta, no recorte que o runner consome.
   * @throws {ErroDoControlPlane} 404 quando a proposta não existe.
   */
  async buscarProposta(id: number): Promise<Proposta> {
    const { proposal } = await this.#get<{ proposal: Proposta }>(`/v1/proposals/${id}`);
    return proposal;
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
   * (`docs/spec/entities-versioning.md` §5). Quem calcula é o topógrafo, com
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
    const { proposal } = await this.#post<{ proposal: Proposta }>(
      `/v1/proposals/${id}/outcome`,
      entrada,
    );
    return proposal;
  }

  /* ------------------------------------------------------------------------ */
  /* t144 — a única escrita que a geração de intake acrescenta.                */
  /* ------------------------------------------------------------------------ */

  /**
   * Propõe um rascunho de intake — que nasce, sempre, `pendente`.
   *
   * Não existe par `confirmar`, `emendar` nem `descartar` neste cliente, e a
   * razão é a mesma que {@link ClienteControle.criarProposta} já documenta:
   * confirmar é o portão humano da camada de intake (`docs/spec/intake.md` §1),
   * e um cliente que não tem o método não toma a decisão por engano. O que este
   * método grava é uma proposta de quebra que qualquer pessoa ainda pode editar
   * por `PATCH`, descartar, ou simplesmente ignorar: nada nele cria trabalho e
   * nada nele emite evento.
   *
   * @param entrada Classe, pedido e a quebra em itens.
   * @returns O rascunho gravado.
   * @throws {ErroDoControlPlane} 404 quando a classe não tem grafo base; 400
   *   quando `itens` não passa na validação do server (`itens_invalidos`).
   */
  async criarIntake(entrada: EntradaDeIntake): Promise<Rascunho> {
    const { draft } = await this.#post<{ draft: Rascunho }>('/v1/intake', entrada);
    return draft;
  }

  /** Cabeçalhos de uma chamada: o `content-type` do corpo, se houver, e a credencial. */
  #cabecalhos(comCorpo: boolean): Record<string, string> {
    const cabecalhos: Record<string, string> = {};
    if (comCorpo) cabecalhos['content-type'] = 'application/json';
    if (this.#token !== undefined) cabecalhos.authorization = `Bearer ${this.#token}`;
    return cabecalhos;
  }

  async #get<T>(caminho: string, timeoutMs?: number): Promise<T> {
    return (await this.#chamar<T>('GET', caminho, undefined, timeoutMs)).body;
  }

  async #post<T>(caminho: string, corpo: unknown, timeoutMs?: number): Promise<T> {
    return (await this.#chamar<T>('POST', caminho, corpo, timeoutMs)).body;
  }

  /**
   * O mesmo `POST`, com o status ainda anexado (t247).
   *
   * Existe para uma rota só — `POST /v1/proposals` —, onde o status É resposta:
   * desde a t246 o control plane responde `201` quando criou e `200` quando
   * casou com uma proposta pendente e reforçou a evidência dela. Os demais
   * `#post` continuam lendo só o corpo, porque para eles um 2xx é um 2xx.
   */
  async #postComStatus<T>(
    caminho: string,
    corpo: unknown,
    timeoutMs?: number,
  ): Promise<JsonAnswer<T>> {
    return await this.#chamar<T>('POST', caminho, corpo, timeoutMs);
  }

  /**
   * A única porta de saída desta classe (t193, FR2).
   *
   * A mecânica — prazo, status antes do corpo, decodificação — mora em
   * `http-client.ts`, e o que sobra aqui é o que é DESTE cliente: a URL base, os
   * cabeçalhos e o {@link ErroDoControlPlane} que ele promete. O `corpoDeErro`
   * que vivia neste arquivo desde a t156 virou `decodeErrorBody` lá, com a mesma
   * regra e um dono só.
   *
   * @param verbo Verbo HTTP.
   * @param caminho Caminho a partir da URL base.
   * @param corpo Corpo a enviar, quando há um.
   * @param timeoutMs Prazo desta chamada. Sem ele, o do cliente.
   * @returns O corpo decodificado da resposta, e o status com que ela veio.
   */
  async #chamar<T>(
    verbo: string,
    caminho: string,
    corpo: unknown,
    timeoutMs?: number,
  ): Promise<JsonAnswer<T>> {
    return await requestJsonWithStatus<T>({
      url: `${this.urlBase}${caminho}`,
      method: verbo,
      headers: this.#cabecalhos(corpo !== undefined),
      body: corpo,
      timeoutMs: timeoutMs ?? this.#requestTimeoutMs,
      fetchImpl: this.#buscar,
      buildError: ({ status, body }) =>
        new ErroDoControlPlane(
          // A mensagem é o que um operador lê no stderr de `prune`, de `intake`
          // e do topógrafo, e por isso ela é inglesa desde a t254 — como a
          // vizinha "the control plane did not answer for it" já era.
          `${verbo} ${caminho} answered ${status}`,
          status,
          decodeErrorBody(body),
        ),
    });
  }
}
