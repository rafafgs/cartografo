/**
 * Testes de aceite do runner de migração (t100, FR3/FR5).
 *
 * Cobrem ordem numérica de aplicação, registro em `schema_migrations`,
 * idempotência da segunda partida e atomicidade (migração que quebra no meio
 * não deixa resíduo).
 *
 * Convenção do repo (mesma de `tests/schema-grafo.test.mjs`): o módulo sob
 * teste é importado sob demanda, depois de um `existsSync` explícito, para que
 * o vermelho inicial diga qual artefato falta em vez de estourar um
 * ERR_MODULE_NOT_FOUND cru.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const DIR_MIGRACOES_REAIS = path.join(RAIZ_PACOTE, 'migrations');

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;

async function carregarConnection(): Promise<typeof ModuloConnection> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'db', 'connection.ts');
  assert.ok(existsSync(caminho), 'artefato ainda não existe: packages/core/src/db/connection.ts');
  cacheConnection ??= (await import(
    new URL('../src/db/connection.ts', import.meta.url).href
  )) as typeof ModuloConnection;
  return cacheConnection;
}

async function carregarMigrate(): Promise<typeof ModuloMigrate> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'db', 'migrate.ts');
  assert.ok(existsSync(caminho), 'artefato ainda não existe: packages/core/src/db/migrate.ts');
  cacheMigrate ??= (await import(
    new URL('../src/db/migrate.ts', import.meta.url).href
  )) as typeof ModuloMigrate;
  return cacheMigrate;
}

/** Diretório temporário isolado, removido no fim do teste. */
function areaTemporaria(t: { after: (fn: () => void) => void }): string {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function escreverMigracao(dir: string, arquivo: string, sql: string): void {
  writeFileSync(path.join(dir, arquivo), sql, 'utf8');
}

const SQL_CRIA_TABELA_DE_CONTROLE =
  'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);';

test('AT1 — migrações rodam em ordem numérica (não alfabética) e ficam registradas', async (t) => {
  const { abrirBanco } = await carregarConnection();
  const { listarMigracoes, migrar } = await carregarMigrate();

  const base = areaTemporaria(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);

  // Escritas fora de ordem no disco de propósito. Além de `0002` vir antes de
  // `0001`, entra um `10_` que em ordem ALFABÉTICA cai antes do `2_` — só
  // ordenação pelo número do prefixo devolve a sequência correta.
  escreverMigracao(dir, '0002_segunda.sql', 'CREATE TABLE segunda (id TEXT PRIMARY KEY);');
  escreverMigracao(dir, '10_decima.sql', 'CREATE TABLE decima (id TEXT PRIMARY KEY);');
  escreverMigracao(dir, '0001_init.sql', SQL_CRIA_TABELA_DE_CONTROLE);

  const esperada = ['0001_init', '0002_segunda', '10_decima'];
  assert.deepEqual(
    listarMigracoes(dir).map((m) => m.id),
    esperada,
    'listarMigracoes precisa ordenar pelo número do prefixo',
  );

  const db = abrirBanco(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  assert.deepEqual(migrar(db, dir), esperada, 'migrar devolve os ids aplicados, em ordem');

  const registradas = db
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string; applied_at: string }>;
  assert.deepEqual(
    registradas.map((linha) => linha.id),
    esperada,
    'toda migração aplicada precisa ficar registrada em schema_migrations',
  );
  for (const linha of registradas) {
    assert.match(
      linha.applied_at,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      `applied_at de "${linha.id}" precisa ser um instante ISO-8601`,
    );
  }

  const tabelas = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const nomes = tabelas.map((linha) => linha.name);
  for (const esperado of ['decima', 'schema_migrations', 'segunda']) {
    assert.ok(nomes.includes(esperado), `a tabela "${esperado}" precisa ter sido criada`);
  }
});

test('AT2 — segunda partida sobre banco já migrado não reaplica nada', async (t) => {
  const { abrirBanco } = await carregarConnection();
  const { migrar } = await carregarMigrate();

  const base = areaTemporaria(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  escreverMigracao(dir, '0001_init.sql', SQL_CRIA_TABELA_DE_CONTROLE);
  escreverMigracao(dir, '0002_segunda.sql', 'CREATE TABLE segunda (id TEXT PRIMARY KEY);');

  const caminhoBanco = path.join(base, 'cartografo.db');
  const primeiro = abrirBanco(caminhoBanco);
  assert.deepEqual(migrar(primeiro, dir), ['0001_init', '0002_segunda']);
  const depoisDaPrimeira = primeiro
    .prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id')
    .all();
  primeiro.close();

  // Conexão nova, banco já migrado: é a partida idempotente da FR3.
  const segundo = abrirBanco(caminhoBanco);
  t.after(() => segundo.close());

  assert.deepEqual(migrar(segundo, dir), [], 'nenhuma migração pode ser reaplicada');
  assert.deepEqual(
    segundo.prepare('SELECT id, applied_at FROM schema_migrations ORDER BY id').all(),
    depoisDaPrimeira,
    'nem o applied_at das migrações antigas pode mudar na segunda partida',
  );

  // Uma terceira chamada na mesma conexão também é ruído zero.
  assert.deepEqual(migrar(segundo, dir), []);
});

test('AT3 — migração que quebra no meio não deixa resíduo (transação por migração)', async (t) => {
  const { abrirBanco } = await carregarConnection();
  const { migrar } = await carregarMigrate();

  const base = areaTemporaria(t);
  const dir = path.join(base, 'migrations');
  mkdirSync(dir);
  escreverMigracao(dir, '0001_init.sql', SQL_CRIA_TABELA_DE_CONTROLE);
  escreverMigracao(
    dir,
    '0002_quebrada.sql',
    'CREATE TABLE meio_do_caminho (id TEXT PRIMARY KEY);\nISTO NAO E SQL VALIDO;\n',
  );

  const db = abrirBanco(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  assert.throws(() => migrar(db, dir), /0002_quebrada/, 'o erro precisa nomear a migração culpada');

  const aplicadas = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{
    id: string;
  }>;
  assert.deepEqual(
    aplicadas.map((linha) => linha.id),
    ['0001_init'],
    'a migração que falhou não pode ficar registrada',
  );

  const residuo = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'meio_do_caminho'")
    .get();
  assert.equal(residuo, undefined, 'o que a migração quebrada criou antes de falhar precisa sumir');
});

test('AT4 — arquivo .sql sem prefixo numérico e número duplicado falham alto', async (t) => {
  const { listarMigracoes } = await carregarMigrate();

  const base = areaTemporaria(t);

  const semPrefixo = path.join(base, 'sem-prefixo');
  mkdirSync(semPrefixo);
  escreverMigracao(semPrefixo, 'init.sql', SQL_CRIA_TABELA_DE_CONTROLE);
  assert.throws(() => listarMigracoes(semPrefixo), /init\.sql/);

  const duplicado = path.join(base, 'duplicado');
  mkdirSync(duplicado);
  escreverMigracao(duplicado, '0001_init.sql', SQL_CRIA_TABELA_DE_CONTROLE);
  escreverMigracao(duplicado, '0001_outra.sql', 'CREATE TABLE outra (id TEXT PRIMARY KEY);');
  assert.throws(() => listarMigracoes(duplicado), /0001/);
});

test('AT5 — 0001_init.sql do pacote cria schema_migrations com id e applied_at', async (t) => {
  const { abrirBanco } = await carregarConnection();
  const { migrar } = await carregarMigrate();

  const caminhoInit = path.join(DIR_MIGRACOES_REAIS, '0001_init.sql');
  assert.ok(existsSync(caminhoInit), 'artefato ainda não existe: packages/core/migrations/0001_init.sql');

  const sql = readFileSync(caminhoInit, 'utf8');
  assert.doesNotMatch(
    sql,
    /\b(BEGIN|COMMIT|ROLLBACK)\b/i,
    'a migração não abre transação própria: quem transaciona é o runner',
  );

  const base = areaTemporaria(t);
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  t.after(() => db.close());

  const aplicadas = migrar(db, DIR_MIGRACOES_REAIS);
  assert.ok(aplicadas.includes('0001_init'), 'a primeira migração do pacote precisa ser 0001_init');

  const colunas = db.prepare('PRAGMA table_info(schema_migrations)').all() as Array<{
    name: string;
    type: string;
    pk: number;
    notnull: number;
  }>;
  const porNome = new Map(colunas.map((coluna) => [coluna.name, coluna]));

  const id = porNome.get('id');
  assert.ok(id, 'schema_migrations precisa ter a coluna id');
  assert.equal(id.type.toUpperCase(), 'TEXT');
  assert.equal(id.pk, 1, 'id é a chave primária');

  const appliedAt = porNome.get('applied_at');
  assert.ok(appliedAt, 'schema_migrations precisa ter a coluna applied_at');
  assert.equal(appliedAt.type.toUpperCase(), 'TEXT');
  assert.equal(appliedAt.notnull, 1, 'applied_at é NOT NULL');
});
