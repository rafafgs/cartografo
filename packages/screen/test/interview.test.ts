/**
 * Acceptance tests for the interview page (t433, RF-15, RF-16, RF-21).
 *
 * This ticket is wiring: the interview engine (t360), the map renderer (t431)
 * and the register/export pair (t432) all shipped already, each tested on its
 * own. What had never existed is a door a person can open — so almost
 * everything here is END TO END, against a real control plane as a child
 * process and the screen in process, exactly as `questions.test.ts` and
 * `board.test.ts` are. Two exceptions, both deliberate: the chat renderer is
 * pure and is fed hand-written conversation shapes (AT17), and the polling
 * island runs against the stub DOM of `fake-dom.ts` (AT18), because this
 * package ships native ES modules and refuses a headless browser as a
 * dependency.
 *
 * ## Two fixtures worth explaining
 *
 * **A finished interview.** `conversation.done` is `job.completed`, which the
 * control plane derives from the traveller standing on a final node it has run
 * — so a session that merely reported `{done: true}` does not make it true.
 * The fixture therefore seeds what a real traversal seeds, in the order a real
 * traversal writes it: the interview's last session reports the map and asks
 * nothing, the job walks its one edge, and a session ON `deliver` — which is
 * what `hasArrived` looks for — closes the crossing. Since t464 the order is
 * only the real one and no longer a trick: `conversation.draft` accumulates
 * `graph` and `skills` per key over every completed session, so `deliver`'s own
 * report, which names neither, is inert wherever it sits.
 *
 * **The forbidden vocabulary.** FR10 asks that nothing THIS TICKET writes says
 * "job", "runner" or "input request". The shared navigation `layout()` draws on
 * every page of the screen carries a `runners` link that predates this ticket
 * and is nothing this page wrote, so the sweep below reads each page with that
 * one shared header removed. Everything else — the title, the whole body, every
 * message — stays inside the sweep.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { FakeDocument, FakeElement } from './fake-dom.ts';
import {
  NO_HOMEPAGE_ENTRY,
  NPM_ENTRY,
  PYPI_ENTRY,
  startRegistryFixture,
} from './fakes/registry-server.mjs';
import type * as ClientModule from '../src/client.ts';
import type * as ExportBundleModule from '../src/export-bundle.ts';
import type * as InterviewModule from '../src/interview.ts';
import type * as McpCatalogModule from '../src/mcp-catalog.ts';
import type * as MapDocumentModule from '../src/map-document.ts';
import type * as PagesModule from '../src/pages.ts';
import type * as RegisterMapModule from '../src/register-map.ts';
import type * as RouterModule from '../src/router.ts';
import {
  api,
  blocks,
  createJob,
  createQuestion,
  openPage,
  openSession,
  requireArtifacts,
  startControlPlane,
  startScreen,
  type RunningControlPlane,
  type ScreenUnderTest,
} from './support.ts';

/* -------------------------------------------------------------- the modules */

async function loadInterview(): Promise<typeof InterviewModule> {
  requireArtifacts('src/interview.ts');
  return (await import(
    new URL('../src/interview.ts', import.meta.url).href
  )) as typeof InterviewModule;
}

async function loadMapDocument(): Promise<typeof MapDocumentModule> {
  requireArtifacts('src/map-document.ts');
  return (await import(
    new URL('../src/map-document.ts', import.meta.url).href
  )) as typeof MapDocumentModule;
}

async function loadExportBundle(): Promise<typeof ExportBundleModule> {
  requireArtifacts('src/export-bundle.ts');
  return (await import(
    new URL('../src/export-bundle.ts', import.meta.url).href
  )) as typeof ExportBundleModule;
}

async function loadRegisterMap(): Promise<typeof RegisterMapModule> {
  requireArtifacts('src/register-map.ts');
  return (await import(
    new URL('../src/register-map.ts', import.meta.url).href
  )) as typeof RegisterMapModule;
}

async function loadPages(): Promise<typeof PagesModule> {
  requireArtifacts('src/pages.ts');
  return (await import(new URL('../src/pages.ts', import.meta.url).href)) as typeof PagesModule;
}

/* --------------------------------------------------------------- vocabulary */

/** The three words no page of this ticket says (FR10). */
const FORBIDDEN = ['job', 'runner', 'input request'];

/**
 * The page with the SHARED navigation removed.
 *
 * `layout()`'s header is every page's, it carries a `runners` link this ticket
 * did not write, and FR10 is about what this ticket writes.
 */
function withoutSharedNav(html: string): string {
  return html.replace(/<header class="topo">[\s\S]*?<\/header>/, '');
}

function assertSaysNothingForbidden(html: string, what: string): void {
  const swept = withoutSharedNav(html);
  for (const word of FORBIDDEN) {
    assert.ok(!swept.toLowerCase().includes(word), `${what} says "${word}":\n${swept}`);
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * The inner HTML of one of the page's two columns, by the id it carries.
 *
 * Depth-counted rather than cut at the first `</div>`: both columns hold real
 * markup, and a naive slice would compare a prefix and call it equality.
 */
function columnOf(html: string, id: string): string {
  const opening = `<div id="${id}">`;
  const start = html.indexOf(opening);
  assert.ok(start >= 0, `the page has no <div id="${id}">:\n${html}`);

  const cursor = start + opening.length;
  const pattern = /<(\/?)div\b/g;
  pattern.lastIndex = cursor;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    depth += match[1] === '' ? 1 : -1;
    if (depth === 0) return html.slice(cursor, match.index);
  }
  assert.fail(`the <div id="${id}"> is never closed:\n${html}`);
}

/** Submits one of this page's forms, the way a browser would, without following. */
async function post(
  screen: ScreenUnderTest,
  path: string,
  fields: Record<string, string> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${screen.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
}

async function countJobs(cp: RunningControlPlane): Promise<number> {
  const response = await api<{ jobs: unknown[] }>(cp, 'GET', '/v1/jobs?project_id=1');
  assert.equal(response.status, 200);
  return response.body.jobs.length;
}

async function readQuestion(
  cp: RunningControlPlane,
  questionId: number,
): Promise<{ id: number; status: string; answer: string | null }> {
  const response = await api<{
    input_requests: { id: number; status: string; answer: string | null }[];
  }>(cp, 'GET', '/v1/input-requests');
  assert.equal(response.status, 200);
  const found = response.body.input_requests.find((row) => row.id === questionId);
  assert.ok(found !== undefined, `the control plane does not know question ${questionId}`);
  return found;
}

/* ----------------------------------------------------------------- fixtures */

/** The class the start form may target, and the only one (`factory-graphs/map-design`). */
const INTERVIEW_CLASS = 'map-design';

/** The class the drafts below register as. */
const DRAFT_CLASS = 'widget-triage';

interface GraphSummaryBody {
  graph: { id: string; current_version_id: string | null };
}

async function mapDesignVersion(cp: RunningControlPlane): Promise<string> {
  const response = await api<GraphSummaryBody>(cp, 'GET', `/v1/graphs/${INTERVIEW_CLASS}`);
  assert.equal(response.status, 200, 'the control plane imports the interview bundle at startup');
  const version = response.body.graph.current_version_id;
  assert.ok(typeof version === 'string', 'the interview class has a current version');
  return version;
}

/** A traveller standing on `interview`: an interview started and nothing more. */
async function seedOpenInterview(cp: RunningControlPlane): Promise<number> {
  const created = await createJob(cp, {
    title: 'how I triage a widget',
    body: 'Every week I look at the widgets that came in and decide what to do with each one.',
    entry_node_id: 'interview',
    graph_version_id: await mapDesignVersion(cp),
  });
  return created.id;
}

/** Closes one session, reporting `output` from `nodeId`. */
async function reportFrom(
  cp: RunningControlPlane,
  jobId: number,
  nodeId: string,
  output: Record<string, unknown>,
): Promise<void> {
  const session = await openSession(cp, { job_id: jobId, node_id: nodeId });
  const finished = await api<{ output_accepted: boolean }>(
    cp,
    'PATCH',
    `/v1/sessions/${session.id}/finish`,
    { status: 'completed', exit_code: 0, output },
  );
  assert.equal(finished.status, 200, `finishing the ${nodeId} session`);
  assert.equal(finished.body.output_accepted, true, `the ${nodeId} report was taken`);
}

/** An interview that has arrived, carrying `draft` — see this file's header. */
async function seedFinishedInterview(
  cp: RunningControlPlane,
  draft: RegisterMapModule.MapDraft,
): Promise<number> {
  const created = await createJob(cp, {
    title: 'how I triage a widget',
    body: 'Every week I look at the widgets that came in.',
    // The same entry_node_id every real interview is created with, and it never
    // changes for the life of the job (t459 FR8) — only `current_node_id` moves
    // as the job travels. Seeding `deliver` here used to be harmless because
    // nothing branched on the field; t459's still-open list does.
    entry_node_id: 'interview',
    graph_version_id: await mapDesignVersion(cp),
  });
  // The last interview turn: it reports the whole map, flattened as two
  // top-level keys since t464, and asks nothing — which is what makes it the
  // turn that finishes interviewing.
  await reportFrom(cp, created.id, 'interview', { done: true, ...draft });
  // `current_node_id` starts at `entry_node_id` and moves only through
  // `/transitions` — never through a session merely finishing (t459). With
  // `entry_node_id` corrected to `interview` above, the job has to actually
  // walk the graph's one edge to `deliver` for `hasArrived` to read true.
  const walked = await api(cp, 'POST', `/v1/jobs/${created.id}/transitions`, {
    to_node_id: 'deliver',
  });
  assert.equal(walked.status, 200, 'the interview walks its one edge to deliver');
  await reportFrom(cp, created.id, 'deliver', {
    bundle: { graph: draft.graph, skills: draft.skills },
    checked: { structure: true, soundness: true },
    note: 'the map covers triage and review',
  });
  return created.id;
}

/** What a manifest declares about reaching outside (RF-20, the pinned half). */
type Network = { allowed: false } | { allowed: true; domains: string[] };

/**
 * A draft whose pins close and whose graph the registry accepts.
 *
 * The same two-step shape `export-bundle.test.ts` already builds and
 * `scripts/validate-factory-bundle.mjs` already accepts there — repeated rather
 * than shared because this file needs one knob that one does not: whether the
 * first step's manifest declares the outside world (AT15).
 */
function closingDraft(network: Network = { allowed: false }): RegisterMapModule.MapDraft {
  return {
    graph: {
      problem_class: DRAFT_CLASS,
      lineage: { type: 'base' },
      metadata: {
        name: 'Widget triage — the interviewed map',
        description: 'Two steps: one writes the triage note, one checks it and closes the run.',
        schema_version: '1.0.0',
        created_at: '2026-09-07',
        source: 'an interview at the screen',
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
              {
                type: 'deterministic',
                command: 'test -s triage.md',
                description: 'The triage note exists and is not empty.',
              },
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
                instruction:
                  'Does the note name the reported widget and the decision taken about it? Cite the passage that supports the verdict.',
                required_evidence: true,
                description: 'A judgement of adherence, with evidence of its own.',
              },
            ],
          },
        },
      ],
      edges: [
        {
          from: 'triage',
          to: 'review',
          condition: 'always',
          description: 'A single exit: the note always goes on to review.',
        },
      ],
      initial_node: 'triage',
      final_nodes: ['review'],
      // Declared, and not empty: `widget` is what both steps need before they
      // can start, and a class whose first step asks for something no step
      // produces and no field declares is one the registry refuses outright
      // (`unproduced_input`). The interview asks for exactly this, so a draft
      // that reaches the register button carries it.
      custom_fields: [
        {
          name: 'widget',
          type: 'string',
          required_at: 'triage',
          description: 'The widget that came in.',
        },
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
            instruction:
              'Does the note name the reported widget and the decision taken about it? Cite the passage that supports the verdict.',
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

/** The same draft with one pin that cannot close: a step naming a manifest that is not there. */
function brokenDraft(): RegisterMapModule.MapDraft {
  const draft = closingDraft();
  draft.skills = [draft.skills[0]];
  return draft;
}

/* ----------------------------------------------------------- the zip reader */

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Reads a Stored zip from the end, the same hand-written reader `export-bundle.test.ts` uses. */
function readZip(bytes: Uint8Array): ZipEntry[] {
  const buffer = Buffer.from(bytes);

  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'the archive carries no end-of-central-directory record');

  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < total; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `central directory record #${index}`);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: buffer.subarray(start, start + compressedSize) });

    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/* ================================================================= AT1 */

test('t433 AT1 — GET /interview asks for a title and a description, and nothing else', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/interview');

  assert.equal(page.status, 200);
  assert.ok(page.html.includes('action="/interview"'), 'the form posts to /interview');

  const titleField = /<input[^>]*name="title"[^>]*>/.exec(page.html)?.[0];
  assert.ok(titleField !== undefined, `there is a title field:\n${page.html}`);
  assert.ok(titleField.includes('required'), `the title field is required: ${titleField}`);

  const bodyField = /<textarea[^>]*name="body"[^>]*>/.exec(page.html)?.[0];
  assert.ok(bodyField !== undefined, `there is a description field:\n${page.html}`);
  assert.ok(bodyField.includes('required'), `the description field is required: ${bodyField}`);

  assertSaysNothingForbidden(page.html, 'GET /interview');
});

/* ================================================================= AT2 */

test('t433 AT2 — POST /interview starts a real interview on the map-design class', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const submission = await post(screen, '/interview', {
    title: 'how I triage a widget',
    body: 'Every week I look at the widgets that came in and decide what to do with each one.',
  });

  assert.equal(submission.status, 303, 'a POST that writes answers with a redirect');
  const location = submission.headers.get('location') ?? '';
  const opened = /^\/interview\/([0-9]+)$/.exec(location);
  assert.ok(opened !== null, `the redirect opens the interview: ${location}`);

  const created = await api<{ entry_node_id: string; graph_version_id: string; title: string }>(
    cp,
    'GET',
    `/v1/jobs/${opened[1]}`,
  );
  assert.equal(created.status, 200, 'the control plane knows it');
  assert.equal(created.body.entry_node_id, 'interview');
  assert.equal(created.body.title, 'how I triage a widget');
  assert.equal(created.body.graph_version_id, await mapDesignVersion(cp));
});

/* ================================================================= AT3 */

test('t433 AT3 — a blank title, and a blank description, are refused before the network', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const before = await countJobs(cp);

  const noTitle = await post(screen, '/interview', { title: '   ', body: 'a real description' });
  assert.equal(noTitle.status, 400);
  assertSaysNothingForbidden(await noTitle.text(), 'the blank-title refusal');

  const noBody = await post(screen, '/interview', { title: 'a real title', body: '  ' });
  assert.equal(noBody.status, 400);
  assertSaysNothingForbidden(await noBody.text(), 'the blank-description refusal');

  assert.equal(await countJobs(cp), before, 'nothing was created');
});

/* ================================================================= AT4 */

test('t433 AT4 — a freshly started interview is thinking, with nothing to draw yet', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);

  const page = await openPage(screen, `/interview/${jobId}`);

  assert.equal(page.status, 200);
  const chat = columnOf(page.html, 'chat');
  assert.ok(chat.includes('data-state="thinking"'), `the exchange is thinking:\n${chat}`);
  const map = columnOf(page.html, 'map');
  assert.ok(map.includes('nothing to draw yet'), `the map column is still empty:\n${map}`);

  assertSaysNothingForbidden(page.html, 'a thinking interview');
});

/* ================================================================= AT5 */

test('t433 AT5 — the open question shows all five fields, its options and a named answer field', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);

  const asked = {
    question: 'What do you call this class of problem?',
    context: 'The name is the address every later map is filed under.',
    options: ['widget-triage', 'widget-review'],
    recommendation: 'Take widget-triage: it is what you already call it out loud.',
    default_answer: 'widget-triage',
  };
  await createQuestion(cp, { job_id: jobId, ...asked });

  const page = await openPage(screen, `/interview/${jobId}`);
  const chat = columnOf(page.html, 'chat');

  assert.ok(chat.includes(asked.question), 'shows the question');
  assert.ok(chat.includes(asked.context), 'shows the context');
  assert.ok(chat.includes(asked.recommendation), 'shows the recommendation');
  assert.ok(chat.includes(asked.default_answer), 'shows the default answer');
  for (const option of asked.options) {
    assert.ok(
      new RegExp(`<button[^>]*data-option="${option}"`).test(chat),
      `there is a button for the option "${option}":\n${chat}`,
    );
  }
  assert.ok(
    chat.includes(`action="/interview/${jobId}/answer"`),
    `the form answers this interview:\n${chat}`,
  );

  // The same accessible-name check `questions-answer-field.test.ts` makes: a
  // visible <label> tied by for/id, never a placeholder standing in for a name.
  const field = /<textarea[^>]*id="([^"]+)"[^>]*name="answer"/.exec(chat);
  assert.ok(field !== null, `the answer field is a named <textarea>:\n${chat}`);
  assert.ok(
    new RegExp(`<label[^>]*for="${field[1]}"[^>]*>[^<]*\\S`).test(chat),
    `a visible <label for="${field[1]}"> names it:\n${chat}`,
  );

  assertSaysNothingForbidden(page.html, 'the pending question');
});

/* ================================================================= AT6 */

test('t433 AT6 — the answer form writes FOR REAL, and a blank one is refused', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);
  const question = await createQuestion(cp, { job_id: jobId, question: 'What do you call it?' });

  const blank = await post(screen, `/interview/${jobId}/answer`, { answer: '   ' });
  assert.equal(blank.status, 400);
  assertSaysNothingForbidden(await blank.text(), 'the blank-answer refusal');
  assert.equal((await readQuestion(cp, question.id)).status, 'pending', 'nothing was written');

  const submission = await post(screen, `/interview/${jobId}/answer`, { answer: 'widget-triage' });
  assert.equal(submission.status, 303);
  assert.equal(submission.headers.get('location'), `/interview/${jobId}`);

  const after = await readQuestion(cp, question.id);
  assert.equal(after.status, 'answered', 'the control plane recorded the answer');
  assert.equal(after.answer, 'widget-triage');
});

/* ================================================================= AT7 */

test('t433 AT7 — every write of this page refuses a submit that started elsewhere', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedFinishedInterview(cp, closingDraft());
  const before = await api<{ graphs: unknown[] }>(cp, 'GET', '/v1/graphs');

  for (const route of ['answer', 'register', 'export']) {
    const refused = await post(
      screen,
      `/interview/${jobId}/${route}`,
      { answer: 'anything' },
      { 'sec-fetch-site': 'cross-site' },
    );
    assert.equal(refused.status, 403, `POST /interview/:id/${route} is gated`);
    const page = await refused.text();
    assert.ok(page.includes('<h2>untrusted origin</h2>'), `the 403 of /${route}:\n${page}`);
  }

  const after = await api<{ graphs: unknown[] }>(cp, 'GET', '/v1/graphs');
  assert.equal(after.body.graphs.length, before.body.graphs.length, 'nothing was registered');
});

/* ================================================================= AT8 */

test('t433 AT8 — the map column is exactly what renderStepProgress + renderMapDocument draw for the draft', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { renderMapDocument, renderStepProgress } = await loadMapDocument();

  const draft = closingDraft();
  const jobId = await seedOpenInterview(cp);
  await reportFrom(cp, jobId, 'interview', { done: false, ...draft });

  const page = await openPage(screen, `/interview/${jobId}`);
  assert.equal(page.status, 200);
  assert.equal(
    columnOf(page.html, 'map'),
    renderStepProgress(draft.graph as MapDocumentModule.MapDocumentGraph) +
      renderMapDocument(
        draft.graph as MapDocumentModule.MapDocumentGraph,
        draft.skills as MapDocumentModule.MapDocumentManifest[],
      ),
  );
});

/* ================================================================= AT9 */

test('t433 AT9 — the fragment is the same two columns the page rendered', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, { job_id: jobId, question: 'What do you call it?' });
  await reportFrom(cp, jobId, 'interview', { done: false, ...closingDraft() });

  const page = await openPage(screen, `/interview/${jobId}`);
  const fragment = await fetch(`${screen.url}/interview/${jobId}/fragment`);

  assert.equal(fragment.status, 200);
  assert.match(fragment.headers.get('content-type') ?? '', /^application\/json/);
  const body = (await fragment.json()) as { chat: string; map: string; done: boolean };

  assert.equal(body.chat, columnOf(page.html, 'chat'));
  assert.equal(body.map, columnOf(page.html, 'map'));
  assert.equal(body.done, false);
});

/* ================================================================ AT10 */

test('t433 AT10 — a finished interview closes with both actions, and the fragment says done', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedFinishedInterview(cp, closingDraft());

  const page = await openPage(screen, `/interview/${jobId}`);
  const chat = columnOf(page.html, 'chat');

  assert.ok(chat.includes('data-state="done"'), `the exchange is closed:\n${chat}`);
  assert.ok(chat.includes(`action="/interview/${jobId}/register"`), 'there is a register action');
  assert.ok(chat.includes(`action="/interview/${jobId}/export"`), 'there is a download action');

  const fragment = await fetch(`${screen.url}/interview/${jobId}/fragment`);
  const body = (await fragment.json()) as { done: boolean };
  assert.equal(body.done, true);

  assertSaysNothingForbidden(page.html, 'a finished interview');
});

/* ================================================================ AT11 */

test('t433 AT11 — registering a closing draft registers it FOR REAL', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedFinishedInterview(cp, closingDraft());

  const submission = await post(screen, `/interview/${jobId}/register`);
  assert.equal(submission.status, 303, await submission.text());
  assert.equal(submission.headers.get('location'), `/graphs/${DRAFT_CLASS}`);

  const registered = await api<GraphSummaryBody>(cp, 'GET', `/v1/graphs/${DRAFT_CLASS}`);
  assert.equal(registered.status, 200, 'the class exists in the control plane');
  assert.ok(registered.body.graph.current_version_id !== null, 'and it carries a version');
});

/* ================================================================ AT12 */

test('t433 AT12 — registering before the interview closes is refused, and writes nothing', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);
  await reportFrom(cp, jobId, 'interview', { done: false, ...closingDraft() });

  const before = await api<{ skills: unknown[] }>(cp, 'GET', '/v1/skills');
  const refused = await post(screen, `/interview/${jobId}/register`);

  assert.equal(refused.status, 400);
  assertSaysNothingForbidden(await refused.text(), 'the too-early refusal');

  const graph = await api<unknown>(cp, 'GET', `/v1/graphs/${DRAFT_CLASS}`);
  assert.equal(graph.status, 404, 'no class was registered');
  const after = await api<{ skills: unknown[] }>(cp, 'GET', '/v1/skills');
  assert.equal(after.body.skills.length, before.body.skills.length, 'no manifest was registered');
});

/* ================================================================ AT13 */

test('t433 AT13 — a draft whose pin does not close is refused with every problem', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { fillSkillRefs } = await loadRegisterMap();
  const { escapeHtml } = await loadPages();

  const jobId = await seedFinishedInterview(cp, brokenDraft());

  const refused = await post(screen, `/interview/${jobId}/register`);
  assert.equal(refused.status, 422);
  const page = await refused.text();

  const filled = fillSkillRefs(brokenDraft());
  assert.equal(filled.ok, false, 'the fixture really does not close');
  const problems = filled.ok ? [] : filled.problems;
  assert.ok(problems.length > 0, 'and it reports at least one problem');
  for (const problem of problems) {
    assert.ok(
      page.includes(escapeHtml(problem.message)),
      `the refusal names "${problem.message}":\n${page}`,
    );
  }

  const graph = await api<unknown>(cp, 'GET', `/v1/graphs/${DRAFT_CLASS}`);
  assert.equal(graph.status, 404, 'nothing was registered');
  assertSaysNothingForbidden(page, 'the pin refusal');
});

/* ================================================================ AT14 */

test('t433 AT14 — exporting answers the bundle bytes as a download', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { buildBundleZip } = await loadExportBundle();

  const jobId = await seedFinishedInterview(cp, closingDraft());

  const download = await post(screen, `/interview/${jobId}/export`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /^application\/zip/);
  assert.equal(
    download.headers.get('content-disposition'),
    `attachment; filename="${DRAFT_CLASS}.bundle.zip"`,
  );

  const built = buildBundleZip(closingDraft());
  assert.ok(built.ok, 'the fixture builds');
  const expected = new Map(
    readZip(built.bytes).map((entry) => [entry.name, entry.data.toString('utf8')]),
  );
  const got = new Map(
    readZip(new Uint8Array(await download.arrayBuffer())).map((entry) => [
      entry.name,
      entry.data.toString('utf8'),
    ]),
  );

  assert.deepEqual([...got.keys()].sort(), [...expected.keys()].sort());
  for (const [name, content] of expected) {
    assert.equal(got.get(name), content, `${name} matches buildBundleZip's own output`);
  }
  assert.ok(got.has('graph.json'), 'the bundle carries the graph');
  assert.ok([...got.keys()].some((name) => name.startsWith('skills/')), 'and its manifests');
});

/* ============================================================ t464 AT5 */

test('t464 AT5 — a last turn that reports only `graph` still registers and exports every manifest', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { buildBundleZip } = await loadExportBundle();

  const draft = closingDraft();
  const created = await createJob(cp, {
    title: 'how I triage a widget',
    body: 'Every week I look at the widgets that came in.',
    entry_node_id: 'interview',
    graph_version_id: await mapDesignVersion(cp),
  });

  // An earlier turn settled the manifests...
  await reportFrom(cp, created.id, 'interview', {
    done: false,
    graph: draft.graph,
    skills: draft.skills,
  });
  // ...and the last one changed none of them, so it reports none. Under the old
  // last-session-only rule this is the turn that lost every manifest the
  // interview had written.
  await reportFrom(cp, created.id, 'interview', { done: true, graph: draft.graph });

  const walked = await api(cp, 'POST', `/v1/jobs/${created.id}/transitions`, {
    to_node_id: 'deliver',
  });
  assert.equal(walked.status, 200, 'the interview walks its one edge to deliver');
  await reportFrom(cp, created.id, 'deliver', {
    bundle: { graph: draft.graph, skills: draft.skills },
    checked: { structure: true, soundness: true },
    note: 'the map covers triage and review',
  });

  const submission = await post(screen, `/interview/${created.id}/register`);
  assert.equal(submission.status, 303, await submission.text());
  assert.equal(submission.headers.get('location'), `/graphs/${DRAFT_CLASS}`);

  const registered = await api<{ skills: { id: string }[] }>(cp, 'GET', '/v1/skills');
  const ids = registered.body.skills.map((skill) => skill.id);
  for (const manifest of draft.skills) {
    assert.ok(
      ids.includes(manifest.id),
      `${manifest.id} was registered from the accumulated map: ${JSON.stringify(ids)}`,
    );
  }

  const download = await post(screen, `/interview/${created.id}/export`);
  assert.equal(download.status, 200, 'the export answers the bundle bytes');
  const built = buildBundleZip(draft);
  assert.ok(built.ok, 'the fixture builds');
  const got = new Map(
    readZip(new Uint8Array(await download.arrayBuffer())).map((entry) => [
      entry.name,
      entry.data.toString('utf8'),
    ]),
  );
  assert.deepEqual(
    [...got.keys()].sort(),
    readZip(built.bytes)
      .map((entry) => entry.name)
      .sort(),
    'the exported bundle carries every manifest, not only what the last turn reported',
  );
});

/* ================================================================ AT15 */

test('t433 AT15 — GET /graphs/:class draws a registered map, network line included', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { manifestHash } = await loadRegisterMap();
  const { renderMapDocument } = await loadMapDocument();

  // Registered the way any API client would: manifests first, graph after — and
  // the first one declaring the outside world, which is the RF-20 line an
  // interview's own live column can never show (a draft's manifests carry no
  // pin, so `matchesPin` never matches mid-interview).
  const draft = closingDraft({ allowed: true, domains: ['api.widgets.example'] });
  const pinned = draft.skills.map((entry) => ({ ...entry, hash: manifestHash(entry) }));

  for (const entry of pinned) {
    const response = await api<unknown>(cp, 'POST', '/v1/skills', entry);
    assert.ok(
      response.status === 201 || response.status === 200,
      `registering ${entry.id}: ${JSON.stringify(response.body)}`,
    );
  }

  const document = {
    ...draft.graph,
    nodes: (draft.graph.nodes ?? []).map((graphNode, index) => ({
      ...graphNode,
      skill_ref: { id: pinned[index].id, version: pinned[index].version, hash: pinned[index].hash },
    })),
  };
  const created = await api<unknown>(cp, 'POST', '/v1/graphs', document);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // What the page has to equal is read back from the API independently, never
  // from the objects posted above: the snapshot is the control plane's.
  const lineage = await api<GraphSummaryBody>(cp, 'GET', `/v1/graphs/${DRAFT_CLASS}`);
  const version = await api<{ graph_version: { snapshot: MapDocumentModule.MapDocumentGraph } }>(
    cp,
    'GET',
    `/v1/graph-versions/${lineage.body.graph.current_version_id}`,
  );
  const manifests: MapDocumentModule.MapDocumentManifest[] = [];
  for (const entry of pinned) {
    const skill = await api<MapDocumentModule.MapDocumentManifest>(
      cp,
      'GET',
      `/v1/skills/${entry.id}?hash=${encodeURIComponent(entry.hash)}`,
    );
    assert.equal(skill.status, 200);
    manifests.push(skill.body);
  }

  const page = await openPage(screen, `/graphs/${DRAFT_CLASS}`);
  assert.equal(page.status, 200);
  const map = columnOf(page.html, 'map');
  assert.equal(map, renderMapDocument(version.body.graph_version.snapshot, manifests));
  assert.ok(
    map.includes('api.widgets.example'),
    `the RF-20 network line is drawn from the pinned manifest:\n${map}`,
  );
  assertSaysNothingForbidden(page.html, 'the read-only map');
});

/* ================================================================ AT16 */

test('t433 AT16 — a class nobody registered answers the ordinary 404', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/graphs/never-registered');
  assert.equal(page.status, 404);
  assertSaysNothingForbidden(page.html, 'the unknown-class 404');
});

/* ================================================================ AT17 */

test('t433 AT17 — the chat renderer never says job, runner or input request', async () => {
  const { renderChat } = await loadInterview();

  const draft = closingDraft();
  const turn = {
    question: 'What do you call this class of problem?',
    answer: 'widget-triage',
    answered_by: 'rafael',
    at: '2026-09-07T10:00:00.000Z',
  };
  const pending = {
    id: 7,
    question: 'What does the first step need before it can start?',
    context: 'It is the contract the step is dispatched against.',
    recommendation: 'The widget that came in.',
    options: ['the widget', 'the whole queue'],
    default: 'the widget',
  };

  // The five shapes `domain/conversation.ts`'s own doc comment enumerates: an
  // open turn (nothing closed yet, one question waiting), a closed turn, a
  // pending question over a history, the thinking state, and the finished one.
  // `partial` rides on all five since t465, and it is `null` on all five here:
  // the shape that carries one is t465 AT18's own case, and this sweep is the
  // pin that the five shapes THIS ticket enumerated still say nothing forbidden.
  const shapes: ClientModule.Conversation[] = [
    { turns: [], pending, thinking: false, partial: null, draft: null, done: false },
    { turns: [turn], pending: null, thinking: false, partial: null, draft, done: false },
    { turns: [turn], pending, thinking: false, partial: null, draft, done: false },
    { turns: [turn], pending: null, thinking: true, partial: null, draft, done: false },
    { turns: [turn], pending: null, thinking: false, partial: null, draft, done: true },
  ];

  for (const [index, shape] of shapes.entries()) {
    const html = renderChat(shape, 42).toLowerCase();
    for (const word of FORBIDDEN) {
      assert.ok(!html.includes(word), `shape #${index} says "${word}":\n${html}`);
    }
  }
});

/* ================================================================ AT18 */

test('t433 AT18 — the island keeps a typed answer, and stops the moment it is done', async () => {
  requireArtifacts('src/public/interview.js');
  const { mount } = (await import(
    new URL('../src/public/interview.js', import.meta.url).href
  )) as {
    mount: (
      doc: FakeDocument,
      request: (url: string) => Promise<Response>,
      jobId: number,
      schedule?: (fn: () => void, ms: number) => void,
    ) => { tick: () => Promise<void> };
  };

  const doc = new FakeDocument(['chat', 'map']);
  const field = new FakeElement('textarea');
  field.id = 'answer-7';
  field.value = 'half a sentence';
  doc.require('chat').append(field);
  doc.activeElement = field;

  const scheduled: { fn: () => void; ms: number }[] = [];
  const schedule = (fn: () => void, ms: number): void => {
    scheduled.push({ fn, ms });
  };

  const answers = [
    { chat: '<textarea id="answer-7" name="answer"></textarea>', map: '<ol></ol>', done: false },
    { chat: '<p>closed</p>', map: '<ol></ol>', done: true },
  ];
  let calls = 0;
  const request = async (url: string): Promise<Response> => {
    assert.equal(url, '/interview/42/fragment');
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const island = mount(doc, request, 42, schedule);
  assert.equal(scheduled.length, 1, 'mounting schedules the first poll');
  assert.equal(scheduled[0].ms, 3000, 'and it is three seconds away');
  assert.equal(calls, 0, 'mounting itself asks nothing');

  await island.tick();
  assert.equal(calls, 1);
  assert.equal(doc.require('chat').innerHTML, answers[0].chat, 'the exchange was swapped');
  const carried = doc.getElementById('answer-7');
  assert.ok(carried !== null, 'the same question is still there');
  assert.equal(carried.value, 'half a sentence', 'and what was typed came with it');
  assert.equal(carried.focused, true, 'and it has focus again');
  assert.equal(scheduled.length, 2, 'a poll that is not done schedules the next one');

  await island.tick();
  assert.equal(calls, 2, 'the injected fetch was called exactly once more');
  assert.equal(scheduled.length, 2, 'a poll that is done schedules nothing more');
});

/* ---------------------------------------------------------------------------
 * AT19 is `packages/screen/test/spec-routes.test.ts` itself: `t183 AT1`–`AT3`
 * read this ticket's router and this ticket's §1 table with their assertions
 * unchanged. Restating them here would be a second pin to keep agreeing with
 * the first.
 * ------------------------------------------------------------------------- */

/* ===========================================================================
 * t373 — the RF-20 extension: when no discovered server covers what the step
 * needs, the open question carries up to three candidates from the official
 * registry, and never a button that installs one.
 *
 * The registry is `fakes/registry-server.mjs` on a loopback port, wired in
 * through `ScreenOptions.mcpRegistryUrl`. Nothing here reaches the real
 * registry, and nothing here runs a command it renders.
 * ======================================================================== */

/** The line every suggestion carries, verbatim. */
const MCP_DISCLAIMER =
  'not reviewed by anyone on your side; configure its credentials on the engine, not here.';

/** What a suggestion says instead of a command when none is evidenced. */
const NO_COMMAND_LINE = 'no known add command; see its homepage';

/** A `context` that asks for a server the machine does not have (FR1's line). */
const HINTED_CONTEXT =
  'You said this step reaches into your calendar, and nothing this engine reports covers it.\nNEEDS_MCP_SERVER: calendar';

/**
 * The screen, up, with knobs `support.ts`'s `startScreen` does not expose.
 *
 * Deliberately local rather than a third parameter on the shared helper: the
 * catalogue seam is this ticket's, four tests in this file use it, and every
 * other suite in the package starts its screen unchanged.
 */
async function startScreenWith(
  t: { after: (fn: () => void | Promise<void>) => void },
  cp: RunningControlPlane,
  extra: Partial<RouterModule.ScreenOptions>,
): Promise<ScreenUnderTest> {
  requireArtifacts('src/router.ts');
  const { startScreenRouter } = (await import(
    new URL('../src/router.ts', import.meta.url).href
  )) as typeof RouterModule;

  const screen = await startScreenRouter({
    controlPlaneUrl: cp.url,
    token: cp.token,
    port: 0,
    ...extra,
  });
  t.after(async () => {
    await screen.close();
  });
  return { url: screen.url };
}

/**
 * The suggestion block of a page, or `null` when the page drew none.
 *
 * Depth-counted over `<div>` for the same reason `columnOf` is: the block sits
 * inside the chat column, and a slice cut at the first `</div>` would compare a
 * prefix and call it the whole thing.
 */
function suggestionBlock(html: string): string | null {
  const opening = '<div class="mcp-suggestions">';
  const start = html.indexOf(opening);
  if (start < 0) return null;

  const cursor = start + opening.length;
  const pattern = /<(\/?)div\b/g;
  pattern.lastIndex = cursor;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    depth += match[1] === '' ? 1 : -1;
    if (depth === 0) return html.slice(cursor, match.index);
  }
  assert.fail(`the suggestion block is never closed:\n${html}`);
}

/** How many suggestion cards a page drew. */
function countSuggestions(html: string): number {
  return (html.match(/class="mcp-suggestion"/g) ?? []).length;
}

/** Seeds an open interview whose one question asks for a server nobody has. */
async function seedHintedQuestion(cp: RunningControlPlane): Promise<number> {
  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, {
    job_id: jobId,
    question: 'Which server does the scheduling step reach through?',
    context: HINTED_CONTEXT,
    recommendation: 'Name the one you already use, or install one of the three below.',
    default_answer: 'none of them yet',
  });
  return jobId;
}

/* ================================================================ AT10 */

test('t373 AT10 — a question that needs a server nobody has offers three candidates', async (t) => {
  const cp = await startControlPlane(t);
  const registry = await startRegistryFixture(t, {
    servers: [NPM_ENTRY, PYPI_ENTRY, NO_HOMEPAGE_ENTRY],
  });
  const screen = await startScreenWith(t, cp, { mcpRegistryUrl: registry.url });
  const jobId = await seedHintedQuestion(cp);

  const page = await openPage(screen, `/interview/${jobId}`);
  assert.equal(page.status, 200);
  const block = suggestionBlock(page.html);
  assert.ok(block !== null, `the page drew no suggestions at all:\n${page.html}`);
  assert.equal(countSuggestions(block), 3, `three candidates:\n${block}`);

  // The names, the descriptions and — for the default engine — the add command.
  assert.ok(block.includes('io.example/calendar'), 'the npm candidate is named');
  assert.ok(block.includes('Reads and writes a calendar.'), 'and described');
  assert.ok(
    block.includes('claude mcp add io.example/calendar -- npx -y calendar-mcp-server'),
    `the npm candidate carries its add command:\n${block}`,
  );
  assert.ok(
    block.includes('claude mcp add io.example/calendar-python -- uvx calendar-mcp'),
    `the pypi candidate carries its add command:\n${block}`,
  );
  assert.ok(
    block.includes('href="https://example.com/calendar"'),
    `the candidate with a homepage links to it:\n${block}`,
  );

  const disclaimers = block.split(MCP_DISCLAIMER).length - 1;
  assert.equal(disclaimers, 3, `the disclaimer appears once per candidate:\n${block}`);

  assertSaysNothingForbidden(page.html, 'a question carrying suggestions');
});

/* ================================================================ AT11 */

test('t373 AT11 — the suggestion block installs nothing and links nowhere else', async (t) => {
  const cp = await startControlPlane(t);
  const registry = await startRegistryFixture(t, {
    servers: [NPM_ENTRY, PYPI_ENTRY, NO_HOMEPAGE_ENTRY],
  });
  const screen = await startScreenWith(t, cp, { mcpRegistryUrl: registry.url });
  const jobId = await seedHintedQuestion(cp);

  const page = await openPage(screen, `/interview/${jobId}`);
  const block = suggestionBlock(page.html);
  assert.ok(block !== null, 'the page drew suggestions');

  assert.ok(!block.includes('<form'), `there is no form in the block:\n${block}`);
  assert.ok(!block.includes('<button'), `and no button:\n${block}`);

  // The ONLY addresses this block may point at are the candidates' own.
  const allowed = new Set([
    'https://example.com/calendar',
    'https://github.com/example/calendar-python',
  ]);
  for (const link of block.matchAll(/<a\b[^>]*href="([^"]*)"/g)) {
    assert.ok(allowed.has(link[1]), `the block links somewhere that is not a homepage: ${link[1]}`);
  }
});

/* ================================================================ AT12 */

test('t373 AT12 — a registry that hangs costs the question nothing at all', async (t) => {
  const cp = await startControlPlane(t);
  const registry = await startRegistryFixture(t, {
    servers: [NPM_ENTRY],
    delayMs: 60_000,
  });
  const screen = await startScreenWith(t, cp, { mcpRegistryUrl: registry.url });
  const jobId = await seedHintedQuestion(cp);

  const page = await openPage(screen, `/interview/${jobId}`);

  assert.equal(page.status, 200, 'a slow registry is not an error page');
  const chat = columnOf(page.html, 'chat');
  assert.ok(chat.includes('Which server does the scheduling step reach through?'), 'the question');
  assert.ok(chat.includes('NEEDS_MCP_SERVER: calendar'), 'the context, whole');
  assert.ok(chat.includes('Name the one you already use'), 'the recommendation');
  assert.ok(chat.includes(`action="/interview/${jobId}/answer"`), 'the answer form');
  assert.equal(countSuggestions(page.html), 0, `no candidate was drawn:\n${chat}`);
  assert.equal(suggestionBlock(page.html), null, 'and no empty block either');
  assertSaysNothingForbidden(page.html, 'a question whose registry hung');
});

/* ================================================================ AT13 */

test('t373 AT13 — an ordinary question never touches the catalogue', async (t) => {
  const cp = await startControlPlane(t);

  const searched: string[] = [];
  const counting: McpCatalogModule.McpCatalog = {
    async search(query) {
      searched.push(query);
      return [];
    },
  };
  const screen = await startScreenWith(t, cp, { mcpCatalog: counting });

  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, {
    job_id: jobId,
    question: 'What do you call this class of problem?',
    context: 'The name is the address every later map is filed under.',
  });

  const page = await openPage(screen, `/interview/${jobId}`);
  assert.equal(page.status, 200);
  assert.equal(countSuggestions(page.html), 0);
  assert.equal(suggestionBlock(page.html), null);

  await fetch(`${screen.url}/interview/${jobId}/fragment`);
  assert.deepEqual(searched, [], 'a question with no hint costs no registry call');
});

/* ================================================================ AT14 */

test('t373 AT14 — the fragment carries the same suggestions the page rendered', async (t) => {
  const cp = await startControlPlane(t);
  const registry = await startRegistryFixture(t, {
    servers: [NPM_ENTRY, PYPI_ENTRY, NO_HOMEPAGE_ENTRY],
  });
  const screen = await startScreenWith(t, cp, { mcpRegistryUrl: registry.url });
  const jobId = await seedHintedQuestion(cp);

  const page = await openPage(screen, `/interview/${jobId}`);
  const fragment = await fetch(`${screen.url}/interview/${jobId}/fragment`);
  assert.equal(fragment.status, 200);
  const body = (await fragment.json()) as { chat: string };

  assert.equal(body.chat, columnOf(page.html, 'chat'));
  assert.equal(countSuggestions(body.chat), 3, 'and the suggestions are in it');
});

/* ================================================================ AT15 */

test('t373 AT15 — the command shown is the one for the engine actually recorded', async (t) => {
  const cp = await startControlPlane(t);
  const registry = await startRegistryFixture(t, { servers: [NPM_ENTRY] });
  const screen = await startScreenWith(t, cp, { mcpRegistryUrl: registry.url });
  const jobId = await seedHintedQuestion(cp);

  const claude = 'claude mcp add io.example/calendar -- npx -y calendar-mcp-server';
  const codex = 'codex mcp add io.example/calendar -- npx -y calendar-mcp-server';

  const withClaude = await openPage(screen, `/interview/${jobId}`);
  assert.ok(withClaude.html.includes(claude), 'the default engine is claude-code');
  assert.ok(!withClaude.html.includes(codex), 'and the other engine is not shown beside it');

  const toCodex = await api(cp, 'PATCH', '/v1/settings', { engine: 'codex' });
  assert.equal(toCodex.status, 200, 'the engine was recorded');

  const withCodex = await openPage(screen, `/interview/${jobId}`);
  assert.ok(withCodex.html.includes(codex), `the codex command is shown:\n${withCodex.html}`);
  assert.ok(!withCodex.html.includes(claude), 'and not the claude one');

  const toStrange = await api(cp, 'PATCH', '/v1/settings', { engine: 'some-other-cli' });
  assert.equal(toStrange.status, 200);

  const withStrange = await openPage(screen, `/interview/${jobId}`);
  assert.equal(countSuggestions(withStrange.html), 1, 'the candidate is still offered');
  assert.ok(!withStrange.html.includes(' mcp add '), 'but no command is invented for it');
  assert.ok(
    withStrange.html.includes(NO_COMMAND_LINE),
    `it says so plainly instead:\n${withStrange.html}`,
  );
});

/* ===========================================================================
 * t459 — the two doors back into an interview already in flight: the board's
 * own card (`board.test.ts`) and the still-open list at the top of
 * `GET /interview`. Only the second half lives here.
 * ======================================================================== */

/**
 * The `data-interviews-open="N"` wrapper's own inner HTML.
 *
 * A plain `indexOf('</section>')` rather than `columnOf`'s depth counting:
 * nothing the wrapper ever draws (an empty-state paragraph, a run of
 * `<article>` cards, or a `<table>`) nests another `<section>`.
 */
function stillOpenBlock(html: string): { count: number; excerpt: string } {
  const opening = /<section data-interviews-open="(\d+)">/.exec(html);
  assert.ok(opening !== null, `the page has no data-interviews-open wrapper:\n${html}`);
  const start = opening.index + opening[0].length;
  const end = html.indexOf('</section>', start);
  assert.ok(end >= 0, `the data-interviews-open wrapper is never closed:\n${html}`);
  return { count: Number(opening[1]), excerpt: html.slice(start, end) };
}

/** `count` interviews, all still open, sharing one graph-version read. */
async function seedManyOpenInterviews(cp: RunningControlPlane, count: number): Promise<number[]> {
  const version = await mapDesignVersion(cp);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const created = await createJob(cp, {
      title: `interview #${index}`,
      body: 'a body, so the fixture is a real job',
      entry_node_id: 'interview',
      graph_version_id: version,
    });
    ids.push(created.id);
  }
  return ids;
}

test('t459 AT3 — with zero interviews open, GET /interview renders the empty wrapper, above the form', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const page = await openPage(screen, '/interview');
  assert.equal(page.status, 200);

  const block = stillOpenBlock(page.html);
  assert.equal(block.count, 0);
  assert.ok(!block.excerpt.includes('data-trabalho'), `an empty list must carry no card:\n${block.excerpt}`);
  assert.ok(
    /no interviews/i.test(block.excerpt),
    `an explicit empty-state line, not silence:\n${block.excerpt}`,
  );

  const wrapperIndex = page.html.indexOf('data-interviews-open=');
  const formIndex = page.html.indexOf('<form method="post" action="/interview">');
  assert.ok(wrapperIndex >= 0 && formIndex >= 0, 'both the wrapper and the form must be on the page');
  assert.ok(wrapperIndex < formIndex, 'the still-open list sits above the start form');

  assertSaysNothingForbidden(page.html, 'the interview start page with no interviews open');
});

test('t459 AT4 — the still-open list shows an open interview and excludes a finished one', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const openId = await seedOpenInterview(cp);
  const finishedId = await seedFinishedInterview(cp, closingDraft());

  const page = await openPage(screen, '/interview');
  const block = stillOpenBlock(page.html);

  assert.equal(block.count, 1);
  assert.ok(
    block.excerpt.includes(`href="/interview/${openId}"`),
    `the open interview is linked:\n${block.excerpt}`,
  );
  assert.ok(
    !new RegExp(`\\b${finishedId}\\b`).test(block.excerpt),
    `the finished interview's id must appear nowhere in the wrapper:\n${block.excerpt}`,
  );

  const wrapperIndex = page.html.indexOf('data-interviews-open=');
  const formIndex = page.html.indexOf('<form method="post" action="/interview">');
  assert.ok(wrapperIndex < formIndex, 'the still-open list sits above the start form');
});

test('t459 AT5 — an interview awaiting an answer carries class="attention" in the still-open list', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedHintedQuestion(cp);

  const page = await openPage(screen, '/interview');
  const block = stillOpenBlock(page.html);

  const card = blocks(block.excerpt, 'trabalho').find((one) => one.value === String(jobId));
  assert.ok(card !== undefined, `no card found for interview ${jobId}:\n${block.excerpt}`);
  assert.match(
    card.excerpt,
    /class="[^"]*\battention\b[^"]*"/,
    'an interview awaiting an answer must carry .attention',
  );
});

test('t459 AT6 — twelve open interviews render as cards, a thirteenth switches the list to a table', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const twelve = await seedManyOpenInterviews(cp, 12);

  const twelvePage = await openPage(screen, '/interview');
  const twelveBlock = stillOpenBlock(twelvePage.html);
  assert.equal(twelveBlock.count, 12);
  assert.ok(
    !twelveBlock.excerpt.includes('<table>'),
    `twelve open interviews must stay in card mode:\n${twelveBlock.excerpt}`,
  );

  const [thirteenth] = await seedManyOpenInterviews(cp, 1);
  const ids = [...twelve, thirteenth];

  const thirteenPage = await openPage(screen, '/interview');
  const thirteenBlock = stillOpenBlock(thirteenPage.html);
  assert.equal(thirteenBlock.count, 13);
  assert.ok(
    thirteenBlock.excerpt.includes('<table>'),
    `thirteen open interviews must switch to a table:\n${thirteenBlock.excerpt}`,
  );
  for (const id of ids) {
    assert.ok(
      thirteenBlock.excerpt.includes(`href="/interview/${id}"`),
      `interview ${id} is missing its row:\n${thirteenBlock.excerpt}`,
    );
  }
});

test('t459 AT7 — the forbidden-vocabulary sweep holds with the still-open list populated', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  await seedOpenInterview(cp);
  await seedHintedQuestion(cp);

  const page = await openPage(screen, '/interview');
  assertSaysNothingForbidden(page.html, 'the interview start page with the still-open list populated');
});

/* ================================================================ t465 */

/**
 * The conversation of an interview whose session is writing right now.
 *
 * Hand-written, like AT17's five shapes and for the same reason: `renderChat`
 * is pure, and what this ticket adds is a rendering decision, not a wiring one.
 */
function drafting(partial: string | null): ClientModule.Conversation {
  return { turns: [], pending: null, thinking: true, draft: null, partial, done: false };
}

/** The line the page has always shown while nothing was known about the wait. */
const PLACEHOLDER = 'Working on the next question';

test('t465 AT16 — a session that is writing shows what it wrote, not the placeholder', async () => {
  const { renderChat } = await loadInterview();

  const html = renderChat(
    drafting('Step 03 <needs> the checked proposal & the price table'),
    42,
  );

  assert.ok(html.includes('data-state="thinking"'), `it is still the thinking state:\n${html}`);
  assert.ok(
    html.includes('class="partial"'),
    `the arriving text has no class of its own to style or test apart:\n${html}`,
  );
  assert.ok(
    html.includes('Step 03 &lt;needs&gt; the checked proposal &amp; the price table'),
    `the text is not escaped, and D4 states that rule with no exception:\n${html}`,
  );
  assert.ok(
    !html.includes('<needs>'),
    `an agent's angle bracket reached the page as markup:\n${html}`,
  );
  assert.ok(
    !html.includes(PLACEHOLDER),
    `the placeholder is REPLACED by the content, never drawn beside it:\n${html}`,
  );
  assert.ok(!html.includes('style='), `nothing on this page carries an inline style:\n${html}`);
});

test('t465 AT17 — with nothing written yet the placeholder is exactly what it was', async () => {
  const { renderChat } = await loadInterview();

  for (const conversation of [drafting(null), drafting('   ')]) {
    const html = renderChat(conversation, 42);
    assert.ok(html.includes(PLACEHOLDER), `the placeholder is gone:\n${html}`);
    assert.ok(
      !html.includes('class="partial"'),
      `a blank draft is not content and draws no element:\n${html}`,
    );
  }
});

test('t465 AT18 — the vocabulary sweep holds over a conversation that is writing', async () => {
  const { renderChat } = await loadInterview();

  const html = renderChat(
    drafting('Drafting the third step of the map: what it needs and what it produces.'),
    42,
  ).toLowerCase();

  for (const word of FORBIDDEN) {
    assert.ok(!html.includes(word), `a conversation with a draft says "${word}":\n${html}`);
  }
});

test('t465 AT19 — the arriving text is ink and upright inside the muted placeholder box', async () => {
  requireArtifacts('src/public/style.css');
  const stylesheet = readFileSync(
    new URL('../src/public/style.css', import.meta.url),
    'utf8',
  );

  const rule = /\.interview\s+\.thinking\s+\.partial\s*\{([^}]*)\}/.exec(stylesheet);
  assert.ok(rule !== null, 'the stylesheet has no rule for the arriving text');
  const body = rule[1];

  assert.match(body, /color:\s*var\(--ink\)/, 'arriving content is ink, not the muted grade');
  assert.match(body, /font-style:\s*normal/, 'and upright: it is content, not a placeholder');
  assert.match(body, /white-space:\s*pre-wrap/, "the model's own line breaks have to survive");
  assert.ok(!/border-left/.test(body), 'the left-edge bar belongs to "waiting on you" alone (§8)');
  assert.ok(!/monospace/.test(body), 'this is prose, never something copied or typed (§4)');
});

/* ===========================================================================
 * t460 — the map in progress validates itself.
 *
 * The right column gains a second panel: what registering this draft right now
 * would still fail on, read live off `POST /v1/graphs/validate` and written by
 * the prose renderer the graph editor already uses for the identical report
 * (`public/graph-soundness.js`). The panel reports and never blocks — the
 * answer form, the register action and the export action are untouched by it,
 * which is what AT10 checks by rendering a draft full of problems and finding
 * the page still whole.
 *
 * Three of the six cases below are pure (the renderer, fed hand-written
 * reports), two are end to end against a real control plane, and the last one
 * drives the island against `fake-dom.ts` — the same split t433 already made
 * for the same three surfaces.
 * ======================================================================== */

async function loadClient(): Promise<typeof ClientModule> {
  requireArtifacts('src/client.ts');
  return (await import(new URL('../src/client.ts', import.meta.url).href)) as typeof ClientModule;
}

interface SoundnessModule {
  NO_PROBLEMS_LINE: string;
  renderReport: (report: unknown) => string[];
}

async function loadSoundness(): Promise<SoundnessModule> {
  requireArtifacts('src/public/graph-soundness.js');
  return (await import(
    new URL('../src/public/graph-soundness.js', import.meta.url).href
  )) as SoundnessModule;
}

/** A report the control plane would answer for a draft with nothing wrong. */
const CLEAN_REPORT = {
  valid: true,
  structure: { valid: true, errors: [] },
  soundness: { valid: true, violations: [] },
};

/**
 * The draft of job 5, in miniature: a step whose single exit never got a label.
 *
 * `condition: null` and not `""` — that is the shape an interview leaves behind
 * when it never asks, and the one this whole ticket exists for.
 */
function draftWithUnlabelledEdge(): RegisterMapModule.MapDraft {
  const draft = closingDraft();
  const edges = draft.graph.edges as Array<Record<string, unknown>>;
  edges[0].condition = null;
  return draft;
}

/** How many times one needle appears — the panel's line count, by its class. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ================================================================= AT6 */

test('t460 AT6 — a report with violations renders one escaped line per problem', async () => {
  const { renderMapProgress } = await loadInterview();
  const { renderReport, NO_PROBLEMS_LINE } = await loadSoundness();
  const { escapeHtml } = await loadPages();

  const report = {
    valid: false,
    structure: { valid: true, errors: [] },
    soundness: {
      valid: false,
      violations: [
        { rule: 'edge_with_condition', target: { from: 'triage', to: 'review' } },
        // A step id nobody would type, and exactly the reason every line is
        // escaped: the ids in a report came out of an agent's draft.
        { rule: 'reachable', target: '<script>alert(1)</script>' },
      ],
    },
  };

  const lines = renderReport(report);
  assert.equal(lines.length, 2, 'the renderer writes one line per violation');

  const html = renderMapProgress(report);
  for (const line of lines) {
    assert.notEqual(line, NO_PROBLEMS_LINE, 'a report with violations is not the empty line');
    assert.ok(
      !line.startsWith('unknown soundness rule'),
      `the renderer fell back instead of naming the rule: ${line}`,
    );
    assert.ok(html.includes(escapeHtml(line)), `the panel is missing "${line}":\n${html}`);
  }

  assert.equal(occurrences(html, 'class="problem"'), 2, `one element per problem:\n${html}`);
  assert.ok(!html.includes('<script>'), `the target arrives as text, never as markup:\n${html}`);
});

/* ================================================================= AT7 */

test('t460 AT7 — a report with nothing wrong renders the renderer\'s own empty line', async () => {
  const { renderMapProgress } = await loadInterview();
  const { NO_PROBLEMS_LINE } = await loadSoundness();
  const { escapeHtml } = await loadPages();

  const html = renderMapProgress(CLEAN_REPORT);

  assert.ok(html.includes(escapeHtml(NO_PROBLEMS_LINE)), `the panel says so:\n${html}`);
  assert.equal(occurrences(html, 'class="problem"'), 1, `and says it once:\n${html}`);
});

/* ================================================================= AT8 */

test('t460 AT8 — with no draft to judge, the panel renders nothing at all', async () => {
  const { renderMapProgress } = await loadInterview();

  assert.equal(renderMapProgress(undefined), '');
});

/* ================================================================= AT9 */

test('t460 AT9 — the fragment carries the panel the validation route answers for the draft', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const { renderMapProgress } = await loadInterview();
  const { ApiClient } = await loadClient();

  const draft = draftWithUnlabelledEdge();
  const jobId = await seedOpenInterview(cp);
  await reportFrom(cp, jobId, 'interview', { done: false, ...draft });

  const fragment = await fetch(`${screen.url}/interview/${jobId}/fragment`);
  assert.equal(fragment.status, 200);
  const body = (await fragment.json()) as { progress: string };

  // The same question the screen asked, asked again from the test's own client:
  // whatever the route answers for this draft is what the panel has to be.
  const report = await new ApiClient({ baseUrl: cp.url, token: cp.token }).validateGraphDocument(
    draft.graph,
  );
  assert.equal(body.progress, renderMapProgress(report));
  assert.ok(
    body.progress.includes('has no condition'),
    `the unlabelled exit is named:\n${body.progress}`,
  );
});

/* ================================================================ AT10 */

test('t460 AT10 — the page and the poll draw the same panel, behind the same id', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, { job_id: jobId, question: 'What do you call it?' });
  await reportFrom(cp, jobId, 'interview', { done: false, ...draftWithUnlabelledEdge() });

  const page = await openPage(screen, `/interview/${jobId}`);
  assert.equal(page.status, 200);
  const fragment = await fetch(`${screen.url}/interview/${jobId}/fragment`);
  const body = (await fragment.json()) as { chat: string; map: string; progress: string };

  const panel = columnOf(page.html, 'map-progress');
  assert.notEqual(panel.trim(), '', 'a draft with a problem draws a panel');
  assert.equal(body.progress, panel, 'the page and the poll cannot come to say different things');
  assert.equal(body.map, columnOf(page.html, 'map'), 'and the map column still agrees too');

  // It reports and never blocks: everything a person can still do is still there.
  const chat = columnOf(page.html, 'chat');
  assert.ok(chat.includes(`action="/interview/${jobId}/answer"`), 'the answer form is untouched');
  assertSaysNothingForbidden(page.html, 'an interview whose draft is still incomplete');
});

/* ================================================================ AT11 */

test('t460 AT11 — the island swaps the panel from the payload on every poll', async () => {
  requireArtifacts('src/public/interview.js');
  const { mount } = (await import(
    new URL('../src/public/interview.js', import.meta.url).href
  )) as {
    mount: (
      doc: FakeDocument,
      request: (url: string) => Promise<Response>,
      jobId: number,
      schedule?: (fn: () => void, ms: number) => void,
    ) => { tick: () => Promise<void> };
  };

  const doc = new FakeDocument(['chat', 'map', 'map-progress']);
  const schedule = (): void => {};

  const answers = [
    {
      chat: '<p>asking</p>',
      map: '<ol></ol>',
      progress: '<div class="problems"><p class="problem">first</p></div>',
      done: false,
    },
    {
      chat: '<p>asking</p>',
      map: '<ol></ol>',
      progress: '<div class="problems"><p class="problem">second</p></div>',
      done: false,
    },
  ];
  let calls = 0;
  const request = async (): Promise<Response> => {
    const answer = answers[Math.min(calls, answers.length - 1)];
    calls += 1;
    return new Response(JSON.stringify(answer), {
      headers: { 'content-type': 'application/json' },
    });
  };

  const island = mount(doc, request, 42, schedule);

  await island.tick();
  assert.equal(doc.require('map-progress').innerHTML, answers[0].progress, 'the first poll swapped it');

  await island.tick();
  assert.equal(
    doc.require('map-progress').innerHTML,
    answers[1].progress,
    'and so does every poll after it',
  );
});

/* ================================================================================
 * t481 — a step's worth of decisions, asked as one form
 *
 * `input_request.options` carries either the flat list of one-click labels it
 * was born with, or the fields of a whole step (t480). Everything below is the
 * SECOND shape on the page, plus the one thing that is true of both: the
 * recommendation is read before the situation (§7.5).
 *
 * End to end against a real control plane, like AT5 above and for the same
 * reason: the batched shape has to survive the API that stores it, the
 * projection that reads it back and the renderer, and a hand-written fixture
 * would only prove the last of the three.
 * ============================================================================= */

/** The three controls, one of each kind, as a step of the interview asks them. */
const BATCHED_FIELDS = [
  {
    id: 'name',
    label: 'What do you call this class of problem?',
    kind: 'choice',
    options: ['widget-triage', 'widget-review'],
    recommended: 'widget-triage',
  },
  {
    id: 'arrivals',
    label: 'Where does the work arrive from?',
    kind: 'multi',
    options: ['a shared mailbox', 'a form', 'a spreadsheet'],
    recommended: ['a form'],
  },
  {
    id: 'anything_else',
    label: 'Anything else worth writing down?',
    kind: 'free_text',
    recommended: 'nothing yet',
  },
];

const BATCHED_QUESTION = {
  question: 'Four things about this step, all at once',
  context: 'The name is the address every later map is filed under.',
  options: BATCHED_FIELDS,
  recommendation: 'Take what is already pre-filled: it is what you said out loud.',
};

/**
 * The markup of each field of a batched form, by the id it answers under.
 *
 * Sliced on the `data-field` markers rather than parsed: a field is drawn as a
 * `<fieldset>` when it has options and as something else when it has none, and
 * a test that demanded one element name would be pinning the implementation
 * instead of the contract.
 */
function fieldBlocks(html: string): Map<string, string> {
  const marker = /<[a-z]+[^>]*\sdata-field="([^"]+)"/g;
  const found = [...html.matchAll(marker)];
  const blocks = new Map<string, string>();
  found.forEach((match, index) => {
    const end = index + 1 < found.length ? found[index + 1].index : html.length;
    blocks.set(match[1], html.slice(match.index, end));
  });
  return blocks;
}

/** Every `<label>` of a fragment, as `{for, text}`. */
function labelsOf(fragment: string): { target: string | null; text: string }[] {
  return [...fragment.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)].map((match) => ({
    target: /\sfor="([^"]*)"/.exec(match[1])?.[1] ?? null,
    text: match[2].replaceAll(/<[^>]*>/g, ' ').replaceAll(/\s+/g, ' ').trim(),
  }));
}

/** The opening tag of every `<input>` of a fragment. */
function inputsOf(fragment: string): string[] {
  return [...fragment.matchAll(/<input\b[^>]*>/g)].map((match) => match[0]);
}

/** The one input of a fragment carrying `value="…"`, or `undefined`. */
function inputWithValue(fragment: string, value: string): string | undefined {
  return inputsOf(fragment).find((tag) => new RegExp(`\\svalue="${value}"`).test(tag));
}

/** Opens an interview whose one open question asks a whole step at once. */
async function seedBatchedInterview(cp: RunningControlPlane): Promise<number> {
  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, { job_id: jobId, ...BATCHED_QUESTION });
  return jobId;
}

/* ================================================================= AT1 */

test('t481 AT1 — a batched question draws one control per field, each with a visible name', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedBatchedInterview(cp);

  const page = await openPage(screen, `/interview/${jobId}`);
  assert.equal(page.status, 200);
  const chat = columnOf(page.html, 'chat');

  assert.ok(
    chat.includes(`action="/interview/${jobId}/answer"`),
    `the form still answers this interview:\n${chat}`,
  );

  const blocks = fieldBlocks(chat);
  assert.deepEqual([...blocks.keys()], ['name', 'arrivals', 'anything_else'], 'one block per field');

  // choice — a radio group behind a <legend>, one radio per offered option.
  const choice = blocks.get('name') ?? '';
  assert.ok(
    new RegExp(`<legend[^>]*>[^<]*${BATCHED_FIELDS[0].label}`).test(choice),
    `the choice field is named by its own <legend>:\n${choice}`,
  );
  for (const option of BATCHED_FIELDS[0].options ?? []) {
    const tag = inputWithValue(choice, option);
    assert.ok(tag !== undefined, `there is a control for "${option}":\n${choice}`);
    assert.ok(/type="radio"/.test(tag), `"${option}" is a radio: ${tag}`);
    assert.ok(
      labelsOf(choice).some((label) => label.text.includes(option)),
      `a visible <label> reads "${option}":\n${choice}`,
    );
  }
  const groups = new Set(
    inputsOf(choice)
      .filter((tag) => /type="radio"/.test(tag))
      .map((tag) => /\sname="([^"]*)"/.exec(tag)?.[1] ?? ''),
  );
  assert.equal(groups.size, 1, 'every radio of one field is in the same group');

  // multi — the same, as checkboxes.
  const multi = blocks.get('arrivals') ?? '';
  assert.ok(
    new RegExp(`<legend[^>]*>[^<]*${BATCHED_FIELDS[1].label}`).test(multi),
    `the multi field is named by its own <legend>:\n${multi}`,
  );
  for (const option of BATCHED_FIELDS[1].options ?? []) {
    const tag = inputWithValue(multi, option);
    assert.ok(tag !== undefined, `there is a control for "${option}":\n${multi}`);
    assert.ok(/type="checkbox"/.test(tag), `"${option}" is a checkbox: ${tag}`);
  }

  // free_text — a textarea behind a <label> tied by for/id.
  const free = blocks.get('anything_else') ?? '';
  const textarea = /<textarea[^>]*id="([^"]+)"/.exec(free);
  assert.ok(textarea !== null, `the free-text field is a <textarea>:\n${free}`);
  assert.ok(
    labelsOf(free).some(
      (label) => label.target === textarea[1] && label.text.includes(BATCHED_FIELDS[2].label),
    ),
    `a visible <label for="${textarea[1]}"> names it:\n${free}`,
  );

  // Nothing of the legacy shape is drawn beside it.
  assert.ok(!/data-option="/.test(chat), `a batched question draws no one-click buttons:\n${chat}`);
});

/* ================================================================= AT2 */

test('t481 AT2 — what the agent would take is pre-selected and says so, in text', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedBatchedInterview(cp);

  const chat = columnOf((await openPage(screen, `/interview/${jobId}`)).html, 'chat');
  const blocks = fieldBlocks(chat);

  const choice = blocks.get('name') ?? '';
  const chosen = inputWithValue(choice, 'widget-triage');
  assert.ok(chosen !== undefined && /\schecked\b/.test(chosen), `the recommended radio is checked: ${chosen}`);
  assert.ok(
    inputWithValue(choice, 'widget-review')?.includes('checked') !== true,
    'and it is the only one',
  );
  assert.ok(
    labelsOf(choice).some(
      (label) => label.text.includes('widget-triage') && label.text.includes('(recommended)'),
    ),
    `the recommended option says so in its own label:\n${choice}`,
  );

  const multi = blocks.get('arrivals') ?? '';
  const ticked = inputWithValue(multi, 'a form');
  assert.ok(ticked !== undefined && /\schecked\b/.test(ticked), `the recommended box is ticked: ${ticked}`);
  assert.ok(
    inputWithValue(multi, 'a spreadsheet')?.includes('checked') !== true,
    'and the others are not',
  );

  const free = blocks.get('anything_else') ?? '';
  assert.ok(
    /<textarea[^>]*>nothing yet<\/textarea>/.test(free),
    `the free-text field opens on what would be written:\n${free}`,
  );
});

/* ================================================================= AT3 */

test('t481 AT3 — a field with options can also be answered outside them', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedBatchedInterview(cp);

  const chat = columnOf((await openPage(screen, `/interview/${jobId}`)).html, 'chat');
  const blocks = fieldBlocks(chat);

  for (const id of ['name', 'arrivals']) {
    const block = blocks.get(id) ?? '';
    const other = inputsOf(block).find((tag) => /data-other\b/.test(tag));
    assert.ok(other !== undefined, `"${id}" offers something outside the list:\n${block}`);
    assert.ok(
      /type="(radio|checkbox)"/.test(other),
      `the escape hatch is paired with the group: ${other}`,
    );
    const typed = inputsOf(block).find((tag) => /type="text"/.test(tag));
    assert.ok(typed !== undefined, `"${id}" has a box to write it in:\n${block}`);
    const id_ = /\sid="([^"]+)"/.exec(typed)?.[1] ?? '';
    assert.ok(
      labelsOf(block).some((label) => label.target === id_ && label.text !== ''),
      `a visible <label for="${id_}"> names the box:\n${block}`,
    );
  }

  const free = blocks.get('anything_else') ?? '';
  assert.equal(
    inputsOf(free).filter((tag) => /type="text"/.test(tag)).length,
    0,
    `free text needs no escape hatch of its own:\n${free}`,
  );
});

/* ================================================================= AT4 */

test('t481 AT4 — the recommendation is read before the situation, on both shapes', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const legacyId = await seedOpenInterview(cp);
  await createQuestion(cp, {
    job_id: legacyId,
    question: 'What do you call this class of problem?',
    context: 'The name is the address every later map is filed under.',
    options: ['widget-triage', 'widget-review'],
    recommendation: 'Take widget-triage: it is what you already call it out loud.',
    default_answer: 'widget-triage',
  });
  const legacy = columnOf((await openPage(screen, `/interview/${legacyId}`)).html, 'chat');
  assert.ok(
    legacy.indexOf('what I would take') < legacy.indexOf('why it matters'),
    `§7.5: the recommendation comes first:\n${legacy}`,
  );
  assert.ok(legacy.includes('if you just accept'), 'and the accept line still renders');

  const batchedId = await seedBatchedInterview(cp);
  const batched = columnOf((await openPage(screen, `/interview/${batchedId}`)).html, 'chat');
  assert.ok(
    batched.indexOf('what I would take') < batched.indexOf('why it matters'),
    `§7.5 holds for a batched question too:\n${batched}`,
  );
  assert.ok(
    !batched.includes('if you just accept'),
    `a batched question shows each field's own recommendation instead:\n${batched}`,
  );
});

/* ================================================================= AT5 */

test('t481 AT5 — a question with a flat list of labels renders exactly as it did', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedOpenInterview(cp);
  await createQuestion(cp, {
    job_id: jobId,
    question: 'What do you call this class of problem?',
    options: ['widget-triage', 'widget-review'],
    default_answer: 'widget-triage',
  });

  const chat = columnOf((await openPage(screen, `/interview/${jobId}`)).html, 'chat');

  for (const option of ['widget-triage', 'widget-review']) {
    assert.ok(
      new RegExp(`<button[^>]*data-option="${option}"`).test(chat),
      `the one-click button for "${option}" is untouched:\n${chat}`,
    );
  }
  assert.equal(
    [...chat.matchAll(/<textarea\b/g)].length,
    1,
    `one shared answer field, as before:\n${chat}`,
  );
  assert.ok(/<textarea[^>]*name="answer"/.test(chat), 'posted under the same one name');
  assert.equal(fieldBlocks(chat).size, 0, `and nothing of the batched shape:\n${chat}`);
});

/* ================================================================= AT6 */

test('t481 AT6 — the forbidden vocabulary holds over a batched question', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const jobId = await seedBatchedInterview(cp);

  const page = await openPage(screen, `/interview/${jobId}`);
  assertSaysNothingForbidden(page.html, 'a batched question');
});

/* ================================================================= AT7 */

test('t481 AT7 — the batched form says it needs a script; the legacy one does not', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const batchedId = await seedBatchedInterview(cp);
  const batched = columnOf((await openPage(screen, `/interview/${batchedId}`)).html, 'chat');
  const notice = /<noscript>([\s\S]*?)<\/noscript>/.exec(batched);
  assert.ok(notice !== null, `a batched form declares what it needs:\n${batched}`);
  assert.ok(/\S/.test(notice[1].replaceAll(/<[^>]*>/g, '')), 'and the notice says something');

  // The document the script assembles is posted under the one field the route
  // already reads, so nothing about the write changes.
  assert.ok(
    /<input[^>]*type="hidden"[^>]*name="answer"/.test(batched) ||
      /<input[^>]*name="answer"[^>]*type="hidden"/.test(batched),
    `the assembled answer travels on the same field:\n${batched}`,
  );

  const legacyId = await seedOpenInterview(cp);
  await createQuestion(cp, { job_id: legacyId, question: 'What do you call it?' });
  const legacy = columnOf((await openPage(screen, `/interview/${legacyId}`)).html, 'chat');
  assert.ok(
    !legacy.includes('<noscript>'),
    `a question that works without a script claims nothing:\n${legacy}`,
  );
});
