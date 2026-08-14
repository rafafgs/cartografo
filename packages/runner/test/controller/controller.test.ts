/**
 * Testes de aceite do loop de despacho do controller (t103, FR11/AT14–AT16).
 *
 * O controller é o dono do ciclo de vida da lease do lado do runner: pega
 * trabalho liberado, disputa a lease, mantém o heartbeat enquanto a sessão roda
 * e devolve a capacidade ao terminar — inclusive quando o trabalho estoura. Uma
 * lease presa por erro de despacho é capacidade vazando até o TTL vencer, que é
 * o pior dos dois mundos: ninguém trabalha e o teto continua ocupado.
 *
 * O tempo aqui é falso (`t.mock.timers`): o que está sob teste é o
 * comportamento do relógio do controller, não a paciência da suíte. O caminho
 * com tempo real está em `dispatch-e-lease.e2e.test.ts` (AT17).
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloCliente from '../../src/controller/cliente-controle.ts';
import type * as ModuloController from '../../src/controller/controller.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..', '..');
const URL_BASE = 'http://127.0.0.1:4317';

interface ChamadaHttp {
  url: string;
  metodo: string;
  corpo: unknown;
}

let cacheCliente: typeof ModuloCliente | null = null;
let cacheController: typeof ModuloController | null = null;

async function carregarCliente(): Promise<typeof ModuloCliente> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'controller', 'cliente-controle.ts')),
    'artefato ainda não existe: packages/runner/src/controller/cliente-controle.ts',
  );
  cacheCliente ??= (await import(
    new URL('../../src/controller/cliente-controle.ts', import.meta.url).href
  )) as typeof ModuloCliente;
  return cacheCliente;
}

async function carregarController(): Promise<typeof ModuloController> {
  assert.ok(
    existsSync(path.join(RAIZ_PACOTE, 'src', 'controller', 'controller.ts')),
    'artefato ainda não existe: packages/runner/src/controller/controller.ts',
  );
  cacheController ??= (await import(
    new URL('../../src/controller/controller.ts', import.meta.url).href
  )) as typeof ModuloController;
  return cacheController;
}

/** Cede o event loop de verdade: `setImmediate` não é mockado nestes testes. */
const cederEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const LEASE = {
  id: 12,
  runner_id: 'runner-a',
  trabalho_id: 1,
  projeto_id: 3,
  status: 'ativa',
  ttl_segundos: 6,
  concedida_em: '2026-08-14T12:00:00.000Z',
  heartbeat_em: '2026-08-14T12:00:00.000Z',
  expira_em: '2026-08-14T12:00:06.000Z',
  liberada_em: null,
  motivo_expiracao: null,
};

/**
 * Cliente apontado para um control plane falso que responde o mínimo do
 * contrato e guarda tudo o que recebeu.
 */
async function ambiente(): Promise<{
  cliente: ModuloCliente.ClienteControle;
  chamadas: ChamadaHttp[];
  heartbeats: () => number;
  liberacoes: () => number;
}> {
  const { ClienteControle } = await carregarCliente();
  const chamadas: ChamadaHttp[] = [];

  const responder = (status: number, corpo: unknown): Response =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const buscar: typeof fetch = async (entrada, init) => {
    const corpoBruto = init?.body;
    const url = String(entrada);
    chamadas.push({
      url,
      metodo: init?.method ?? 'GET',
      corpo: typeof corpoBruto === 'string' ? JSON.parse(corpoBruto) : undefined,
    });

    if (url.endsWith('/v1/trabalhos')) {
      return responder(200, {
        trabalhos: [
          {
            id: 1,
            titulo: 'implementar t103',
            no_atual: 'implementar',
            bloqueado: false,
            execucao_id: 9,
            grafo_versao_id: 'sha256:abc',
          },
        ],
      });
    }
    if (url.endsWith('/v1/leases')) return responder(201, { lease: LEASE });
    if (url.endsWith('/heartbeats')) return responder(200, { lease: LEASE });
    if (url.endsWith('/liberacoes')) {
      return responder(200, { lease: { ...LEASE, status: 'liberada' } });
    }
    throw new Error(`chamada inesperada: ${url}`);
  };

  return {
    cliente: new ClienteControle({ urlBase: URL_BASE, buscar }),
    chamadas,
    heartbeats: () => chamadas.filter((chamada) => chamada.url.endsWith('/heartbeats')).length,
    liberacoes: () => chamadas.filter((chamada) => chamada.url.endsWith('/liberacoes')).length,
  };
}

const OPCOES_BASE = {
  runnerId: 'runner-a',
  projetoId: 3,
  tetoRunner: 1,
  tetoProjeto: 4,
  ttlSegundos: 6,
};

test('AT14 — com o despacho em curso, o heartbeat bate em intervalo menor que o TTL', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { cliente, chamadas, heartbeats } = await ambiente();
  const { Controller } = await carregarController();

  let avisarDespachou: () => void = () => undefined;
  const despachou = new Promise<void>((resolve) => {
    avisarDespachou = resolve;
  });

  const controller = new Controller({
    ...OPCOES_BASE,
    cliente,
    // Nunca resolve: é a sessão que ainda está rodando.
    despachar: async () => {
      avisarDespachou();
      return new Promise<void>(() => undefined);
    },
  });

  const emCurso = controller.tick();
  emCurso.catch(() => undefined);

  await despachou;
  await cederEventLoop();

  assert.equal(heartbeats(), 0, 'nada de heartbeat antes de o relógio andar');

  // Uma janela inteira de TTL menos 1ms: se o intervalo fosse >= TTL, a lease
  // teria expirado no server sem nenhuma batida.
  t.mock.timers.tick(OPCOES_BASE.ttlSegundos * 1000 - 1);
  await cederEventLoop();

  assert.ok(
    heartbeats() >= 2,
    `o heartbeat precisa bater mais de uma vez dentro do TTL; bateu ${heartbeats()}`,
  );
  assert.ok(
    chamadas.some((chamada) => chamada.url.endsWith(`/v1/leases/${LEASE.id}/heartbeats`)),
    'o heartbeat é da lease concedida',
  );
});

test('AT15 — despacho concluído libera a lease e para o heartbeat', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { cliente, chamadas, heartbeats, liberacoes } = await ambiente();
  const { Controller } = await carregarController();

  const controller = new Controller({
    ...OPCOES_BASE,
    cliente,
    despachar: async () => undefined,
  });

  const resultado = await controller.tick();
  assert.deepEqual(resultado, { trabalhoId: 1, leaseId: LEASE.id });

  assert.equal(liberacoes(), 1, 'trabalho terminado devolve a lease');
  const batidasAteALiberacao = heartbeats();

  const indiceLiberacao = chamadas.findIndex((chamada) => chamada.url.endsWith('/liberacoes'));
  assert.ok(
    !chamadas.slice(indiceLiberacao + 1).some((chamada) => chamada.url.endsWith('/heartbeats')),
    'nenhum heartbeat depois da liberação',
  );

  t.mock.timers.tick(60_000);
  await cederEventLoop();
  assert.equal(
    heartbeats(),
    batidasAteALiberacao,
    'o relógio do heartbeat é desarmado junto com a liberação',
  );
});

test('AT16 — despacho que estoura AINDA libera a lease', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });

  const { cliente, heartbeats, liberacoes } = await ambiente();
  const { Controller } = await carregarController();

  const controller = new Controller({
    ...OPCOES_BASE,
    cliente,
    despachar: async () => {
      throw new Error('a sessão morreu no meio');
    },
  });

  await assert.rejects(
    async () => controller.tick(),
    /a sessão morreu no meio/,
    'o erro do trabalho não pode ser engolido pelo controller',
  );

  assert.equal(
    liberacoes(),
    1,
    'lease presa por erro de despacho é capacidade vazando até o TTL vencer',
  );

  const batidas = heartbeats();
  t.mock.timers.tick(60_000);
  await cederEventLoop();
  assert.equal(heartbeats(), batidas, 'o heartbeat para junto, mesmo no caminho de erro');
});

test('AT16 — sem trabalho liberado, o tick não pede lease nenhuma', async () => {
  const { ClienteControle } = await carregarCliente();
  const { Controller } = await carregarController();

  const chamadas: string[] = [];
  const buscar: typeof fetch = async (entrada) => {
    chamadas.push(String(entrada));
    return new Response(JSON.stringify({ trabalhos: [{ id: 1, bloqueado: true }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const controller = new Controller({
    ...OPCOES_BASE,
    cliente: new ClienteControle({ urlBase: URL_BASE, buscar }),
    despachar: async () => {
      throw new Error('não deveria despachar sem trabalho liberado');
    },
  });

  assert.equal(await controller.tick(), null);
  assert.deepEqual(chamadas, [`${URL_BASE}/v1/trabalhos`]);
});
