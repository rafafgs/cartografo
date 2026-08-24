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
 * 1. **The registry is asked, by the id AND the version the node pins.** A node
 *    whose skill the registry does not carry does not dispatch; it is a broken
 *    deployment, and running it under generic instructions would be the
 *    hand-cranked mode this ficha exists to end.
 *
 *    The version is part of the request since t215, and it is the whole of what
 *    that ficha changed here. This module used to ask `GET /v1/skills/:id` and
 *    say, in this very paragraph, that it was safe because "the registry is
 *    create-only, so an `id` only ever carried the one `hash` it was registered
 *    with". D22 made that false: a lineage has versions, and the id-only read
 *    resolves the newest one. Asking by id alone would mean that the moment
 *    somebody registered a better version of a skill, every graph in flight
 *    pinned to the older one started refusing its own dispatch on the hash
 *    check below — a decision nobody took, taken by whoever happened to publish
 *    a skill. D22 says the opposite twice: a node "nunca resolve 'a mais
 *    recente'", and improving a skill never breaks a map that is pinned to it.
 *    Moving a pin is a proposal, and it happens in the graph, not here.
 * 2. **The pin is checked, and a mismatch refuses the dispatch.** That is the
 *    entire value of pinning by hash (D4): an imported skill is a prompt-
 *    injection vector, and a hash that stopped matching means the content behind
 *    a graph somebody validated has moved. It is refused BEFORE any session
 *    exists, the same placement `UnknownEngineError` already has — a refusal
 *    after the engine is running is a refusal that already spent the quota and
 *    already let the instructions out.
 *
 *    It stays exactly what it was, and it does not need `hash` in the lookup to
 *    do its job: `(id, version)` is the registry's primary key now, so this
 *    check compares the pin the graph froze against the content that key
 *    resolves to. What it catches is the one case that is left, and the one it
 *    was always for — the registered content having moved under a version that
 *    did not.
 * 3. **The placeholders of the manifest body are resolved against the node's
 *    input, or nothing is rendered at all** (t204). Until then `instructions`
 *    went into the session VERBATIM, which meant a manifest that wrote
 *    `{{input.triaged_thesis.title}}` reached the model with those characters in
 *    it — silently, as if a thesis had been named. Now a path that does not
 *    resolve throws {@link UnresolvedPlaceholderError}, in the same window as
 *    the two refusals above and for the same reason: it is the format's own
 *    rule — `falha fechada`, in the format's own words
 *    (`especificacoes/formatos/manifesto-skill.md`) — and a wrong prompt is
 *    worse than no prompt.
 *
 *    What supplies that input is NOT here: since t259 the dispatch's
 *    `resolveInput` seam reads `GET /v1/jobs/:id/context`, the control plane's
 *    own projection of what the job and the nodes before it produced
 *    (`packages/core/src/domain/context.ts`). A path that projection does not
 *    carry still refuses loudly, which is what the rule is for.
 * 4. **The session is shown the data it has and the schema it is judged by**
 *    (t267). Two gaps, one defect: a session was told what it would be checked
 *    against, and it was the wrong thing. The VALUES of `input` reached the model
 *    only through the paths somebody remembered to write into the body, so a
 *    projection could carry a field in full and the session still open without it
 *    (`analise-assimetria`, second bets crossing). And what was rendered under
 *    "what you have to produce" was the NODE's `contract.output_schema`, beside a
 *    sentence claiming the output would be checked against it — while `/finish`
 *    checks the SKILL's own `output` (`resolveOutputSchema`, in core), a
 *    different schema by design (`docs/spec/graph.md`).
 * 5. **The text and the permissions are built from what came back**, with the
 *    paragraph that tells the session how to report its result
 *    (`result-protocol.ts`) whenever this node declares an `output_schema` —
 *    gate or not, since t259. A node that is never told how to report is a node
 *    whose successor has nothing to read.
 *
 *    What CLOSES the text is the escalation paragraph, and since t261 that
 *    position is measured rather than chosen: it used to open the text, and a
 *    fenced JSON template opening a system prompt is refused outright by
 *    Anthropic's safeguard classifier. See {@link render}.
 *
 * English per D18 — the manifest's own KEYS too, since the 2026-08-15
 * amendment (t178). The rendered CONTENT stays Portuguese, like every other
 * prompt in this package: it IS the skill manifest's free text, and that text is
 * written in Portuguese (`especificacoes/formatos/exemplos/`).
 */

import { ErroDoControlPlane } from '../controller/cliente-controle.ts';
import type { SessionPermissions } from '../engine/types.ts';
import {
  ALWAYS_ESCALATION_PROTOCOL,
  ESCALATION_PROTOCOL,
  NEVER_ESCALATION_PROTOCOL,
} from './escalation-protocol.ts';
import { renderInputValues } from './render-input-values.ts';
import { resolveEscalationPolicy, type ResolvedNode } from './resolve-node.ts';
import { hasOutputSchema, resultProtocol } from './result-protocol.ts';

/**
 * The three paragraphs this module composes, re-exported unchanged (t223).
 *
 * They were declared here until the 600-line budget of `src/dispatch/` came due
 * and 77 lines of frozen literal were the cheapest thing in the file to move
 * (`escalation-protocol.ts`). Re-exported and not just imported because this is
 * where they have always been read from — by this package's own tests, and by
 * `dispatch.ts`, which re-exports `ESCALATION_PROTOCOL` in turn. The split
 * renames nothing.
 */
export {
  ALWAYS_ESCALATION_PROTOCOL,
  ESCALATION_PROTOCOL,
  NEVER_ESCALATION_PROTOCOL,
} from './escalation-protocol.ts';

/** A registered skill, as `GET /v1/skills/:id?version=` projects it. */
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
 * `{{input.triaged_thesis.title}}` instead. A session opened on that text is a
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
 * The route of one registered skill VERSION (t215).
 *
 * `?version=` and not `?hash=`, and the difference matters: `(id, version)` is
 * the registry's key, so this asks for exactly one row, and the hash check above
 * then compares what came back against what the graph froze. Looking up by hash
 * instead would make a moved-content mismatch look like a 404 — "this skill is
 * not registered" for a skill that is, which sends whoever is debugging to
 * register a manifest that is already there.
 *
 * Both halves are encoded. They come off a graph document written by an agent,
 * and D4 says that is content to distrust — never a path fragment to trust.
 *
 * @param id Id of the skill, as the node pins it.
 * @param version Version of the skill, as the node pins it.
 * @returns The route, with both values encoded.
 */
export function skillRoute(id: string, version: string): string {
  return `/v1/skills/${encodeURIComponent(id)}?version=${encodeURIComponent(version)}`;
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
 *
 * `input` rides along beside it since t267, for the half of the same object the
 * body did NOT quote: the placeholders cover the paths somebody wrote down, and
 * the block below the body covers what the skill declared
 * (`render-input-values.ts`).
 */
function render(
  resolved: ResolvedNode,
  skill: RegisteredSkill,
  body: string,
  input: Record<string, unknown>,
): string {
  const { node, edges } = resolved;
  const contract = node.contract ?? {};

  const parts = [
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
    // Right after the body, and before the contract: what the session is
    // holding comes before what the graph says about it.
    ...renderInputValues(skill.input, input),
    '---',
    '',
    `## O contrato do nó \`${node.id}\``,
    '',
    'Este é o contrato que ESTE nó declara no grafo registrado, e ele é',
    'documentação: descreve o que o nó recebe, a forma que ele espera produzir e',
    'como o que sai daqui é verificado — e é dessa forma que sai o vocabulário',
    'das arestas deste nó. Ele NÃO é o validador do seu relato: o schema que',
    'decide se a sua saída é aceita está mais abaixo, em `### O que você tem que',
    'produzir`.',
    '',
    ...fenced('### O que entra', contract.input_schema ?? {}),
    ...fenced('### A forma que este nó documenta', contract.output_schema ?? {}),
    ...fenced('### Como este nó é verificado', contract.checks ?? []),
    ...fenced('## Os checks declarados pela skill', skill.checks),
    ...fenced('## As permissões desta sessão', skill.permissions),
    'Elas já estão aplicadas: o que estiver fechado aí não vai funcionar, e',
    'contornar não é opção. Se a tarefa exige algo que a declaração não permite,',
    'isso é uma pergunta, não um obstáculo para driblar.',
    '',
    '---',
    '',
    '## O schema que fecha esta sessão',
    '',
    `Este é o \`output\` declarado pela skill \`${skill.id}\` v${skill.version}, e é`,
    'contra ele — não contra o contrato do nó acima — que',
    '`PATCH /v1/sessions/:id/finish` checa o bloco `resultado` que você emitir',
    '(D9). Um relato que não casar com esta forma é recusado no fechamento da',
    'sessão, e o nó seguinte não recebe nada.',
    '',
    ...fenced('### O que você tem que produzir', skill.output),
  ];

  // Whenever this node declares a shape, and no longer only when it decides
  // (t259). A `work` node that is never told how to report is a node whose
  // successor has nothing to read; the routing key, when there is one, is a
  // field INSIDE the same block rather than a second one beside it.
  if (hasOutputSchema(contract.output_schema)) {
    parts.push('', '---', '', ...resultProtocol(edges, resolveEscalationPolicy(resolved) !== 'never'));
  }

  // LAST, and measured (t261). This paragraph opened the text from t161 until
  // the first real traversal of the bets graph, when every claude-code session
  // on it came back `stop_reason: "refusal"` with
  // `stop_details.category: "reasoning_extraction"` — 5/5, zero output tokens,
  // before the model ever read the node. The plantão's bisection isolated it to
  // POSITION and to nothing else: the same prompt minus these lines reaches
  // `end_turn`, the same lines moved down here reach `end_turn`, and a softer
  // REWORDING left at the top still refuses. What the safeguard classifier
  // bites on is a fenced JSON answer template OPENING a system prompt.
  //
  // So the order below is a constraint, not a layout preference: whoever moves
  // this back up is turning every session on this renderer into a refusal, and
  // the test that pins it (`render-skill-instructions.test.ts`, t261) is what
  // says so out loud. `docs/spec/human-escalation.md` §8 carries the finding.
  parts.push('', '---', '', escalationProtocol(resolved));

  return parts.join('\n');
}

/**
 * Fetches the node's pinned skill, checks the pin, resolves its placeholders,
 * and renders it.
 *
 * @param resolved The node the dispatch resolved, with its outgoing edges.
 * @param read Reader of `GET /v1/skills/:id?version=`.
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
    skill = await read(skillRoute(pin.id, pin.version));
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
    instructions: render(resolved, skill, body, input),
    permissions: resolveSkillPermissions(skill.permissions),
  };
}
