/**
 * Testes de aceite da rota de saúde (t100, FR4/FR10).
 *
 * `GET /health` é rota de infraestrutura: fica FORA do prefixo `/v1`, e o campo
 * `db` é o resultado de um `SELECT 1` de verdade — não uma constante. O segundo
 * teste é o que prova isso: sobe o app apontado para um arquivo que não é um
 * banco SQLite e exige que a resposta deixe de dizer `db: "ok"`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloServer from '../src/server.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;
let cacheServer: typeof ModuloServer | null = null;

async function carregarConnection(): Promise<typeof ModuloConnection> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'db', 'connection.ts')),
    'artefato ainda não existe: packages/core/src/db/connection.ts',
  );
  cacheConnection ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ModuloConnection;
  return cacheConnection;
}

async function carregarMigrate(): Promise<typeof ModuloMigrate> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'db', 'migrate.ts')),
    'artefato ainda não existe: packages/core/src/db/migrate.ts',
  );
  cacheMigrate ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof ModuloMigrate;
  return cacheMigrate;
}

async function carregarServer(): Promise<typeof ModuloServer> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'server.ts')),
    'artefato ainda não existe: packages/core/src/server.ts',
  );
  cacheServer ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ModuloServer;
  return cacheServer;
}

function areaTemporaria(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

test('AT6 — GET /health responde 200, JSON, corpo exatamente {"status":"ok","db":"ok"}', async (t) => {
  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();
  const { criarApp } = await carregarServer();

  const base = areaTemporaria(t);
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const resposta = await fetch(`${endereco}/health`);
  assert.equal(resposta.status, 200);
  assert.match(resposta.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(await resposta.text(), '{"status":"ok","db":"ok"}');
});

test('AT7 — com o banco corrompido, /health não diz db:"ok"', async (t) => {
  const { abrirBanco } = await carregarConnection();
  const { criarApp } = await carregarServer();

  const base = areaTemporaria(t);
  const caminho = path.join(base, 'corrompido.db');
  // Arquivo existe, tem tamanho e NÃO é um banco: o open passa (o SQLite lê o
  // cabeçalho só na primeira consulta), então quem estoura é o `SELECT 1` da
  // checagem — exatamente o que o teste quer provar.
  writeFileSync(caminho, 'isto nao e um banco sqlite, so lixo textual\n'.repeat(64), 'utf8');

  const db = abrirBanco(caminho);
  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const resposta = await fetch(`${endereco}/health`);
  const corpo = (await resposta.json()) as { status: string; db: string };
  assert.notEqual(corpo.db, 'ok', 'o campo db precisa refletir a checagem real, não uma constante');
  assert.notEqual(corpo.status, 'ok');
  assert.equal(resposta.status, 503);
});

test('AT8 — /health fica fora do prefixo /v1, que é onde nascem as rotas de negócio', async (t) => {
  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();
  const { criarApp, PREFIXO_API } = await carregarServer();

  assert.equal(PREFIXO_API, '/v1');

  const base = areaTemporaria(t);
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
  });

  assert.equal((await fetch(`${endereco}/health`)).status, 200);
  assert.equal(
    (await fetch(`${endereco}${PREFIXO_API}/health`)).status,
    404,
    'health é probe de infraestrutura: não pode ser versionada junto com o negócio',
  );
});
