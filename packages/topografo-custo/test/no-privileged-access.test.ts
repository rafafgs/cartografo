/**
 * Testes de aceite da fronteira do topógrafo de custo (t114, AT10/AT11 — D1/D11).
 *
 * Mesmo padrão de `packages/tela/test/no-privileged-access.test.ts`: o topógrafo
 * é cliente comum da API pública. Não declara driver de SQLite, não alcança
 * `packages/core/src/db` e fala com o control plane só por HTTP.
 *
 * Aqui isso vale duas vezes. Além da D1, é a prova mecânica do critério da
 * ficha: se a lente de custo precisasse tocar o core para existir, "topógrafo é
 * ponto de extensão" seria afirmação sem lastro.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const CAMINHO_PORTAO = path.join(RAIZ_REPO, 'scripts', 'check-single-writer.mjs');

/**
 * Lista escrita à mão de propósito: importar a constante do portão faria o
 * pacote depender de um script do repo, que é justamente o tipo de acoplamento
 * que este teste existe para impedir (mesma nota de `packages/tela`).
 */
const DRIVERS_SQLITE = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const CAMPOS_DE_DEPENDENCIA = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT10 — packages/topografo-custo não declara nenhum driver de SQLite', () => {
  const manifesto = JSON.parse(
    readFileSync(path.join(RAIZ_PACOTE, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const campo of CAMPOS_DE_DEPENDENCIA) {
    const declaradas = Object.keys(manifesto[campo] ?? {});
    for (const driver of DRIVERS_SQLITE) {
      assert.ok(
        !declaradas.includes(driver),
        `o topógrafo não pode declarar "${driver}" em ${campo} (D1: só o core toca o banco)`,
      );
    }
    assert.ok(
      !declaradas.includes('cartografo') && !declaradas.includes('@cartografo/runner'),
      `o topógrafo não depende do core nem do runner em ${campo}: a única superfície é a API pública`,
    );
  }
});

test('AT11 — varredura do portão sobre packages/topografo-custo não acusa nada', () => {
  assert.ok(
    existsSync(CAMINHO_PORTAO),
    'artefato ainda não existe: scripts/check-single-writer.mjs',
  );

  const resultado = spawnSync(process.execPath, [CAMINHO_PORTAO, RAIZ_PACOTE], {
    encoding: 'utf8',
  });
  assert.equal(
    resultado.status,
    0,
    `o portão reprovou o topógrafo:\n${resultado.stdout ?? ''}${resultado.stderr ?? ''}`,
  );
});
