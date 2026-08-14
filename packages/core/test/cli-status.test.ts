/**
 * Testes de aceite de `status` (t108, FR5).
 *
 * A forma do `--json` é pinada byte a byte no control plane vazio, pelo mesmo
 * motivo que `health.test.ts` pina o corpo de `/health`: é saída de máquina, e
 * campo que aparece ou some silenciosamente quebra quem consome. O que o pino
 * mais protege é `trabalhos`/`perguntas_pendentes` valendo `null` — as tabelas
 * `sessão`/`input_request` não existem (`migrations/0001_init.sql`), e um `0`
 * ali afirmaria "fila vazia" quando a resposta honesta é "não rastreado ainda".
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  BUNDLE_FABRICA,
  areaTemporaria,
  pareceStackTrace,
  portaLivre,
  primeiroHash,
  rodarCli,
  subirControlPlane,
} from './cli-apoio.ts';

const CLASSE_FABRICA = 'desenvolvimento-de-software';

test('AT8 — status --json no control plane vazio tem forma pinada', { timeout: 180_000 }, async (t) => {
  const base = areaTemporaria(t);
  const controlPlane = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'cartografo.db'),
  });

  const resultado = await rodarCli(['status', '--json'], {
    env: { CARTOGRAFO_URL: controlPlane.url },
  });

  assert.equal(resultado.codigo, 0, `stderr:\n${resultado.erros}`);
  assert.equal(
    resultado.saida.trim(),
    '{"server":"ok","projetos":[],"trabalhos":null,"perguntas_pendentes":null}',
  );
});

test('AT9 — depois de importar, status --json lista a classe com a versão corrente', { timeout: 180_000 }, async (t) => {
  const base = areaTemporaria(t);
  const controlPlane = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'cartografo.db'),
  });

  const importacao = await rodarCli(['import', BUNDLE_FABRICA, '--url', controlPlane.url]);
  assert.equal(importacao.codigo, 0, `stderr:\n${importacao.erros}`);
  const versao = primeiroHash(importacao.saida);

  const resultado = await rodarCli(['status', '--json', '--url', controlPlane.url]);
  assert.equal(resultado.codigo, 0, `stderr:\n${resultado.erros}`);

  const relatorio = JSON.parse(resultado.saida) as {
    server: string;
    projetos: { classe: string; versao_corrente_id: string }[];
    trabalhos: null;
    perguntas_pendentes: null;
  };
  assert.equal(relatorio.server, 'ok');
  assert.deepEqual(relatorio.projetos, [{ classe: CLASSE_FABRICA, versao_corrente_id: versao }]);
  assert.equal(relatorio.trabalhos, null);
  assert.equal(relatorio.perguntas_pendentes, null);

  const tabela = await rodarCli(['status', '--url', controlPlane.url]);
  assert.equal(tabela.codigo, 0, `stderr:\n${tabela.erros}`);
  assert.match(tabela.saida, /server: ok/);
  assert.match(tabela.saida, new RegExp(CLASSE_FABRICA));
  assert.match(tabela.saida, new RegExp(versao));
});

test('AT10 — status contra servidor inalcançável diz `server: indisponível` e sai não-zero', { timeout: 60_000 }, async () => {
  const porta = await portaLivre();
  const resultado = await rodarCli(['status', '--url', `http://127.0.0.1:${porta}`]);

  assert.notEqual(resultado.codigo, 0);
  assert.match(resultado.saida, /server: indisponível/);
  assert.equal(pareceStackTrace(resultado.erros), false, `stack trace vazou:\n${resultado.erros}`);
});
