/**
 * Testes de aceite do roteamento da CLI (t108, FR1/FR7).
 *
 * O que este arquivo protege é a compatibilidade: o comando ganhou
 * subcomandos, e a partida — que antes era a única coisa que ele fazia —
 * continua sendo o comportamento default, sem argumento nenhum. Por isso os
 * dois primeiros testes reafirmam o AT9 do t100 (`test/startup.test.ts`) por
 * fora do roteador, em vez de confiarem que ele não mexeu no caminho antigo.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { areaTemporaria, rodarCli, subirControlPlane } from './cli-apoio.ts';

test('AT1 — sem subcomando, o comando ainda sobe o control plane e serve /health', { timeout: 180_000 }, async (t) => {
  const base = areaTemporaria(t);
  const controlPlane = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'dados', 'cartografo.db'),
  });

  assert.equal(controlPlane.prontidao.evento, 'cartografo.pronto');
  const resposta = await fetch(`${controlPlane.url}/health`);
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { status: 'ok', db: 'ok' });
});

test('AT2 — `up` explícito se comporta igual à partida sem argumento', { timeout: 180_000 }, async (t) => {
  const base = areaTemporaria(t);
  const controlPlane = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'dados', 'cartografo.db'),
    argumentos: ['up'],
  });

  assert.equal(controlPlane.prontidao.evento, 'cartografo.pronto');
  assert.ok(
    controlPlane.prontidao.migracoes_aplicadas >= 1,
    'a primeira partida precisa aplicar ao menos a migração inicial',
  );
  const resposta = await fetch(`${controlPlane.url}/health`);
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { status: 'ok', db: 'ok' });
});

test('AT3 — `--help` sai 0 e lista os quatro subcomandos', { timeout: 60_000 }, async () => {
  for (const bandeira of ['--help', '-h']) {
    const resultado = await rodarCli([bandeira]);
    assert.equal(resultado.codigo, 0, `stderr:\n${resultado.erros}`);
    for (const subcomando of ['up', 'import', 'export', 'status']) {
      assert.match(resultado.saida, new RegExp(`\\b${subcomando}\\b`), `${bandeira} precisa citar "${subcomando}"`);
    }
  }
});

test('AT4 — subcomando desconhecido sai não-zero e imprime o uso em stderr', { timeout: 60_000 }, async () => {
  const ajuda = await rodarCli(['--help']);
  const desconhecido = await rodarCli(['bogus-command']);

  assert.notEqual(desconhecido.codigo, 0, 'comando desconhecido não pode sair 0');
  assert.equal(desconhecido.saida, '', 'em erro, nada vai para stdout');
  assert.match(desconhecido.erros, /bogus-command/);
  for (const subcomando of ['up', 'import', 'export', 'status']) {
    assert.match(
      desconhecido.erros,
      new RegExp(`\\b${subcomando}\\b`),
      'o uso impresso em stderr é o mesmo do --help',
    );
  }
  assert.ok(
    desconhecido.erros.includes(ajuda.saida.trim()),
    'o uso impresso em stderr precisa ser literalmente o mesmo texto do --help',
  );
});
