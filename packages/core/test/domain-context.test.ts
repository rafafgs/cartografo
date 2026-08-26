/**
 * Node input projection — the merge algorithm, with no database (t253, FR7).
 *
 * This is the step `specs/formats/skill-manifest.md` calls "step 2"
 * and describes as the one that does not exist: assembling the object a node's
 * `{{input.*}}` placeholders resolve against. It is tested here, pure, for the
 * same reason `domain/graph.ts` and `domain/custom-fields.ts` are: the merge is
 * a structural question over four pieces of data, and a test that has to boot a
 * server to ask it stops being able to ask the awkward cases.
 *
 * The fixture graph is declared INLINE and is not a real bundle. That is
 * deliberate (t253, Acceptance Tests): what is under test is the rule
 * `contract.produces` establishes, not what either factory bundle happens to
 * declare today — those declarations are the follow-up ticket's, and a test that
 * read them would go red the moment somebody edited a bundle for an unrelated
 * reason.
 *
 * The file name is `domain-context.test.ts` and not `domain/context.test.ts`
 * because this package's test script is a FLAT glob (`test/*.test.ts`): a file
 * in a subdirectory would never run, which is the worst possible way for an
 * acceptance test to pass.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type * as ContextModule from '../src/domain/context.ts';
import { requireArtifacts } from './support.ts';

type ContextSources = ContextModule.ContextSources;
type ProjectedSnapshot = ContextModule.ProjectedSnapshot;

/** The artifact this ticket adds; the initial red names it instead of blowing up. */
const CONTEXT_MODULE = 'src/domain/context.ts';

let loaded: typeof ContextModule | null = null;

/**
 * Loads the pure module on demand, behind the existence check.
 *
 * Same reason `support.ts` loads `src/` lazily: on the initial red the failure
 * has to NAME the missing artifact, instead of an `ERR_MODULE_NOT_FOUND` that
 * looks like any other bug.
 */
async function buildNodeInput(sources: ContextSources): Promise<Record<string, unknown>> {
  requireArtifacts(CONTEXT_MODULE);
  loaded ??= (await import('../src/domain/context.ts')) as typeof ContextModule;
  return loaded.buildNodeInput(sources);
}

/**
 * Three nodes, and the whole point is the middle one.
 *
 * `desenvolver` and `integrar` share the `artefato` bucket; `testar` sits
 * between them, declares no `produces`, and merges at the top level. If the
 * bucket were per-session rather than accumulated, `integrar`'s `merge_commit`
 * would land in an object that no longer carried `desenvolver`'s `branch` — and
 * `implantar-release`, two hops downstream, reads both.
 */
const SNAPSHOT: ProjectedSnapshot = {
  nodes: [
    { id: 'desenvolver', contract: { produces: 'artefato' } },
    { id: 'testar', contract: {} },
    { id: 'integrar', contract: { produces: 'artefato' } },
  ],
  project: {
    repo: 'git@github.com:rafaelgomes/cartografo.git',
    comando_testes: 'npm test',
  },
};

/**
 * The walk this job has already made, as the control plane reads it (t270).
 *
 * The default is the shape of a job standing on its entry node: nothing
 * executed yet, and the instant it was created as the moment it got there.
 */
const TRAVERSAL = Object.freeze({
  nodes_visited: [] as string[],
  entered_at: '2026-08-18T08:00:00.000Z',
});

/** The sources with nothing in them, so each case varies only its own piece. */
function sources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    job: { id: 253, title: 'Input projection', body: 'the raw body', fields: null },
    snapshot: SNAPSHOT,
    outputs: [],
    answered: [],
    traversal: { nodes_visited: [...TRAVERSAL.nodes_visited], entered_at: TRAVERSAL.entered_at },
    ...overrides,
  };
}

test('t253 FR7 — the job seeds input.job, and its own fields land at the top level', async () => {
  const input = await buildNodeInput(
    sources({
      job: {
        id: 253,
        title: 'Input projection',
        body: 'o corpo bruto',
        fields: { premise_source: 'nota de 2026-08-17', downside: 3, upside: 12 },
      },
    }),
  );

  assert.deepEqual(input.job, {
    id: 253,
    title: 'Input projection',
    body: 'o corpo bruto',
  });
  // Beside `input.job`, never inside it: this is what keeps bets' scalar custom
  // fields (`premise_source`, `downside`, `upside`) resolving with no bucket to
  // declare.
  assert.equal(input.premise_source, 'nota de 2026-08-17');
  assert.equal(input.downside, 3);
  assert.equal(input.upside, 12);
});

test('t253 FR7 — input.job carries a type only when the job has one', async () => {
  const untyped = await buildNodeInput(sources());
  assert.equal(
    Object.hasOwn(untyped.job as Record<string, unknown>, 'type'),
    false,
    'a job with no type declares none: the key is absent, never null',
  );

  const typed = await buildNodeInput(
    sources({
      job: { id: 253, title: 'x', body: null, type: 'feature', fields: null },
    }),
  );
  assert.equal((typed.job as Record<string, unknown>).type, 'feature');
});

test('t253 FR7 — the snapshot project object lands at input.project', async () => {
  const input = await buildNodeInput(sources());

  assert.deepEqual(input.project, {
    repo: 'git@github.com:rafaelgomes/cartografo.git',
    comando_testes: 'npm test',
  });
});

test('t253 FR7 — a class that declares no project still answers an empty object', async () => {
  for (const snapshot of [null, {}, { nodes: [] }] as (ProjectedSnapshot | null)[]) {
    const input = await buildNodeInput(sources({ snapshot }));
    assert.deepEqual(
      input.project,
      {},
      'an absent project is an honest empty object, never a missing key: a ' +
        'placeholder has to resolve for a class that declares no project config',
    );
  }
});

test('t253 FR7 — two nodes sharing a produces bucket accumulate into one object', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'desenvolver',
          output: { branch: 'ticket-253', files: 4 },
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 1,
        },
        {
          node_id: 'integrar',
          output: { merge_commit: 'a1b2c3d' },
          finished_at: '2026-08-17T11:00:00.000Z',
          session_id: 3,
        },
      ],
    }),
  );

  assert.deepEqual(input.artefato, {
    branch: 'ticket-253',
    files: 4,
    merge_commit: 'a1b2c3d',
  });
});

test('t253 FR7 — a produces-less node merges at the top, and the bucket survives it', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'desenvolver',
          output: { branch: 'ticket-253' },
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 1,
        },
        {
          node_id: 'testar',
          output: { outcome: 'pass', evidence: 'the suite passed' },
          finished_at: '2026-08-17T10:00:00.000Z',
          session_id: 2,
        },
        {
          node_id: 'integrar',
          output: { merge_commit: 'a1b2c3d' },
          finished_at: '2026-08-17T11:00:00.000Z',
          session_id: 3,
        },
      ],
    }),
  );

  assert.equal(input.outcome, 'pass', 'the gate declares no bucket: it merges at the top');
  assert.equal(input.evidence, 'the suite passed');
  assert.deepEqual(
    input.artefato,
    { branch: 'ticket-253', merge_commit: 'a1b2c3d' },
    'the bucket outlives the gate that produced no artifact of its own',
  );
});

test('t253 FR7 — the walk is in finished_at order, and the later writer wins', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'integrar',
          output: { merge_commit: 'after' },
          finished_at: '2026-08-17T11:00:00.000Z',
          session_id: 9,
        },
        {
          node_id: 'desenvolver',
          output: { merge_commit: 'before', branch: 'ticket-253' },
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 1,
        },
      ],
    }),
  );

  assert.deepEqual(input.artefato, { merge_commit: 'after', branch: 'ticket-253' });
});

test('t253 FR7 — a session whose node the snapshot does not carry merges at the top', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'no-que-nao-existe',
          output: { texto: 'a nota' },
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 1,
        },
        {
          node_id: null,
          output: { sem_no: true },
          finished_at: '2026-08-17T09:30:00.000Z',
          session_id: 2,
        },
      ],
    }),
  );

  assert.equal(input.texto, 'a nota');
  assert.equal(input.sem_no, true);
});

test('t253 FR7 — a session that reported nothing contributes nothing', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'desenvolver',
          output: null,
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 1,
        },
      ],
    }),
  );

  assert.equal(
    Object.hasOwn(input, 'artefato'),
    false,
    'an empty bucket is not the same claim as a bucket nobody filled',
  );
});

test('t253 FR7 — the answered escalations are exposed structurally', async () => {
  const input = await buildNodeInput(
    sources({
      answered: [
        { id: '4', pergunta: 'Which mapping holds?', resposta: 'Option 1: produces + project.' },
      ],
    }),
  );

  assert.deepEqual(input.perguntas_respondidas, [
    { id: '4', pergunta: 'Which mapping holds?', resposta: 'Option 1: produces + project.' },
  ]);
});

test('t253 FR7 — nothing answered is an empty list, and never a missing key', async () => {
  assert.deepEqual((await buildNodeInput(sources())).perguntas_respondidas, []);
});

test('t253 FR8 — contexto_falha is not in this ticket\'s projection', async () => {
  const input = await buildNodeInput(sources());

  assert.equal(
    Object.hasOwn(input, 'contexto_falha'),
    false,
    'deriving it needs the job\'s transition history read as a loop-detection ' +
      'question, which is the follow-up ticket (t253, FR8 / Out of Scope)',
  );
});

/* -------------------------------------------------------------------------- */
/* t270 Half A — `input.traversal`: the job's own walk, published by the        */
/* control plane.                                                              */
/*                                                                             */
/* `registrar-travessia` reads which nodes this crossing executed and when it   */
/* got where it is standing. Nothing produced either: `buildNodeInput`          */
/* assembled `input.job`, `input.project`, the buckets and                      */
/* `input.perguntas_respondidas`, and never the traversal — so the last node of */
/* the bets bundle failed closed on `UnresolvedPlaceholderError` and the        */
/* plantao patched the two values into `fields` by hand.                        */
/*                                                                             */
/* Two of the three keys come in from `sources.traversal` (the log is the       */
/* repository's to read, D1); the third is derived HERE, out of the completed   */
/* reports this function already receives.                                     */
/* -------------------------------------------------------------------------- */

test('t270 AT — input.traversal publishes what the sources declare, verbatim', async () => {
  const input = await buildNodeInput(
    sources({
      traversal: {
        nodes_visited: ['triagem', 'coleta-fundamentos', 'analise-assimetria'],
        entered_at: '2026-08-17T22:41:03.117Z',
      },
    }),
  );

  const traversal = input.traversal as Record<string, unknown>;
  assert.deepEqual(
    traversal.nodes_visited,
    ['triagem', 'coleta-fundamentos', 'analise-assimetria'],
    'the walk is a fact about the log, and this function is not the one that reads it',
  );
  assert.equal(traversal.entered_at, '2026-08-17T22:41:03.117Z');
});

test('t270 AT — sessions_by_node groups the reports by node, in closing order', async () => {
  const input = await buildNodeInput(
    sources({
      outputs: [
        {
          node_id: 'integrar',
          output: { merge_commit: 'a1b2c3d' },
          finished_at: '2026-08-17T11:00:00.000Z',
          session_id: 9,
        },
        // The second run of `desenvolver` closed LAST, and it has to sort last
        // inside its own node's array: `sessions_by_node` is a walk, not a set.
        {
          node_id: 'desenvolver',
          output: { branch: 'ticket-270-b' },
          finished_at: '2026-08-17T10:00:00.000Z',
          session_id: 4,
        },
        {
          node_id: 'desenvolver',
          output: { branch: 'ticket-270-a' },
          finished_at: '2026-08-17T09:00:00.000Z',
          session_id: 2,
        },
        // No node: a discovery session belongs to no bucket, exactly as
        // `bucketOf` already reads it.
        {
          node_id: null,
          output: { nota: 'session with no node' },
          finished_at: '2026-08-17T12:00:00.000Z',
          session_id: 11,
        },
      ],
    }),
  );

  const traversal = input.traversal as Record<string, unknown>;
  assert.deepEqual(traversal.sessions_by_node, {
    desenvolver: [2, 4],
    integrar: [9],
  });
  assert.equal(
    Object.hasOwn(traversal.sessions_by_node as Record<string, unknown>, 'null'),
    false,
    'a session with no node contributes to no key, and never to a key called "null"',
  );
});

test('t270 AT — no completed session is an empty grouping, never a missing key', async () => {
  const input = await buildNodeInput(sources());

  assert.deepEqual(
    (input.traversal as Record<string, unknown>).sessions_by_node,
    {},
    'a job that has run nothing yet resolves to an honest empty object',
  );
});
