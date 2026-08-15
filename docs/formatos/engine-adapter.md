# EngineAdapter — especificação v1

> **Status:** v1, **congelada**. A regra dos dois consumidores
> (`notas/2026-08-14-extensao-e-qualidade.md:57-63`) exige dois adapters
> *implementados* antes de travar o formato, e os dois existem:
> `packages/runner/src/engine/claude-code-adapter.ts` (t104) e
> `packages/runner/src/engine/codex-adapter.ts` (t119), cada um certificado
> pelos sete casos do kit contra o fake engine.
>
> **Lacuna registrada no congelamento (t119):** a prova manual do adapter do
> Codex contra a CLI real rodou até o 401 — a máquina não tem credencial
> OpenAI (`codex doctor`: "no Codex credentials were found") — então a metade
> credenciada dela, a que exige que a sessão *tenha trabalhado*, fica
> pendente de uma rodada com `OPENAI_API_KEY`. O que a rodada sem credencial
> já provou está no roteiro de `packages/runner/scripts/spike-real-session-codex.mjs`;
> o congelamento se apoia na certificação C1–C7, que está verde.
>
> O que autoriza o congelamento não é a contagem, é o que a contagem serve
> para medir: construir o segundo adapter **não exigiu mudança nenhuma** na
> interface nem no kit. O `CodexAdapter` entrou pela interface como ela
> estava e reusou `src/engine/conformance-kit.ts` e
> `test/fixtures/fake-engine.mjs` sem cópia e sem edição — a hipótese que a
> regra dos dois consumidores manda testar antes de travar, testada.
>
> Congelada significa aditivo daqui para frente: campo novo entra opcional
> (é para isso que `EngineCapabilities` já é toda opcional), e símbolo
> publicado não muda de nome nem de forma sem uma decisão registrada. O
> primeiro crescimento sob essa regra foi `SessionSpec.permissions` (t125),
> opcional e sem tocar em símbolo nenhum dos que já existiam. Onde a
> análise de viabilidade abaixo e "Fora de escopo (v0)" discordarem, **a
> decisão de escopo é a que vale**: a tabela é levantamento exploratório de
> uma CLI, não promessa de superfície. O caso vivo é `hasResume` — o
> `codex exec resume` existe, a tabela sugere declará-lo, e nenhum dos dois
> adapters declara, porque resume está fora do v0.
>
> **Portão deste documento:** `scripts/check-engine-adapter-spec.sh`.
> Ele verifica estrutura e sintaxe (headings, cobertura do kit, citação de
> fonte, e que todo bloco `typescript` daqui compila sob `tsc --strict`).
> Julgamento arquitetural é portão humano.

## Por que esta interface existe

O `engine` do flowpilot é um campo; no cartografo ele é uma interface —
"EngineAdapter (abrir sessão com prompt/workdir/skills/timeout), acompanhar
output, colher exit. Claude Code é o primeiro adapter, não uma dependência"
(`notas/2026-08-14-arquitetura-brain-dump.md:11-14`). É um dos quatro
formatos tratados como produto (`:17` da nota de extensão), e o que sustenta
sua qualidade quando um terceiro plugar uma CLI nova é o **kit de
conformidade** desta especificação, não a boa vontade de quem implementa.

Três fronteiras valem mais que qualquer detalhe abaixo:

1. **Nenhum vocabulário de engine acima desta linha.** Nome de binário,
   flag, variável de ambiente e formato de frame são assunto privado de cada
   adapter. Quem está acima fala `SessionSpec`, `SessionStatus` e
   `SessionListener`, e nada mais.
2. **O listener é a única saída.** O adapter não escreve no banco (D1), não
   chama a API e não persiste nada: ele reporta, e quem o chamou decide o que
   fazer com isso. É o que mantém o runner stateless e o server como único
   escritor.
3. **Depender do mínimo, explorar o máximo.** O baseline é uma CLI que
   recebe um prompt, roda comandos e devolve output. Toda capacidade além
   disso é oferecida quando existe, nunca exigida.

## Interface TypeScript

Stack cravada pela D17 (TypeScript, subprocess de CLI). Tudo aqui é
declaração de tipo — este repo é pré-código, e a implementação é ticket
futuro na ordem da D6.

### Status de sessão

Union de string literal, não enum: o valor persiste em coluna de texto e
atravessa JSON na API sem tradução, e adicionar membro não é migração.

```typescript
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
```

### O que se pede a um engine

```typescript
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

  /**
   * O que esta sessão pode tocar. Ausente = nenhuma restrição, que é o
   * comportamento de toda sessão aberta antes deste campo existir.
   */
  readonly permissions?: SessionPermissions;
}
```

### Regra normativa: `instructions` e `prompt` nunca chegam concatenados

**O chamador jamais concatena os dois campos.** Ele entrega os dois
separados e cada adapter decide como injeta — "flag/stdin/arquivo efêmero do
engine" (`notas/2026-08-14-arquitetura-brain-dump.md:17-18`).

Isso não é preciosismo de tipo: a revisão de viabilidade abaixo mediu a
divergência. O Claude Code tem `--system-prompt` e `--append-system-prompt`
nativos; o `codex exec` não tem nenhum flag de system prompt, e resolve
instrução por `AGENTS.md` no workdir ou pela chave de configuração
`base_instructions`. Um `SessionSpec` com um único campo `prompt` já teria
tomado, no chamador e sem revisão, a decisão de que toda injeção é
concatenação de string — e teria apagado a diferença justamente no engine que
faz melhor.

```typescript
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
```

Corolário para o kit: o caso de injeção de skill se verifica pelo que o
**processo do engine efetivamente recebeu**, nunca pelo que foi montado no
`SessionSpec` — checar o spec testaria o teste.

### Permissões da sessão

Este é o campo que a tensão 1 desta especificação registrou como faltante e
deixou "para a ticket da D4" (t125). Ele é **aditivo e opcional**, pela mesma
razão de compatibilidade das capacidades: um adapter de terceiro que constrói
o `SessionSpec` literalmente não pode parar de compilar porque a política de
permissão nasceu.

```typescript
export interface SessionPermissions {
  readonly filesystem: { readonly write: readonly string[] };
  readonly network: { readonly allowed: boolean; readonly domains?: readonly string[] };
}
```

O vocabulário vem do manifesto de skill (`permissoes.filesystem.escrita`,
`permissoes.rede`), com uma ausência deliberada: `permissoes.filesystem.leitura`
**não** tem contrapartida aqui. Nenhum dos dois engines analisados restringe
leitura abaixo do workspace sem quebrar skill comum, e declarar um campo que
nenhum adapter aplica seria a capacidade morta que a rejeição de
`hasNativeSystemPrompt` já recusou uma vez.

**O que um adapter faz com isto é assunto dele — inclusive recusar.** Um engine
que não consegue expressar a política pedida tem de dizer isso ANTES de abrir a
sessão, com `SessionStartError`; abrir uma sessão que aplica em silêncio menos
do que foi pedido é o desfecho que esta interface proíbe. Quem chama fica com
três respostas possíveis, todas honestas: a sessão sobe com a política
aplicada, a sessão sobe sem restrição (política ausente), ou a sessão não sobe.

**Estado hoje, sem maquiagem:** só o `claude-code` lê este campo. O
`CodexAdapter` o **ignora** — nem aplica, nem recusa — e nesse estado ele não
cumpre a regra do parágrafo acima. Isso é tolerável só porque nada popula
`permissions` ainda: quem vai populá-lo é o pipeline de renderização de skill
(`especificacoes/formatos/manifesto-skill.md:18-20`), que não existe. A ficha
que der um produtor real ao campo tem de fechar isto junto, e a resposta certa
para o Codex não é reusar o gating por nome de ferramenta daqui: ele tem
`-s, --sandbox` nativo, que é garantia de outra natureza (ver a tensão 1).

#### O que o adapter de referência garante

O `claude-code` não tem sandbox de SO (não há equivalente ao
`-s, --sandbox` do `codex exec`); o que existe é **gating por nome de
ferramenta** (`--disallowedTools`, com o padrão `"Bash(git *)"` documentado no
próprio `claude --help`). Cada eixo, e o que acontece com ele:

| Política declarada | Desfecho | Como |
|---|---|---|
| `rede.permitido: true` sem `dominios` | passa direto | nada a aplicar |
| `rede.permitido: true` com `dominios` | **recusa** | allowlist por domínio exigiria proxy de egress, que o engine não tem |
| `rede.permitido: false` | aplica | nega `WebFetch`, `WebSearch` e os padrões `Bash(curl *)`, `Bash(wget *)`, `Bash(nc *)`, `Bash(netcat *)`, `Bash(ssh *)`, `Bash(scp *)`, `Bash(telnet *)` |
| `escrita: []` | aplica | nega `Edit`, `Write`, `NotebookEdit` |
| `escrita: ["**"]` | passa direto | o workspace inteiro é gravável |
| `escrita` mais estreita | **recusa** | traduzir glob para regra fina de ferramenta é ficha futura |

**A lacuna residual, escrita porque existe.** `Bash` continua sendo um caminho
de rede e de escrita que nenhuma lista de nomes fecha por completo: `python -c`,
um script do próprio repo ou um utilitário que os padrões acima não nomeiam
alcançam a rede com a política de rede "aplicada". Isto é *best-effort no que o
engine permite* — a régua que `notas/2026-08-14-extensao-e-qualidade.md:43-44`
já fixou ("sandbox onde o engine permitir") — e **não** é isolamento de
processo. Fechar a lacuna de verdade exige sandbox de SO por plataforma
(`sandbox-exec`, namespace de rede, contêiner), que é mudança de mecanismo e
ficha própria. Toda tentativa negada vira evento `sessao.permissao_negada` no
log: o que o gating não impede, a telemetria pelo menos registra.

### Capacidades

```typescript
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
```

### O listener

Callback, nunca retorno síncrono: a sessão dura minutos ou horas, e o
consumidor precisa do output enquanto ele acontece — é disso que a telemetria
exigida pela D16 é feita.

```typescript
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
```

### O adapter

```typescript
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
```

### Erros

```typescript
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
```

### Invariantes que a interface não consegue expressar em tipo

Todas verificadas pelo kit abaixo:

1. `onFinished` é chamado exatamente uma vez, sempre, inclusive quando o
   processo é morto a sinal — nunca zero vezes, nunca duas.
2. Depois de `onFinished`, nenhum `onOutput` chega.
3. `getStatus` só devolve status terminal depois que `onFinished` correu.
4. Toda linha emitida pelo engine chega ao `onOutput`, na ordem original.
5. Nenhum processo fica órfão: nem por timeout, nem por cancelamento, nem por
   engine que ignora SIGTERM.
6. **`stdin` do processo do engine é fechado ou redirecionado para
   `/dev/null` pelo adapter.** Não é detalhe de implementação — ver "Ajustes
   feitos na revisão", item 1.
7. **O adapter nunca dá ao engine acesso a diretório além do
   `spec.workingDir`.** No `claude-code` isso é `--add-dir`, que o adapter não
   monta em nenhum caminho; em outro engine será outra flag. A invariante é a
   mesma: um diretório extra devolve, numa flag só, o escopo de escrita que a
   política acabou de fechar — e o `workingDir` é o único lugar que uma sessão
   tem direito de tocar.

## Kit de conformidade

Esta é a suíte que um adapter de terceiro precisa passar para entrar
(`notas/2026-08-14-extensao-e-qualidade.md:21-23`). Roda contra um **fake
engine** — um script controlável, injetado pela costura de construção de
comando do adapter — de modo que o CI nunca precise da CLI real instalada nem
autenticada. Rodar contra a CLI de verdade é portão manual, separado.

Os seis primeiros casos são obrigatórios. C7 vem junto porque é a única
verificação do contrato de erro e custa uma linha.

| Nome | Setup | Resultado esperado |
|---|---|---|
| **C1 — Sessão básica** | Fake engine emite N linhas e sai com 0. | `getStatus` é `"running"` logo após o start; `onFinished("completed", 0)` uma vez; `getStatus` passa a `"completed"`. Nenhum `onOutput` depois do `onFinished`. |
| **C2 — Injeção de skill** | `instructions` carrega um marcador único (ex.: `MARCADOR-a1b2c3`); `prompt` não o contém. O fake engine grava em arquivo TUDO que recebeu — argv, ambiente, stdin e arquivos criados no workdir. | O marcador aparece no que o **processo** recebeu, por qualquer um dos caminhos legítimos (argumento, flag de system prompt, stdin, arquivo efêmero). Asserção proibida: inspecionar o `SessionSpec` — isso testaria o teste, não o adapter. |
| **C3 — Timeout** | Fake engine que nunca termina sozinho; `timeoutSeconds` curto. | `onFinished("timed_out", …)` dispara perto do prazo, uma vez; o processo não existe mais depois (nenhum órfão); o relógio não continua armado. |
| **C4 — Morte de processo** | Fake engine que instala handler ignorando SIGTERM e segue vivo. | Depois do grace period o adapter escala para SIGKILL; `onFinished` ocorre mesmo assim e não fica pendurado. Cobre também o filho que sobrevive ao pai. |
| **C5 — Cancelamento** | Sessão longa; chamar `cancel(handle, "timed_out")` no meio. | O status reportado ao `onFinished` é **o que foi passado**, `"timed_out"`, não um `"cancelled"` fixo. Repetir com `cancel(handle)` sem argumento deve dar `"cancelled"`. Chamar `cancel` numa sessão já terminal é no-op silencioso, não erro. |
| **C6 — Colheita de eventos** | Fake engine emite uma sequência conhecida de linhas — incluindo uma que não é frame estruturado — e sai com código não-zero. | Todas as linhas chegam ao `onOutput`, **na ordem original e sem parse**; `onFinished` reporta `"failed"` com o exit code exato. A variante com saída 0 reporta `"completed"` com 0. |
| **C7 — Handle desconhecido** | Handle nunca iniciado neste adapter. | `getStatus` e `cancel` rejeitam com `UnknownSessionError`. Nenhum dos dois inventa status. |

Notas de execução:

- **Sem CLI real no CI.** A costura é a construção do comando; trocar o
  binário pelo fake engine é o que mantém a suíte determinística. Um adapter
  que não expõe essa costura é um adapter que não dá para certificar — isso é
  requisito do kit, não sugestão.
- **C3 e C4 são os caros.** São os dois que só falham sob carga real e são a
  razão de o kit existir: um adapter que vaza processo derruba a máquina do
  runner depois da centésima sessão, não da primeira.
- **Assíncrono, com deadline.** Todo caso espera status terminal com limite
  próprio e falha com mensagem explícita ao estourar; nada de `sleep` fixo.

## Viabilidade: segunda CLI

A regra dos dois consumidores exige um segundo engine real antes de congelar.
Aqui ele é **analisado, não implementado** — implementar é ticket futuro.

**Escolha: Codex CLI (OpenAI)**, pela semelhança estrutural com o
`stream-json` do Claude Code. Evidência levantada nesta ticket, em
2026-08-14, contra `codex-cli 0.147.0` executado via
`npx --yes @openai/codex@latest` (a CLI não estava instalada na máquina), e
contra `claude 2.1.232` já instalado. Fontes primárias:

- `codex --help` e `codex exec --help`, rodados aqui — saída transcrita nas
  citações abaixo.
- Uma execução real de `codex exec --json --skip-git-repo-check --ephemeral`
  sem credencial, que rendeu a forma dos frames e o código de saída.
- Strings do binário distribuído, para as chaves de instrução.
- Repositório e docs oficiais: <https://github.com/openai/codex> e
  <https://developers.openai.com/codex/>.
- Alternativa avaliada e descartada por ora: Gemini CLI, modo headless por
  `-p`/`--prompt` com `--output-format json|jsonl`
  (<https://geminicli.com/docs/cli/headless/>). Serve, e a mecânica é a
  mesma; Codex ficou por ter modo headless em subcomando dedicado
  (`codex exec`), o que dá uma superfície de flags menor e mais estável para
  um adapter.

### Mapeamento método a método

| Elemento da interface | Mecânica no `codex exec` | Evidência |
|---|---|---|
| `engineName` | `"codex"`. | — |
| `startSession` | `codex exec [OPTIONS] [PROMPT]` — "Run Codex non-interactively". Subprocess comum, sem daemon. | `codex --help`: `exec  Run Codex non-interactively [aliases: e]` |
| `SessionSpec.workingDir` | `-C, --cd <DIR>` ("use the specified directory as its working root"). Precisa de `--skip-git-repo-check` quando o diretório não é repo git — pegadinha real para worktree de teste. | `codex exec --help` |
| `SessionSpec.instructions` | **Sem flag de system prompt.** Três caminhos internos ao adapter: concatenar no prompt; escrever `AGENTS.md` efêmero no workdir; ou `-c base_instructions=<...>`. | `codex exec --help` não lista nenhum flag de system prompt; `grep -a` no binário distribuído acha `AGENTS.md` (70 ocorrências) e `base_instructions` (14). Contraste medido: `claude --help` lista `--system-prompt <prompt>` e `--append-system-prompt <prompt>`. |
| `SessionSpec.prompt` | Argumento posicional, ou stdin quando `-`. Sem shell no meio: argv direto, zero superfície de injeção de quoting. | `codex exec --help`: "Initial instructions for the agent. If not provided as an argument (or if `-` is used), instructions are read from stdin" |
| `SessionSpec.timeoutSeconds` | **Não existe flag de timeout** — nem aqui nem no Claude Code. É relógio do adapter sobre o processo, exatamente como a interface presume. | ausência em `codex exec --help` |
| `SessionSpec.envOverrides` | Ambiente do subprocess, mais `-c chave=valor` para configuração. | `codex exec --help` |
| `SessionListener.onOutput` | `--json` ("Print events to stdout as JSONL"). Linhas de erro do runtime saem em texto puro **não-JSON** no mesmo fluxo — o que confirma o contrato de linha crua sem parse. | Execução real: entre os frames JSON vieram linhas `ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized` |
| `SessionListener.onEngineRef` | Primeiro frame do stream: `{"type":"thread.started","thread_id":"01a000e7-…"}`. | Execução real |
| `SessionListener.onFinished` (status) | Frame terminal `turn.completed` / `turn.failed`, com o mesmo padrão do `result` do Claude Code: classificar por frame estruturado, cair para exit code quando não houver frame. | Execução real produziu `{"type":"turn.failed","error":{"message":"unexpected status 401 …"}}` |
| `SessionListener.onFinished` (exit code) | Sai **1** num turno falho — não mascara a falha atrás de um 0. | Execução real, medida sem pipe: `REAL_EXIT=1` |
| `getStatus` | Estado local do adapter, como no Claude Code: a CLI não tem consulta de estado. | — |
| `cancel` | Sinal ao processo: SIGTERM, SIGKILL após grace period. Sem subcomando de cancelamento. | ausência em `codex --help` |
| `capabilities` | `hasStructuredOutput: true` (JSONL), `hasResume: true` (`codex exec resume [SESSION_ID]`). `reportsUsage` a confirmar contra corpus real. | `codex exec resume --help`: "Resume a previous session by id" |
| `verifyCli` | `codex --version` → `codex-cli 0.147.0`; `codex doctor` ("Diagnose local Codex installation, config, auth, and runtime health") como sonda mais rica. Ver o item 3 dos ajustes. | `codex --help`, `codex --version` |
| `SessionStartError` | Falha de spawn ou workdir inexistente — mesma classe de erro nos dois engines. | — |
| `UnknownSessionError` | Puramente do adapter; nenhum engine participa. | — |

### Conclusão

A interface serve ao Codex CLI sem mudança estrutural: os dois engines são
subprocess headless com stream de eventos JSONL, engine ref no primeiro
frame, frame terminal e exit code. As divergências reais são **três**, e
todas caem exatamente onde a fronteira do adapter foi desenhada para
absorvê-las: como as instruções entram, como o frame terminal se chama, e o
que a sonda de autenticação consegue prometer. Nenhuma delas vaza para cima.

O que a revisão *mudou* está na seção seguinte.

## Ajustes feitos na revisão

Quatro mudanças e duas rejeições explícitas. Nada aqui é decorativo: os itens
1 e 3 saíram de rodar as CLIs, não de ler documentação.

1. **`stdin` fechado virou invariante normativa (novo).** Rodando
   `codex exec` com stdin não-TTY, a CLI imprimiu
   `Reading additional input from stdin...` antes de começar — e o
   `codex exec --help` confirma: "If stdin is piped and a prompt is also
   provided, stdin is appended as a `<stdin>` block". Um adapter que deixe um
   pipe aberto e nunca escreva nele trava a sessão para sempre: o engine
   espera EOF, o timeout até dispara, mas o custo é uma sessão inteira
   perdida por um default de biblioteca. Antes desta revisão isso era detalhe
   de implementação copiado do flowpilot; agora é invariante 6, e o caso C1
   do kit o exercita de graça.

2. **`exitCode` ficou `number | null` em vez de `number`.** Processo morto a
   sinal não tem código de saída em POSIX, e é o que acontece em C3 e C4 —
   os dois casos que o kit obriga. Um `number` puro forçaria todo adapter a
   inventar um `-1` ou `137`, e a telemetria perderia a diferença entre
   "saiu com erro" e "não chegou a sair". Vale para os dois engines.

3. **`CliProbe.authenticated` foi rebaixado a melhor esforço, por escrito.**
   A execução sem credencial mostrou que o Codex **abre a sessão
   normalmente** — `thread.started` e `turn.started` saem antes de qualquer
   sinal de problema — e só falha ao tentar falar com a API, com o 401
   chegando como frames `{"type":"error","message":"Reconnecting... 2/5 …"}`
   no meio do stream. Ou seja: não existe sonda barata que garanta
   autenticação para todo engine. O campo continua na interface (o wizard de
   instalação precisa dele), mas o doc agora diz o que ele promete, e nenhum
   consumidor pode tratá-lo como garantia.

4. **Campos de `EngineCapabilities` viraram opcionais.** Motivo é de formato
   publicado, não de gosto: acrescentar uma flag obrigatória a uma interface
   que terceiros implementam quebra a compilação de todos eles de uma vez.
   Opcional + `resolveCapabilities()` torna o crescimento aditivo, que é o
   que "schema versionado" tem que significar na prática.

**Rejeitado — flag `hasNativeSystemPrompt`.** A divergência é real e medida
(`claude --help` tem `--system-prompt`; `codex exec --help` não tem
equivalente), e a tentação de expor isso como capacidade é grande. Mas
nenhum consumidor acima do adapter faria coisa diferente sabendo: `instructions`
chega separado justamente para que a escolha do mecanismo morra dentro do
adapter. Declarar a flag seria uma afirmação sem consumidor — e é assim que
um formato-produto começa a acumular campo morto. O que a divergência
produziu foi a **regra normativa** da separação, que agora está escrita, e o
caso C2 do kit, que a verifica pelo que o processo recebeu.

**Rejeitado — `SessionStatus` mais rico.** Codex e Claude Code têm ambos
estados próprios de quota/limite (o `Reconnecting... n/5` acima é um deles).
Tentador promover ao baseline; errado por ora. Um terceiro engine sem
conceito de janela de quota teria que fingir, e a regra dos dois consumidores
vale para o vocabulário de status tanto quanto para os métodos. Fica
`failed`, e o motivo real vive no log de eventos, que é append-only e não
perde nada.

## Fora de escopo (v0)

Registrado para quem ler depois não presumir esquecimento:

- **`continueSession` / resume**, contagem de uso (`SessionUsage`) e projeção
  de transcript. Existem no flowpilot; a régua da PoC (D16) pede sessões
  despachadas e telemetria completa, e não menciona resume. `onEngineRef` já
  captura a chave que o resume vai precisar. Continua fora no v1: o
  `codex exec resume` existe e segue não declarado nas `capabilities` dos dois
  adapters, justamente por isto.
- **Sandbox de sistema operacional.** Permissões de skill **saíram** desta
  lista na t125 (ver "Permissões da sessão" e a tensão 1, agora resolvida); o
  que continua fora é o isolamento de processo — `sandbox-exec`, namespace de
  rede, contêiner. O que existe hoje é gating por nome de ferramenta, no que o
  engine permitir, com a lacuna residual escrita.
- **SDK vs subprocess.** Assumido subprocess de CLI, alinhado à D17 e ao
  precedente do flowpilot.

Duas entradas **saíram** desta lista no congelamento para v1 (t119), por terem
deixado de ser verdade — registradas aqui em vez de sumirem sem rastro:
"implementar qualquer adapter, nem Claude Code nem Codex" (o primeiro saiu na
t104, o segundo nesta ficha) e "congelar a interface: dois adapters reais
primeiro" (é o que este documento acabou de fazer).

## Revisão contra as decisões registradas

- **D1 (só o server escreve)** — respeitada por construção: o listener é a
  única saída do adapter, e quem persiste é quem chamou.
- **D6 (ordem do MVP)** — esta ticket é a especificação que a construção do
  primeiro adapter consome; nenhum sintetizador é tocado.
- **D17 (stack e relação com o flowpilot)** — TypeScript, subprocess de CLI,
  flowpilot como referência de comportamento. Nenhuma linha de código
  portada; o que veio de lá foram as decisões e as cicatrizes.
- **D9 (formato do contrato)** — tensão registrada, não decidida aqui, na
  seção abaixo.
- **D4 (portão de importação de skill)** — a tensão 1 abaixo saiu do papel na
  t125: o campo existe, o adapter de referência aplica o que consegue e recusa
  o que não consegue.

### Tensões encontradas (para o portão humano, não decididas aqui)

1. **D4 × ausência de política de permissão no `SessionSpec` — RESOLVIDA na
   t125.** O campo é `permissions?: SessionPermissions` (ver "Permissões da
   sessão"), e a pergunta que a tensão dizia não ser neutra — quem responde
   pela política, o manifesto ou o adapter — foi respondida assim: **o
   manifesto declara, o adapter aplica ou recusa**. O default do adapter deixa
   de valer no instante em que a política chega; onde ela não chega, o
   comportamento é o de antes. Resolver a segunda metade (buscar `permissoes`
   do manifesto registrado a partir do `skill_ref` do nó e popular o campo) é
   do pipeline de renderização de skill, que ainda não existe. O registro
   original, que continua verdadeiro sobre as CLIs, fica abaixo.

   > *Como estava registrado, antes da t125:* as duas CLIs têm controle de
   > permissão de primeira classe — `codex exec` traz
   > `-s, --sandbox <read-only|workspace-write|danger-full-access>`,
   > `--approve-for-me` e `--dangerously-bypass-approvals-and-sandbox`; o
   > `claude` traz `--permission-mode` com
   > `acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`. Cuidado com o
   > `-a, --ask-for-approval`: ele é do `codex` **interativo** (nível superior)
   > e não existe no subcomando `exec`, que morre com
   > `error: unexpected argument '-a' found` — a aprovação não-interativa do
   > exec são os dois flags acima. O `SessionSpec` v0 **não tem onde expressar
   > isso**: hoje a política só pode vir de default codificado no adapter ou de
   > `envOverrides`, que é opaco por definição e portanto inauditável. Quando a
   > D4 sair do papel — permissões declaradas no manifesto da skill, com pin por
   > hash — vai faltar exatamente este campo, e ele é aditivo mas não é neutro
   > (define quem responde pela política: o manifesto ou o adapter). Fica para a
   > ticket de D4.

   Uma coisa daquele registro **não** foi resolvida e vale como aviso: o
   `-s/--sandbox` do `codex exec` é sandbox de verdade, de outra natureza que o
   gating por nome de ferramenta do `claude-code`. O adapter do Codex não ganha
   permissão nesta ficha justamente por isso — reusar a lógica de gating ali
   seria traduzir uma garantia dura para uma fraca sem ninguém pedir, e a regra
   dos dois consumidores manda esperar o segundo consumidor real.
2. **D9 × a forma deste contrato.** A D9 manda contrato ser JSON Schema de
   entrada/saída mais checks tipados. Esta especificação é tipo TS mais uma
   tabela de conformidade em prosa. A leitura adotada aqui é que a D9 governa
   **capacidades** (skill, portão, nó) — as coisas que atravessam o grafo — e
   não a interface de transporte de sessão, que é código e cuja verificação é
   a suíte de conformidade. Se a leitura correta for a outra, o kit acima é o
   candidato natural a virar lista de checks tipados, e o `SessionSpec` a
   virar JSON Schema. Vale a mesma pergunta para as três especificações irmãs
   (schema do grafo, manifesto de skill, taxonomia de eventos) — melhor
   responder uma vez, para as quatro.
