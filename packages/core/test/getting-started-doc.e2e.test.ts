/**
 * Gate: `docs/getting-started.md` is executable, not aspirational (t121, AT2).
 *
 * The founder's instruction for this ticket was not "write a usage document" —
 * it was "write it from a cold start and then follow your own instructions on a
 * fresh clone", and "that execution is the acceptance criterion, not a review of
 * the prose". This file is the automated form of that instruction: it boots a
 * real control plane through the real binary, imports the bundle the document
 * names, creates a job out of the document's own example body and reads back
 * the two endpoints the document sends a stuck reader to.
 *
 * ## Why it EXTRACTS the commands instead of restating them
 *
 * A test that hard-coded `factory-graphs/software-development` and
 * `{"title": …, "entry_node_id": "refine"}` would prove that the CONTROL PLANE
 * works — which four suites already prove — and would go on passing forever
 * after somebody edited the document into something that does not. What has to
 * be pinned is the document's claims, so every input below is read out of the
 * document at test time: the bundle path comes from the import command it
 * publishes, and the request body comes from the `-d` payload of the `curl` it
 * publishes. Edit either into something that does not work and this goes red.
 *
 * The same reasoning `tests/factory-graph-2.test.mjs` records for FR10 — the
 * bundle README as executable documentation — one level up.
 *
 * ## What it deliberately does NOT prove
 *
 * That an agent traverses the graph. `packages/runner/test/bin.e2e.test.ts` and
 * the two factory-graph suites own that proof, it needs an engine CLI installed
 * and authenticated on the machine, and the document makes no claim about it
 * that those suites do not already hold. What this file covers is exactly the
 * span the document walks a stranger through on their own machine: install,
 * start, import, create, inspect.
 *
 * The two `npx` commands that START something are checked structurally rather
 * than run: the document has to name a command this repository really publishes,
 * so the `bin` entries of the workspace manifests are what AT2 reads. Booting
 * the screen adds a second port and a second process to prove a package manifest
 * already states.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { REPO_ROOT, runCli, startControlPlane, temporaryArea } from './cli-support.ts';

/** The document under test, repo-relative. */
const DOCUMENT = path.join('docs', 'getting-started.md');

/** The headings this gate reads the document by, in the document's own order. */
const SECTIONS = Object.freeze({
  install: /^##\s.*\bInstall\b/im,
  start: /^##\s.*\bStart\b/im,
  import: /^##\s.*\bImport\b/im,
  create: /^##\s.*\bPut a piece of work on it\b/im,
  watch: /^##\s.*\bWatch\b/im,
  stuck: /^##\s.*\bstuck\b/im,
});

/** The job a reader creates, in the part this suite reads of it. */
interface CreatedJob {
  id: number;
  title: string;
  entry_node_id: string;
  current_node_id: string;
}

/** The document, whole. */
function document(): string {
  return readFileSync(path.join(REPO_ROOT, DOCUMENT), 'utf8');
}

/**
 * One `##` section of a markdown document: the heading and everything under it.
 *
 * Pure, so the extraction below can be bitten with a synthetic document.
 *
 * @param markdown Contents of the document.
 * @param heading Expression matching the heading line.
 * @returns The section, or `null` when no heading matches.
 */
export function sectionOf(markdown: string, heading: RegExp): string | null {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));

  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** Every fenced block of one span of markdown, fences dropped. */
export function fencesIn(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

/**
 * The bundle path the document tells a reader to import.
 *
 * @param markdown Contents of the document.
 * @returns The path, as the document writes it, relative to the repository root.
 */
export function importedBundleIn(markdown: string): string | null {
  const section = sectionOf(markdown, SECTIONS.import);
  if (section === null) return null;

  const match = /npx cartografo import\s+(\S+)/.exec(fencesIn(section).join('\n'));
  return match === null ? null : match[1];
}

/**
 * The request body the document's `POST /v1/jobs` example sends.
 *
 * Read out of `curl`'s `-d` payload, which is the shape the document publishes;
 * returned unparsed so the caller can report a body that is not JSON as a
 * failure of the document rather than as a crash of the gate.
 *
 * @param markdown Contents of the document.
 * @returns The payload as written, or `null` when there is no such example.
 */
export function jobPayloadIn(markdown: string): string | null {
  const section = sectionOf(markdown, SECTIONS.create);
  if (section === null) return null;

  const commands = fencesIn(section).join('\n');
  if (!/\/v1\/jobs\b/.test(commands)) return null;

  const match = /-d\s+'([\s\S]*?)'/.exec(commands);
  return match === null ? null : match[1];
}

/** The `bin` names of every workspace manifest, as one set. */
function publishedCommands(): Set<string> {
  const workspaces = ['core', 'runner', 'screen', 'surveyor', 'cost-surveyor'];
  const found = new Set<string>();

  for (const workspace of workspaces) {
    const manifestPath = path.join(REPO_ROOT, 'packages', workspace, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.bin ?? {})) found.add(name);
  }

  return found;
}

test('AT2 — the document walks the seven steps a cold reader needs, in order', () => {
  const contents = document();

  for (const [step, heading] of Object.entries(SECTIONS)) {
    assert.notEqual(
      sectionOf(contents, heading),
      null,
      `${DOCUMENT} has no "${step}" section; the walkthrough drops a step a stranger cannot ` +
        'supply on their own',
    );
  }

  const order = Object.values(SECTIONS).map((heading) =>
    contents.split('\n').findIndex((line) => heading.test(line)),
  );

  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'the steps are out of order; a reader cannot import before starting the control plane, ' +
      'and cannot create a job before importing a graph',
  );
});

test('AT2 — every command the document tells a reader to start is one this repository publishes', () => {
  const contents = document();
  const section = sectionOf(contents, SECTIONS.start);
  assert.notEqual(section, null, `${DOCUMENT} has no start section`);

  const published = publishedCommands();
  const named = [...fencesIn(section as string).join('\n').matchAll(/npx\s+([a-z0-9-]+)/g)].map(
    (match) => match[1],
  );

  assert.ok(named.length >= 2, 'the start section names fewer than two commands to run');

  const unpublished = named.filter((command) => !published.has(command));

  assert.deepEqual(
    unpublished,
    [],
    `the document tells a reader to run a command no package of this repository publishes: ` +
      `${unpublished.join(', ')}`,
  );
});

test('AT2 — the document sends a stuck reader to routes and a switch that exist', () => {
  const section = sectionOf(document(), SECTIONS.stuck);
  assert.notEqual(section, null, `${DOCUMENT} has no "when it is stuck" section`);

  for (const anchor of ['block_reason', '/v1/input-requests?status=pending', 'CARTOGRAFO_LOG_LEVEL']) {
    assert.ok(
      (section as string).includes(anchor),
      `the section a stuck reader lands on never mentions ${anchor}; those are the three ` +
        'places an answer actually is',
    );
  }
});

test(
  'AT2 — the document, executed: import, create a job, read it back',
  { timeout: 180_000 },
  async (t) => {
    const contents = document();
    const base = temporaryArea(t, 'cartografo-t121-');
    const controlPlane = await startControlPlane(t, {
      databasePath: path.join(base, 'cartografo.db'),
    });

    // (d) Import a factory graph — the bundle path the document publishes.
    const bundle = importedBundleIn(contents);
    assert.notEqual(
      bundle,
      null,
      `${DOCUMENT} publishes no "npx cartografo import <bundle>" command; step (d) of the ` +
        'walkthrough is the one that turns an empty control plane into a usable one',
    );

    const imported = await runCli(['import', bundle as string, '--url', controlPlane.url], {
      token: controlPlane.token,
    });

    assert.equal(
      imported.code,
      0,
      `the import command the document publishes failed:\n${imported.stderr}`,
    );

    // The class the document says a reader now has, as the control plane lists it.
    const classes = await fetch(`${controlPlane.url}/v1/classes`);
    assert.equal(classes.status, 200, 'GET /v1/classes did not answer after the import');

    // (e) Put a piece of work on it — the document's own request body.
    const payload = jobPayloadIn(contents);
    assert.notEqual(
      payload,
      null,
      `${DOCUMENT} shows no POST /v1/jobs example with a body; a walkthrough that stops at a ` +
        'running server never shows the shape a real ticket takes',
    );

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload as string) as Record<string, unknown>;
    } catch (error) {
      assert.fail(`the document's POST /v1/jobs payload is not JSON: ${String(error)}`);
    }

    assert.ok(
      typeof body.title === 'string' && body.title !== '',
      "the document's example body has no `title`",
    );
    assert.ok(
      typeof body.entry_node_id === 'string' && body.entry_node_id !== '',
      "the document's example body has no `entry_node_id`",
    );

    const graph = JSON.parse(
      readFileSync(path.join(REPO_ROOT, bundle as string, 'graph.json'), 'utf8'),
    ) as { initial_node: string };

    assert.equal(
      body.entry_node_id,
      graph.initial_node,
      "the document's example starts a job on a node the imported graph does not begin at; " +
        'the request would be accepted and the job would sit off the map',
    );

    const created = await fetch(`${controlPlane.url}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    assert.equal(created.status, 201, `POST /v1/jobs returned ${String(created.status)}`);

    const job = (await created.json()) as CreatedJob;

    assert.equal(job.title, body.title, 'the created job is not the one the body described');
    assert.equal(
      job.current_node_id,
      body.entry_node_id,
      'the job did not come back standing on the node it declared as its entry, which is what ' +
        'the document tells a reader to expect from the 201',
    );

    // (f) Watch it run — the board reads the job list; the timeline is per job.
    const board = await fetch(`${controlPlane.url}/v1/jobs`);
    assert.equal(board.status, 200, 'GET /v1/jobs did not answer; the board has nothing to render');

    const timeline = await fetch(`${controlPlane.url}/v1/jobs/${String(job.id)}/events`);
    assert.equal(timeline.status, 200, "GET /v1/jobs/:id/events did not answer");

    const { events } = (await timeline.json()) as { events: { type: string }[] };
    assert.ok(
      events.some((event) => event.type === 'job.created'),
      "the job's timeline does not carry its own creation; the document promises a reader " +
        'they can follow a job through the log',
    );

    // (g) Where to look when it does not — the pending-question queue resolves.
    const pending = await fetch(`${controlPlane.url}/v1/input-requests?status=pending`);
    assert.equal(
      pending.status,
      200,
      'GET /v1/input-requests?status=pending did not answer; it is the first place the ' +
        'document sends somebody whose job has stopped moving',
    );

    const { input_requests: requests } = (await pending.json()) as { input_requests: unknown[] };
    assert.deepEqual(
      requests,
      [],
      'nothing has asked this control plane a question yet, so the queue is the empty list — ' +
        'a reader following the document has to be able to tell "nothing pending" from an error',
    );
  },
);

test('AT2 — the extraction really reads the document, and reports a document that says nothing', () => {
  const sample = [
    '# x',
    '',
    '## 4. Import a factory graph',
    '',
    '```bash',
    'npx cartografo import factory-graphs/software-development',
    '```',
    '',
    '## 5. Put a piece of work on it',
    '',
    '```bash',
    "curl -X POST http://127.0.0.1:4317/v1/jobs -d '{\"title\": \"t\"}'",
    '```',
    '',
    '## 6. Watch it run',
    '',
    'nothing here',
    '',
  ].join('\n');

  assert.equal(importedBundleIn(sample), 'factory-graphs/software-development');
  assert.equal(jobPayloadIn(sample), '{"title": "t"}');
  assert.equal(
    sectionOf(sample, SECTIONS.watch)?.includes('npx cartografo import'),
    false,
    'a section must stop at the next heading, or every claim resolves against the whole file',
  );

  assert.equal(importedBundleIn('# x\n\n## 4. Import a factory graph\n\nprose only\n'), null);
  assert.equal(jobPayloadIn('# x\n\n## 5. Put a piece of work on it\n\nprose only\n'), null);
});
