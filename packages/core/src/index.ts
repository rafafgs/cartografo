/**
 * Partida do control plane, em um comando só.
 *
 * A ordem é fixa e não tem passo manual: abrir/criar o banco → aplicar as
 * migrações pendentes → subir o HTTP → imprimir a linha de prontidão. É o
 * inegociável de qualidade registrado em `notas/2026-08-14-extensao-e-qualidade.md`
 * ("partida em um comando", "migrações automáticas").
 */

import path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { abrirBanco, aplicarPragmas, caminhoDoBanco, type BancoDeDados } from './db/connection.ts';
import { migrar } from './db/migrate.ts';
import { criarApp } from './server.ts';

/** Porta default do control plane. */
export const PORTA_PADRAO = 4317;

/** Variável de ambiente que sobrescreve a porta default. */
export const ENV_PORTA = 'CARTOGRAFO_PORT';

/**
 * Endereço de escuta. Fixo em loopback: o control plane é dono do banco (D1) e
 * não tem autenticação nesta fase — expor a interface externa é decisão da
 * ticket que trouxer autorização, não desta.
 */
export const HOST_PADRAO = '127.0.0.1';

/** Diretório das migrações do pacote. */
export const DIR_MIGRACOES = path.resolve(import.meta.dirname, '..', 'migrations');

/** Nome do evento da linha de prontidão impressa em stdout. */
export const EVENTO_PRONTO = 'cartografo.pronto';

/** Control plane no ar. */
export interface ControlPlane {
  app: FastifyInstance;
  db: BancoDeDados;
  /** Caminho absoluto do arquivo do banco em uso. */
  caminhoBanco: string;
  /** Ids das migrações aplicadas NESTA partida (vazio quando já estava em dia). */
  migracoesAplicadas: string[];
  /** URL base do servidor. */
  url: string;
  /** Fecha o HTTP e o banco, nesta ordem. */
  encerrar: () => Promise<void>;
}

/**
 * Resolve a porta de escuta.
 *
 * @param env Ambiente de onde ler `CARTOGRAFO_PORT`.
 * @returns Porta válida.
 */
export function portaDoServidor(env: NodeJS.ProcessEnv = process.env): number {
  const configurada = env[ENV_PORTA]?.trim();
  if (configurada === undefined || configurada === '') return PORTA_PADRAO;

  const porta = Number(configurada);
  if (!Number.isInteger(porta) || porta < 0 || porta > 65535) {
    throw new Error(`${ENV_PORTA} inválida: "${configurada}" (esperado um inteiro de 0 a 65535)`);
  }
  return porta;
}

/**
 * Sobe o control plane inteiro.
 *
 * @param env Ambiente de onde ler a configuração.
 * @returns O control plane no ar, com o que é preciso para encerrá-lo.
 */
export async function iniciar(env: NodeJS.ProcessEnv = process.env): Promise<ControlPlane> {
  const caminhoBanco = caminhoDoBanco(env);
  const db = abrirBanco(caminhoBanco);

  let app: FastifyInstance;
  let migracoesAplicadas: string[];
  try {
    aplicarPragmas(db);
    migracoesAplicadas = migrar(db, DIR_MIGRACOES);
    app = criarApp({ db });
    await app.listen({ port: portaDoServidor(env), host: HOST_PADRAO });
  } catch (erro) {
    db.close();
    throw erro;
  }

  const endereco = app.server.address();
  const porta = endereco !== null && typeof endereco !== 'string' ? endereco.port : portaDoServidor(env);

  return {
    app,
    db,
    caminhoBanco,
    migracoesAplicadas,
    url: `http://${HOST_PADRAO}:${porta}`,
    encerrar: async () => {
      await app.close();
      db.close();
    },
  };
}

/**
 * Ponto de entrada do comando `cartografo`.
 *
 * Imprime uma linha JSON de prontidão em stdout — é o que um supervisor (ou o
 * teste de aceite da partida) usa para saber que o servidor está no ar e
 * quantas migrações esta partida aplicou.
 */
export async function principal(): Promise<void> {
  const controlPlane = await iniciar();

  process.stdout.write(
    `${JSON.stringify({
      evento: EVENTO_PRONTO,
      banco: controlPlane.caminhoBanco,
      migracoes_aplicadas: controlPlane.migracoesAplicadas.length,
      url: controlPlane.url,
    })}\n`,
  );

  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      void controlPlane
        .encerrar()
        .catch(() => undefined)
        .then(() => process.exit(0));
    });
  }
}
