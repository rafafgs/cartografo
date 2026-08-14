#!/usr/bin/env node
/**
 * Comando único do control plane: `cartografo`.
 *
 * O executável é `.mjs` (e não `.ts`) para não depender de nenhuma flag do
 * Node: ele registra o loader do tsx em processo e só então importa
 * `src/index.ts`. Em processo, e não via `spawn`, para que o processo que o
 * supervisor vê seja o mesmo que escuta a porta — sinal enviado ao comando
 * chega em quem precisa encerrar.
 *
 * Uso: `npm exec cartografo`, `node packages/core/bin/cartografo.mjs`.
 * Configuração: `CARTOGRAFO_DB_PATH`, `CARTOGRAFO_PORT`.
 */

import { register } from 'tsx/esm/api';

register();

const { principal } = await import(new URL('../src/index.ts', import.meta.url).href);

try {
  await principal();
} catch (erro) {
  console.error('cartografo: falha na partida');
  console.error(erro);
  process.exitCode = 1;
}
