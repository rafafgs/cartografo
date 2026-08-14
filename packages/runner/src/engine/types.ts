/**
 * Interface do EngineAdapter — transcrição literal de
 * `docs/formatos/engine-adapter.md` § "Interface TypeScript".
 *
 * Este arquivo NÃO é lugar de decisão de design. Ele é a especificação
 * compilando: os blocos `typescript` daquela seção, na ordem em que aparecem,
 * com os comentários que os acompanham. A especificação está declaradamente
 * "não congelada" (`engine-adapter.md:1-9`) enquanto a regra dos dois
 * consumidores não for satisfeita, e `test/engine/spec-parity.test.ts` é o
 * portão que impede o código de divergir dela em silêncio.
 *
 * Mudança aqui sem mudança lá (ou o contrário) quebra o teste de paridade —
 * de propósito. O documento manda; este módulo obedece.
 */

/**
 * Ciclo de vida de uma sessão de agente, no vocabulário mínimo que toda CLI
 * headless consegue expressar.
 *
 * `timed_out` existe separado de `failed` porque a resposta operacional é
 * outra: fomos NÓS que matamos a sessão ao expirar o relógio, e a escada de
 * retry pode reagir a isso sem tratar como bug do trabalho. Status
 * específicos de um engine (quota esgotada, resume expirado) NÃO entram no
 * baseline — são extensão de quem os tem, e um consumidor que ramifica neles
 * já quebrou a fronteira 1.
 */
export type SessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Status a partir dos quais nada mais transiciona sem uma nova ação. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Tudo que um engine precisa para rodar uma unidade de trabalho. */
export interface SessionSpec {
  /** Diretório onde a sessão roda (tipicamente um worktree git). */
  readonly workingDir: string;

  /**
   * As instruções do nó, vindas do banco. É o contrato do nó renderizado —
   * "as instruções do nó saem do banco e são injetadas na sessão pelo
   * runner" (`notas/2026-08-14-arquitetura-brain-dump.md:17-20`). Nunca sai
   * de CLAUDE.md nem de arquivo md residente no repo alvo.
   */
  readonly instructions: string;

  /** O conteúdo específico desta tarefa/turno. Ver a regra normativa abaixo. */
  readonly prompt: string;

  /** Limite de relógio de parede; passando dele a sessão é morta. */
  readonly timeoutSeconds: number;

  /**
   * Adições opacas ao ambiente do processo do engine. Deliberadamente sem
   * tipo do ponto de vista desta camada: o que as chaves significam é
   * assunto do engine.
   */
  readonly envOverrides?: Readonly<Record<string, string>>;
}

/**
 * Engine sem system prompt nativo: o adapter concatena internamente
 * (equivalente ao que o flowpilot faz hoje). O chamador nunca vê isso.
 */
export function composeSingleArgument(spec: SessionSpec): string {
  return `${spec.instructions}\n\n---\n\n${spec.prompt}`;
}

/**
 * Engine com flag nativa: as instruções viram system prompt e o prompt vai
 * puro. Mesmo `SessionSpec`, injeção melhor — sem o chamador saber de nada.
 */
export function composeWithSystemPromptFlag(spec: SessionSpec): string[] {
  return ["--system-prompt", spec.instructions, spec.prompt];
}

/**
 * O que um engine faz além do baseline.
 *
 * Todos os campos são OPCIONAIS por decisão de compatibilidade: num formato
 * publicado, acrescentar uma flag obrigatória quebra a compilação de todo
 * adapter de terceiro que constrói o objeto literalmente. Ausente é `false`
 * — a direção segura de errar.
 *
 * Nenhuma destas flags tem consumidor no v0; as três nomeiam exatamente as
 * capacidades adiadas em "Fora de escopo". Declarar a quarta, quinta e sexta
 * antes de alguém ler é como o formato apodrece.
 */
export interface EngineCapabilities {
  /** Continua uma sessão anterior a partir de um `engineRef`. */
  readonly hasResume?: boolean;
  /** Emite frames legíveis por máquina, não só texto. */
  readonly hasStructuredOutput?: boolean;
  /** O output carrega contabilidade de tokens agregável. */
  readonly reportsUsage?: boolean;
}

/** O baseline: uma CLI que só recebe prompt, roda comandos e devolve output. */
export const BASELINE_CAPABILITIES: Required<EngineCapabilities> = {
  hasResume: false,
  hasStructuredOutput: false,
  reportsUsage: false,
};

/** Normaliza o que um adapter declarou contra o baseline. */
export function resolveCapabilities(
  declared: EngineCapabilities = {},
): Required<EngineCapabilities> {
  return {
    hasResume: declared.hasResume ?? false,
    hasStructuredOutput: declared.hasStructuredOutput ?? false,
    reportsUsage: declared.reportsUsage ?? false,
  };
}

/**
 * Por onde tudo que uma sessão produz sai do adapter.
 *
 * Nada escapa por canal específico de engine: o que o chamador precisa chega
 * aqui, e é isso que permite anexar ao log de eventos e atualizar a linha da
 * sessão sem saber qual CLI rodou (D1 — o adapter reporta, o server escreve).
 */
export interface SessionListener {
  /**
   * Uma linha emitida pelo engine (stdout e stderr fundidos, na ordem de
   * chegada), crua e sem parse. Cru é requisito: nem toda linha é frame
   * estruturado — uma CLI escreve grito de morte em texto puro no meio do
   * stream, e o log só é replayável (event sourcing) se guardar as duas.
   */
  onOutput(line: string): void;

  /**
   * O identificador que o próprio engine deu à sessão, assim que conhecido.
   *
   * Opcional e string opaca: cada CLI chama isso de uma coisa e nenhuma
   * garante o formato. Capturado hoje só para telemetria e auditoria — resume
   * está fora de escopo. Existe agora porque é barato de adicionar antes de
   * haver adapter publicado e caro de aparafusar depois.
   */
  onEngineRef?(engineRef: string): void;

  /**
   * Chamado EXATAMENTE UMA VEZ, ao atingir status terminal.
   *
   * `exitCode` é `number | null`: em POSIX, processo morto por sinal não tem
   * código de saída, e é precisamente o que acontece nos casos de timeout e
   * cancelamento do kit. `null` é "não houve", não "zero".
   */
  onFinished(status: SessionStatus, exitCode: number | null): void;
}

/** Resultado do preflight da CLI, consumido pelo wizard de instalação. */
export interface CliProbe {
  /** O binário existe e responde. */
  readonly available: boolean;
  readonly version: string | null;
  /**
   * Melhor esforço, nunca garantia: há engine cuja falha de credencial só
   * aparece no meio da primeira sessão (ver "Viabilidade"). `true` significa
   * "não achei motivo para falhar", não "vai autenticar".
   */
  readonly authenticated: boolean;
}

export interface EngineAdapter {
  /** Identificador estável, persistido na linha da sessão. */
  readonly engineName: string;

  /**
   * Abre uma sessão e devolve o handle LOCAL DESTE ADAPTER para ela — que
   * não é o `engineRef` do engine e não deve ser confundido com ele.
   *
   * Resolve assim que a sessão está de pé; o trabalho continua e é reportado
   * pelo listener. Rejeita com `SessionStartError` se não subiu.
   */
  startSession(spec: SessionSpec, listener: SessionListener): Promise<string>;

  /** Status corrente. Lança `UnknownSessionError` para handle desconhecido. */
  getStatus(sessionId: string): Promise<SessionStatus>;

  /**
   * Para uma sessão em andamento; no-op se já terminou.
   *
   * `status` é o status terminal a reportar no `onFinished`, default
   * `"cancelled"` (alguém apertou o botão). Um watchdog passa `"timed_out"`.
   * Registrar o motivo AQUI é o que tira o watchdog da corrida com a thread
   * de streaming do próprio adapter: a alternativa — cancelar e depois
   * sobrescrever a linha que a thread acabou de escrever — perde a escrita
   * que chegar por último.
   *
   * Lança `UnknownSessionError` para handle desconhecido.
   */
  cancel(sessionId: string, status?: SessionStatus): Promise<void>;

  /**
   * Declara o que este engine faz além do baseline. Logicamente não
   * obrigatório: um adapter que não tem nada a dizer devolve
   * `BASELINE_CAPABILITIES`, e o default seguro é todas as flags falsas.
   */
  capabilities(): EngineCapabilities;

  /** Preflight sem gastar quota. */
  verifyCli(): Promise<CliProbe>;
}

export class EngineError extends Error {}

/** A sessão não pôde ser aberta (binário ausente, workdir inexistente, spawn). */
export class SessionStartError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionStartError";
  }
}

/**
 * O handle nunca existiu NESTE adapter.
 *
 * `getStatus` e `cancel` sobre handle desconhecido LANÇAM — nunca devolvem
 * um status inventado. Um `"failed"` de consolo aqui vira, lá em cima, uma
 * sessão viva marcada como morta, e a diferença entre "não sei" e "deu
 * errado" é exatamente o que a telemetria precisa preservar.
 */
export class UnknownSessionError extends EngineError {
  constructor(public readonly sessionId: string) {
    super(`Handle de sessão desconhecido: ${sessionId}`);
    this.name = "UnknownSessionError";
  }
}
