/**
 * Testes de aceite do pareamento de runner (t103, FR2/FR4).
 *
 * Registrar runner é a única coisa que um runner faz antes de disputar
 * trabalho, e precisa ser idempotente por construção: um runner que reinicia
 * (crash, deploy, máquina que voltou) se registra de novo com o MESMO id e não
 * pode receber erro nem duplicar linha. É o mesmo espírito de "registros
 * idempotentes na API" da D5.
 *
 * Autenticação do pareamento é t124 (fora da PoC, D16): aqui o id é declarado
 * pelo próprio runner.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloRunners from '../src/repositorios/runners.ts';
import type * as ModuloServer from '../src/server.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');

interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

interface LinhaRunner {
  id: string;
  nome: string | null;
  registrado_em: string;
}

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;
let cacheServer: typeof ModuloServer | null = null;
let cacheRunners: typeof ModuloRunners | null = null;

async function carregarConnection(): Promise<typeof ModuloConnection> {
  cacheConnection ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ModuloConnection;
  return cacheConnection;
}

async function carregarMigrate(): Promise<typeof ModuloMigrate> {
  cacheMigrate ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof ModuloMigrate;
  return cacheMigrate;
}

async function carregarServer(): Promise<typeof ModuloServer> {
  cacheServer ??= (await import(
    new URL('../src/server.ts', import.meta.url).href
  )) as typeof ModuloServer;
  return cacheServer;
}

async function carregarRunners(): Promise<typeof ModuloRunners> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'repositorios', 'runners.ts')),
    'artefato ainda não existe: packages/core/src/repositorios/runners.ts',
  );
  cacheRunners ??= (await import(
    new URL('../src/repositorios/runners.ts', import.meta.url).href
  )) as typeof ModuloRunners;
  return cacheRunners;
}

/** Control plane efêmero: banco em diretório temporário, porta 0. */
async function subir(t: ContextoDeTeste): Promise<{
  endereco: string;
  db: ModuloConnection.BancoDeDados;
}> {
  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();
  const { criarApp } = await carregarServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-runners-'));
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return { endereco, db };
}

test('AT1 — POST /v1/runners cria o registro e devolve 201', async (t) => {
  const { endereco } = await subir(t);

  const resposta = await fetch(`${endereco}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'laptop do fundador' }),
  });

  assert.equal(resposta.status, 201);
  const corpo = (await resposta.json()) as { runner: LinhaRunner };
  assert.equal(corpo.runner.id, 'runner-a');
  assert.equal(corpo.runner.nome, 'laptop do fundador');
  assert.equal(typeof corpo.runner.registrado_em, 'string');
  assert.ok(
    !Number.isNaN(Date.parse(corpo.runner.registrado_em)),
    'registrado_em precisa ser um instante ISO 8601',
  );
});

test('AT2 — POST /v1/runners com o mesmo id é idempotente: 200 e uma linha só', async (t) => {
  const { endereco, db } = await subir(t);
  const { listarRunners } = await carregarRunners();

  const primeira = await fetch(`${endereco}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'nome antigo' }),
  });
  assert.equal(primeira.status, 201);

  const segunda = await fetch(`${endereco}/v1/runners`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'runner-a', nome: 'nome novo' }),
  });
  assert.equal(
    segunda.status,
    200,
    'registrar de novo o mesmo runner é idempotente, não conflito (D5)',
  );

  const corpo = (await segunda.json()) as { runner: LinhaRunner };
  assert.equal(corpo.runner.id, 'runner-a');
  assert.equal(corpo.runner.nome, 'nome novo', 'a re-inscrição atualiza o nome enviado');

  const registrados = listarRunners(db);
  assert.equal(registrados.length, 1, 'o segundo registro não pode duplicar a linha');
  assert.equal(registrados[0].id, 'runner-a');
});
