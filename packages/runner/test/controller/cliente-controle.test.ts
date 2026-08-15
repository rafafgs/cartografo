/**
 * Teste de aceite do cliente HTTP do controller (t103, FR10/AT13).
 *
 * O runner é cliente da API e nada mais (D1): tudo o que ele sabe do estado do
 * mundo chega por HTTP. Este teste fixa o contrato de saída de cada método —
 * verbo, caminho e corpo — contra um `fetch` falso injetado, no mesmo padrão de
 * `packages/tela/src/index.ts`.
 *
 * `GET /v1/jobs` é rota do t102, já mergeada; o cliente consome dela
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
    if (chamada.url.endsWith('/v1/jobs')) {
      return {
        status: 200,
        corpo: {
          trabalhos: [
            {
              id: 1,
              titulo: 'liberado',
              no_atual: 'implementar',
              bloqueado: false,
              concluido: false,
              execucao_id: 9,
              grafo_versao_id: 'sha256:abc',
            },
            {
              id: 2,
              titulo: 'bloqueado',
              no_atual: 'revisar',
              bloqueado: true,
              concluido: false,
              execucao_id: 9,
              grafo_versao_id: 'sha256:abc',
            },
            {
              id: 3,
              titulo: 'também liberado',
              no_atual: 'implementar',
              bloqueado: false,
              concluido: false,
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
    if (chamada.url.endsWith('/releases')) {
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
    url: `${URL_BASE}/v1/jobs`,
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
    url: `${URL_BASE}/v1/leases/12/releases`,
    metodo: 'POST',
    corpo: {},
  });

  assert.equal(chamadas.length, 5, 'nenhuma chamada a mais do que as cinco do contrato');
});

test('t161 — trabalho concluído deixa de ser candidato, mesmo desbloqueado', async () => {
  const { ClienteControle } = await carregarCliente();

  // `concluido` sai de `GET /v1/jobs` desde a t152: é derivado do `no_atual`
  // contra os `nos_finais` da versão do trabalho. Sem este filtro, um trabalho
  // que chega ao nó final continua liberado para sempre — e o controller o
  // redespacha em laço, que é a lacuna 3 da t161.
  const { buscar } = fetchFalso(() => ({
    status: 200,
    corpo: {
      trabalhos: [
        {
          id: 1,
          titulo: 'ainda andando',
          no_atual: 'implementar',
          bloqueado: false,
          concluido: false,
          execucao_id: 9,
          grafo_versao_id: 'sha256:abc',
        },
        {
          id: 2,
          titulo: 'chegou no nó final',
          no_atual: 'publicar',
          bloqueado: false,
          concluido: true,
          execucao_id: 9,
          grafo_versao_id: 'sha256:abc',
        },
      ],
    },
  }));

  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar });
  const liberados = await cliente.listarTrabalhosLiberados();

  assert.deepEqual(
    liberados.map((trabalho) => trabalho.id),
    [1],
    'trabalho no nó final não volta para a fila de despacho',
  );
  assert.equal(liberados[0].concluido, false, 'o campo chega ao chamador, não só ao filtro');
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

/**
 * `fetch` falso que registra os CABEÇALHOS de cada chamada (t124).
 *
 * Separado do `fetchFalso` acima de propósito: aquele fixa verbo, caminho e
 * corpo, e é o contrato que o t103 congelou. O que esta ficha acrescenta é
 * ortogonal — o mesmo pedido, com credencial —, e um `fetch` falso que registra
 * tudo tornaria a comparação por `deepEqual` daquele teste refém deste.
 */
function fetchQueRegistraCabecalhos(): {
  buscar: typeof fetch;
  autorizacoes: Array<string | null>;
} {
  const autorizacoes: Array<string | null> = [];
  const buscar: typeof fetch = async (entrada, init) => {
    autorizacoes.push(new Headers(init?.headers).get('authorization'));
    return new Response(
      JSON.stringify(
        String(entrada).endsWith('/v1/jobs')
          ? { trabalhos: [] }
          : { runner: { id: 'runner-a', nome: null, registrado_em: '2026-08-14T12:00:00.000Z' } },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { buscar, autorizacoes };
}

test('t124 — com `token` configurado, toda chamada leva o cabeçalho Bearer', async () => {
  const { ClienteControle } = await carregarCliente();

  const { buscar, autorizacoes } = fetchQueRegistraCabecalhos();
  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar, token: 'token-do-runner' });

  await cliente.registrarRunner('runner-a');
  await cliente.listarTrabalhosLiberados();

  assert.deepEqual(
    autorizacoes,
    ['Bearer token-do-runner', 'Bearer token-do-runner'],
    'o POST e o GET carregam a credencial: não existe rota de negócio isenta',
  );
});

test('t124 — sem `token`, o cliente não inventa cabeçalho nenhum', async () => {
  const { ClienteControle } = await carregarCliente();

  const { buscar, autorizacoes } = fetchQueRegistraCabecalhos();
  const cliente = new ClienteControle({ urlBase: URL_BASE, buscar });

  await cliente.registrarRunner('runner-a');
  await cliente.listarTrabalhosLiberados();

  assert.deepEqual(
    autorizacoes,
    [null, null],
    'um cliente sem credencial toma 401 do control plane — e não um cabeçalho vazio que parece credencial',
  );
});

/**
 * `fetch` falso que devolve uma resposta CRUA, montada pelo teste (t156).
 *
 * Separado do `fetchFalso` do topo de propósito: aquele sempre serializa JSON e
 * anuncia `application/json`, e por isso não consegue nem descrever o caso desta
 * ficha — um intermediário quebrado (proxy reverso) respondendo 502 com uma
 * página HTML, que é corpo que o `JSON.parse` não engole.
 */
function fetchQueResponde(montar: () => Response): typeof fetch {
  return async () => montar();
}

const HTML_502 = '<html>502 Bad Gateway</html>';

test('t156 — corpo de erro não-JSON vira ErroDoControlPlane com o texto cru, não SyntaxError', async () => {
  const { ClienteControle, ErroDoControlPlane } = await carregarCliente();

  const cliente = new ClienteControle({
    urlBase: URL_BASE,
    buscar: fetchQueResponde(
      () => new Response(HTML_502, { status: 502, headers: { 'content-type': 'text/html' } }),
    ),
  });

  await assert.rejects(
    () => cliente.listarTrabalhosLiberados(),
    (erro: unknown) => {
      assert.ok(
        erro instanceof ErroDoControlPlane,
        `esperava ErroDoControlPlane, veio ${erro instanceof Error ? erro.name : String(erro)}`,
      );
      assert.equal(erro.status, 502);
      assert.equal(
        erro.corpo,
        HTML_502,
        'o corpo cru é o que sobra para quem loga: quem respondeu não foi o control plane',
      );
      return true;
    },
  );
});

/**
 * Pino de não-regressão, não repro: o caso do corpo vazio JÁ funciona hoje
 * (`texto === '' ? undefined : JSON.parse(texto)`), e o que este teste guarda é
 * que a refatoração do t156 não o troque por `''` nem por uma exceção.
 */
test('t156 (não-regressão) — corpo vazio em resposta de erro continua chegando como undefined', async () => {
  const { ClienteControle, ErroDoControlPlane } = await carregarCliente();

  const cliente = new ClienteControle({
    urlBase: URL_BASE,
    buscar: fetchQueResponde(() => new Response('', { status: 500 })),
  });

  await assert.rejects(
    () => cliente.listarTrabalhosLiberados(),
    (erro: unknown) => {
      assert.ok(erro instanceof ErroDoControlPlane);
      assert.equal(erro.status, 500);
      assert.equal(erro.corpo, undefined);
      return true;
    },
  );
});
