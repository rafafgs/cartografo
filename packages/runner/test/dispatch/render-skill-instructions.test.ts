/**
 * Acceptance tests for rendering a registered skill into a session (t161,
 * FR3–FR6).
 *
 * This is the half of the ficha that closes `manifesto-skill.md`'s own "not
 * implemented yet: render `instructions` into a session". Three things have to be
 * true at once for it to be worth anything:
 *
 * - the text a session receives is the REGISTERED manifest's, plus the node's
 *   own contract — not a literal somebody typed into the dispatch;
 * - a pin that does not match refuses the dispatch BEFORE a session exists,
 *   which is the whole point of pinning by hash (D4);
 * - the permissions the session runs under are the ones the manifest declared,
 *   so `permissions` stops being a document nobody reads.
 *
 * English per D18 — the manifest's own KEYS too, since the 2026-08-15 amendment
 * (t178). The rendered CONTENT stays Portuguese, like every other prompt in this
 * package: it stands in for the manifest's free text, which is written in
 * Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as RenderModule from '../../src/dispatch/render-skill-instructions.ts';
import type * as ResolveModule from '../../src/dispatch/resolve-node.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/dispatch/render-skill-instructions.ts';

let cache: typeof RenderModule | null = null;

async function loadModule(): Promise<typeof RenderModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/dispatch/render-skill-instructions.ts', import.meta.url).href
  )) as typeof RenderModule;
  return cache;
}

async function loadClient(): Promise<typeof ClientModule> {
  return (await import(
    new URL('../../src/controller/cliente-controle.ts', import.meta.url).href
  )) as typeof ClientModule;
}

const SKILL_ID = 'travessia-conferir';
const SKILL_HASH = `sha256:${'a'.repeat(64)}`;

/** The manifest the registry gives back, in the recut this module reads. */
function registeredSkill(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SKILL_ID,
    version: '1.0.0',
    hash: SKILL_HASH,
    role: 'gate',
    description: 'Confere o artefato da etapa anterior com evidência própria.',
    input: { type: 'object', required: ['nota'] },
    output: { type: 'object', required: ['outcome'] },
    preconditions: ['a etapa anterior deixou o artefato no diretório da sessão'],
    checks: [
      {
        id: 'conferencia-com-evidencia',
        type: 'agentic',
        description: 'Portão agêntico confere com evidência própria.',
        instruction: 'Leia o artefato e diga se ele atende ao pedido.',
        required_evidence: ['saida.md'],
      },
    ],
    permissions: {
      filesystem: { read: ['**'], write: [] },
      network: { allowed: true, domains: ['127.0.0.1'] },
    },
    instructions: '# Conferir uma etapa\n\nJulgue com evidência sua, nunca com o relato de quem produziu.',
    origin: { type: 'native' },
    registrado_em: '2026-08-15T12:00:00.000Z',
    ...overrides,
  };
}

/** The node the dispatch resolved, with as many edges as the case needs. */
function resolvedNode(edges: ResolveModule.GraphEdge[], hash = SKILL_HASH): ResolveModule.ResolvedNode {
  return {
    versionId: 'sha256:cafe',
    node: {
      id: 'conferir',
      role: 'tester',
      node_type: 'gate',
      description: 'Confere o artefato e roteia.',
      skill_ref: { id: SKILL_ID, version: '1.0.0', hash },
      contract: {
        input_schema: { type: 'object', required: ['nota'] },
        output_schema: {
          type: 'object',
          required: ['outcome'],
          properties: { outcome: { enum: ['aprovado', 'retrabalho'] } },
        },
        checks: [
          { type: 'deterministic', command: 'test -s saida.md', description: 'O artefato existe.' },
        ],
      },
    },
    edges,
  };
}

const SINGLE_EDGE: ResolveModule.GraphEdge[] = [
  { from: 'conferir', to: 'publicar', condition: 'sempre' },
];
const TWO_EDGES: ResolveModule.GraphEdge[] = [
  { from: 'conferir', to: 'publicar', condition: 'aprovado' },
  { from: 'conferir', to: 'implementar', condition: 'retrabalho' },
];

/** A reader that serves one skill, or refuses with the status it is given. */
async function makeReader(
  body: Record<string, unknown> | null,
): Promise<{ read: RenderModule.ReadSkill; routes: string[] }> {
  const { ErroDoControlPlane } = await loadClient();
  const routes: string[] = [];
  const read: RenderModule.ReadSkill = async (route) => {
    routes.push(route);
    if (body === null) {
      throw new ErroDoControlPlane(`GET ${route} answered 404`, 404, { error: 'skill_nao_encontrada' });
    }
    return body as unknown as RenderModule.RegisteredSkill;
  };
  return { read, routes };
}

test('AT6 — the rendered text carries the manifest, the node contract and the escalation protocol', async () => {
  const { renderSkillInstructions, ESCALATION_PROTOCOL } = await loadModule();
  const { read, routes } = await makeReader(registeredSkill());

  const rendered = await renderSkillInstructions(resolvedNode(SINGLE_EDGE), read);

  assert.ok(rendered !== null, 'a node with a registered, correctly pinned skill renders');
  assert.deepEqual(routes, [`/v1/skills/${SKILL_ID}`], 'the registry is keyed by the skill id');

  const text = rendered.instructions;

  // 1. the escalation protocol, verbatim: a session that does not know how to
  // ask never asks, and this ficha is the first thing that dispatches sessions
  // WITHOUT the fixed literal that used to carry it.
  assert.ok(
    text.includes(ESCALATION_PROTOCOL),
    'the escalation protocol has to travel with every rendered instruction',
  );
  assert.ok(ESCALATION_PROTOCOL.includes('```input-request'), 'and it is the block, not a mention of it');

  // 2. the manifest itself.
  assert.ok(text.includes('Confere o artefato da etapa anterior com evidência própria.'));
  assert.ok(
    text.includes('Julgue com evidência sua, nunca com o relato de quem produziu.'),
    'the skill instructions are rendered verbatim',
  );
  assert.ok(text.includes(SKILL_ID) && text.includes(SKILL_HASH), 'the session is told what it is pinned to');

  // 3. the node's OWN contract — which is where the routing vocabulary lives,
  // not in the manifest's `output` (`docs/spec/grafo.md`).
  assert.ok(text.includes('"aprovado"') && text.includes('"retrabalho"'));
  assert.ok(text.includes('test -s saida.md'), 'the node verifications are part of the contract');

  // 4. checks and permissions, for the session's own visibility.
  assert.ok(text.includes('conferencia-com-evidencia'));
  assert.ok(text.includes('required_evidence'));
  assert.ok(text.includes('"write"') && text.includes('"allowed"'));
});

test('AT7 — an unregistered skill refuses to render at all', async () => {
  const { renderSkillInstructions, SkillNotRegisteredError } = await loadModule();
  const { read } = await makeReader(null);

  await assert.rejects(
    async () => renderSkillInstructions(resolvedNode(SINGLE_EDGE), read),
    (error: unknown) => {
      assert.ok(
        error instanceof SkillNotRegisteredError,
        `expected SkillNotRegisteredError, got: ${String(error)}`,
      );
      assert.equal(error.nodeId, 'conferir');
      assert.equal(error.skillId, SKILL_ID);
      assert.ok(error.message.includes('conferir'), error.message);
      assert.ok(error.message.includes(SKILL_ID), error.message);
      return true;
    },
  );
});

test('AT8 — a hash that does not match the registered one refuses to render', async () => {
  const { renderSkillInstructions, SkillPinMismatchError } = await loadModule();
  const { read } = await makeReader(registeredSkill());

  const declared = `sha256:${'b'.repeat(64)}`;

  await assert.rejects(
    async () => renderSkillInstructions(resolvedNode(SINGLE_EDGE, declared), read),
    (error: unknown) => {
      assert.ok(
        error instanceof SkillPinMismatchError,
        `expected SkillPinMismatchError, got: ${String(error)}`,
      );
      assert.equal(error.nodeId, 'conferir');
      assert.equal(error.declared, declared);
      assert.equal(error.registered, SKILL_HASH);
      assert.match(error.message, new RegExp(declared));
      assert.match(error.message, new RegExp(SKILL_HASH));
      return true;
    },
  );
});

test('AT9 — the routing protocol is appended only when the node has more than one way out', async () => {
  const { renderSkillInstructions } = await loadModule();

  const single = await renderSkillInstructions(
    resolvedNode(SINGLE_EDGE),
    (await makeReader(registeredSkill())).read,
  );
  const none = await renderSkillInstructions(
    resolvedNode([]),
    (await makeReader(registeredSkill())).read,
  );
  const gate = await renderSkillInstructions(
    resolvedNode(TWO_EDGES),
    (await makeReader(registeredSkill())).read,
  );

  assert.ok(single !== null && none !== null && gate !== null);

  assert.ok(
    !single.instructions.includes('```resultado'),
    'a node with one way out is deterministic: asking it to choose invents a decision',
  );
  assert.ok(!none.instructions.includes('```resultado'));

  assert.ok(gate.instructions.includes('```resultado'), 'a gate is told how to report its outcome');
  // The exact `condition` labels of THIS node, so the session is choosing from
  // the real edges and not from a vocabulary somebody remembered.
  assert.ok(gate.instructions.includes('aprovado'));
  assert.ok(gate.instructions.includes('retrabalho'));
});

test('AT10 — the manifest permissions become the session permissions', async () => {
  const { renderSkillInstructions } = await loadModule();

  const gate = await renderSkillInstructions(
    resolvedNode(TWO_EDGES),
    (await makeReader(registeredSkill())).read,
  );
  assert.ok(gate !== null);
  assert.deepEqual(gate.permissions, {
    filesystem: { write: [] },
    network: { allowed: true, domains: ['127.0.0.1'] },
  });

  // A closed network carries no domains: the manifest's own rule is that
  // `domains` is ignored when `allowed` is false, and carrying it here would
  // make the policy resolution refuse a session the manifest never restricted.
  const closed = await renderSkillInstructions(
    resolvedNode(SINGLE_EDGE),
    (
      await makeReader(
        registeredSkill({
          permissions: {
            filesystem: { read: ['**'], write: ['**'] },
            network: { allowed: false, domains: ['example.com'] },
          },
        }),
      )
    ).read,
  );
  assert.ok(closed !== null);
  assert.deepEqual(closed.permissions, {
    filesystem: { write: ['**'] },
    network: { allowed: false },
  });
});

test('AT11 — a node that declares no skill_ref renders nothing, instead of inventing one', async () => {
  const { renderSkillInstructions } = await loadModule();
  const { read, routes } = await makeReader(registeredSkill());

  const node = resolvedNode(SINGLE_EDGE);
  delete node.node.skill_ref;

  assert.equal(
    await renderSkillInstructions(node, read),
    null,
    'nothing is pinned, so there is nothing to refuse and nothing to render',
  );
  assert.deepEqual(routes, [], 'and the registry was never asked');
});
