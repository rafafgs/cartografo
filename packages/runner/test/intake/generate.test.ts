/**
 * Acceptance tests for the intake generation run (t144, AT3).
 *
 * Four claims, and each one is a boundary of the shape this ficha borrowed from
 * the surveyor (t110) rather than from the synthesizer (t115):
 *
 * 1. a class that names no registered lineage is refused BEFORE any session
 *    opens — the same ordering `synthesize.ts` records for its own pre-check,
 *    applied here so a typo in `--class` does not cost a whole session;
 * 2. a session that came back well formed produces EXACTLY ONE
 *    `POST /v1/intake`, carrying what the session wrote, verbatim. Nothing here
 *    re-validates `items`: a bad draft is cheap and reversible (discard it), the
 *    server already answers the whole `invalid_items` report, and a second copy
 *    of `validateItems` on this side is a copy that can drift;
 * 3. a session that did not end `completed` posts nothing;
 * 4. neither does one whose file is missing, unreadable as JSON, or carrying no
 *    usable `items`.
 *
 * The engine is real (`ClaudeCodeAdapter` driving `test/fixtures/fake-engine.mjs`,
 * the seam the conformance kit uses); the control plane is faked on both sides —
 * the read of `/v1/classes` and the write of `/v1/intake` — because what this
 * file proves is the runner's behaviour, and t101/t122 prove their own routes.
 *
 * English per D18. The payload keys are the published wire, English since t255;
 * the file name the session writes stays as it is, because that is data the
 * prompt names and not a field of the API.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
import type { EntradaDeIntake, Rascunho } from '../../src/controller/cliente-controle.ts';
import type * as GenerateModule from '../../src/intake/generate.ts';
import type * as PromptModule from '../../src/intake/prompt.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const GENERATE_MODULE = 'src/intake/generate.ts';
const PROMPT_MODULE = 'src/intake/prompt.ts';
const FAKE_ENGINE = fileURLToPath(new URL('../fixtures/fake-engine.mjs', import.meta.url));

const CLASS_NAME = 'software-development';
const REQUEST = 'Fechar a camada de intake: propor a quebra e confirmar num portao humano.';

/** What the session wrote, and what the control plane has to receive untouched. */
const ITEMS: ReadonlyArray<Record<string, unknown>> = Object.freeze([
  {
    ref: 'migracao',
    title: 'Migracao do intake',
    body: 'As duas tabelas e as colunas novas.',
    acceptance_criteria: ['a migracao roda do zero'],
  },
  { ref: 'rotas', title: 'Rotas do intake', depends_on: ['migracao'] },
]);

let generateCache: typeof GenerateModule | null = null;
let promptCache: typeof PromptModule | null = null;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(new URL(`../../${relative}`, import.meta.url).href)) as T;
}

async function loadGenerate(): Promise<typeof GenerateModule> {
  generateCache ??= await loadModule<typeof GenerateModule>(GENERATE_MODULE);
  return generateCache;
}

async function loadPrompt(): Promise<typeof PromptModule> {
  promptCache ??= await loadModule<typeof PromptModule>(PROMPT_MODULE);
  return promptCache;
}

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

/** A scratch directory that cleans itself up. One per case: the file is state. */
function scratch(t: TestHook, label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `cartografo-t144-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The `claude` argv handed whole to the fake engine — only the binary changes. */
function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec: SessionSpec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
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

/** The read side of the control plane: which classes are registered. */
function readerWith(...names: readonly string[]): { fetchClasses: () => Promise<{ class: string }[]> } {
  return { fetchClasses: async () => names.map((name) => ({ class: name })) };
}

/** The write side: records every call and never makes one of its own. */
class RecordingClient {
  readonly calls: EntradaDeIntake[] = [];

  async criarIntake(input: EntradaDeIntake): Promise<Rascunho> {
    this.calls.push(input);
    return {
      id: 7,
      project_id: 3,
      execution_id: null,
      class: input.class,
      request: input.request,
      items: input.items as Array<Record<string, unknown>>,
      status: 'pending',
      created_jobs: null,
      created_at: '2026-08-16T12:00:00.000Z',
      updated_at: '2026-08-16T12:00:00.000Z',
    };
  }
}

/** Configures the fake engine to write `content` where the orchestrator reads it. */
function engineWriting(file: string, content: string): Record<string, string> {
  return { FAKE_ENGINE_WRITE_FILES: JSON.stringify({ [file]: content }) };
}

test('AT3a — a class that is not registered is refused, with no session and no write', async (t) => {
  const { generateIntakeDraft, IntakeError } = await loadGenerate();
  const { OUTPUT_FILE } = await loadPrompt();

  const adapter = new CountingAdapter(fakeAdapter());
  const client = new RecordingClient();
  const workingDir = scratch(t, 'classe-desconhecida');

  await assert.rejects(
    async () =>
      await generateIntakeDraft({
        reader: readerWith('nota-curta', 'asymmetric-bets'),
        client,
        adapter,
        request: REQUEST,
        className: CLASS_NAME,
        workingDir,
        timeoutSeconds: 60,
        envOverrides: engineWriting(OUTPUT_FILE, JSON.stringify({ items: ITEMS })),
      }),
    (error: unknown) => {
      assert.ok(error instanceof IntakeError, `expected an IntakeError, got: ${String(error)}`);
      assert.equal(
        error.code,
        'grafo_desconhecido',
        'the refusal echoes the code the control plane itself answers',
      );
      assert.match(error.message, new RegExp(CLASS_NAME));
      return true;
    },
  );

  assert.equal(adapter.sessions, 0, 'the refusal comes BEFORE any session (FR3a)');
  assert.deepEqual(client.calls, [], 'and nothing is posted');
  assert.deepEqual(readdirSync(workingDir), [], 'the working directory is left as it was found');
});

test('AT3b — a well-formed session lands exactly one draft, carrying what it wrote', async (t) => {
  const { generateIntakeDraft } = await loadGenerate();
  const { OUTPUT_FILE } = await loadPrompt();

  const adapter = new CountingAdapter(fakeAdapter());
  const client = new RecordingClient();

  const draft = await generateIntakeDraft({
    reader: readerWith('nota-curta', CLASS_NAME),
    client,
    adapter,
    request: REQUEST,
    className: CLASS_NAME,
    workingDir: scratch(t, 'sessao-boa'),
    timeoutSeconds: 60,
    envOverrides: engineWriting(OUTPUT_FILE, JSON.stringify({ items: ITEMS }, null, 2)),
  });

  assert.equal(adapter.sessions, 1, 'exactly one agent session decomposes the request');
  assert.deepEqual(
    client.calls,
    [{ class: CLASS_NAME, request: REQUEST, items: ITEMS }],
    'the body is the class, the request and the items the session wrote, verbatim',
  );
  assert.equal(draft.id, 7, 'the created draft is what comes back');
  assert.equal(draft.status, 'pending');
});

/**
 * t175 — a tier the session wrote survives the trip to the control plane.
 *
 * This orchestrator judges nothing about an item's shape on purpose (AT3b's
 * "verbatim"), so the claim here is a REGRESSION one: nothing on this path may
 * start filtering keys it does not recognize. A whitelist introduced here would
 * drop `tier` on the floor silently — the draft would still be created, the
 * jobs would still be born, and every one of them would be unclassified with
 * nothing failing anywhere.
 */
test('t175 — an item written with a tier reaches the draft with the tier intact', async (t) => {
  const { generateIntakeDraft } = await loadGenerate();
  const { OUTPUT_FILE } = await loadPrompt();

  const triaged: ReadonlyArray<Record<string, unknown>> = Object.freeze([
    { ref: 'renomear', title: 'Renomear a coluna', tier: 'trivial' },
    { ref: 'feature', title: 'A feature inteira', tier: 'standard' },
    { ref: 'sem-triagem', title: 'Ninguem triou esta' },
  ]);

  const client = new RecordingClient();

  const draft = await generateIntakeDraft({
    reader: readerWith(CLASS_NAME),
    client,
    adapter: fakeAdapter(),
    request: REQUEST,
    className: CLASS_NAME,
    workingDir: scratch(t, 'sessao-com-tier'),
    timeoutSeconds: 60,
    envOverrides: engineWriting(OUTPUT_FILE, JSON.stringify({ items: triaged })),
  });

  assert.deepEqual(
    client.calls,
    [{ class: CLASS_NAME, request: REQUEST, items: triaged }],
    'the items go up exactly as the session wrote them, tier included',
  );
  assert.deepEqual(
    draft.items.map((item) => item.tier),
    ['trivial', 'standard', undefined],
    'and come back on the draft the same way',
  );
});

test('AT3c — a session that did not complete posts nothing', async (t) => {
  const { generateIntakeDraft, IntakeError } = await loadGenerate();
  const { OUTPUT_FILE } = await loadPrompt();

  const client = new RecordingClient();

  await assert.rejects(
    async () =>
      await generateIntakeDraft({
        reader: readerWith(CLASS_NAME),
        client,
        adapter: fakeAdapter(),
        request: REQUEST,
        className: CLASS_NAME,
        workingDir: scratch(t, 'sessao-morta'),
        timeoutSeconds: 60,
        envOverrides: {
          ...engineWriting(OUTPUT_FILE, JSON.stringify({ items: ITEMS })),
          FAKE_ENGINE_EXIT_CODE: '3',
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof IntakeError, `expected an IntakeError, got: ${String(error)}`);
      assert.equal(error.code, 'session_failed');
      return true;
    },
  );

  assert.deepEqual(client.calls, [], 'a session that died writes no draft, however good the file is');
});

test('AT3d — a missing, unreadable or empty answer posts nothing', async (t) => {
  const { generateIntakeDraft, IntakeError } = await loadGenerate();
  const { OUTPUT_FILE } = await loadPrompt();

  const client = new RecordingClient();

  /** One run, in a directory of its own so a previous file cannot rescue it. */
  const run = async (label: string, envOverrides: Record<string, string>): Promise<unknown> =>
    await generateIntakeDraft({
      reader: readerWith(CLASS_NAME),
      client,
      adapter: fakeAdapter(),
      request: REQUEST,
      className: CLASS_NAME,
      workingDir: scratch(t, label),
      timeoutSeconds: 60,
      envOverrides,
    }).then(
      () => null,
      (error: unknown) => error,
    );

  const cases: ReadonlyArray<{ label: string; env: Record<string, string>; code: string }> = [
    { label: 'sem-arquivo', env: {}, code: 'missing_output' },
    {
      label: 'json-torto',
      env: engineWriting(OUTPUT_FILE, '{"items": [ isto nao e json'),
      code: 'invalid_output',
    },
    {
      label: 'sem-items',
      env: engineWriting(OUTPUT_FILE, JSON.stringify({ observacao: 'esqueci a lista' })),
      code: 'missing_items',
    },
    {
      label: 'items-vazios',
      env: engineWriting(OUTPUT_FILE, JSON.stringify({ items: [] })),
      code: 'missing_items',
    },
    // t255 — a session that wrote the retired envelope is a session that wrote
    // nothing this run can use. It fails loudly rather than posting an empty
    // batch: `document.itens` is not read any more, and a silent `[]` here would
    // land a draft with no ticket in it.
    {
      label: 'envelope-antigo',
      env: engineWriting(OUTPUT_FILE, JSON.stringify({ itens: ITEMS })),
      code: 'missing_items',
    },
  ];

  for (const one of cases) {
    const failure = await run(one.label, one.env);
    assert.ok(failure !== null, `${one.label} should not have produced a draft`);
    assert.ok(
      failure instanceof IntakeError,
      `${one.label}: expected an IntakeError, got: ${String(failure)}`,
    );
    assert.equal(failure.code, one.code, `${one.label}: ${failure.message}`);
  }

  assert.deepEqual(client.calls, [], 'no bad session may spend a write to find out it was bad');
});
