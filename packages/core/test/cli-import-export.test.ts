/**
 * Acceptance tests of `import` and `export` (t108, FR2/FR3/FR4).
 *
 * The central test is the round trip: exporting from one control plane and
 * importing into ANOTHER, with an empty database, has to produce the same
 * `grafo_versao.id`. That only closes if the export returns the snapshot without
 * touching it — the id is the canonical hash of the document
 * (`docs/spec/entidades-versionamento.md` §2), so any field added, removed or
 * rewritten along the way shows up as a different hash. It is the proof that the
 * import/export pair preserves the data, and not merely that the two commands
 * run.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FACTORY_BUNDLE,
  REPO_ROOT,
  temporaryArea,
  looksLikeStackTrace,
  freePort,
  firstHash,
  runCli,
  startControlPlane,
} from './cli-support.ts';

const FACTORY_CLASS = 'desenvolvimento-de-software';
const FACTORY_GRAPH = path.join(FACTORY_BUNDLE, 'grafo.json');
const INVALID_GRAPH = path.join(REPO_ROOT, 'schema', 'exemplos', 'grafo-invalido-no-inalcancavel.json');

test('AT5 — importing the factory bundle, refusing a reimport, exporting and the round trip', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t);
  const first = await startControlPlane(t, {
    databasePath: path.join(base, 'primeiro', 'cartografo.db'),
  });

  let importedVersion = '';

  await t.test('importing the factory bundle registers the class', async () => {
    const result = await runCli(['import', FACTORY_BUNDLE, '--url', first.url]);
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(FACTORY_CLASS));
    importedVersion = firstHash(result.stdout);

    const response = await fetch(`${first.url}/v1/classes`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      classes: { classe: string; versao_corrente_id: string }[];
    };
    assert.deepEqual(
      body.classes.map((entry) => entry.classe),
      [FACTORY_CLASS],
    );
    assert.equal(body.classes[0]?.versao_corrente_id, importedVersion);
  });

  await t.test('importing the same bundle again is refused with classe_ja_registrada', async () => {
    const result = await runCli(['import', FACTORY_BUNDLE, '--url', first.url]);
    assert.notEqual(result.code, 0, 'reimporting over an existing lineage cannot exit 0');
    assert.match(result.stderr, /classe_ja_registrada/);
    assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
  });

  const exportedFile = path.join(base, 'saida.grafo.json');

  await t.test('exporting returns the same document as the source grafo.json', async () => {
    const result = await runCli([
      'export',
      FACTORY_CLASS,
      '--out',
      exportedFile,
      '--url',
      first.url,
    ]);
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const text = readFileSync(exportedFile, 'utf8');
    assert.ok(text.endsWith('\n'), 'the exported file ends with a line break');
    assert.match(text, /\n {2}"classe"/, 'the exported file is indented JSON');
    assert.deepEqual(
      JSON.parse(text),
      JSON.parse(readFileSync(FACTORY_GRAPH, 'utf8')),
      'export with no envelope: what comes out is the document that went in',
    );
  });

  await t.test('exporting an unknown class exits non-zero with grafo_desconhecido', async () => {
    const result = await runCli(['export', 'classe-que-nao-existe', '--url', first.url], {
      cwd: base,
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /grafo_desconhecido/);
    assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
  });

  await t.test('round trip: the exported file imports into another control plane with the same id', async () => {
    const second = await startControlPlane(t, {
      databasePath: path.join(base, 'segundo', 'cartografo.db'),
    });

    const result = await runCli(['import', exportedFile, '--url', second.url]);
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(
      firstHash(result.stdout),
      importedVersion,
      'the version id is the canonical hash of the snapshot: a round trip cannot change it',
    );
  });
});

test('AT6 — importing an invalid graph prints the violations of the 422', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });

  const result = await runCli(['import', INVALID_GRAPH, '--url', controlPlane.url]);

  assert.notEqual(result.code, 0, 'an invalid graph cannot exit 0');
  assert.match(result.stderr, /grafo_invalido/);
  assert.match(result.stderr, /alcançável/, 'the soundness violation comes out on the error output');
  assert.match(result.stderr, /revisar_lote/, 'the violation comes out with the target that broke it');
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);

  const response = await fetch(`${controlPlane.url}/v1/classes`);
  assert.deepEqual(await response.json(), { classes: [] }, 'a refused graph cannot have been registered');
});

test('AT7 — importing with no control plane running points at `cartografo up`, with no stack trace', { timeout: 60_000 }, async () => {
  const port = await freePort();
  const result = await runCli([
    'import',
    FACTORY_BUNDLE,
    '--url',
    `http://127.0.0.1:${port}`,
  ]);

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cartografo up/, 'the message has to say what to do');
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
});
