/**
 * Testes de aceite das rotas de grafo (t101, FR5/FR6).
 *
 * O teste central é o AT6: o `grafo.json` do bundle de fábrica 1 (t105) entra
 * pela API **sem edição nenhuma**. É a prova de integração do critério "grafo
 * vivendo como dado no banco" da D16 — fixture sintético não provaria isso.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloHash from '../src/dominio/hash.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloServer from '../src/server.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');
const DIR_EXEMPLOS = path.join(RAIZ_REPO, 'schema', 'exemplos');
const GRAFO_DE_FABRICA = path.join(
  RAIZ_REPO,
  'grafos-de-fabrica',
  'desenvolvimento-de-software',
  'grafo.json',
);

/** Contexto mínimo de teste usado pelos utilitários deste arquivo. */
interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

interface LinhaGrafo {
  id: string;
  classe: string;
  linhagem_tipo: string;
  base_classe: string | null;
  origem_proposta_id: number | null;
  versao_corrente_id: string | null;
  criado_em: string;
}

interface LinhaVersao {
  id: string;
  grafo_id: string;
  versao_pai: string | null;
  origem: string;
  proposta_id: number | null;
  criado_em: string;
}

interface RelatorioDeValidacao {
  erro: string;
  valido: boolean;
  estrutura: { valido: boolean; erros: Array<{ codigo: string; alvo: unknown }> };
  soundness: { valido: boolean; violacoes: Array<{ regra: string; alvo: unknown }> };
}

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;
let cacheServer: typeof ModuloServer | null = null;
let cacheHash: typeof ModuloHash | null = null;

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

async function carregarHash(): Promise<typeof ModuloHash> {
  const caminho = path.join(RAIZ_PACOTE, 'src', 'dominio', 'hash.ts');
  assert.ok(existsSync(caminho), 'artefato ainda não existe: packages/core/src/dominio/hash.ts');
  cacheHash ??= (await import(
    new URL('../src/dominio/hash.ts', import.meta.url).href
  )) as typeof ModuloHash;
  return cacheHash;
}

/** Sobe um control plane inteiro contra um banco temporário e devolve a URL. */
async function subirApp(t: ContextoDeTeste): Promise<string> {
  assert.ok(
    existsSync(path.join(DIR_MIGRACOES, '0002_grafo_versao_proposta.sql')),
    'artefato ainda não existe: packages/core/migrations/0002_grafo_versao_proposta.sql',
  );
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'routes', 'grafos.ts')),
    'artefato ainda não existe: packages/core/src/routes/grafos.ts',
  );

  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();
  const { criarApp } = await carregarServer();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t101-'));
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

  return endereco;
}

async function postar(endereco: string, rota: string, corpo: unknown): Promise<Response> {
  return fetch(`${endereco}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

async function corpoJson<T>(resposta: Response): Promise<T> {
  return (await resposta.json()) as T;
}

function lerJson(caminho: string): Record<string, unknown> {
  return JSON.parse(readFileSync(caminho, 'utf8')) as Record<string, unknown>;
}

test('AT6 — o grafo de fábrica 1 entra pela API sem edição, com hash do snapshot inteiro', async (t) => {
  const endereco = await subirApp(t);
  const { hashSnapshot } = await carregarHash();

  assert.ok(existsSync(GRAFO_DE_FABRICA), 'o bundle de fábrica 1 (t105) precisa estar no repo');
  const documento = lerJson(GRAFO_DE_FABRICA);

  const resposta = await postar(endereco, '/v1/grafos', documento);
  const corpo = await corpoJson<{ grafo: LinhaGrafo; grafo_versao: LinhaVersao }>(resposta);
  assert.equal(resposta.status, 201, JSON.stringify(corpo));
  assert.equal(corpo.grafo.id, 'desenvolvimento-de-software');
  assert.equal(corpo.grafo.classe, 'desenvolvimento-de-software');
  assert.equal(corpo.grafo.linhagem_tipo, 'base');
  assert.equal(corpo.grafo.base_classe, null);

  assert.equal(
    corpo.grafo_versao.id,
    hashSnapshot(documento),
    'o id da versão é o sha256 do documento INTEIRO, canonicalizado',
  );
  assert.match(corpo.grafo_versao.id, /^sha256:[0-9a-f]{64}$/);
  assert.equal(corpo.grafo_versao.versao_pai, null, 'a primeira versão da linhagem não tem pai');
  assert.equal(corpo.grafo_versao.origem, 'manual');
  assert.equal(corpo.grafo_versao.grafo_id, 'desenvolvimento-de-software');

  // Bootstrap de linhagem nova é a única situação em que registrar move o
  // ponteiro na mesma chamada: não existe "corrente" anterior a preservar.
  assert.equal(corpo.grafo.versao_corrente_id, corpo.grafo_versao.id);

  // O snapshot guardado é o documento inteiro, recuperável byte a byte no valor.
  const versao = await fetch(`${endereco}/v1/grafo-versoes/${encodeURIComponent(corpo.grafo_versao.id)}`);
  assert.equal(versao.status, 200);
  const corpoVersao = await corpoJson<{ grafo_versao: LinhaVersao & { snapshot: unknown } }>(versao);
  assert.deepEqual(corpoVersao.grafo_versao.snapshot, documento);
});

test('AT7 — registrar a mesma classe duas vezes devolve 409 na segunda', async (t) => {
  const endereco = await subirApp(t);
  const documento = lerJson(path.join(DIR_EXEMPLOS, 'grafo-valido-minimo.json'));

  assert.equal((await postar(endereco, '/v1/grafos', documento)).status, 201);

  const segunda = await postar(endereco, '/v1/grafos', documento);
  assert.equal(segunda.status, 409);
  const corpo = await corpoJson<{ erro: string }>(segunda);
  assert.equal(corpo.erro, 'classe_ja_registrada');
});

test('AT8 — registrar uma variante devolve 400 (D13/t118 estão fora desta ticket)', async (t) => {
  const endereco = await subirApp(t);

  const documento = lerJson(path.join(DIR_EXEMPLOS, 'grafo-valido-minimo.json'));
  documento.classe = 'nota-curta-do-projeto';
  documento.linhagem = { tipo: 'variante', base_classe: 'nota-curta' };

  const resposta = await postar(endereco, '/v1/grafos', documento);
  assert.equal(resposta.status, 400);
  assert.equal((await corpoJson<{ erro: string }>(resposta)).erro, 'linhagem_nao_base');
});

test('AT9 — grafo que quebra soundness devolve 422 com o relatório do validador', async (t) => {
  const endereco = await subirApp(t);
  const documento = lerJson(path.join(DIR_EXEMPLOS, 'grafo-invalido-no-inalcancavel.json'));

  const resposta = await postar(endereco, '/v1/grafos', documento);
  assert.equal(resposta.status, 422);

  const corpo = await corpoJson<RelatorioDeValidacao>(resposta);
  assert.equal(corpo.erro, 'grafo_invalido');
  assert.equal(corpo.valido, false);
  assert.deepEqual(
    corpo.soundness.violacoes,
    [{ regra: 'alcançável', alvo: 'revisar_lote' }],
    'o relatório precisa ser o mesmo de scripts/validar-grafo.mjs',
  );

  // Nada foi gravado: um grafo que não passa no portão não vira linhagem.
  const grafos = await corpoJson<{ grafos: LinhaGrafo[] }>(await fetch(`${endereco}/v1/grafos`));
  assert.deepEqual(grafos.grafos, []);
});

test('AT10 — as leituras refletem o grafo recém-registrado e 404 no que não existe', async (t) => {
  const endereco = await subirApp(t);
  const documento = lerJson(path.join(DIR_EXEMPLOS, 'grafo-valido-minimo.json'));

  const criacao = await postar(endereco, '/v1/grafos', documento);
  assert.equal(criacao.status, 201);
  const { grafo_versao: versao } = await corpoJson<{ grafo_versao: LinhaVersao }>(criacao);

  const porId = await fetch(`${endereco}/v1/grafos/nota-curta`);
  assert.equal(porId.status, 200);
  const corpoPorId = await corpoJson<{ grafo: LinhaGrafo }>(porId);
  assert.equal(corpoPorId.grafo.id, 'nota-curta');
  assert.equal(corpoPorId.grafo.versao_corrente_id, versao.id);

  const lista = await corpoJson<{ grafos: LinhaGrafo[] }>(await fetch(`${endereco}/v1/grafos`));
  assert.deepEqual(
    lista.grafos.map((grafo) => grafo.id),
    ['nota-curta'],
  );

  const classes = await corpoJson<{ classes: Array<{ classe: string; grafo_id: string }> }>(
    await fetch(`${endereco}/v1/classes`),
  );
  assert.deepEqual(classes.classes.map((entrada) => entrada.classe), ['nota-curta']);
  assert.equal(classes.classes[0].grafo_id, 'nota-curta');

  const versoes = await corpoJson<{ versoes: LinhaVersao[] }>(
    await fetch(`${endereco}/v1/grafos/nota-curta/versoes`),
  );
  assert.deepEqual(
    versoes.versoes.map((linha) => linha.id),
    [versao.id],
  );

  assert.equal((await fetch(`${endereco}/v1/grafos/inexistente`)).status, 404);
  assert.equal((await fetch(`${endereco}/v1/grafos/inexistente/versoes`)).status, 404);
  assert.equal((await fetch(`${endereco}/v1/grafo-versoes/sha256:naoexiste`)).status, 404);
});
