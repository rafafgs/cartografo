/**
 * Construção do comando e do ambiente da CLI `claude`.
 *
 * Puro de propósito: sem spawn, sem estado, sem relógio. É a costura que o kit
 * de conformidade exige ("um adapter que não expõe essa costura é um adapter
 * que não dá para certificar", `docs/formatos/engine-adapter.md:363-366`), e
 * mantê-la sem efeito colateral é o que deixa o argv ser verificado por unidade
 * sem CLI real nem autenticação.
 *
 * Todo o vocabulário de engine do adapter mora aqui: nome do binário, flags e
 * a variável de ambiente do modo de permissão. Nada disso atravessa a fronteira
 * para cima (fronteira 1 da especificação).
 */

import { composeWithSystemPromptFlag, type SessionSpec } from './types.ts';

/** O binário headless. */
export const CLAUDE_BINARY = 'claude';

/**
 * Modo de permissão default.
 *
 * `bypassPermissions` porque a sessão é não-interativa e roda em worktree
 * isolado — não há ninguém para aprovar nada, e uma sessão que trava pedindo
 * permissão é uma sessão perdida. Mesmo trade-off que o flowpilot já assume.
 *
 * De onde a política *deveria* vir é tensão registrada e ainda aberta: o
 * `SessionSpec` v0 não tem onde expressá-la, e quando a D4 sair do papel
 * (permissões declaradas no manifesto da skill, com pin por hash) vai faltar
 * exatamente esse campo (`docs/formatos/engine-adapter.md:515-532`). Até lá o
 * default é do adapter, e o único override é a variável abaixo.
 */
export const MODO_DE_PERMISSAO_PADRAO = 'bypassPermissions';

/**
 * Único override do modo de permissão, lido do ambiente do PRÓPRIO adapter.
 *
 * Deliberadamente não é campo do `SessionSpec` nem chave de `envOverrides`:
 * nenhuma configuração de engine pode vir de cima da fronteira do adapter
 * enquanto a D4 não decidir quem responde pela política.
 */
export const VARIAVEL_DE_MODO_DE_PERMISSAO = 'CLAUDE_PERMISSION_MODE';

/**
 * `stdio` do processo do engine: stdin em `/dev/null`, stdout e stderr em pipe.
 *
 * Invariante 6 da especificação, e a única do documento que nasceu de rodar as
 * CLIs em vez de ler documentação: um pipe aberto que ninguém escreve deixa o
 * engine esperando EOF para sempre — "o timeout até dispara, mas o custo é uma
 * sessão inteira perdida por um default de biblioteca"
 * (`docs/formatos/engine-adapter.md:436-445`).
 */
export const STDIO_DO_ENGINE = ['ignore', 'pipe', 'pipe'] as const;

/** Um comando pronto para `spawn`, sem shell no meio. */
export interface EngineCommand {
  readonly command: string;
  readonly args: string[];
}

/** O modo de permissão em vigor: a variável de ambiente, ou o default. */
export function resolverModoDePermissao(env: NodeJS.ProcessEnv = process.env): string {
  const declarado = env[VARIAVEL_DE_MODO_DE_PERMISSAO]?.trim();
  return declarado ? declarado : MODO_DE_PERMISSAO_PADRAO;
}

/**
 * Monta o argv da sessão headless.
 *
 * As três últimas posições saem de `composeWithSystemPromptFlag` — a própria
 * função da especificação para "engine com flag nativa: as instruções viram
 * system prompt e o prompt vai puro" (`engine-adapter.md:138-144`). Usar a
 * função do documento em vez de reescrevê-la aqui é o que garante que a regra
 * normativa (`instructions` e `prompt` NUNCA concatenados) valha por
 * construção, e não por disciplina de quem editar este arquivo depois.
 */
export function buildCommand(
  spec: SessionSpec,
  env: NodeJS.ProcessEnv = process.env,
): EngineCommand {
  return {
    command: CLAUDE_BINARY,
    args: [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      resolverModoDePermissao(env),
      ...composeWithSystemPromptFlag(spec),
    ],
  };
}

/**
 * Ambiente do processo do engine: o ambiente base com os `envOverrides` por
 * cima.
 *
 * `envOverrides` é opaco por definição da interface ("o que as chaves
 * significam é assunto do engine"), então nada é interpretado aqui — só fundido.
 */
export function buildEnvironment(
  spec: SessionSpec,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...spec.envOverrides };
}
