/**
 * The local check and the failure branches of `cartografo import`, in process (t212).
 *
 * `cli-import-export.test.ts` proves the round trip against a real control
 * plane, which is the only thing that can. What it never reaches is the half of
 * this file that exists for things going WRONG: a bundle whose pin does not
 * match, a registry that refuses the fourth manifest, a control plane that
 * answers 422 with a list of violated rules. `import.ts` read 92 % of lines and
 * 36 % of branches for exactly that reason.
 *
 * Two surfaces are covered here, and they are different in kind:
 *
 * - **`verifyBundle`** is pure enough to call directly — a directory in, a list
 *   of problems out. It is the check that runs BEFORE any request, and its
 *   contract is that it reports EVERY problem instead of the first one: whoever
 *   is fixing a bundle needs the whole list. So the tests below break one thing
 *   at a time in a copy of factory bundle 1 (D14) and read the list back.
 * - **`runImport`** is driven against a scripted control plane, which is what
 *   makes "the registry refused a skill" a fixture instead of a broken server.
 *   The rule it keeps is the one D4 pays for: when a manifest is refused, the
 *   graph is NEVER sent — a lineage pointing at a skill the registry does not
 *   have is a class nobody can dispatch.
 *
 * The copies are of the real factory bundle rather than of a hand-written graph,
 * so a change to the graph format cannot leave this file passing against a
 * fixture nobody validates.
 *
 * English per D18; the wire codes (`grafo_invalido`, `classe_ja_registrada`) and
 * the manifest field names are the formats' own.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runImport, verifyBundle, type BundleProblem } from '../src/cli/import.ts';
import { UsageError } from '../src/cli/url.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import { FACTORY_BUNDLE, temporaryArea, type TestHook } from './cli-support.ts';
import { capture, startFakeControlPlane, type FakeAnswer } from './cli-unit-support.ts';

/** The graph document of factory bundle 1, read fresh. */
function graphOf(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(directory, 'grafo.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeGraph(directory: string, document: unknown): void {
  writeFileSync(path.join(directory, 'grafo.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function manifestOf(directory: string, file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(directory, 'skills', file), 'utf8')) as Record<
    string,
    unknown
  >;
}

function writeManifest(directory: string, file: string, manifest: unknown): void {
  writeFileSync(
    path.join(directory, 'skills', file),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

/**
 * A writable copy of factory bundle 1, with one thing broken on purpose.
 *
 * @param t Test context, so the copy disappears with the test.
 * @param breakIt What to break; the copy is whole when it is left out.
 * @returns Path of the copy.
 */
function bundleCopy(t: TestHook, breakIt: (directory: string) => void = () => {}): string {
  const area = temporaryArea(t, 'cartografo-t212-import-');
  const directory = path.join(area, 'bundle');
  cpSync(FACTORY_BUNDLE, directory, { recursive: true });
  breakIt(directory);
  return directory;
}

/** The messages of the problems of one scope, which is how each test reads the list. */
function messagesOf(problems: BundleProblem[], scope: BundleProblem['scope']): string[] {
  return problems.filter((problem) => problem.scope === scope).map((problem) => problem.message);
}

/** A control plane that accepts every skill and every graph. */
function accepting(): (request: { path: string }) => FakeAnswer {
  return (request) =>
    request.path === '/v1/skills'
      ? { status: 201, body: { id: 'uma-skill' } }
      : {
          status: 201,
          body: {
            grafo: { id: 42, classe: 'desenvolvimento-de-software' },
            grafo_versao: { id: 'sha256:abc' },
          },
        };
}

/* ------------------------------------------------------------ verifyBundle */

test('the factory bundle checks out whole', (t) => {
  const directory = bundleCopy(t);

  assert.deepEqual(
    verifyBundle(directory, graphOf(directory)),
    [],
    'the bundle in the repository is the reference for every failure below',
  );
});

test('a graph that does not validate is reported, by structure and by soundness', (t) => {
  const withoutNodes = bundleCopy(t, (directory) => {
    const document = graphOf(directory);
    delete document.nodes;
    writeGraph(directory, document);
  });
  const structural = messagesOf(verifyBundle(withoutNodes, graphOf(withoutNodes)), 'graph');
  assert.ok(structural.some((message) => message.startsWith('estrutura ')), structural.join('\n'));

  const withoutEdges = bundleCopy(t, (directory) => {
    writeGraph(directory, { ...graphOf(directory), edges: [] });
  });
  const unsound = messagesOf(verifyBundle(withoutEdges, graphOf(withoutEdges)), 'graph');
  assert.ok(
    unsound.some((message) => message.startsWith('soundness ')),
    'a graph with no edge reaches nothing and terminates nowhere',
  );
});

test('a skills directory that cannot be listed stops the check where it is', (t) => {
  const directory = bundleCopy(t, (copy) => rmSync(path.join(copy, 'skills'), { recursive: true }));
  const problems = verifyBundle(directory, graphOf(directory));

  assert.deepEqual(messagesOf(problems, 'bundle'), [`could not list ${path.join(directory, 'skills')}`]);
  assert.deepEqual(messagesOf(problems, 'pin'), [], 'no pin is checked against manifests nobody read');
});

test('a manifest that is not readable JSON is one problem, and the rest is still checked', (t) => {
  const directory = bundleCopy(t, (copy) => {
    writeFileSync(path.join(copy, 'skills', 'refinar-ticket.json'), '{ nem JSON', 'utf8');
  });
  const problems = verifyBundle(directory, graphOf(directory));

  assert.ok(messagesOf(problems, 'manifest').some((message) => message.includes('is not valid JSON')));
  assert.ok(
    messagesOf(problems, 'pin').some((message) => message.includes('no manifest in skills/ with that id')),
    'the node that pinned it is reported too, instead of the check stopping there',
  );
});

test('each rule a manifest has to keep is reported on its own', (t) => {
  const area = temporaryArea(t, 'cartografo-t212-manifests-');
  const directory = path.join(area, 'bundle');
  mkdirSync(path.join(directory, 'skills'), { recursive: true });

  const sound = manifestOf(FACTORY_BUNDLE, 'refinar-ticket.json');
  const withHash = (manifest: Record<string, unknown>): Record<string, unknown> => ({
    ...manifest,
    hash: manifestHash(manifest),
  });

  writeManifest(directory, 'nem-objeto.json', ['not an object']);
  writeManifest(directory, 'sem-campos.json', { id: 'sem-campos' });
  writeManifest(directory, 'ID_ERRADO.json', withHash({ ...sound, id: 'ID_ERRADO' }));
  writeManifest(directory, 'outro-nome.json', withHash({ ...sound, id: 'refinar-ticket' }));
  writeManifest(directory, 'versao-errada.json', withHash({ ...sound, id: 'versao-errada', version: '1.0' }));
  writeManifest(directory, 'papel-errado.json', withHash({ ...sound, id: 'papel-errado', role: 'juiz' }));
  writeManifest(directory, 'hash-torto.json', { ...sound, id: 'hash-torto', hash: 'sha256:xyz' });
  writeManifest(directory, 'hash-mentiroso.json', {
    ...sound,
    id: 'hash-mentiroso',
    instructions: 'outra coisa completamente diferente',
  });

  // The document is the valid factory graph: what is under test here is the
  // manifests, and the pins it carries are reported apart.
  const problems = messagesOf(verifyBundle(directory, graphOf(FACTORY_BUNDLE)), 'manifest');

  const found = (fragment: string): boolean =>
    problems.some((message) => message.includes(fragment));
  assert.ok(found('the manifest has to be a JSON object'), problems.join('\n'));
  assert.ok(found('required field missing: "version"'));
  assert.ok(found('"id" has to be kebab-case'));
  assert.ok(found('has to be the file name without the extension'));
  assert.ok(found('"version" has to be semver'));
  assert.ok(found('"role" has to be work or gate'));
  assert.ok(found('"hash" has to have the shape sha256:<64 hex>'));
  assert.ok(found('a tampered manifest does not run (D4)'));
});

test('two manifests with the same id are a problem of the bundle, not of either file', (t) => {
  const directory = bundleCopy(t, (copy) => {
    writeManifest(copy, 'copia.json', manifestOf(copy, 'refinar-ticket.json'));
  });
  const problems = messagesOf(verifyBundle(directory, graphOf(directory)), 'manifest');

  assert.ok(problems.some((message) => message.includes('repeated id in the bundle: "refinar-ticket"')));
});

test('a pin is checked in each of the three ways it can be wrong', (t) => {
  const missing = bundleCopy(t, (copy) => rmSync(path.join(copy, 'skills', 'refinar-ticket.json')));
  assert.ok(
    messagesOf(verifyBundle(missing, graphOf(missing)), 'pin').some((message) =>
      message.includes('no manifest in skills/ with that id'),
    ),
  );

  // `version` is outside the content hash on purpose (renaming a skill must not
  // invalidate a pin), so bumping it alone is a clean version-only mismatch.
  const bumped = bundleCopy(t, (copy) => {
    writeManifest(copy, 'refinar-ticket.json', {
      ...manifestOf(copy, 'refinar-ticket.json'),
      version: '9.9.9',
    });
  });
  assert.ok(
    messagesOf(verifyBundle(bumped, graphOf(bumped)), 'pin').some((message) =>
      message.includes('pinned version 1.0.0, manifest 9.9.9'),
    ),
  );

  // And `instructions` is inside it, so rewriting the body with an honestly
  // recomputed hash leaves the manifest valid and the PIN stale — which is the
  // case the pin exists for (D4).
  const rewritten = bundleCopy(t, (copy) => {
    const manifest = { ...manifestOf(copy, 'refinar-ticket.json'), instructions: 'faça outra coisa' };
    writeManifest(copy, 'refinar-ticket.json', { ...manifest, hash: manifestHash(manifest) });
  });
  const problems = verifyBundle(rewritten, graphOf(rewritten));
  assert.deepEqual(messagesOf(problems, 'manifest'), [], 'the manifest itself is beyond reproach');
  assert.ok(
    messagesOf(problems, 'pin').some((message) => message.includes('manifest content sha256:')),
  );
});

test('a document with no nodes to pin is checked without complaining about pins', (t) => {
  const directory = bundleCopy(t);

  assert.deepEqual(messagesOf(verifyBundle(directory, 'nem sequer um objeto'), 'pin'), []);
  assert.deepEqual(messagesOf(verifyBundle(directory, { nodes: 'nem lista' }), 'pin'), []);
  assert.deepEqual(
    messagesOf(verifyBundle(directory, { nodes: ['nem objeto'] }), 'pin'),
    [],
    'an entry that is not a node is the graph validator\'s business, not the pin check\'s',
  );
  assert.deepEqual(messagesOf(verifyBundle(directory, { nodes: [{ id: 'sem-skill' }] }), 'pin'), [
    'node "sem-skill" → skill "undefined": no manifest in skills/ with that id',
  ]);
});

/* ---------------------------------------------------------------- runImport */

test('a path that does not exist never becomes a request', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());

  await assert.rejects(
    capture(() => runImport({ path: '/nao/existe/grafo.json', url: plane.url })),
    UsageError,
  );
  assert.deepEqual(plane.requests, []);
});

test('a bundle directory with no grafo.json says so instead of failing on a read', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const area = temporaryArea(t, 'cartografo-t212-import-');

  await assert.rejects(
    capture(() => runImport({ path: area, url: plane.url })),
    (error: unknown) => error instanceof UsageError && /could not read/.test(error.message),
  );
});

test('a file that is not valid JSON says where it broke', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const area = temporaryArea(t, 'cartografo-t212-import-');
  const file = path.join(area, 'grafo.json');
  writeFileSync(file, '{ "nodes": [', 'utf8');

  await assert.rejects(
    capture(() => runImport({ path: file, url: plane.url })),
    (error: unknown) => error instanceof UsageError && /is not valid JSON/.test(error.message),
  );
  assert.deepEqual(plane.requests, []);
});

test('a graph file goes straight to the control plane, with no registry step', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const directory = bundleCopy(t);

  const run = await capture(() =>
    runImport({ path: path.join(directory, 'grafo.json'), url: plane.url }),
  );

  assert.equal(run.code, 0);
  assert.match(run.stdout, /graph imported/);
  assert.match(run.stdout, /grafo_versao\.id\s+sha256:abc/);
  assert.deepEqual(
    plane.requests.map((request) => `${request.method} ${request.path}`),
    ['POST /v1/graphs'],
    'a bare file has no manifest to offer, so the registry is never called',
  );
});

test('a directory with no skills/ is imported as a plain graph', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const area = temporaryArea(t, 'cartografo-t212-import-');
  const directory = path.join(area, 'sem-skills');
  mkdirSync(directory, { recursive: true });
  writeGraph(directory, graphOf(FACTORY_BUNDLE));

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 0);
  assert.deepEqual(
    plane.requests.map((request) => request.path),
    ['/v1/graphs'],
  );
});

test('a bundle offers every manifest to the registry before the graph', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const directory = bundleCopy(t);

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 0);
  assert.match(run.stdout, /skills\s+5 registered, 0 already in the registry/);
  assert.deepEqual(
    plane.requests.map((request) => request.path),
    ['/v1/skills', '/v1/skills', '/v1/skills', '/v1/skills', '/v1/skills', '/v1/graphs'],
    'the manifests go up first: a lineage pinning a skill the registry lacks is undispatchable',
  );
});

test('a manifest the registry already has is a reimport, not a failure', async (t) => {
  const plane = await startFakeControlPlane(t, (request) =>
    request.path === '/v1/skills' ? { status: 409, body: { erro: 'skill_ja_registrada' } } : accepting()(request),
  );
  const directory = bundleCopy(t);

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 0, 'registration is create-only, so the second import finds them there');
  assert.match(run.stdout, /skills\s+0 registered, 5 already in the registry/);
});

test('a manifest the registry refuses stops the import, and the graph is never sent', async (t) => {
  const plane = await startFakeControlPlane(t, (request) =>
    request.path === '/v1/skills'
      ? { status: 422, body: { error: 'manifesto_invalido', details: ['checks: at least one'] } }
      : accepting()(request),
  );
  const directory = bundleCopy(t);

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /the registry refused a skill \(HTTP 422\)/);
  assert.match(run.stderr, /manifesto_invalido/);
  assert.match(run.stderr, /checks: at least one/);
  assert.match(run.stderr, /the graph was not sent to the control plane/);
  assert.deepEqual(
    plane.requests.map((request) => request.path),
    ['/v1/skills'],
    'it stops at the first refusal instead of offering the rest',
  );
});

test('a refusal with nothing in the body is still a refusal', async (t) => {
  const plane = await startFakeControlPlane(t, (request) =>
    request.path === '/v1/skills' ? { status: 500, text: 'upstream exploded' } : accepting()(request),
  );
  const directory = bundleCopy(t);

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /the registry refused a skill \(HTTP 500\)/);
});

test('an invalid bundle never becomes a request at all', async (t) => {
  const plane = await startFakeControlPlane(t, accepting());
  const directory = bundleCopy(t, (copy) => {
    writeManifest(copy, 'refinar-ticket.json', {
      ...manifestOf(copy, 'refinar-ticket.json'),
      version: '9.9.9',
    });
  });

  const run = await capture(() => runImport({ path: directory, url: plane.url }));

  assert.equal(run.code, 1);
  assert.match(run.stderr, /invalid bundle/);
  assert.match(run.stderr, /pin\s+node "refinar"/);
  assert.match(run.stderr, /nothing was sent to the control plane/);
  assert.deepEqual(plane.requests, [], 'a broken pin never becomes a request (D4)');
});

test('a class already registered comes back as classe_ja_registrada', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({
    status: 409,
    body: { erro: 'classe_ja_registrada', mensagem: 'a classe desenvolvimento-de-software já existe' },
  }));
  const directory = bundleCopy(t);

  const run = await capture(() =>
    runImport({ path: path.join(directory, 'grafo.json'), url: plane.url }),
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /classe_ja_registrada — a classe desenvolvimento-de-software já existe/);
});

test('a graph the control plane refuses is printed rule by rule', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({
    status: 422,
    body: {
      estrutura: { erros: [{ codigo: 'campo_obrigatorio_ausente', mensagem: '"nodes" is missing' }] },
      soundness: { violacoes: [{ regra: 'alcançável', alvo: { no: 'implantar' } }] },
    },
  }));
  const directory = bundleCopy(t);

  const run = await capture(() =>
    runImport({ path: path.join(directory, 'grafo.json'), url: plane.url }),
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /grafo_invalido/);
  assert.match(run.stderr, /estrutura {2}campo_obrigatorio_ausente: "nodes" is missing/);
  assert.match(run.stderr, /soundness {2}alcançável: \{"no":"implantar"\}/);
});

test('a 422 with nothing to list is still a refusal, not a crash', async (t) => {
  const plane = await startFakeControlPlane(t, () => ({ status: 422, body: {} }));
  const directory = bundleCopy(t);

  const run = await capture(() =>
    runImport({ path: path.join(directory, 'grafo.json'), url: plane.url }),
  );

  assert.equal(run.code, 1);
  assert.match(run.stderr, /grafo_invalido/);
});

test('any other refusal of the graph is printed with what came with it', async (t) => {
  const directory = bundleCopy(t);
  const graphPath = path.join(directory, 'grafo.json');

  const detailed = await startFakeControlPlane(t, () => ({
    status: 503,
    body: { erro: 'indisponivel', mensagem: 'o núcleo está reindexando' },
  }));
  const withBody = await capture(() => runImport({ path: graphPath, url: detailed.url }));
  assert.equal(withBody.code, 1);
  assert.match(withBody.stderr, /HTTP 503\) — indisponivel: o núcleo está reindexando/);

  const silent = await startFakeControlPlane(t, () => ({ status: 500, text: '' }));
  const withoutBody = await capture(() => runImport({ path: graphPath, url: silent.url }));
  assert.equal(withoutBody.code, 1);
  assert.match(withoutBody.stderr, /refused the graph \(HTTP 500\)/);
});
