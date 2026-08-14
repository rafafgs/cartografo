/**
 * Construção do comando da CLI `claude`.
 *
 * O que estes testes protegem é a regra normativa da especificação: "o chamador
 * jamais concatena os dois campos" (`docs/formatos/engine-adapter.md:114-149`).
 * O Claude Code tem `--system-prompt` nativo, então a injeção correta aqui é a
 * flag — concatenar seria adotar, sem revisão, o caminho de quem *não* tem a
 * flag, e apagar a diferença justamente no engine que faz melhor.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAUDE_BINARY,
  MODO_DE_PERMISSAO_PADRAO,
  STDIO_DO_ENGINE,
  VARIAVEL_DE_MODO_DE_PERMISSAO,
  buildCommand,
  buildEnvironment,
} from '../../src/engine/command.ts';
import type { SessionSpec } from '../../src/engine/types.ts';

const INSTRUCOES = 'Você é o nó "fazer". Implemente o ticket com testes primeiro.';
const PROMPT = 'Ticket #104: EngineAdapter do Claude Code.';

const spec = (extra: Partial<SessionSpec> = {}): SessionSpec => ({
  workingDir: '/tmp/worktree-de-teste',
  instructions: INSTRUCOES,
  prompt: PROMPT,
  timeoutSeconds: 600,
  ...extra,
});

test('instructions nunca chega concatenado ao prompt', () => {
  const { args } = buildCommand(spec(), {});

  for (const argumento of args) {
    assert.ok(
      !(argumento.includes(INSTRUCOES) && argumento.includes(PROMPT)),
      `o argumento ${JSON.stringify(argumento)} carrega instructions E prompt no mesmo valor`,
    );
  }
});

test('--system-prompt carrega instructions verbatim', () => {
  const { args } = buildCommand(spec(), {});

  const posicao = args.indexOf('--system-prompt');
  assert.notEqual(posicao, -1, 'o comando não usa a flag nativa de system prompt');
  assert.equal(
    args[posicao + 1],
    INSTRUCOES,
    'as instruções do nó têm de ir verbatim, sem prefixo, sufixo ou reformatação',
  );
});

test('prompt é o último elemento do argv', () => {
  const { command, args } = buildCommand(spec(), {});

  assert.equal(command, CLAUDE_BINARY);
  assert.equal(args.at(-1), PROMPT);
});

test('o comando roda headless com saída estruturada', () => {
  const { args } = buildCommand(spec(), {});

  assert.ok(args.includes('--print'), 'sem --print a CLI abre sessão interativa');
  assert.ok(args.includes('--verbose'));

  const formato = args.indexOf('--output-format');
  assert.notEqual(formato, -1);
  assert.equal(args[formato + 1], 'stream-json');
});

test('sem --permission-mode explícito o default é bypassPermissions', () => {
  const { args } = buildCommand(spec(), {});

  const posicao = args.indexOf('--permission-mode');
  assert.notEqual(posicao, -1);
  assert.equal(args[posicao + 1], 'bypassPermissions');
  assert.equal(MODO_DE_PERMISSAO_PADRAO, 'bypassPermissions');
});

test('CLAUDE_PERMISSION_MODE sobrepõe o default, e só ela', () => {
  const { args } = buildCommand(spec(), { [VARIAVEL_DE_MODO_DE_PERMISSAO]: 'plan' });

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
});

test('envOverrides do spec não muda o modo de permissão', () => {
  // A política de permissão é assunto do adapter, não do chamador: enquanto a
  // tensão da D4 não for resolvida (`engine-adapter.md:515-532`), nenhuma
  // configuração de engine atravessa a fronteira por cima.
  const { args } = buildCommand(
    spec({ envOverrides: { [VARIAVEL_DE_MODO_DE_PERMISSAO]: 'acceptEdits' } }),
    {},
  );

  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('buildEnvironment funde envOverrides por cima do ambiente base', () => {
  const ambiente = buildEnvironment(spec({ envOverrides: { MINHA_CHAVE: 'valor' } }), {
    PATH: '/usr/bin',
    MINHA_CHAVE: 'antigo',
  });

  assert.equal(ambiente.MINHA_CHAVE, 'valor');
  assert.equal(ambiente.PATH, '/usr/bin', 'o ambiente base tem de sobreviver à fusão');
});

test('buildEnvironment sem envOverrides devolve o ambiente base', () => {
  const ambiente = buildEnvironment(spec(), { PATH: '/usr/bin' });

  assert.deepEqual(ambiente, { PATH: '/usr/bin' });
});

test('stdin do processo do engine é fechado por default', () => {
  // Invariante 6 da especificação: um pipe aberto que ninguém escreve trava a
  // sessão para sempre, esperando EOF.
  assert.equal(STDIO_DO_ENGINE[0], 'ignore');
  assert.deepEqual([...STDIO_DO_ENGINE], ['ignore', 'pipe', 'pipe']);
});
