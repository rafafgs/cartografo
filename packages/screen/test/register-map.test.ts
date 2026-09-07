/**
 * Acceptance tests of the map's registration half (t432, RF-24).
 *
 * `register-map.ts` is pure orchestration: it closes the draft's pins and then
 * offers the result to an injected client, in a fixed order, stopping at the
 * first refusal. Nothing here opens a socket, and nothing here renders — the
 * page that will call it is t433's.
 *
 * Two things the tests below exist to hold down, and they are different in
 * kind:
 *
 * - **the hash recipe is a copy**, and a copy of a pin is a pin waiting to
 *   drift. D11 forbids the screen from importing `packages/core`, so the recipe
 *   cannot be shared the way `import.ts` and the registry share it — AT1 pins
 *   the port against real content instead, by recomputing every manifest of
 *   factory bundle 1 and demanding the hash the bundle already declares.
 * - **the ORDER of the calls carries meaning.** Manifests go up one at a time,
 *   in the draft's own order, and the graph only after every one of them was
 *   accepted: a class whose nodes pin a capability the registry refused is a
 *   class nobody can dispatch. Stopping partway leaves what was already
 *   accepted registered, exactly as `cartografo import` does — this module owns
 *   no transaction across the API either.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as RegisterMapModule from '../src/register-map.ts';
import { requireArtifacts } from './support.ts';

/** Factory bundle 1's manifests — the reference content of AT1. */
const FACTORY_SKILLS = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'factory-graphs',
  'software-development',
  'skills',
);

async function load(): Promise<typeof RegisterMapModule> {
  requireArtifacts('src/register-map.ts');
  return (await import(
    new URL('../src/register-map.ts', import.meta.url).href
  )) as typeof RegisterMapModule;
}

/**
 * A manifest as the interview writes it: everything the format requires except
 * `hash`, which is what this module computes (t360 FR2d/FR6).
 */
function draftManifest(
  id: string,
  version: string,
  instructions = `Do the ${id} step.`,
): RegisterMapModule.MapDraftManifest {
  return {
    id,
    version,
    role: 'work',
    description: `The ${id} step of the interviewed map.`,
    input: { type: 'object', properties: { topic: { type: 'string' } } },
    output: { type: 'object', required: ['note'], properties: { note: { type: 'string' } } },
    preconditions: [],
    checks: [
      {
        id: 'note-exists',
        type: 'deterministic',
        description: 'The note exists and is not empty.',
        command: 'test -s note.md',
      },
    ],
    permissions: { filesystem: { read: ['**'], write: ['note.md'] }, network: { allowed: false } },
    instructions,
    origin: { type: 'native' },
  };
}

/** A node as the draft carries it: `skill_ref` pinned by id and version, never by hash. */
function draftNode(id: string, skillId: string, version?: string): RegisterMapModule.MapDraftNode {
  return {
    id,
    role: 'author',
    node_type: 'work',
    description: `Node ${id}.`,
    skill_ref: version === undefined ? { id: skillId } : { id: skillId, version },
    contract: { input_schema: {}, output_schema: {}, checks: [] },
  };
}

/** A two-node draft whose pins close. */
function closedDraft(): RegisterMapModule.MapDraft {
  return {
    graph: {
      problem_class: 'widget-triage',
      nodes: [draftNode('triage', 'triage-widget', '1.0.0'), draftNode('review', 'review-widget', '2.1.0')],
    },
    skills: [draftManifest('triage-widget', '1.0.0'), draftManifest('review-widget', '2.1.0')],
  };
}

/** What the fake client recorded, in the order it happened. */
interface Recorded {
  /** One entry per call, in order: `skill:<id>` or `graph:<problem_class>`. */
  order: string[];
  skills: { manifest: Record<string, unknown>; filter: unknown }[];
  graphs: { document: Record<string, unknown>; filter: unknown }[];
}

/**
 * A hand-written client of the narrow interface the module declares.
 *
 * It throws the way every `ApiClient` method already throws — an `ApiError`
 * shaped `{status, body}` — which is the whole reason the interface was written
 * that way: wiring the real client up later (t433) adds two methods of this
 * shape and teaches the class no second calling convention.
 *
 * @param behaviour What to throw, and where.
 * @returns The client and the log of what it was asked to do.
 */
function fakeClient(
  behaviour: {
    skillThrows?: (manifest: Record<string, unknown>, index: number) => unknown;
    graphThrows?: () => unknown;
    graphResult?: { graph: unknown; graph_version: unknown };
  } = {},
): { client: RegisterMapModule.RegisterMapClient; calls: Recorded } {
  const calls: Recorded = { order: [], skills: [], graphs: [] };
  const client: RegisterMapModule.RegisterMapClient = {
    async registerSkill(manifest, filter) {
      const index = calls.skills.length;
      calls.order.push(`skill:${String(manifest.id)}`);
      calls.skills.push({ manifest, filter });
      const failure = behaviour.skillThrows?.(manifest, index);
      if (failure !== undefined) throw failure;
      return { id: manifest.id };
    },
    async registerGraph(document, filter) {
      calls.order.push(`graph:${String(document.problem_class)}`);
      calls.graphs.push({ document, filter });
      const failure = behaviour.graphThrows?.();
      if (failure !== undefined) throw failure;
      return behaviour.graphResult ?? { graph: { id: 7 }, graph_version: { id: 'sha256:abc' } };
    },
  };
  return { client, calls };
}

/* -------------------------------------------------------------- manifestHash */

test('AT1 — the ported recipe reproduces every pin of factory bundle 1', async () => {
  const { manifestHash } = await load();

  const files = readdirSync(FACTORY_SKILLS)
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.equal(files.length, 5, 'factory bundle 1 declares five skills');

  for (const file of files) {
    const manifest = JSON.parse(
      readFileSync(path.join(FACTORY_SKILLS, file), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(
      manifestHash(manifest),
      manifest.hash,
      `${file}: the screen's copy of the recipe disagrees with the pin the bundle declares`,
    );
  }
});

test('AT1 — the recipe never reads the pin it is recomputing', async () => {
  const { manifestHash } = await load();
  const manifest = draftManifest('triage-widget', '1.0.0');

  assert.equal(
    manifestHash({ ...manifest, hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }),
    manifestHash(manifest),
    'a manifest carrying a hash hashes exactly like the same manifest without one',
  );
  assert.equal(
    manifestHash({ ...manifest, id: 'renamed', version: '9.9.9' }),
    manifestHash(manifest),
    'catalogue metadata is outside the subset: renaming a skill does not move its pin',
  );
  assert.notEqual(
    manifestHash({ ...manifest, instructions: 'Do something else entirely.' }),
    manifestHash(manifest),
    'the instructions ARE the content: editing them moves the pin (D4)',
  );
});

/* -------------------------------------------------------------- fillSkillRefs */

test('AT2 — fillSkillRefs closes every pin and touches nothing of the draft', async () => {
  const { fillSkillRefs, manifestHash } = await load();
  const draft = closedDraft();
  const before = structuredClone(draft);

  const result = fillSkillRefs(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const nodes = result.graph.nodes as { id: string; skill_ref: Record<string, unknown> }[];
  assert.deepEqual(
    nodes.map((node) => node.skill_ref),
    [
      { id: 'triage-widget', version: '1.0.0', hash: manifestHash(draft.skills[0]) },
      { id: 'review-widget', version: '2.1.0', hash: manifestHash(draft.skills[1]) },
    ],
    'every node carries the hash of the manifest it names',
  );
  assert.deepEqual(
    result.manifests.map((manifest) => [manifest.id, manifest.hash]),
    [
      ['triage-widget', manifestHash(draft.skills[0])],
      ['review-widget', manifestHash(draft.skills[1])],
    ],
    'the manifests come back in the draft order, each carrying the same hash',
  );
  assert.deepEqual(draft, before, 'the draft is input, never a scratch pad');
});

test('AT3 — an unmatched pin is reported for every node, not just the first', async () => {
  const { fillSkillRefs } = await load();
  const draft = closedDraft();
  draft.graph.nodes = [
    draftNode('triage', 'triage-widget', '1.0.0'),
    draftNode('review', 'nobody-wrote-this', '2.1.0'),
    { id: 'deploy', role: 'operator', node_type: 'work', contract: {} },
  ];

  const result = fillSkillRefs(draft);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.deepEqual(
    result.problems.map((problem) => problem.code),
    ['unmatched_skill_ref', 'unmatched_skill_ref'],
    'the sweep checks every node — a broken pin does not stop it',
  );
  assert.match(result.problems[0].message, /review/);
  assert.match(result.problems[0].message, /nobody-wrote-this/);
  assert.match(result.problems[1].message, /deploy/);
});

test('AT4 — a version the manifest disagrees with is a mismatch, naming both', async () => {
  const { fillSkillRefs } = await load();
  const draft = closedDraft();
  draft.graph.nodes = [
    draftNode('triage', 'triage-widget', '1.0.0'),
    draftNode('review', 'review-widget', '1.4.2'),
  ];

  const result = fillSkillRefs(draft);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.deepEqual(result.problems.map((problem) => problem.code), ['version_mismatch']);
  assert.match(result.problems[0].message, /1\.4\.2/);
  assert.match(result.problems[0].message, /2\.1\.0/);
});

/* ----------------------------------------------------------------- registerMap */

test('AT5 — registerMap sends every manifest, in order, and then the graph', async () => {
  const { registerMap, manifestHash } = await load();
  const draft = closedDraft();
  const { client, calls } = fakeClient({
    graphResult: { graph: { id: 42, class: 'widget-triage' }, graph_version: { id: 'sha256:beef' } },
  });

  const result = await registerMap(client, draft, { project_id: 3 });

  assert.deepEqual(result, {
    ok: true,
    graph: { id: 42, class: 'widget-triage' },
    graphVersion: { id: 'sha256:beef' },
  });
  assert.deepEqual(
    calls.order,
    ['skill:triage-widget', 'skill:review-widget', 'graph:widget-triage'],
    'the graph is the last call, and only after every manifest was accepted',
  );
  assert.deepEqual(
    calls.skills.map((call) => call.manifest.hash),
    [manifestHash(draft.skills[0]), manifestHash(draft.skills[1])],
    'each manifest went up with its pin already computed',
  );
  assert.deepEqual(
    calls.skills.map((call) => call.filter),
    [{ project_id: 3 }, { project_id: 3 }],
    'the scope rides on every call',
  );
  const document = calls.graphs[0].document as { nodes: { skill_ref: Record<string, unknown> }[] };
  assert.deepEqual(document.nodes.map((node) => node.skill_ref.hash), [
    manifestHash(draft.skills[0]),
    manifestHash(draft.skills[1]),
  ]);
  assert.deepEqual(calls.graphs[0].filter, { project_id: 3 });
});

test('AT6 — a broken pin reaches no client at all', async () => {
  const { registerMap } = await load();
  const draft = closedDraft();
  draft.graph.nodes = [draftNode('triage', 'nobody-wrote-this', '1.0.0')];
  const { client, calls } = fakeClient();

  const result = await registerMap(client, draft);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.stage, 'pin');
  if (result.stage !== 'pin') return;
  assert.deepEqual(result.problems.map((problem) => problem.code), ['unmatched_skill_ref']);
  assert.deepEqual(calls.order, [], 'a draft with a broken pin never becomes a request');
});

test('AT7 — the loop stops at the first skill the registry refuses', async () => {
  const { registerMap } = await load();
  const draft: RegisterMapModule.MapDraft = {
    graph: {
      problem_class: 'widget-triage',
      nodes: [
        draftNode('one', 'skill-one', '1.0.0'),
        draftNode('two', 'skill-two', '1.0.0'),
        draftNode('three', 'skill-three', '1.0.0'),
      ],
    },
    skills: [
      draftManifest('skill-one', '1.0.0'),
      draftManifest('skill-two', '1.0.0'),
      draftManifest('skill-three', '1.0.0'),
    ],
  };
  const refusal = { status: 409, body: { error: 'skill_version_conflict' } };
  const { client, calls } = fakeClient({
    skillThrows: (_manifest, index) => (index === 1 ? refusal : undefined),
  });

  const result = await registerMap(client, draft);

  assert.deepEqual(result, {
    ok: false,
    stage: 'skill',
    skillId: 'skill-two',
    status: 409,
    body: { error: 'skill_version_conflict' },
  });
  assert.deepEqual(
    calls.order,
    ['skill:skill-one', 'skill:skill-two'],
    'the third manifest and the graph were never sent',
  );
});

test('AT8 — the graph refusal comes back verbatim, with its stage', async () => {
  const { registerMap } = await load();
  const body = { error: 'invalid_graph', soundness: { violations: [{ rule: 'reachable' }] } };
  const { client, calls } = fakeClient({ graphThrows: () => ({ status: 422, body }) });

  const result = await registerMap(client, closedDraft());

  assert.deepEqual(result, { ok: false, stage: 'graph', status: 422, body });
  assert.deepEqual(calls.order, ['skill:triage-widget', 'skill:review-widget', 'graph:widget-triage']);
});

test('AT9 — a transport failure is not a refusal, and propagates unchanged', async () => {
  const { registerMap } = await load();
  const transport = new Error('ECONNREFUSED');
  const { client } = fakeClient({ skillThrows: () => transport });

  await assert.rejects(
    async () => await registerMap(client, closedDraft()),
    (error: unknown) => error === transport,
  );
});
