/**
 * Acceptance tests for the graph configuration screen (t170).
 *
 * Two real control planes come up here, and the reason is the whole first test:
 * the editor is only worth having if it produces EXACTLY the version a scripted
 * API client would have produced with the same operations. A graph version's id
 * IS the hash of its snapshot, so the same document registered in two fresh
 * databases yields the same id — which makes "drive the page on one, replay its
 * own request body on the other, compare the two ids" a byte-for-byte parity
 * proof rather than a plausibility argument.
 *
 * The page runs against a stub DOM (`fake-dom.ts`) for the same reason
 * `inbox-reason-field.test.ts` does: this package ships native ES modules with
 * no bundler, and a headless browser is a dependency the screen refuses to
 * carry. Everything else is real — the screen's own server, its `/v1/*` proxy,
 * and the control plane as a child process that this package can only reach
 * over HTTP (D11).
 *
 * Every string the page SHOWS reads in English since t310. Two values it sends
 * do not, and this file pins both: `MANUAL_EVIDENCE` moved with the copy because
 * it is this screen's own invention, while `MANUAL_METRIC` stayed exactly as it
 * is because `packages/core` validates every proposal's `expected_metric`
 * against that Portuguese shape (`domain/hypothesis.ts`,
 * `routes/proposals.ts`). Renaming its keys here would make this page's own
 * proposals fail that validation — which is why AC1 asserts the two side by
 * side, in one body.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { FakeDocument, FakeElement } from './fake-dom.ts';
import { api, openPage, startControlPlane, startScreen, type RunningControlPlane } from './support.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const PUBLIC_DIR = path.join(PACKAGE_ROOT, 'src', 'public');
const HTML_PATH = path.join(PUBLIC_DIR, 'graph-editor.html');
const SCRIPT_PATH = path.join(PUBLIC_DIR, 'graph-editor.js');
const BASE_GRAPH_PATH = path.join(REPO_ROOT, 'schema', 'examples', 'graph-valid-minimal.json');

/** Fields the page may change on a node that already exists (t170, FR2). */
const EDITABLE_FIELDS = [
  'contract',
  'description',
  'role',
  'skill_ref.hash',
  'skill_ref.id',
  'skill_ref.version',
];

/** Fields no client can swap on an existing node — only remove and re-add. */
const FROZEN_FIELDS = ['engine', 'id', 'node_type'];

/** The sentence the page owes next to those three (FR2). */
const FROZEN_NOTE = 'remove and re-create the node to change this';

/** Tags that take input from a person. */
const CONTROL_TAGS = ['input', 'select', 'textarea'];

/* --------------------------------------------------------------- the page */

interface EditorHandle {
  /** The initial `GET /v1/classes`, so a test can wait for the picker. */
  ready: Promise<void>;
  loadClasses: () => Promise<void>;
  loadGraph: (graphId?: string) => Promise<void>;
  save: () => Promise<void>;
  state: () => { graphId: string | null; versionId: string | null; appliedVersionId: string | null };
}

/**
 * `mount`, typed for this test.
 *
 * Written out instead of imported for the same reason `inbox-reason-field`
 * writes it out: the page documents its first parameter as `Document`, a type
 * this package's lib does not have, and the stub is what it is checked against.
 */
type Mount = (doc: FakeDocument, request: PageRequest) => EditorHandle;

/** The HTTP client the page is given — the same shape as the browser's `fetch`. */
type PageRequest = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Response>;

async function loadMount(): Promise<Mount> {
  assert.ok(existsSync(SCRIPT_PATH), 'artifact does not exist yet: packages/screen/src/public/graph-editor.js');
  const module = (await import(new URL('../src/public/graph-editor.js', import.meta.url).href)) as {
    mount: Mount;
  };
  return module.mount;
}

/**
 * A stub document carrying exactly the ids the real page declares.
 *
 * Read out of `graph-editor.html` and never copied: an id renamed in the markup
 * without being renamed in the script is precisely the failure this test would
 * otherwise stop seeing.
 */
function pageDocument(): FakeDocument {
  assert.ok(existsSync(HTML_PATH), 'artifact does not exist yet: packages/screen/src/public/graph-editor.html');
  const ids = [...readFileSync(HTML_PATH, 'utf8').matchAll(/\bid="([^"]+)"/g)].map((hit) => hit[1]);
  assert.ok(ids.length > 0, 'graph-editor.html declares no id for the script to mount into');
  return new FakeDocument(ids);
}

/* ------------------------------------------------------------- the driving */

/** One call the page made, as this test wants to read it back. */
interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  /** Filled once the answer arrives; reading it never consumes the body. */
  status: number;
}

/** A `fetch` pointed at the screen that keeps a log of what the page asked for. */
function recordingFetch(screenUrl: string, log: RecordedCall[]): PageRequest {
  return async (url, options) => {
    const call: RecordedCall = {
      method: options?.method ?? 'GET',
      url,
      body: options?.body === undefined ? undefined : (JSON.parse(options.body) as unknown),
      status: 0,
    };
    log.push(call);

    const response = await fetch(`${screenUrl}${url}`, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
    });
    call.status = response.status;
    return response;
  };
}

/** `POST /v1/proposals/7/approve` → `POST /v1/proposals/:id/approve`. */
function shapeOf(call: RecordedCall): string {
  return `${call.method} ${call.url.replace(/\/\d+(?=\/|$)/g, '/:id')}`;
}

/** Every card in a list, in the order the page drew them. */
function cards(doc: FakeDocument, listId: string, marker: string): FakeElement[] {
  return doc
    .require(listId)
    .descendants()
    .filter((node) => node.getAttribute(marker) !== null);
}

/** The control of one field inside a card, or a readable failure. */
function control(card: FakeElement, field: string): FakeElement {
  const found = card.descendants().filter((node) => node.getAttribute('data-campo') === field);
  assert.equal(found.length, 1, `expected exactly one control for "${field}", found ${found.length}`);
  return found[0];
}

/** Fills a card the way a person would: one field at a time. */
function fillCard(card: FakeElement, values: Record<string, string>): void {
  for (const [field, value] of Object.entries(values)) control(card, field).typeText(value);
}

/* ------------------------------------------------------------- the fixture */

/** The base graph both control planes register, byte for byte the same. */
function baseGraph(): Record<string, unknown> {
  return JSON.parse(readFileSync(BASE_GRAPH_PATH, 'utf8')) as Record<string, unknown>;
}

/** The node the tests add, as the person would type it into the new card. */
const NEW_NODE = {
  id: 'checar_fonte',
  role: 'conferente',
  node_type: 'work',
  description: 'Checks the sources cited in the note.',
  'skill_ref.id': 'cartografo/checar-fonte',
  'skill_ref.version': '1.0.0',
  'skill_ref.hash': `sha256:${'4'.repeat(64)}`,
  contract: JSON.stringify({
    input_schema: { type: 'object' },
    output_schema: { type: 'object' },
    checks: [{ type: 'deterministic', command: 'test -s fontes.md' }],
  }),
};

/** The lineage envelope every graph route answers with. */
interface LineageBody {
  graph: { id: string; current_version_id: string | null };
}

/** `POST /v1/graphs` also hands back the first version it wrote. */
interface RegisteredBody extends LineageBody {
  graph_version: { id: string };
}

/** Registers a graph — the base one unless another document is handed in. */
async function registerBase(
  cp: RunningControlPlane,
  document: Record<string, unknown> = baseGraph(),
): Promise<RegisteredBody> {
  const created = await api<RegisteredBody>(cp, 'POST', '/v1/graphs', document);
  assert.equal(created.status, 201, `POST /v1/graphs returned ${created.status}`);
  return created.body;
}

/**
 * Mounts the page over a control plane and loads the base graph into it.
 *
 * The picker is set and `loadGraph` is called with no argument on purpose: that
 * is the path the button takes, so the test exercises the same read the page
 * does rather than a shortcut past it.
 */
async function openEditor(
  screenUrl: string,
  graphId: string,
): Promise<{ doc: FakeDocument; editor: EditorHandle; log: RecordedCall[] }> {
  const mount = await loadMount();
  const doc = pageDocument();
  const log: RecordedCall[] = [];

  const editor = mount(doc, recordingFetch(screenUrl, log));
  await editor.ready;

  doc.require('graph-picker').value = graphId;
  await editor.loadGraph();

  return { doc, editor, log };
}

/* ------------------------------------------------------------------ AC1 */

test('AC1 — the page produces the same version the API would, through the same three calls', async (t) => {
  const [driven, replayed] = await Promise.all([startControlPlane(t), startControlPlane(t)]);
  const screen = await startScreen(t, driven);

  const registered = await registerBase(driven);
  await registerBase(replayed);

  const { doc, editor, log } = await openEditor(screen.url, registered.graph.id);

  doc.require('add-node').click();
  fillCard(cards(doc, 'node-list', 'data-node').at(-1) as FakeElement, NEW_NODE);

  doc.require('add-edge').click();
  fillCard(cards(doc, 'edge-list', 'data-edge').at(-1) as FakeElement, {
    from: 'redigir',
    to: 'checar_fonte',
    condition: 'conferir_fontes',
  });

  doc.require('add-edge').click();
  fillCard(cards(doc, 'edge-list', 'data-edge').at(-1) as FakeElement, {
    from: 'checar_fonte',
    to: 'revisar',
    condition: 'sempre',
  });

  await editor.save();

  // FR5: these calls, in this order, and no other route. The page has no
  // shortcut into the core, and this is where that stops being a promise — the
  // three WRITES at the bottom are the whole of how a graph moves.
  //
  // The version id is percent-encoded because it carries a `sha256:` prefix and
  // the page escapes every id it puts in a path — an id it read from the API is
  // not a path fragment it gets to trust.
  //
  // The two registry reads are t215's, one per distinct skill the loaded nodes
  // pin, and they are reads: they exist so the page can offer the versions the
  // registry carries (FR10) instead of asking a person to type a hash. This
  // fixture's pins are placeholders no registry can hold, so both come back with
  // nothing and no picker is drawn — which is exactly why the shape of the call
  // list is the only trace of them here.
  assert.deepEqual(log.map(shapeOf), [
    'GET /v1/classes',
    `GET /v1/graphs/${registered.graph.id}`,
    `GET /v1/graph-versions/${encodeURIComponent(registered.graph.current_version_id ?? '')}`,
    'GET /v1/skills?id=cartografo%2Fredigir-nota',
    'GET /v1/skills?id=cartografo%2Frevisar-nota',
    'POST /v1/proposals',
    'POST /v1/proposals/:id/approve',
    'POST /v1/proposals/:id/apply',
  ]);

  const applied = editor.state().appliedVersionId;
  assert.ok(typeof applied === 'string' && applied !== '', 'the page did not record a new version');
  assert.ok(doc.require('result').textContent.includes(applied), 'the new version is not on the page (FR7)');

  // The same body, sent by hand to a control plane the page never touched.
  const sent = log.find((call) => shapeOf(call) === 'POST /v1/proposals');
  assert.ok(sent !== undefined, 'the page never created a proposal');

  // t310, and the whole reason this ticket had two landmines rather than one.
  // The evidence is this screen's own invention and moved with the copy; the
  // metric mirrors the shape `packages/core` still validates, and did not.
  const body = sent.body as { evidence: unknown; expected_metric: unknown };
  assert.deepEqual(body.evidence, {
    source: 'graph-configuration-screen',
    note: 'manual edit through the graph configuration screen',
  });
  assert.deepEqual(
    body.expected_metric,
    { nome: 'manual edit (no metric)', direcao: 'sobe', de: 0, para: 0 },
    'MANUAL_METRIC is a frozen wire shape: only its free-text name is copy',
  );

  const created = await api<{ proposal: { id: number } }>(replayed, 'POST', '/v1/proposals', sent.body);
  assert.equal(created.status, 201, `POST /v1/proposals returned ${created.status}`);
  const proposalId = created.body.proposal.id;

  const approved = await api(replayed, 'POST', `/v1/proposals/${proposalId}/approve`, {});
  assert.equal(approved.status, 200, `approve returned ${approved.status}`);

  const done = await api<{ graph_version: { id: string } }>(
    replayed,
    'POST',
    `/v1/proposals/${proposalId}/apply`,
    {},
  );
  assert.equal(done.status, 200, `apply returned ${done.status}`);

  assert.equal(
    applied,
    done.body.graph_version.id,
    'the page and the raw API produced different versions of the same edit',
  );
});

/* ------------------------------------------- AC1, with parallel edges (t205) */

/**
 * The base graph with two edges between the same two nodes.
 *
 * Sound, and always was: nothing in `graph.schema.json` or in the four
 * soundness rules forbids two transitions between the same pair — they are two
 * different outcomes of the same step, which is exactly what a gate produces.
 */
function parallelBaseGraph(): Record<string, unknown> {
  const graph = baseGraph();
  graph.edges = [
    { from: 'redigir', to: 'revisar', condition: 'aprovado' },
    { from: 'redigir', to: 'revisar', condition: 'reprovado' },
  ];
  return graph;
}

/** Clicks a card's own remove button, the way a person would. */
function removeCard(card: FakeElement, label: string): void {
  const buttons = card.byTag('button').filter((node) => node.textContent === label);
  assert.equal(buttons.length, 1, `expected one "${label}" button in the card, found ${buttons.length}`);
  buttons[0].click();
}

/** The `condition` of every edge of a version's snapshot, in document order. */
function conditionsOf(snapshot: Record<string, unknown>): string[] {
  const edges = snapshot.edges as Record<string, unknown>[];
  return edges.map((edge) => String(edge.condition));
}

test('AC1 — two parallel edges stay two edges, from the cards to the version id', async (t) => {
  const [driven, replayed] = await Promise.all([startControlPlane(t), startControlPlane(t)]);
  const screen = await startScreen(t, driven);

  const registered = await registerBase(driven, parallelBaseGraph());
  await registerBase(replayed, parallelBaseGraph());

  const { doc, editor, log } = await openEditor(screen.url, registered.graph.id);

  const drawn = cards(doc, 'edge-list', 'data-edge');
  assert.equal(drawn.length, 2, 'the page did not draw one card per parallel edge');

  // Remove the second of the pair and add a third condition in its place. The
  // two operations name the same two ends, so nothing but `condition` can tell
  // the removal from the addition — or from the sibling that has to survive.
  removeCard(drawn[1], 'Remove edge');

  doc.require('add-edge').click();
  fillCard(cards(doc, 'edge-list', 'data-edge').at(-1) as FakeElement, {
    from: 'redigir',
    to: 'revisar',
    condition: 'escala',
  });

  await editor.save();

  const applied = editor.state().appliedVersionId;
  assert.ok(typeof applied === 'string' && applied !== '', 'the page did not record a new version');

  // What was actually written: the sibling the person never touched, and the
  // edge they typed. Keyed by the two ends alone, the diff removed whichever
  // parallel edge came first and this read came back `reprovado, escala`.
  const version = await api<{ graph_version: { snapshot: Record<string, unknown> } }>(
    driven,
    'GET',
    `/v1/graph-versions/${encodeURIComponent(applied)}`,
  );
  assert.equal(version.status, 200, `GET /v1/graph-versions returned ${version.status}`);
  assert.deepEqual(
    conditionsOf(version.body.graph_version.snapshot),
    ['aprovado', 'escala'],
    'the version kept the wrong half of the parallel pair',
  );

  // And the same parity as AC1: the page's own body, replayed by hand against a
  // control plane it never touched, lands on the same id.
  const sent = log.find((call) => shapeOf(call) === 'POST /v1/proposals');
  assert.ok(sent !== undefined, 'the page never created a proposal');

  const created = await api<{ proposal: { id: number } }>(replayed, 'POST', '/v1/proposals', sent.body);
  assert.equal(created.status, 201, `POST /v1/proposals returned ${created.status}`);
  const proposalId = created.body.proposal.id;

  const approved = await api(replayed, 'POST', `/v1/proposals/${proposalId}/approve`, {});
  assert.equal(approved.status, 200, `approve returned ${approved.status}`);

  const done = await api<{ graph_version: { id: string } }>(
    replayed,
    'POST',
    `/v1/proposals/${proposalId}/apply`,
    {},
  );
  assert.equal(done.status, 200, `apply returned ${done.status}`);

  assert.equal(
    applied,
    done.body.graph_version.id,
    'the page and the raw API produced different versions of the same edit',
  );
});

/* ------------------------------------------------------------------ AC2 */

test('AC2 — a soundness failure is shown with its reason, and nothing is written', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const registered = await registerBase(cp);

  const { doc, editor, log } = await openEditor(screen.url, registered.graph.id);

  // A node with no edge at all: unreachable from the initial node, and with no
  // path to a final one. Two rules, one edit.
  doc.require('add-node').click();
  fillCard(cards(doc, 'node-list', 'data-node').at(-1) as FakeElement, NEW_NODE);

  await editor.save();

  const shown = doc.require('problems').textContent;
  for (const word of ['reachable', 'checar_fonte']) {
    assert.ok(shown.includes(word), `the refusal does not mention "${word}": ${shown}`);
  }
  assert.ok(
    shown.includes('final'),
    `the refusal does not explain the termination rule: ${shown}`,
  );

  const last = log[log.length - 1];
  assert.equal(shapeOf(last), 'POST /v1/proposals/:id/apply', 'the page stopped before the gate ran');
  assert.equal(last.status, 422, 'the gate did not refuse the unsound document');

  assert.equal(editor.state().appliedVersionId, null, 'the page recorded a version that was refused');

  const after = await api<LineageBody>(cp, 'GET', `/v1/graphs/${registered.graph.id}`);
  assert.equal(after.status, 200);
  assert.equal(
    after.body.graph.current_version_id,
    registered.graph.current_version_id,
    'the lineage moved even though the gate refused',
  );
});

/* ------------------------------------------------------------------ AC3 */

test('AC3 — an existing node offers no control for `id`, `node_type` or `engine`', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);
  const registered = await registerBase(cp);

  const { doc } = await openEditor(screen.url, registered.graph.id);

  const existing = cards(doc, 'node-list', 'data-node').filter(
    (card) => card.getAttribute('data-new') === null,
  );
  assert.equal(existing.length, 2, 'the page did not render the two nodes of the base graph');

  for (const card of existing) {
    const fields = card
      .descendants()
      .filter((node) => CONTROL_TAGS.includes(node.tagName))
      .map((node) => node.getAttribute('data-campo'));

    assert.deepEqual(
      [...fields].sort(),
      EDITABLE_FIELDS,
      `node "${card.getAttribute('data-node')}" offers controls the operation vocabulary does not have`,
    );
    for (const frozen of FROZEN_FIELDS) {
      assert.ok(!fields.includes(frozen), `node "${card.getAttribute('data-node')}" still edits "${frozen}"`);
    }
    assert.ok(
      card.textContent.includes(FROZEN_NOTE),
      `node "${card.getAttribute('data-node')}" does not say what to do instead: ${card.textContent}`,
    );
  }
});

/* ------------------------------------------------------------------ AC4 */

test('AC4 — neither half of the screen is a dead end', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  for (const from of ['/board', '/']) {
    const page = await openPage(screen, from);
    assert.equal(page.status, 200, `${from} returned ${page.status}`);
    assert.ok(
      page.html.includes('href="/graph-editor.html"'),
      `${from} does not link to the graph editor`,
    );
  }

  const editor = await openPage(screen, '/graph-editor.html');
  assert.equal(editor.status, 200, `/graph-editor.html returned ${editor.status}`);
  assert.ok(
    editor.html.includes('href="/board"') || editor.html.includes('href="/"'),
    'the graph editor links back to neither half of the screen',
  );
});

/* ------------------------------------------------------------------ AC5 (t215) */

/*
 * The registry became a lineage (D22), so a node can be pinned to a version
 * that is no longer the newest one — and the person editing the graph is the
 * one who decides whether to follow. Moving the pin is a proposal like any
 * other change, and this page already knows how to write one: what it was
 * missing was any way to SEE that a newer version exists, and any way to fill
 * in the three fields of a pin without typing a 64-character hash by hand.
 *
 * The picker is deliberately not an upgrade button. It writes the same
 * `skill_ref` the three text inputs write, so the existing node diffing emits
 * the same `change_node_field` it always did, and the gate that refuses an
 * unregistered pin (`routes/proposals.ts`) still has the last word.
 */

/** The lineage the cases below register, told apart by the body of each version. */
const PICKER_SKILL = 'revisar-nota';

/** Sorts keys recursively — the canonicalization the manifest hash is defined over. */
function canonicalManifest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalManifest);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = canonicalManifest(source[key]);
    return sorted;
  }
  return value;
}

/**
 * The pin of a manifest, computed here rather than imported.
 *
 * `packages/screen` declares no dependency on `packages/core` — that is the whole
 * point of D11 — so the procedure of
 * `specs/formats/skill-manifest.md` is written out, the same way
 * `packages/core/test/skill-routes.test.ts` writes it out.
 */
function manifestPin(manifest: Record<string, unknown>): string {
  const subset = {
    instructions: manifest.instructions,
    input: manifest.input,
    output: manifest.output,
    checks: manifest.checks,
    permissions: manifest.permissions,
    budgets: manifest.budgets,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalManifest(subset)), 'utf8').digest('hex')}`;
}

/** One registerable version of {@link PICKER_SKILL}. */
function skillManifest(version: string, instructions: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    id: PICKER_SKILL,
    version,
    hash: '',
    role: 'gate',
    description: 'Confere a nota contra o tema declarado.',
    input: { type: 'object', properties: { texto: { type: 'string' } } },
    output: {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { enum: ['pass', 'fail', 'escalate_human'] } },
    },
    preconditions: [],
    checks: [
      {
        id: 'nota-existe',
        type: 'deterministic',
        description: 'A nota existe e não está vazia.',
        command: 'test -s nota.md',
      },
    ],
    permissions: { filesystem: { read: ['**'], write: [] }, network: { allowed: false } },
    instructions,
    origin: { type: 'native' },
  };
  manifest.hash = manifestPin(manifest);
  return manifest;
}

/** Registers one version and hands back the pin the registry stored. */
async function registerSkill(
  cp: RunningControlPlane,
  version: string,
  instructions: string,
): Promise<{ id: string; version: string; hash: string }> {
  const created = await api<{ id: string; version: string; hash: string }>(
    cp,
    'POST',
    '/v1/skills',
    skillManifest(version, instructions),
  );
  assert.equal(created.status, 201, `POST /v1/skills returned ${created.status}`);
  return { id: created.body.id, version: created.body.version, hash: created.body.hash };
}

/** The base graph with `revisar` pinned to a pin the registry really carries. */
function graphPinnedTo(pin: { id: string; version: string; hash: string }): Record<string, unknown> {
  const graph = baseGraph();
  graph.nodes = (graph.nodes as Record<string, unknown>[]).map((node) =>
    node.id === 'revisar' ? { ...node, skill_ref: { ...pin } } : node,
  );
  return graph;
}

/** The version picker of one card, when the page drew one. */
function versionPicker(card: FakeElement): FakeElement[] {
  return card.descendants().filter((node) => node.getAttribute('data-skill-versions') !== null);
}

/** The card of one node, by id. */
function cardOf(doc: FakeDocument, nodeId: string): FakeElement {
  const found = cards(doc, 'node-list', 'data-node').filter(
    (card) => card.getAttribute('data-node') === nodeId,
  );
  assert.equal(found.length, 1, `expected exactly one card for "${nodeId}", found ${found.length}`);
  return found[0];
}

test('AC5 — a node whose skill has a newer version gets a picker that writes the pin (t215)', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const pinned = await registerSkill(cp, '1.0.0', '# Revisar\n\nConfira a nota.');
  const newer = await registerSkill(cp, '1.1.0', '# Revisar\n\nConfira a nota, e cite o trecho.');
  const registered = await registerBase(cp, graphPinnedTo(pinned));

  const { doc, editor } = await openEditor(screen.url, registered.graph.id);

  const card = cardOf(doc, 'revisar');
  const picker = versionPicker(card);
  assert.equal(picker.length, 1, 'a node with a newer version available has to say so');
  assert.ok(
    picker[0].textContent.includes('1.1.0'),
    `the picker does not offer the newer version: ${picker[0].textContent}`,
  );

  // The node the person never pinned to this lineage shows nothing extra.
  assert.deepEqual(versionPicker(cardOf(doc, 'redigir')), [], 'the other node has no lineage to offer');

  // Choosing the newer version writes the three fields of the pin — the same
  // three the text inputs write, so the diff is the `change_node_field` the
  // page already produces for a hand-typed `skill_ref`.
  const select = picker[0].byTag('select');
  assert.equal(select.length, 1, 'the picker has to be a closed list, not free text');
  select[0].typeText(newer.version);

  const after = cardOf(doc, 'revisar');
  assert.equal(control(after, 'skill_ref.id').value, newer.id, 'the id of the lineage does not move');
  assert.equal(control(after, 'skill_ref.version').value, newer.version);
  assert.equal(control(after, 'skill_ref.hash').value, newer.hash, 'the hash comes from the registry, not typed');

  await editor.save();
  assert.ok(
    typeof editor.state().appliedVersionId === 'string',
    'moving the pin to a registered version has to apply like any other edit',
  );
});

test('AC5 — one known version, or no skill at all, shows nothing extra (t215)', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  const only = await registerSkill(cp, '1.0.0', '# Revisar\n\nConfira a nota.');
  const registered = await registerBase(cp, graphPinnedTo(only));

  const { doc } = await openEditor(screen.url, registered.graph.id);

  assert.deepEqual(
    versionPicker(cardOf(doc, 'revisar')),
    [],
    'a lineage with a single version has nothing to offer, and says nothing',
  );

  // A node being born has an empty `skill_ref.id`, so there is no lineage to ask
  // about — and asking `GET /v1/skills?id=` would be a read with no question.
  doc.require('add-node').click();
  const fresh = cards(doc, 'node-list', 'data-node').at(-1) as FakeElement;
  assert.deepEqual(versionPicker(fresh), [], 'an empty skill_ref.id offers nothing');
});

test('AC5 — a pin the registry does not carry is shown as such, never silently swapped (t215)', async (t) => {
  const cp = await startControlPlane(t);
  const screen = await startScreen(t, cp);

  // The lineage exists and the node's version is not in it — a graph that came
  // from elsewhere, or a version somebody registered and this database never
  // saw. The `<select>` still has to say where this node stands.
  const real = await registerSkill(cp, '2.0.0', '# Revisar\n\nConfira a nota.');
  const registered = await registerBase(
    cp,
    graphPinnedTo({ id: real.id, version: '1.0.0', hash: `sha256:${'9'.repeat(64)}` }),
  );

  const { doc } = await openEditor(screen.url, registered.graph.id);

  const picker = versionPicker(cardOf(doc, 'revisar'));
  assert.equal(picker.length, 1, 'a lineage with another version has something to offer');

  const options = picker[0].byTag('option');
  const selected = options.filter((option) => option.value === '1.0.0');
  assert.equal(selected.length, 1, 'the version this node pins has to be in the list');
  assert.ok(
    selected[0].textContent.includes('not in the registry'),
    `the picker does not say the pin is unregistered: ${selected[0].textContent}`,
  );
  assert.equal(selected[0].disabled, true, 'and it is not something to choose');

  // Nothing was written: the draft still pins what the snapshot pinned.
  assert.equal(control(cardOf(doc, 'revisar'), 'skill_ref.version').value, '1.0.0');
});
