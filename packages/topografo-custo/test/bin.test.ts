/**
 * Teste de aceite do comando instalável `topografo-custo` (t199, FR3).
 *
 * Roda `bin/topografo-custo.mjs` como processo filho de verdade, no mesmo molde
 * de `packages/core/test/startup.test.ts`: o contrato de uma CLI É o processo —
 * código de saída, stdout e stderr —, e nada disso existe quando se chama
 * `executarCli` direto (o que `cli.test.ts` já faz, e cobre outra coisa).
 *
 * O que ele prova é a lacuna que a ficha fecha: até agora este pacote só rodava
 * como `node --import tsx src/cli.ts`, embora o próprio `USO` documentasse
 * `topografo-custo avaliar …` desde a t180. O bin registra o carregador tsx em
 * processo e importa `src/cli.ts` — quem roda o comando não precisa saber que
 * tsx existe.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** O executável sob teste. */
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'topografo-custo.mjs');

function rodar(...argumentos: string[]): { code: number | null; stdout: string; stderr: string } {
  assert.ok(existsSync(BIN_PATH), 'artefato ainda não existe: bin/topografo-custo.mjs');
  const fim = spawnSync(process.execPath, [BIN_PATH, ...argumentos], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: fim.status, stdout: fim.stdout ?? '', stderr: fim.stderr ?? '' };
}

test('AT — `topografo-custo --help` sai 0 e imprime o texto de uso', () => {
  const resultado = rodar('--help');

  assert.equal(resultado.code, 0, `stderr:\n${resultado.stderr}`);
  assert.match(resultado.stdout, /^usage: topografo-custo avaliar/m);
  assert.match(resultado.stdout, /--teto-tokens/);
  assert.equal(resultado.stderr, '', 'ajuda pedida é stdout, não erro');
});

test('AT — `topografo-custo` sem argumento nenhum sai 2', () => {
  const resultado = rodar();

  assert.equal(resultado.code, 2, `stdout:\n${resultado.stdout}\nstderr:\n${resultado.stderr}`);
  assert.match(resultado.stderr, /unknown subcommand/);
  // Linha de comando errada não vaza stack trace: sai a mensagem e o uso.
  assert.doesNotMatch(resultado.stderr, /\n\s+at\s+\S+/);
});

test('AT — o pacote declara o bin com o mesmo nome que o próprio USO documenta', () => {
  const manifesto = JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as { bin?: Record<string, string>; dependencies?: Record<string, string> };

  assert.deepEqual(manifesto.bin, { 'topografo-custo': './bin/topografo-custo.mjs' });
  // O bin importa `tsx/esm/api` na primeira linha: fora do monorepo, uma
  // devDependency não é instalada e o comando morre ali (t199, FR2).
  assert.ok(manifesto.dependencies?.tsx, 'tsx é dependência de runtime de quem publica um bin');
});
