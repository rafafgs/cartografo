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
 * The AT12–AT18 block at the bottom is t204, and it closes the other half of the
 * same sentence: `{{input.<caminho>}}` used to reach the model as literal text,
 * silently. Now it resolves against the node's input — or the render refuses,
 * before any session exists, which is the fail-closed rule the manifest format
 * decided long before there was an engine to obey it.
 *
 * English per D18 — the manifest's own KEYS too, since the 2026-08-15 amendment
 * (t178). The rendered CONTENT stays Portuguese, like every other prompt in this
 * package: it stands in for the manifest's free text, which is written in
 * Portuguese.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ClientModule from '../../src/controller/cliente-controle.ts';
import type * as RenderModule from '../../src/dispatch/render-skill-instructions.ts';
import type * as ResolveModule from '../../src/dispatch/resolve-node.ts';
import { composeSingleArgument, type SessionSpec } from '../../src/engine/types.ts';

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

  const rendered = await renderSkillInstructions(resolvedNode(SINGLE_EDGE), read, {});

  assert.ok(rendered !== null, 'a node with a registered, correctly pinned skill renders');
  // Keyed by the id AND the version the node pins, since t215: the registry
  // carries a lineage now, and asking by id alone would resolve "the latest".
  assert.deepEqual(routes, [`/v1/skills/${SKILL_ID}?version=1.0.0`], 'the pin names the version it asks for');

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
    async () => renderSkillInstructions(resolvedNode(SINGLE_EDGE), read, {}),
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
    async () => renderSkillInstructions(resolvedNode(SINGLE_EDGE, declared), read, {}),
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
    {},
  );
  const none = await renderSkillInstructions(
    resolvedNode([]),
    (await makeReader(registeredSkill())).read,
    {},
  );
  const gate = await renderSkillInstructions(
    resolvedNode(TWO_EDGES),
    (await makeReader(registeredSkill())).read,
    {},
  );

  assert.ok(single !== null && none !== null && gate !== null);

  // The claim is about the ROUTING half, and it is the same claim it always
  // was: a node with one way out is deterministic, and asking it to choose
  // invents a decision it does not have. What changed in t259 is that every
  // node with an `output_schema` is now told to REPORT — the block is there for
  // all three, and only the gate is asked to name an edge inside it.
  assert.ok(
    !single.instructions.includes('mais de uma saída'),
    'a node with one way out is deterministic: asking it to choose invents a decision',
  );
  assert.ok(!none.instructions.includes('mais de uma saída'));

  assert.ok(gate.instructions.includes('```resultado'), 'a gate is told how to report its outcome');
  assert.ok(gate.instructions.includes('mais de uma saída'));
  // The exact `condition` labels of THIS node, so the session is choosing from
  // the real edges and not from a vocabulary somebody remembered.
  assert.ok(gate.instructions.includes('aprovado'));
  assert.ok(gate.instructions.includes('retrabalho'));
});

/* -- t259: every node is told how to report, not just the ones that route --- */

/** The same node, with whatever `contract` the case needs. */
function nodeWithContract(
  edges: ResolveModule.GraphEdge[],
  contract: Record<string, unknown>,
): ResolveModule.ResolvedNode {
  const base = resolvedNode(edges);
  return { ...base, node: { ...base.node, contract } };
}

/** Renders that node and gives back the text. */
async function renderContract(
  edges: ResolveModule.GraphEdge[],
  contract: Record<string, unknown>,
): Promise<string> {
  const { renderSkillInstructions } = await loadModule();
  const rendered = await renderSkillInstructions(
    nodeWithContract(edges, contract),
    (await makeReader(registeredSkill())).read,
    {},
  );
  assert.ok(rendered !== null, 'the node pins a registered skill, so it renders');
  return rendered.instructions;
}

/**
 * The other half of the routing protocol, and the half nothing carried (t259).
 *
 * `routingProtocol` only ever spoke to a node with two or more ways out, and it
 * only ever asked for a routing label. So a `work` node — every node of the
 * software bundle but one — was handed an `output_schema` in its prompt, told
 * it would be checked against it, and never told HOW to hand its result back.
 * There was no producer for `session.output` at all, which is what the next
 * node's `input` is projected from.
 */
test('t259 AT5 — a single-edge node with an output_schema is told to report it', async () => {
  const OUTPUT_SCHEMA = {
    type: 'object',
    required: ['branch'],
    properties: { branch: { type: 'string' } },
  };
  const text = await renderContract(SINGLE_EDGE, {
    input_schema: { type: 'object' },
    output_schema: OUTPUT_SCHEMA,
    checks: [],
  });

  assert.ok(
    text.includes('```resultado'),
    'a work node with a contract to fulfil has to be told how to hand its result back',
  );
  assert.ok(
    !text.includes('mais de uma saída'),
    'and it is never asked to choose an edge it does not have',
  );
});

test('t259 AT5 — a node with more than one way out gets ONE merged block', async () => {
  const text = await renderContract(TWO_EDGES, {
    input_schema: { type: 'object' },
    output_schema: {
      type: 'object',
      required: ['outcome'],
      properties: { outcome: { enum: ['pass', 'fail'] } },
    },
    checks: [],
  });

  assert.equal(
    text.split('```resultado').length - 1,
    1,
    'the routing label is a FIELD of the report, never a second block beside it',
  );
  assert.ok(text.includes('mais de uma saída'), 'the gate is still told it decides');
  assert.ok(text.includes('aprovado') && text.includes('retrabalho'), 'and with its real labels');
});

test('t259 AT5 — a node with no output_schema is told nothing about reporting', async () => {
  const empty = await renderContract(SINGLE_EDGE, {
    input_schema: { type: 'object' },
    output_schema: {},
    checks: [],
  });
  const absent = await renderContract(SINGLE_EDGE, { input_schema: { type: 'object' }, checks: [] });

  for (const text of [empty, absent]) {
    assert.ok(
      !text.includes('```resultado'),
      'there is nothing to conform to, so there is nothing to ask for',
    );
  }
});

test('AT10 — the manifest permissions become the session permissions', async () => {
  const { renderSkillInstructions } = await loadModule();

  const gate = await renderSkillInstructions(
    resolvedNode(TWO_EDGES),
    (await makeReader(registeredSkill())).read,
    {},
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
    {},
  );
  assert.ok(closed !== null);
  assert.deepEqual(closed.permissions, {
    filesystem: { write: ['**'] },
    network: { allowed: false },
  });
});

/* -------------------------------------------------------------------------- */
/* t167 — the escalation paragraph is per node, not one paragraph for all      */
/* -------------------------------------------------------------------------- */

/** The same node as above, declaring a policy (or deliberately declaring none). */
function nodeWithPolicy(policy: string | undefined): ResolveModule.ResolvedNode {
  const resolved = resolvedNode(SINGLE_EDGE);
  if (policy !== undefined) {
    (resolved.node as unknown as Record<string, unknown>).escalation_policy = policy;
  }
  return resolved;
}

/** Renders one node against the standard manifest. */
async function renderPolicy(policy: string | undefined): Promise<string> {
  const { renderSkillInstructions } = await loadModule();
  const rendered = await renderSkillInstructions(
    nodeWithPolicy(policy),
    (await makeReader(registeredSkill())).read,
    {},
  );
  assert.ok(rendered !== null);
  return rendered.instructions;
}

test('t167 — a "never" node is told it has nobody to ask, and never how to ask', async () => {
  const { NEVER_ESCALATION_PROTOCOL } = await loadModule();
  const text = await renderPolicy('never');

  assert.ok(
    text.includes(NEVER_ESCALATION_PROTOCOL),
    'the session has to be told, in words, that this node has nobody to ask',
  );
  assert.ok(
    !text.includes('```input-request'),
    'and it must not be handed the template for a block the runner will not turn into a question',
  );
  assert.ok(
    !NEVER_ESCALATION_PROTOCOL.includes('```input-request'),
    'the paragraph itself is what replaces the fence, not something that carries it',
  );
});

test('t167 — an "always" node keeps the block and is told to use it before closing', async () => {
  const { ESCALATION_PROTOCOL, ALWAYS_ESCALATION_PROTOCOL } = await loadModule();
  const text = await renderPolicy('always');

  assert.ok(
    text.includes(ESCALATION_PROTOCOL),
    'always still escalates through the same block: the addition is on top of it',
  );
  assert.ok(
    text.includes(ALWAYS_ESCALATION_PROTOCOL),
    'plus the sentence that makes it escalate even when it believes it knows',
  );
});

test('t167 — a node with no policy renders exactly what it rendered before', async () => {
  const { ESCALATION_PROTOCOL, ALWAYS_ESCALATION_PROTOCOL, NEVER_ESCALATION_PROTOCOL } =
    await loadModule();

  const absent = await renderPolicy(undefined);
  const declared = await renderPolicy('on_uncertainty');

  assert.equal(
    absent,
    declared,
    'declaring the default has to be indistinguishable from declaring nothing',
  );

  // The regression pin, in the layout t261 moved it to: the paragraph is the
  // LAST section of the text, separated by the same divider every other section
  // uses, and neither of the two other paragraphs appears anywhere in it. It
  // used to be the first thing in the text, and that is precisely what made
  // every claude-code session on this prompt come back refused.
  assert.ok(
    !absent.startsWith(ESCALATION_PROTOCOL),
    'the rendered text may not OPEN with the escalation paragraph (t261)',
  );
  assert.ok(
    absent.endsWith(`\n\n---\n\n${ESCALATION_PROTOCOL}`),
    'nothing may be inserted around the paragraph every session already had',
  );
  assert.ok(!absent.includes(ALWAYS_ESCALATION_PROTOCOL));
  assert.ok(!absent.includes(NEVER_ESCALATION_PROTOCOL));
});

/* -------------------------------------------------------------------------- */
/* t261 — the escalation paragraph renders LAST, and never opens the prompt    */
/*                                                                            */
/* Measured, not guessed (plantão, 2026-08-17): `claude --print` answers       */
/* `stop_reason: "refusal"` with `stop_details.category:                       */
/* "reasoning_extraction"` on the exact prompt this module rendered for the    */
/* node `triagem`, 5/5. The bisection isolated it to POSITION: the same        */
/* paragraph moved to the end of the same prompt reaches `end_turn` 2/2, and a */
/* softer rewording left at the top still refuses. A fenced JSON template that */
/* OPENS a system prompt is what the safeguard classifier bites on.            */
/* -------------------------------------------------------------------------- */

test('t261 — the rendered instructions never open with the escalation block', async () => {
  const { ESCALATION_PROTOCOL, ALWAYS_ESCALATION_PROTOCOL, NEVER_ESCALATION_PROTOCOL } =
    await loadModule();

  for (const policy of [undefined, 'on_uncertainty', 'always', 'never']) {
    const text = await renderPolicy(policy);
    assert.ok(
      !text.trimStart().startsWith('```input-request'),
      `a "${String(policy)}" node's prompt may not open with the fence: it is refused before it runs`,
    );
    assert.ok(
      text.startsWith('# Nó `conferir` — skill'),
      `a "${String(policy)}" node's prompt opens with the node header, and with nothing before it`,
    );
  }

  assert.ok(!(await renderPolicy(undefined)).startsWith(ESCALATION_PROTOCOL));
  assert.ok(!(await renderPolicy('on_uncertainty')).startsWith(ESCALATION_PROTOCOL));
  assert.ok(
    !(await renderPolicy('always')).startsWith(`${ESCALATION_PROTOCOL}\n\n${ALWAYS_ESCALATION_PROTOCOL}`),
    'the `always` variant is the same paragraph plus a sentence, and it moves with it',
  );
  assert.ok(!(await renderPolicy('never')).startsWith(NEVER_ESCALATION_PROTOCOL));
});

test('t261 — the escalation paragraph lands after the result-report block', async () => {
  const { ESCALATION_PROTOCOL, ALWAYS_ESCALATION_PROTOCOL, NEVER_ESCALATION_PROTOCOL } =
    await loadModule();

  // The standard node declares an `output_schema`, so `resultProtocol` renders
  // the report block — and the bisected position is AFTER it, not merely
  // "somewhere below the top". (The fence is spelled only inside string
  // literals here: a triple backtick in a comment desyncs the D18 sweep's
  // masking scanner, `test/no-portuguese-identifiers.test.ts`.)
  const cases: ReadonlyArray<readonly [string | undefined, string]> = [
    [undefined, ESCALATION_PROTOCOL],
    ['always', ALWAYS_ESCALATION_PROTOCOL],
    ['never', NEVER_ESCALATION_PROTOCOL],
  ];

  for (const [policy, paragraph] of cases) {
    const text = await renderPolicy(policy);
    const report = text.indexOf('```resultado');
    assert.ok(report > 0, `the "${String(policy)}" case renders a report block, or it proves nothing`);
    assert.ok(
      text.indexOf(paragraph) > report,
      `a "${String(policy)}" node's escalation paragraph has to come after the report block`,
    );
  }
});

test('t261 — the codex composition still does not open with the fence', async () => {
  const { renderSkillInstructions, ESCALATION_PROTOCOL } = await loadModule();

  const rendered = await renderSkillInstructions(
    resolvedNode(SINGLE_EDGE),
    (await makeReader(registeredSkill())).read,
    {},
  );
  assert.ok(rendered !== null);

  // The other adapter reads the SAME string: claude-code hands it to
  // `--system-prompt`, codex concatenates it ahead of the prompt. Reordering
  // inside the renderer is what fixes both, and this is that claim run rather
  // than read.
  const spec: SessionSpec = {
    workingDir: '/tmp/t261',
    instructions: rendered.instructions,
    prompt: 'Faça o que o nó pede.',
    timeoutSeconds: 60,
  };
  const composed = composeSingleArgument(spec);

  assert.ok(!composed.trimStart().startsWith('```input-request'));
  assert.ok(!composed.startsWith(ESCALATION_PROTOCOL), 'and not with the paragraph that carries it');
  assert.ok(composed.includes(ESCALATION_PROTOCOL), 'the paragraph still travels — only its place moved');
});

test('AT11 — a node that declares no skill_ref renders nothing, instead of inventing one', async () => {
  const { renderSkillInstructions } = await loadModule();
  const { read, routes } = await makeReader(registeredSkill());

  const node = resolvedNode(SINGLE_EDGE);
  delete node.node.skill_ref;

  assert.equal(
    await renderSkillInstructions(node, read, {}),
    null,
    'nothing is pinned, so there is nothing to refuse and nothing to render',
  );
  assert.deepEqual(routes, [], 'and the registry was never asked');
});

/* -------------------------------------------------------------------------- */
/* t204 — the placeholders resolve, or no session opens at all                 */
/* -------------------------------------------------------------------------- */

/**
 * Renders the standard node against a manifest carrying `instructions`.
 *
 * The pin is untouched on purpose: what these cases are about is the body, and
 * the two refusals that come before it already have their own tests above.
 */
async function renderBody(
  instructions: string,
  input: Record<string, unknown>,
): Promise<string> {
  const { renderSkillInstructions } = await loadModule();
  const rendered = await renderSkillInstructions(
    resolvedNode(SINGLE_EDGE),
    (await makeReader(registeredSkill({ instructions }))).read,
    input,
  );
  assert.ok(rendered !== null);
  return rendered.instructions;
}

/** The one refusal this ficha adds, loaded and checked for existence first. */
async function loadUnresolvedError(): Promise<typeof RenderModule.UnresolvedPlaceholderError> {
  const module = await loadModule();
  assert.equal(
    typeof module.UnresolvedPlaceholderError,
    'function',
    'artifact does not exist yet: UnresolvedPlaceholderError',
  );
  return module.UnresolvedPlaceholderError;
}

/** Renders a body that cannot resolve, and hands back the refusal it produced. */
async function refusalOf(
  instructions: string,
  input: Record<string, unknown>,
): Promise<RenderModule.UnresolvedPlaceholderError> {
  const { renderSkillInstructions } = await loadModule();
  const UnresolvedPlaceholderError = await loadUnresolvedError();

  let refusal: RenderModule.UnresolvedPlaceholderError | null = null;
  await assert.rejects(
    async () =>
      renderSkillInstructions(
        resolvedNode(SINGLE_EDGE),
        (await makeReader(registeredSkill({ instructions }))).read,
        input,
      ),
    (error: unknown) => {
      assert.ok(
        error instanceof UnresolvedPlaceholderError,
        `expected UnresolvedPlaceholderError, got: ${String(error)}`,
      );
      refusal = error;
      return true;
    },
  );

  assert.ok(refusal !== null);
  return refusal;
}

test('AT12 — a path that resolves to a string substitutes the string verbatim', async () => {
  // The value carries `<`, `&` and quotes on purpose: FR3 decides there is no
  // escaping, because what is being injected is a manifest a human reviewed at
  // the import gate (D4). A renderer that escaped here would be silently
  // rewriting the reviewed text.
  const title = 'Navelar Logística (NVLR3) — "reprecificação" & <venda do braço rodoviário>';
  const text = await renderBody(
    '**Tese:** {{input.tese_triada.titulo}} ({{input.tese_triada.ativo}})',
    { tese_triada: { titulo: title, ativo: 'NVLR3' } },
  );

  assert.ok(
    text.includes(`**Tese:** ${title} (NVLR3)`),
    'the string goes in exactly as it came, with no escaping and no quoting',
  );
  assert.ok(!text.includes('{{'), 'and nothing that looks like a placeholder survives');
});

test('AT13 — a path that resolves to any other JSON value substitutes its compact JSON', async () => {
  const scope = [
    'termos da venda do braço rodoviário: preço, forma de pagamento e passivos que ficam',
    'contrato portuário: prazo, cláusula de reajuste e concentração de cliente',
  ];

  const text = await renderBody(
    [
      'Frentes: {{input.tese_triada.escopo_de_pesquisa}}',
      'Posições: {{input.carteira.posicoes_abertas}}',
      'Descartada: {{input.tese_triada.descartada}}',
      'Nota: {{input.tese_triada.nota}}',
      'Carteira: {{input.carteira}}',
    ].join('\n'),
    {
      tese_triada: { escopo_de_pesquisa: scope, descartada: false, nota: null },
      carteira: { posicoes_abertas: 7, exposicao_atual_pct: 62.5 },
    },
  );

  // `JSON.stringify` with no spacing argument IS the compact form, so comparing
  // against it is what proves no whitespace was added on the way in.
  assert.ok(text.includes(`Frentes: ${JSON.stringify(scope)}`), text);
  assert.ok(text.includes('Posições: 7'));
  assert.ok(text.includes('Descartada: false'));
  assert.ok(text.includes('Nota: null'), 'null is a value that resolved, never a path that did not');
  assert.ok(text.includes('Carteira: {"posicoes_abertas":7,"exposicao_atual_pct":62.5}'), text);
});

test('AT14 — a body with no `{{input.` token renders byte-for-byte what it always rendered', async () => {
  const literal = [
    '# Conferir uma etapa',
    '',
    'Julgue com evidência sua, nunca com o relato de quem produziu.',
    '',
    'Um `{{outro.formato}}` de chave dupla não é entrada de nó: passa reto.',
  ].join('\n');

  const empty = await renderBody(literal, {});
  const rich = await renderBody(literal, {
    tese_triada: { titulo: 'nada que este corpo cite' },
    outro: { formato: 'nem isto' },
  });

  assert.ok(empty.includes(literal), 'the manifest body travels into the session unchanged');
  assert.equal(
    empty,
    rich,
    'with nothing to interpolate, what the input carries cannot change a single byte',
  );
});

test('AT15 — a path absent from the input refuses the render instead of leaking the token', async () => {
  const refusal = await refusalOf('**Tese:** {{input.tese_triada.titulo}}', { tese_triada: {} });

  assert.equal(refusal.nodeId, 'conferir');
  assert.equal(refusal.skillId, SKILL_ID);
  assert.deepEqual(refusal.paths, ['tese_triada.titulo']);
  assert.ok(refusal.message.includes('conferir'), refusal.message);
  assert.ok(refusal.message.includes(SKILL_ID), refusal.message);
  assert.ok(refusal.message.includes('tese_triada.titulo'), refusal.message);
});

test('AT16 — every unresolved path is listed on the one refusal, deduplicated and in order', async () => {
  const refusal = await refusalOf(
    [
      '**Tese:** {{input.tese_triada.titulo}} ({{input.tese_triada.ativo}})',
      '',
      'Frentes: {{input.escopo}}',
      '',
      'Repetida de propósito: {{input.tese_triada.titulo}}',
    ].join('\n'),
    { tese_triada: { ativo: 'NVLR3' } },
  );

  assert.deepEqual(
    refusal.paths,
    ['tese_triada.titulo', 'escopo'],
    'first-occurrence order, one entry per path, and the resolvable one is not among them',
  );
});

test('AT17 — a path that walks through a value that is not an object is unresolved', async () => {
  const throughText = await refusalOf('**Tese:** {{input.tese_triada.titulo}}', {
    tese_triada: 'a tese como texto, e não como objeto',
  });
  assert.deepEqual(throughText.paths, ['tese_triada.titulo']);

  const throughList = await refusalOf('**Primeira frente:** {{input.escopo.0}}', {
    escopo: ['termos da venda do braço rodoviário'],
  });
  assert.deepEqual(
    throughList.paths,
    ['escopo.0'],
    'an array is not a plain object: indexing into one is not a path this format has',
  );
});

/* --- AT18: the real factory manifests, against the real crossing fixture --- */

const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const BETS_SKILLS_DIR = path.join(REPO_ROOT, 'grafos-de-fabrica', 'bets-assimetricas', 'skills');
const BETS_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'tese-exemplo-bets-assimetricas.json');

/** One step of the crossing the t116 fixture hand-authored. */
interface CrossingStep {
  no: string;
  entrada: Record<string, unknown>;
}

/** The six nodes the fixture models, each with the skill its graph node pins. */
const BETS_NODES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['triagem', 'triar-tese'],
  ['coleta-fundamentos', 'coletar-fundamentos'],
  ['analise-assimetria', 'analisar-assimetria'],
  ['red-team', 'derrubar-tese'],
  ['dimensionamento-risco', 'dimensionar-risco'],
  ['decisao', 'escalar-decisao'],
]);

/** A committed factory manifest, read from the bundle it ships in. */
function factoryManifest(skillId: string): Record<string, unknown> {
  const file = path.join(BETS_SKILLS_DIR, `${skillId}.json`);
  assert.ok(existsSync(file), `artifact does not exist: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** How many `{{input.` occurrences a manifest's body carries. */
function placeholderCount(manifest: Record<string, unknown>): number {
  return [...String(manifest.instructions).matchAll(/\{\{input\./g)].length;
}

/** A node pinning one factory manifest, with the manifest's own contract on it. */
function factoryNode(nodeId: string, manifest: Record<string, unknown>): ResolveModule.ResolvedNode {
  return {
    versionId: 'sha256:bets-assimetricas',
    node: {
      id: nodeId,
      role: 'investidor',
      node_type: String(manifest.role) === 'gate' ? 'gate' : 'work',
      description: String(manifest.description),
      skill_ref: {
        id: String(manifest.id),
        version: String(manifest.version),
        hash: String(manifest.hash),
      },
      contract: {
        input_schema: manifest.input,
        output_schema: manifest.output,
        checks: [],
      },
    },
    edges: [],
  };
}

test('AT18 — the bets-assimetricas manifests resolve against the crossing fixture', async (parent) => {
  const { renderSkillInstructions } = await loadModule();
  const fixture = JSON.parse(readFileSync(BETS_FIXTURE, 'utf8')) as { travessia: CrossingStep[] };

  let covered = 0;

  for (const [nodeId, skillId] of BETS_NODES) {
    await parent.test(`${nodeId} → ${skillId}`, async () => {
      const step = fixture.travessia.find((entry) => entry.no === nodeId);
      assert.ok(step !== undefined, `the fixture has no step for the node "${nodeId}"`);

      const manifest = factoryManifest(skillId);
      const occurrences = placeholderCount(manifest);
      assert.ok(occurrences > 0, `"${skillId}" carries no placeholder: this case would prove nothing`);
      covered += occurrences;

      const rendered = await renderSkillInstructions(
        factoryNode(nodeId, manifest),
        (await makeReader(manifest)).read,
        step.entrada,
      );

      assert.ok(rendered !== null);
      assert.ok(
        !rendered.instructions.includes('{{input.'),
        `"${skillId}" reached the session with an unresolved placeholder`,
      );
    });
  }

  await parent.test('the six of them account for 26 of the bundle\'s 30 occurrences', () => {
    assert.equal(covered, 26);
    assert.equal(placeholderCount(factoryManifest('registrar-travessia')), 4);
  });

  // The seventh node is not in the fixture, and the reason is worth pinning:
  // two of its four placeholders are fields the WIRING produces (which nodes
  // ran, and when the crossing was recorded), and the t116 fixture models the
  // contract chaining between nodes, not the runner around them.
  await parent.test('registro-monitoramento → registrar-travessia, against a literal input', async () => {
    const manifest = factoryManifest('registrar-travessia');
    const input: Record<string, unknown> = {
      tese_triada: {
        titulo: 'Navelar Logística (NVLR3) — reprecificação depois da venda do braço rodoviário',
        ativo: 'NVLR3',
      },
      nos_executados: [
        'triagem',
        'coleta-fundamentos',
        'analise-assimetria',
        'red-team',
        'dimensionamento-risco',
        'decisao',
      ],
      data_de_registro: '2026-08-16',
    };

    const rendered = await renderSkillInstructions(
      factoryNode('registro-monitoramento', manifest),
      (await makeReader(manifest)).read,
      input,
    );

    assert.ok(rendered !== null);
    assert.ok(!rendered.instructions.includes('{{input.'));
    assert.ok(rendered.instructions.includes(JSON.stringify(input.nos_executados)));
    assert.ok(rendered.instructions.includes('2026-08-16'));

    // And the claim that made it a separate case: strip the two wiring fields
    // and it is exactly those two that no thesis fixture could have supplied.
    const UnresolvedPlaceholderError = await loadUnresolvedError();
    await assert.rejects(
      async () =>
        renderSkillInstructions(
          factoryNode('registro-monitoramento', manifest),
          (await makeReader(manifest)).read,
          { tese_triada: input.tese_triada },
        ),
      (error: unknown) => {
        assert.ok(error instanceof UnresolvedPlaceholderError, String(error));
        assert.deepEqual(error.paths, ['nos_executados', 'data_de_registro']);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/* t215 — the pin resolves by (id, version), never by "the latest".            */
/*                                                                            */
/* The header of the module under test used to say the version needed no       */
/* separate check because "the registry is create-only, so an `id` only ever   */
/* carried the one `hash` it was registered with". D22 ended that: a lineage   */
/* has many versions, and asking `GET /v1/skills/:id` with no query resolves   */
/* the LATEST one — so a node pinned to 1.0.0 would start refusing its own     */
/* dispatch the instant somebody registered 1.1.0. The route has to name the   */
/* version, and the hash check stays exactly what it was: tamper detection.    */
/* -------------------------------------------------------------------------- */

test('t215 AT — skillRoute names the pinned version, not just the id', async () => {
  const { skillRoute } = await loadModule();

  assert.equal(skillRoute('travessia-fazer', '1.2.3'), '/v1/skills/travessia-fazer?version=1.2.3');
  assert.equal(
    skillRoute('a/b', '1.0.0'),
    '/v1/skills/a%2Fb?version=1.0.0',
    'the id is still encoded: it is graph data, never a path fragment to trust',
  );
});

test('t215 AT — the request renderSkillInstructions makes carries the version the node pins', async () => {
  const { renderSkillInstructions } = await loadModule();

  // A registry answering with 2.0.0's content while the node pins 1.0.0 is what
  // "resolve the latest" would look like from here. The route the reader
  // RECORDS is the assertion: it has to have asked for 1.0.0 in the first place.
  const { read, routes } = await makeReader(registeredSkill());
  const rendered = await renderSkillInstructions(resolvedNode(SINGLE_EDGE), read, {});

  assert.ok(rendered !== null);
  assert.deepEqual(routes, [`/v1/skills/${SKILL_ID}?version=1.0.0`]);
  assert.ok(
    routes.every((route) => route.includes('version=1.0.0')),
    `the dispatch asked the registry for something other than the pinned version: ${routes.join(', ')}`,
  );
});
