/**
 * The synthesizer against the real thing, end to end (t148, AT9/AT10).
 *
 * Every acceptance test this surface had before faked one half of production or
 * the other: `synthesize.test.ts` hands `runSynthesis` an object literal in
 * place of the control plane, so no request is ever made and no credential is
 * ever missed; and every fake engine in the suite prints plain prose, so the
 * fence scanner never meets the `stream-json` frames a real session emits. Both
 * halves were broken at once, and both suites were green.
 *
 * So this file removes exactly those two fakes and nothing else:
 *
 * - the control plane is the REAL binary, spawned as a child process, with the
 *   credential gate t124 put on `/v1` fully armed. The token is the one it
 *   printed on its own readiness line;
 * - `globalThis.fetch` is left ALONE. `test/authorized-fetch.ts` exists for the
 *   suites that want to assert about dispatch instead of about headers, and it
 *   is precisely what let the dispatcher ride somebody else's credential from
 *   t124 to t147. A test that patches the global cannot find out whether the
 *   code under test presents a token, because the answer is always yes;
 * - the engine stays fake — deterministic CI, no installed CLI, no
 *   authentication (`docs/formatos/engine-adapter.md:363-366`) — but it is fed
 *   the FRAME shape the real adapter produces, not prose.
 *
 * What is left faked is the model's judgement, which is the one thing no test
 * can assert about anyway.
 *
 * The boot helper is copied from `test/dispatch/dispatch-claude-code.test.ts`
 * rather than shared, for the reason that file already records about its own
 * copy: it belongs to another ticket's surface.
 *
 * English per D18; the draft file name and the graph document's keys are the
 * published, Portuguese surface.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootCore } from '@cartografo/test-support';

import { ClaudeCodeAdapter } from '../../src/engine/claude-code-adapter.ts';
import { buildCommand } from '../../src/engine/command.ts';
import type { SessionSpec } from '../../src/engine/types.ts';
import type * as ClientModule from '../../src/synthesizer/control-plane-client.ts';
import type * as SynthesisModule from '../../src/synthesizer/synthesize.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const CLIENT_MODULE = 'src/synthesizer/control-plane-client.ts';
const SYNTHESIS_MODULE = 'src/synthesizer/synthesize.ts';

const DECLARATION = 'Quero um fluxo que redige e revisa uma nota curta sobre um tema declarado.';
const CLASS_NAME = 'artigo-revisado';

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

/**
 * Boots the real control plane and returns its address and credential.
 *
 * The spawn, the readiness wait and the teardown are
 * `@cartografo/test-support`'s since t201; what stays here is the shape the
 * assertions below already speak.
 *
 * It touches no global, and that absence IS the device: with `globalThis.fetch`
 * untouched, the only credential that can reach the API is one the code under
 * test presented itself.
 */
async function bootControlPlane(t: TestHook): Promise<{ baseUrl: string; token: string }> {
  const { url, token } = await bootCore(t);
  return { baseUrl: url, token };
}

/** A scratch directory that cleans itself up. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t148-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A graph document, in the shape of `schema/grafo.schema.json`. */
function proposedGraph(): Record<string, unknown> {
  const pin = { id: 'cartografo/redigir-nota', versao: '1.0.0', hash: `sha256:${'a'.repeat(64)}` };
  const contract = {
    input_schema: {},
    output_schema: {},
    checks: [{ type: 'deterministic', comando: 'npm test', descricao: 'Prova.' }],
  };
  return {
    problem_class: CLASS_NAME,
    lineage: { tipo: 'base' },
    metadata: { nome: CLASS_NAME, descricao: 'Redige e revisa.', schema_version: '1.0.0' },
    nodes: [
      { id: 'redigir', papel: 'redator', node_type: 'work', skill_ref: pin, contrato: contract },
      { id: 'revisar', papel: 'revisor', node_type: 'gate', skill_ref: pin, contrato: contract },
    ],
    edges: [{ from: 'redigir', to: 'revisar', condition: 'sempre' }],
    initial_node: 'redigir',
    final_nodes: ['revisar'],
  };
}

/**
 * The fake engine, driven to print what a REAL `claude` session prints: one
 * `stream-json` frame per line, the answer escaped inside `result`.
 */
function frameEmittingAdapter(answer: string): ClaudeCodeAdapter {
  const frame = JSON.stringify({ type: 'result', subtype: 'success', result: answer });
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    environmentBuilder: () => ({
      ...process.env,
      FAKE_ENGINE_LINES: JSON.stringify([{ stream: 'stdout', text: frame }]),
    }),
    graceMs: 300,
  });
}

/** The whole answer of the session, fence included, before it is framed. */
function answerWithBlock(document: Record<string, unknown>): string {
  return [
    'Compus a partir do catálogo registrado.',
    '```grafo-proposto',
    JSON.stringify(document, null, 2),
    '```',
  ].join('\n');
}

test('AT9 — with a token and real frames, the synthesis completes and the draft lands', async (t) => {
  const { createControlPlaneReader } = await loadModule<typeof ClientModule>(CLIENT_MODULE);
  const { runSynthesis } = await loadModule<typeof SynthesisModule>(SYNTHESIS_MODULE);

  const { baseUrl, token } = await bootControlPlane(t);
  const dir = scratch(t, 'com-credencial');
  const document = proposedGraph();

  const printed: string[] = [];
  const code = await runSynthesis({
    declaration: DECLARATION,
    className: CLASS_NAME,
    client: createControlPlaneReader(baseUrl, { token }),
    adapter: frameEmittingAdapter(answerWithBlock(document)),
    workingDir: dir,
    cwd: dir,
    timeoutSeconds: 60,
    write: (text) => printed.push(text),
    writeError: (text) => printed.push(text),
  });

  assert.equal(code, 0, `the whole real path failed:\n${printed.join('')}`);

  const draft = path.join(dir, `${CLASS_NAME}.grafo.rascunho.json`);
  assert.ok(existsSync(draft), 'the draft on disk is the only product this command has');
  assert.deepEqual(
    JSON.parse(readFileSync(draft, 'utf8')),
    document,
    'the document survived the round trip through the frame',
  );
});

test('AT10 — with no token, the very first read is refused 401 by the real gate', async (t) => {
  const { createControlPlaneReader, ControlPlaneError } = await loadModule<typeof ClientModule>(
    CLIENT_MODULE,
  );
  const { runSynthesis } = await loadModule<typeof SynthesisModule>(SYNTHESIS_MODULE);

  const { baseUrl } = await bootControlPlane(t);
  const dir = scratch(t, 'sem-credencial');

  await assert.rejects(
    async () =>
      await runSynthesis({
        declaration: DECLARATION,
        className: CLASS_NAME,
        // Everything a working run gets, minus the credential.
        client: createControlPlaneReader(baseUrl),
        adapter: frameEmittingAdapter(answerWithBlock(proposedGraph())),
        workingDir: dir,
        cwd: dir,
        timeoutSeconds: 60,
        write: () => undefined,
        writeError: () => undefined,
      }),
    (error: unknown) => {
      assert.ok(
        error instanceof ControlPlaneError,
        `expected the refusal the control plane itself raises, got: ${String(error)}`,
      );
      assert.equal(error.status, 401, 'there is no open mode since t124, and none is wanted');
      return true;
    },
  );

  assert.ok(
    !existsSync(path.join(dir, `${CLASS_NAME}.grafo.rascunho.json`)),
    'a run that never read the classes never wrote anything either',
  );
});
