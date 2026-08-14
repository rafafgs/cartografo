/**
 * Apoio dos testes de aceite da CLI (t108).
 *
 * Não é arquivo de teste (`test/*.test.ts` é o glob do runner): é só o que os
 * três arquivos `cli-*.test.ts` compartilham para rodar o comando como processo
 * filho de verdade. Processo filho e não chamada em processo porque o contrato
 * da CLI É o processo: código de saída, stdout e stderr — nada disso existe
 * quando se chama a função direto.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as esperar } from 'node:timers/promises';

/** Raiz do pacote `cartografo` (packages/core). */
export const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');

/** Raiz do repositório — de onde saem os fixtures de grafo e o bundle de fábrica. */
export const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');

/** O executável sob teste. */
export const CAMINHO_BIN = path.join(RAIZ_PACOTE, 'bin', 'cartografo.mjs');

/** Bundle de fábrica 1 (D14), o insumo do caminho de 3 comandos do README. */
export const BUNDLE_FABRICA = path.join(RAIZ_REPO, 'grafos-de-fabrica', 'desenvolvimento-de-software');

/** Contexto de teste na parte que este apoio usa. */
export interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

/** Saída completa de uma execução do comando. */
export interface ResultadoDoComando {
  codigo: number | null;
  sinal: NodeJS.Signals | null;
  saida: string;
  erros: string;
}

/** Linha de prontidão que `up` imprime em stdout. */
export interface LinhaDeProntidao {
  evento: string;
  banco: string;
  migracoes_aplicadas: number;
  url: string;
}

/** Control plane no ar, do ponto de vista de quem só fala HTTP com ele. */
export interface ControlPlaneNoAr {
  url: string;
  porta: number;
  prontidao: LinhaDeProntidao;
  encerrar: () => Promise<void>;
}

/** `stdio: ['ignore', 'pipe', 'pipe']` — sem stdin, com stdout/stderr lidos. */
type FilhoDoComando = ChildProcessByStdio<null, Readable, Readable>;

/** Reserva uma porta livre pedindo ao SO a porta 0 e devolvendo o número. */
export async function portaLivre(): Promise<number> {
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

/** Diretório temporário que some no fim do teste. */
export function areaTemporaria(t: ContextoDeTeste, rotulo = 'cartografo-t108-'): string {
  const base = mkdtempSync(path.join(tmpdir(), rotulo));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

/**
 * Prazo default de uma execução de subcomando.
 *
 * Existe porque a falha característica desta CLI é justamente NÃO terminar: um
 * subcomando que caia no caminho da partida fica servindo HTTP para sempre, e
 * sem prazo o teste vermelho travaria a suíte inteira em vez de falhar. Passado
 * o prazo, o filho morre e o resultado volta com `codigo: null`.
 */
export const PRAZO_DO_COMANDO_MS = 30_000;

/**
 * Roda o comando e espera ele terminar.
 *
 * O banco default aponta para uma área temporária própria: se um subcomando
 * subir servidor por engano, ele não escreve `.cartografo/` na raiz do repo.
 *
 * @param argumentos Argumentos depois do nome do comando.
 * @param opcoes Diretório de trabalho, ambiente extra e prazo.
 * @returns Código de saída, stdout e stderr.
 */
export async function rodarCli(
  argumentos: string[],
  opcoes: { cwd?: string; env?: NodeJS.ProcessEnv; prazoMs?: number } = {},
): Promise<ResultadoDoComando> {
  const filho = spawn(process.execPath, [CAMINHO_BIN, ...argumentos], {
    cwd: opcoes.cwd ?? RAIZ_REPO,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-t108-cli-')), 'cartografo.db'),
      ...opcoes.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as FilhoDoComando;

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

  return await new Promise((resolve, reject) => {
    const prazo = setTimeout(() => {
      erros += `\n[apoio] o comando não terminou em ${opcoes.prazoMs ?? PRAZO_DO_COMANDO_MS}ms e foi morto\n`;
      filho.kill('SIGKILL');
    }, opcoes.prazoMs ?? PRAZO_DO_COMANDO_MS);
    prazo.unref();

    filho.on('error', (erro) => {
      clearTimeout(prazo);
      reject(erro);
    });
    filho.on('close', (codigo, sinal) => {
      clearTimeout(prazo);
      resolve({ codigo, sinal, saida, erros });
    });
  });
}

/**
 * Sobe um control plane pelo próprio comando e espera a linha de prontidão.
 *
 * @param t Contexto do teste, para encerrar o processo no fim.
 * @param opcoes Banco e argumentos (`[]` = partida implícita, `['up']` = explícita).
 * @returns O control plane no ar.
 */
export async function subirControlPlane(
  t: ContextoDeTeste,
  opcoes: { caminhoBanco: string; argumentos?: string[]; cwd?: string } ,
): Promise<ControlPlaneNoAr> {
  const porta = await portaLivre();
  const filho = spawn(process.execPath, [CAMINHO_BIN, ...(opcoes.argumentos ?? [])], {
    cwd: opcoes.cwd ?? RAIZ_REPO,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: opcoes.caminhoBanco,
      CARTOGRAFO_PORT: String(porta),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as FilhoDoComando;

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
  t.after(encerrar);

  const prazo = Date.now() + 60_000;
  while (Date.now() < prazo) {
    if (filho.exitCode !== null) {
      throw new Error(
        `o control plane morreu antes de ficar pronto (código ${filho.exitCode})\nstdout:\n${saida}\nstderr:\n${erros}`,
      );
    }
    const linha = saida
      .split('\n')
      .map((texto) => texto.trim())
      .find((texto) => texto.startsWith('{') && texto.includes('cartografo.pronto'));
    if (linha !== undefined) {
      const prontidao = JSON.parse(linha) as LinhaDeProntidao;
      return { url: prontidao.url, porta, prontidao, encerrar };
    }
    await esperar(100);
  }

  await encerrar();
  throw new Error(`o control plane não ficou pronto em 60s\nstdout:\n${saida}\nstderr:\n${erros}`);
}

/** Extrai o primeiro `sha256:<64 hex>` que aparecer no texto. */
export function primeiroHash(texto: string): string {
  const casamento = /sha256:[0-9a-f]{64}/.exec(texto);
  if (casamento === null) throw new Error(`nenhum hash de versão na saída:\n${texto}`);
  return casamento[0];
}

/** O texto tem cara de stack trace vazado? */
export function pareceStackTrace(texto: string): boolean {
  return /\n\s+at\s+\S+/.test(texto) || texto.includes('TypeError:');
}
