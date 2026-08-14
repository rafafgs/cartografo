/**
 * Teste de aceite do cliente HTTP do controller (t103, FR10/AT13).
 *
 * O runner é cliente da API e nada mais (D1): tudo o que ele sabe do estado do
 * mundo chega por HTTP. Este teste fixa o contrato de saída de cada método —
 * verbo, caminho e corpo — contra um `fetch` falso injetado, no mesmo padrão de
 * `packages/tela/src/index.ts`.
 *
 * `GET /v1/trabalhos` é rota do t102, já mergeada; o cliente consome dela
 * apenas o subconjunto de que precisa (`id`, `bloqueado`), e o filtro de
 * `bloqueado` mora do lado do cliente. A rota segue simulada aqui porque o que
 * este teste cobra é o cliente, não o server do t102.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ModuloCliente from '../../src/controller/cliente-controle.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..', '..');
const URL_BASE = 'http://127.0.0.1:4317';

/** Uma requisição, como o `fetch` falso a viu. */
interface ChamadaHttp {
  url: string;
  metodo: string;
  corpo: unknown;
}

let cacheCliente: typeof ModuloCliente | null = null;

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

/**
 * `fetch` falso que registra o que recebeu e responde o que mandarem.
 *
 * @param responder Decide a resposta a partir da chamada registrada.
 * @returns O par `{buscar, chamadas}`.
 */
function fetchFalso(responder: (chamada: ChamadaHttp) => { status: number; corpo: unknown }): {
  buscar: typeof fetch;
  chamadas: ChamadaHttp[];
} {
  const chamadas: ChamadaHttp[] = [];
  const buscar: typeof fetch = async (entrada, init) => {
    const corpoBruto = init?.body;
    const chamada: ChamadaHttp = {
      url: String(entrada),
      metodo: init?.method ?? 'GET',
      corpo: typeof corpoBruto === 'string' ? JSON.parse(corpoBruto) : undefined,
    };
    chamadas.push(chamada);

    const { status, corpo } = responder(chamada);
    return new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { buscar, chamadas };
}

const LEASE = {
  id: 12,
  runner_id: 'runner-a',
  trabalho_id: 55,
  projeto_id: 3,
  status: 'ativa',
  ttl_segundos: 30,
  concedida_em: '2026-08-14T12:00:00.000Z',
  heartbeat_em: '2026-08-14T12:00:00.000Z',
  expira_em: '2026-08-14T12:00:30.000Z',
  liberada_em: null,
  motivo_expiracao: null,
};

test('AT13 — cada método do cliente monta verbo, caminho e corpo certos', async () => {
  const { ClienteControle } = await carregarCliente();

  const { buscar, chamadas } = fetchFalso((chamada) => {
    if (chamada.url.endsWith('/v1/runners')) {
      return {
        status: 201,
        corpo: { runner: { id: 'runner-a', nome: 'laptop', registrado_em: '2026-08-14T12:00:00.000Z' } },
      };
    }
    if (chamada.url.endsWith('/v1/trabalhos')) {
      return {
        status: 200,
        corpo: {
          trabalhos: [
            {
              id: 1,
              titulo: 'liberado',
              no_atual: 'implementar',
              bloqueado: false,
              execucao_id: 9,
              grafo_versao_id: 'sha256:abc',
            },
            {
              id: 2,
              titulo: 'bloqueado',
              no_atual: 'revisar',
              bloqueado: true,
              execucao_id: 9,
              grafo_versao_id: 'sha256:abc',
            },
            {
              id: 3,
              titulo: 'também liberado',
              no_atual: 'implementar',
              bloqueado: false,
              execucao_id: 9,
              grafo_versao_id: 'sha256:abc',
            },
          ],
        },
      };
    }
    if (chamada.url.endsWith('/v1/leases')) return { status: 201, corpo: { lease: LEASE } };
    if (chamada.url.endsWith('/heartbeats')) {
      return { status: 200, corpo: { lease: { ...LEASE, ttl_segundos: 45 } } };
    }
    if (chamada.url.endsWith('/liberacoes')) {
      return { status: 200, corpo: { lease: { ...LEASE, status: 'liberada' } } };
    }
    throw new Error(`chamada inesperada: ${chamada.metodo} ${chamada.url}`);
  });

  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar });

  const runner = await cliente.registrarRunner('runner-a', 'laptop');
  assert.equal(runner.id, 'runner-a');
  assert.deepEqual(chamadas[0], {
    url: `${URL_BASE}/v1/runners`,
    metodo: 'POST',
    corpo: { id: 'runner-a', nome: 'laptop' },
  });

  const liberados = await cliente.listarTrabalhosLiberados();
  assert.deepEqual(chamadas[1], {
    url: `${URL_BASE}/v1/trabalhos`,
    metodo: 'GET',
    corpo: undefined,
  });
  assert.deepEqual(
    liberados.map((trabalho) => trabalho.id),
    [1, 3],
    'trabalho bloqueado nunca vira candidato a lease',
  );

  const concessao = await cliente.pedirLease({
    runner_id: 'runner-a',
    projeto_id: 3,
    trabalho_id: 55,
    teto_runner: 2,
    teto_projeto: 4,
    ttl_segundos: 30,
  });
  assert.equal(concessao.lease?.id, 12);
  assert.deepEqual(chamadas[2], {
    url: `${URL_BASE}/v1/leases`,
    metodo: 'POST',
    corpo: {
      runner_id: 'runner-a',
      projeto_id: 3,
      trabalho_id: 55,
      teto_runner: 2,
      teto_projeto: 4,
      ttl_segundos: 30,
    },
  });

  const renovada = await cliente.heartbeat(12, 45);
  assert.equal(renovada.ttl_segundos, 45);
  assert.deepEqual(chamadas[3], {
    url: `${URL_BASE}/v1/leases/12/heartbeats`,
    metodo: 'POST',
    corpo: { ttl_segundos: 45 },
  });

  const liberada = await cliente.liberar(12);
  assert.equal(liberada.status, 'liberada');
  assert.deepEqual(chamadas[4], {
    url: `${URL_BASE}/v1/leases/12/liberacoes`,
    metodo: 'POST',
    corpo: {},
  });

  assert.equal(chamadas.length, 5, 'nenhuma chamada a mais do que as cinco do contrato');
});

test('AT13 — recusa de lease chega ao chamador como motivo, não como erro', async () => {
  const { ClienteControle } = await carregarCliente();

  const { buscar } = fetchFalso(() => ({
    status: 200,
    corpo: { lease: null, motivo: 'teto_projeto' },
  }));

  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar });
  const concessao = await cliente.pedirLease({
    runner_id: 'runner-a',
    projeto_id: 3,
    trabalho_id: 55,
    teto_runner: 1,
    teto_projeto: 1,
    ttl_segundos: 30,
  });

  assert.equal(concessao.lease, null);
  assert.equal(concessao.motivo, 'teto_projeto');
});

test('AT13 — resposta de erro do control plane vira exceção com o status', async () => {
  const { ClienteControle, ErroDoControlPlane } = await carregarCliente();

  const { buscar } = fetchFalso(() => ({ status: 404, corpo: { erro: 'runner_desconhecido' } }));
  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar });

  await assert.rejects(
    async () =>
      cliente.pedirLease({
        runner_id: 'fantasma',
        projeto_id: 3,
        trabalho_id: 55,
        teto_runner: 1,
        teto_projeto: 1,
        ttl_segundos: 30,
      }),
    (erro: unknown) => {
      assert.ok(erro instanceof ErroDoControlPlane);
      assert.equal(erro.status, 404);
      return true;
    },
  );
});

test('AT13 — a URL base tolera barra no fim, como o cliente da tela', async () => {
  const { ClienteControle } = await carregarCliente();

  const { buscar, chamadas } = fetchFalso(() => ({
    status: 201,
    corpo: { runner: { id: 'runner-a', nome: null, registrado_em: '2026-08-14T12:00:00.000Z' } },
  }));

  const cliente = new ClienteControle({ urlBase: `${URL_BASE}/`, buscar });
  await cliente.registrarRunner('runner-a');

  assert.equal(chamadas[0].url, `${URL_BASE}/v1/runners`);
  assert.deepEqual(chamadas[0].corpo, { id: 'runner-a' }, 'nome ausente não vira null no corpo');
});
