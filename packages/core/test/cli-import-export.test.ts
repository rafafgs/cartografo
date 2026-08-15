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
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * The five manifests of the factory bundle, in the order `GET /v1/skills`
 * returns them (t135, FR4).
 *
 * Written out instead of read from `skills/*.json`: the point of the assertion
 * is that importing the bundle populates the registry with exactly THESE
 * capabilities — the ones the synthesizer's "consultar capacidades" step will
 * find — and a list the test derives from the same directory the CLI read would
 * agree with an import that registered nothing but a coincidence.
 */
const FACTORY_SKILL_IDS = [
  'desenvolver-ticket',
  'implantar-release',
  'integrar-branch',
  'refinar-ticket',
  'testar-alpha',
];

/** A registered skill, in the part these tests read. */
interface RegisteredSkill {
  id: string;
  origem: { tipo: string };
}

/** Sorts keys recursively — same canonicalization the format's hash is defined over. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonical(source[key]);
    return sorted;
  }
  return value;
}

/** The pin, recomputed here on purpose (see `skill-routes.test.ts`). */
function contentHash(manifest: Record<string, unknown>): string {
  const subset = {
    instrucoes: manifest.instrucoes,
    entrada: manifest.entrada,
    saida: manifest.saida,
    checks: manifest.checks,
    permissoes: manifest.permissoes,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(subset)), 'utf8').digest('hex')}`;
}

/** Every skill the registry holds, by id. */
async function registeredSkills(url: string): Promise<RegisteredSkill[]> {
  const response = await fetch(`${url}/v1/skills`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { skills: RegisteredSkill[] };
  return body.skills;
}

test('AT5 — importing the factory bundle, refusing a reimport, exporting and the round trip', { timeout: 300_000 }, async (t) => {
  const base = temporaryArea(t);
  const first = await startControlPlane(t, {
    databasePath: path.join(base, 'primeiro', 'cartografo.db'),
  });

  let importedVersion = '';

  await t.test('importing the factory bundle registers the class', async () => {
    const result = await runCli(['import', FACTORY_BUNDLE, '--url', first.url], { token: first.token });
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

    // t135, FR4: the graph is only half the bundle — the capabilities its nodes
    // pin have to be in the registry, or the class is imported with nothing to
    // dispatch.
    const skills = await registeredSkills(first.url);
    assert.deepEqual(
      skills.map((skill) => skill.id),
      FACTORY_SKILL_IDS,
      'importing the bundle registers every manifest in skills/',
    );
    for (const skill of skills) {
      assert.equal(skill.origem.tipo, 'nativa', `${skill.id} is in-repo content, not an import`);
    }
  });

  await t.test('importing the same bundle again is refused with classe_ja_registrada', async () => {
    const result = await runCli(['import', FACTORY_BUNDLE, '--url', first.url], { token: first.token });
    assert.notEqual(result.code, 0, 'reimporting over an existing lineage cannot exit 0');
    assert.match(result.stderr, /classe_ja_registrada/);
    assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);
  });

  await t.test('reimporting is idempotent for the registry: the 409s are not errors', async () => {
    const result = await runCli(['import', FACTORY_BUNDLE, '--url', first.url], { token: first.token });

    assert.notEqual(result.code, 0, 'the class is still already registered');
    assert.match(result.stderr, /classe_ja_registrada/);
    assert.doesNotMatch(
      result.stderr,
      /skill_already_registered/,
      'an already-registered manifest is the expected outcome of a reimport, not a failure',
    );

    const skills = await registeredSkills(first.url);
    assert.deepEqual(
      skills.map((skill) => skill.id),
      FACTORY_SKILL_IDS,
      'a second import neither duplicates nor drops a registration',
    );
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
    ], { token: first.token });
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
      token: first.token,
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

    const result = await runCli(['import', exportedFile, '--url', second.url], { token: second.token });
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

  const result = await runCli(['import', INVALID_GRAPH, '--url', controlPlane.url], { token: controlPlane.token });

  assert.notEqual(result.code, 0, 'an invalid graph cannot exit 0');
  assert.match(result.stderr, /grafo_invalido/);
  assert.match(result.stderr, /alcançável/, 'the soundness violation comes out on the error output');
  assert.match(result.stderr, /revisar_lote/, 'the violation comes out with the target that broke it');
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);

  const response = await fetch(`${controlPlane.url}/v1/classes`);
  assert.deepEqual(await response.json(), { classes: [] }, 'a refused graph cannot have been registered');
});

test('AT8 — a manifest the registry refuses stops the import before the graph (t135)', { timeout: 180_000 }, async (t) => {
  const base = temporaryArea(t);
  const controlPlane = await startControlPlane(t, {
    databasePath: path.join(base, 'cartografo.db'),
  });

  // A bundle whose local check passes and whose REGISTRY check does not: the
  // agentic check loses its `evidencia_obrigatoria`, and both pins — the
  // manifest's own and the node's `skill_ref` — are regenerated over the
  // mutation, which is exactly what `verifyBundle` looks at. What is left for
  // the control plane to catch is the schema rule the CLI never checked.
  const bundle = path.join(base, 'bundle-sem-evidencia');
  cpSync(FACTORY_BUNDLE, bundle, { recursive: true });

  const manifestPath = path.join(bundle, 'skills', 'refinar-ticket.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  const checks = manifest.checks as Record<string, unknown>[];
  const broken = checks.find((check) => check.tipo === 'agentico');
  assert.ok(broken !== undefined, 'the fixture assumes refinar-ticket has an agentic check');
  delete broken.evidencia_obrigatoria;
  manifest.hash = contentHash(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const graphPath = path.join(bundle, 'grafo.json');
  const document = JSON.parse(readFileSync(graphPath, 'utf8')) as Record<string, unknown>;
  let repinned = 0;
  for (const node of document.nos as Record<string, unknown>[]) {
    const ref = node.skill_ref as Record<string, unknown> | undefined;
    if (ref?.id !== 'refinar-ticket') continue;
    ref.hash = manifest.hash;
    repinned += 1;
  }
  assert.ok(repinned > 0, 'the fixture assumes some node pins refinar-ticket');
  writeFileSync(graphPath, `${JSON.stringify(document, null, 2)}\n`);

  const result = await runCli(['import', bundle, '--url', controlPlane.url], { token: controlPlane.token });

  assert.notEqual(result.code, 0, 'a manifest the registry refuses cannot exit 0');
  assert.match(result.stderr, /refinar-ticket/, 'the output names the manifest that was refused');
  assert.match(result.stderr, /evidencia_obrigatoria/, "the registry's own reason comes out");
  assert.equal(looksLikeStackTrace(result.stderr), false, `a stack trace leaked:\n${result.stderr}`);

  const classes = await fetch(`${controlPlane.url}/v1/classes`);
  assert.deepEqual(
    await classes.json(),
    { classes: [] },
    'the graph is never sent once a manifest is refused',
  );

  const refused = await fetch(`${controlPlane.url}/v1/skills/refinar-ticket`);
  assert.equal(refused.status, 404, 'the refused manifest cannot have been registered');
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
