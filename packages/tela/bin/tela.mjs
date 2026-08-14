#!/usr/bin/env node
/**
 * Comando da tela: `cartografo-tela`.
 *
 * Casca fina, no mesmo molde de `packages/core/bin/cartografo.mjs`: o
 * executável é `.mjs` (e não `.ts`) para não depender de flag nenhuma do Node —
 * ele registra o loader do tsx em processo e só então importa
 * `src/servidor.ts`. Em processo, e não via `spawn`, para que o processo que o
 * supervisor vê seja o mesmo que escuta a porta.
 *
 * Comando PRÓPRIO, e não subcomando de `cartografo`, porque a tela é outro
 * processo, em outra porta, sem nenhum privilégio sobre o control plane (D11):
 * dois binários é o que essa fronteira parece do lado de fora.
 *
 * Uso: `npx cartografo-tela [--url http://127.0.0.1:4317]`.
 * Configuração: `CARTOGRAFO_TELA_PORT` (porta da tela, default 4318),
 * `CARTOGRAFO_URL` (control plane, default `http://127.0.0.1:4317`).
 */

import { register } from 'tsx/esm/api';

register();

const { principal } = await import(new URL('../src/servidor.ts', import.meta.url).href);

try {
  await principal(process.argv.slice(2));
} catch (erro) {
  console.error('cartografo-tela: falha ao subir a tela');
  console.error(erro instanceof Error ? erro.message : erro);
  process.exitCode = 1;
}
