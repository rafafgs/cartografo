/**
 * `cartografo interview` — the conversation in the terminal, drawing the map
 * beside it (t546, D26).
 *
 * The screen's interview page is a job on the `map-design` class plus the
 * questions it raises, read back through ONE projection, `GET
 * /v1/jobs/:id/conversation` (`docs/spec/interview.md` §3). This REPL is a
 * second consumer of that projection and of nothing underneath it: it reads
 * `pending`, `draft` and `done`, answers through the same answer route the page
 * uses, and never reasons about sessions or dispatches. The recorded plan B of
 * `interview.md` §1 would change nothing here, for the same reason it would
 * change nothing on the page.
 *
 * ## Resuming needs no local state
 *
 * Everything an interview is lives on the server: the exchange so far, the map
 * so far, whether it is done. The loop only moves past a question once the
 * answer's write has come back `200`, so an answer is either recorded or was
 * never sent — there is no "typed but lost". `--resume <id>` therefore skips
 * the start form and enters the same loop.
 *
 * ## Waiting is a push that wakes a re-read, never the new state itself
 *
 * Between questions the loop subscribes to the event stream through
 * `watch.ts`'s own `watchEvents` — the same decode, reconnect and backoff — and
 * the first envelope about this interview only means "read the projection
 * again". A cursor is kept across waits, starting from this interview's own
 * latest event, so nothing that lands between a read and the next subscription
 * can be missed.
 *
 * The wake filter is wider than `watch --job`'s on purpose: `session.finished`
 * and the two answer types carry no `job_id` (`specs/events/taxonomy.md`), and
 * a session finishing is exactly the moment an interview becomes done. Those
 * three types wake the loop whatever they are about; a stray re-read costs one
 * request, a missed one would cost the interview.
 *
 * ## Vocabulary
 *
 * A person having a conversation reads *interview*, *map*, *step*, *question*
 * and *answer* — never the three platform words the page also avoids
 * (`docs/spec/screen-interview.md` §2). The server's own refusal messages are
 * therefore not forwarded verbatim where they could name those things; the
 * error code is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { ID_PATTERN, manifestHash } from '../domain/manifest.ts';
import { isObject } from '../util/is-object.ts';
import {
  renderMapText,
  renderStepProgressText,
  stripControlCharacters,
  type MapDocumentGraph,
  type MapDocumentManifest,
} from './map-document.ts';
import { UsageError, requestJson } from './url.ts';
import { StreamDeniedError, watchEvents, type EventEnvelope } from './watch.ts';

/** The class every interview runs on, and the node it enters at. */
const INTERVIEW_CLASS = 'map-design';
const INTERVIEW_ENTRY_NODE = 'interview';

/** What the map says while the interview has drawn nothing yet. */
const NOTHING_TO_DRAW = 'nothing to draw yet';

/** The hint at `next> ` for anything it does not understand. */
const NEXT_HINT = 'type register, export <dir>, or press Enter to leave it as a draft';

/** Event types that carry no `job_id` and still mean "look again". */
const UNATTRIBUTED_WAKERS: ReadonlySet<string> = new Set([
  'session.finished',
  'input_request.answered',
  'input_request.auto_resolved',
]);

/** Options of `interview`, as the router hands them over. */
export interface InterviewOptions {
  url: string;
  token?: string;
  projectId: number;
  /** An existing interview to pick up again. */
  resumeId?: number;
  /** A file of lines to read instead of the terminal. */
  answersPath?: string;
  /** Who answers; defaults to the OS user. */
  by?: string;
}

/** One field of a question asked as a form (t480). */
interface Field {
  id: string;
  label: string;
  kind: string;
  options?: string[];
  recommended?: string | string[];
}

/** The open question, as the projection spells it. */
interface PendingQuestion {
  id: number;
  question: string;
  context: string | null;
  recommendation: string | null;
  options: string[] | Field[] | null;
  default: string | null;
}

/** The projection, in the part this REPL reads. */
interface Conversation {
  pending: PendingQuestion | null;
  draft: unknown;
  done: boolean;
}

/** The input ran out before the interview reached a place it can stop. */
class OutOfLines extends Error {}

/** The control plane refused something, and the message has already been printed. */
class Refused extends Error {}

/** Where lines come from: the terminal, or an `--answers` file. */
interface LineSource {
  /** Prints the prompt and reads one line; `null` at the end of the input. */
  read(prompt: string): Promise<string | null>;
  close(): void;
  scripted: boolean;
}

/**
 * `--answers <file>`: one line per read, trailing blank lines dropped. Each
 * line is echoed after its prompt, so the transcript reads like a typed one.
 *
 * @throws {UsageError} When the file cannot be read — a wrong command line.
 */
function answersSource(filePath: string): LineSource {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new UsageError(`--answers: could not read "${filePath}"`);
  }
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  return {
    scripted: true,
    read: async (prompt) => {
      process.stdout.write(prompt);
      const line = lines.shift();
      if (line === undefined) {
        process.stdout.write('\n');
        return null;
      }
      process.stdout.write(`${line}\n`);
      return line;
    },
    close: () => undefined,
  };
}

/** The terminal: lines typed ahead of a prompt are kept, in order. */
function stdinSource(): LineSource {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  const buffered: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;

  reader.on('line', (line) => {
    const next = waiting.shift();
    if (next === undefined) buffered.push(line);
    else next(line);
  });
  reader.on('close', () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });

  return {
    scripted: false,
    read: async (prompt) => {
      reader.setPrompt(prompt);
      reader.prompt(true);
      const line = buffered.shift();
      if (line !== undefined) return line;
      if (ended) return null;
      return await new Promise((resolve) => waiting.push(resolve));
    },
    close: () => {
      reader.close();
      process.stdin.unref?.();
    },
  };
}

/** `--by`, else the OS user, else the literal `operator`. */
function resolveOperatorName(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  try {
    const { username } = os.userInfo();
    if (username !== '') return username;
  } catch {
    // No passwd entry for this uid.
  }
  return 'operator';
}

/** Prints a line of content that did not come from this file. */
function say(text: string): void {
  process.stdout.write(`${stripControlCharacters(text)}\n`);
}

/** The refusal's error code, for a line that must not forward the server's own prose. */
function errorCode(body: unknown): string {
  return isObject(body) && typeof body.error === 'string' ? ` — ${stripControlCharacters(body.error)}` : '';
}

/** Reads a line nobody may leave blank. */
async function readRequired(source: LineSource, prompt: string, what: string): Promise<string> {
  for (;;) {
    const line = await source.read(prompt);
    if (line === null) throw new OutOfLines();
    if (line.trim() !== '') return line.trim();
    process.stderr.write(`cartografo: ${what} is required\n`);
  }
}

/** Starts a fresh interview from its two fields; returns its id. */
async function startInterview(options: InterviewOptions, source: LineSource): Promise<number> {
  const title = await readRequired(source, 'title> ', 'a title');
  const description = await readRequired(source, 'description> ', 'a description');

  const lineage = await requestJson(`${options.url}/v1/graphs/${INTERVIEW_CLASS}?project_id=${options.projectId}`);
  const graph = isObject(lineage.body) && isObject(lineage.body.graph) ? lineage.body.graph : {};
  if (lineage.status === 404 || (lineage.status === 200 && typeof graph.current_version_id !== 'string')) {
    process.stderr.write(
      'cartografo: this control plane has no interview to start — it is imported at the first startup, and the reason it is missing was printed on the control plane\'s own startup log\n',
    );
    throw new Refused();
  }
  if (lineage.status !== 200) {
    process.stderr.write(`cartografo: could not read the interview map (HTTP ${lineage.status})${errorCode(lineage.body)}\n`);
    throw new Refused();
  }

  const created = await requestJson(`${options.url}/v1/jobs?project_id=${options.projectId}`, {
    method: 'POST',
    body: {
      title,
      body: description,
      entry_node_id: INTERVIEW_ENTRY_NODE,
      graph_version_id: graph.current_version_id,
      project_id: options.projectId,
    },
  });
  const body = isObject(created.body) ? created.body : {};
  if (created.status !== 201 || typeof body.id !== 'number') {
    process.stderr.write(`cartografo: the interview could not be started (HTTP ${created.status})${errorCode(created.body)}\n`);
    throw new Refused();
  }

  process.stdout.write(`interview #${body.id} started — pick it up again with: cartografo interview --resume ${body.id}\n`);
  return body.id;
}

/** Checks that `--resume <id>` names an interview of this project. */
async function resumeInterview(options: InterviewOptions, id: number): Promise<number> {
  const response = await requestJson(`${options.url}/v1/jobs/${id}?project_id=${options.projectId}`);
  if (response.status === 404) {
    process.stderr.write(`cartografo: no interview #${id}\n`);
    throw new Refused();
  }
  const body = isObject(response.body) ? response.body : {};
  if (response.status !== 200) {
    process.stderr.write(`cartografo: could not read interview #${id} (HTTP ${response.status})${errorCode(response.body)}\n`);
    throw new Refused();
  }
  if (body.entry_node_id !== INTERVIEW_ENTRY_NODE) {
    process.stderr.write(`cartografo: #${id} is not an interview\n`);
    throw new Refused();
  }
  process.stdout.write(`interview #${id} resumed\n`);
  return id;
}

async function readConversation(options: InterviewOptions, id: number): Promise<Conversation> {
  const response = await requestJson(`${options.url}/v1/jobs/${id}/conversation?project_id=${options.projectId}`);
  if (response.status !== 200 || !isObject(response.body)) {
    process.stderr.write(`cartografo: could not read interview #${id} (HTTP ${response.status})${errorCode(response.body)}\n`);
    throw new Refused();
  }
  const body = response.body;
  return {
    pending: isObject(body.pending) ? (body.pending as unknown as PendingQuestion) : null,
    draft: body.draft ?? null,
    done: body.done === true,
  };
}

/** The id of this interview's latest event — where the first wait starts from. */
async function latestEventId(options: InterviewOptions, id: number): Promise<number> {
  const response = await requestJson(`${options.url}/v1/jobs/${id}/events?project_id=${options.projectId}`);
  const body = isObject(response.body) ? response.body : {};
  const events = Array.isArray(body.events) ? body.events : [];
  return events.reduce<number>(
    (highest, event) => (isObject(event) && typeof event.id === 'number' && event.id > highest ? event.id : highest),
    0,
  );
}

/** Whether an envelope is worth re-reading the projection for. */
function wakes(envelope: EventEnvelope, id: number): boolean {
  if (envelope.entity.type === 'job' && envelope.entity.id === id) return true;
  if (envelope.data.job_id === id) return true;
  return UNATTRIBUTED_WAKERS.has(envelope.type);
}

/**
 * Waits for the next event about this interview, past `cursor`, then closes
 * the connection.
 *
 * @returns The cursor to wait from next time.
 */
async function waitForChange(options: InterviewOptions, id: number, cursor: number): Promise<number> {
  const controller = new AbortController();
  let last = cursor;
  try {
    for await (const envelope of watchEvents({
      url: options.url,
      token: options.token,
      projectId: options.projectId,
      since: cursor,
      fromStart: false,
      json: false,
      untilDone: false,
      signal: controller.signal,
    })) {
      last = envelope.id;
      if (wakes(envelope, id)) break;
    }
  } finally {
    controller.abort();
  }
  return last;
}

/** The draft as a drawable map, or `undefined`. */
function drawable(draft: unknown): { graph: MapDocumentGraph; skills?: MapDocumentManifest[] } | undefined {
  if (!isObject(draft) || !isObject(draft.graph) || !Array.isArray(draft.graph.nodes)) return undefined;
  return {
    graph: draft.graph as unknown as MapDocumentGraph,
    skills: Array.isArray(draft.skills) ? (draft.skills as MapDocumentManifest[]) : undefined,
  };
}

function printMap(draft: unknown): void {
  const map = drawable(draft);
  process.stdout.write('\n--- the map ---\n');
  if (map === undefined) {
    process.stdout.write(`${NOTHING_TO_DRAW}\n`);
  } else {
    process.stdout.write(`${renderStepProgressText(map.graph)}\n\n`);
    process.stdout.write(`${renderMapText(map.graph, map.skills)}\n`);
  }
  process.stdout.write('---\n');
}

/** Is this a list of fields rather than a list of labels? (`packages/screen/src/interview.ts`'s own rule) */
function isFieldList(options: string[] | Field[] | null): options is Field[] {
  return (
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Field).id === 'string' &&
        typeof (item as Field).label === 'string' &&
        typeof (item as Field).kind === 'string',
    )
  );
}

function printQuestionHead(pending: PendingQuestion): void {
  process.stdout.write('\n');
  say(`question: ${pending.question}`);
  if (typeof pending.context === 'string' && pending.context.trim() !== '') say(pending.context);
  if (typeof pending.recommendation === 'string' && pending.recommendation.trim() !== '') {
    say(`recommendation: ${pending.recommendation}`);
  }
}

/** A plain decision: numbered options, a number or text, Enter for the default. */
async function askDecision(pending: PendingQuestion, source: LineSource): Promise<string> {
  printQuestionHead(pending);
  const options = Array.isArray(pending.options)
    ? pending.options.filter((option): option is string => typeof option === 'string')
    : [];
  options.forEach((option, index) => say(`  ${index + 1}) ${option}`));

  for (;;) {
    const line = await source.read('answer> ');
    if (line === null) throw new OutOfLines();
    const typed = line.trim();
    if (/^[0-9]+$/.test(typed)) {
      const index = Number(typed);
      if (index >= 1 && index <= options.length) return options[index - 1];
    }
    if (typed !== '') return typed;
    if (typeof pending.default === 'string') return pending.default;
    process.stderr.write('cartografo: an answer is required\n');
  }
}

/** Picks an offered option by number, or keeps the text. */
function pick(text: string, options: string[]): string {
  if (/^[0-9]+$/.test(text)) {
    const index = Number(text);
    if (index >= 1 && index <= options.length) return options[index - 1];
  }
  return text;
}

/**
 * A step form: every field in order, one prompt each, assembled into ONE
 * document. A `multi` is answered as a comma-separated list and sent as an
 * array — the shape the page's own form sends.
 */
async function askForm(pending: PendingQuestion, fields: Field[], source: LineSource): Promise<string> {
  printQuestionHead(pending);
  const document: Record<string, string | string[]> = {};

  for (const [index, field] of fields.entries()) {
    const offered = Array.isArray(field.options) ? field.options.filter((option) => typeof option === 'string') : [];
    const recommended =
      typeof field.recommended === 'string'
        ? [field.recommended]
        : Array.isArray(field.recommended)
          ? field.recommended.filter((value) => typeof value === 'string')
          : [];

    say(`field ${index + 1}/${fields.length}: ${field.label} (${field.kind})`);
    if (offered.length > 0) say(`  options: ${offered.join(', ')}`);
    if (recommended.length > 0) say(`  recommended: ${recommended.join(', ')}`);

    for (;;) {
      const line = await source.read(`${stripControlCharacters(field.id)}> `);
      if (line === null) throw new OutOfLines();
      const typed = line.trim();

      if (field.kind === 'multi') {
        const values = typed === '' ? recommended : typed.split(',').map((part) => pick(part.trim(), offered)).filter((part) => part !== '');
        if (values.length > 0) {
          document[field.id] = values;
          break;
        }
      } else if (typed !== '') {
        document[field.id] = field.kind === 'choice' ? pick(typed, offered) : typed;
        break;
      } else if (recommended.length > 0) {
        document[field.id] = recommended[0];
        break;
      }
      process.stderr.write('cartografo: an answer is required\n');
    }
  }

  return JSON.stringify(document);
}

/** Sends one answer; a refusal ends the REPL, never a silent retry. */
async function sendAnswer(options: InterviewOptions, pending: PendingQuestion, answer: string): Promise<void> {
  const response = await requestJson(
    `${options.url}/v1/input-requests/${pending.id}/answer?project_id=${options.projectId}`,
    { method: 'PATCH', body: { answer, answered_by: resolveOperatorName(options.by) } },
  );
  if (response.status === 200) return;
  if (response.status === 409) {
    process.stderr.write('cartografo: this question was already answered somewhere else (HTTP 409) — nothing was sent twice\n');
  } else {
    process.stderr.write(`cartografo: the answer was refused (HTTP ${response.status})${errorCode(response.body)}\n`);
  }
  throw new Refused();
}

/* ------------------------------------------------------------ closing the pins */

type Manifest = Record<string, unknown> & { id: string; version: string };

type Closed =
  | { ok: true; graph: Record<string, unknown>; manifests: (Manifest & { hash: string })[] }
  | { ok: false; problems: { code: string; message: string }[] };

/**
 * Computes every manifest's pin and writes it into the node that names it —
 * `register-map.ts`'s `fillSkillRefs`, on the canonical `manifestHash`. Never
 * mutates the draft; every node is checked before anything is decided.
 */
function closePins(draft: unknown): Closed {
  const map = isObject(draft) && isObject(draft.graph) ? draft : undefined;
  if (map === undefined) {
    return { ok: false, problems: [{ code: 'no_map', message: 'the interview drew no map' }] };
  }
  const graph = map.graph as Record<string, unknown>;
  const problems: { code: string; message: string }[] = [];
  const manifests: (Manifest & { hash: string })[] = [];
  const byId = new Map<string, Manifest & { hash: string }>();

  for (const candidate of Array.isArray(map.skills) ? map.skills : []) {
    if (!isObject(candidate) || typeof candidate.id !== 'string' || !ID_PATTERN.test(candidate.id)) {
      problems.push({ code: 'invalid_manifest_id', message: `a manifest of the draft has no kebab-case id` });
      continue;
    }
    const manifest = { ...candidate, hash: manifestHash(candidate) } as Manifest & { hash: string };
    manifests.push(manifest);
    if (byId.has(manifest.id)) {
      problems.push({ code: 'duplicate_manifest_id', message: `two manifests of the draft declare the id "${manifest.id}"` });
      continue;
    }
    byId.set(manifest.id, manifest);
  }

  const nodes: Record<string, unknown>[] = [];
  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    const safeNode = isObject(node) ? node : {};
    const reference = isObject(safeNode.skill_ref) ? safeNode.skill_ref : {};
    const label = `step "${String(safeNode.id)}" → skill "${String(reference.id)}"`;
    const manifest = typeof reference.id === 'string' ? byId.get(reference.id) : undefined;

    if (manifest === undefined) {
      problems.push({ code: 'unmatched_skill_ref', message: `${label}: no manifest of the draft declares that id` });
      continue;
    }
    if (reference.version !== undefined && reference.version !== manifest.version) {
      problems.push({
        code: 'version_mismatch',
        message: `${label}: pinned version ${String(reference.version)}, manifest ${String(manifest.version)}`,
      });
      continue;
    }
    nodes.push({ ...safeNode, skill_ref: { id: manifest.id, version: manifest.version, hash: manifest.hash } });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, graph: { ...graph, nodes }, manifests };
}

function printPinProblems(problems: { code: string; message: string }[]): void {
  process.stderr.write('cartografo: the map cannot be closed yet\n');
  for (const problem of problems) {
    process.stderr.write(`  ${problem.code.padEnd(22)} ${stripControlCharacters(problem.message)}\n`);
  }
}

function line(label: string, value: string): string {
  return `  ${label.padEnd(18)}${stripControlCharacters(value)}\n`;
}

/**
 * `register`: manifests first, then the graph — `import.ts`'s own order and
 * statuses.
 *
 * @returns `undefined` to go back to `next> `, or the exit code to leave with.
 */
async function register(options: InterviewOptions, draft: unknown): Promise<number | undefined> {
  const closed = closePins(draft);
  if (!closed.ok) {
    printPinProblems(closed.problems);
    return 1;
  }

  let created = 0;
  let known = 0;
  for (const manifest of closed.manifests) {
    const response = await requestJson(`${options.url}/v1/skills?project_id=${options.projectId}`, {
      method: 'POST',
      body: manifest,
    });
    if (response.status === 201) {
      created += 1;
      continue;
    }
    if (response.status === 200) {
      known += 1;
      continue;
    }
    const body = isObject(response.body) ? response.body : {};
    process.stderr.write(
      `cartografo: the registry refused a skill (HTTP ${response.status}) — ${stripControlCharacters(manifest.id)}\n`,
    );
    if (typeof body.error === 'string') process.stderr.write(`  ${'registry'.padEnd(10)} ${stripControlCharacters(body.error)}\n`);
    for (const detail of Array.isArray(body.details) ? body.details : []) {
      process.stderr.write(`  ${'registry'.padEnd(10)} ${stripControlCharacters(String(detail))}\n`);
    }
    process.stderr.write('cartografo: the map was not registered\n');
    return 1;
  }

  const response = await requestJson(`${options.url}/v1/graphs?project_id=${options.projectId}`, {
    method: 'POST',
    body: closed.graph,
  });
  const body = isObject(response.body) ? response.body : {};

  if (response.status === 201) {
    const graph = isObject(body.graph) ? body.graph : {};
    const version = isObject(body.graph_version) ? body.graph_version : {};
    process.stdout.write('map registered\n');
    process.stdout.write(line('class', String(graph.class)));
    process.stdout.write(line('graph.id', String(graph.id)));
    process.stdout.write(line('graph_version.id', String(version.id)));
    process.stdout.write(line('skills', `${created} registered, ${known} already in the registry`));
    return undefined;
  }

  if (response.status === 409) {
    process.stderr.write(
      `cartografo: class_already_registered — ${stripControlCharacters(String(body.message))}\n`,
    );
    return undefined;
  }

  if (response.status === 422) {
    process.stderr.write('cartografo: invalid_graph — the map was not registered\n');
    const structure = isObject(body.structure) ? body.structure : {};
    const soundness = isObject(body.soundness) ? body.soundness : {};
    const contracts = isObject(body.contracts) ? body.contracts : {};
    for (const error of Array.isArray(structure.errors) ? structure.errors : []) {
      const item = isObject(error) ? error : {};
      process.stderr.write(`  structure  ${stripControlCharacters(`${String(item.code)}: ${String(item.message)}`)}\n`);
    }
    for (const violation of Array.isArray(soundness.violations) ? soundness.violations : []) {
      const item = isObject(violation) ? violation : {};
      process.stderr.write(`  soundness  ${stripControlCharacters(`${String(item.rule)}: ${JSON.stringify(item.target)}`)}\n`);
    }
    for (const problem of Array.isArray(contracts.problems) ? contracts.problems : []) {
      const item = isObject(problem) ? problem : {};
      process.stderr.write(`  contracts  ${stripControlCharacters(`${String(item.code)}: ${String(item.message)}`)}\n`);
    }
    return undefined;
  }

  process.stderr.write(`cartografo: the map was refused (HTTP ${response.status})${errorCode(response.body)}\n`);
  return 1;
}

/** `export <dir>`: `<dir>/graph.json` and `<dir>/skills/<id>.json`, never overwriting. */
function exportMap(draft: unknown, directory: string): void {
  const closed = closePins(draft);
  if (!closed.ok) {
    printPinProblems(closed.problems);
    return;
  }

  const target = path.resolve(directory);
  const graphPath = path.join(target, 'graph.json');
  if (existsSync(graphPath)) {
    process.stderr.write(`cartografo: ${graphPath} already exists — export never overwrites\n`);
    return;
  }

  const skillsDir = path.join(target, 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(graphPath, `${JSON.stringify(closed.graph, null, 2)}\n`, 'utf8');
  for (const manifest of closed.manifests) {
    writeFileSync(path.join(skillsDir, `${manifest.id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`map exported to ${target} (${closed.manifests.length + 1} files)\n`);
}

/** The prompt once the interview is done. */
async function afterDone(options: InterviewOptions, draft: unknown, source: LineSource): Promise<number> {
  process.stdout.write('\nthe interview is finished. register the map, export it, or leave it as a draft.\n');
  for (;;) {
    const read = await source.read('next> ');
    if (read === null) return 0;
    const typed = read.trim();
    if (typed === '' || typed === 'quit') return 0;

    if (typed === 'register') {
      const outcome = await register(options, draft);
      if (outcome !== undefined) return outcome;
      continue;
    }

    const exported = /^export(?:\s+(.+))?$/.exec(typed);
    if (exported !== null && exported[1] !== undefined) {
      exportMap(draft, exported[1].trim());
      continue;
    }

    process.stderr.write(`cartografo: ${NEXT_HINT}\n`);
  }
}

/** The loop of FR4: read, then answer, finish, or wait. */
async function converse(options: InterviewOptions, id: number, source: LineSource): Promise<number> {
  let cursor = await latestEventId(options, id);
  let printedDraft: string | undefined;
  let waitingSaid = false;

  for (;;) {
    const conversation = await readConversation(options, id);

    if (conversation.done) {
      printMap(conversation.draft);
      return await afterDone(options, conversation.draft, source);
    }

    const draftKey = JSON.stringify(conversation.draft);
    if (conversation.draft !== null && draftKey !== printedDraft) {
      printMap(conversation.draft);
      printedDraft = draftKey;
    }

    const pending = conversation.pending;
    if (pending !== null) {
      const answer = isFieldList(pending.options)
        ? await askForm(pending, pending.options, source)
        : await askDecision(pending, source);
      await sendAnswer(options, pending, answer);
      waitingSaid = false;
      continue;
    }

    if (!waitingSaid) {
      process.stdout.write('working on the next question…\n');
      waitingSaid = true;
    }
    cursor = await waitForChange(options, id, cursor);
  }
}

/** The body of a stream refusal, as one line. */
function deniedLine(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string') return stripControlCharacters(parsed.message);
  } catch {
    // Not JSON.
  }
  return stripControlCharacters(body);
}

/**
 * Runs `cartografo interview`.
 *
 * @param options Scope, source of lines and who answers, already parsed.
 * @returns `0` on a clean finish, `1` on a refusal or input that ran out.
 * @throws {UsageError} When `--answers` names a file that cannot be read.
 */
export async function runInterview(options: InterviewOptions): Promise<number> {
  const source = options.answersPath !== undefined ? answersSource(options.answersPath) : stdinSource();
  let id: number | undefined;

  try {
    id = options.resumeId !== undefined ? await resumeInterview(options, options.resumeId) : await startInterview(options, source);
    return await converse(options, id, source);
  } catch (failure) {
    if (failure instanceof Refused) return 1;
    if (failure instanceof OutOfLines) {
      if (source.scripted) {
        process.stderr.write('cartografo: --answers ran out of lines before the interview finished\n');
      } else {
        const resume = id === undefined ? '' : ` — pick it up again with: cartografo interview --resume ${id}`;
        process.stderr.write(`cartografo: the input ended before the interview finished${resume}\n`);
      }
      return 1;
    }
    if (failure instanceof StreamDeniedError) {
      process.stderr.write(`cartografo: ${deniedLine(failure.body)}\n`);
      return 1;
    }
    throw failure;
  } finally {
    source.close();
  }
}
