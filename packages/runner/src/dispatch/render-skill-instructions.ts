/**
 * The registered skill, rendered into the session that runs the node (t161,
 * FR3–FR6).
 *
 * This is the line `especificacoes/formatos/manifesto-skill.md` had been
 * carrying since t117: "not implemented yet: rendering `instructions` into a
 * session, which is the runner's job". Until now a dispatch opened every session
 * with the same fixed literal, whatever node it was on — which meant the whole
 * registry (contracts, checks, permissions, the instructions a human reviewed at
 * the import gate) was a document nobody read at execution time.
 *
 * Three things happen here, and the order matters:
 *
 * 1. **The registry is asked, by the id the node pins.** A node whose skill the
 *    registry does not carry does not dispatch; it is a broken deployment, and
 *    running it under generic instructions would be the hand-cranked mode this
 *    ficha exists to end.
 * 2. **The pin is checked, and a mismatch refuses the dispatch.** That is the
 *    entire value of pinning by hash (D4): an imported skill is a prompt-
 *    injection vector, and a hash that stopped matching means the content behind
 *    a graph somebody validated has moved. It is refused BEFORE any session
 *    exists, the same placement `UnknownEngineError` already has — a refusal
 *    after the engine is running is a refusal that already spent the quota and
 *    already let the instructions out.
 *    `version` is not separately checked: the registry is create-only, so an
 *    `id` only ever carried the one `hash` it was registered with, and a hash
 *    match already implies a version match.
 * 3. **The text and the permissions are built from what came back.** The
 *    instructions render VERBATIM — `{{input.<caminho>}}` interpolation is
 *    out of scope for this ficha and stays listed as a known limit of the
 *    format, because interpolating it needs a per-node context assembly that
 *    threads a prior node's output into the next one's input, and that pipeline
 *    does not exist.
 *
 * **Where the routing vocabulary comes from is a decision, not an accident.**
 * The block a gate is asked to emit names the `condition` of the edges leaving
 * THIS node, taken from the graph — not the `outcome` enum of the skill's own
 * `output`, which is a different vocabulary with different values
 * (`pass`/`fail`/`escalate_human`, enforced at registry entry). The graph spec is
 * explicit that an edge's label matches the outcome the source node's
 * `output_schema` declares (`docs/spec/grafo.md`), and that schema is the NODE's
 * contract. One skill can sit under two graphs whose edges are labelled
 * differently, and reading the labels off the graph is what lets it.
 *
 * English per D18 — the manifest's own KEYS too, since the 2026-08-15
 * amendment (t178). The rendered CONTENT stays Portuguese, like every other
 * prompt in this package: it IS the skill manifest's free text, and that text is
 * written in Portuguese (`especificacoes/formatos/exemplos/`).
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import type { SessionPermissions } from '../engine/types.ts';
import type { GraphEdge, ResolvedNode } from './resolve-node.ts';

/**
 * The escalation paragraph, which travels with EVERY instruction this runner
 * ever dispatches.
 *
 * It lives here and not in `dispatch-claude-code.ts` (which re-exports it, so
 * the constant is still reachable where `DEFAULT_INSTRUCTIONS` is) for one
 * reason: this module is the one that would have dropped it. A session that does
 * not know how to escalate never escalates, and the whole cycle t106 built —
 * question, block, answer, re-dispatch — would have gone quietly missing for
 * exactly the jobs this ficha newly drives, the ones with a real graph behind
 * them. Composing it into both texts is what makes that impossible rather than
 * unlikely.
 *
 * The text is unchanged from the literal it was extracted out of.
 */
export const ESCALATION_PROTOCOL = [
  'Quando alguma coisa que o trabalho não resolve travar você, NÃO chute e não',
  'fique esperando: termine seu turno com exatamente UM bloco cercado, e nada',
  'depois dele:',
  '',
  '```input-request',
  '{"question": "<a decisão que você precisa, em uma ou duas frases>",',
  ' "context": "<a evidência, o que você já tentou, as alternativas>",',
  ' "options": ["<rótulo curto>", "<rótulo curto>"],',
  ' "recommendation": "<a ação que você tomaria, no imperativo>",',
  ' "default": "<a opção que vale se a pessoa simplesmente aceitar>"}',
  '```',
  '',
  'O control plane bloqueia o trabalho, uma pessoa responde, e você é despachado',
  'de novo — com a pergunta e a resposta já escritas no prompt. Não existe',
  'retomada de sessão: cada despacho é uma sessão nova que foi informada do que',
  'aconteceu antes.',
].join('\n');

/** A registered skill, as `GET /v1/skills/:id` projects it. */
export interface RegisteredSkill {
  id: string;
  version: string;
  hash: string;
  /** `work` or `gate`. */
  role: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  preconditions: string[];
  checks: Record<string, unknown>[];
  permissions: Record<string, unknown>;
  instructions: string;
}

/** Everything a resolved skill gives one dispatch. */
export interface RenderedSkill {
  /** The manifest, as the registry has it. */
  skill: RegisteredSkill;
  /** The whole instruction text of the session. */
  instructions: string;
  /**
   * The policy the session runs under, resolved from `permissions`.
   *
   * `undefined` when the manifest declares nothing readable — which the registry
   * does not allow on the way in, so it only happens for a projection that
   * changed shape underneath us. Absent means "declared nothing", which is the
   * behaviour every session had before the field existed; it never means
   * "anything goes" further down, because the adapter's own policy resolution
   * reads absence the same way.
   */
  permissions: SessionPermissions | undefined;
}

/** Reads one route of the control plane, rejecting on a refusal. */
export type ReadSkill = (route: string) => Promise<RegisteredSkill>;

/**
 * A node points at a skill the registry does not carry.
 *
 * Never softened into "dispatch it with the default instructions": a graph node
 * whose skill nobody registered is a deployment that is missing a piece, and a
 * session run under generic text would produce work nobody can attribute to a
 * contract. It propagates the way `UnknownEngineError` does — the controller's
 * `finally` gives the lease back, and the work is simply not advanced.
 */
export class SkillNotRegisteredError extends Error {
  readonly nodeId: string;
  readonly skillId: string;

  constructor(nodeId: string, skillId: string) {
    super(
      `node "${nodeId}" pins skill "${skillId}", which is not in the registry — ` +
        'register the manifest before dispatching this graph (D4)',
    );
    this.name = 'SkillNotRegisteredError';
    this.nodeId = nodeId;
    this.skillId = skillId;
  }
}

/**
 * The hash a node pinned is not the hash the registry has.
 *
 * This is the pin doing its job. Between the review that approved a manifest and
 * this dispatch there is a JSON payload anybody can edit, and D4 exists because
 * an imported skill is a prompt-injection vector: the graph was validated
 * against content with one hash, and the registry is offering content with
 * another. Which of the two moved is not this module's to guess, and running
 * either one would be running something nobody approved.
 */
export class SkillPinMismatchError extends Error {
  readonly nodeId: string;
  readonly skillId: string;
  /** What the graph node declared. */
  readonly declared: string;
  /** What the registry actually carries. */
  readonly registered: string;

  constructor(nodeId: string, skillId: string, declared: string, registered: string) {
    super(
      `node "${nodeId}" pins skill "${skillId}" at ${declared}, but the registry carries ` +
        `${registered} — a pin that stopped matching does not dispatch (D4)`,
    );
    this.name = 'SkillPinMismatchError';
    this.nodeId = nodeId;
    this.skillId = skillId;
    this.declared = declared;
    this.registered = registered;
  }
}

/**
 * The route of one registered skill.
 *
 * @param id Id of the skill, as the node pins it.
 * @returns The route, with the id encoded.
 */
export function skillRoute(id: string): string {
  return `/v1/skills/${encodeURIComponent(id)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every entry of a list of strings, or an empty list when it is not one. */
function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Turns the manifest's `permissions` into the interface's `SessionPermissions`.
 *
 * The two vocabularies are deliberately different — the manifest is a product
 * format's, the `EngineAdapter` interface's is the adapter's — and this is the
 * one place they meet. `filesystem.read` has no counterpart on purpose: the
 * interface declares no read axis, because no adapter enforces one, and
 * inventing the field here would be exactly the dead capability the engine
 * specification refuses to accumulate.
 *
 * `domains` is dropped when the network is closed, which is the manifest
 * format's own rule ("`network.allowed: false` closes the network; `domains` is
 * ignored in that case"). Carrying it anyway would make the adapter's policy
 * resolution REFUSE the session — it cannot express a per-domain allowlist —
 * for a declaration that restricted nothing.
 *
 * @param permissions The manifest's declaration.
 * @returns The session policy, or `undefined` when nothing readable was
 *   declared.
 */
export function resolveSkillPermissions(permissions: unknown): SessionPermissions | undefined {
  if (!isObject(permissions)) return undefined;

  const filesystem = isObject(permissions.filesystem) ? permissions.filesystem : null;
  const network = isObject(permissions.network) ? permissions.network : null;
  if (filesystem === null || network === null) return undefined;

  const allowed = network.allowed === true;
  const domains = allowed ? textList(network.domains) : [];

  return {
    filesystem: { write: textList(filesystem.write) },
    network: allowed && domains.length > 0 ? { allowed, domains } : { allowed },
  };
}

/** One fenced JSON section of the rendered text. */
function fenced(title: string, value: unknown): string[] {
  return [title, '', '```json', JSON.stringify(value ?? null, null, 2), '```', ''];
}

/**
 * The paragraph that tells a gate how to name the edge it took.
 *
 * Rendered only for a node with more than one way out (FR8): a node with a
 * single outgoing edge is deterministic by construction, and asking it to choose
 * would invent a decision it does not have — and then escalate to a human when
 * the session, correctly, did not make one.
 */
function routingProtocol(edges: readonly GraphEdge[]): string[] {
  const labels = edges.map((edge) => edge.condition ?? '').filter((label) => label !== '');
  const list = labels.map((label) => `\`${label}\``).join(', ');

  return [
    '## Como fechar o turno: este nó decide para onde o trabalho vai',
    '',
    `Este nó tem mais de uma saída — ${list} —, e quem escolhe qual delas vale`,
    'é você. Termine seu turno com exatamente UM bloco cercado, e nada depois',
    'dele:',
    '',
    '```resultado',
    `{"resultado": "<um de: ${labels.join(', ')}>"}`,
    '```',
    '',
    'O valor precisa ser um desses, literalmente. Qualquer outra coisa — ou',
    'nenhum bloco — não roteia nada: vira uma pergunta para uma pessoa, e o',
    'trabalho para até alguém responder.',
    '',
    'Se o que trava você é a decisão em si, use o bloco `input-request` acima em',
    'vez de chutar um resultado.',
  ];
}

/** The whole instruction text of a session running this node with this skill. */
function render(resolved: ResolvedNode, skill: RegisteredSkill): string {
  const { node, edges } = resolved;
  const contract = node.contract ?? {};

  const parts = [
    ESCALATION_PROTOCOL,
    '',
    '---',
    '',
    `# Nó \`${node.id}\` — skill \`${skill.id}\` v${skill.version}`,
    '',
    `Papel do nó: \`${node.role ?? 'não declarado'}\`. Tipo: \`${node.node_type ?? 'não declarado'}\`.`,
    `Papel da skill: \`${skill.role}\`. Pin: \`${skill.hash}\`.`,
    '',
    skill.description,
    '',
    '---',
    '',
    skill.instructions,
    '',
    '---',
    '',
    `## O contrato do nó \`${node.id}\``,
    '',
    'Este é o contrato que ESTE nó declara no grafo registrado, e é contra ele',
    'que a sua saída vai ser conferida.',
    '',
    ...fenced('### O que entra', contract.input_schema ?? {}),
    ...fenced('### O que você tem que produzir', contract.output_schema ?? {}),
    ...fenced('### Como este nó é verificado', contract.checks ?? []),
    ...fenced('## Os checks declarados pela skill', skill.checks),
    ...fenced('## As permissões desta sessão', skill.permissions),
    'Elas já estão aplicadas: o que estiver fechado aí não vai funcionar, e',
    'contornar não é opção. Se a tarefa exige algo que a declaração não permite,',
    'isso é uma pergunta, não um obstáculo para driblar.',
  ];

  if (edges.length >= 2) parts.push('', '---', '', ...routingProtocol(edges));

  return parts.join('\n');
}

/**
 * Fetches the node's pinned skill, checks the pin, and renders it.
 *
 * @param resolved The node the dispatch resolved, with its outgoing edges.
 * @param read Reader of `GET /v1/skills/:id`.
 * @returns The rendered instructions and the session policy, or `null` when the
 *   node pins no skill at all — nothing is pinned, so there is nothing to refuse
 *   and nothing to render, and the dispatch keeps the instructions it would have
 *   used for a graph-less work.
 * @throws {SkillNotRegisteredError} The registry answered 404.
 * @throws {SkillPinMismatchError} The registered hash is not the declared one.
 */
export async function renderSkillInstructions(
  resolved: ResolvedNode,
  read: ReadSkill,
): Promise<RenderedSkill | null> {
  const pin = resolved.node.skill_ref;
  if (pin === undefined || typeof pin.id !== 'string' || pin.id === '') return null;

  let skill: RegisteredSkill;
  try {
    skill = await read(skillRoute(pin.id));
  } catch (error) {
    // Only the 404 is translated: it is the one refusal that means something
    // specific about the GRAPH, and it deserves a message naming the node. Any
    // other status is the control plane having a bad day, and rewriting it as a
    // registry problem would send whoever is debugging to the wrong place.
    if (error instanceof ErroDoControlPlane && error.status === 404) {
      throw new SkillNotRegisteredError(resolved.node.id, pin.id);
    }
    throw error;
  }

  if (skill.hash !== pin.hash) {
    throw new SkillPinMismatchError(resolved.node.id, pin.id, pin.hash, skill.hash);
  }

  return {
    skill,
    instructions: render(resolved, skill),
    permissions: resolveSkillPermissions(skill.permissions),
  };
}
