#!/usr/bin/env node
/**
 * Comando único do control plane: `cartografo`.
 *
 * O executável é `.mjs` (e não `.ts`) para não depender de nenhuma flag do
 * Node: ele registra o loader do tsx em processo e só então importa
 * `src/cli/index.ts`. Em processo, e não via `spawn`, para que o processo que o
 * supervisor vê seja o mesmo que escuta a porta — sinal enviado ao comando
 * chega em quem precisa encerrar.
 *
 * Aqui só mora o despacho: o roteador devolve o código de saída e este arquivo
 * o registra em `process.exitCode` em vez de chamar `process.exit`. A diferença
 * importa — `up` retorna com o servidor no ar, e um `exit` mataria o control
 * plane no instante em que ele ficou pronto.
 *
 * Uso: `npm exec cartografo [subcomando]`, `node packages/core/bin/cartografo.mjs`.
 * Configuração: `CARTOGRAFO_DB_PATH`, `CARTOGRAFO_PORT`, `CARTOGRAFO_URL`.
 */

import { register } from 'tsx/esm/api';

register();

const { executarCli } = await import(new URL('../src/cli/index.ts', import.meta.url).href);

try {
  process.exitCode = await executarCli(process.argv.slice(2));
} catch (erro) {
  console.error('cartografo: falha ao executar o comando');
  console.error(erro);
  process.exitCode = 1;
}
