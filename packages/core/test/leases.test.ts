/**
 * Testes de aceite do mecanismo de lease (t103, FR3, FR5–FR9).
 *
 * A D5 cabe em duas frases: "trabalho despachado carrega lease; runner morto
 * expira e o trabalho volta à fila", e o teto de concorrência nunca é excedido.
 * As duas viram teste aqui — AT5/AT6/AT12 para o teto (inclusive sob chamadas
 * simultâneas) e AT10/AT11 para a morte do runner.
 *
 * Duas formas de montar o app convivem de propósito:
 *
 * - a maioria dos casos sobe o app real (`criarApp`), com o relógio de verdade,
 *   porque é o caminho que produção usa;
 * - AT10/AT11 montam o MESMO módulo de rotas com um relógio controlado
 *   (`registrarLeases(app, db, {agora})`, FR3). É o que deixa "o runner morreu e
 *   o prazo venceu" ser determinístico, sem `sleep`. O caminho com tempo real de
 *   ponta a ponta está provado em AT17
 *   (`packages/runner/test/controller/dispatch-e-lease.e2e.test.ts`).
 *
 * `trabalho_id` é inteiro opaco em toda esta suíte: a tabela `trabalho` é do
 * t102 e esta rota nunca a lê (Out of Scope).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Fastify from 'fastify';

import type * as ModuloConnection from '../src/db/connection.ts';
import type * as ModuloMigrate from '../src/db/migrate.ts';
import type * as ModuloRotasLeases from '../src/routes/leases.ts';
import type * as ModuloRunners from '../src/repositorios/runners.ts';
import type * as ModuloServer from '../src/server.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..');
const DIR_MIGRACOES = path.join(RAIZ_PACOTE, 'migrations');

interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

interface LinhaLease {
  id: number;
  runner_id: string;
  trabalho_id: number;
  projeto_id: number;
  status: 'ativa' | 'liberada' | 'expirada';
  ttl_segundos: number;
  concedida_em: string;
  heartbeat_em: string;
  expira_em: string;
  liberada_em: string | null;
  motivo_expiracao: 'heartbeat_perdido' | 'expirou' | null;
}

interface RespostaConcessao {
  lease: LinhaLease | null;
  motivo?: string;
}

let cacheConnection: typeof ModuloConnection | null = null;
let cacheMigrate: typeof ModuloMigrate | null = null;
let cacheServer: typeof ModuloServer | null = null;
let cacheRunners: typeof ModuloRunners | null = null;
let cacheRotasLeases: typeof ModuloRotasLeases | null = null;

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

async function carregarRotasLeases(): Promise<typeof ModuloRotasLeases> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'routes', 'leases.ts')),
    'artefato ainda não existe: packages/core/src/routes/leases.ts',
  );
  cacheRotasLeases ??= (await import(
    new URL('../src/routes/leases.ts', import.meta.url).href
  )) as typeof ModuloRotasLeases;
  return cacheRotasLeases;
}

/** Banco efêmero, já migrado. */
async function bancoTemporario(t: ContextoDeTeste): Promise<ModuloConnection.BancoDeDados> {
  const { abrirBanco, aplicarPragmas } = await carregarConnection();
  const { migrar } = await carregarMigrate();

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-leases-'));
  const db = abrirBanco(path.join(base, 'cartografo.db'));
  aplicarPragmas(db);
  migrar(db, DIR_MIGRACOES);

  t.after(() => {
    db.close();
    rmSync(base, { recursive: true, force: true });
  });

  return db;
}

/** Control plane efêmero de verdade, com o relógio de produção. */
async function subir(t: ContextoDeTeste): Promise<{
  endereco: string;
  db: ModuloConnection.BancoDeDados;
}> {
  const { criarApp } = await carregarServer();
  const db = await bancoTemporario(t);

  const app = criarApp({ db });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });

  return { endereco, db };
}

/**
 * O mesmo módulo de rotas de lease, montado com um relógio controlado.
 *
 * Só AT10/AT11 usam: são os dois casos em que o fato sob teste é a passagem do
 * tempo, e um `sleep` de verdade os tornaria lentos e instáveis.
 */
async function subirComRelogio(
  t: ContextoDeTeste,
  agora: () => string,
): Promise<{ endereco: string; db: ModuloConnection.BancoDeDados }> {
  const { registrarLeases } = await carregarRotasLeases();
  const db = await bancoTemporario(t);

  const app = Fastify({ logger: false });
  app.register(async (escopo) => registrarLeases(escopo, db, { agora }), { prefix: '/v1' });
  const endereco = await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
  });

  return { endereco, db };
}

/** Relógio de teste: começa em um instante fixo e só anda quando mandam. */
function relogioControlado(inicio = '2026-08-14T12:00:00.000Z'): {
  agora: () => string;
  avancar: (segundos: number) => void;
} {
  let instante = Date.parse(inicio);
  return {
    agora: () => new Date(instante).toISOString(),
    avancar: (segundos) => {
      instante += segundos * 1000;
    },
  };
}

interface Pedido {
  runner_id: string;
  projeto_id?: number;
  trabalho_id: number;
  teto_runner?: number;
  teto_projeto?: number;
  ttl_segundos?: number;
}

async function pedirLease(endereco: string, pedido: Pedido): Promise<Response> {
  return await fetch(`${endereco}/v1/leases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projeto_id: 1,
      teto_runner: 8,
      teto_projeto: 8,
      ttl_segundos: 60,
      ...pedido,
    }),
  });
}

async function listarLeasesHttp(endereco: string, consulta = ''): Promise<LinhaLease[]> {
  const resposta = await fetch(`${endereco}/v1/leases${consulta}`);
  assert.equal(resposta.status, 200);
  return ((await resposta.json()) as { leases: LinhaLease[] }).leases;
}

async function registrar(db: ModuloConnection.BancoDeDados, ...ids: string[]): Promise<void> {
  const { registrarRunner } = await carregarRunners();
  for (const id of ids) registrarRunner(db, { id });
}

test('AT3 — POST /v1/leases com runner_id não registrado devolve 404', async (t) => {
  const { endereco } = await subir(t);

  const resposta = await pedirLease(endereco, { runner_id: 'runner-fantasma', trabalho_id: 1 });

  assert.equal(
    resposta.status,
    404,
    'lease é concedida a runner pareado; um id desconhecido não existe para o control plane',
  );
  // O corpo importa: um 404 de rota inexistente também seria 404, e passaria
  // este teste sem que a regra existisse.
  const corpo = (await resposta.json()) as { erro?: string; runner_id?: string };
  assert.equal(corpo.erro, 'runner_desconhecido');
  assert.equal(corpo.runner_id, 'runner-fantasma');
});

test('AT4 — lease concedida nasce ativa e com expira_em = concedida_em + ttl_segundos', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a');

  const resposta = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 7,
    ttl_segundos: 30,
  });

  assert.equal(resposta.status, 201);
  const { lease } = (await resposta.json()) as RespostaConcessao;
  assert.ok(lease !== null, 'sem lease concorrente, a concessão não pode falhar');
  assert.equal(lease.status, 'ativa');
  assert.equal(lease.runner_id, 'runner-a');
  assert.equal(lease.trabalho_id, 7);
  assert.equal(lease.ttl_segundos, 30);
  assert.equal(lease.heartbeat_em, lease.concedida_em, 'lease recém-nascida nunca foi renovada');
  assert.equal(
    Date.parse(lease.expira_em) - Date.parse(lease.concedida_em),
    30_000,
    'expira_em é concedida_em + ttl_segundos',
  );
  assert.equal(lease.liberada_em, null);
  assert.equal(lease.motivo_expiracao, null);
});

test('AT5 — o teto por runner nunca é excedido', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a');

  const primeira = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 1,
    teto_runner: 1,
  });
  assert.equal(primeira.status, 201);

  const segunda = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(segunda.status, 200, 'teto batido não é erro do cliente: é "agora não"');
  const corpo = (await segunda.json()) as RespostaConcessao;
  assert.equal(corpo.lease, null);
  assert.equal(corpo.motivo, 'teto_runner');

  const ativas = await listarLeasesHttp(endereco, '?status=ativa');
  assert.equal(ativas.length, 1, 'a primeira lease segue ativa e é a única');
  assert.equal(ativas[0].trabalho_id, 1);
});

test('AT6 — o teto por projeto nunca é excedido, entre runners diferentes', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a', 'runner-b');

  const primeira = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 1,
    projeto_id: 42,
    teto_projeto: 1,
  });
  assert.equal(primeira.status, 201);

  const segunda = await pedirLease(endereco, {
    runner_id: 'runner-b',
    trabalho_id: 2,
    projeto_id: 42,
    teto_projeto: 1,
  });
  assert.equal(segunda.status, 200);
  const corpo = (await segunda.json()) as RespostaConcessao;
  assert.equal(corpo.lease, null);
  assert.equal(
    corpo.motivo,
    'teto_projeto',
    'o teto do projeto vale para o projeto inteiro, não por runner',
  );

  const ativas = await listarLeasesHttp(endereco, '?status=ativa&projeto_id=42');
  assert.equal(ativas.length, 1);
});

test('AT7 — trabalho que já tem lease ativa não recebe uma segunda', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a', 'runner-b');

  assert.equal((await pedirLease(endereco, { runner_id: 'runner-a', trabalho_id: 99 })).status, 201);

  const resposta = await pedirLease(endereco, { runner_id: 'runner-b', trabalho_id: 99 });
  assert.equal(resposta.status, 200);
  const corpo = (await resposta.json()) as RespostaConcessao;
  assert.equal(corpo.lease, null);
  assert.equal(corpo.motivo, 'trabalho_ja_leased');

  const todas = await listarLeasesHttp(endereco);
  assert.equal(todas.length, 1, 'a disputa perdida não pode deixar linha para trás');
});

test('AT8 — heartbeat estende o prazo; sobre lease não ativa é 409, sobre id inexistente é 404', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a');

  const concedida = (await (
    await pedirLease(endereco, { runner_id: 'runner-a', trabalho_id: 1, ttl_segundos: 30 })
  ).json()) as RespostaConcessao;
  assert.ok(concedida.lease !== null);
  const leaseId = concedida.lease.id;

  const batida = await fetch(`${endereco}/v1/leases/${leaseId}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_segundos: 300 }),
  });
  assert.equal(batida.status, 200);
  const renovada = ((await batida.json()) as { lease: LinhaLease }).lease;
  assert.equal(renovada.status, 'ativa');
  assert.equal(renovada.ttl_segundos, 300, 'o ttl enviado no heartbeat passa a valer');
  assert.ok(
    Date.parse(renovada.expira_em) > Date.parse(concedida.lease.expira_em),
    'heartbeat empurra expira_em para frente',
  );
  assert.ok(
    Date.parse(renovada.heartbeat_em) >= Date.parse(concedida.lease.heartbeat_em),
    'heartbeat_em registra a última batida',
  );

  const inexistente = await fetch(`${endereco}/v1/leases/987654/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(inexistente.status, 404);

  const liberacao = await fetch(`${endereco}/v1/leases/${leaseId}/liberacoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(liberacao.status, 200);

  const tardia = await fetch(`${endereco}/v1/leases/${leaseId}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(tardia.status, 409, 'heartbeat só faz sentido sobre lease ativa');
});

test('AT9 — liberar devolve a capacidade na hora', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a');

  const primeira = (await (
    await pedirLease(endereco, { runner_id: 'runner-a', trabalho_id: 1, teto_runner: 1 })
  ).json()) as RespostaConcessao;
  assert.ok(primeira.lease !== null);

  const bloqueada = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(((await bloqueada.json()) as RespostaConcessao).motivo, 'teto_runner');

  const liberacao = await fetch(`${endereco}/v1/leases/${primeira.lease.id}/liberacoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(liberacao.status, 200);
  const liberada = ((await liberacao.json()) as { lease: LinhaLease }).lease;
  assert.equal(liberada.status, 'liberada');
  assert.ok(liberada.liberada_em !== null, 'liberar carimba quando');

  const depois = await pedirLease(endereco, {
    runner_id: 'runner-a',
    trabalho_id: 2,
    teto_runner: 1,
  });
  assert.equal(depois.status, 201, 'a vaga liberada conta imediatamente na próxima concessão');

  const inexistente = await fetch(`${endereco}/v1/leases/987654/liberacoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(inexistente.status, 404);

  const repetida = await fetch(`${endereco}/v1/leases/${primeira.lease.id}/liberacoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(repetida.status, 409, 'liberar duas vezes a mesma lease é conflito');
});

test('AT10 — runner morre, lease expira, outro runner pega o mesmo trabalho', async (t) => {
  const relogio = relogioControlado();
  const { endereco, db } = await subirComRelogio(t, relogio.agora);
  await registrar(db, 'runner-a', 'runner-b');

  const primeira = (await (
    await pedirLease(endereco, { runner_id: 'runner-a', trabalho_id: 55, ttl_segundos: 5 })
  ).json()) as RespostaConcessao;
  assert.ok(primeira.lease !== null);
  const leaseMorta = primeira.lease.id;

  // runner-a morre aqui: nenhum heartbeat sai daqui para frente.
  relogio.avancar(6);

  const resposta = await pedirLease(endereco, {
    runner_id: 'runner-b',
    trabalho_id: 55,
    ttl_segundos: 5,
  });

  assert.equal(
    resposta.status,
    201,
    'o mesmo request que pede lease reivindica as expiradas antes de decidir (FR9)',
  );
  const nova = ((await resposta.json()) as RespostaConcessao).lease;
  assert.ok(nova !== null);
  assert.equal(nova.runner_id, 'runner-b');
  assert.equal(nova.trabalho_id, 55);
  assert.equal(nova.status, 'ativa');
  assert.notEqual(nova.id, leaseMorta);

  const todas = await listarLeasesHttp(endereco);
  const antiga = todas.find((lease) => lease.id === leaseMorta);
  assert.ok(antiga !== undefined);
  assert.equal(antiga.status, 'expirada', 'a lease do runner morto vira expirada, não some');

  const ativas = todas.filter((lease) => lease.status === 'ativa');
  assert.equal(ativas.length, 1, 'o trabalho re-enfileirado tem exatamente um dono novo');
});

test('AT11 — motivo_expiracao distingue nunca-renovada de heartbeat-perdido', async (t) => {
  const relogio = relogioControlado();
  const { endereco, db } = await subirComRelogio(t, relogio.agora);
  await registrar(db, 'runner-a', 'runner-b', 'runner-c');

  const nuncaRenovada = (await (
    await pedirLease(endereco, { runner_id: 'runner-a', trabalho_id: 1, ttl_segundos: 10 })
  ).json()) as RespostaConcessao;
  const comHeartbeat = (await (
    await pedirLease(endereco, { runner_id: 'runner-b', trabalho_id: 2, ttl_segundos: 10 })
  ).json()) as RespostaConcessao;
  assert.ok(nuncaRenovada.lease !== null && comHeartbeat.lease !== null);

  relogio.avancar(3);
  const batida = await fetch(`${endereco}/v1/leases/${comHeartbeat.lease.id}/heartbeats`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(batida.status, 200);

  // As duas param aqui; o prazo das duas vence.
  relogio.avancar(60);

  // Qualquer pedido novo reconcilia as expiradas antes de decidir (FR9).
  assert.equal(
    (await pedirLease(endereco, { runner_id: 'runner-c', trabalho_id: 3, ttl_segundos: 10 })).status,
    201,
  );

  const todas = await listarLeasesHttp(endereco);
  const semRenovacao = todas.find((lease) => lease.id === nuncaRenovada.lease?.id);
  const comRenovacao = todas.find((lease) => lease.id === comHeartbeat.lease?.id);
  assert.ok(semRenovacao !== undefined && comRenovacao !== undefined);

  assert.equal(semRenovacao.status, 'expirada');
  assert.equal(
    semRenovacao.motivo_expiracao,
    'expirou',
    'nunca renovada (heartbeat_em == concedida_em): o prazo simplesmente venceu',
  );

  assert.equal(comRenovacao.status, 'expirada');
  assert.equal(
    comRenovacao.motivo_expiracao,
    'heartbeat_perdido',
    'renovada ao menos uma vez e depois calada: o heartbeat é que se perdeu',
  );
});

test('AT12 — teto respeitado sob chamadas simultâneas', async (t) => {
  const { endereco, db } = await subir(t);
  await registrar(db, 'runner-a');

  const TETO_PROJETO = 3;
  const TRABALHOS = [1, 2, 3, 4, 5, 6, 7, 8];

  const respostas = await Promise.all(
    TRABALHOS.map(async (trabalho_id) =>
      pedirLease(endereco, {
        runner_id: 'runner-a',
        trabalho_id,
        projeto_id: 7,
        teto_runner: TRABALHOS.length,
        teto_projeto: TETO_PROJETO,
      }),
    ),
  );

  const concedidas = respostas.filter((resposta) => resposta.status === 201);
  const recusadas = respostas.filter((resposta) => resposta.status === 200);
  assert.equal(
    concedidas.length,
    TETO_PROJETO,
    'a contagem e a escrita precisam ser atômicas: nem uma concessão a mais',
  );
  assert.equal(recusadas.length, TRABALHOS.length - TETO_PROJETO);

  for (const resposta of recusadas) {
    const corpo = (await resposta.json()) as RespostaConcessao;
    assert.equal(corpo.lease, null);
    assert.equal(corpo.motivo, 'teto_projeto');
  }

  const ativas = await listarLeasesHttp(endereco, '?status=ativa&projeto_id=7');
  assert.equal(ativas.length, TETO_PROJETO, 'o estado no banco nunca excede o teto configurado');
  assert.equal(
    new Set(ativas.map((lease) => lease.trabalho_id)).size,
    TETO_PROJETO,
    'nenhum trabalho recebeu duas leases na corrida',
  );
});
