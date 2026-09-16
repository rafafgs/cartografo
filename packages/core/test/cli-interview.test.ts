/**
 * Acceptance tests of `cartografo interview` (t546, D26).
 *
 * Every case drives a real control plane over its public API, the same posture
 * as every other `cli-*.test.ts`. None spawns a runner or an engine: the
 * "engine" here is {@link startScriptedEngine}, a small loop that watches the
 * conversation projection and, each time nothing is pending and the interview
 * is not done, posts the next scripted turn — a session opened and closed with
 * a report, then a question — exactly the writes a runner would make, played
 * deterministically. `executions.test.ts`'s `arrive()` and `cli-reads.test.ts`'s
 * seeding make the same substitution; the real runner + fake engine layer is
 * `packages/runner`'s own e2e suite.
 *
 * `cli-support.ts`'s `runCli` opens the child with no stdin, which cannot feed
 * a REPL, so {@link spawnInterview} is local to this file — the same gap and
 * the same resolution t543 recorded for `cli-watch.test.ts`.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { openDatabase } from '../src/db/connection.ts';
import { verifyBundle } from '../src/cli/import.ts';
import { manifestHash } from '../src/domain/manifest.ts';
import {
  BETS_BUNDLE,
  BIN_PATH,
  REPO_ROOT,
  runCli,
  startControlPlane,
  temporaryArea,
  type RunningControlPlane,
  type TestHook,
} from './cli-support.ts';
import { loadEvents, type Event } from './support.ts';

/* ------------------------------------------------------------------ helpers */

interface JsonResponse<T> {
  status: number;
  body: T;
}

/** Speaks JSON with the control plane; the global fetch is already authorized. */
async function api<T>(cp: RunningControlPlane, method: string, route: string, body?: unknown): Promise<JsonResponse<T>> {
  const response = await fetch(`${cp.url}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text === '' ? undefined : JSON.parse(text)) as T };
}

interface ConversationBody {
  turns: { question: string; answer: string }[];
  pending: { id: number } | null;
  thinking: boolean;
  draft: { graph: Record<string, unknown>; skills?: Record<string, unknown>[] } | null;
  done: boolean;
}

async function conversationOf(cp: RunningControlPlane, jobId: number): Promise<ConversationBody> {
  const response = await api<ConversationBody>(cp, 'GET', `/v1/jobs/${jobId}/conversation?project_id=1`);
  assert.equal(response.status, 200, `GET conversation of #${jobId}`);
  return response.body;
}

interface QuestionRow {
  id: number;
  job_id: number;
  status: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

async function questionsOf(cp: RunningControlPlane, jobId: number): Promise<QuestionRow[]> {
  const all: QuestionRow[] = [];
  for (const status of ['pending', 'answered']) {
    const response = await api<{ input_requests: QuestionRow[] }>(
      cp,
      'GET',
      `/v1/input-requests?project_id=1&status=${status}`,
    );
    assert.equal(response.status, 200);
    all.push(...response.body.input_requests.filter((row) => row.job_id === jobId));
  }
  return all.sort((a, b) => a.id - b.id);
}

/** A running `cartografo interview`, with its live output. */
interface InterviewProcess {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** Types one line on the REPL's stdin. */
  type: (line: string) => void;
  /** Waits for the NEXT occurrence of `text` past everything already waited for. */
  expect: (text: string, timeoutMs?: number) => Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns the real binary. `interactive` pipes a stdin; otherwise stdin is not
 * opened at all (AT10 depends on that).
 */
function spawnInterview(
  t: TestHook,
  cp: RunningControlPlane,
  args: string[],
  options: { interactive: boolean },
): InterviewProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, CARTOGRAFO_TOKEN: cp.token };
  delete env.CARTOGRAFO_URL;
  const child = spawn(process.execPath, [BIN_PATH, 'interview', '--url', cp.url, ...args], {
    cwd: REPO_ROOT,
    env,
    stdio: [options.interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  let offset = 0;
  const expect = async (text: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = stdout.indexOf(text, offset);
      if (found !== -1) {
        offset = found + text.length;
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(50);
    }
    const found = stdout.indexOf(text, offset);
    if (found !== -1) {
      offset = found + text.length;
      return;
    }
    assert.fail(`the interview never printed ${JSON.stringify(text)}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  };

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    type: (line) => {
      child.stdin?.write(`${line}\n`);
    },
    expect,
    exited,
  };
}

/** Reads the id `interview #<id>` the REPL announces once it has started or resumed. */
async function announcedId(proc: InterviewProcess): Promise<number> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const match = /interview #(\d+)/.exec(proc.stdout());
    if (match !== null) return Number(match[1]);
    if (proc.child.exitCode !== null) break;
    await sleep(50);
  }
  assert.fail(`no interview id announced\nstdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`);
}

async function waitForExit(proc: InterviewProcess, timeoutMs = 60_000): Promise<number | null> {
  const timer = setTimeout(() => proc.child.kill('SIGKILL'), timeoutMs);
  const { code } = await proc.exited;
  clearTimeout(timer);
  return code;
}

/* ------------------------------------------------------------ the scripted engine */

/** One turn of the interview: what the session reports, and what it asks, if anything. */
interface Turn {
  report: Record<string, unknown>;
  question?: Record<string, unknown>;
}

async function closeSession(
  cp: RunningControlPlane,
  jobId: number,
  nodeId: string,
  output: Record<string, unknown>,
): Promise<void> {
  const opened = await api<{ id: number }>(cp, 'POST', '/v1/sessions', {
    engine: 'claude-code',
    working_dir: '/tmp/cartografo',
    prompt: 'work',
    job_id: jobId,
    node_id: nodeId,
  });
  assert.equal(opened.status, 201, `opening a ${nodeId} session`);
  const finished = await api<{ output_accepted: boolean }>(cp, 'PATCH', `/v1/sessions/${opened.body.id}/finish`, {
    status: 'completed',
    exit_code: 0,
    output,
  });
  assert.equal(finished.status, 200, `finishing the ${nodeId} session`);
  assert.equal(finished.body.output_accepted, true, `the ${nodeId} report was taken`);
}

/**
 * Plays the runner + engine: every time nothing is pending and the interview is
 * not done, posts the next turn; once the turns run out, walks `interview →
 * deliver` and closes `deliver`, which is what makes `done` true.
 */
function startScriptedEngine(
  t: TestHook,
  cp: RunningControlPlane,
  jobId: number,
  turns: Turn[],
  draft: { graph: Record<string, unknown>; skills: Record<string, unknown>[] },
): Promise<void> {
  let stopped = false;
  t.after(() => {
    stopped = true;
  });

  const run = async (): Promise<void> => {
    let index = 0;
    while (!stopped) {
      const conversation = await conversationOf(cp, jobId);
      if (conversation.done) return;
      if (conversation.pending === null) {
        if (index < turns.length) {
          const turn = turns[index];
          index += 1;
          await closeSession(cp, jobId, 'interview', turn.report);
          if (turn.question !== undefined) {
            const created = await api(cp, 'POST', '/v1/input-requests', {
              job_id: jobId,
              kind: 'question',
              auto_approvable: false,
              ...turn.question,
            });
            assert.equal(created.status, 201, 'the scripted question was created');
          }
          continue;
        }
        const walked = await api(cp, 'POST', `/v1/jobs/${jobId}/transitions`, { to_node_id: 'deliver' });
        assert.equal(walked.status, 200, 'the interview walks its one edge to deliver');
        await closeSession(cp, jobId, 'deliver', {
          bundle: { graph: draft.graph, skills: draft.skills },
          checked: { structure: true, soundness: true },
          note: 'the map covers triage and review',
        });
        return;
      }
      await sleep(150);
    }
  };
  const promise = run();
  // Surfaced by the test's own await; never an unhandled rejection meanwhile.
  promise.catch(() => undefined);
  return promise;
}

/* ----------------------------------------------------------------- fixtures */

const DRAFT_CLASS = 'widget-triage';

type Network = { allowed: false } | { allowed: true; domains: string[] };

/** A map whose pins close and whose graph the registry accepts (the screen's own `closingDraft`). */
function closingDraft(network: Network = { allowed: false }): {
  graph: Record<string, unknown>;
  skills: Record<string, unknown>[];
} {
  return {
    graph: {
      problem_class: DRAFT_CLASS,
      lineage: { type: 'base' },
      metadata: {
        name: 'Widget triage — the interviewed map',
        description: 'Two steps: one writes the triage note, one checks it and closes the run.',
        schema_version: '1.0.0',
        created_at: '2026-09-16',
        source: 'an interview in the terminal',
      },
      nodes: [
        {
          id: 'triage',
          role: 'analyst',
          node_type: 'work',
          description: 'Writes the triage note from the reported widget.',
          skill_ref: { id: 'triage-widget', version: '1.0.0' },
          contract: {
            input_schema: {
              type: 'object',
              required: ['widget'],
              properties: { widget: { type: 'string', minLength: 1 } },
            },
            output_schema: {
              type: 'object',
              required: ['note'],
              properties: { note: { type: 'string', minLength: 1 } },
            },
            checks: [
              { type: 'deterministic', command: 'test -s triage.md', description: 'The triage note exists and is not empty.' },
            ],
          },
        },
        {
          id: 'review',
          role: 'reviewer',
          node_type: 'gate',
          description: 'Checks the triage note against the reported widget and closes the run.',
          skill_ref: { id: 'review-widget', version: '2.1.0' },
          contract: {
            input_schema: {
              type: 'object',
              required: ['widget', 'note'],
              properties: { widget: { type: 'string' }, note: { type: 'string' } },
            },
            output_schema: {
              type: 'object',
              required: ['outcome', 'evidence'],
              properties: {
                outcome: { enum: ['pass', 'fail', 'escalate_human'] },
                evidence: { type: 'string', minLength: 1 },
              },
            },
            checks: [
              {
                type: 'agentic',
                instruction: 'Does the note name the reported widget and the decision taken about it? Cite the passage.',
                required_evidence: true,
                description: 'A judgement of adherence, with evidence of its own.',
              },
            ],
          },
        },
      ],
      edges: [
        { from: 'triage', to: 'review', condition: 'always', description: 'A single exit: the note always goes on to review.' },
      ],
      initial_node: 'triage',
      final_nodes: ['review'],
      custom_fields: [
        { name: 'widget', type: 'string', required_at: 'triage', description: 'The widget that came in.' },
      ],
    },
    skills: [
      {
        id: 'triage-widget',
        version: '1.0.0',
        role: 'work',
        description: 'Writes the triage note for one reported widget.',
        input: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['widget'],
          properties: { widget: { type: 'string', minLength: 1 } },
        },
        output: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['note'],
          properties: { note: { type: 'string', minLength: 1 } },
        },
        preconditions: ['the reported widget is available in the input'],
        checks: [
          {
            id: 'note-exists',
            type: 'deterministic',
            description: 'The triage note exists and is not empty.',
            command: 'test -s triage.md',
          },
        ],
        permissions: { filesystem: { read: ['**'], write: ['triage.md'] }, network },
        instructions: '# Triage the widget\n\nWrite `triage.md` naming the widget and the decision.',
        origin: { type: 'native' },
      },
      {
        id: 'review-widget',
        version: '2.1.0',
        role: 'gate',
        description: 'Checks the triage note and closes the run.',
        input: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['widget', 'note'],
          properties: { widget: { type: 'string' }, note: { type: 'string' } },
        },
        output: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['outcome', 'evidence'],
          properties: {
            outcome: { type: 'string', enum: ['pass', 'fail', 'escalate_human'] },
            evidence: { type: 'string', minLength: 1 },
          },
        },
        preconditions: ['the triage note was written'],
        checks: [
          {
            id: 'adherence',
            type: 'agentic',
            description: 'A judgement of adherence, with evidence of its own.',
            instruction: 'Does the note name the reported widget and the decision taken about it? Cite the passage.',
            required_evidence: ['the passage of the note the verdict cites'],
          },
        ],
        permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
        instructions: '# Review the triage note\n\nRead `triage.md` and issue one verdict.',
        origin: { type: 'native' },
      },
    ],
  };
}

const PLAIN_QUESTION = {
  question: 'Does every widget get a triage note?',
  context: 'The note is what the review step reads.',
  options: ['yes', 'no'],
  recommendation: 'yes',
  default_answer: 'yes',
};

const SECOND_QUESTION = {
  question: 'Who reads the note first?',
  options: ['the reviewer', 'the owner'],
  recommendation: 'the reviewer',
  default_answer: 'the reviewer',
};

const FORM_QUESTION = {
  question: 'Two things about the review step, at once',
  context: 'The name is where every later map is filed.',
  options: [
    {
      id: 'name',
      label: 'What do you call this class of problem?',
      kind: 'choice',
      options: ['widget-triage', 'widget-review'],
      recommended: 'widget-triage',
    },
    { id: 'anything_else', label: 'Anything else worth writing down?', kind: 'free_text' },
  ],
  recommendation: 'Take what is pre-filled.',
};

/** The three-question script AT1 and AT5 share. */
function threeTurns(draft: ReturnType<typeof closingDraft>): Turn[] {
  const partial = { done: false, graph: draft.graph };
  return [
    { report: partial, question: PLAIN_QUESTION },
    { report: partial, question: SECOND_QUESTION },
    { report: partial, question: FORM_QUESTION },
    { report: { done: true, graph: draft.graph, skills: draft.skills } },
  ];
}

/** Closes the draft's pins in the test, with the canonical recipe. */
function pinned(draft: ReturnType<typeof closingDraft>): ReturnType<typeof closingDraft> {
  const skills = draft.skills.map((skill) => ({ ...skill, hash: manifestHash(skill) }) as Record<string, unknown>);
  const nodes = (draft.graph.nodes as Record<string, unknown>[]).map((node) => {
    const ref = node.skill_ref as { id: string };
    const skill = skills.find((candidate) => candidate.id === ref.id);
    assert.ok(skill !== undefined);
    return { ...node, skill_ref: { id: skill.id, version: skill.version, hash: skill.hash } };
  });
  return { graph: { ...draft.graph, nodes }, skills };
}

function writeAnswers(t: TestHook, lines: string[]): string {
  const dir = temporaryArea(t, 'cartografo-t546-answers-');
  const file = path.join(dir, 'answers.txt');
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function freshPlane(t: TestHook): Promise<RunningControlPlane> {
  const area = temporaryArea(t, 'cartografo-t546-');
  return await startControlPlane(t, { databasePath: path.join(area, 'cartografo.db') });
}

/* ======================================================================= AT1 */

test('t546 AT1 — end to end: start, answer three turns, register, export, round trip', { timeout: 240_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const exportDir = path.join(temporaryArea(t, 'cartografo-t546-export-'), 'bundle');

  const proc = spawnInterview(t, cp, ['--by', 'test-operator'], { interactive: true });
  await proc.expect('title> ');
  proc.type('how I triage a widget');
  await proc.expect('description> ');
  proc.type('Every week I look at the widgets that came in and decide what to do with each one.');

  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, threeTurns(draft), draft);

  await proc.expect(PLAIN_QUESTION.question);
  await proc.expect('answer> ');
  proc.type('1');
  await proc.expect(SECOND_QUESTION.question);
  await proc.expect('answer> ');
  proc.type('the owner');
  await proc.expect(FORM_QUESTION.question);
  await proc.expect('name> ');
  proc.type('');
  await proc.expect('anything_else> ');
  proc.type('nothing more');

  await proc.expect('next> ');
  proc.type('register');
  await proc.expect('next> ');
  proc.type(`export ${exportDir}`);
  await proc.expect('next> ');
  proc.child.stdin?.end();

  const code = await waitForExit(proc);
  await engine;
  assert.equal(code, 0, `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`);

  const answers = await questionsOf(cp, jobId);
  assert.deepEqual(
    answers.map((row) => row.answer),
    ['yes', 'the owner', JSON.stringify({ name: 'widget-triage', anything_else: 'nothing more' })],
  );
  assert.ok(answers.every((row) => row.answered_by === 'test-operator'));

  const lineage = await api<{ graph: { current_version_id: string | null } }>(cp, 'GET', `/v1/graphs/${DRAFT_CLASS}?project_id=1`);
  assert.equal(lineage.status, 200, 'the registered map is a lineage');
  assert.ok(typeof lineage.body.graph.current_version_id === 'string');

  const exported = JSON.parse(readFileSync(path.join(exportDir, 'graph.json'), 'utf8')) as unknown;
  assert.deepEqual(verifyBundle(exportDir, exported), [], 'the exported directory is a valid bundle');

  const project = await api<{ id: number }>(cp, 'POST', '/v1/projects', { name: 'second' });
  assert.equal(project.status, 201);
  const imported = await runCli(['import', exportDir, '--project', 'second', '--url', cp.url], { token: cp.token });
  assert.equal(imported.code, 0, `import of the export:\n${imported.stderr}`);
  const secondLineage = await api<{ graph: { current_version_id: string } }>(
    cp,
    'GET',
    `/v1/graphs/${DRAFT_CLASS}?project_id=${project.body.id}`,
  );
  assert.equal(
    secondLineage.body.graph.current_version_id,
    lineage.body.graph.current_version_id,
    'the export and the registered lineage are the same document',
  );
});

/* ======================================================================= AT2 */

test('t546 AT2 — resuming loses no answer and answers nothing twice', { timeout: 240_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const turns: Turn[] = [
    { report: { done: false, graph: draft.graph }, question: PLAIN_QUESTION },
    { report: { done: false, graph: draft.graph }, question: SECOND_QUESTION },
    { report: { done: true, graph: draft.graph, skills: draft.skills } },
  ];

  const first = spawnInterview(t, cp, ['--by', 'test-operator'], { interactive: true });
  await first.expect('title> ');
  first.type('how I triage a widget');
  await first.expect('description> ');
  first.type('The weekly widget pass.');
  const jobId = await announcedId(first);
  const engine = startScriptedEngine(t, cp, jobId, turns, draft);

  await first.expect('answer> ');
  first.type('no');
  const deadline = Date.now() + 30_000;
  let firstRow: QuestionRow | undefined;
  while (Date.now() < deadline) {
    firstRow = (await questionsOf(cp, jobId))[0];
    if (firstRow?.answered_at !== null && firstRow?.answered_at !== undefined) break;
    await sleep(100);
  }
  assert.ok(firstRow?.answered_at, 'the first answer landed before the kill');
  first.child.kill('SIGKILL');
  await first.exited;

  const second = spawnInterview(t, cp, ['--resume', String(jobId), '--by', 'test-operator'], { interactive: true });
  assert.equal(await announcedId(second), jobId);
  await second.expect(SECOND_QUESTION.question);
  await second.expect('answer> ');
  second.type('2');
  await second.expect('next> ');
  second.child.stdin?.end();
  assert.equal(await waitForExit(second), 0, `stderr:\n${second.stderr()}`);
  await engine;

  const conversation = await conversationOf(cp, jobId);
  assert.equal(conversation.done, true);
  assert.deepEqual(
    conversation.turns.map((turn) => turn.answer),
    ['no', 'the owner'],
    'both answers are there, once each',
  );
  const rows = await questionsOf(cp, jobId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'answered'));
});

/* ======================================================================= AT3 */

test('t546 AT3 — --resume on a job that is not an interview exits 1 and writes nothing', { timeout: 120_000 }, async (t) => {
  const cp = await freshPlane(t);
  const imported = await runCli(['import', BETS_BUNDLE, '--url', cp.url], { token: cp.token });
  assert.equal(imported.code, 0, imported.stderr);
  const bundle = JSON.parse(readFileSync(path.join(BETS_BUNDLE, 'graph.json'), 'utf8')) as {
    problem_class: string;
    initial_node: string;
  };
  const lineage = await api<{ graph: { current_version_id: string } }>(cp, 'GET', `/v1/graphs/${bundle.problem_class}`);
  const created = await api<{ id: number }>(cp, 'POST', '/v1/jobs', {
    title: 'a bet',
    entry_node_id: bundle.initial_node,
    graph_version_id: lineage.body.graph.current_version_id,
  });
  assert.equal(created.status, 201);
  const eventsBefore = await api<{ events: unknown[] }>(cp, 'GET', `/v1/jobs/${created.body.id}/events`);

  const proc = spawnInterview(t, cp, ['--resume', String(created.body.id)], { interactive: false });
  assert.equal(await waitForExit(proc), 1);
  assert.match(proc.stderr(), /is not an interview/);

  const eventsAfter = await api<{ events: unknown[] }>(cp, 'GET', `/v1/jobs/${created.body.id}/events`);
  assert.equal(eventsAfter.body.events.length, eventsBefore.body.events.length);
});

/* ======================================================================= AT4 */

test('t546 AT4 — --resume on an unknown id exits 1', { timeout: 120_000 }, async (t) => {
  const cp = await freshPlane(t);
  const proc = spawnInterview(t, cp, ['--resume', '9999'], { interactive: false });
  assert.equal(await waitForExit(proc), 1);
  assert.match(proc.stderr(), /no interview #9999/);
});

/* ======================================================================= AT5 */

test('t546 AT5 — nothing the REPL prints says job, runner or input request', { timeout: 240_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const exportDir = path.join(mkdtempSync(path.join(tmpdir(), 'cartografo-t546-sweep-')), 'bundle');
  const answers = writeAnswers(t, [
    'how I triage a widget',
    'The weekly widget pass.',
    '1',
    'the reviewer',
    '',
    'nothing more',
    'register',
    'bogus',
    `export ${exportDir}`,
  ]);

  const proc = spawnInterview(t, cp, ['--answers', answers, '--by', 'test-operator'], { interactive: false });
  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, threeTurns(draft), draft);
  assert.equal(await waitForExit(proc), 0, `stderr:\n${proc.stderr()}`);
  await engine;
  assert.ok(existsSync(path.join(exportDir, 'graph.json')), 'the export ran');

  const everything = `${proc.stdout()}\n${proc.stderr()}`;
  for (const word of [/\bjobs?\b/i, /\brunners?\b/i, /\binput[ _-]requests?\b/i]) {
    assert.ok(!word.test(everything), `the REPL says ${String(word)}:\n${everything}`);
  }
});

/* ======================================================================= AT6 */

test('t546 AT6 — the printed map carries the same facts as the projection', { timeout: 180_000 }, async (t) => {
  const { renderMapText } = (await import('../src/cli/map-document.ts')) as {
    renderMapText: (graph: unknown, manifests?: unknown[]) => string;
  };
  const cp = await freshPlane(t);
  const base = pinned(closingDraft({ allowed: true, domains: ['widgets.example.com'] }));
  const graph = {
    ...base.graph,
    edges: [
      ...(base.graph.edges as unknown[]),
      { from: 'review', to: 'triage', condition: 'fail', description: 'The note goes back for another pass.' },
    ],
  };
  const report = { done: false, graph, skills: base.skills };
  const answers = writeAnswers(t, ['how I triage a widget', 'The weekly widget pass.']);

  const proc = spawnInterview(t, cp, ['--answers', answers], { interactive: false });
  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, [{ report, question: PLAIN_QUESTION }], base);
  await waitForExit(proc);
  // The REPL ran out of lines on the question; the engine is left waiting on it.
  void engine;

  const conversation = await conversationOf(cp, jobId);
  assert.ok(conversation.draft !== null);
  const expected = renderMapText(conversation.draft.graph, conversation.draft.skills);
  const printed = proc.stdout();
  assert.ok(printed.includes(expected), `the REPL printed the projection's map:\n${expected}\n---\n${printed}`);

  for (const fact of [
    'analyst — Writes the triage note from the reported widget.',
    'reviewer — Checks the triage note against the reported widget and closes the run.',
    'needs:',
    'produces:',
    'verified_by:',
    'exits:',
    'fail → triage',
    'reaches an external system: widgets.example.com',
  ]) {
    assert.ok(printed.includes(fact), `the printed map says "${fact}":\n${printed}`);
  }
});

/* ======================================================================= AT7 */

test('t546 AT7 — a plain decision: a number, the text, and Enter all send the option', { timeout: 240_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const partial = { done: false, graph: draft.graph };
  const turns: Turn[] = [
    { report: partial, question: PLAIN_QUESTION },
    { report: partial, question: PLAIN_QUESTION },
    { report: partial, question: PLAIN_QUESTION },
    { report: { done: true, graph: draft.graph, skills: draft.skills } },
  ];
  // The blank line is in the middle: trailing blank lines of --answers are trimmed.
  const answers = writeAnswers(t, ['how I triage a widget', 'The weekly widget pass.', '', '1', 'yes']);

  const proc = spawnInterview(t, cp, ['--answers', answers], { interactive: false });
  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, turns, draft);
  assert.equal(await waitForExit(proc), 0, `stderr:\n${proc.stderr()}`);
  await engine;

  assert.match(proc.stdout(), /1\) yes/);
  assert.match(proc.stdout(), /2\) no/);
  const rows = await questionsOf(cp, jobId);
  assert.deepEqual(
    rows.map((row) => row.answer),
    ['yes', 'yes', 'yes'],
  );
});

/* ======================================================================= AT8 */

test('t546 AT8 — a step form is asked field by field and answered in one write', { timeout: 180_000 }, async (t) => {
  const area = temporaryArea(t, 'cartografo-t546-');
  const databasePath = path.join(area, 'cartografo.db');
  const cp = await startControlPlane(t, { databasePath });
  const draft = closingDraft();
  const partial = { done: false, graph: draft.graph };
  const turns: Turn[] = [
    { report: partial, question: FORM_QUESTION },
    { report: { done: true, graph: draft.graph, skills: draft.skills } },
  ];
  const answers = writeAnswers(t, ['how I triage a widget', 'The weekly widget pass.', '', 'typed by hand']);

  const proc = spawnInterview(t, cp, ['--answers', answers], { interactive: false });
  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, turns, draft);
  assert.equal(await waitForExit(proc), 0, `stderr:\n${proc.stderr()}`);
  await engine;

  const printed = proc.stdout();
  const first = printed.indexOf('name> ');
  const second = printed.indexOf('anything_else> ');
  assert.ok(first !== -1 && second > first, `each field has its own prompt, in order:\n${printed}`);
  assert.match(printed, /field 1\/2: What do you call this class of problem\? \(choice\)/);

  const [row] = await questionsOf(cp, jobId);
  assert.ok(row.answer !== null);
  assert.deepEqual(JSON.parse(row.answer), { name: 'widget-triage', anything_else: 'typed by hand' });

  const { getEventsByEntity } = await loadEvents();
  const db = openDatabase(databasePath);
  try {
    const answered = (getEventsByEntity(db, 'input_request', row.id) as Event[]).filter(
      (event) => event.type === 'input_request.answered',
    );
    assert.equal(answered.length, 1, 'one answer for the whole form');
  } finally {
    db.close();
  }
});

/* ======================================================================= AT9 */

test('t546 AT9 — a refused register returns to the prompt, and export still works', { timeout: 240_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const closed = pinned(draft);
  for (const skill of closed.skills) {
    const response = await api(cp, 'POST', '/v1/skills?project_id=1', skill);
    assert.ok(response.status === 201 || response.status === 200, `seeding ${String(skill.id)}`);
  }
  const seeded = await api(cp, 'POST', '/v1/graphs?project_id=1', closed.graph);
  assert.equal(seeded.status, 201, 'the class is registered before the interview starts');

  const exportDir = path.join(temporaryArea(t, 'cartografo-t546-export-'), 'bundle');
  const answers = writeAnswers(t, ['how I triage a widget', 'The weekly widget pass.', 'register', `export ${exportDir}`]);
  const turns: Turn[] = [{ report: { done: true, graph: draft.graph, skills: draft.skills } }];

  const proc = spawnInterview(t, cp, ['--answers', answers], { interactive: false });
  const jobId = await announcedId(proc);
  const engine = startScriptedEngine(t, cp, jobId, turns, draft);
  assert.equal(await waitForExit(proc), 0, `stderr:\n${proc.stderr()}`);
  await engine;

  assert.match(proc.stderr(), /class_already_registered/);
  const prompts = proc.stdout().split('next> ').length - 1;
  assert.ok(prompts >= 3, `the prompt came back after the refusal:\n${proc.stdout()}`);
  assert.ok(existsSync(path.join(exportDir, 'graph.json')));
  assert.ok(existsSync(path.join(exportDir, 'skills', 'triage-widget.json')));
  assert.ok(existsSync(path.join(exportDir, 'skills', 'review-widget.json')));
});

/* ====================================================================== AT10 */

test('t546 AT10 — --answers running out of lines exits 1 and never reads the terminal', { timeout: 180_000 }, async (t) => {
  const cp = await freshPlane(t);
  const draft = closingDraft();
  const answers = writeAnswers(t, ['how I triage a widget', 'The weekly widget pass.']);

  const proc = spawnInterview(t, cp, ['--answers', answers], { interactive: false });
  const jobId = await announcedId(proc);
  void startScriptedEngine(t, cp, jobId, [{ report: { done: false, graph: draft.graph }, question: PLAIN_QUESTION }], draft);

  assert.equal(await waitForExit(proc), 1, `stdout:\n${proc.stdout()}\nstderr:\n${proc.stderr()}`);
  assert.match(proc.stderr(), /--answers ran out of lines before the interview finished/);
});
