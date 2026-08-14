/**
 * `ClaudeCodeAdapter` — o primeiro EngineAdapter, rodando a CLI `claude`
 * headless como subprocess.
 *
 * "Claude Code é o primeiro adapter, não uma dependência"
 * (`notas/2026-08-14-arquitetura-brain-dump.md:11-14`). Tudo que é específico
 * desta CLI está aqui e em `command.ts`; acima desta linha só existe
 * `SessionSpec`, `SessionStatus` e `SessionListener`.
 *
 * Três decisões estruturais, todas vindas das cicatrizes registradas na
 * especificação:
 *
 * - **O processo sobe destacado (`detached`), e os sinais vão para o GRUPO.**
 *   É o que faz o C4 passar: um engine que deixa um filho vivo derruba a
 *   máquina do runner depois da centésima sessão, não da primeira
 *   (`docs/formatos/engine-adapter.md:367-369`).
 * - **O fim é decidido no `close`, não no `exit`.** `close` só chega quando os
 *   pipes fecharam, e é o que garante a invariante 4 (toda linha emitida chega
 *   ao `onOutput`) antes da invariante 1 (`onFinished` exatamente uma vez).
 * - **O relógio é nosso.** Nenhuma das duas CLIs analisadas tem flag de
 *   timeout (`engine-adapter.md:407`), então o adapter arma, escala
 *   SIGTERM→SIGKILL e desarma.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  buildCommand,
  buildEnvironment,
  CLAUDE_BINARY,
  STDIO_DO_ENGINE,
  type EngineCommand,
} from './command.ts';
import {
  SessionStartError,
  UnknownSessionError,
  type CliProbe,
  type EngineAdapter,
  type EngineCapabilities,
  type SessionListener,
  type SessionSpec,
  type SessionStatus,
} from './types.ts';

/** Espera entre o SIGTERM e o SIGKILL. */
export const MS_DE_GRACA_PADRAO = 5_000;

/** Prazo da sonda de `--version`; uma CLI que não responde nisso não está de pé. */
const MS_DE_PRAZO_DA_SONDA = 10_000;

/**
 * Credenciais que, presentes no ambiente, sugerem sessão autenticável.
 *
 * "Sugerem" é o verbo certo: `authenticated` é melhor esforço por decisão
 * registrada da especificação — existe engine cuja falha de credencial só
 * aparece no meio da primeira sessão (`engine-adapter.md:452-461`).
 */
export const VARIAVEIS_DE_CREDENCIAL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export interface ClaudeCodeAdapterOptions {
  /** Costura de teste: troca o binário real pelo fake engine do kit. */
  readonly commandBuilder?: (spec: SessionSpec) => EngineCommand;
  /** Costura de teste: ambiente entregue ao processo do engine. */
  readonly environmentBuilder?: (spec: SessionSpec) => NodeJS.ProcessEnv;
  /** Espera entre SIGTERM e SIGKILL. Default 5s. */
  readonly graceMs?: number;
  /** Costura de teste: o comando do preflight. */
  readonly probeCommandBuilder?: () => EngineCommand;
  /** Ambiente consultado pelo preflight. Default `process.env`. */
  readonly probeEnvironment?: NodeJS.ProcessEnv;
  /** Arquivo de credencial lido pelo preflight. Default `~/.claude.json`. */
  readonly credentialsPath?: string;
}

/** Estado local de uma sessão viva. O adapter não persiste nada (D1). */
interface Sessao {
  readonly processo: ChildProcess;
  readonly listener: SessionListener;
  status: SessionStatus;
  /** Status terminal pedido por quem mandou parar (cancelamento ou relógio). */
  statusPedido: SessionStatus | null;
  finalizada: boolean;
  refEnviada: boolean;
  relogio: NodeJS.Timeout | null;
  escalada: NodeJS.Timeout | null;
  rede: NodeJS.Timeout | null;
  restos: { stdout: string; stderr: string };
}

/**
 * O id de sessão que o próprio engine deu, se esta linha for um quadro
 * `stream-json` reconhecido.
 *
 * Exigir `type` e `session_id` é o que separa um quadro de verdade de uma
 * linha de log que por acaso menciona a palavra: o stream mistura frames
 * estruturados com "grito de morte em texto puro"
 * (`engine-adapter.md:209-214`), e classificar errado aqui produziria um
 * `engineRef` inventado.
 */
export function extrairEngineRef(linha: string): string | null {
  const podado = linha.trim();
  if (!podado.startsWith('{')) return null;

  let quadro: unknown;
  try {
    quadro = JSON.parse(podado);
  } catch {
    return null;
  }
  if (typeof quadro !== 'object' || quadro === null) return null;

  const { type, session_id: idDaSessao } = quadro as { type?: unknown; session_id?: unknown };
  if (typeof type !== 'string' || typeof idDaSessao !== 'string' || idDaSessao === '') return null;
  return idDaSessao;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly engineName = 'claude-code';

  readonly #sessoes = new Map<string, Sessao>();
  readonly #commandBuilder: (spec: SessionSpec) => EngineCommand;
  readonly #environmentBuilder: (spec: SessionSpec) => NodeJS.ProcessEnv;
  readonly #graceMs: number;
  readonly #probeCommandBuilder: () => EngineCommand;
  readonly #probeEnvironment: NodeJS.ProcessEnv;
  readonly #credentialsPath: string;

  constructor(opcoes: ClaudeCodeAdapterOptions = {}) {
    this.#commandBuilder = opcoes.commandBuilder ?? ((spec) => buildCommand(spec));
    this.#environmentBuilder = opcoes.environmentBuilder ?? ((spec) => buildEnvironment(spec));
    this.#graceMs = opcoes.graceMs ?? MS_DE_GRACA_PADRAO;
    this.#probeCommandBuilder =
      opcoes.probeCommandBuilder ?? (() => ({ command: CLAUDE_BINARY, args: ['--version'] }));
    this.#probeEnvironment = opcoes.probeEnvironment ?? process.env;
    this.#credentialsPath = opcoes.credentialsPath ?? join(homedir(), '.claude.json');
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    const comando = this.#commandBuilder(spec);

    let processo: ChildProcess;
    try {
      processo = spawn(comando.command, [...comando.args], {
        cwd: spec.workingDir,
        env: this.#environmentBuilder(spec),
        stdio: [...STDIO_DO_ENGINE],
        // Grupo próprio: é o que permite sinalizar netos junto com o pai.
        detached: true,
      });
    } catch (causa) {
      throw new SessionStartError(`não foi possível iniciar "${comando.command}"`, { cause: causa });
    }

    const id = randomUUID();
    const sessao: Sessao = {
      processo,
      listener,
      status: 'pending',
      statusPedido: null,
      finalizada: false,
      refEnviada: false,
      relogio: null,
      escalada: null,
      rede: null,
      restos: { stdout: '', stderr: '' },
    };
    this.#sessoes.set(id, sessao);

    // Todos os handlers são registrados AGORA, síncronos: um processo que morre
    // depressa dispararia `close` antes de um registro adiado por `await`, e a
    // sessão ficaria pendurada para sempre.
    let subiu = false;
    let avisarInicio: (erro: Error | null) => void = () => {};
    const inicio = new Promise<Error | null>((resolve) => {
      avisarInicio = resolve;
    });

    processo.once('spawn', () => {
      subiu = true;
      sessao.status = 'running';
      avisarInicio(null);
    });

    processo.once('error', (erro: Error) => {
      if (!subiu) {
        avisarInicio(erro);
        return;
      }
      this.#finalizar(id, sessao.statusPedido ?? 'failed', null);
    });

    for (const fluxo of ['stdout', 'stderr'] as const) {
      const stream = processo[fluxo];
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', (pedaco: string) => {
        this.#bombear(sessao, fluxo, pedaco);
      });
    }

    processo.once('close', (codigo: number | null) => {
      if (!subiu) {
        avisarInicio(new Error(`o processo do engine fechou antes de subir (código ${codigo})`));
        return;
      }
      this.#concluir(id, codigo);
    });

    const falha = await inicio;
    if (falha) {
      this.#sessoes.delete(id);
      throw new SessionStartError(
        `não foi possível abrir sessão com "${comando.command}" em "${spec.workingDir}"`,
        { cause: falha },
      );
    }

    if (spec.timeoutSeconds > 0) {
      sessao.relogio = setTimeout(() => {
        this.#encerrar(id, 'timed_out');
      }, spec.timeoutSeconds * 1_000);
    }

    return id;
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return this.#exigirSessao(sessionId).status;
  }

  async cancel(sessionId: string, status: SessionStatus = 'cancelled'): Promise<void> {
    const sessao = this.#exigirSessao(sessionId);
    // No-op silencioso, não erro: quem cancela corre com a própria thread de
    // streaming do adapter e não tem como saber se perdeu a corrida.
    if (sessao.finalizada) return;
    this.#encerrar(sessionId, status);
  }

  /**
   * `stream-json` é parseável, então `hasStructuredOutput`. As outras duas
   * ficam ausentes (default `false`): resume e contagem de uso estão fora do
   * v0 e não têm consumidor — "declarar a quarta, quinta e sexta antes de
   * alguém ler é como o formato apodrece" (`engine-adapter.md:160-165`).
   */
  capabilities(): EngineCapabilities {
    return { hasStructuredOutput: true };
  }

  async verifyCli(): Promise<CliProbe> {
    const versao = await this.#sondarVersao();
    return {
      available: versao !== null,
      version: versao,
      authenticated: this.#pareceAutenticado(),
    };
  }

  #exigirSessao(sessionId: string): Sessao {
    const sessao = this.#sessoes.get(sessionId);
    if (!sessao) throw new UnknownSessionError(sessionId);
    return sessao;
  }

  /** Quebra o fluxo em linhas, guardando o resto sem `\n` para o próximo pedaço. */
  #bombear(sessao: Sessao, fluxo: 'stdout' | 'stderr', pedaco: string): void {
    const acumulado = sessao.restos[fluxo] + pedaco;
    const partes = acumulado.split('\n');
    sessao.restos[fluxo] = partes.pop() ?? '';
    for (const linha of partes) this.#emitir(sessao, linha);
  }

  #emitir(sessao: Sessao, linha: string): void {
    // Invariante 2: depois do onFinished, nenhum onOutput.
    if (sessao.finalizada) return;
    sessao.listener.onOutput(linha);

    if (sessao.refEnviada || !sessao.listener.onEngineRef) return;
    const ref = extrairEngineRef(linha);
    if (ref === null) return;
    sessao.refEnviada = true;
    sessao.listener.onEngineRef(ref);
  }

  /** Fim natural do processo: drena o que sobrou e classifica o desfecho. */
  #concluir(id: string, codigo: number | null): void {
    const sessao = this.#sessoes.get(id);
    if (!sessao || sessao.finalizada) return;

    for (const fluxo of ['stdout', 'stderr'] as const) {
      const resto = sessao.restos[fluxo];
      sessao.restos[fluxo] = '';
      if (resto !== '') this.#emitir(sessao, resto);
    }

    // Quem mandou parar tem a palavra sobre o status; sem isso, o exit code
    // decide. `codigo` já vem `null` quando o processo morreu por sinal — em
    // POSIX não há código de saída nesse caso, e `null` é "não houve", nunca
    // "zero" (`engine-adapter.md:227-234`).
    const status = sessao.statusPedido ?? (codigo === 0 ? 'completed' : 'failed');
    this.#finalizar(id, status, codigo);
  }

  /** Pede parada: SIGTERM ao grupo, SIGKILL depois do grace. */
  #encerrar(id: string, status: SessionStatus): void {
    const sessao = this.#sessoes.get(id);
    if (!sessao || sessao.finalizada) return;

    sessao.statusPedido = status;
    this.#sinalizarGrupo(sessao, 'SIGTERM');
    if (sessao.escalada) return;

    sessao.escalada = setTimeout(() => {
      this.#sinalizarGrupo(sessao, 'SIGKILL');

      // Rede de segurança da invariante 1 ("onFinished exatamente uma vez,
      // sempre"): se nem depois do SIGKILL o `close` chegar, o desfecho é
      // reportado assim mesmo. Sessão pendurada para sempre é pior do que
      // sessão reportada sem a última linha, e este caminho não deveria
      // acontecer — matar o grupo fecha os pipes.
      sessao.rede = setTimeout(() => {
        this.#finalizar(id, status, null);
      }, this.#graceMs);
    }, this.#graceMs);
  }

  #finalizar(id: string, status: SessionStatus, exitCode: number | null): void {
    const sessao = this.#sessoes.get(id);
    if (!sessao || sessao.finalizada) return;

    this.#desarmar(sessao);
    sessao.finalizada = true;
    // Invariante 3: o status só vira terminal junto com o onFinished, nunca antes.
    sessao.status = status;
    sessao.listener.onFinished(status, exitCode);
  }

  #desarmar(sessao: Sessao): void {
    for (const nome of ['relogio', 'escalada', 'rede'] as const) {
      const relogio = sessao[nome];
      if (relogio) clearTimeout(relogio);
      sessao[nome] = null;
    }
  }

  /**
   * Sinaliza o grupo inteiro do processo (pid negativo).
   *
   * O processo subiu com `detached`, então é líder do próprio grupo: o sinal
   * alcança o filho que o engine deixou para trás. Se o grupo não existir mais,
   * cai para o processo direto, e a falha final é ignorada — o alvo já morreu.
   */
  #sinalizarGrupo(sessao: Sessao, sinal: NodeJS.Signals): void {
    const pid = sessao.processo.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sinal);
    } catch {
      try {
        sessao.processo.kill(sinal);
      } catch {
        /* já morreu; nada a fazer */
      }
    }
  }

  /** `claude --version`: preflight que não abre sessão nem gasta cota. */
  #sondarVersao(): Promise<string | null> {
    const comando = this.#probeCommandBuilder();

    return new Promise((resolve) => {
      let processo: ChildProcess;
      try {
        processo = spawn(comando.command, [...comando.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.#probeEnvironment,
        });
      } catch {
        resolve(null);
        return;
      }

      let saida = '';
      processo.stdout?.setEncoding('utf8');
      processo.stdout?.on('data', (pedaco: string) => {
        saida += pedaco;
      });

      const prazo = setTimeout(() => {
        processo.kill('SIGKILL');
        resolve(null);
      }, MS_DE_PRAZO_DA_SONDA);

      const responder = (versao: string | null): void => {
        clearTimeout(prazo);
        resolve(versao);
      };

      // Binário ausente chega aqui como ENOENT: `available: false`, sem lançar.
      processo.once('error', () => responder(null));
      processo.once('close', (codigo: number | null) => {
        const podado = saida.trim();
        responder(codigo === 0 && podado !== '' ? podado : null);
      });
    });
  }

  /**
   * Melhor esforço, nunca garantia: credencial no ambiente OU conta OAuth
   * registrada no arquivo de credencial. `true` significa "não achei motivo
   * para falhar", não "vai autenticar" (`engine-adapter.md:245-252`).
   */
  #pareceAutenticado(): boolean {
    for (const nome of VARIAVEIS_DE_CREDENCIAL) {
      const valor = this.#probeEnvironment[nome];
      if (typeof valor === 'string' && valor.trim() !== '') return true;
    }

    try {
      const conteudo: unknown = JSON.parse(readFileSync(this.#credentialsPath, 'utf8'));
      if (typeof conteudo !== 'object' || conteudo === null) return false;
      return Boolean((conteudo as { oauthAccount?: unknown }).oauthAccount);
    } catch {
      // Arquivo ausente, ilegível ou corrompido não é sinal de autenticação —
      // e muito menos motivo para derrubar um preflight.
      return false;
    }
  }
}
