/**
 * Teste de aceite fim a fim do ciclo de lease (t103, AT17) — o cenário central
 * da D5: "trabalho despachado carrega lease; runner morto expira e o trabalho
 * volta à fila".
 *
 * Aqui não há relógio injetado nem repositório chamado na mão: sobe-se o
 * control plane de verdade como processo filho (mesmo padrão de
 * `packages/core/test/startup.test.ts`), e dois `Controller` disputam o mesmo
 * trabalho por HTTP. O tempo é o tempo real, e a espera tem prazo próprio com
 * mensagem explícita — nada de `sleep` torcendo para dar certo, na mesma
 * disciplina de `packages/runner/src/engine/conformance-kit.ts`.
 *
 * O runner NÃO importa nada do core: o control plane é um processo, e a única
 * superfície entre os dois é a porta HTTP. É a D1 sendo exercida, não só
 * declarada — e é o que deixa este arquivo passar no portão de AT19.
 *
 * `GET /v1/jobs` é do t102 e ainda não existe: só ELA é simulada, por um
 * `fetch` que intercepta esse caminho e delega todo o resto para o control plane
 * de verdade. Todo o caminho de lease — conceder, expirar, reivindicar,
 * reconceder — é HTTP real contra o server real.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as esperar } from 'node:timers/promises';

import type * as ModuloCliente from '../../src/controller/cliente-controle.ts';
import type * as ModuloController from '../../src/controller/controller.ts';

const RAIZ_PACOTE = path.resolve(import.meta.dirname, '..', '..');
const RAIZ_REPO = path.resolve(RAIZ_PACOTE, '..', '..');
const CAMINHO_BIN = path.join(RAIZ_REPO, 'packages', 'core', 'bin', 'cartografo.mjs');

/** Trabalho ao qual os dois runners vão se candidatar. */
const TRABALHO_ID = 4242;
/** TTL da lease. Um segundo é o menor prazo expressável em `ttl_segundos`. */
const TTL_SEGUNDOS = 1;
/** Prazo da espera pela re-enfileirada. Folga larga sobre o TTL, de propósito. */
const PRAZO_MS = 30_000;

interface ContextoDeTeste {
  after: (fn: () => void | Promise<void>) => void;
}

interface LinhaLease {
  id: number;
  runner_id: string;
  trabalho_id: number;
  status: string;
  motivo_expiracao: string | null;
}

type FilhoDoComando = ChildProcessByStdio<null, Readable, Readable>;

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

/** Sobe o control plane de verdade e devolve a URL que ele anunciou. */
async function subirControlPlane(t: ContextoDeTeste): Promise<string> {
  assert.ok(existsSync(CAMINHO_BIN), `artefato ainda não existe: ${CAMINHO_BIN}`);

  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t103-e2e-'));
  const filho: FilhoDoComando = spawn(process.execPath, [CAMINHO_BIN], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, 'cartografo.db'),
      CARTOGRAFO_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let saida = '';
  let erros = '';
  filho.stdout.setEncoding('utf8');
  filho.stderr.setEncoding('utf8');
  filho.stdout.on('data', (pedaco: string) => {
    saida += pedaco;
  });
  filho.stderr.on('data', (pedaco: string) => {
    erros += pedaco;
  });

  t.after(async () => {
    if (filho.exitCode === null && filho.signalCode === null) {
      filho.kill('SIGTERM');
      for (let tentativa = 0; tentativa < 50; tentativa += 1) {
        if (filho.exitCode !== null || filho.signalCode !== null) break;
        await esperar(100);
      }
      if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL');
    }
    rmSync(base, { recursive: true, force: true });
  });

  const prazo = Date.now() + PRAZO_MS;
  while (Date.now() < prazo) {
    if (filho.exitCode !== null) {
      throw new Error(
        `o control plane morreu antes de ficar pronto (código ${filho.exitCode})\nstdout:\n${saida}\nstderr:\n${erros}`,
      );
    }
    const linha = saida
      .split('\n')
      .map((texto) => texto.trim())
      .find((texto) => texto.startsWith('{') && texto.includes('cartografo.pronto'));
    if (linha !== undefined) return (JSON.parse(linha) as { url: string }).url;
    await esperar(50);
  }

  throw new Error(`o control plane não ficou pronto em ${PRAZO_MS}ms\nstdout:\n${saida}`);
}

/**
 * `fetch` que responde `GET /v1/jobs` com uma fila fixa e delega TODO o
 * resto para o control plane de verdade.
 *
 * A rota existe de verdade desde que o t102 mergeou, mas continua simulada de
 * propósito: o que a AT17 prova é o ciclo de lease sob tempo real, e semear a
 * fila por HTTP faria o teste falhar por mudança de contrato do t102 em vez de
 * por regressão de lease. Quem ligar o ciclo ponta a ponta (t106/t109) é quem
 * troca esta simulação pela fila de verdade.
 */
function fetchComFilaSimulada(): typeof fetch {
  return async (entrada, init) => {
    if (String(entrada).endsWith('/v1/jobs')) {
      return new Response(
        JSON.stringify({
          trabalhos: [
            {
              id: TRABALHO_ID,
              titulo: 'trabalho disputado',
              no_atual: 'implementar',
              bloqueado: false,
              execucao_id: 1,
              grafo_versao_id: 'sha256:e2e',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return fetch(entrada, init);
  };
}

test('AT17 — runner morre, a lease expira e o outro runner pega o mesmo trabalho', async (t) => {
  const { ClienteControle } = await carregarCliente();
  const { Controller } = await carregarController();

  const urlBase = await subirControlPlane(t);
  const buscar = fetchComFilaSimulada();

  const clienteA = new ClienteControle({ urlBase, buscar });
  const clienteB = new ClienteControle({ urlBase, buscar });
  await clienteA.registrarRunner('runner-a', 'o que morre');
  await clienteB.registrarRunner('runner-b', 'o que herda');

  let avisarDespachou: () => void = () => undefined;
  const despachouA = new Promise<void>((resolve) => {
    avisarDespachou = resolve;
  });

  const controllerA = new Controller({
    cliente: clienteA,
    runnerId: 'runner-a',
    projetoId: 3,
    tetoRunner: 1,
    tetoProjeto: 4,
    ttlSegundos: TTL_SEGUNDOS,
    // Bem maior que o TTL: simula o processo do runner-a morrendo logo depois
    // de despachar — os temporizadores dele param, nenhum heartbeat sai.
    intervaloHeartbeatMs: 60_000,
    despachar: async () => {
      avisarDespachou();
      return new Promise<void>(() => undefined);
    },
  });

  const despachados: number[] = [];
  const controllerB = new Controller({
    cliente: clienteB,
    runnerId: 'runner-b',
    projetoId: 3,
    tetoRunner: 1,
    tetoProjeto: 4,
    ttlSegundos: TTL_SEGUNDOS,
    despachar: async (trabalhoId) => {
      despachados.push(trabalhoId);
    },
  });

  const tickA = controllerA.tick();
  tickA.catch(() => undefined);
  await despachouA;

  // Com a lease viva, runner-b não tem o que pegar: o trabalho tem dono.
  assert.equal(
    await controllerB.tick(),
    null,
    'enquanto a lease do runner-a vale, o trabalho não é candidato de mais ninguém',
  );

  // A partir daqui é só tempo real passando: sem heartbeat, a lease do runner-a
  // vence e o próprio pedido do runner-b reivindica a expirada.
  const prazo = Date.now() + PRAZO_MS;
  let herdada: { trabalhoId: number; leaseId: number } | null = null;
  while (Date.now() < prazo && herdada === null) {
    herdada = await controllerB.tick();
    if (herdada === null) await esperar(100);
  }

  assert.ok(
    herdada !== null,
    `o trabalho não voltou à fila em ${PRAZO_MS}ms com TTL de ${TTL_SEGUNDOS}s`,
  );
  assert.equal(herdada.trabalhoId, TRABALHO_ID);
  assert.deepEqual(despachados, [TRABALHO_ID], 'runner-b despachou o trabalho re-enfileirado');

  const resposta = await fetch(`${urlBase}/v1/leases?projeto_id=3`);
  assert.equal(resposta.status, 200);
  const todas = (await resposta.json()) as { leases: LinhaLease[] };
  const leases = todas.leases.filter((lease) => lease.trabalho_id === TRABALHO_ID);

  const doRunnerA = leases.filter((lease) => lease.runner_id === 'runner-a');
  assert.equal(doRunnerA.length, 1);
  assert.equal(doRunnerA[0].status, 'expirada', 'a lease do runner morto é reivindicada');
  assert.equal(
    doRunnerA[0].motivo_expiracao,
    'expirou',
    'runner-a nunca renovou: o prazo simplesmente venceu',
  );

  const doRunnerB = leases.filter((lease) => lease.runner_id === 'runner-b');
  assert.equal(doRunnerB.length, 1, 'runner-b assumiu o mesmo trabalho, com lease própria');
  assert.equal(doRunnerB[0].id, herdada.leaseId);
  assert.equal(
    doRunnerB[0].status,
    'liberada',
    'terminado o despacho, runner-b devolveu a capacidade',
  );
});
