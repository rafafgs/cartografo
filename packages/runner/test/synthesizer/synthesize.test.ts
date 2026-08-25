/**
 * Acceptance tests of the synthesis run (t115, AT4).
 *
 * Three claims, one per test, and each one is a boundary of D10's copilot
 * posture:
 *
 * 1. a class that already has a base graph is refused BEFORE any session opens
 *    — extending a registered lineage is the proposal flow (D13, t118), and
 *    burning a session to find that out is the wrong order;
 * 2. a session that returns nothing usable writes NOTHING to disk. A partial
 *    draft is worse than no draft: it looks like something a human could edit;
 * 3. a session that returns a document lands it as a draft file, and stops
 *    there. No `POST /v1/graphs` — registration is `cartografo import` (t108),
 *    run by a person after they edited the file.
 *
 * The engine is real (`ClaudeCodeAdapter` driving `test/fixtures/fake-engine.mjs`,
 * the same seam the conformance kit uses); only the control plane is faked,
 * because what this ficha proves is the runner's behaviour, not the routes of
 * t101/t117 — which have their own suites.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type {
  EngineAdapter,
  EngineCapabilities,
  SessionListener,
  SessionSpec,
  SessionStatus,
} from '../../src/engine/types.ts';
import type * as ClientModule from '../../src/synthesizer/control-plane-client.ts';
import type * as SynthesisModule from '../../src/synthesizer/synthesize.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/synthesizer/synthesize.ts';
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

let cache: typeof SynthesisModule | null = null;

async function loadSynthesis(): Promise<typeof SynthesisModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/synthesize.ts', import.meta.url).href
  )) as typeof SynthesisModule;
  return cache;
}

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** A scratch directory that cleans itself up. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t115-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The `claude` argv handed whole to the fake engine — only the binary changes. */
function fakeAdapter(lines: string[]): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    environmentBuilder: () => ({
      ...process.env,
      FAKE_ENGINE_LINES: JSON.stringify(lines.map((text) => ({ stream: 'stdout', text }))),
    }),
    graceMs: 300,
  });
}

/** Counts sessions without changing anything the adapter does. */
class CountingAdapter implements EngineAdapter {
  readonly engineName: string;
  sessions = 0;
  readonly #inner: EngineAdapter;

  constructor(inner: EngineAdapter) {
    this.#inner = inner;
    this.engineName = inner.engineName;
  }

  async startSession(spec: SessionSpec, listener: SessionListener): Promise<string> {
    this.sessions += 1;
    return await this.#inner.startSession(spec, listener);
  }

  async getStatus(sessionId: string): Promise<SessionStatus> {
    return await this.#inner.getStatus(sessionId);
  }

  async cancel(sessionId: string, status?: SessionStatus): Promise<void> {
    await this.#inner.cancel(sessionId, status);
  }

  capabilities(): EngineCapabilities {
    return this.#inner.capabilities();
  }

  async verifyCli(): ReturnType<EngineAdapter['verifyCli']> {
    return await this.#inner.verifyCli();
  }
}

const SKILLS: ClientModule.RegisteredSkill[] = [
  {
    id: 'cartografo/redigir-nota',
    version: '1.0.0',
    hash: `sha256:${'a'.repeat(64)}`,
    role: 'skill',
    description: 'Escreve a nota a partir do tema declarado.',
    input: { type: 'object' },
    output: { type: 'object' },
    checks: [{ type: 'deterministic', comando: 'test -s nota.md' }],
  },
];

const EXISTING_VERSION: ClientModule.GraphVersion = {
  id: 'sha256:aaa',
  graph_id: 'nota-curta',
  snapshot: {
    metadata: {
      nome: 'Nota curta',
      description: 'Redigir e revisar uma nota curta sobre um tema declarado.',
      schema_version: '1.0.0',
    },
  },
};

/** The control plane, faked at the three reads this ficha consumes. */
function fakeClient(classes: ClientModule.ClassEntry[]): ClientModule.ControlPlaneReader & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async fetchClasses() {
      calls.push('GET /v1/classes');
      return classes;
    },
    async fetchClassVersion(versionId: string) {
      calls.push(`GET /v1/graph-versions/${versionId}`);
      return EXISTING_VERSION;
    },
    async fetchSkills() {
      calls.push('GET /v1/skills');
      return SKILLS;
    },
  };
}

/** A graph document, in the shape of `schema/graph.schema.json`. */
function proposedGraph(className: string): Record<string, unknown> {
  return {
    problem_class: className,
    lineage: { tipo: 'base' },
    metadata: { nome: className, schema_version: '1.0.0' },
    nodes: [
      {
        id: 'redigir',
        role: 'redator',
        node_type: 'work',
        skill_ref: { id: SKILLS[0].id, version: SKILLS[0].version, hash: SKILLS[0].hash },
        contract: { input_schema: {}, output_schema: {}, checks: [] },
      },
      {
        id: 'revisar',
        role: 'revisor',
        node_type: 'gate',
        skill_ref: { id: SKILLS[0].id, version: SKILLS[0].version, hash: SKILLS[0].hash },
        contract: { input_schema: {}, output_schema: {}, checks: [] },
      },
    ],
    edges: [{ from: 'redigir', to: 'revisar', condition: 'sempre' }],
    initial_node: 'redigir',
    final_nodes: ['revisar'],
  };
}

const DECLARATION = 'Quero um fluxo que redige e revisa uma nota curta sobre um tema declarado.';

/**
 * One line of what a REAL `ClaudeCodeAdapter` session prints (t148).
 *
 * The adapter hands `onOutput` whatever the `claude` CLI put on stdout, and with
 * `--output-format stream-json` that is one frame per line: the answer's own
 * quotes arrive as `\"` and its newlines as `\n`, inside `result`. Every fake
 * engine in this file prints prose instead, which is precisely why a synthesizer
 * that fed raw lines to the fence scanner stayed green here and exited 1 on
 * every real run.
 */
function resultFrame(answer: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', result: answer });
}

test('AT4a — a class that already has a base graph is refused without opening a session', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const client = fakeClient([
    { class: 'nota-curta', current_version_id: EXISTING_VERSION.id },
  ]);
  const adapter = new CountingAdapter(fakeAdapter(['should never run']));
  const dir = scratch(t, 'ja-registrada');

  const out: string[] = [];
  const err: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'nota-curta',
    client,
    adapter,
    workingDir: dir,
    cwd: dir,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  });

  assert.equal(code, 1);
  assert.match(err.join(''), /class_already_registered/);
  assert.equal(adapter.sessions, 0, 'the refusal comes before any session (D13: fork is t118)');
  assert.ok(
    !client.calls.includes('GET /v1/skills'),
    'a refused class does not even need the catalogue',
  );
  assert.deepEqual(readdirSync(dir), [], 'a refused class writes nothing');
});

test('AT4b — a session that returns no valid block exits 1 and writes nothing', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const client = fakeClient([{ class: 'nota-curta', current_version_id: EXISTING_VERSION.id }]);
  const adapter = new CountingAdapter(
    fakeAdapter([
      'I looked at the catalogue and could not compose a topology.',
      '```grafo-proposto',
      '{"classe": "half-writ',
      '```',
    ]),
  );
  const dir = scratch(t, 'sem-bloco');

  const out: string[] = [];
  const err: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'artigo-revisado',
    client,
    adapter,
    workingDir: dir,
    cwd: dir,
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  });

  assert.equal(code, 1);
  assert.equal(adapter.sessions, 1, 'the session did open — this is the failure after it');
  assert.ok(
    !existsSync(path.join(dir, 'artigo-revisado.grafo.rascunho.json')),
    'never a partial or invalid draft',
  );
  assert.match(
    err.join('') + out.join(''),
    /could not compose a topology/,
    'the raw session output is printed, or the failure is unreadable',
  );
});

test('AT4c — a valid block lands the draft file and the one-line summary', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const document = proposedGraph('artigo-revisado');
  const client = fakeClient([{ class: 'nota-curta', current_version_id: EXISTING_VERSION.id }]);
  const adapter = new CountingAdapter(
    fakeAdapter([
      'Composed from the registered capabilities:',
      '```grafo-proposto',
      ...JSON.stringify(document, null, 2).split('\n'),
      '```',
    ]),
  );
  const dir = scratch(t, 'sucesso');

  const out: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'artigo-revisado',
    client,
    adapter,
    workingDir: dir,
    cwd: dir,
    write: (text) => out.push(text),
    writeError: (text) => out.push(text),
  });

  assert.equal(code, 0, `the run failed:\n${out.join('')}`);

  const draft = path.join(dir, 'artigo-revisado.grafo.rascunho.json');
  assert.ok(existsSync(draft), 'the draft is written next to where the person is working');

  const raw = readFileSync(draft, 'utf8');
  assert.deepEqual(JSON.parse(raw), document, 'the document lands exactly as parsed');
  assert.ok(
    raw.includes('\n  "problem_class"'),
    'indented with 2 spaces: a human is going to edit it',
  );

  const printed = out.join('');
  assert.ok(printed.includes(draft), 'the path is printed');
  assert.match(printed, /\b2\b/, 'the summary counts the nodes');
  assert.match(printed, /nota-curta/, 'the similarity suggestion is surfaced to the person');

  // The catalogue was read, the version of the existing class was read to score
  // it, and nothing was written through the API: registration is `cartografo
  // import`, run by a human after the edit (D10).
  assert.ok(client.calls.includes('GET /v1/skills'));
  assert.ok(client.calls.includes(`GET /v1/graph-versions/${EXISTING_VERSION.id}`));
});

test('t148 — a block that arrives inside a stream-json frame lands the draft too', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const document = proposedGraph('artigo-revisado');
  const client = fakeClient([{ class: 'nota-curta', current_version_id: EXISTING_VERSION.id }]);
  // ONE line, exactly as the real adapter emits it: the whole answer, fence and
  // all, JSON-escaped inside the final frame.
  const adapter = new CountingAdapter(
    fakeAdapter([
      resultFrame(
        [
          'Composed from the registered capabilities:',
          '```grafo-proposto',
          JSON.stringify(document, null, 2),
          '```',
        ].join('\n'),
      ),
    ]),
  );
  const dir = scratch(t, 'quadro-sucesso');

  const out: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'artigo-revisado',
    client,
    adapter,
    workingDir: dir,
    cwd: dir,
    write: (text) => out.push(text),
    writeError: (text) => out.push(text),
  });

  assert.equal(code, 0, `the run failed against the real engine's own shape:\n${out.join('')}`);

  const draft = path.join(dir, 'artigo-revisado.grafo.rascunho.json');
  assert.ok(existsSync(draft), 'the draft is written from the DECODED text');
  assert.deepEqual(JSON.parse(readFileSync(draft, 'utf8')), document);
});

test('t148 — a frame with no block prints the decoded prose, not the raw frame', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const client = fakeClient([{ class: 'nota-curta', current_version_id: EXISTING_VERSION.id }]);
  const adapter = new CountingAdapter(
    fakeAdapter([
      resultFrame('Li o catálogo e não consegui compor uma topologia com o que existe.'),
    ]),
  );
  const dir = scratch(t, 'quadro-sem-bloco');

  const err: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'artigo-revisado',
    client,
    adapter,
    workingDir: dir,
    cwd: dir,
    write: () => undefined,
    writeError: (text) => err.push(text),
  });

  assert.equal(code, 1);
  const printed = err.join('');
  assert.match(
    printed,
    /não consegui compor uma topologia/,
    'the person reads what the session said, in the words it said them',
  );
  assert.ok(
    !printed.includes('"subtype"'),
    'a raw frame under "saída bruta da sessão" is unreadable exactly when it matters',
  );
});

test('t180 — the run refuses and reports in English, quoting the API vocabulary', async (t) => {
  const { runSynthesis } = await loadSynthesis();

  const client = fakeClient([{ class: 'nota-curta', current_version_id: EXISTING_VERSION.id }]);
  const dir = scratch(t, 'classe-ja-registrada');

  const err: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: 'nota-curta',
    client,
    adapter: fakeAdapter([]),
    workingDir: dir,
    cwd: dir,
    write: () => undefined,
    writeError: (text) => err.push(text),
  });

  assert.equal(code, 1);
  assert.equal(
    err.join(''),
    'synthesize: class_already_registered — class "nota-curta" already has a base graph.\n' +
      '  A new version over an existing lineage is the proposal flow (D13), not synthesis.\n',
    'the code echoes the API and is frozen; the sentence around it is English (FR2)',
  );
});
