/**
 * Testes de aceite da fronteira do runner (t103, FR12 / D1).
 *
 * "Runner só fala HTTP com o server; zero acesso ao arquivo do banco" é
 * critério de aceite do ticket, e a D1 é a decisão por trás: só o control plane
 * escreve no SQLite. Um runner que abrisse o arquivo do banco quebraria a
 * garantia de escritor único no exato cenário em que ela mais importa — vários
 * runners distribuídos disputando o mesmo trabalho.
 *
 * Mesmo par de asserções de `packages/tela/test/no-privileged-access.test.ts`,
 * pelo mesmo portão (`scripts/check-single-writer.mjs`).
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
 * Lista escrita à mão de propósito, como na tela: importar a constante do portão
 * faria o runner depender de um script do repo, que é justamente o tipo de
 * acoplamento que este teste existe para impedir.
 */
const DRIVERS_SQLITE = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const CAMPOS_DE_DEPENDENCIA = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT18 — packages/runner não declara nenhum driver de SQLite', () => {
  const manifesto = JSON.parse(
    readFileSync(path.join(RAIZ_PACOTE, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const campo of CAMPOS_DE_DEPENDENCIA) {
    const declaradas = Object.keys(manifesto[campo] ?? {});
    for (const driver of DRIVERS_SQLITE) {
      assert.ok(
        !declaradas.includes(driver),
        `o runner não pode declarar "${driver}" em ${campo} (D1: só o core toca o banco)`,
      );
    }
  }
});

test('AT19 — varredura do portão sobre packages/runner não acusa nada', () => {
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
    `o portão reprovou o runner:\n${resultado.stdout ?? ''}${resultado.stderr ?? ''}`,
  );
});
