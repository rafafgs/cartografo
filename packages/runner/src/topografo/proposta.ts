/**
 * The surveyor's proposal: evidence built by us, operations chosen by one
 * session, nothing applied (t110, FR5–FR9).
 *
 * This is D16's next milestone — "superar o flowpilot é o marco seguinte
 * (primeira proposta do topógrafo com evidência)" — assembled out of machinery
 * that already existed and had no caller. `POST /v1/proposals` has always
 * validated the semantic diff, demanded `evidencia` and `metrica_esperada`, and
 * landed the row as `pendente`; what was missing was somebody with something to
 * say.
 *
 * The division of labour is the whole design, and it is deliberate:
 *
 * - **We** compute the numbers ({@link montarEvidencia}) and the hypothesis
 *   ({@link montarMetricaEsperada}) from the log, deterministically. The
 *   evidence carries the ids of the events it came from, so "evidence traceable
 *   to numbers in the log" is true by construction and not by the agent's
 *   memory.
 * - **The session** does exactly one thing: turn a named bottleneck into
 *   `operacoes`, in the vocabulary of `docs/spec/entidades-versionamento.md`
 *   §3. It writes JSON to a file in its own working directory and is handed no
 *   URL, no token and no write access to anything else. The only `POST` in this
 *   ticket is ours.
 * - **Nobody applies.** There is no `aplicar` call here and no client method
 *   for one: a surveyor proposal only ever reaches `pendente`, which is the
 *   safety ladder of README principle 5 in code rather than in prose.
 *
 * A run with no signal (`gargalo === null`) opens no session at all and posts
 * nothing. "Nothing to propose" is a valid, silent outcome.
 *
 * English per D18; payload keys and the domain vocabulary stay in Portuguese,
 * because that is how they are already published in the book.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type {
  ClienteControle,
  Proposta,
  VersaoDeGrafo,
} from '../controller/cliente-controle.ts';
import type { EngineAdapter, SessionSpec, SessionStatus } from '../engine/types.ts';
import {
  calcularMetricasDeFluxo,
  type MetricaDeNo,
  type MetricasDeFluxo,
} from './metricas.ts';

/**
 * Where the session writes its answer.
 *
 * A file in the working directory, not stdout: the output of a real CLI is a
 * stream of frames with prose in between (`docs/spec/escalacao-humana.md` §4),
 * and a contract that survives that is one the session can fulfil with a single
 * write.
 */
export const ARQUIVO_DE_SAIDA = 'proposta-topografo.json';

/** Wall-clock limit of the surveyor's session, in seconds. */
const TIMEOUT_PADRAO_SEGUNDOS = 900;

/**
 * How much of the bottleneck's dominant number the proposal claims to shave.
 *
 * Declared, not measured: it is the ambition of the hypothesis. The verdict of
 * t112 compares the next run against `de`, never against `para`
 * (`packages/core/src/domain/hypothesis.ts`), so this number decides nothing
 * on its own — it says out loud what "worth it" would look like.
 */
const REDUCAO_ESPERADA = 0.2;

/** The five operation types, as `domain/operations.ts` defines them. */
const TIPOS_DE_OPERACAO = ['adicionar_no', 'remover_no', 'adicionar_aresta', 'remover_aresta', 'alterar_campo_no'];

/** Which type undoes which. `alterar_campo_no` is its own inverse. */
const INVERSA_ESPERADA: Record<string, string> = {
  adicionar_no: 'remover_no',
  remover_no: 'adicionar_no',
  adicionar_aresta: 'remover_aresta',
  remover_aresta: 'adicionar_aresta',
  alterar_campo_no: 'alterar_campo_no',
};

/** Node fields `alterar_campo_no` may swap. */
const CAMPOS_ALTERAVEIS = ['papel', 'descricao', 'skill_ref', 'contrato'];

/** The evidence a flow proposal carries into the book. */
export interface EvidenciaDeFluxo {
  /** Which surveyor produced this. The second one (custo) will say otherwise. */
  fonte: string;
  execucao_id: number;
  grafo_versao_id: string;
  /** The bottleneck these numbers are about. */
  no_id: string;
  tempo_agente_ms: number;
  tempo_espera_ms: number;
  tempo_fila_ms: number;
  total_ms: number;
  perguntas: number;
  /** Ids of the events the numbers were computed from — never a summary alone. */
  eventos: number[];
  /** The whole ranking, so "why this node" is answerable without a re-run. */
  por_no: MetricaDeNo[];
}

/** The hypothesis, in the shape t112's verdict can read. */
export interface MetricaEsperada {
  nome: string;
  direcao: 'cai' | 'sobe';
  de: number;
  para: number;
}

/** What one surveyor run did. */
export interface ResultadoDoTopografo {
  metricas: MetricasDeFluxo;
  /** `null` when the run had no time signal at all. */
  gargalo: MetricaDeNo | null;
  evidencia: EvidenciaDeFluxo | null;
  metrica_esperada: MetricaEsperada | null;
  /** The proposal, always `pendente`; `null` when there was nothing to propose. */
  proposta: Proposta | null;
}

/** Configuration of one surveyor run. */
export interface OpcoesDoTopografo {
  /** The runner's one HTTP door to the control plane. */
  cliente: ClienteControle;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass the fake. */
  adapter: EngineAdapter;
  /** The execution to read. */
  execucaoId: number;
  /** Scratch directory the session runs in, and writes its answer to. */
  workingDir: string;
  /** Wall-clock limit of the session. Default: 15 minutes. */
  timeoutSeconds?: number;
  /**
   * Opaque additions to the engine's environment.
   *
   * Never the control plane: the session has no business talking to it, and
   * this ticket's only `POST` is the orchestrator's. In production nothing is
   * passed here; it is the seam the fake engine of the suite is driven by.
   */
  envOverrides?: Readonly<Record<string, string>>;
  /** Where progress goes. Default: nowhere — this is a library, not a CLI. */
  registrar?: (mensagem: string) => void;
}

/** A run that could not produce a proposal. Never a partial one. */
export class ErroDoTopografo extends Error {
  readonly codigo: string;
  readonly detalhes: readonly string[];

  constructor(codigo: string, mensagem: string, detalhes: readonly string[] = []) {
    super(mensagem);
    this.name = 'ErroDoTopografo';
    this.codigo = codigo;
    this.detalhes = detalhes;
  }
}

type Registro = Record<string, unknown>;

function ehObjeto(valor: unknown): valor is Registro {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function ehTextoPreenchido(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Client-side mirror of the server's `validarOperacao`
 * (`packages/core/src/domain/operations.ts`).
 *
 * The server remains the authority — every operation is validated again there,
 * and a disagreement is a `400` we would rather read than route around. The
 * mirror exists for one reason: FR7 requires a bad session to make **zero**
 * `POST /v1/proposals` calls, and "let the server decide" would spend a write
 * to find that out.
 *
 * Structural only, exactly like the original: it checks keys, types and that
 * the inverse undoes the same target. Whether the result is a sound graph is
 * the soundness gate's judgement, at apply time — a different layer.
 *
 * @param operacao One operation, straight out of the session's JSON.
 * @returns Every problem found; empty means well formed.
 */
export function validarOperacao(operacao: unknown): string[] {
  if (!ehObjeto(operacao)) return ['operação precisa ser um objeto JSON'];

  const tipo = operacao.tipo;
  if (typeof tipo !== 'string' || !TIPOS_DE_OPERACAO.includes(tipo)) {
    return [
      `tipo de operação desconhecido: ${JSON.stringify(tipo)} (conhecidos: ${TIPOS_DE_OPERACAO.join(', ')})`,
    ];
  }

  const problemas = conferirCorpo(tipo, operacao, 'operação');

  const inversa = operacao.inversa;
  if (!ehObjeto(inversa)) {
    problemas.push(`operação "${tipo}" precisa declarar a própria inversa (D15)`);
    return problemas;
  }
  if (inversa.tipo !== INVERSA_ESPERADA[tipo]) {
    problemas.push(
      `a inversa de "${tipo}" precisa ser do tipo "${INVERSA_ESPERADA[tipo]}", veio ${JSON.stringify(inversa.tipo)}`,
    );
    return problemas;
  }

  problemas.push(...conferirCorpo(INVERSA_ESPERADA[tipo], inversa, 'inversa'));
  problemas.push(...conferirAlvoDaInversa(tipo, operacao, inversa));
  return problemas;
}

/** Keys and types each operation type demands of itself. */
function conferirCorpo(tipo: string, corpo: Registro, papel: string): string[] {
  const problemas: string[] = [];
  const aresta = corpo.aresta;

  switch (tipo) {
    case 'adicionar_no':
      if (!ehObjeto(corpo.no) || !ehTextoPreenchido(corpo.no.id)) {
        problemas.push(`${papel} "${tipo}": "no" precisa ser um objeto com "id"`);
      }
      break;
    case 'remover_no':
      if (!ehTextoPreenchido(corpo.no_id)) {
        problemas.push(`${papel} "${tipo}": "no_id" precisa ser um id de nó preenchido`);
      }
      break;
    case 'adicionar_aresta':
    case 'remover_aresta':
      if (!ehObjeto(aresta) || !ehTextoPreenchido(aresta.de) || !ehTextoPreenchido(aresta.para)) {
        problemas.push(`${papel} "${tipo}": "aresta" precisa ter "de" e "para"`);
        break;
      }
      // `condicao` só é exigida na aresta que ENTRA no documento, e como string
      // (mesmo vazia): rótulo faltando é reprovação do portão de soundness, com
      // o nome da regra, não um 400 genérico.
      if (tipo === 'adicionar_aresta' && typeof aresta.condicao !== 'string') {
        problemas.push(`${papel} "${tipo}": "aresta.condicao" precisa ser uma string`);
      }
      break;
    case 'alterar_campo_no':
      if (!ehTextoPreenchido(corpo.no_id)) {
        problemas.push(`${papel} "${tipo}": "no_id" precisa ser um id de nó preenchido`);
      }
      if (typeof corpo.campo !== 'string' || !CAMPOS_ALTERAVEIS.includes(corpo.campo)) {
        problemas.push(
          `${papel} "alterar_campo_no": "campo" precisa ser um de ${CAMPOS_ALTERAVEIS.join(', ')}`,
        );
      }
      for (const chave of ['de', 'para']) {
        if (!Object.hasOwn(corpo, chave)) {
          problemas.push(`${papel} "alterar_campo_no": falta "${chave}"`);
        }
      }
      break;
    default:
      break;
  }

  return problemas;
}

/** The inverse has to undo THE SAME target — another node's inverse is not one. */
function conferirAlvoDaInversa(tipo: string, operacao: Registro, inversa: Registro): string[] {
  const pontas = (valor: unknown): string =>
    ehObjeto(valor) ? `${String(valor.de)}→${String(valor.para)}` : 'inválida';

  switch (tipo) {
    case 'adicionar_no': {
      const id = ehObjeto(operacao.no) ? operacao.no.id : undefined;
      return inversa.no_id === id ? [] : [`a inversa precisa remover o nó "${String(id)}"`];
    }
    case 'remover_no': {
      const id = ehObjeto(inversa.no) ? inversa.no.id : undefined;
      return id === operacao.no_id
        ? []
        : [`a inversa precisa readicionar o nó "${String(operacao.no_id)}"`];
    }
    case 'adicionar_aresta':
    case 'remover_aresta':
      return pontas(operacao.aresta) === pontas(inversa.aresta)
        ? []
        : [`a inversa precisa apontar para a mesma aresta (${pontas(operacao.aresta)})`];
    case 'alterar_campo_no':
      return inversa.no_id === operacao.no_id && inversa.campo === operacao.campo
        ? []
        : [
            `a inversa precisa alterar o mesmo campo do mesmo nó ("${String(operacao.no_id)}"."${String(operacao.campo)}")`,
          ];
    default:
      return [];
  }
}

/**
 * Assembles the evidence of a bottleneck — the four numbers and the ids.
 *
 * @param gargalo The worst node of the run.
 * @param metricas The whole ranking, carried along as context.
 * @param execucaoId The execution read.
 * @param versaoId The graph version it ran under.
 * @returns The `evidencia` payload, ready for the book.
 */
export function montarEvidencia(
  gargalo: MetricaDeNo,
  metricas: MetricasDeFluxo,
  execucaoId: number,
  versaoId: string,
): EvidenciaDeFluxo {
  return {
    fonte: 'topografo/fluxo',
    execucao_id: execucaoId,
    grafo_versao_id: versaoId,
    no_id: gargalo.no_id,
    tempo_agente_ms: gargalo.tempo_agente_ms,
    tempo_espera_ms: gargalo.tempo_espera_ms,
    tempo_fila_ms: gargalo.tempo_fila_ms,
    total_ms: gargalo.total_ms,
    perguntas: gargalo.perguntas,
    eventos: [...gargalo.eventos],
    por_no: metricas.por_no,
  };
}

/**
 * Names the number the next run should move, and which way.
 *
 * The dominant component of the bottleneck, not the total: "the node costs
 * 159s" is not actionable, "the node spends two minutes blocked on a human" is.
 * Ties fall to waiting, then queueing, then agent time — the order in which a
 * change to the graph can plausibly help.
 *
 * @param gargalo The worst node of the run.
 * @returns The declared hypothesis.
 */
export function montarMetricaEsperada(gargalo: MetricaDeNo): MetricaEsperada {
  const componentes = [
    { nome: 'tempo_espera_ms', valor: gargalo.tempo_espera_ms },
    { nome: 'tempo_fila_ms', valor: gargalo.tempo_fila_ms },
    { nome: 'tempo_agente_ms', valor: gargalo.tempo_agente_ms },
  ];
  const dominante = componentes.reduce((maior, atual) =>
    atual.valor > maior.valor ? atual : maior,
  );

  return {
    nome: `${dominante.nome}:${gargalo.no_id}`,
    direcao: 'cai',
    de: dominante.valor,
    para: Math.round(dominante.valor * (1 - REDUCAO_ESPERADA)),
  };
}

/**
 * The output contract of the session, as its system prompt.
 *
 * It says what to write and where, and it says what NOT to do: the session has
 * no access to the control plane and no business editing the repository. The
 * five operation types are listed literally because the vocabulary is closed
 * (`docs/spec/entidades-versionamento.md` §3) and this ticket adds none.
 */
export const INSTRUCOES = [
  'Você é o topógrafo de fluxo do cartografo, analisando UMA execução já terminada.',
  '',
  'Você recebe: o grafo que rodou (nós e arestas) e a medição do nó mais caro da',
  'execução, já calculada — os números não são seus para recalcular.',
  '',
  'Sua única tarefa: propor um diff SEMÂNTICO no grafo que ataque aquele gargalo.',
  '',
  `Escreva o resultado no arquivo \`${ARQUIVO_DE_SAIDA}\`, no diretório atual, com`,
  'exatamente esta forma e nada mais:',
  '',
  '```json',
  '{"operacoes": [ ... ]}',
  '```',
  '',
  'Cada operação é de UM destes cinco tipos, e carrega a própria inversa:',
  '',
  '- `adicionar_no`    {"tipo","no",     "inversa": {"tipo":"remover_no","no_id"}}',
  '- `remover_no`      {"tipo","no_id",  "inversa": {"tipo":"adicionar_no","no"}}',
  '- `adicionar_aresta` {"tipo","aresta":{"de","para","condicao"}, "inversa":{"tipo":"remover_aresta","aresta":{"de","para"}}}',
  '- `remover_aresta`  {"tipo","aresta":{"de","para"}, "inversa":{"tipo":"adicionar_aresta","aresta":{"de","para","condicao"}}}',
  '- `alterar_campo_no` {"tipo","no_id","campo","de","para", "inversa": a mesma com de/para trocados}',
  '',
  '`campo` só pode ser papel, descricao, skill_ref ou contrato. Trocar `id` ou',
  '`tipo_no` não é troca de campo, e não existe operação para isso aqui.',
  '',
  'Regras duras:',
  '',
  '- a lista não pode ser vazia — se não houver mudança que ajude, diga isso no',
  '  seu turno e escreva o arquivo assim mesmo, com a melhor proposta que tiver;',
  '- todo nó novo precisa de aresta de entrada E de saída, senão o portão de',
  '  soundness reprova a proposta inteira;',
  '- não edite mais nada no diretório, não rode git e não chame API nenhuma. Sua',
  '  saída é o arquivo, e a proposta é gravada por quem despachou você.',
].join('\n');

/** The prompt: the graph that ran, and the measurement of its worst node. */
export function montarPrompt(versao: VersaoDeGrafo, evidencia: EvidenciaDeFluxo): string {
  const nos = versao.snapshot.nos ?? [];
  const arestas = versao.snapshot.arestas ?? [];

  const partes = [
    `# Grafo \`${versao.grafo_id}\`, versão \`${versao.id}\``,
    '',
    '## Nós',
    '',
    ...nos.map((no) => {
      const papel = typeof no.papel === 'string' ? no.papel : '—';
      const tipoNo = typeof no.tipo_no === 'string' ? no.tipo_no : '—';
      const descricao = typeof no.descricao === 'string' ? no.descricao : '';
      return `- \`${no.id}\` (${tipoNo}, papel: ${papel}) — ${descricao}`;
    }),
    '',
    '## Arestas',
    '',
    ...arestas.map(
      (aresta) =>
        `- \`${aresta.de}\` → \`${aresta.para}\` quando: ${aresta.condicao ?? '(sem condição)'}`,
    ),
    '',
    `## Medição da execução ${evidencia.execucao_id}`,
    '',
    `Gargalo: **\`${evidencia.no_id}\`**.`,
    '',
    '| nó | agente (ms) | espera (ms) | fila (ms) | total (ms) | perguntas |',
    '|---|---|---|---|---|---|',
    ...evidencia.por_no.map(
      (linha) =>
        `| \`${linha.no_id}\` | ${linha.tempo_agente_ms} | ${linha.tempo_espera_ms} | ${linha.tempo_fila_ms} | ${linha.total_ms} | ${linha.perguntas} |`,
    ),
    '',
    'Leitura das colunas: **agente** é tempo de sessão aberta no nó; **espera** é',
    'tempo com o trabalho bloqueado naquele nó (tipicamente aguardando gente);',
    '**fila** é o tempo entre o trabalho chegar ao nó e a sessão dele abrir.',
    '',
    `Proponha o diff que ataca o gargalo e escreva-o em \`${ARQUIVO_DE_SAIDA}\`.`,
  ];

  return partes.join('\n');
}

/** What the session reported when it ended. */
interface Desfecho {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Runs the one agentic step and returns the operations it chose.
 *
 * Everything that can go wrong here ends in `ErroDoTopografo` and no `POST`:
 * a session that dies, one that writes nothing, one that writes something that
 * is not a well-formed semantic diff.
 */
async function escolherOperacoes(
  opcoes: OpcoesDoTopografo,
  versao: VersaoDeGrafo,
  evidencia: EvidenciaDeFluxo,
  registrar: (mensagem: string) => void,
): Promise<unknown[]> {
  const spec: SessionSpec = {
    workingDir: opcoes.workingDir,
    instructions: INSTRUCOES,
    prompt: montarPrompt(versao, evidencia),
    timeoutSeconds: opcoes.timeoutSeconds ?? TIMEOUT_PADRAO_SEGUNDOS,
    ...(opcoes.envOverrides === undefined ? {} : { envOverrides: opcoes.envOverrides }),
  };

  const linhas: string[] = [];
  let avisarFim: (desfecho: Desfecho) => void = () => undefined;
  const fim = new Promise<Desfecho>((resolve) => {
    avisarFim = resolve;
  });

  await opcoes.adapter.startSession(spec, {
    onOutput(linha) {
      linhas.push(linha);
    },
    onFinished(status, exitCode) {
      avisarFim({ status, exitCode });
    },
  });

  const desfecho = await fim;
  registrar(`sessão terminou como "${desfecho.status}" (exit ${String(desfecho.exitCode)})`);

  if (desfecho.status !== 'completed') {
    throw new ErroDoTopografo(
      'sessao_falhou',
      `a sessão do topógrafo terminou como "${desfecho.status}" (exit ${String(desfecho.exitCode)}); nenhuma proposta foi gravada`,
      linhas.slice(-10),
    );
  }

  const caminho = path.join(opcoes.workingDir, ARQUIVO_DE_SAIDA);
  let bruto: string;
  try {
    bruto = readFileSync(caminho, 'utf8');
  } catch {
    throw new ErroDoTopografo(
      'saida_ausente',
      `a sessão terminou sem escrever ${ARQUIVO_DE_SAIDA} em ${opcoes.workingDir}: sem operacoes, não há proposta`,
      linhas.slice(-10),
    );
  }

  let documento: unknown;
  try {
    documento = JSON.parse(bruto);
  } catch (erro) {
    throw new ErroDoTopografo(
      'saida_invalida',
      `${ARQUIVO_DE_SAIDA} não é JSON válido: ${erro instanceof Error ? erro.message : String(erro)}`,
    );
  }

  const operacoes = ehObjeto(documento) ? documento.operacoes : undefined;
  if (!Array.isArray(operacoes) || operacoes.length === 0) {
    throw new ErroDoTopografo(
      'operacoes_ausentes',
      `${ARQUIVO_DE_SAIDA} precisa ter "operacoes" como lista não vazia — uma proposta que não muda nada não é proposta`,
    );
  }

  // Same structural rules the server enforces, applied before spending a write
  // to discover them (FR7).
  const problemas = operacoes.flatMap((operacao, indice) =>
    validarOperacao(operacao).map((problema) => `operação #${indice}: ${problema}`),
  );
  if (problemas.length > 0) {
    throw new ErroDoTopografo(
      'operacoes_invalidas',
      `a sessão devolveu ${problemas.length} problema(s) de forma nas operacoes; nada foi gravado`,
      problemas,
    );
  }

  return operacoes;
}

/**
 * Which graph version this execution ran under.
 *
 * The log does not carry it (`trabalho.criado` has no `grafo_versao_id` in its
 * schema — it is projection, not fact), so the answer comes from the
 * version × telemetry join of t102. The version with the most works wins a run
 * that spans two of them: the proposal has to target one, and the majority is
 * the one the evidence is mostly about.
 */
async function resolverVersao(opcoes: OpcoesDoTopografo): Promise<string> {
  const metricas = await opcoes.cliente.metricasPorVersao(opcoes.execucaoId);
  const declaradas = metricas.filter(
    (linha): linha is { grafo_versao_id: string; trabalhos: number; eventos: number } =>
      linha.grafo_versao_id !== null,
  );

  if (declaradas.length === 0) {
    throw new ErroDoTopografo(
      'execucao_sem_versao',
      `a execução ${opcoes.execucaoId} não tem trabalho nenhum declarando grafo_versao_id: não há grafo a que propor mudança`,
    );
  }

  return declaradas.reduce((maior, atual) => (atual.trabalhos > maior.trabalhos ? atual : maior))
    .grafo_versao_id;
}

/**
 * Reads one execution and, if it had a bottleneck, lands exactly one pending
 * proposal about it.
 *
 * @param opcoes Control plane, engine, execution and scratch directory.
 * @returns The metrics, the bottleneck and the proposal — the last two `null`
 *   when the run had no time signal at all.
 * @throws {ErroDoTopografo} When the execution declares no version, or the
 *   session failed to produce a well-formed diff. Nothing is posted in either
 *   case.
 * @throws {ErroDoControlPlane} When the API refuses a call.
 */
export async function proporMelhoriaDeFluxo(
  opcoes: OpcoesDoTopografo,
): Promise<ResultadoDoTopografo> {
  const registrar = opcoes.registrar ?? ((): void => undefined);

  const versaoId = await resolverVersao(opcoes);
  const versao = await opcoes.cliente.buscarVersaoDeGrafo(versaoId);
  const eventos = await opcoes.cliente.listarEventosDaExecucao(opcoes.execucaoId);
  registrar(`execução ${opcoes.execucaoId}: ${eventos.length} eventos sob a versão ${versaoId}`);

  const nos = (versao.snapshot.nos ?? []).map((no) => no.id);
  const metricas = calcularMetricasDeFluxo(eventos, nos);

  const gargalo = metricas.gargalo;
  if (gargalo === null) {
    // No session, no proposal, no error: with nothing to explain, nobody gets
    // paid to explain it.
    registrar('nenhum nó custou tempo nesta execução; nada a propor');
    return { metricas, gargalo: null, evidencia: null, metrica_esperada: null, proposta: null };
  }

  const evidencia = montarEvidencia(gargalo, metricas, opcoes.execucaoId, versaoId);
  const metrica_esperada = montarMetricaEsperada(gargalo);
  registrar(
    `gargalo: ${gargalo.no_id} (${gargalo.total_ms}ms, ${gargalo.perguntas} pergunta(s)), sobre os eventos ${gargalo.eventos.join(', ')}`,
  );

  const operacoes = await escolherOperacoes(opcoes, versao, evidencia, registrar);

  const proposta = await opcoes.cliente.criarProposta({
    grafo_id: versao.grafo_id,
    versao_alvo: versao.id,
    operacoes,
    evidencia,
    metrica_esperada,
  });
  registrar(`proposta ${proposta.id} gravada como "${proposta.status}"`);

  return { metricas, gargalo, evidencia, metrica_esperada, proposta };
}
