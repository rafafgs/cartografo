/**
 * Testes de aceite do portão de single-writer (t100, FR6/FR7).
 *
 * Cobrem a função exportada e o CLI de `scripts/check-single-writer.mjs`, com
 * fixtures positivo e negativos escritos em diretório temporário.
 *
 * ATENÇÃO ao escrever fixture aqui: este arquivo é varrido pelo próprio script
 * quando `npm run lint` roda na raiz. Por isso NENHUMA linha abaixo escreve
 * literalmente o nome de um driver nem o caminho `packages/core/src/db` dentro
 * de um `import ... from '...'` — tudo entra por interpolação das constantes
 * exportadas pelo script. Um literal aqui viraria violação real no lint.
 *
 * Rodar: `npm test` na raiz.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const RAIZ = path.resolve(import.meta.dirname, '..');
const CAMINHO_SCRIPT = path.join(RAIZ, 'scripts', 'check-single-writer.mjs');

let moduloScript = null;

async function carregarScript() {
  assert.ok(existsSync(CAMINHO_SCRIPT), 'artefato ainda não existe: scripts/check-single-writer.mjs');
  moduloScript ??= await import(new URL('./check-single-writer.mjs', import.meta.url));
  return moduloScript;
}

function areaTemporaria(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'cartografo-t100-swriter-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function escrever(raiz, relativo, conteudo) {
  const destino = path.join(raiz, relativo);
  mkdirSync(path.dirname(destino), { recursive: true });
  writeFileSync(destino, conteudo, 'utf8');
}

/**
 * Monta a árvore de fixture base: core com o driver no lugar certo, tela sem
 * nenhum privilégio. `ajustes` sobrescreve arquivos para produzir cada negativo.
 */
function montarArvore(raiz, { DRIVERS_SQLITE, SEGMENTO_DONO_DO_BANCO }, ajustes = {}) {
  const arquivos = {
    'packages/core/package.json': JSON.stringify(
      { name: 'cartografo', dependencies: { [DRIVERS_SQLITE[0]]: '^13.0.0' } },
      null,
      2,
    ),
    'packages/core/src/db/connection.ts':
      `import Database from '${DRIVERS_SQLITE[0]}';\n` +
      `export const abrir = () => new Database(':memory:');\n`,
    'packages/core/src/server.ts':
      `import { abrir } from './db/connection.ts';\nexport const app = abrir;\n`,
    // Teste do próprio core alcançando o módulo de banco: legítimo, porque o
    // que é privado é o pacote, não a pasta `src/`.
    'packages/core/test/connection.test.ts':
      `import { abrir } from '../${SEGMENTO_DONO_DO_BANCO.split('/').slice(1).join('/')}/connection.ts';\n` +
      `export const alvo = abrir;\n`,
    'packages/tela/package.json': JSON.stringify(
      { name: '@cartografo/tela', dependencies: {} },
      null,
      2,
    ),
    'packages/tela/src/index.ts': `export const saude = (url) => fetch(url + '/health');\n`,
    ...ajustes,
  };
  for (const [relativo, conteudo] of Object.entries(arquivos)) {
    escrever(raiz, relativo, conteudo);
  }
  return raiz;
}

function rodarCli(...args) {
  const resultado = spawnSync(process.execPath, [CAMINHO_SCRIPT, ...args], { encoding: 'utf8' });
  return { status: resultado.status, stdout: resultado.stdout ?? '', stderr: resultado.stderr ?? '' };
}

test('AT10 — extrairImports pega import, export-from, import() e require()', async () => {
  const { extrairImports } = await carregarScript();

  const codigo = [
    "import fs from 'node:fs';",
    'import { a, b } from "./modulo-a.ts";',
    "import './efeito-colateral.ts';",
    "export { c } from './modulo-c.ts';",
    "export * from './modulo-d.ts';",
    "const tardio = await import('./modulo-e.ts');",
    "const velho = require('pacote-cjs');",
    "const naoEhImport = 'pacote-que-so-aparece-em-string';",
  ].join('\n');

  const achados = extrairImports(codigo);
  for (const esperado of [
    'node:fs',
    './modulo-a.ts',
    './efeito-colateral.ts',
    './modulo-c.ts',
    './modulo-d.ts',
    './modulo-e.ts',
    'pacote-cjs',
  ]) {
    assert.ok(achados.includes(esperado), `extrairImports precisa achar "${esperado}"`);
  }
  assert.ok(
    !achados.includes('pacote-que-so-aparece-em-string'),
    'string solta não é import: só conta o que está em posição de especificador',
  );
});

test('AT11 — árvore com o driver só sob o caminho permitido sai 0', async (t) => {
  const script = await carregarScript();
  const raiz = montarArvore(areaTemporaria(t), script);

  const relatorio = script.verificar(raiz);
  assert.deepEqual(relatorio.violacoes, []);
  assert.equal(relatorio.valido, true);

  const cli = rodarCli(raiz);
  assert.equal(cli.status, 0, `CLI devia sair 0:\n${cli.stdout}${cli.stderr}`);
});

test('AT12 — import do driver fora do dono sai 1 e reporta o arquivo', async (t) => {
  const script = await carregarScript();
  const { DRIVERS_SQLITE } = script;
  const raiz = montarArvore(areaTemporaria(t), script, {
    'packages/core/src/server.ts':
      `import Database from '${DRIVERS_SQLITE[0]}';\nexport const app = () => new Database(':memory:');\n`,
  });

  const relatorio = script.verificar(raiz);
  assert.equal(relatorio.valido, false);

  const violacao = relatorio.violacoes.find((v) => v.codigo === 'driver_fora_do_dono');
  assert.ok(violacao, 'violação esperada: driver_fora_do_dono');
  assert.equal(violacao.arquivo, 'packages/core/src/server.ts');
  assert.equal(violacao.alvo, DRIVERS_SQLITE[0]);

  const cli = rodarCli(raiz);
  assert.equal(cli.status, 1);
  const relato = `${cli.stdout}${cli.stderr}`;
  assert.ok(relato.includes('packages/core/src/server.ts'), 'o CLI precisa nomear o arquivo culpado');
  assert.ok(relato.includes(DRIVERS_SQLITE[0]), 'o CLI precisa nomear o driver importado');
});

test('AT13 — módulo fora do core importando o banco privado sai 1', async (t) => {
  const script = await carregarScript();
  const { SEGMENTO_DONO_DO_BANCO } = script;
  const raiz = montarArvore(areaTemporaria(t), script, {
    'packages/tela/src/index.ts':
      `import { abrir } from '../../${SEGMENTO_DONO_DO_BANCO}/connection.ts';\n` +
      `export const saude = abrir;\n`,
  });

  const relatorio = script.verificar(raiz);
  assert.equal(relatorio.valido, false);
  const violacao = relatorio.violacoes.find((v) => v.codigo === 'db_privado_importado');
  assert.ok(violacao, 'violação esperada: db_privado_importado');
  assert.equal(violacao.arquivo, 'packages/tela/src/index.ts');

  assert.equal(rodarCli(raiz).status, 1);

  // Mesma varredura, agora com a raiz apontando só para a tela (FR7).
  const soATela = script.verificar(path.join(raiz, 'packages', 'tela'));
  assert.equal(soATela.valido, false);
  assert.ok(soATela.violacoes.some((v) => v.codigo === 'db_privado_importado'));
  assert.equal(rodarCli(path.join(raiz, 'packages', 'tela')).status, 1);
});

test('AT14 — pacote fora do core declarando o driver como dependência sai 1', async (t) => {
  const script = await carregarScript();
  const { DRIVERS_SQLITE } = script;
  const raiz = montarArvore(areaTemporaria(t), script, {
    'packages/tela/package.json': JSON.stringify(
      { name: '@cartografo/tela', dependencies: { [DRIVERS_SQLITE[0]]: '^13.0.0' } },
      null,
      2,
    ),
  });

  const relatorio = script.verificar(raiz);
  assert.equal(relatorio.valido, false);
  const violacao = relatorio.violacoes.find((v) => v.codigo === 'driver_declarado_fora_do_core');
  assert.ok(violacao, 'violação esperada: driver_declarado_fora_do_core');
  assert.equal(violacao.arquivo, 'packages/tela/package.json');

  assert.equal(rodarCli(raiz).status, 1);
});

test('AT15 — o repositório de verdade passa no portão', async () => {
  const { verificar } = await carregarScript();
  const relatorio = verificar(RAIZ);
  assert.deepEqual(relatorio.violacoes, []);
  assert.equal(relatorio.valido, true);

  assert.equal(rodarCli().status, 0, 'o CLI sem argumento varre a raiz do repo');
});
