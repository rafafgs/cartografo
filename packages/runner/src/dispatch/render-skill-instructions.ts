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
 * 3. **The placeholders of the manifest body are resolved against the node's
 *    input, or nothing is rendered at all** (t204). Until then `instructions`
 *    went into the session VERBATIM, which meant a manifest that wrote
 *    `{{input.tese_triada.titulo}}` reached the model with those characters in
 *    it — silently, as if a thesis had been named. Now a path that does not
 *    resolve throws {@link UnresolvedPlaceholderError}, in the same window as
 *    the two refusals above and for the same reason: it is the format's own
 *    rule — `falha fechada`, in the format's own words
 *    (`especificacoes/formatos/manifesto-skill.md`) — and a wrong prompt is
 *    worse than no prompt.
 *
 *    What supplies that input is NOT here, and is honest about it: the
 *    dispatch's `resolveInput` seam defaults to `{}`, so today every skill with
 *    a placeholder fails closed. The per-node context projection that would
 *    thread a prior node's output into the next one's input is a ficha of its
 *    own, and this module refuses loudly until it exists.
 * 4. **The text and the permissions are built from what came back.**
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
import { resolveEscalationPolicy, type GraphEdge, type ResolvedNode } from './resolve-node.ts';

/**
 * The escalation paragraph, which travels with EVERY instruction this runner
 * ever dispatches.
 *
 * It lives here and not in `dispatch.ts` (which re-exports it, so
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

/**
 * What an `always` node is told, on top of {@link ESCALATION_PROTOCOL} (t167).
 *
 * It ADDS to the standard paragraph instead of replacing it: the block, the
 * fields and what happens after are identical — what changes is when the session
 * is expected to reach for it. A node declares `always` when the decision it
 * takes is one a person wants to see even when the session is sure, and "even
 * when you are sure" is the only sentence that carries that.
 *
 * Instruction and not enforcement, like every other line of this file: whether a
 * session was actually certain is not machine-checkable, and pretending
 * otherwise would put a gate in front of a judgement nobody can make.
 */
export const ALWAYS_ESCALATION_PROTOCOL = [
  '**Neste nó, escalar não é último recurso.** Antes de fechar o nó, use o bloco',
  'acima mesmo que você ache que sabe a resposta: a decisão deste nó é de uma',
  'pessoa, e a sua convicção não substitui a passagem por ela. Se depois de',
  'olhar não houver decisão nenhuma a tomar, aí sim siga sem perguntar.',
].join('\n');

/**
 * What a `never` node is told, INSTEAD of {@link ESCALATION_PROTOCOL} (t167).
 *
 * The one policy that replaces the paragraph rather than adding to it, and the
 * reason is not stylistic: at this node the runner turns an `input-request` into
 * an ordinary block, so a session handed the template would be writing a block
 * nobody will ever answer as a question. Giving it the fence and then ignoring
 * the fence is how a prompt starts lying about what the wiring does.
 *
 * What replaces it is the honest instruction: a wall here is a failure of THIS
 * node's own contract, and it is reported as one.
 */
export const NEVER_ESCALATION_PROTOCOL = [
  'Este nó não tem a quem perguntar. Não existe pessoa esperando do outro lado',
  'dele, então não escreva bloco de pergunta nenhum: ele não vira pergunta para',
  'ninguém, e ficar esperando resposta é esperar por uma resposta que não vem.',
  '',
  'Se alguma coisa que o trabalho não resolve travar você, isso é falha do',
  'contrato DESTE nó, e é assim que se relata: termine seu turno dizendo, no',
  'resultado do nó, o que travou e por quê. Não chute para preencher, e não',
  'invente saída — um nó que não conseguiu cumprir o contrato dele é um fato',
  'que alguém precisa ler, e o trabalho para aqui até alguém olhar.',
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
 * A manifest body names something its node's input does not carry (t204).
 *
 * The third refusal of this module, and the one that closes the gap the other
 * two left open: a pin can be perfect and the instructions still arrive
 * half-written, because the sentence that was supposed to name the thesis names
 * `{{input.tese_triada.titulo}}` instead. A session opened on that text is a
 * session working on the wrong thing while every log line says it went fine —
 * the exact failure mode the format's `falha fechada` rule was decided against
 * (`especificacoes/formatos/manifesto-skill.md`).
 *
 * Every unresolved path travels on the ONE error, deduplicated and in the order
 * the body mentions them: whoever fixes this is fixing an input assembly, and
 * fixing it one missing field per dispatch is a round trip per field.
 *
 * It propagates exactly like {@link SkillNotRegisteredError} — the controller's
 * `finally` gives the lease back, and the work is simply not advanced. No block
 * of its own: the work is not broken, the wiring around it is incomplete, and
 * two owners for one blocked flag is how a work ends up stopped with nothing
 * pending.
 */
export class UnresolvedPlaceholderError extends Error {
  readonly nodeId: string;
  readonly skillId: string;
  /** Every path that did not resolve, deduplicated, in first-occurrence order. */
  readonly paths: readonly string[];

  constructor(nodeId: string, skillId: string, paths: readonly string[]) {
    super(
      `node "${nodeId}" pins skill "${skillId}", whose instructions name input that this ` +
        `dispatch does not carry: ${paths.join(', ')} — a placeholder that does not resolve ` +
        'aborts the dispatch instead of reaching the session as text',
    );
    this.name = 'UnresolvedPlaceholderError';
    this.nodeId = nodeId;
    this.skillId = skillId;
    this.paths = paths;
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

/**
 * Every `{{input.…}}` token of a manifest body, whatever is written inside it.
 *
 * Deliberately wider than the path grammar the format declares
 * (`[a-zA-Z0-9_]+` segments joined by `.`): what is NOT a valid path — a dash, a
 * space, an empty tail — is caught by {@link isPath} below and reported as
 * unresolved, instead of being left in the text because the regex did not
 * recognize it. A malformed placeholder is still a placeholder that reached the
 * model, which is the whole bug this ficha closes.
 *
 * `[^{}]*` keeps the match inside one pair of braces, so a stray `{` cannot make
 * one token swallow the paragraph that follows it.
 */
const PLACEHOLDER = /\{\{input\.([^{}]*)\}\}/g;

/** The path grammar the manifest format declares. */
const PATH = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/;

/** Nothing resolved: the value the walk hands back when a segment is missing. */
const UNRESOLVED = Symbol('unresolved');

/**
 * Walks one dotted path through the node's input.
 *
 * A segment that the object being walked does not carry AS ITS OWN — and that
 * includes every segment past a value which is not a plain object, an array
 * among them — is unresolved. Inherited properties are not carriers either:
 * `{{input.constructor.name}}` resolves against nothing, because what the
 * manifest is allowed to name is data somebody put in the input, never the
 * prototype chain of the object holding it.
 *
 * @param input The already-validated input object of this node.
 * @param path A dotted path, already known to match the grammar.
 * @returns The value found, or {@link UNRESOLVED}.
 */
function walk(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;

  for (const segment of path.split('.')) {
    if (!isObject(current) || !Object.hasOwn(current, segment)) return UNRESOLVED;
    current = current[segment];
  }

  // A key present holding `undefined` cannot come out of parsed JSON, and it is
  // not a value that can be written into a prompt either — `String(undefined)`
  // in the middle of an instruction is exactly the silent wrongness this module
  // refuses. It counts as unresolved, which is the fail-closed answer.
  return current === undefined ? UNRESOLVED : current;
}

/**
 * What one resolved value looks like inside the instruction text.
 *
 * A string goes in verbatim, with no escaping and no quoting: the manifest is
 * reviewed at the import gate (D4), the text around the placeholder was written
 * to read as prose, and quoting it would be this module editing a reviewed
 * document. Anything else — number, boolean, `null`, array, object — goes in as
 * compact JSON, which is the one rendering that is unambiguous for a model to
 * read and never invents line breaks inside a paragraph.
 *
 * @param value The value the walk found.
 * @returns The text that replaces the token.
 */
function substitute(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Resolves every placeholder of a manifest body against this node's input
 * (t204, FR2–FR6).
 *
 * One pass, and the refusal comes at the END of it: a body missing three fields
 * reports three, because the caller is about to go assemble an input and
 * discovering the gaps one dispatch at a time is a round trip per field.
 *
 * @param text The manifest's `instructions`, as the registry has it.
 * @param input The already-validated input object of this node.
 * @param unresolved Accumulator, filled in first-occurrence order, deduplicated.
 * @returns The interpolated text — meaningless unless `unresolved` stayed empty.
 */
function interpolate(
  text: string,
  input: Record<string, unknown>,
  unresolved: string[],
): string {
  return text.replace(PLACEHOLDER, (token, path: string) => {
    const value = PATH.test(path) ? walk(input, path) : UNRESOLVED;
    if (value !== UNRESOLVED) return substitute(value);

    if (!unresolved.includes(path)) unresolved.push(path);
    // Returned unchanged, and never read: the caller throws before this text
    // reaches anybody. Leaving the token in place is what keeps a half-rendered
    // body from ever looking like a rendered one while it is being inspected.
    return token;
  });
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
function routingProtocol(edges: readonly GraphEdge[], canAsk: boolean): string[] {
  const labels = edges.map((edge) => edge.condition ?? '').filter((label) => label !== '');
  const list = labels.map((label) => `\`${label}\``).join(', ');

  // The two sentences that describe what happens when the session does NOT name
  // an edge have to agree with the paragraph at the top: at a `never` node the
  // wiring blocks the work instead of raising a question, and a session sent
  // back to a block that will not become a question is a prompt lying about the
  // wiring it runs under (t167).
  const whenNothingMatches = canAsk
    ? [
        'O valor precisa ser um desses, literalmente. Qualquer outra coisa — ou',
        'nenhum bloco — não roteia nada: vira uma pergunta para uma pessoa, e o',
        'trabalho para até alguém responder.',
        '',
        'Se o que trava você é a decisão em si, use o bloco `input-request` acima em',
        'vez de chutar um resultado.',
      ]
    : [
        'O valor precisa ser um desses, literalmente. Qualquer outra coisa — ou',
        'nenhum bloco — não roteia nada: o trabalho é bloqueado com o motivo, e',
        'para até alguém olhar.',
        '',
        'Se o que trava você é a decisão em si, relate isso como falha do contrato',
        'deste nó, com o motivo — nunca chute um resultado para sair andando.',
      ];

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
    ...whenNothingMatches,
  ];
}

/**
 * The escalation paragraph of THIS node (t167, FR5).
 *
 * Until this ficha there was one paragraph, composed into every session
 * whatever node it was on. The three answers here are the same fact made per
 * node: `on_uncertainty` is the text verbatim — every graph written before the
 * field existed renders byte-for-byte what it always rendered — `always` adds a
 * sentence to it, and `never` replaces it, because at that node the block would
 * not become a question.
 */
function escalationProtocol(resolved: ResolvedNode): string {
  switch (resolveEscalationPolicy(resolved)) {
    case 'never':
      return NEVER_ESCALATION_PROTOCOL;
    case 'always':
      return `${ESCALATION_PROTOCOL}\n\n${ALWAYS_ESCALATION_PROTOCOL}`;
    default:
      return ESCALATION_PROTOCOL;
  }
}

/**
 * The whole instruction text of a session running this node with this skill.
 *
 * `body` is passed in rather than read off `skill.instructions`, because by the
 * time the text is composed it is no longer the manifest's: it is the manifest
 * with this node's input in it, and the interpolation that produced it either
 * succeeded completely or never got here.
 */
function render(resolved: ResolvedNode, skill: RegisteredSkill, body: string): string {
  const { node, edges } = resolved;
  const contract = node.contract ?? {};

  const parts = [
    escalationProtocol(resolved),
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
    body,
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

  if (edges.length >= 2) {
    parts.push('', '---', '', ...routingProtocol(edges, resolveEscalationPolicy(resolved) !== 'never'));
  }

  return parts.join('\n');
}

/**
 * Fetches the node's pinned skill, checks the pin, resolves its placeholders,
 * and renders it.
 *
 * @param resolved The node the dispatch resolved, with its outgoing edges.
 * @param read Reader of `GET /v1/skills/:id`.
 * @param input The already-validated input object of THIS node, which is what
 *   `{{input.<caminho>}}` is resolved against. Required and never optional: an
 *   optional parameter here would default to "resolve nothing" at every call
 *   site that forgot it, which is the silent pass-through this ficha removes.
 * @returns The rendered instructions and the session policy, or `null` when the
 *   node pins no skill at all — nothing is pinned, so there is nothing to refuse
 *   and nothing to render, and the dispatch keeps the instructions it would have
 *   used for a graph-less work.
 * @throws {SkillNotRegisteredError} The registry answered 404.
 * @throws {SkillPinMismatchError} The registered hash is not the declared one.
 * @throws {UnresolvedPlaceholderError} The body names input this node does not
 *   carry.
 */
export async function renderSkillInstructions(
  resolved: ResolvedNode,
  read: ReadSkill,
  input: Record<string, unknown>,
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

  // Right after the pin, and before anything is composed: the content is
  // trusted only once its hash matched, and a body that cannot be completed
  // must not become a text somebody might ship by accident.
  const unresolved: string[] = [];
  const body = interpolate(skill.instructions, input, unresolved);
  if (unresolved.length > 0) {
    throw new UnresolvedPlaceholderError(resolved.node.id, pin.id, unresolved);
  }

  return {
    skill,
    instructions: render(resolved, skill, body),
    permissions: resolveSkillPermissions(skill.permissions),
  };
}
