/**
 * Testes de aceite da fronteira da tela (t100, FR7 / D11).
 *
 * A tela é cliente comum da API pública: não declara o driver do SQLite, não
 * alcança `packages/core/src/db` e fala com o core só por HTTP. Os dois
 * primeiros pontos são verificados aqui pelo mesmo portão que roda no lint.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloTela from '../src/index.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const CAMINHO_PORTAO = path.join(RAIZ_REPO, 'scripts', 'check-single-writer.mjs');

/**
 * Lista escrita à mão de propósito: importar a constante do portão faria a tela
 * depender de um script do repo, que é justamente o tipo de acoplamento que
 * este teste existe para impedir.
 */
const DRIVERS_SQLITE = ['better-sqlite3', 'sqlite3', 'node:sqlite', 'libsql', '@libsql/client'];

const CAMPOS_DE_DEPENDENCIA = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('AT16 — packages/tela não declara nenhum driver de SQLite', () => {
  const manifesto = JSON.parse(
    readFileSync(path.join(RAIZ_PACOTE, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, string> | undefined>;

  for (const campo of CAMPOS_DE_DEPENDENCIA) {
    const declaradas = Object.keys(manifesto[campo] ?? {});
    for (const driver of DRIVERS_SQLITE) {
      assert.ok(
        !declaradas.includes(driver),
        `a tela não pode declarar "${driver}" em ${campo} (D1: só o core toca o banco)`,
      );
    }
  }
});

test('AT17 — varredura do portão sobre packages/tela não acusa nada', () => {
  assert.ok(existsSync(CAMINHO_PORTAO), 'artefato ainda não existe: scripts/check-single-writer.mjs');

  const resultado = spawnSync(process.execPath, [CAMINHO_PORTAO, RAIZ_PACOTE], {
    encoding: 'utf8',
  });
  assert.equal(
    resultado.status,
    0,
    `o portão reprovou a tela:\n${resultado.stdout ?? ''}${resultado.stderr ?? ''}`,
  );
});

test('AT18 — a tela conversa com o core só por HTTP, na rota pública /health', async () => {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'index.ts')),
    'artefato ainda não existe: packages/tela/src/index.ts',
  );
  const { consultarSaude } = (await import(
    new URL('../src/index.ts', import.meta.url).href
  )) as typeof ModuloTela;

  const chamadas: string[] = [];
  const buscarFalso: typeof fetch = async (entrada) => {
    chamadas.push(String(entrada));
    return new Response('{"status":"ok","db":"ok"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const saude = await consultarSaude('http://127.0.0.1:4317', buscarFalso);
  assert.deepEqual(saude, { status: 'ok', db: 'ok' });
  assert.deepEqual(chamadas, ['http://127.0.0.1:4317/health']);
});
