/**
 * Teste de aceite da partida em um comando (t100, FR2/FR3).
 *
 * Roda `packages/core/bin/cartografo.mjs` como processo filho de verdade, em
 * diretório temporário sem banco: é o único jeito de provar que o comando
 * único cria o arquivo, aplica as migrações e sobe o HTTP sem passo manual de
 * setup. A segunda partida contra o mesmo banco prova a idempotência.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import type { Readable } from 'node:stream';
import test from 'node:test';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const CAMINHO_BIN = path.join(RAIZ_PACOTE, 'bin', 'cartografo.mjs');

/** Linha de prontidão que o comando imprime em stdout quando o server sobe. */
interface LinhaDeProntidao {
  evento: string;
  banco: string;
  migracoes_aplicadas: number;
  url: string;
}

/** `stdio: ['ignore', 'pipe', 'pipe']` — sem stdin, com stdout/stderr lidos. */
type FilhoDoComando = ChildProcessByStdio<null, Readable, Readable>;

interface Partida {
  filho: FilhoDoComando;
  prontidao: LinhaDeProntidao;
  encerrar: () => Promise<void>;
}

/** Reserva uma porta livre pedindo ao SO a porta 0 e devolvendo o número. */
async function portaLivre(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const servidor = createServer();
    servidor.on('error', reject);
    servidor.listen(0, '127.0.0.1', () => {
      const endereco = servidor.address();
      if (endereco === null || typeof endereco === 'string') {
        servidor.close();
        reject(new Error('não deu para reservar uma porta livre'));
        return;
      }
      const { port } = endereco;
      servidor.close(() => resolve(port));
    });
  });
}

/** Sobe o comando e resolve quando a linha de prontidão sai em stdout. */
async function partir(opcoes: {
  cwd: string;
  caminhoBanco: string;
  porta: number;
}): Promise<Partida> {
  const filho = spawn(process.execPath, [CAMINHO_BIN], {
    cwd: opcoes.cwd,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: opcoes.caminhoBanco,
      CARTOGRAFO_PORT: String(opcoes.porta),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  let erros = '';
  filho.stdout.setEncoding('utf8');
  filho.stderr.setEncoding('utf8');
  filho.stdout.on('data', (pedaco: string) => {
    saida += pedaco;
  });
  filho.stderr.on('data', (pedaco: string) => {
    erros += pedaco;
  });

  const encerrar = async (): Promise<void> => {
    if (filho.exitCode !== null || filho.signalCode !== null) return;
    filho.kill('SIGTERM');
    for (let tentativa = 0; tentativa < 100; tentativa += 1) {
      if (filho.exitCode !== null || filho.signalCode !== null) return;
      await esperar(100);
    }
    filho.kill('SIGKILL');
  };

  const prazo = Date.now() + 60_000;
  while (Date.now() < prazo) {
    if (filho.exitCode !== null) {
      throw new Error(
        `o comando morreu antes de ficar pronto (código ${filho.exitCode})\nstdout:\n${saida}\nstderr:\n${erros}`,
      );
    }
    const linha = saida
      .split('\n')
      .map((texto) => texto.trim())
      .find((texto) => texto.startsWith('{') && texto.includes('cartografo.pronto'));
    if (linha !== undefined) {
      return { filho, prontidao: JSON.parse(linha) as LinhaDeProntidao, encerrar };
    }
    await esperar(100);
  }

  await encerrar();
  throw new Error(`o comando não ficou pronto em 60s\nstdout:\n${saida}\nstderr:\n${erros}`);
}

test(
  'AT9 — partida em um comando cria banco, migra e responde /health; a segunda partida não remigra',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(existsSync(CAMINHO_BIN), 'artefato ainda não existe: packages/core/bin/cartografo.mjs');

    const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-partida-'));
    t.after(() => rmSync(base, { recursive: true, force: true }));

    // Subdiretório que NÃO existe: prova que o comando cria o caminho do banco.
    const caminhoBanco = path.join(base, 'dados', 'cartografo.db');
    assert.equal(existsSync(path.dirname(caminhoBanco)), false);

    const porta = await portaLivre();

    const primeira = await partir({ cwd: base, caminhoBanco, porta });
    try {
      assert.equal(primeira.prontidao.evento, 'cartografo.pronto');
      assert.equal(primeira.prontidao.banco, caminhoBanco);
      assert.ok(
        primeira.prontidao.migracoes_aplicadas >= 1,
        'a primeira partida precisa aplicar ao menos a migração inicial',
      );
      assert.ok(existsSync(caminhoBanco), 'o arquivo do banco precisa existir no caminho configurado');

      const resposta = await fetch(`http://127.0.0.1:${porta}/health`);
      assert.equal(resposta.status, 200);
      assert.deepEqual(await resposta.json(), { status: 'ok', db: 'ok' });
    } finally {
      await primeira.encerrar();
    }

    // Mesma porta, mesmo banco: só volta a subir se a primeira encerrou de fato.
    const segunda = await partir({ cwd: base, caminhoBanco, porta });
    try {
      assert.equal(
        segunda.prontidao.migracoes_aplicadas,
        0,
        'partida idempotente: banco já migrado não reaplica migração nenhuma',
      );
      const resposta = await fetch(`http://127.0.0.1:${porta}/health`);
      assert.equal(resposta.status, 200);
      assert.deepEqual(await resposta.json(), { status: 'ok', db: 'ok' });
    } finally {
      await segunda.encerrar();
    }
  },
);
