/**
 * Testes de aceite de `import` e `export` (t108, FR2/FR3/FR4).
 *
 * O teste central é o round-trip: exportar de um control plane e importar em
 * OUTRO, de banco vazio, tem que produzir o mesmo `grafo_versao.id`. Isso só
 * fecha se o export devolver o snapshot sem tocar nele — o id é o hash
 * canônico do documento (`docs/spec/entidades-versionamento.md` §2), então
 * qualquer campo acrescentado, removido ou reescrito no caminho aparece como
 * hash diferente. É a prova de que o par import/export preserva o dado, e não
 * só de que os dois comandos rodam.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  BUNDLE_FABRICA,
  RAIZ_REPO,
  areaTemporaria,
  pareceStackTrace,
  portaLivre,
  primeiroHash,
  rodarCli,
  subirControlPlane,
} from './cli-apoio.ts';

const CLASSE_FABRICA = 'desenvolvimento-de-software';
const GRAFO_FABRICA = path.join(BUNDLE_FABRICA, 'grafo.json');
const GRAFO_INVALIDO = path.join(RAIZ_REPO, 'schema', 'exemplos', 'grafo-invalido-no-inalcancavel.json');

test('AT5 — import do bundle de fábrica, recusa de reimportação, export e round-trip', { timeout: 300_000 }, async (t) => {
  const base = areaTemporaria(t);
  const primeiro = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'primeiro', 'cartografo.db'),
  });

  let versaoImportada = '';

  await t.test('importar o bundle de fábrica registra a classe', async () => {
    const resultado = await rodarCli(['import', BUNDLE_FABRICA, '--url', primeiro.url]);
    assert.equal(resultado.codigo, 0, `stdout:\n${resultado.saida}\nstderr:\n${resultado.erros}`);
    assert.match(resultado.saida, new RegExp(CLASSE_FABRICA));
    versaoImportada = primeiroHash(resultado.saida);

    const resposta = await fetch(`${primeiro.url}/v1/classes`);
    assert.equal(resposta.status, 200);
    const corpo = (await resposta.json()) as {
      classes: { classe: string; versao_corrente_id: string }[];
    };
    assert.deepEqual(
      corpo.classes.map((entrada) => entrada.classe),
      [CLASSE_FABRICA],
    );
    assert.equal(corpo.classes[0]?.versao_corrente_id, versaoImportada);
  });

  await t.test('importar o mesmo bundle de novo é recusado com classe_ja_registrada', async () => {
    const resultado = await rodarCli(['import', BUNDLE_FABRICA, '--url', primeiro.url]);
    assert.notEqual(resultado.codigo, 0, 'reimportar sobre linhagem existente não pode sair 0');
    assert.match(resultado.erros, /classe_ja_registrada/);
    assert.equal(pareceStackTrace(resultado.erros), false, `stack trace vazou:\n${resultado.erros}`);
  });

  const arquivoExportado = path.join(base, 'saida.grafo.json');

  await t.test('exportar devolve o mesmo documento que o grafo.json de origem', async () => {
    const resultado = await rodarCli([
      'export',
      CLASSE_FABRICA,
      '--out',
      arquivoExportado,
      '--url',
      primeiro.url,
    ]);
    assert.equal(resultado.codigo, 0, `stdout:\n${resultado.saida}\nstderr:\n${resultado.erros}`);

    const texto = readFileSync(arquivoExportado, 'utf8');
    assert.ok(texto.endsWith('\n'), 'o arquivo exportado termina com quebra de linha');
    assert.match(texto, /\n {2}"classe"/, 'o arquivo exportado é JSON indentado');
    assert.deepEqual(
      JSON.parse(texto),
      JSON.parse(readFileSync(GRAFO_FABRICA, 'utf8')),
      'export sem envelope: o que sai é o documento que entrou',
    );
  });

  await t.test('exportar classe desconhecida sai não-zero com grafo_desconhecido', async () => {
    const resultado = await rodarCli(['export', 'classe-que-nao-existe', '--url', primeiro.url], {
      cwd: base,
    });
    assert.notEqual(resultado.codigo, 0);
    assert.match(resultado.erros, /grafo_desconhecido/);
    assert.equal(pareceStackTrace(resultado.erros), false, `stack trace vazou:\n${resultado.erros}`);
  });

  await t.test('round-trip: o arquivo exportado importa em outro control plane com o mesmo id', async () => {
    const segundo = await subirControlPlane(t, {
      caminhoBanco: path.join(base, 'segundo', 'cartografo.db'),
    });

    const resultado = await rodarCli(['import', arquivoExportado, '--url', segundo.url]);
    assert.equal(resultado.codigo, 0, `stdout:\n${resultado.saida}\nstderr:\n${resultado.erros}`);
    assert.equal(
      primeiroHash(resultado.saida),
      versaoImportada,
      'o id da versão é o hash canônico do snapshot: round-trip não pode mudá-lo',
    );
  });
});

test('AT6 — importar grafo inválido imprime as violações do 422', { timeout: 180_000 }, async (t) => {
  const base = areaTemporaria(t);
  const controlPlane = await subirControlPlane(t, {
    caminhoBanco: path.join(base, 'cartografo.db'),
  });

  const resultado = await rodarCli(['import', GRAFO_INVALIDO, '--url', controlPlane.url]);

  assert.notEqual(resultado.codigo, 0, 'grafo inválido não pode sair 0');
  assert.match(resultado.erros, /grafo_invalido/);
  assert.match(resultado.erros, /alcançável/, 'a violação de soundness sai na saída de erro');
  assert.match(resultado.erros, /revisar_lote/, 'a violação sai com o alvo que a quebrou');
  assert.equal(pareceStackTrace(resultado.erros), false, `stack trace vazou:\n${resultado.erros}`);

  const resposta = await fetch(`${controlPlane.url}/v1/classes`);
  assert.deepEqual(await resposta.json(), { classes: [] }, 'grafo recusado não pode ter sido registrado');
});

test('AT7 — importar sem control plane no ar aponta para `cartografo up`, sem stack trace', { timeout: 60_000 }, async () => {
  const porta = await portaLivre();
  const resultado = await rodarCli([
    'import',
    BUNDLE_FABRICA,
    '--url',
    `http://127.0.0.1:${porta}`,
  ]);

  assert.notEqual(resultado.codigo, 0);
  assert.match(resultado.erros, /cartografo up/, 'a mensagem precisa dizer o que fazer');
  assert.equal(pareceStackTrace(resultado.erros), false, `stack trace vazou:\n${resultado.erros}`);
});
