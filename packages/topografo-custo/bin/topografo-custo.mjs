#!/usr/bin/env node
/**
 * O comando da lente de custo: `topografo-custo`.
 *
 * Casca fina, no mesmo molde de `packages/runner/bin/cartografo-runner.mjs` e
 * `packages/tela/bin/tela.mjs`: o executável é `.mjs` (e não `.ts`) para não
 * depender de nenhuma flag do Node — ele registra o carregador tsx em processo e
 * só então importa `src/cli.ts`. Quem roda `npx topografo-custo` não precisa
 * saber que tsx existe, que é exatamente o que faltava enquanto o único caminho
 * era `node --import tsx src/cli.ts avaliar …`.
 *
 * O nome do comando é o que o próprio `USO` do pacote documenta desde a t180
 * (`src/cli.ts`): `topografo-custo avaliar …`. Batizá-lo de outra coisa aqui
 * seria uma segunda instância do desencontro que a t199 existe para fechar.
 *
 * Só o despacho mora aqui: `executarCli` devolve o código de saída e este
 * arquivo o registra em `process.exitCode` em vez de chamar `process.exit` — a
 * mesma escolha dos outros dois bins, para que a saída em voo termine de ser
 * escrita antes de o processo acabar.
 *
 * Uso: `npx topografo-custo avaliar --url <url> --execucao <id> [opções]`.
 * Configuração: `CARTOGRAFO_TOKEN` (credencial do control plane).
 */

import { register } from 'tsx/esm/api';

register();

const { executarCli } = await import(new URL('../src/cli.ts', import.meta.url).href);

try {
  process.exitCode = await executarCli(process.argv.slice(2));
} catch (erro) {
  console.error('topografo-custo: failed to run the command');
  console.error(erro);
  process.exitCode = 1;
}
