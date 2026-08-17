/**
 * The surveyor's proposal: evidence built by us, operations chosen by one
 * session, nothing applied (t110, FR5–FR9).
 *
 * This is D16's next milestone — "beating the flowpilot is the next mark (the
 * surveyor's first proposal with evidence)" — assembled out of machinery that
 * already existed and had no caller. `POST /v1/proposals` has always
 * validated the semantic diff, demanded `evidencia` and `metrica_esperada`, and
 * landed the row as `pendente`; what was missing was somebody with something to
 * say.
 *
 * The division of labour is the whole design, and it is deliberate:
 *
 * - **We** compute the numbers ({@link buildEvidence}) and the hypothesis
 *   ({@link buildExpectedMetric}) from the log, deterministically. The
 *   evidence carries the ids of the events it came from, so "evidence traceable
 *   to numbers in the log" is true by construction and not by the agent's
 *   memory.
 * - **The session** does exactly one thing: turn a named bottleneck into
 *   `operacoes`, in the vocabulary of `docs/spec/entidades-versionamento.md`
 *   §3. It writes JSON to a file in its own working directory and is handed no
 *   URL, no token and no write access to anything else. The only `POST` in this
 *   ticket is ours.
 * - **Nobody applies.** There is no apply call here and no client method for
 *   one: a surveyor proposal only ever reaches `pendente`, which is the safety
 *   ladder of README principle 5 in code rather than in prose.
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
  calculateFlowMetrics,
  type NodeMetric,
  type FlowMetrics,
} from './metrics.ts';

/**
 * Where the session writes its answer.
 *
 * A file in the working directory, not stdout: the output of a real CLI is a
 * stream of frames with prose in between (`docs/spec/escalacao-humana.md` §4),
 * and a contract that survives that is one the session can fulfil with a single
 * write. The file NAME stays as it is: it is data the session is told to write,
 * not a code identifier.
 */
export const OUTPUT_FILE = 'proposta-topografo.json';

/** Wall-clock limit of the surveyor's session, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * How much of the bottleneck's dominant number the proposal claims to shave.
 *
 * Declared, not measured: it is the ambition of the hypothesis. The verdict of
 * t112 compares the next run against `de`, never against `para`
 * (`packages/core/src/domain/hypothesis.ts`), so this number decides nothing
 * on its own — it says out loud what "worth it" would look like.
 */
const EXPECTED_REDUCTION = 0.2;

/** The five operation types, as `domain/operations.ts` defines them. */
const OPERATION_TYPES = ['adicionar_no', 'remover_no', 'adicionar_aresta', 'remover_aresta', 'alterar_campo_no'];

/** Which type undoes which. `alterar_campo_no` is its own inverse. */
const EXPECTED_INVERSE: Record<string, string> = {
  adicionar_no: 'remover_no',
  remover_no: 'adicionar_no',
  adicionar_aresta: 'remover_aresta',
  remover_aresta: 'adicionar_aresta',
  alterar_campo_no: 'alterar_campo_no',
};

/** Node fields `alterar_campo_no` may swap. */
const MUTABLE_FIELDS = ['role', 'description', 'skill_ref', 'contract'];

/** The evidence a flow proposal carries into the book. */
export interface FlowEvidence {
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
  por_no: NodeMetric[];
}

/** The hypothesis, in the shape t112's verdict can read. */
export interface ExpectedMetric {
  nome: string;
  direcao: 'cai' | 'sobe';
  de: number;
  para: number;
}

/**
 * What one surveyor run did.
 *
 * The field names are the book's, not this module's: they are the same keys
 * `POST /v1/proposals` reads and the same ones the ranking publishes, so they
 * stay in Portuguese along with everything else on that surface.
 */
export interface SurveyorResult {
  metricas: FlowMetrics;
  /** `null` when the run had no time signal at all. */
  gargalo: NodeMetric | null;
  evidencia: FlowEvidence | null;
  metrica_esperada: ExpectedMetric | null;
  /** The proposal, always `pendente`; `null` when there was nothing to propose. */
  proposta: Proposta | null;
}

/** Configuration of one surveyor run. */
export interface SurveyorOptions {
  /** The runner's one HTTP door to the control plane. */
  client: ClienteControle;
  /** The engine. Production passes `ClaudeCodeAdapter`; tests pass the fake. */
  adapter: EngineAdapter;
  /** The execution to read. */
  executionId: number;
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
  log?: (message: string) => void;
}

/** A run that could not produce a proposal. Never a partial one. */
export class SurveyorError extends Error {
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'SurveyorError';
    this.code = code;
    this.details = details;
  }
}

type PlainObject = Record<string, unknown>;

function isObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFilledText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Client-side mirror of the server's `validateOperation`
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
 * @param operation One operation, straight out of the session's JSON.
 * @returns Every problem found; empty means well formed.
 */
export function validateOperation(operation: unknown): string[] {
  if (!isObject(operation)) return ['an operation has to be a JSON object'];

  const type = operation.tipo;
  if (typeof type !== 'string' || !OPERATION_TYPES.includes(type)) {
    return [
      `unknown operation type: ${JSON.stringify(type)} (known: ${OPERATION_TYPES.join(', ')})`,
    ];
  }

  const problems = checkBody(type, operation, 'operation');

  const inverse = operation.inversa;
  if (!isObject(inverse)) {
    problems.push(`operation "${type}" has to declare its own "inversa" (D15)`);
    return problems;
  }
  if (inverse.tipo !== EXPECTED_INVERSE[type]) {
    problems.push(
      `the inverse of "${type}" has to be of type "${EXPECTED_INVERSE[type]}", got ${JSON.stringify(inverse.tipo)}`,
    );
    return problems;
  }

  problems.push(...checkBody(EXPECTED_INVERSE[type], inverse, 'inverse'));
  problems.push(...checkInverseTarget(type, operation, inverse));
  return problems;
}

/** Keys and types each operation type demands of itself. */
function checkBody(type: string, body: PlainObject, role: string): string[] {
  const problems: string[] = [];
  const edge = body.aresta;

  switch (type) {
    case 'adicionar_no':
      if (!isObject(body.no) || !isFilledText(body.no.id)) {
        problems.push(`${role} "${type}": "no" has to be an object with an "id"`);
      }
      break;
    case 'remover_no':
      if (!isFilledText(body.no_id)) {
        problems.push(`${role} "${type}": "no_id" has to be a filled node id`);
      }
      break;
    case 'adicionar_aresta':
    case 'remover_aresta':
      if (!isObject(edge) || !isFilledText(edge.from) || !isFilledText(edge.to)) {
        problems.push(`${role} "${type}": "aresta" has to have "from" and "to"`);
        break;
      }
      // `condition` is only demanded of the edge that ENTERS the document, and
      // as a string (even an empty one): a missing label is the soundness
      // gate's rejection, with the name of the rule, not a generic 400.
      if (type === 'adicionar_aresta' && typeof edge.condition !== 'string') {
        problems.push(`${role} "${type}": "aresta.condition" has to be a string`);
      }
      break;
    case 'alterar_campo_no':
      if (!isFilledText(body.no_id)) {
        problems.push(`${role} "${type}": "no_id" has to be a filled node id`);
      }
      if (typeof body.campo !== 'string' || !MUTABLE_FIELDS.includes(body.campo)) {
        problems.push(
          `${role} "alterar_campo_no": "campo" has to be one of ${MUTABLE_FIELDS.join(', ')}`,
        );
      }
      for (const key of ['de', 'para']) {
        if (!Object.hasOwn(body, key)) {
          problems.push(`${role} "alterar_campo_no": "${key}" is missing`);
        }
      }
      break;
    default:
      break;
  }

  return problems;
}

/** The inverse has to undo THE SAME target — another node's inverse is not one. */
function checkInverseTarget(type: string, operation: PlainObject, inverse: PlainObject): string[] {
  const ends = (value: unknown): string =>
    isObject(value) ? `${String(value.from)}→${String(value.to)}` : 'invalid';

  switch (type) {
    case 'adicionar_no': {
      const id = isObject(operation.no) ? operation.no.id : undefined;
      return inverse.no_id === id ? [] : [`the inverse has to remove node "${String(id)}"`];
    }
    case 'remover_no': {
      const id = isObject(inverse.no) ? inverse.no.id : undefined;
      return id === operation.no_id
        ? []
        : [`the inverse has to add node "${String(operation.no_id)}" back`];
    }
    case 'adicionar_aresta':
    case 'remover_aresta':
      return ends(operation.aresta) === ends(inverse.aresta)
        ? []
        : [`the inverse has to point at the same edge (${ends(operation.aresta)})`];
    case 'alterar_campo_no':
      return inverse.no_id === operation.no_id && inverse.campo === operation.campo
        ? []
        : [
            `the inverse has to change the same field of the same node ("${String(operation.no_id)}"."${String(operation.campo)}")`,
          ];
    default:
      return [];
  }
}

/**
 * Assembles the evidence of a bottleneck — the four numbers and the ids.
 *
 * @param bottleneck The worst node of the run.
 * @param metrics The whole ranking, carried along as context.
 * @param executionId The execution read.
 * @param versionId The graph version it ran under.
 * @returns The `evidencia` payload, ready for the book.
 */
export function buildEvidence(
  bottleneck: NodeMetric,
  metrics: FlowMetrics,
  executionId: number,
  versionId: string,
): FlowEvidence {
  return {
    fonte: 'topografo/fluxo',
    execucao_id: executionId,
    grafo_versao_id: versionId,
    no_id: bottleneck.no_id,
    tempo_agente_ms: bottleneck.tempo_agente_ms,
    tempo_espera_ms: bottleneck.tempo_espera_ms,
    tempo_fila_ms: bottleneck.tempo_fila_ms,
    total_ms: bottleneck.total_ms,
    perguntas: bottleneck.perguntas,
    eventos: [...bottleneck.eventos],
    por_no: metrics.por_no,
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
 * @param bottleneck The worst node of the run.
 * @returns The declared hypothesis.
 */
export function buildExpectedMetric(bottleneck: NodeMetric): ExpectedMetric {
  const components = [
    { name: 'tempo_espera_ms', value: bottleneck.tempo_espera_ms },
    { name: 'tempo_fila_ms', value: bottleneck.tempo_fila_ms },
    { name: 'tempo_agente_ms', value: bottleneck.tempo_agente_ms },
  ];
  const dominant = components.reduce((biggest, current) =>
    current.value > biggest.value ? current : biggest,
  );

  return {
    nome: `${dominant.name}:${bottleneck.no_id}`,
    direcao: 'cai',
    de: dominant.value,
    para: Math.round(dominant.value * (1 - EXPECTED_REDUCTION)),
  };
}

/**
 * The output contract of the session, as its system prompt.
 *
 * It says what to write and where, and it says what NOT to do: the session has
 * no access to the control plane and no business editing the repository. The
 * five operation types are listed literally because the vocabulary is closed
 * (`docs/spec/entidades-versionamento.md` §3) and this ticket adds none.
 *
 * The CONTENT stays in Portuguese: it stands in for the skill manifest the
 * graph will inject (t101/t105), and those are written in Portuguese.
 */
export const INSTRUCTIONS = [
  'Você é o topógrafo de fluxo do cartografo, analisando UMA execução já terminada.',
  '',
  'Você recebe: o grafo que rodou (nós e arestas) e a medição do nó mais caro da',
  'execução, já calculada — os números não são seus para recalcular.',
  '',
  'Sua única tarefa: propor um diff SEMÂNTICO no grafo que ataque aquele gargalo.',
  '',
  `Escreva o resultado no arquivo \`${OUTPUT_FILE}\`, no diretório atual, com`,
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
  '- `adicionar_aresta` {"tipo","aresta":{"from","to","condition"}, "inversa":{"tipo":"remover_aresta","aresta":{"from","to"}}}',
  '- `remover_aresta`  {"tipo","aresta":{"from","to"}, "inversa":{"tipo":"adicionar_aresta","aresta":{"from","to","condition"}}}',
  '- `alterar_campo_no` {"tipo","no_id","campo","de","para", "inversa": a mesma com de/para trocados}',
  '',
  '`campo` só pode ser role, description, skill_ref ou contract. Trocar `id` ou',
  '`node_type` não é troca de campo, e não existe operação para isso aqui.',
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

/**
 * The prompt: the graph that ran, and the measurement of its worst node.
 *
 * Portuguese for the same reason {@link INSTRUCTIONS} is: it is content handed
 * to a session, not code.
 */
export function buildPrompt(version: VersaoDeGrafo, evidence: FlowEvidence): string {
  const nodes = version.snapshot.nodes ?? [];
  const edges = version.snapshot.edges ?? [];

  const parts = [
    `# Grafo \`${version.graph_id}\`, versão \`${version.id}\``,
    '',
    '## Nós',
    '',
    ...nodes.map((node) => {
      const role = typeof node.role === 'string' ? node.role : '—';
      const nodeType = typeof node.node_type === 'string' ? node.node_type : '—';
      const description = typeof node.description === 'string' ? node.description : '';
      return `- \`${node.id}\` (${nodeType}, role: ${role}) — ${description}`;
    }),
    '',
    '## Arestas',
    '',
    ...edges.map(
      (edge) =>
        `- \`${edge.from}\` → \`${edge.to}\` quando: ${edge.condition ?? '(sem condição)'}`,
    ),
    '',
    `## Medição da execução ${evidence.execucao_id}`,
    '',
    `Gargalo: **\`${evidence.no_id}\`**.`,
    '',
    '| nó | agente (ms) | espera (ms) | fila (ms) | total (ms) | perguntas |',
    '|---|---|---|---|---|---|',
    ...evidence.por_no.map(
      (row) =>
        `| \`${row.no_id}\` | ${row.tempo_agente_ms} | ${row.tempo_espera_ms} | ${row.tempo_fila_ms} | ${row.total_ms} | ${row.perguntas} |`,
    ),
    '',
    'Leitura das colunas: **agente** é tempo de sessão aberta no nó; **espera** é',
    'tempo com o trabalho bloqueado naquele nó (tipicamente aguardando gente);',
    '**fila** é o tempo entre o trabalho chegar ao nó e a sessão dele abrir.',
    '',
    `Proponha o diff que ataca o gargalo e escreva-o em \`${OUTPUT_FILE}\`.`,
  ];

  return parts.join('\n');
}

/** What the session reported when it ended. */
interface Outcome {
  status: SessionStatus;
  exitCode: number | null;
}

/**
 * Runs the one agentic step and returns the operations it chose.
 *
 * Everything that can go wrong here ends in `SurveyorError` and no `POST`: a
 * session that dies, one that writes nothing, one that writes something that is
 * not a well-formed semantic diff.
 */
async function chooseOperations(
  options: SurveyorOptions,
  version: VersaoDeGrafo,
  evidence: FlowEvidence,
  log: (message: string) => void,
): Promise<unknown[]> {
  const spec: SessionSpec = {
    workingDir: options.workingDir,
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(version, evidence),
    timeoutSeconds: options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    ...(options.envOverrides === undefined ? {} : { envOverrides: options.envOverrides }),
  };

  const lines: string[] = [];
  let announceEnd: (outcome: Outcome) => void = () => undefined;
  const end = new Promise<Outcome>((resolve) => {
    announceEnd = resolve;
  });

  await options.adapter.startSession(spec, {
    onOutput(line) {
      lines.push(line);
    },
    onFinished(status, exitCode) {
      announceEnd({ status, exitCode });
    },
  });

  const outcome = await end;
  log(`session ended as "${outcome.status}" (exit ${String(outcome.exitCode)})`);

  if (outcome.status !== 'completed') {
    throw new SurveyorError(
      'session_failed',
      `the surveyor's session ended as "${outcome.status}" (exit ${String(outcome.exitCode)}); no proposal was written`,
      lines.slice(-10),
    );
  }

  const outputPath = path.join(options.workingDir, OUTPUT_FILE);
  let raw: string;
  try {
    raw = readFileSync(outputPath, 'utf8');
  } catch {
    throw new SurveyorError(
      'missing_output',
      `the session ended without writing ${OUTPUT_FILE} in ${options.workingDir}: with no "operacoes", there is no proposal`,
      lines.slice(-10),
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new SurveyorError(
      'invalid_output',
      `${OUTPUT_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const operations = isObject(document) ? document.operacoes : undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new SurveyorError(
      'missing_operations',
      `${OUTPUT_FILE} has to carry "operacoes" as a non-empty list — a proposal that changes nothing is not a proposal`,
    );
  }

  // Same structural rules the server enforces, applied before spending a write
  // to discover them (FR7).
  const problems = operations.flatMap((operation, index) =>
    validateOperation(operation).map((problem) => `operation #${index}: ${problem}`),
  );
  if (problems.length > 0) {
    throw new SurveyorError(
      'invalid_operations',
      `the session returned ${problems.length} shape problem(s) in "operacoes"; nothing was written`,
      problems,
    );
  }

  return operations;
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
async function resolveVersion(options: SurveyorOptions): Promise<string> {
  const rows = await options.client.metricasPorVersao(options.executionId);
  const declared = rows.filter(
    (row): row is { graph_version_id: string; jobs: number; events: number } =>
      row.graph_version_id !== null,
  );

  if (declared.length === 0) {
    throw new SurveyorError(
      'execution_without_version',
      `execution ${options.executionId} has no work declaring a graph_version_id: there is no graph to propose a change to`,
    );
  }

  return declared.reduce((biggest, current) =>
    current.jobs > biggest.jobs ? current : biggest,
  ).graph_version_id;
}

/**
 * Reads one execution and, if it had a bottleneck, lands exactly one pending
 * proposal about it.
 *
 * @param options Control plane, engine, execution and scratch directory.
 * @returns The metrics, the bottleneck and the proposal — the last two `null`
 *   when the run had no time signal at all.
 * @throws {SurveyorError} When the execution declares no version, or the
 *   session failed to produce a well-formed diff. Nothing is posted in either
 *   case.
 * @throws {ErroDoControlPlane} When the API refuses a call.
 */
export async function proposeFlowImprovement(
  options: SurveyorOptions,
): Promise<SurveyorResult> {
  const log = options.log ?? ((): void => undefined);

  const versionId = await resolveVersion(options);
  const version = await options.client.buscarVersaoDeGrafo(versionId);
  const events = await options.client.listarEventosDaExecucao(options.executionId);
  log(`execution ${options.executionId}: ${events.length} events under version ${versionId}`);

  const nodeIds = (version.snapshot.nodes ?? []).map((node) => node.id);
  const metrics = calculateFlowMetrics(events, nodeIds);

  const bottleneck = metrics.gargalo;
  if (bottleneck === null) {
    // No session, no proposal, no error: with nothing to explain, nobody gets
    // paid to explain it.
    log('no node cost any time in this execution; nothing to propose');
    return { metricas: metrics, gargalo: null, evidencia: null, metrica_esperada: null, proposta: null };
  }

  const evidence = buildEvidence(bottleneck, metrics, options.executionId, versionId);
  const expectedMetric = buildExpectedMetric(bottleneck);
  log(
    `bottleneck: ${bottleneck.no_id} (${bottleneck.total_ms}ms, ${bottleneck.perguntas} question(s)), over events ${bottleneck.eventos.join(', ')}`,
  );

  const operations = await chooseOperations(options, version, evidence, log);

  // Only the OUTER keys of the input change language (t226): what `evidence` and
  // `expected_metric` carry is the frozen hypothesis shape (FR5), and what is
  // inside `operations` belongs to D20's third child.
  const proposal = await options.client.criarProposta({
    graph_id: version.graph_id,
    target_version: version.id,
    operations,
    evidence,
    expected_metric: expectedMetric,
  });
  log(`proposal ${proposal.id} written as "${proposal.status}"`);

  return {
    metricas: metrics,
    gargalo: bottleneck,
    evidencia: evidence,
    metrica_esperada: expectedMetric,
    proposta: proposal,
  };
}
