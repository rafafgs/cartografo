/**
 * Acceptance test for the human-escalation cycle, end to end (t106, FR8).
 *
 * This is the ticket's central claim, exercised against a REAL control plane
 * over HTTP and a real `EngineAdapter`: a dispatched session asks a question,
 * the work blocks by itself, a human answers through the API, the work is a
 * candidate again, and the next `tick()` re-dispatches a session whose prompt
 * already carries the question and the answer.
 *
 * The engine is the fake one (`test/fixtures/fake-engine.mjs`), for the reason
 * the conformance kit already records: CI must be deterministic and must not
 * depend on an installed, authenticated CLI
 * (`docs/formatos/engine-adapter.md:363-366`). The other half of the proof —
 * a real `claude` session emitting a real block — is the manual spike
 * (`scripts/spike-t106-human-escalation.mjs`), same discipline t104 used.
 *
 * The control-plane boot is the same pattern as
 * `test/controller/dispatch-and-lease.e2e.test.ts`: spawn the real binary, wait
 * for the readiness line, never `sleep` and hope. It is duplicated rather than
 * extracted because that file belongs to another ticket's surface.
 *
 * The t147 tests at the bottom boot through {@link bootControlPlane} and stop
 * there — they never call `authorizeGlobalFetch`. That is the whole point of
 * them: the shared {@link startControlPlane} patches `globalThis.fetch`, the
 * dispatcher captures the already-patched global as its `doFetch`, and every
 * test above therefore rode the harness's own token instead of exercising the
 * dispatcher's. That is how a dispatcher with no `Authorization` header at all
 * stayed green from t124 to t147.
 *
 * English per D18; this directory is post-decision code.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ClaudeCodeAdapter } from "../../src/engine/claude-code-adapter.ts";
import { CodexAdapter } from "../../src/engine/codex-adapter.ts";
import { buildCommand as buildCodexCommand } from "../../src/engine/codex-command.ts";
import { buildCommand } from "../../src/engine/command.ts";
import type {
  EngineAdapter,
  SessionFinishDetail,
  SessionSpec,
  SessionStatus,
} from "../../src/engine/types.ts";
import { decodeClaudeCodeSessionText } from "../../src/dispatch/session-text.ts";
import type * as ClientModule from "../../src/controller/cliente-controle.ts";
import type * as ControllerModule from "../../src/controller/controller.ts";
import type * as BudgetModule from "../../src/engine/resolve-budget.ts";
import type * as DispatchModule from "../../src/dispatch/dispatch-claude-code.ts";
import type * as SessionTextModule from "../../src/dispatch/session-text.ts";
import type * as WorktreeModule from "../../src/dispatch/session-worktree.ts";

import { authorizeGlobalFetch } from "../authorized-fetch.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const BIN_PATH = path.join(
  REPO_ROOT,
  "packages",
  "core",
  "bin",
  "cartografo.mjs",
);
const FAKE_ENGINE = fileURLToPath(
  new URL("../fixtures/fake-engine.mjs", import.meta.url),
);

const DISPATCH_MODULE = "src/dispatch/dispatch-claude-code.ts";
const SESSION_TEXT_MODULE = "src/dispatch/session-text.ts";

/** Deadline for anything this test waits on. Wide on purpose. */
const DEADLINE_MS = 30_000;

/** The escalation the fake session emits on the first dispatch. */
const ESCALATION = {
  question: "Renumerar a migração para 0003?",
  context: "A t101 corre em paralelo e é dona do mesmo espaço de numeração.",
  options: ["Renumerar para 0003", "Manter 0002"],
  recommendation: "Manter 0002 e renumerar só se colidir no merge.",
  default: "Manter 0002",
};

/** What the human answers through the API. */
const ANSWER = "Manter 0002 e renumerar só no merge";
const ANSWERED_BY = "rafael";

interface TestHook {
  after: (fn: () => void | Promise<void>) => void;
}

interface Work {
  id: number;
  titulo: string;
  no_atual: string;
  bloqueado: boolean;
  motivo_bloqueio: string | null;
  execucao_id: number | null;
}

interface Question {
  id: number;
  trabalho_id: number;
  sessao_id: number | null;
  tipo: string;
  pergunta: string;
  contexto: string | null;
  opcoes: string[] | null;
  recomendacao: string | null;
  resposta_padrao: string | null;
  auto_aprovavel: boolean;
  status: string;
  resposta: string | null;
  respondido_por: string | null;
  origem: string | null;
}

interface Session {
  id: number;
  trabalho_id: number | null;
  no_id: string | null;
  engine: string;
  engine_session_ref: string | null;
  working_dir: string;
  prompt: string;
  status: string;
  exit_code: number | null;
  /** The inactivity budget the session was opened with (t163). */
  silence_seconds: number | null;
  /** Which watchdog stopped it, when one did (t163). */
  timeout_reason: string | null;
  /** The four token counts the engine reported, or `null` for nothing (t172). */
  uso: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  /** Which models ran the session, or `null` for nothing reported (t172). */
  modelos: string[] | null;
  finalizada_em: string | null;
}

/** Body of `GET /v1/sessions/:id/transcript` (t159). */
interface Transcript {
  transcricao: string | null;
  truncada: boolean;
  tamanho_original: number | null;
}

interface Event {
  id: number;
  tipo: string;
  entidade: { tipo: string; id: number | string };
  ator: { tipo: string; ref: string };
  dados: Record<string, unknown>;
}

/** What the fake engine recorded about the process it was given. */
interface FakeRecord {
  /** The engine process's own pid, which is how the t148 tests find it again. */
  pid: number;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

type CommandChild = ChildProcessByStdio<null, Readable, Readable>;

async function loadModule<T>(relative: string): Promise<T> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, relative)),
    `artifact does not exist yet: packages/runner/${relative}`,
  );
  return (await import(
    new URL(`../../${relative}`, import.meta.url).href
  )) as T;
}

/** The readiness line the control plane prints when it is up. */
interface Readiness {
  url: string;
  bootstrapToken: string | null;
}

/**
 * Boots the real control plane and returns its readiness line, verbatim.
 *
 * It touches no global: whoever calls it decides how the credential reaches the
 * requests. {@link startControlPlane} arms `globalThis.fetch` on top of this;
 * the t147 tests hand the token to the code under test instead, which is the
 * only way to find out whether that code presents one.
 */
async function bootControlPlane(t: TestHook): Promise<Readiness> {
  assert.ok(existsSync(BIN_PATH), `artifact does not exist yet: ${BIN_PATH}`);

  const base = mkdtempSync(path.join(tmpdir(), "cartografo-t106-e2e-"));
  const child: CommandChild = spawn(process.execPath, [BIN_PATH], {
    cwd: base,
    env: {
      ...process.env,
      CARTOGRAFO_DB_PATH: path.join(base, "cartografo.db"),
      CARTOGRAFO_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    err += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        await delay(100);
      }
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    rmSync(base, { recursive: true, force: true });
  });

  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `the control plane died before it was ready (code ${child.exitCode})\nstdout:\n${out}\nstderr:\n${err}`,
      );
    }
    const line = out
      .split("\n")
      .map((text) => text.trim())
      .find(
        (text) => text.startsWith("{") && text.includes("cartografo.ready"),
      );
    if (line !== undefined) {
      // Since t124 the API answers nothing without a credential; the control
      // plane prints the one it minted, on this very line.
      return JSON.parse(line) as Readiness;
    }
    await delay(50);
  }

  throw new Error(
    `the control plane was not ready within ${DEADLINE_MS}ms\nstdout:\n${out}`,
  );
}

/**
 * Boots the control plane and makes every `fetch` of this test present its
 * token — the shape the t106 and t125 tests below were written against.
 */
async function startControlPlane(t: TestHook): Promise<string> {
  const readiness = await bootControlPlane(t);
  authorizeGlobalFetch(t, {
    baseUrl: readiness.url,
    token: readiness.bootstrapToken ?? "",
  });
  return readiness.url;
}

/**
 * Talks JSON with the control plane, asserting the status on the way.
 *
 * `token` is optional because the tests that boot through
 * {@link startControlPlane} have their credential armed on the global already;
 * the t147 tests leave that global alone, so they pass it in here.
 */
async function api<T>(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
  expected = 200,
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    expected,
    `${method} ${route} answered ${response.status}: ${text}`,
  );
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** The lines the fake session prints when it needs the founder. */
function linesWithBlock(): string {
  return JSON.stringify([
    { stream: "stdout", text: "Li a ficha e os arquivos que ela nomeia." },
    {
      stream: "stdout",
      text: "Uma coisa a ficha não resolve, então eu pergunto:",
    },
    { stream: "stdout", text: "```input-request" },
    { stream: "stdout", text: JSON.stringify(ESCALATION) },
    { stream: "stdout", text: "```" },
  ]);
}

/** ...and the lines it prints when it has the answer and just works. */
function linesWithoutBlock(): string {
  return JSON.stringify([
    { stream: "stdout", text: "A resposta já veio no prompt; segui com ela." },
    { stream: "stdout", text: "Terminei o trabalho, nada a perguntar." },
  ]);
}

/** The engine's own answer when a tool the policy denied is attempted (t125). */
const DENIAL_TEXT =
  "Claude requested permissions to use WebFetch, but you have not granted it.";

/** The frames of a session that tried a denied tool and was told no. */
function linesWithDenial(): string {
  return JSON.stringify([
    {
      stream: "stdout",
      text: JSON.stringify({
        type: "assistant",
        session_id: "cc-t125",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_t125",
              name: "WebFetch",
              input: { url: "https://example.com" },
            },
          ],
        },
      }),
    },
    {
      stream: "stdout",
      text: JSON.stringify({
        type: "user",
        session_id: "cc-t125",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_t125",
              is_error: true,
              content: DENIAL_TEXT,
            },
          ],
        },
      }),
    },
    {
      stream: "stdout",
      text: "Sem rede, segui pelo que já estava no repositório.",
    },
  ]);
}

/**
 * The frames of a session that was denied a tool AND ended up asking something.
 *
 * One session that touches every write route a dispatch has, which is what
 * makes the t147 green test say something about all seven of `call`'s routes
 * instead of only the five a quiet session reaches.
 */
function linesWithDenialAndBlock(): string {
  return JSON.stringify([
    ...(JSON.parse(linesWithDenial()) as unknown[]),
    ...(JSON.parse(linesWithBlock()) as unknown[]),
  ]);
}

test("t106 — question, block, answer, unblock and re-dispatch, over real HTTP", async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    "src/controller/cliente-controle.ts",
  );
  const { Controller } = await loadModule<typeof ControllerModule>(
    "src/controller/controller.ts",
  );
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const baseUrl = await startControlPlane(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t106-workdir-"));
  const firstRecord = path.join(workDir, "primeiro-despacho.json");
  const secondRecord = path.join(workDir, "segundo-despacho.json");
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const client = new ClienteControle({ urlBase: baseUrl });
  await client.registrarRunner("runner-t106", "o que despacha de verdade");

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha que escala",
      no_entrada_id: "implementar",
      execucao_id: 7,
    },
    201,
  );

  // The seam the conformance kit already defines: the argv the real `claude`
  // would receive, handed whole to the fake engine. Only the binary changes.
  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });

  const dispatchOptions = {
    urlBase: baseUrl,
    engines: claudeOnly(adapter),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
  };

  // Two real dispatches, differing only in how the fake engine is configured:
  // `envOverrides` is fixed per dispatch (the `SessionSpec` has no other way to
  // reach the engine's environment), so swapping the dispatch between ticks is
  // how this test says "this time the session has nothing to ask".
  const dispatchThatAsks = createClaudeCodeDispatch({
    ...dispatchOptions,
    envOverrides: {
      FAKE_ENGINE_RECORD: firstRecord,
      FAKE_ENGINE_LINES: linesWithBlock(),
    },
  });
  const dispatchThatFinishes = createClaudeCodeDispatch({
    ...dispatchOptions,
    envOverrides: {
      FAKE_ENGINE_RECORD: secondRecord,
      FAKE_ENGINE_LINES: linesWithoutBlock(),
    },
  });

  let currentDispatch = dispatchThatAsks;
  const controller = new Controller({
    client,
    runnerId: "runner-t106",
    projectId: 1,
    runnerCap: 1,
    projectCap: 4,
    ttlSeconds: 30,
    dispatch: async (jobId) => currentDispatch(jobId),
  });

  // --- 1. the first tick dispatches, and the session asks -------------------
  const first = await controller.tick();
  assert.ok(
    first !== null,
    "the first tick should have found and dispatched the work",
  );
  assert.equal(first.jobId, work.id);

  const blocked = await api<Work>(baseUrl, "GET", `/v1/jobs/${work.id}`);
  assert.equal(
    blocked.bloqueado,
    true,
    "asking blocks the work, without the runner asking for it",
  );

  const pending = await api<{ perguntas: Question[] }>(
    baseUrl,
    "GET",
    "/v1/input-requests?status=pendente",
  );
  assert.equal(pending.perguntas.length, 1);
  const question = pending.perguntas[0];
  assert.equal(
    blocked.motivo_bloqueio,
    `aguardando resposta da pergunta ${question.id}`,
    "the reason names the question that unblocks the work",
  );

  // The queue carries enough to decide without opening the repository — the
  // criterion t102 set for the question entity, now fed by a real session.
  assert.equal(question.trabalho_id, work.id);
  assert.equal(question.tipo, "pergunta");
  assert.equal(question.pergunta, ESCALATION.question);
  assert.equal(question.contexto, ESCALATION.context);
  assert.deepEqual(question.opcoes, ESCALATION.options);
  assert.equal(question.recomendacao, ESCALATION.recommendation);
  assert.equal(question.resposta_padrao, ESCALATION.default);
  assert.equal(question.auto_aprovavel, true);
  assert.ok(
    question.sessao_id !== null,
    "the question knows which session raised it",
  );

  // A blocked work is nobody's candidate: the loop keeps turning and finds
  // nothing to do, which is exactly the point of the flag.
  assert.equal(
    await controller.tick(),
    null,
    "a blocked work is not dispatched again",
  );

  // --- 2. a human answers through the API -----------------------------------
  const answered = await api<Question>(
    baseUrl,
    "PATCH",
    `/v1/input-requests/${question.id}/answer`,
    { resposta: ANSWER, respondido_por: ANSWERED_BY },
  );
  assert.equal(answered.status, "respondida");
  assert.equal(answered.origem, "usuario");

  const unblocked = await api<Work>(baseUrl, "GET", `/v1/jobs/${work.id}`);
  assert.equal(
    unblocked.bloqueado,
    false,
    "answering returns the work to the queue",
  );
  assert.equal(unblocked.motivo_bloqueio, null);

  // --- 3. the next tick re-dispatches, and this time the session knows ------
  currentDispatch = dispatchThatFinishes;
  const second = await controller.tick();
  assert.ok(second !== null, "the answered work is a candidate again");
  assert.equal(second.jobId, work.id);

  const record = JSON.parse(readFileSync(secondRecord, "utf8")) as FakeRecord;
  const prompt = record.argv[record.argv.length - 1];
  assert.ok(
    prompt.includes(ESCALATION.question),
    `the re-dispatched prompt must carry the question that was asked:\n${prompt}`,
  );
  assert.ok(
    prompt.includes(ANSWER),
    `the re-dispatched prompt must carry the answer that was given:\n${prompt}`,
  );
  // `realpathSync` because macOS hands out `/var/folders/...` temp dirs that
  // the child process reports as `/private/var/folders/...`.
  assert.equal(
    record.cwd,
    realpathSync(workDir),
    "the session ran in the working dir it was given",
  );

  const questions = await api<{ perguntas: Question[] }>(
    baseUrl,
    "GET",
    "/v1/input-requests",
  );
  assert.equal(
    questions.perguntas.length,
    1,
    "knowing the answer, the second session did not ask the same thing again",
  );

  // --- 4. and the log tells the whole story ---------------------------------
  const timeline = await api<{ eventos: Event[] }>(
    baseUrl,
    "GET",
    `/v1/jobs/${work.id}/events`,
  );
  assert.deepEqual(
    timeline.eventos.map((event) => event.tipo),
    [
      "trabalho.criado",
      "sessao.aberta",
      "pergunta.criada",
      "trabalho.bloqueado",
      "trabalho.desbloqueado",
      "sessao.aberta",
    ],
    // `sessao.finalizada` and `pergunta.respondida` are absent BY CONTRACT, not
    // by omission: their payloads carry no `trabalho_id`, so the work timeline
    // cannot see them (t102, `packages/core/src/db/events.ts`
    // `FiltroDeEventos`). They are proven below, on the projections.
    "the work timeline, in the order the log recorded it",
  );

  const created = timeline.eventos.find(
    (event) => event.tipo === "pergunta.criada",
  );
  assert.deepEqual(
    created?.ator,
    { tipo: "agente", ref: work.no_atual },
    "the agent asked",
  );
  const blockEvent = timeline.eventos.find(
    (event) => event.tipo === "trabalho.bloqueado",
  );
  assert.equal(
    blockEvent?.ator.tipo,
    "sistema",
    "the flag was raised by the wiring",
  );
  const unblockEvent = timeline.eventos.find(
    (event) => event.tipo === "trabalho.desbloqueado",
  );
  assert.equal(
    unblockEvent?.ator.tipo,
    "usuario",
    "the flag was lowered by the human who answered",
  );

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=7",
  );
  assert.equal(
    sessions.sessoes.length,
    2,
    "two sessions: the one that asked and the one that knew",
  );
  for (const session of sessions.sessoes) {
    assert.equal(session.trabalho_id, work.id);
    assert.equal(session.no_id, work.no_atual);
    assert.equal(session.engine, "claude-code");
    assert.equal(session.working_dir, workDir);
    assert.equal(
      session.status,
      "concluida",
      "the taxonomy vocabulary, not the interface one",
    );
    assert.equal(session.exit_code, 0);
    assert.ok(session.finalizada_em !== null);
  }
  assert.ok(
    sessions.sessoes[1].prompt.includes(ANSWER),
    "the persisted prompt of the second session carries the answer, for the audit trail",
  );
});

test("t125 — a denied tool becomes one permission-denial call, and does not fail the dispatch", async (t) => {
  const { ClienteControle } = await loadModule<typeof ClientModule>(
    "src/controller/cliente-controle.ts",
  );
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const baseUrl = await startControlPlane(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t125-workdir-"));
  const record = path.join(workDir, "despacho-com-negacao.json");
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const client = new ClienteControle({ urlBase: baseUrl });
  await client.registrarRunner(
    "runner-t125",
    "o que despacha com política de permissão",
  );

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha com skill de terceiro",
      no_entrada_id: "implementar",
      execucao_id: 9,
    },
    201,
  );

  // A spy in front of the real `fetch`: the claim is "exactly one call, with
  // this body", and the control plane on the other side is real — so the same
  // test proves the route accepts what the runner sends.
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      route: String(input).slice(baseUrl.length),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return fetch(input, init);
  };

  const adapter = new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });

  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    engines: claudeOnly(adapter),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
    doFetch,
    permissions: { filesystem: { write: ["**"] }, network: { allowed: false } },
    envOverrides: {
      FAKE_ENGINE_RECORD: record,
      FAKE_ENGINE_LINES: linesWithDenial(),
    },
  });

  // Asking is not failing, and neither is being denied: the dispatch of a
  // session that tried a closed door resolves normally.
  await dispatch(work.id);

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=9",
  );
  assert.equal(sessions.sessoes.length, 1);
  const session = sessions.sessoes[0];
  assert.equal(
    session.status,
    "concluida",
    "a denial is an incident, never a terminal status",
  );

  const denials = calls.filter((call) =>
    call.route.endsWith("/permission-denials"),
  );
  assert.equal(
    denials.length,
    1,
    `expected exactly one denial call, got ${denials.length}`,
  );
  assert.equal(denials[0].method, "POST");
  assert.equal(
    denials[0].route,
    `/v1/sessions/${session.id}/permission-denials`,
  );
  assert.deepEqual(denials[0].body, {
    recurso: "rede",
    ferramenta: "WebFetch",
    motivo: DENIAL_TEXT,
    ator: { tipo: "sistema", ref: "runner" },
  });

  // ...and the policy really reached the engine process, by the only channel
  // that counts: the argv (case C2's discipline).
  const received = JSON.parse(readFileSync(record, "utf8")) as FakeRecord;
  assert.ok(received.argv.includes("--disallowedTools"));
  assert.ok(received.argv.includes("WebFetch"));
});

test("t159 — what the engine printed is what the finish call ships, and what a human reads back", async (t) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const baseUrl = await startControlPlane(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t159-workdir-"));
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "a ficha cuja saída precisa sobreviver ao processo",
      no_entrada_id: "implementar",
      execucao_id: 11,
    },
    201,
  );

  // The same spy the t125 case uses: the claim is about the BODY of one call,
  // and the control plane on the other side is real — so the same test proves
  // the route accepts what the runner sends.
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const doFetch: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      route: String(input).slice(baseUrl.length),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return fetch(input, init);
  };

  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    engines: claudeOnly(fakeAdapter()),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
    doFetch,
    envOverrides: { FAKE_ENGINE_LINES: linesWithoutBlock() },
  });

  await dispatch(work.id);

  // Built from the fixture the engine was handed, not from the buffer under
  // test: the expectation has to come from outside the code it measures.
  const printed = (
    JSON.parse(linesWithoutBlock()) as Array<{ text: string }>
  )
    .map((line) => line.text)
    .join("\n");

  const finishes = calls.filter((call) => call.route.endsWith("/finish"));
  assert.equal(
    finishes.length,
    1,
    `expected exactly one finish call, got ${finishes.length}`,
  );
  assert.equal(finishes[0].method, "PATCH");
  const body = finishes[0].body as Record<string, unknown>;
  assert.equal(
    body.transcricao,
    printed,
    "the finish call carries the raw lines, joined by newline",
  );
  assert.equal(
    body.uso,
    null,
    "the transcript rides along with `uso`; it does not replace it",
  );

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=11",
  );
  assert.equal(sessions.sessoes.length, 1);
  const session = sessions.sessoes[0];

  // The end of the proof: what the engine printed is what a human can read
  // back, long after the runner's process is gone.
  const transcript = await api<Transcript>(
    baseUrl,
    "GET",
    `/v1/sessions/${session.id}/transcript`,
  );
  assert.equal(transcript.transcricao, printed);
  assert.equal(transcript.truncada, false);
  assert.equal(
    transcript.tamanho_original,
    Buffer.byteLength(printed, "utf8"),
  );
});

/** One `release`, as {@link fakeWorktrees} recorded it. */
interface ReleaseCall {
  path: string;
  branch: string;
  keep: boolean;
}

/** A `WorktreeManager` that records what it was asked, and creates nothing. */
interface FakeWorktrees extends WorktreeModule.WorktreeManager {
  /** The job ids `acquire` was called with, in order. */
  readonly acquisitions: number[];
  /** Every `release`, in order — the ledger AT10 reads. */
  readonly releases: ReleaseCall[];
}

/**
 * The worktree manager every test in this file passes (t160, FR6).
 *
 * It hands out ONE directory the test already owns, instead of a real
 * `git worktree`: what these tests are about is the dispatch, and a real
 * manager would put a `git worktree add` in front of every one of them for no
 * assertion's sake. The real one is proven against real git in
 * `session-worktree.test.ts`.
 *
 * The directory is created on `acquire` because it has to exist by the time the
 * engine process is spawned into it — the same guarantee the real manager gives
 * by checking out a worktree there.
 *
 * @param dir The path `acquire` hands back.
 * @returns The manager, with its ledger attached.
 */
function fakeWorktrees(dir: string): FakeWorktrees {
  const acquisitions: number[] = [];
  const releases: ReleaseCall[] = [];
  return {
    acquisitions,
    releases,
    acquire: (jobId) => {
      acquisitions.push(jobId);
      mkdirSync(dir, { recursive: true });
      return Promise.resolve({ path: dir, branch: `ticket-${jobId}` });
    },
    release: (worktree, outcome) => {
      releases.push({
        path: worktree.path,
        branch: worktree.branch,
        keep: outcome.keep,
      });
      return Promise.resolve();
    },
  };
}

/** The fake engine, wired the way every test in this file wires it. */
function fakeAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCommand(spec).args],
    }),
    graceMs: 300,
  });
}

/**
 * The one-engine registry, which is what every test that is NOT about routing
 * passes — and what production passed implicitly until t141 replaced the single
 * `adapter` with a table.
 */
function claudeOnly(
  adapter: ClaudeCodeAdapter,
): Record<string, DispatchModule.EngineRoute> {
  return {
    "claude-code": { adapter, decodeSessionText: decodeClaudeCodeSessionText },
  };
}

/**
 * Boots a control plane for a t147 test and hands back what it announced.
 *
 * No `authorizeGlobalFetch`, and that absence is the test device: with the
 * global untouched, the only credential that can reach the API is one the code
 * under test presents itself.
 */
async function bootUnpatched(
  t: TestHook,
): Promise<{ baseUrl: string; token: string }> {
  const readiness = await bootControlPlane(t);
  assert.ok(
    readiness.bootstrapToken !== null && readiness.bootstrapToken !== "",
    "each test boots against a database that never existed, so startup always mints and prints a token",
  );
  return { baseUrl: readiness.url, token: readiness.bootstrapToken };
}

test("t147 — with no token, the dispatch is refused 401 on its very first call", async (t) => {
  const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(
    "src/controller/cliente-controle.ts",
  );
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(
    path.join(tmpdir(), "cartografo-t147-anonymous-workdir-"),
  );
  const record = path.join(workDir, "despacho-sem-token.json");
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha despachada contra um control plane autenticado",
      no_entrada_id: "implementar",
      execucao_id: 147,
    },
    201,
    token,
  );

  // Everything a working dispatch gets, minus the credential.
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    engines: claudeOnly(fakeAdapter()),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
    envOverrides: {
      FAKE_ENGINE_RECORD: record,
      FAKE_ENGINE_LINES: linesWithoutBlock(),
    },
  });

  await assert.rejects(
    async () => dispatch(work.id),
    (error: unknown) => {
      assert.ok(
        error instanceof ErroDoControlPlane,
        `expected the control plane's own refusal, got: ${String(error)}`,
      );
      assert.equal(error.status, 401);
      assert.equal(
        error.message,
        `GET /v1/jobs/${work.id} answered 401`,
        "the read that opens a dispatch is where it dies: nothing after it ever runs",
      );
      return true;
    },
  );

  // Which is to say: no engine was started and no telemetry was written. A
  // dispatch that cannot read the work does not half-happen.
  assert.ok(
    !existsSync(record),
    "the engine process must never have been spawned",
  );
  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=147",
    undefined,
    200,
    token,
  );
  assert.equal(sessions.sessoes.length, 0);
});

test("t147 — with a token, the dispatch crosses every route it uses", async (t) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(
    path.join(tmpdir(), "cartografo-t147-authorized-workdir-"),
  );
  const record = path.join(workDir, "despacho-com-token.json");
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha despachada com credencial",
      no_entrada_id: "implementar",
      execucao_id: 147,
    },
    201,
    token,
  );

  // The operator token, which is what production has to pass here: none of the
  // seven routes this dispatch touches is on the runner surface t143 opened
  // (`packages/core/src/auth.ts`), so a pairing token would be refused 403.
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    engines: claudeOnly(fakeAdapter()),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
    token,
    permissions: { filesystem: { write: ["**"] }, network: { allowed: false } },
    envOverrides: {
      FAKE_ENGINE_RECORD: record,
      FAKE_ENGINE_LINES: linesWithDenialAndBlock(),
    },
  });

  // Resolving is already most of the proof: a refusal on ANY of the seven
  // routes rejects — the reads and the two writes at once, and the denial
  // report by way of the failure the dispatch re-throws at the very end.
  await dispatch(work.id);

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=147",
    undefined,
    200,
    token,
  );
  assert.equal(
    sessions.sessoes.length,
    1,
    "the session was opened through POST /v1/sessions",
  );
  assert.equal(
    sessions.sessoes[0].status,
    "concluida",
    "and closed through PATCH /v1/sessions/:id/finish",
  );

  const questions = await api<{ perguntas: Question[] }>(
    baseUrl,
    "GET",
    "/v1/input-requests",
    undefined,
    200,
    token,
  );
  assert.equal(
    questions.perguntas.length,
    1,
    "the question reached POST /v1/input-requests",
  );
  assert.equal(questions.perguntas[0].pergunta, ESCALATION.question);

  // The execution stream and not the work timeline: a denial is recorded
  // against the session and its payload carries no `trabalho_id`, so the work's
  // own timeline structurally cannot show it — the same contract the t106 test
  // above records for `sessao.finalizada`.
  const timeline = await api<{ eventos: Event[] }>(
    baseUrl,
    "GET",
    "/v1/executions/147/events",
    undefined,
    200,
    token,
  );
  assert.ok(
    timeline.eventos.some((event) => event.tipo === "sessao.permissao_negada"),
    "the denial reached POST /v1/sessions/:id/permission-denials",
  );
});

// --- t141: per-node engine routing ------------------------------------------

/** A node's contract, in the smallest shape the schema and soundness accept. */
function contract(): Record<string, unknown> {
  return {
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    checks: [
      {
        type: "deterministic",
        command: "test -s saida.md",
        description: "A saída existe.",
      },
    ],
  };
}

/**
 * A `trabalho` node, with `engine` only when the routing test declares one.
 *
 * The `skill_ref` points at the fixture manifest this file registers, and since
 * t161 that is not decoration: a dispatch that resolves a node now resolves its
 * skill too, and refuses to open a session for one the registry does not carry
 * or whose pin does not match. The placeholder this used to carry
 * (`cartografo/fazer`, a zero hash) could never have been registered at all —
 * the registry's ids are kebab-case, with no slash.
 */
function node(id: string, engine?: string): Record<string, unknown> {
  return {
    id,
    role: "desenvolvedor",
    node_type: "work",
    description: `Nó ${id} da prova de roteamento por nó.`,
    skill_ref: skillPin(WORK_SKILL),
    contract: contract(),
    ...(engine === undefined ? {} : { engine }),
  };
}

/**
 * A registrable two-node graph: the first node says nothing about an engine, the
 * second declares one. It is the smallest document that can tell a default from
 * a route.
 */
function twoEngineGraph(
  className: string,
  engine: string | undefined,
): Record<string, unknown> {
  return {
    problem_class: className,
    lineage: { type: "base" },
    metadata: {
      name: "Prova de roteamento por nó",
      description:
        "Dois nós de trabalho numa aresta, um deles declarando engine.",
      schema_version: "1.0.0",
      created_at: "2026-08-15",
      source: "fixture da t141",
    },
    nodes: [node("implementar"), node("revisar", engine)],
    edges: [{ from: "implementar", to: "revisar", condition: "sempre" }],
    initial_node: "implementar",
    final_nodes: ["revisar"],
    // Required and empty since t168: this class declares no field on its
    // tickets, and the key is what says so out loud.
    custom_fields: [],
  };
}

/** The `codex` adapter, pointed at the fake engine through its own argv seam. */
function fakeCodexAdapter(): CodexAdapter {
  return new CodexAdapter({
    commandBuilder: (spec) => ({
      command: process.execPath,
      args: [FAKE_ENGINE, ...buildCodexCommand(spec).args],
    }),
    graceMs: 300,
  });
}

/** Registers the graph and returns the version id a job can point at. */
async function registerGraph(
  baseUrl: string,
  token: string,
  document: Record<string, unknown>,
): Promise<string> {
  const registered = await api<{ grafo_versao: { id: string } }>(
    baseUrl,
    "POST",
    "/v1/graphs",
    document,
    201,
    token,
  );
  return registered.grafo_versao.id;
}

/** The two skill manifests this file registers, read from disk. */
const WORK_SKILL = "skill-travessia-fazer.json";
const GATE_SKILL = "skill-travessia-conferir.json";

/** A registered skill, in the recut these tests read. */
interface RegisteredSkill {
  id: string;
  version: string;
  hash: string;
  role: string;
  description: string;
  instructions: string;
  checks: Record<string, unknown>[];
  permissions: Record<string, unknown>;
}

/** Reads one of the committed manifest fixtures. */
function manifest(file: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(PACKAGE_ROOT, "test", "fixtures", file), "utf8"),
  ) as Record<string, unknown>;
}

/**
 * The `skill_ref` a graph node carries for one of the fixture manifests.
 *
 * Taken from the manifest itself, never typed by hand: the pin is the whole
 * point, and a hash copied by eye into a fixture is a test that would pass while
 * the mismatch refusal was broken.
 */
function skillPin(file: string): Record<string, unknown> {
  const document = manifest(file);
  return {
    id: document.id,
    version: document.version,
    hash: document.hash,
  };
}

/** Registers a manifest fixture in the skill registry (idempotent per plane). */
async function registerSkill(
  baseUrl: string,
  token: string,
  file: string,
): Promise<RegisteredSkill> {
  return await api<RegisteredSkill>(
    baseUrl,
    "POST",
    "/v1/skills",
    manifest(file),
    201,
    token,
  );
}

/**
 * The three routing acceptance tests share ONE control plane, on purpose.
 *
 * Booting a real server per test is what the rest of this file does, and at
 * three more boots it stopped being free: the extra parallel load made the
 * conformance kit's C4 — which sleeps a fixed settle before reading the fake
 * engine's sidecar — miss its window and fail in a file this ficha never
 * touched. One boot for three tests keeps the suite's cost where it was.
 *
 * Nothing is shared BETWEEN the subtests except the server: each registers its
 * own graph class, creates its own work under its own `execucao_id`, and
 * queries back only its own.
 */
test("t141 — the engine is resolved from the node the work is standing on", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);

  // Registered once for the three subtests: since t161 a node with a skill the
  // registry never heard of does not dispatch at all, so the routing proof
  // needs a real registration underneath it.
  await registerSkill(baseUrl, token, WORK_SKILL);

  await parent.test(
    'AT3 — a node declaring engine "codex" is dispatched through the codex route',
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);
      const { decodeCodexSessionText } =
        await loadModule<typeof SessionTextModule>(SESSION_TEXT_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t141-codex-workdir-"),
      );
      const claudeRecord = path.join(workDir, "nunca-despachado.json");
      const codexRecord = path.join(workDir, "despacho-codex.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        twoEngineGraph("roteamento-por-no-at3", "codex"),
      );

      // The work is created ON the node that declares the engine: the dispatch
      // resolves the CURRENT node, not the entry one.
      const work = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cujo nó declara codex",
          no_entrada_id: "revisar",
          execucao_id: 141,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const dispatch = createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: {
          "claude-code": {
            adapter: fakeAdapter(),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
          codex: {
            adapter: fakeCodexAdapter(),
            decodeSessionText: decodeCodexSessionText,
          },
        },
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: codexRecord,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      });

      await dispatch(work.id);

      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=141",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes.length, 1);
      assert.equal(
        sessions.sessoes[0].engine,
        "codex",
        "the engine the node declared is the engine the telemetry records",
      );
      assert.equal(sessions.sessoes[0].no_id, "revisar");

      // ...and the route that ran is the codex one, by the only channel that
      // proves it: the argv the fake engine received.
      assert.ok(
        existsSync(codexRecord),
        "the codex route never started a session",
      );
      assert.ok(
        !existsSync(claudeRecord),
        "the default route must not have run",
      );
      const received = JSON.parse(
        readFileSync(codexRecord, "utf8"),
      ) as FakeRecord;
      assert.ok(
        received.argv.includes("exec") &&
          received.argv.includes("--skip-git-repo-check"),
        `the argv is the one codex's own command builder produces:\n${received.argv.join(" ")}`,
      );
    },
  );

  await parent.test(
    "AT4 — with no graph version, and with a node that declares nothing, the default runs",
    async (t) => {
      const { createClaudeCodeDispatch, DEFAULT_ENGINE } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t141-default-workdir-"),
      );
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      assert.equal(
        DEFAULT_ENGINE,
        "claude-code",
        "the default is named, never silently implied",
      );

      const engines = {
        [DEFAULT_ENGINE]: {
          adapter: fakeAdapter(),
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      };

      // --- 1. no `grafo_versao_id` at all: today's behaviour, byte for byte ------
      const bare = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha sem grafo",
          no_entrada_id: "implementar",
          execucao_id: 1410,
        },
        201,
        token,
      );

      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines,
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: path.join(workDir, "sem-grafo.json"),
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      })(bare.id);

      // --- 2. a graph whose current node declares no engine ---------------------
      const versionId = await registerGraph(
        baseUrl,
        token,
        twoEngineGraph("roteamento-por-no-at4", undefined),
      );
      const onGraph = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cujo nó não declara engine",
          no_entrada_id: "implementar",
          execucao_id: 1411,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines,
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: path.join(workDir, "no-sem-engine.json"),
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      })(onGraph.id);

      for (const executionId of [1410, 1411]) {
        const sessions = await api<{ sessoes: Session[] }>(
          baseUrl,
          "GET",
          `/v1/sessions?execucao_id=${executionId}`,
          undefined,
          200,
          token,
        );
        assert.equal(
          sessions.sessoes.length,
          1,
          `execution ${executionId} dispatched exactly once`,
        );
        assert.equal(
          sessions.sessoes[0].engine,
          DEFAULT_ENGINE,
          `execution ${executionId} must fall back to the default engine`,
        );
        assert.equal(sessions.sessoes[0].status, "concluida");
      }
    },
  );

  await parent.test(
    "AT5 — a node declaring an engine nobody registered fails before any session opens",
    async (t) => {
      const { createClaudeCodeDispatch, UnknownEngineError } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t141-unknown-workdir-"),
      );
      const record = path.join(workDir, "nunca-despachado.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        twoEngineGraph("roteamento-por-no-at5", "gemini"),
      );
      const work = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cujo nó pede um engine que ninguém registrou",
          no_entrada_id: "revisar",
          execucao_id: 1412,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      // A spy that counts, so "before any session opens" is a measured claim and
      // not an inference from the absence of a row.
      const posts: string[] = [];
      const doFetch: typeof fetch = async (input, init) => {
        if ((init?.method ?? "GET") === "POST")
          posts.push(String(input).slice(baseUrl.length));
        return fetch(input, init);
      };

      const dispatch = createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: {
          "claude-code": {
            adapter: fakeAdapter(),
            decodeSessionText: decodeClaudeCodeSessionText,
          },
        },
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      });

      await assert.rejects(
        async () => dispatch(work.id),
        (error: unknown) => {
          assert.ok(
            error instanceof UnknownEngineError,
            `expected UnknownEngineError, got: ${String(error)}`,
          );
          assert.equal(error.engine, "gemini");
          assert.equal(error.nodeId, "revisar");
          return true;
        },
      );

      // Never a silent fallback: a session recorded against another engine would
      // make the telemetry lie about what actually ran.
      assert.deepEqual(
        posts.filter((route) => route === "/v1/sessions"),
        [],
        "POST /v1/sessions must never be reached for an engine that has no route",
      );
      assert.ok(!existsSync(record), "no engine process may have been spawned");

      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=1412",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes.length, 0);
    },
  );
});

// --- t148: a control-plane call that fails must not leak the session --------

/**
 * `true` while the pid exists; `EPERM` counts as alive (it exists, and is not
 * ours to signal).
 *
 * A local copy of what `src/engine/conformance-kit.ts:163-180` already does.
 * The kit does not export it, and one caller outside the kit is not yet the two
 * consumers this project asks for before it moves anything into a shared
 * surface — when the second one shows up, this is the pair to extract.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls until the pid is gone, and fails the test if it never is. */
async function requireProcessDead(
  pid: number,
  label: string,
  deadlineMs = 5_000,
): Promise<void> {
  const limit = Date.now() + deadlineMs;
  while (Date.now() < limit) {
    if (!isProcessAlive(pid)) return;
    await delay(25);
  }
  assert.fail(
    `${label}: process ${pid} was still alive ${deadlineMs}ms after the dispatch settled (leaked session)`,
  );
}

/**
 * SIGKILLs whatever is left of an engine process, group first.
 *
 * The cleanup half of the acceptance criteria: whichever way these two tests
 * end — green, red or thrown — no fake engine of theirs may outlive them. The
 * engine comes up `detached`, so the group is the honest target and the direct
 * pid is only the fallback.
 */
function killIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it died between the check and the signal; nothing to do */
    }
  }
}

/**
 * Waits for the fake engine's sidecar and reads it.
 *
 * `startSession` resolves on the process's `spawn` event, which happens long
 * before the fake engine has run a line of its own — so "the engine is up" and
 * "the engine has recorded itself" are two different instants, and only the
 * second one has a pid in it.
 */
async function waitForRecord(
  recordPath: string,
  deadlineMs = DEADLINE_MS,
): Promise<FakeRecord> {
  const limit = Date.now() + deadlineMs;
  while (Date.now() < limit) {
    if (existsSync(recordPath)) {
      try {
        return JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
      } catch {
        /* caught the file mid-write; read it again on the next turn */
      }
    }
    await delay(25);
  }
  throw new Error(
    `the fake engine never recorded itself at ${recordPath} within ${deadlineMs}ms`,
  );
}

/** The body a control plane that fell over would send back. */
function serverError(): Response {
  return new Response(JSON.stringify({ erro: "o control plane caiu" }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}

test("t148 — POST /v1/sessions fails after the engine started: the session is cancelled, not leaked", async (t) => {
  const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(
    "src/controller/cliente-controle.ts",
  );
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t148-leak-"));
  const recordPath = path.join(workDir, "despacho-que-vazou.json");
  let enginePid: number | null = null;
  t.after(() => {
    if (enginePid !== null) killIfAlive(enginePid);
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha cujo POST /v1/sessions cai com o engine já de pé",
      no_entrada_id: "implementar",
      execucao_id: 148,
    },
    201,
    token,
  );

  // Everything reaches the real control plane except the one call this test is
  // about, which never gets there: it fails outright, the way a 500 or a
  // dropped connection fails.
  //
  // Waiting for the sidecar before answering is what makes the race a
  // certainty instead of a coincidence — the failure has to land while the
  // engine process is provably up and writing in `workingDir`.
  const doFetch: typeof fetch = async (input, init) => {
    const target = String(input);
    if ((init?.method ?? "GET") === "POST" && target.endsWith("/v1/sessions")) {
      enginePid = (await waitForRecord(recordPath)).pid;
      return serverError();
    }
    return fetch(input, init);
  };

  const worktrees = fakeWorktrees(workDir);
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    token,
    doFetch,
    engines: claudeOnly(fakeAdapter()),
    worktrees,
    timeoutSeconds: 60,
    envOverrides: {
      FAKE_ENGINE_RECORD: recordPath,
      // The session never ends on its own: if it dies, somebody killed it, and
      // this test is about who.
      FAKE_ENGINE_HANG: "1",
      FAKE_ENGINE_LINES: linesWithoutBlock(),
    },
  });

  await assert.rejects(
    async () => dispatch(work.id),
    (error: unknown) => {
      assert.ok(
        error instanceof ErroDoControlPlane,
        `the original failure must be what propagates, got: ${String(error)}`,
      );
      assert.equal(error.status, 500);
      assert.equal(
        error.message,
        "POST /v1/sessions answered 500",
        "cancelling the session may not replace the error that caused it",
      );
      return true;
    },
  );

  // The controller's `finally` has already given the lease back by now, so the
  // work is a candidate again: an engine still alive in this working dir is a
  // second session about to be dispatched on top of the first.
  assert.ok(
    enginePid !== null,
    "the fake engine must have recorded itself before the call failed",
  );
  await requireProcessDead(enginePid, "t148 (engine process)");

  // ...and nothing was left half-open on the other side either.
  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=148",
    undefined,
    200,
    token,
  );
  assert.equal(
    sessions.sessoes.length,
    0,
    "the call that failed is the one that would have created the row",
  );

  // t160, AT10 — the other half of FR8, on the one exit path only this test
  // reaches: a failure with the session already open. Nothing about this
  // dispatch is `completed`, so the tree is kept, and it is kept exactly once.
  assert.deepEqual(
    worktrees.releases.map((release) => release.keep),
    [true],
    "a dispatch that died with the engine up has to release its worktree once, keeping it for diagnosis",
  );
});

test("t148 — the finish PATCH fails after the session ended: the escalation question is still posted", async (t) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t148-finish-"));
  const recordPath = path.join(workDir, "despacho-sem-fechamento.json");
  t.after(() => {
    if (existsSync(recordPath)) {
      const { pid } = JSON.parse(
        readFileSync(recordPath, "utf8"),
      ) as FakeRecord;
      killIfAlive(pid);
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha que pergunta e cujo fechamento de sessão cai",
      no_entrada_id: "implementar",
      execucao_id: 1481,
    },
    201,
    token,
  );

  // Only the finish PATCH fails. The session itself ended `completed` with a
  // block in its output, so the question is real, parsed and owed to a human.
  const doFetch: typeof fetch = async (input, init) => {
    const target = String(input);
    if (
      (init?.method ?? "GET") === "PATCH" &&
      /\/v1\/sessions\/\d+\/finish$/.test(target)
    ) {
      return serverError();
    }
    return fetch(input, init);
  };

  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    token,
    doFetch,
    engines: claudeOnly(fakeAdapter()),
    worktrees: fakeWorktrees(workDir),
    timeoutSeconds: 60,
    envOverrides: {
      FAKE_ENGINE_RECORD: recordPath,
      FAKE_ENGINE_LINES: linesWithBlock(),
    },
  });

  // Failing is right — the runner owes the control plane a write it could not
  // make. Failing BEFORE asking is not: "asking is not failing" is the whole
  // invariant, and a question dropped here is a human who is never called.
  await assert.rejects(async () => dispatch(work.id));

  const questions = await api<{ perguntas: Question[] }>(
    baseUrl,
    "GET",
    "/v1/input-requests",
    undefined,
    200,
    token,
  );
  assert.equal(
    questions.perguntas.length,
    1,
    "the question the session asked has to reach POST /v1/input-requests anyway",
  );
  const question = questions.perguntas[0];
  assert.equal(question.trabalho_id, work.id);
  assert.equal(question.pergunta, ESCALATION.question);
  assert.equal(question.contexto, ESCALATION.context);
  assert.deepEqual(question.opcoes, ESCALATION.options);
  assert.equal(question.recomendacao, ESCALATION.recommendation);
  assert.equal(question.resposta_padrao, ESCALATION.default);
});

// --- t160: one worktree per session -----------------------------------------

/**
 * An adapter that ends the session with the terminal status the test asked for.
 *
 * A stub and not the fake engine, for one case only the interface can produce:
 * `cancelled` never comes out of a fake engine this dispatch drives — the
 * dispatch cancels exactly once, on a path where it never awaits the outcome
 * (t148). AT10's claim is about the dispatch's bookkeeping per outcome status,
 * so the honest fixture is the status itself, delivered through the listener the
 * interface defines.
 *
 * @param status What `onFinished` reports.
 * @returns The adapter, with the rest of the interface answering trivially.
 */
function stubAdapter(status: SessionStatus): EngineAdapter {
  return {
    engineName: "claude-code",
    startSession: (_spec, listener) => {
      // On the next turn of the loop, never inside `startSession`: the dispatch
      // is entitled to have its handle before the outcome lands.
      queueMicrotask(() => {
        listener.onFinished(status, status === "completed" ? 0 : 1);
      });
      return Promise.resolve("stub-session");
    },
    getStatus: () => Promise.resolve(status),
    cancel: () => Promise.resolve(),
    capabilities: () => ({}),
    verifyCli: () =>
      Promise.resolve({ available: true, version: "stub", authenticated: true }),
  };
}

test("t160 AT8 — the session runs in the directory the worktree manager handed out", async (t) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t160-at8-"));
  // The path the manager hands out is NOT the directory the test happens to
  // own: with the static option gone, the only way the engine can end up here
  // is through `acquire` (FR6, FR7).
  const worktreePath = path.join(workDir, "worktree-da-sessao");
  const record = path.join(workDir, "despacho-em-worktree.json");
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha que roda no worktree que o runner criou",
      no_entrada_id: "implementar",
      execucao_id: 160,
    },
    201,
    token,
  );

  const worktrees = fakeWorktrees(worktreePath);
  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    token,
    engines: claudeOnly(fakeAdapter()),
    worktrees,
    timeoutSeconds: 60,
    envOverrides: {
      FAKE_ENGINE_RECORD: record,
      FAKE_ENGINE_LINES: linesWithoutBlock(),
    },
  });

  await dispatch(work.id);

  assert.deepEqual(
    worktrees.acquisitions,
    [work.id],
    "the worktree is acquired once, for the job being dispatched",
  );

  // The only channel that proves it: where the engine PROCESS actually ran.
  // `realpathSync` because macOS hands out `/var/folders/...` temp dirs that the
  // child reports as `/private/var/folders/...`.
  const received = JSON.parse(readFileSync(record, "utf8")) as FakeRecord;
  assert.equal(
    received.cwd,
    realpathSync(worktreePath),
    "the engine ran somewhere other than the worktree it was given",
  );

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=160",
    undefined,
    200,
    token,
  );
  assert.equal(sessions.sessoes.length, 1);
  assert.equal(
    sessions.sessoes[0].working_dir,
    worktreePath,
    "the telemetry has to record the directory the session really had",
  );
});

test("t160 AT9 — a worktree that cannot be created blocks the dispatch before any session opens", async (t) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(t);

  const work = await api<Work>(
    baseUrl,
    "POST",
    "/v1/jobs",
    {
      titulo: "ficha cujo worktree não pôde ser criado",
      no_entrada_id: "implementar",
      execucao_id: 1601,
    },
    201,
    token,
  );

  const failure = new Error("git worktree add exited 128");
  const releases: unknown[] = [];
  const worktrees: WorktreeModule.WorktreeManager = {
    acquire: () => Promise.reject(failure),
    release: (worktree, outcome) => {
      releases.push({ worktree, outcome });
      return Promise.resolve();
    },
  };

  // A counting adapter, so "no session opened" is measured at the interface and
  // not inferred from the absence of a row.
  const real = fakeAdapter();
  let starts = 0;
  const counting: EngineAdapter = {
    engineName: real.engineName,
    startSession: (spec, listener) => {
      starts += 1;
      return real.startSession(spec, listener);
    },
    getStatus: (id) => real.getStatus(id),
    cancel: (id, status) => real.cancel(id, status),
    capabilities: () => real.capabilities(),
    verifyCli: () => real.verifyCli(),
  };

  const posts: string[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    if ((init?.method ?? "GET") === "POST")
      posts.push(String(input).slice(baseUrl.length));
    return fetch(input, init);
  };

  const dispatch = createClaudeCodeDispatch({
    urlBase: baseUrl,
    token,
    doFetch,
    engines: {
      "claude-code": {
        adapter: counting,
        decodeSessionText: decodeClaudeCodeSessionText,
      },
    },
    worktrees,
    timeoutSeconds: 60,
  });

  await assert.rejects(
    async () => dispatch(work.id),
    (error: unknown) => {
      assert.equal(
        error,
        failure,
        `the manager's own error is what a human has to read, got: ${String(error)}`,
      );
      return true;
    },
  );

  assert.equal(
    starts,
    0,
    "a session was opened without an isolated directory to open it in",
  );
  assert.deepEqual(
    posts.filter((route) => route === "/v1/sessions"),
    [],
    "POST /v1/sessions must never be reached when there is no worktree",
  );
  assert.deepEqual(
    releases,
    [],
    "nothing was acquired, so there is nothing to release",
  );

  const sessions = await api<{ sessoes: Session[] }>(
    baseUrl,
    "GET",
    "/v1/sessions?execucao_id=1601",
    undefined,
    200,
    token,
  );
  assert.equal(sessions.sessoes.length, 0);
});

/**
 * AT10 — the outcome, and only the outcome, decides whether the tree is kept.
 *
 * Four outcomes through one control plane, for the reason the t141 block above
 * records: booting a real server per subtest is not free, and nothing is shared
 * between them except the server.
 *
 * The fifth path of FR8 — a control-plane failure with the session already open
 * — lives in the t148 test above, which is the one that produces it.
 */
test("t160 AT10 — the outcome decides whether the worktree is kept", async (parent) => {
  const { createClaudeCodeDispatch, DispatchError } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

  const { baseUrl, token } = await bootUnpatched(parent);

  const cases = [
    { status: "completed", keep: false },
    { status: "failed", keep: true },
    { status: "timed_out", keep: true },
    { status: "cancelled", keep: true },
  ] as const;

  for (const [index, scenario] of cases.entries()) {
    await parent.test(
      `a session that ends "${scenario.status}" releases with keep: ${String(scenario.keep)}`,
      async (t) => {
        const workDir = mkdtempSync(
          path.join(tmpdir(), `cartografo-t160-at10-${scenario.status}-`),
        );
        t.after(() => {
          rmSync(workDir, { recursive: true, force: true });
        });

        const executionId = 1610 + index;
        const work = await api<Work>(
          baseUrl,
          "POST",
          "/v1/jobs",
          {
            titulo: `ficha cuja sessão termina como ${scenario.status}`,
            no_entrada_id: "implementar",
            execucao_id: executionId,
          },
          201,
          token,
        );

        const worktrees = fakeWorktrees(workDir);
        const dispatch = createClaudeCodeDispatch({
          urlBase: baseUrl,
          token,
          engines: {
            "claude-code": {
              adapter: stubAdapter(scenario.status),
              decodeSessionText: decodeClaudeCodeSessionText,
            },
          },
          worktrees,
          timeoutSeconds: 60,
        });

        if (scenario.status === "completed") {
          await dispatch(work.id);
        } else {
          await assert.rejects(
            async () => dispatch(work.id),
            (error: unknown) => {
              assert.ok(
                error instanceof DispatchError,
                `expected DispatchError, got: ${String(error)}`,
              );
              assert.equal(error.status, scenario.status);
              return true;
            },
          );
        }

        assert.deepEqual(
          worktrees.releases.map((release) => release.keep),
          [scenario.keep],
          `a "${scenario.status}" dispatch must release exactly once, with keep: ${String(scenario.keep)}`,
        );
        assert.equal(
          worktrees.releases[0].branch,
          `ticket-${work.id}`,
          "the worktree released is the one this job acquired",
        );
      },
    );
  }
});

// --- t163: the silence budget, and the cause of a watchdog stop --------------

/** An adapter that records what it was asked for and ends however the case needs. */
interface BudgetProbe {
  adapter: EngineAdapter;
  /** Every `SessionSpec` the dispatch handed the engine, in order. */
  readonly specs: SessionSpec[];
}

/**
 * The fixture for both halves of t163's dispatch surface.
 *
 * A stub and not the fake engine, for the reason {@link stubAdapter} already
 * records one case up: the outcome under test is one only the INTERFACE can
 * produce. A real silence stop takes a real silent minute, and what this test
 * is about is not the watchdog (C9 certifies that, against both adapters) but
 * what the dispatch does with the outcome it is handed.
 *
 * @param outcome What `onFinished` reports, third argument included.
 * @returns The adapter plus the ledger of specs it received.
 */
function recordingAdapter(outcome: {
  status: SessionStatus;
  exitCode: number | null;
  detail?: SessionFinishDetail;
}): BudgetProbe {
  const specs: SessionSpec[] = [];
  return {
    specs,
    adapter: {
      engineName: "claude-code",
      startSession: (spec, listener) => {
        specs.push(spec);
        // On the next turn of the loop, never inside `startSession`: the
        // dispatch is entitled to have its handle before the outcome lands.
        queueMicrotask(() => {
          listener.onFinished(outcome.status, outcome.exitCode, outcome.detail);
        });
        return Promise.resolve("recording-session");
      },
      getStatus: () => Promise.resolve(outcome.status),
      cancel: () => Promise.resolve(),
      capabilities: () => ({}),
      verifyCli: () =>
        Promise.resolve({
          available: true,
          version: "recording",
          authenticated: true,
        }),
    },
  };
}

test("t163 — the silence budget is resolved, dispatched and reported with its cause", async (parent) => {
  const { createClaudeCodeDispatch, DEFAULT_SILENCE_SECONDS, DispatchError } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);
  const { resolveBudget } = await loadModule<typeof BudgetModule>(
    "src/engine/resolve-budget.ts",
  );

  const { baseUrl, token } = await bootUnpatched(parent);

  /** One call the dispatch made, as the spy in front of `fetch` saw it. */
  interface Call {
    method: string;
    route: string;
    body: unknown;
  }

  /**
   * Runs one dispatch and hands back what the engine and the API saw.
   *
   * @param t The subtest, for the worktree cleanup.
   * @param executionId Slices this case's session away from its neighbours'.
   * @param outcome What the stub adapter reports.
   * @param options What the case declares on top of the fixed wiring.
   * @returns The specs the engine received, the calls the dispatch made, and the
   *   failure it settled with, if any.
   */
  const run = async (
    t: TestHook,
    executionId: number,
    outcome: {
      status: SessionStatus;
      exitCode: number | null;
      detail?: SessionFinishDetail;
    },
    options: { silenceSeconds?: number } = {},
  ): Promise<{ specs: SessionSpec[]; calls: Call[]; failure: unknown }> => {
    const workDir = mkdtempSync(
      path.join(tmpdir(), `cartografo-t163-${String(executionId)}-`),
    );
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const work = await api<Work>(
      baseUrl,
      "POST",
      "/v1/jobs",
      {
        titulo: "ficha com orçamento de silêncio",
        no_entrada_id: "implementar",
        execucao_id: executionId,
      },
      201,
      token,
    );

    const calls: Call[] = [];
    const doFetch: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        route: String(input).slice(baseUrl.length),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return fetch(input, init);
    };

    const probe = recordingAdapter(outcome);
    const dispatch = createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      doFetch,
      engines: {
        "claude-code": {
          adapter: probe.adapter,
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      },
      worktrees: fakeWorktrees(workDir),
      timeoutSeconds: 60,
      ...(options.silenceSeconds === undefined
        ? {}
        : { silenceSeconds: options.silenceSeconds }),
    });

    let failure: unknown = null;
    try {
      await dispatch(work.id);
    } catch (error) {
      failure = error;
    }
    return { specs: probe.specs, calls, failure };
  };

  const opened = (calls: Call[]): Record<string, unknown> => {
    const call = calls.find(
      (candidate) =>
        candidate.method === "POST" && candidate.route === "/v1/sessions",
    );
    assert.ok(call, "the dispatch never called POST /v1/sessions");
    return call.body as Record<string, unknown>;
  };

  const finished = (calls: Call[]): Record<string, unknown> => {
    const call = calls.find(
      (candidate) =>
        candidate.method === "PATCH" && candidate.route.endsWith("/finish"),
    );
    assert.ok(call, "the dispatch never called PATCH /v1/sessions/:id/finish");
    return call.body as Record<string, unknown>;
  };

  await parent.test(
    "an undeclared budget resolves to the server ceiling, and the session record carries it",
    async (t) => {
      const { specs, calls } = await run(t, 1630, {
        status: "completed",
        exitCode: 0,
      });

      assert.equal(
        DEFAULT_SILENCE_SECONDS,
        300,
        "the ceiling is flowpilot's own DEFAULT_SILENCE_SECONDS",
      );
      assert.equal(
        specs[0]?.silenceSeconds,
        DEFAULT_SILENCE_SECONDS,
        "a dispatch that declares nothing still arms the inactivity watchdog",
      );
      assert.equal(opened(calls).silence_seconds, DEFAULT_SILENCE_SECONDS);

      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=1630",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes[0]?.silence_seconds, DEFAULT_SILENCE_SECONDS);
    },
  );

  await parent.test(
    "a declared budget resolves through the min() rule, and zero is no override",
    async (t) => {
      for (const [index, declared] of [120, 86_400, 0].entries()) {
        const { specs } = await run(
          t,
          1631 + index,
          { status: "completed", exitCode: 0 },
          { silenceSeconds: declared },
        );
        assert.equal(
          specs[0]?.silenceSeconds,
          resolveBudget(declared, DEFAULT_SILENCE_SECONDS),
          `a declared ${declared}s did not resolve against the ${DEFAULT_SILENCE_SECONDS}s ceiling`,
        );
      }
    },
  );

  for (const [index, reason] of (["silence", "wall_clock"] as const).entries()) {
    await parent.test(
      `a "${reason}" stop closes the session as tempo_esgotado with its cause`,
      async (t) => {
        const { calls, failure } = await run(t, 1640 + index, {
          status: "timed_out",
          exitCode: null,
          detail: { timeoutReason: reason },
        });

        assert.ok(
          failure instanceof DispatchError,
          `a session that ran a watchdog out is not a successful dispatch, got: ${String(failure)}`,
        );

        const body = finished(calls);
        assert.equal(
          body.status,
          "tempo_esgotado",
          "both watchdogs land on the one status the taxonomy already has",
        );
        assert.equal(
          body.timeout_reason,
          reason,
          "the cause is what separates them, and it rides in the payload",
        );
      },
    );
  }

  await parent.test(
    "a bare timed_out sends timeout_reason null, never a fabricated cause",
    async (t) => {
      const { calls, failure } = await run(t, 1642, {
        status: "timed_out",
        exitCode: null,
      });

      assert.ok(failure instanceof DispatchError);
      const body = finished(calls);
      assert.equal(body.status, "tempo_esgotado");
      assert.equal(
        body.timeout_reason,
        null,
        'an adapter that reported no cause has to read as "unknown", never as one of the two',
      );
    },
  );
});

// --- t161: the graph drives the session, and the session advances the node ---

/**
 * The three fixture graphs every t161 case below registers, all built from the
 * committed fixture on disk.
 *
 * A class per case: `POST /v1/graphs` keys the lineage by `problem_class`, and two
 * subtests registering the same base class collide with each other rather than
 * with anything this ficha is about.
 */
function traversalGraph(className: string): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(
      path.join(PACKAGE_ROOT, "test", "fixtures", "grafo-travessia.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  return { ...document, problem_class: className };
}

/** The lines a fake gate session prints when it chooses an edge by name. */
function linesWithResult(result: string): string {
  return JSON.stringify([
    { stream: "stdout", text: "Conferi o artefato contra o que a etapa pedia." },
    { stream: "stdout", text: "```resultado" },
    { stream: "stdout", text: JSON.stringify({ resultado: result }) },
    { stream: "stdout", text: "```" },
  ]);
}

test("t161 — the node's skill drives the session, and the session advances the node", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);

  const workSkill = await registerSkill(baseUrl, token, WORK_SKILL);
  const gateSkill = await registerSkill(baseUrl, token, GATE_SKILL);

  /** One call the dispatch made, as the spy in front of `fetch` saw it. */
  interface Call {
    method: string;
    route: string;
    body: unknown;
  }

  /** A spy that records every call and delegates to the real control plane. */
  function spy(): { doFetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const doFetch: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        route: String(input).slice(baseUrl.length),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return fetch(input, init);
    };
    return { doFetch, calls };
  }

  /** The transitions a dispatch posted, in order, as `para_no_id` values. */
  function transitions(calls: Call[]): string[] {
    return calls
      .filter(
        (call) => call.method === "POST" && call.route.endsWith("/transitions"),
      )
      .map((call) => (call.body as { para_no_id: string }).para_no_id);
  }

  await parent.test(
    "AT12 — a resolvable node dispatches the rendered skill; a graph-less one keeps the literal",
    async (t) => {
      const { createClaudeCodeDispatch, DEFAULT_INSTRUCTIONS } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t161-render-"),
      );
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at12"),
      );

      const onGraph = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num nó com skill registrada",
          no_entrada_id: "publicar",
          execucao_id: 1612,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );
      const bare = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha sem grafo nenhum",
          no_entrada_id: "publicar",
          execucao_id: 1612,
        },
        201,
        token,
      );

      const record = path.join(workDir, "com-grafo.json");
      const bareRecord = path.join(workDir, "sem-grafo.json");
      const base = {
        urlBase: baseUrl,
        token,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
      };

      await createClaudeCodeDispatch({
        ...base,
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      })(onGraph.id);

      await createClaudeCodeDispatch({
        ...base,
        envOverrides: {
          FAKE_ENGINE_RECORD: bareRecord,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      })(bare.id);

      // The argv is the channel: `buildCommand` puts `instructions` on it, so
      // what the process received IS what the session was told.
      const withGraph = (JSON.parse(readFileSync(record, "utf8")) as FakeRecord)
        .argv.join("\n");
      const withoutGraph = (
        JSON.parse(readFileSync(bareRecord, "utf8")) as FakeRecord
      ).argv.join("\n");

      assert.ok(
        withGraph.includes(workSkill.instructions),
        "the session of a node with a registered skill gets the manifest's own instructions",
      );
      assert.ok(
        withGraph.includes(workSkill.description),
        "...and the description that catalogues it",
      );
      assert.ok(
        !withGraph.includes(
          "Trabalhe no diretório atual e faça o que o trabalho pede.",
        ),
        "the fixed literal is what this ficha replaces, not something it appends to",
      );
      assert.ok(
        withGraph.includes("```input-request"),
        "the escalation protocol survives the replacement, or the cycle t106 built stops working",
      );

      assert.ok(
        withoutGraph.includes(DEFAULT_INSTRUCTIONS),
        "a work with no graph is dispatched exactly as it was before this ficha",
      );
    },
  );

  await parent.test(
    "AT13 — a skill-hash mismatch refuses before POST /v1/sessions is reached",
    async (t) => {
      const { createClaudeCodeDispatch, SkillPinMismatchError } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t161-pin-"));
      const record = path.join(workDir, "nunca-despachado.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      // The same graph, with one node's pin tampered with — which is exactly
      // the supply-chain swap D4 exists to catch: the registry still carries
      // the skill, and the document points at content nobody registered.
      const document = traversalGraph("travessia-t161-at13");
      const nodes = document.nodes as Array<Record<string, unknown>>;
      const tampered = nodes.map((node) =>
        node.id === "publicar"
          ? {
              ...node,
              skill_ref: {
                ...(node.skill_ref as Record<string, unknown>),
                hash: `sha256:${"f".repeat(64)}`,
              },
            }
          : node,
      );
      const versionId = await registerGraph(baseUrl, token, {
        ...document,
        nodes: tampered,
      });

      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cujo nó aponta para uma skill adulterada",
          no_entrada_id: "publicar",
          execucao_id: 1613,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      const dispatch = createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      });

      await assert.rejects(
        async () => dispatch(job.id),
        (error: unknown) => {
          assert.ok(
            error instanceof SkillPinMismatchError,
            `expected SkillPinMismatchError, got: ${String(error)}`,
          );
          assert.equal(error.nodeId, "publicar");
          assert.equal(error.registered, workSkill.hash);
          return true;
        },
      );

      assert.deepEqual(
        calls.filter(
          (call) => call.method === "POST" && call.route === "/v1/sessions",
        ),
        [],
        "POST /v1/sessions must never be reached for a pin that does not match",
      );
      assert.ok(
        !existsSync(record),
        "and no engine process may have been spawned",
      );

      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=1613",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes.length, 0);
    },
  );

  await parent.test(
    "AT14 — a single-outgoing-edge node transitions with no operator in the loop",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t161-single-"),
      );
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at14"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num nó de saída única",
          no_entrada_id: "implementar",
          execucao_id: 1614,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithoutBlock() },
      })(job.id);

      assert.deepEqual(
        transitions(calls),
        ["conferir"],
        "a node with one way out takes it, whatever the label on the edge says",
      );

      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.no_atual, "conferir", "the work really moved");

      // Exactly one read of the snapshot: the engine and the edge come from the
      // same document, and they cost one call between them (FR1).
      assert.equal(
        calls.filter(
          (call) =>
            call.method === "GET" && call.route.startsWith("/v1/graph-versions/"),
        ).length,
        1,
        "a dispatch reads the graph version once, never twice",
      );
    },
  );

  await parent.test(
    "AT15 — a gate node takes the edge its ```resultado``` block names",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t161-gate-"));
      const record = path.join(workDir, "portao.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at15"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num portão que reprova",
          no_entrada_id: "conferir",
          execucao_id: 1615,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithResult("retrabalho"),
        },
      })(job.id);

      assert.deepEqual(
        transitions(calls),
        ["implementar"],
        'the "retrabalho" edge is the one this gate named',
      );

      // ...and the session was told how to name it: the routing protocol is
      // rendered only for a node with more than one way out.
      const argv = (
        JSON.parse(readFileSync(record, "utf8")) as FakeRecord
      ).argv.join("\n");
      assert.ok(argv.includes("```resultado"), "the gate was given the protocol");
      assert.ok(argv.includes(gateSkill.instructions), "and its own skill's instructions");
    },
  );

  await parent.test(
    "AT16 — a result that matches no edge escalates instead of failing",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t161-escala-"),
      );
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at16"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num portão que não sabe rotear",
          no_entrada_id: "conferir",
          execucao_id: 1616,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();

      // "escala" is the case the reference fixture already carries: the gate's
      // own `saida_schema` declares it, and no edge leaves the node for it.
      // Asking is not failing, so this dispatch resolves normally.
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithResult("escala") },
      })(job.id);

      assert.deepEqual(transitions(calls), [], "an unroutable result moves nothing");

      const asked = calls.filter(
        (call) => call.method === "POST" && call.route === "/v1/input-requests",
      );
      assert.equal(asked.length, 1, "it calls a human instead");

      const body = asked[0].body as Record<string, unknown>;
      assert.deepEqual(
        body.ator,
        { tipo: "sistema", ref: "runner" },
        "the wiring raised this one, not the session — a session-authored one is `agente`",
      );
      assert.deepEqual(
        body.opcoes,
        ["aprovado", "retrabalho"],
        "the human is offered the edges that actually leave this node",
      );
      const askedText = String(body.pergunta);
      assert.ok(askedText.includes("conferir"), askedText);
      assert.ok(askedText.includes("escala"), askedText);

      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.no_atual, "conferir", "the work stayed where it was");
      assert.equal(after.bloqueado, true, "and it is blocked behind the question");
    },
  );

  await parent.test(
    "AT17 — a session that escalates is never advanced, not even on a single-edge node",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t161-asks-"));
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at17"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cuja sessão pergunta",
          no_entrada_id: "implementar",
          execucao_id: 1617,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithBlock() },
      })(job.id);

      assert.deepEqual(
        transitions(calls),
        [],
        "advancing a work that asked would answer its own question by walking away from it",
      );

      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.no_atual, "implementar");
      assert.equal(after.bloqueado, true);
    },
  );

  await parent.test(
    "AT18 — a transition the control plane refuses fails the dispatch",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);
      const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(
        "src/controller/cliente-controle.ts",
      );

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t161-refused-"),
      );
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at18"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cuja transição o control plane recusa",
          no_entrada_id: "implementar",
          execucao_id: 1618,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      // Everything real except the one write under test: an unrecorded
      // transition is the job silently stuck with nobody able to tell, which is
      // the single failure mode this whole ficha exists to close.
      const doFetch: typeof fetch = async (input, init) => {
        if (String(input).endsWith("/transitions")) return serverError();
        return fetch(input, init);
      };

      await assert.rejects(
        async () =>
          createClaudeCodeDispatch({
            urlBase: baseUrl,
            token,
            doFetch,
            engines: claudeOnly(fakeAdapter()),
            worktrees: fakeWorktrees(workDir),
            timeoutSeconds: 60,
            envOverrides: { FAKE_ENGINE_LINES: linesWithoutBlock() },
          })(job.id),
        (error: unknown) => {
          assert.ok(
            error instanceof ErroDoControlPlane,
            `expected the control plane's own refusal, got: ${String(error)}`,
          );
          assert.equal(error.status, 500);
          return true;
        },
      );

      // The session itself was fine and is closed as such: what failed is the
      // advance, and the work is still standing where it was.
      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=1618",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes.length, 1);
      assert.equal(sessions.sessoes[0].status, "concluida");

      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.no_atual, "implementar");
    },
  );

  await parent.test(
    "AT19 — the skill's declared permissions are the session's permissions",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t161-perms-"));
      const record = path.join(workDir, "portao.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        traversalGraph("travessia-t161-at19"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num portão que não pode escrever",
          no_entrada_id: "conferir",
          execucao_id: 1619,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      // The static option is what a dispatch used to be configured with, and
      // the opposite of what the gate's manifest declares: whichever one shows
      // up in the argv is the one that won.
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        permissions: { filesystem: { write: ["**"] }, network: { allowed: true } },
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithResult("aprovado"),
        },
      })(job.id);

      const argv = (
        JSON.parse(readFileSync(record, "utf8")) as FakeRecord
      ).argv.join("\n");
      assert.ok(
        argv.includes("Write") && argv.includes("WebFetch"),
        `the gate declares no writing and no network, and the argv has to say so:\n${argv}`,
      );
    },
  );
});

// --- t167: a node that has nobody to ask blocks instead of asking ---

/**
 * The traversal fixture with one node declaring an escalation policy.
 *
 * Built from the same committed graph the t161 cases use: what changes between
 * the two halves of this proof is ONE field on ONE node, and nothing else.
 */
function graphWithPolicy(
  className: string,
  nodeId: string,
  policy: string,
): Record<string, unknown> {
  const document = traversalGraph(className);
  const nodes = (document.nodes as Array<Record<string, unknown>>).map((node) =>
    node.id === nodeId ? { ...node, escalation_policy: policy } : node,
  );
  return { ...document, nodes };
}

test("t167 — a node with nobody to ask blocks the work instead of raising a question", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);

  await registerSkill(baseUrl, token, WORK_SKILL);
  await registerSkill(baseUrl, token, GATE_SKILL);

  /** One call the dispatch made, as the spy in front of `fetch` saw it. */
  interface Call {
    method: string;
    route: string;
    body: unknown;
  }

  /** A spy that records every call and delegates to the real control plane. */
  function spy(): { doFetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const doFetch: typeof fetch = async (input, init) => {
      calls.push({
        method: init?.method ?? "GET",
        route: String(input).slice(baseUrl.length),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return fetch(input, init);
    };
    return { doFetch, calls };
  }

  /** The bodies posted to one route, in order. */
  function posted(calls: Call[], route: string): Record<string, unknown>[] {
    return calls
      .filter((call) => call.method === "POST" && call.route === route)
      .map((call) => call.body as Record<string, unknown>);
  }

  /** The questions the control plane actually recorded for one job. */
  async function questionsOf(jobId: number): Promise<Question[]> {
    const body = await api<{ perguntas: Question[] }>(
      baseUrl,
      "GET",
      `/v1/input-requests?trabalho_id=${jobId}`,
      undefined,
      200,
      token,
    );
    return body.perguntas;
  }

  await parent.test(
    "AT1 — a session that asks at a never node is blocked, and no pergunta exists",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t167-never-"));
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        graphWithPolicy("travessia-t167-at1", "implementar", "never"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num nó que não tem a quem perguntar",
          no_entrada_id: "implementar",
          execucao_id: 1671,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithBlock() },
      })(job.id);

      assert.deepEqual(
        posted(calls, "/v1/input-requests"),
        [],
        "a node that declares never must not raise a question anybody has to answer",
      );

      const blocks = posted(calls, `/v1/jobs/${job.id}/blocks`);
      assert.equal(blocks.length, 1, "it blocks unconditionally instead, through the route that already exists");
      assert.deepEqual(
        blocks[0].ator,
        { tipo: "sistema", ref: "runner" },
        "the wiring raised this block, not the session and not a person",
      );
      const motivo = String(blocks[0].motivo);
      assert.ok(motivo.includes("implementar"), motivo);
      assert.ok(motivo.includes(ESCALATION.question), motivo);

      assert.deepEqual(
        await questionsOf(job.id),
        [],
        "no pergunta row is ever created for an escalation at a never node",
      );

      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.bloqueado, true, "the work stops all the same");
      assert.equal(after.motivo_bloqueio, motivo);
      assert.equal(after.no_atual, "implementar", "and it never advanced past the node that got stuck");
    },
  );

  await parent.test(
    "AT2 — the same session output at an on_uncertainty node still asks",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t167-asks-"));
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      // The DEFAULT case, spelled out: the node declares the policy every graph
      // written before this ficha has implicitly.
      const versionId = await registerGraph(
        baseUrl,
        token,
        graphWithPolicy("travessia-t167-at2", "implementar", "on_uncertainty"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num nó que pergunta como sempre perguntou",
          no_entrada_id: "implementar",
          execucao_id: 1672,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithBlock() },
      })(job.id);

      const asked = posted(calls, "/v1/input-requests");
      assert.equal(asked.length, 1, "the cycle t106 built has to be untouched by this ficha");
      assert.equal(asked[0].pergunta, ESCALATION.question);
      assert.deepEqual(
        posted(calls, `/v1/jobs/${job.id}/blocks`),
        [],
        "the block of an ordinary question comes from the control plane, not from the runner",
      );

      const questions = await questionsOf(job.id);
      assert.equal(questions.length, 1);
      assert.equal(questions[0].status, "pendente");
    },
  );

  await parent.test(
    "AT3 — a routing question at a never node goes through /blocks too",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t167-rota-"));
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        graphWithPolicy("travessia-t167-at3", "conferir", "never"),
      );
      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num portão que não sabe rotear e não tem a quem perguntar",
          no_entrada_id: "conferir",
          execucao_id: 1673,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const { doFetch, calls } = spy();
      // "escala" is declared by the gate's own output schema and has no edge:
      // the wiring has no rule to apply, and at a never node it has nobody to
      // ask for one either.
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: { FAKE_ENGINE_LINES: linesWithResult("escala") },
      })(job.id);

      assert.deepEqual(posted(calls, "/v1/input-requests"), []);
      assert.deepEqual(
        calls
          .filter((call) => call.method === "POST" && call.route.endsWith("/transitions"))
          .map((call) => (call.body as { para_no_id: string }).para_no_id),
        [],
        "an unroutable result still moves nothing",
      );

      const blocks = posted(calls, `/v1/jobs/${job.id}/blocks`);
      assert.equal(blocks.length, 1);
      const motivo = String(blocks[0].motivo);
      assert.ok(motivo.includes("conferir"), motivo);
      assert.ok(motivo.includes("escala"), motivo);

      assert.deepEqual(await questionsOf(job.id), []);
      const after = await api<Work>(
        baseUrl,
        "GET",
        `/v1/jobs/${job.id}`,
        undefined,
        200,
        token,
      );
      assert.equal(after.bloqueado, true);
      assert.equal(after.no_atual, "conferir");
    },
  );
});

// --- t166: per-node model selection ------------------------------------------

/**
 * A `trabalho` node that may declare an engine, a model, both or neither.
 *
 * Separate from `node()` above on purpose: that one is the t141 routing
 * fixture and its two callers care about engines, not models. Growing its
 * signature would make every routing test read as if it were about this ficha.
 */
function modelNode(
  id: string,
  declared: { engine?: string; model?: string } = {},
): Record<string, unknown> {
  return {
    id,
    role: "desenvolvedor",
    node_type: "work",
    description: `Nó ${id} da prova de seleção de modelo.`,
    skill_ref: skillPin(WORK_SKILL),
    contract: contract(),
    ...(declared.engine === undefined ? {} : { engine: declared.engine }),
    ...(declared.model === undefined ? {} : { model: declared.model }),
  };
}

/** Two nodes on one edge: the first declares nothing, the second may. */
function modelGraph(
  className: string,
  declared: { engine?: string; model?: string },
): Record<string, unknown> {
  return {
    problem_class: className,
    lineage: { type: "base" },
    metadata: {
      name: "Prova de seleção de modelo por nó",
      description: "Dois nós de trabalho numa aresta, um deles declarando model.",
      schema_version: "1.0.0",
      created_at: "2026-08-16",
      source: "fixture da t166",
    },
    nodes: [modelNode("implementar"), modelNode("revisar", declared)],
    edges: [{ from: "implementar", to: "revisar", condition: "sempre" }],
    initial_node: "implementar",
    final_nodes: ["revisar"],
    custom_fields: [],
  };
}

/** Registers a graph and hands back BOTH ids — the proposal needs the lineage. */
async function registerLineage(
  baseUrl: string,
  token: string,
  document: Record<string, unknown>,
): Promise<{ graphId: string; versionId: string }> {
  const registered = await api<{
    grafo: { id: string };
    grafo_versao: { id: string };
  }>(baseUrl, "POST", "/v1/graphs", document, 201, token);
  return { graphId: registered.grafo.id, versionId: registered.grafo_versao.id };
}

/**
 * The adapter every test below runs, wrapped so the `SessionSpec` it received
 * can be read back.
 *
 * The spec and not the argv, deliberately: what FR5 claims is that the DISPATCH
 * puts the node's model on the spec, and `command.test.ts` already owns the
 * other half — that a spec carrying a model becomes `--model <value>`. Asserting
 * the argv here would prove the two halves at once and leave neither of them
 * located when it breaks.
 */
function capturingAdapter(seen: SessionSpec[]): EngineAdapter {
  const inner = fakeAdapter();
  return {
    engineName: inner.engineName,
    startSession: (spec, listener) => {
      seen.push(spec);
      return inner.startSession(spec, listener);
    },
    getStatus: (id) => inner.getStatus(id),
    cancel: (id, status) => inner.cancel(id, status),
    capabilities: () => inner.capabilities(),
    verifyCli: () => inner.verifyCli(),
  };
}

test("t166 — the model is resolved from the node the work is standing on", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);
  await registerSkill(baseUrl, token, WORK_SKILL);

  /** Dispatches one work on `revisar` of the given version, capturing the spec. */
  const dispatchOn = async (
    t: TestHook,
    options: { versionId: string; executionId: number; title: string },
  ): Promise<SessionSpec> => {
    const { createClaudeCodeDispatch } =
      await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

    const workDir = mkdtempSync(
      path.join(tmpdir(), `cartografo-t166-${options.executionId}-`),
    );
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const work = await api<Work>(
      baseUrl,
      "POST",
      "/v1/jobs",
      {
        titulo: options.title,
        no_entrada_id: "revisar",
        execucao_id: options.executionId,
        grafo_versao_id: options.versionId,
      },
      201,
      token,
    );

    const seen: SessionSpec[] = [];
    await createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      engines: {
        "claude-code": {
          adapter: capturingAdapter(seen),
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      },
      worktrees: fakeWorktrees(workDir),
      timeoutSeconds: 60,
      envOverrides: {
        FAKE_ENGINE_RECORD: path.join(workDir, "despacho.json"),
        FAKE_ENGINE_LINES: linesWithoutBlock(),
      },
    })(work.id);

    assert.equal(seen.length, 1, "exactly one session per dispatch");
    return seen[0]!;
  };

  await parent.test(
    "AT — a node declaring model dispatches a SessionSpec carrying it",
    async (t) => {
      const { versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("selecao-de-modelo-declarado", { model: "claude-haiku-4-5" }),
      );

      const spec = await dispatchOn(t, {
        versionId,
        executionId: 1660,
        title: "ficha cujo nó declara model",
      });

      assert.equal(spec.model, "claude-haiku-4-5");
    },
  );

  await parent.test(
    "AT — a node declaring no model dispatches a SessionSpec with model undefined",
    async (t) => {
      const { versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("selecao-de-modelo-ausente", {}),
      );

      const spec = await dispatchOn(t, {
        versionId,
        executionId: 1661,
        title: "ficha cujo nó não declara model",
      });

      // `undefined`, never a hardcoded fallback: "absence has a name" for every
      // other optional field of the spec, and the engine's own default is the
      // name this one has.
      assert.equal(spec.model, undefined);
      assert.ok(
        !Object.values(spec).includes("claude-haiku-4-5"),
        "a default leaked into the spec from somewhere",
      );
    },
  );

  await parent.test(
    "AT — an empty or non-string model on the node is the same as declaring none",
    async (t) => {
      const { versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("selecao-de-modelo-vazio", { model: "   " }),
      );

      const spec = await dispatchOn(t, {
        versionId,
        executionId: 1662,
        title: "ficha cujo nó declara model em branco",
      });

      assert.equal(
        spec.model,
        undefined,
        "blank is not a model identifier: it would reach the CLI as an empty --model",
      );
    },
  );

  await parent.test(
    "AT — the dispatch under the version a proposal wrote picks up the new model",
    async (t) => {
      const { graphId, versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("selecao-de-modelo-proposta", {}),
      );

      // The whole point of the ficha, end to end: `model` is graph DATA, so
      // changing it is a proposal — apply → soundness → new version → pointer
      // (D15) — and not a runner flag somebody edits on the machine.
      // `null` and not `undefined` on the before-side: JSON has no `undefined`,
      // and `alterar_campo_no` demands `de` be present.
      const swap = {
        tipo: "alterar_campo_no",
        no_id: "revisar",
        campo: "model",
        de: null,
        para: "claude-haiku-4-5",
        inversa: {
          tipo: "alterar_campo_no",
          no_id: "revisar",
          campo: "model",
          de: "claude-haiku-4-5",
          para: null,
        },
      };
      const created = await api<{ proposta: { id: number } }>(
        baseUrl,
        "POST",
        "/v1/proposals",
        {
          grafo_id: graphId,
          versao_alvo: versionId,
          operacoes: [swap],
          evidencia: { fonte: "telemetria", observacao: "o portão não precisa do modelo grande" },
          metrica_esperada: {
            nome: "custo_por_travessia",
            direcao: "cai",
            de: 1,
            para: 0.4,
          },
        },
        201,
        token,
      );
      await api(baseUrl, "POST", `/v1/proposals/${created.proposta.id}/approve`, {}, 200, token);
      const applied = await api<{ grafo_versao: { id: string } }>(
        baseUrl,
        "POST",
        `/v1/proposals/${created.proposta.id}/apply`,
        {},
        200,
        token,
      );
      assert.notEqual(applied.grafo_versao.id, versionId, "applying writes a NEW version");

      const after = await dispatchOn(t, {
        versionId: applied.grafo_versao.id,
        executionId: 1663,
        title: "ficha sob a versão que a proposta escreveu",
      });
      assert.equal(after.model, "claude-haiku-4-5");

      // ...and the version the proposal targeted is untouched, which is what
      // "frozen during execution, versioned between executions" means: a work
      // still traversing the old version keeps the model it started with.
      const before = await dispatchOn(t, {
        versionId,
        executionId: 1664,
        title: "ficha que ficou na versão anterior",
      });
      assert.equal(before.model, undefined);
    },
  );
});

// --- t172: the tokens and the models a session really spent -----------------

/**
 * The `/finish` body of one dispatch whose adapter ended however the case says.
 *
 * The stub is {@link recordingAdapter}, unchanged and shared with t163, for the
 * reason that ficha already recorded: what is under test is not the parsing (the
 * conformance suite owns that, against the real frame shape) but what the
 * DISPATCH does with a detail it was handed. A fake engine would prove the two
 * halves at once and locate neither when one breaks.
 */
test('t172 — the tokens and the models the adapter reported reach the finish call', async (parent) => {
  const { createClaudeCodeDispatch } =
    await loadModule<typeof DispatchModule>(DISPATCH_MODULE);
  const { baseUrl, token } = await bootUnpatched(parent);

  /** The `/finish` body of one dispatch, plus the session it closed. */
  const finishBodyOf = async (
    t: TestHook,
    executionId: number,
    detail: SessionFinishDetail | undefined,
  ): Promise<{ body: Record<string, unknown>; sessionId: number }> => {
    const workDir = mkdtempSync(
      path.join(tmpdir(), `cartografo-t172-${String(executionId)}-`),
    );
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const work = await api<Work>(
      baseUrl,
      "POST",
      "/v1/jobs",
      {
        titulo: "ficha que reporta uso e modelo",
        no_entrada_id: "implementar",
        execucao_id: executionId,
      },
      201,
      token,
    );

    const bodies: Array<{ route: string; body: unknown }> = [];
    const doFetch: typeof fetch = async (input, init) => {
      bodies.push({
        route: String(input).slice(baseUrl.length),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return fetch(input, init);
    };

    const probe = recordingAdapter({
      status: "completed",
      exitCode: 0,
      ...(detail === undefined ? {} : { detail }),
    });

    await createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      doFetch,
      engines: {
        "claude-code": {
          adapter: probe.adapter,
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      },
      worktrees: fakeWorktrees(workDir),
      timeoutSeconds: 60,
    })(work.id);

    const call = bodies.find((candidate) => candidate.route.endsWith("/finish"));
    assert.ok(call, "the dispatch never called PATCH /v1/sessions/:id/finish");
    const id = Number(/\/v1\/sessions\/(\d+)\/finish$/.exec(call.route)?.[1]);
    return { body: call.body as Record<string, unknown>, sessionId: id };
  };

  const USAGE = {
    input_tokens: 2,
    output_tokens: 5,
    cache_creation_input_tokens: 3022,
    cache_read_input_tokens: 15688,
  };

  await parent.test(
    "AT — a reported usage and model land in the finish body, value for value",
    async (t) => {
      const { body, sessionId } = await finishBodyOf(t, 1720, {
        usage: USAGE,
        models: ["claude-haiku-4-5-20251001", "claude-sonnet-5"],
      });

      assert.deepEqual(body.uso, USAGE, "the four counts cross untouched");
      assert.deepEqual(body.modelos, ["claude-haiku-4-5-20251001", "claude-sonnet-5"]);

      // ...and the control plane accepted them: a body the schema refuses would
      // have been a 400 the dispatch swallows into `finishFailure`, and the row
      // would read `null` with every assertion above still green.
      // Read by property and never destructured: `sessoes` is a wire key, and a
      // local binding of that name is a Portuguese identifier D18 forbids in
      // this package (`test/no-portuguese-identifiers.test.ts`).
      const listed = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        `/v1/sessions?execucao_id=1720`,
        undefined,
        200,
        token,
      );
      const stored = listed.sessoes.find((session) => session.id === sessionId);
      assert.ok(stored, "the session the dispatch closed is not in the projection");
      assert.deepEqual(stored.uso, USAGE);
      assert.deepEqual(stored.modelos, ["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    },
  );

  await parent.test(
    "AT — an adapter that reported neither sends uso: null and modelos: null",
    async (t) => {
      const { body } = await finishBodyOf(t, 1721, undefined);

      // Present-and-null, never absent: the same posture `timeout_reason` has
      // had since t163. An absent key and a null one read the same to the
      // server, and differently to whoever is reading the runner's calls.
      assert.ok("uso" in body, "the key has to be sent, not omitted");
      assert.ok("modelos" in body, "the key has to be sent, not omitted");
      assert.equal(body.uso, null);
      assert.equal(body.modelos, null);
      assert.notEqual(body.uso, 0, "absence never collapses into zero");
    },
  );
});

// --- t175: the work item's tier reaches the SessionSpec -----------------------

/**
 * The dispatch sets `modelTier` from the job, once, for whichever engine the
 * node resolved to.
 *
 * The spec and not the argv, for the same reason the t166 block above gives:
 * what this ficha claims here is that the DISPATCH carries the job's tier onto
 * the session it opens, and `command.test.ts` / `codex-command.test.ts` already
 * own the other half — that a spec carrying a tier becomes the right flag, or
 * deliberately no flag at all. Asserting the argv here would prove two halves
 * at once and locate neither when it breaks.
 *
 * The `tier: null` case is the one that would rot quietly: an unclassified job
 * has to produce a spec with NO `modelTier` key at all, not one whose value is
 * `undefined`. `buildCommand` reads absence, not falsiness — the same
 * conditional-spread discipline `envOverrides` and `permissions` already follow.
 */
test("t175 — the tier of the work item becomes the SessionSpec's modelTier", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);
  await registerSkill(baseUrl, token, WORK_SKILL);

  /** Dispatches one work carrying `tier`, and hands back the spec it produced. */
  const dispatchWithTier = async (
    t: TestHook,
    options: { versionId: string; executionId: number; title: string; tier: string | null },
  ): Promise<SessionSpec> => {
    const { createClaudeCodeDispatch } =
      await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

    const workDir = mkdtempSync(
      path.join(tmpdir(), `cartografo-t175-${options.executionId}-`),
    );
    t.after(() => {
      rmSync(workDir, { recursive: true, force: true });
    });

    const work = await api<Work>(
      baseUrl,
      "POST",
      "/v1/jobs",
      {
        titulo: options.title,
        no_entrada_id: "revisar",
        execucao_id: options.executionId,
        grafo_versao_id: options.versionId,
        // Absent, not null: `POST /v1/jobs` treats both as unclassified, and
        // sending the key at all would prove less about the default path.
        ...(options.tier === null ? {} : { tier: options.tier }),
      },
      201,
      token,
    );

    const seen: SessionSpec[] = [];
    await createClaudeCodeDispatch({
      urlBase: baseUrl,
      token,
      engines: {
        "claude-code": {
          adapter: capturingAdapter(seen),
          decodeSessionText: decodeClaudeCodeSessionText,
        },
      },
      worktrees: fakeWorktrees(workDir),
      timeoutSeconds: 60,
      envOverrides: {
        FAKE_ENGINE_RECORD: path.join(workDir, "despacho.json"),
        FAKE_ENGINE_LINES: linesWithoutBlock(),
      },
    })(work.id);

    assert.equal(seen.length, 1, "exactly one session per dispatch");
    return seen[0]!;
  };

  await parent.test("AT — a trivial job dispatches modelTier: 'trivial'", async (t) => {
    const { versionId } = await registerLineage(
      baseUrl,
      token,
      modelGraph("tier-trivial", {}),
    );

    const spec = await dispatchWithTier(t, {
      versionId,
      executionId: 1750,
      title: "ficha triada como trivial",
      tier: "trivial",
    });

    assert.equal(spec.modelTier, "trivial");
  });

  await parent.test("AT — a standard job dispatches modelTier: 'standard'", async (t) => {
    const { versionId } = await registerLineage(
      baseUrl,
      token,
      modelGraph("tier-standard", {}),
    );

    const spec = await dispatchWithTier(t, {
      versionId,
      executionId: 1751,
      title: "ficha triada como standard",
      tier: "standard",
    });

    assert.equal(spec.modelTier, "standard");
  });

  await parent.test(
    "AT — an unclassified job dispatches a spec with no modelTier key at all",
    async (t) => {
      const { versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("tier-ausente", {}),
      );

      const spec = await dispatchWithTier(t, {
        versionId,
        executionId: 1752,
        title: "ficha que ninguém triou",
        tier: null,
      });

      assert.ok(
        !("modelTier" in spec),
        "a `modelTier: undefined` key is still a key, and absence is what the adapters read",
      );
    },
  );

  await parent.test(
    "AT — the tier does not disturb the model the node declared",
    async (t) => {
      // The two travel together and answer different questions: `model` is what
      // the GRAPH pinned for this node (t166), `modelTier` is what the intake
      // said this work costs. The dispatch forwards both; deciding between them
      // is the adapter's job, below boundary 1, where the model names live.
      const { versionId } = await registerLineage(
        baseUrl,
        token,
        modelGraph("tier-com-modelo", { model: "claude-opus-5" }),
      );

      const spec = await dispatchWithTier(t, {
        versionId,
        executionId: 1753,
        title: "ficha trivial num nó que fixou modelo",
        tier: "trivial",
      });

      assert.equal(spec.model, "claude-opus-5", "the node's pin survives the tier");
      assert.equal(spec.modelTier, "trivial", "and the tier survives the pin");
    },
  );
});

// --- t204: the placeholders resolve, or no session opens ---------------------

/** The bundle whose manifests actually carry `{{input.<caminho>}}` placeholders. */
const BETS_SKILLS_DIR = path.join(
  REPO_ROOT,
  "grafos-de-fabrica",
  "bets-assimetricas",
  "skills",
);

/** The crossing fixture of t116, whose steps are hand-authored node inputs. */
const BETS_FIXTURE = path.join(
  REPO_ROOT,
  "tests",
  "fixtures",
  "tese-exemplo-bets-assimetricas.json",
);

/** The thesis title the fixture carries, and the string a resolved prompt shows. */
const THESIS_TITLE = "Navelar Logística";

/**
 * The `coleta-fundamentos` input the t116 fixture hand-authored.
 *
 * Read from the committed fixture instead of typed here: what these two cases
 * prove is that a REAL manifest resolves against a REAL input, and an input
 * retyped in the test would be a shape nobody else has to keep working.
 */
function fundamentalsInput(): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(BETS_FIXTURE, "utf8")) as {
    travessia: { no: string; entrada: Record<string, unknown> }[];
  };
  const step = fixture.travessia.find(
    (entry) => entry.no === "coleta-fundamentos",
  );
  assert.ok(step !== undefined, "the fixture has no coleta-fundamentos step");
  return step.entrada;
}

/** One committed factory manifest of the bets bundle. */
function factoryManifest(skillId: string): Record<string, unknown> {
  const file = path.join(BETS_SKILLS_DIR, `${skillId}.json`);
  assert.ok(existsSync(file), `artifact does not exist: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * The traversal fixture, with one node repinned to a manifest that has
 * placeholders.
 *
 * `publicar` is the node that gets repinned because it is the graph's final
 * node: a dispatch that lands there opens a session and stops, with no
 * transition to assert around: the subject here is the prompt, not the routing.
 */
function placeholderGraph(
  className: string,
  manifest: Record<string, unknown>,
): Record<string, unknown> {
  const document = traversalGraph(className);
  const nodes = document.nodes as Array<Record<string, unknown>>;
  return {
    ...document,
    nodes: nodes.map((node) =>
      node.id === "publicar"
        ? {
            ...node,
            skill_ref: {
              id: manifest.id,
              version: manifest.version,
              hash: manifest.hash,
            },
          }
        : node,
    ),
  };
}

test("t204 — a skill's placeholders resolve into the session, or nothing opens", async (parent) => {
  const { baseUrl, token } = await bootUnpatched(parent);

  // ONE boot for the two subtests, the same economy the t141 block above
  // documents: a control plane per test is what made the conformance kit's C4
  // miss its settle window.
  const manifest = factoryManifest("coletar-fundamentos");
  await api(baseUrl, "POST", "/v1/skills", manifest, 201, token);

  await parent.test(
    "AT19 — a resolved input reaches the session, with no token left behind",
    async (t) => {
      const { createClaudeCodeDispatch } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t204-resolvido-"),
      );
      const record = path.join(workDir, "despacho-com-entrada.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        placeholderGraph("travessia-t204-at19", manifest),
      );

      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha num nó cuja skill tem placeholder",
          no_entrada_id: "publicar",
          execucao_id: 2041,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const inputs: string[] = [];
      await createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        resolveInput: (dispatched, resolved) => {
          inputs.push(`${dispatched.id}:${resolved.node.id}`);
          return fundamentalsInput();
        },
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      })(job.id);

      assert.deepEqual(
        inputs,
        [`${job.id}:publicar`],
        "the input is assembled once per dispatch, for the node being dispatched",
      );

      // The argv is the channel: `buildCommand` puts `instructions` on it, so
      // what the process received IS what the session was told.
      const argv = (
        JSON.parse(readFileSync(record, "utf8")) as FakeRecord
      ).argv.join("\n");

      assert.ok(
        argv.includes(THESIS_TITLE),
        "the resolved thesis title has to be in the text the session was given",
      );
      assert.ok(
        !argv.includes("{{"),
        "and not one placeholder may survive into a prompt",
      );
    },
  );

  await parent.test(
    "AT20 — with nothing to resolve against, the dispatch refuses before any session",
    async (t) => {
      const { createClaudeCodeDispatch, UnresolvedPlaceholderError } =
        await loadModule<typeof DispatchModule>(DISPATCH_MODULE);
      assert.equal(
        typeof UnresolvedPlaceholderError,
        "function",
        "artifact does not exist yet: UnresolvedPlaceholderError",
      );

      const workDir = mkdtempSync(
        path.join(tmpdir(), "cartografo-t204-fecha-"),
      );
      const record = path.join(workDir, "nunca-despachado.json");
      t.after(() => {
        rmSync(workDir, { recursive: true, force: true });
      });

      const versionId = await registerGraph(
        baseUrl,
        token,
        placeholderGraph("travessia-t204-at20", manifest),
      );

      const job = await api<Work>(
        baseUrl,
        "POST",
        "/v1/jobs",
        {
          titulo: "ficha cuja entrada ninguém monta",
          no_entrada_id: "publicar",
          execucao_id: 2042,
          grafo_versao_id: versionId,
        },
        201,
        token,
      );

      const calls: { method: string; route: string }[] = [];
      const doFetch: typeof fetch = async (input, init) => {
        calls.push({
          method: init?.method ?? "GET",
          route: String(input).slice(baseUrl.length),
        });
        return fetch(input, init);
      };

      // No `resolveInput`: production wiring, which resolves `{}` — the honest
      // state until the node-input-assembly ficha exists.
      const dispatch = createClaudeCodeDispatch({
        urlBase: baseUrl,
        token,
        doFetch,
        engines: claudeOnly(fakeAdapter()),
        worktrees: fakeWorktrees(workDir),
        timeoutSeconds: 60,
        envOverrides: {
          FAKE_ENGINE_RECORD: record,
          FAKE_ENGINE_LINES: linesWithoutBlock(),
        },
      });

      await assert.rejects(
        async () => dispatch(job.id),
        (error: unknown) => {
          assert.ok(
            error instanceof UnresolvedPlaceholderError,
            `expected UnresolvedPlaceholderError, got: ${String(error)}`,
          );
          assert.equal(error.nodeId, "publicar");
          assert.equal(error.skillId, manifest.id);
          assert.ok(error.paths.length > 0);
          return true;
        },
      );

      assert.deepEqual(
        calls.filter(
          (call) => call.method === "POST" && call.route === "/v1/sessions",
        ),
        [],
        "POST /v1/sessions must never be reached for a placeholder that does not resolve",
      );
      assert.ok(
        !existsSync(record),
        "and no engine process may have been spawned",
      );

      const sessions = await api<{ sessoes: Session[] }>(
        baseUrl,
        "GET",
        "/v1/sessions?execucao_id=2042",
        undefined,
        200,
        token,
      );
      assert.equal(sessions.sessoes.length, 0);

      const blocks = calls.filter(
        (call) => call.method === "POST" && call.route.endsWith("/blocks"),
      );
      assert.deepEqual(
        blocks,
        [],
        "the refusal propagates through the controller's finally, like the two pin errors: no block of its own",
      );
    },
  );
});

/**
 * The t156 discipline, at the one place left that could regress it (t193).
 *
 * `cliente-controle.ts` reads the status before it decodes the body since
 * t156, and its own test pins that. This module used to have a second,
 * hand-rolled `call()` that decoded FIRST and checked the status three lines
 * later — so the same 502 from the same proxy came out of the other client as
 * an `ErroDoControlPlane` and out of this one as a raw `SyntaxError`, which
 * carries neither the status nor the text.
 *
 * The first call of a dispatch is the one under test because it is the one a
 * broken intermediary meets first, and because a dispatch that fails there has
 * opened nothing: no worktree, no session, no engine process.
 */
const HTML_502 = "<html>502 Bad Gateway</html>";

test("t193 — a non-JSON error body is an ErroDoControlPlane, never a raw SyntaxError", async (t) => {
  const { createClaudeCodeDispatch } = await loadModule<typeof DispatchModule>(
    DISPATCH_MODULE,
  );
  const { ErroDoControlPlane } = await loadModule<typeof ClientModule>(
    "src/controller/cliente-controle.ts",
  );

  const workDir = mkdtempSync(path.join(tmpdir(), "cartografo-t193-502-"));
  t.after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const routes: string[] = [];
  const doFetch: typeof fetch = async (input) => {
    routes.push(String(input));
    return new Response(HTML_502, {
      status: 502,
      headers: { "content-type": "text/html" },
    });
  };

  const dispatch = createClaudeCodeDispatch({
    urlBase: "http://127.0.0.1:4317",
    token: "ct_qualquer",
    doFetch,
    engines: claudeOnly(fakeAdapter()),
    worktrees: fakeWorktrees(workDir),
  });

  await assert.rejects(
    async () => dispatch(193),
    (error: unknown) => {
      assert.ok(
        error instanceof ErroDoControlPlane,
        `expected ErroDoControlPlane, got ${error instanceof Error ? error.name : String(error)}`,
      );
      assert.equal(error.status, 502);
      assert.equal(
        error.corpo,
        HTML_502,
        "the raw text is what is left for whoever logs it: whoever answered was not the control plane",
      );
      return true;
    },
  );

  assert.deepEqual(
    routes,
    ["http://127.0.0.1:4317/v1/jobs/193"],
    "it stops on the first call: nothing is opened before the work is even read",
  );
});
