/**
 * Preflight da CLI (`verifyCli`), rodado contra o binário fake.
 *
 * `available` é uma pergunta barata e honesta: o binário existe e responde a
 * `--version`, sem gastar cota. `authenticated` é outra coisa — a especificação
 * o rebaixou a **melhor esforço** por escrito, depois de medir um engine que
 * abre a sessão normalmente e só descobre a falta de credencial no meio do
 * stream (`docs/formatos/engine-adapter.md:452-461`). Estes testes fixam
 * exatamente isso: uma sonda que não promete mais do que consegue.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';

const FAKE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

/** Um caminho que garantidamente não existe, para o caso do binário ausente. */
const BINARIO_INEXISTENTE = join(tmpdir(), 'cartografo-binario-que-nao-existe-104');

const adapterCom = (opcoes: {
  comando?: { command: string; args: string[] };
  ambiente?: Record<string, string>;
  credenciais?: string;
}): ClaudeCodeAdapter =>
  new ClaudeCodeAdapter({
    probeCommandBuilder: () => opcoes.comando ?? { command: process.execPath, args: [FAKE, '--version'] },
    probeEnvironment: opcoes.ambiente ?? {},
    credentialsPath: opcoes.credenciais ?? join(tmpdir(), 'cartografo-sem-credencial-104.json'),
  });

test('available é true e a versão vem do binário que respondeu', async () => {
  const sonda = await adapterCom({}).verifyCli();

  assert.equal(sonda.available, true);
  assert.equal(sonda.version, '9.9.9 (Fake Engine)');
});

test('binário inexistente devolve available false, sem lançar', async () => {
  const sonda = await adapterCom({
    comando: { command: BINARIO_INEXISTENTE, args: ['--version'] },
  }).verifyCli();

  assert.equal(sonda.available, false);
  assert.equal(sonda.version, null);
});

test('binário que responde com erro não conta como disponível', async () => {
  const sonda = await adapterCom({
    comando: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
  }).verifyCli();

  assert.equal(sonda.available, false);
});

test('authenticated reflete a variável de credencial presente', async () => {
  const comChave = await adapterCom({ ambiente: { ANTHROPIC_API_KEY: 'sk-de-teste' } }).verifyCli();
  assert.equal(comChave.authenticated, true);

  const semChave = await adapterCom({ ambiente: {} }).verifyCli();
  assert.equal(semChave.authenticated, false);
});

test('authenticated também aceita a conta OAuth do arquivo de credencial', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credenciais = join(raiz, '.claude.json');

  try {
    writeFileSync(credenciais, JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' } }));
    const comConta = await adapterCom({ credenciais }).verifyCli();
    assert.equal(comConta.authenticated, true);

    writeFileSync(credenciais, JSON.stringify({ outraCoisa: true }));
    const semConta = await adapterCom({ credenciais }).verifyCli();
    assert.equal(semConta.authenticated, false);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});

test('arquivo de credencial corrompido não derruba a sonda', async () => {
  const raiz = mkdtempSync(join(tmpdir(), 'cartografo-cred-'));
  const credenciais = join(raiz, '.claude.json');

  try {
    writeFileSync(credenciais, '{ isto não é json');
    const sonda = await adapterCom({ credenciais }).verifyCli();

    assert.equal(sonda.available, true);
    assert.equal(sonda.authenticated, false);
  } finally {
    rmSync(raiz, { recursive: true, force: true });
  }
});
