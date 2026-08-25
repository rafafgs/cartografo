/**
 * The synthesis prompt: everything the copilot session is given (t115, FR5).
 *
 * A pure function, tested on its own, because this text IS the contract of the
 * ficha. D10 makes the synthesizer a copilot in the MVP — it proposes, the human
 * edits, and the edit is the entire gate — which means the only thing standing
 * between a declaration and a graph a person has to review is what is written
 * here. A contract that can only be read by opening a session is a contract
 * nobody reviews.
 *
 * Four inputs go in, and each one is a requirement:
 *
 * - the **declaration**, verbatim, as the user typed it;
 * - the **class name**, verbatim, because D8 puts the naming in the user's
 *   hands: the session is told what the class is called, never asked;
 * - the **similar classes**, as non-blocking context. The user already named
 *   the class (FR1/FR2); these are precedents to compose LIKE, not a decision to
 *   revisit;
 * - the **skill catalogue**, in enough detail — contract in, contract out, and
 *   how each capability is verified — that composing a topology is matching
 *   contracts instead of guessing. That is README principle 3 and D9: "with no
 *   contract, the synthesizer composes by hallucination".
 *
 * The output contract is one fenced `grafo-proposto` block, and the hardest
 * rule in it is about `skill_ref`: copied from the catalogue, never invented. A
 * pin is what stops a validated graph having a capability swapped underneath it
 * (D4), and a hash a model made up is not a pin — it is a graph that will be
 * refused by `cartografo import` after wasting the person's edit.
 *
 * Every rule of the format that `cartografo import` enforces has to be stated
 * here, and "has to" is literal: the session's `workingDir` is an empty
 * temporary directory, so it cannot open `schema/graph.schema.json` and read the
 * format for itself. A rule that lives only in the schema is a rule the session
 * cannot follow. That is how t138 was found — a draft that obeyed every word of
 * this text still came back `grafo_invalido` / `soundness no_com_contrato`,
 * because `contract.checks` has `minItems: 1` and nothing here said so.
 *
 * English, the prompt's own PROSE included (D24, t309). It was the last agent
 * instruction in the repository still written in Portuguese, under an exemption
 * that said a prompt is consumed by a subprocess and read by nobody. This file
 * is the counter-example the exemption could not survive: its whole docstring
 * argues that "a contract that can only be read by opening a session is a
 * contract nobody reviews", and the same sentence is true of the prompt that
 * carries it.
 *
 * What did NOT move is the vocabulary quoted inside it. The key names are the
 * format the session has to emit and went English with t178; `sempre` (an edge
 * `condition`, `docs/spec/graph.md`), `no_com_contrato` (a soundness rule) and
 * the {@link PROPOSAL_FENCE} tag stay Portuguese because they are wire, and a
 * prompt teaching a name the import gate does not accept produces documents
 * that gate refuses — the same failure mode t138 was.
 */

import type { RegisteredSkill } from './control-plane-client.ts';

/** A registered class that scored against the declaration (FR3). */
export interface SimilarClass {
  /** The class id, which is also the lineage id (D8). */
  classe: string;
  /** `metadata.name` of its current version. */
  nome: string;
  /** `metadata.description` of its current version; empty when it declares none. */
  descricao: string;
  /** Jaccard score in `[0, 1]`. */
  score: number;
}

/** The fence the session answers in. Named once, used by prompt and parser. */
export const PROPOSAL_FENCE = 'grafo-proposto';

/**
 * One entry of `contract.checks`, in the GRAPH document's format.
 *
 * The open drawer mirrors `domain/graph.ts`: the format has not frozen (rule of
 * two consumers) and this type exists to be rendered, not to constrain.
 */
export type VerificationExample = Readonly<Record<string, unknown>>;

/**
 * The two shapes a `contract.checks` entry can take, shown to the session verbatim.
 *
 * Examples and not prose because of what sits directly above them in the prompt:
 * the skill catalogue, printing each skill's `checks` — and a manifest's check
 * is NOT a graph document's check. They disagree on
 * `required_evidence`, which is a non-empty list of the artifacts the
 * verdict has to cite in `specs/formats/skill-manifest.schema.json`
 * and the literal `true` in `schema/graph.schema.json`. Tell a session "every
 * node needs a check" with only manifest-shaped checks in front of it and it
 * copies one across, which trades the failure t138 reported for a different one
 * at the same gate.
 *
 * `test/synthesizer/prompt.test.ts` validates both against the real schema, so
 * an example cannot drift away from the format it exists to teach.
 */
export const VERIFICATION_EXAMPLES: readonly VerificationExample[] = Object.freeze([
  Object.freeze({
    type: 'deterministic',
    command: 'npm test',
    description: 'What this check proves.',
  }),
  Object.freeze({
    type: 'agentic',
    instruction: 'An answerable question about the artifact, checked with its own evidence.',
    required_evidence: true,
    description: 'What this check proves.',
  }),
]);

/**
 * The session's role and its hard rules, for `SessionSpec.instructions`.
 *
 * Separate from the prompt because the `EngineAdapter` contract is explicit
 * that the two are never concatenated by the caller
 * (`docs/formats/engine-adapter.md`): what is stable across every synthesis
 * belongs here, what is specific to this declaration belongs in the prompt.
 */
export const SYNTHESIS_INSTRUCTIONS = [
  'You are the synthesizer of cartografo, working as a human COPILOT.',
  '',
  'You propose ONE graph topology for a problem class the user has just named.',
  'You register nothing, call no API and edit no file: your answer is a block of',
  'text, and whoever dispatched you is who records it. After you, a human edits',
  'what you proposed — that edit is the entire gate, so propose something that',
  'can be edited, not something that looks finished.',
  '',
  'Hard rules:',
  '',
  '- the `problem_class` of the document is the one the user gave, literally. You',
  '  do not name the class, do not correct the name and do not suggest another;',
  '- `lineage` is always `{"type": "base"}`: a variant is born of a fork with a',
  '  proposal, and this is not that;',
  '- every node carries `skill_ref` copied LITERALLY from the catalogue (id,',
  '  version and hash together, from the same item). Never invent an id, a',
  '  version or a hash: the pin is what stops a capability being swapped',
  '  silently underneath a graph somebody already validated;',
  '- every node needs an incoming and an outgoing edge, `initial_node` has to',
  '  exist in `nodes`, and `final_nodes` too — a graph that does not reach the',
  '  end is refused at the soundness gate before any human reads it;',
  '- every edge has a `condition`: the literal `"sempre"` when the source has a',
  '  single way out, and the result label when it has more than one;',
  '- the `contract` of every node carries `checks` with AT LEAST ONE',
  '  verification, and that holds for a gate just the same, which is a node like',
  '  any other. An empty list is refused by the soundness rule',
  '  `no_com_contrato`, at the same import gate — and where you cannot write the',
  '  verification of a step, there is no gate there at all: prefer saying so in',
  '  your turn to handing back an empty list.',
].join('\n');

/** One skill of the catalogue, rendered so a person can audit the prompt too. */
function renderSkill(skill: RegisteredSkill): string {
  return [
    `### \`${skill.id}\``,
    '',
    `- role: ${skill.role}`,
    `- description: ${skill.description}`,
    `- skill_ref (copy literally): {"id": ${JSON.stringify(skill.id)}, "version": ${JSON.stringify(skill.version)}, "hash": ${JSON.stringify(skill.hash)}}`,
    `- input: ${JSON.stringify(skill.input)}`,
    `- output: ${JSON.stringify(skill.output)}`,
    `- checks: ${JSON.stringify(skill.checks)}`,
  ].join('\n');
}

/** The suggestion block, or the sentence that says there is no suggestion. */
function renderSimilar(similarClasses: readonly SimilarClass[]): string[] {
  if (similarClasses.length === 0) {
    return [
      'No registered class looks like this declaration. Compose from scratch,',
      'out of the catalogue below.',
    ];
  }

  return [
    'These ALREADY REGISTERED classes look like the declaration. They are',
    'precedent, not destination: the class to compose is still the one the user',
    'named. Use them to reuse the shape of a node and of a gate, never to swap',
    'the name of the class.',
    '',
    ...similarClasses.map(
      (item) =>
        `- \`${item.classe}\` (proximity ${item.score.toFixed(2)}) — ${item.nome}${
          item.descricao === '' ? '' : `: ${item.descricao}`
        }`,
    ),
  ];
}

/**
 * Assembles the whole prompt of one synthesis session.
 *
 * @param declaration The problem, in the user's own words.
 * @param className The class the user named (D8).
 * @param similarClasses Up to three scoring precedents; may be empty.
 * @param skills The capability catalogue, as the registry returned it.
 * @returns The prompt, ready for `SessionSpec.prompt`.
 */
export function buildSynthesisPrompt(
  declaration: string,
  className: string,
  similarClasses: readonly SimilarClass[],
  skills: readonly RegisteredSkill[],
): string {
  const catalogue =
    skills.length === 0
      ? [
          'The skill registry is empty: no registered skill to compose with.',
          'Propose the nodes anyway, leaving `skill_ref` with the id the',
          'capability WOULD NEED to have, and say in your turn that the pin does',
          'not exist — whoever edits afterwards will have to register the skill',
          'before importing.',
        ]
      : skills.map(renderSkill);

  return [
    `# The problem, as declared`,
    '',
    declaration,
    '',
    `# Class to compose: \`${className}\``,
    '',
    'This name is the user\'s, and it is final.',
    '',
    '# Precedents',
    '',
    ...renderSimilar(similarClasses),
    '',
    '# Catalogue of registered capabilities',
    '',
    ...catalogue,
    '',
    '# What to hand back',
    '',
    'End your turn with EXACTLY ONE fenced block like this, and nothing after it:',
    '',
    `\`\`\`${PROPOSAL_FENCE}`,
    '{ ... graph document ... }',
    '```',
    '',
    'The document is JSON in the format of `schema/graph.schema.json`, with the',
    'eight required keys and nothing beyond them:',
    '',
    `- \`problem_class\`: ${JSON.stringify(className)};`,
    '- `lineage`: `{"type": "base"}`;',
    '- `metadata`: with `name`, `description` and `schema_version` `"1.0.0"`;',
    '- `nodes`: each with `id`, `role`, `node_type` (`work` or `gate`),',
    '  `skill_ref` and `contract` (`input_schema`, `output_schema`, `checks`);',
    '- `edges`: each with `from`, `to` and `condition`;',
    '- `initial_node` and `final_nodes`;',
    '- `custom_fields`: the fields the tickets of this class carry beyond a title',
    '  and a body. Write `[]` when the request mentions none — the key is',
    '  required even when empty, and inventing a field nobody asked for is more',
    '  work for whoever has to fill it in.',
    '',
    'The `skill_ref` of each node is copied literally from the catalogue above:',
    'never invent an id, a version or a hash — a made-up pin is refused at the',
    'import gate and throws away the edit of whoever comes after you.',
    '',
    '## `contract.checks`: at least one per node',
    '',
    '`contract.checks` is a list with AT LEAST ONE verification. An empty list is',
    'refused at import (`no_com_contrato`), and the graph goes back to whoever',
    'had already edited it. Each item is in one of these two formats, and carries',
    'nothing beyond these fields:',
    '',
    ...VERIFICATION_EXAMPLES.map((example) => `- \`${JSON.stringify(example)}\``),
    '',
    'Do NOT copy the `checks` of the catalogue into `contract.checks`: those are',
    'in the skill manifest format, which is a different document. The difference',
    'that gets refused is `required_evidence` — a list of artifacts in the',
    'manifest, the literal `true` here. Read the `checks` of the catalogue to',
    'learn HOW the capability is checked, and rewrite the verification in one of',
    'the two formats above.',
  ].join('\n');
}
