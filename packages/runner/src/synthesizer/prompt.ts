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
 *   contracts instead of guessing. That is README principle 3 and D9: "sem
 *   contrato o sintetizador compõe por alucinação".
 *
 * The output contract is one fenced `grafo-proposto` block, and the hardest
 * rule in it is about `skill_ref`: copied from the catalogue, never invented. A
 * pin is what stops a validated graph having a capability swapped underneath it
 * (D4), and a hash a model made up is not a pin — it is a graph that will be
 * refused by `cartografo import` after wasting the person's edit.
 *
 * Every rule of the format that `cartografo import` enforces has to be stated
 * here, and "has to" is literal: the session's `workingDir` is an empty
 * temporary directory, so it cannot open `schema/grafo.schema.json` and read the
 * format for itself. A rule that lives only in the schema is a rule the session
 * cannot follow. That is how t138 was found — a draft that obeyed every word of
 * this text still came back `grafo_invalido` / `soundness no_com_contrato`,
 * because `contract.checks` has `minItems: 1` and nothing here said so.
 *
 * English per D18; the prompt's own PROSE is Portuguese, like every other agent
 * instruction in the repository. The key names quoted inside it are not prose —
 * they are the format the session has to emit, and they moved to English with
 * t178. A prompt still teaching `nos` would produce documents the import gate
 * refuses, which is the same failure mode t138 was.
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
 * verdict has to cite in `especificacoes/formatos/manifesto-skill.schema.json`
 * and the literal `true` in `schema/grafo.schema.json`. Tell a session "every
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
    description: 'O que este check prova.',
  }),
  Object.freeze({
    type: 'agentic',
    instruction: 'Pergunta respondível sobre o artefato, conferida com evidência própria.',
    required_evidence: true,
    description: 'O que este check prova.',
  }),
]);

/**
 * The session's role and its hard rules, for `SessionSpec.instructions`.
 *
 * Separate from the prompt because the `EngineAdapter` contract is explicit
 * that the two are never concatenated by the caller
 * (`docs/formatos/engine-adapter.md`): what is stable across every synthesis
 * belongs here, what is specific to this declaration belongs in the prompt.
 */
export const SYNTHESIS_INSTRUCTIONS = [
  'Você é o sintetizador do cartografo, trabalhando como COPILOTO de um humano.',
  '',
  'Você propõe UMA topologia de grafo para uma classe de problema que o usuário',
  'acabou de nomear. Você não registra nada, não chama API nenhuma e não edita',
  'arquivo nenhum: sua resposta é um bloco de texto, e quem grava é quem despachou',
  'você. Depois de você, um humano edita o que você propôs — essa edição é o',
  'portão inteiro, então proponha algo que dê para editar, não algo que pareça',
  'pronto.',
  '',
  'Regras duras:',
  '',
  '- a `problem_class` do documento é a que o usuário deu, literalmente. Você não',
  '  nomeia classe, não corrige o nome e não sugere outro;',
  '- `lineage` é sempre `{"type": "base"}`: variante nasce de fork com proposta,',
  '  e não é isto aqui;',
  '- todo nó carrega `skill_ref` copiado LITERALMENTE do catálogo (id, version e',
  '  hash juntos, do mesmo item). Nunca invente id, versão ou hash: o pin é o que',
  '  impede troca silenciosa de capacidade por baixo de um grafo já validado;',
  '- todo nó precisa de aresta de entrada e de saída, `initial_node` precisa',
  '  existir em `nodes`, e `final_nodes` também — um grafo que não alcança o fim é',
  '  reprovado no portão de soundness antes de qualquer humano ler;',
  '- toda aresta tem `condition`: o literal `"sempre"` quando a origem tem saída',
  '  única, e o rótulo do resultado quando tem mais de uma;',
  '- o `contract` de todo nó traz `checks` com PELO MENOS UMA verificação, e',
  '  isso vale igual para portão, que é nó como outro qualquer. Lista vazia é',
  '  reprovada na regra de soundness `no_com_contrato`, no mesmo portão de',
  '  importação — e onde você não consegue escrever a verificação de uma etapa,',
  '  não há portão nenhum ali: prefira dizer isso no seu turno a devolver uma',
  '  lista vazia.',
].join('\n');

/** One skill of the catalogue, rendered so a person can audit the prompt too. */
function renderSkill(skill: RegisteredSkill): string {
  return [
    `### \`${skill.id}\``,
    '',
    `- role: ${skill.role}`,
    `- description: ${skill.description}`,
    `- skill_ref (copie literalmente): {"id": ${JSON.stringify(skill.id)}, "version": ${JSON.stringify(skill.version)}, "hash": ${JSON.stringify(skill.hash)}}`,
    `- input: ${JSON.stringify(skill.input)}`,
    `- output: ${JSON.stringify(skill.output)}`,
    `- checks: ${JSON.stringify(skill.checks)}`,
  ].join('\n');
}

/** The suggestion block, or the sentence that says there is no suggestion. */
function renderSimilar(similarClasses: readonly SimilarClass[]): string[] {
  if (similarClasses.length === 0) {
    return [
      'Nenhuma classe registrada se parece com esta declaração. Componha do zero,',
      'a partir do catálogo abaixo.',
    ];
  }

  return [
    'Estas classes JÁ REGISTRADAS se parecem com a declaração. Elas são',
    'precedente, não destino: a classe a compor continua sendo a que o usuário',
    'nomeou. Use-as para reaproveitar formato de nó e de portão, nunca para',
    'trocar o nome da classe.',
    '',
    ...similarClasses.map(
      (item) =>
        `- \`${item.classe}\` (proximidade ${item.score.toFixed(2)}) — ${item.nome}${
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
          'O registro de skills está vazio: nenhuma skill registrada para compor.',
          'Proponha os nós mesmo assim, deixando `skill_ref` com o id que a',
          'capacidade PRECISARIA ter, e diga no seu turno que o pin não existe —',
          'quem edita depois vai ter que registrar a skill antes de importar.',
        ]
      : skills.map(renderSkill);

  return [
    `# Declaração do problema`,
    '',
    declaration,
    '',
    `# Classe a compor: \`${className}\``,
    '',
    'Este nome é do usuário e é final.',
    '',
    '# Precedentes',
    '',
    ...renderSimilar(similarClasses),
    '',
    '# Catálogo de capacidades registradas',
    '',
    ...catalogue,
    '',
    '# O que devolver',
    '',
    'Termine seu turno com EXATAMENTE UM bloco cercado assim, e nada depois dele:',
    '',
    `\`\`\`${PROPOSAL_FENCE}`,
    '{ ... documento de grafo ... }',
    '```',
    '',
    'O documento é um JSON no formato de `schema/grafo.schema.json`, com as oito',
    'chaves obrigatórias e nada além delas:',
    '',
    `- \`problem_class\`: ${JSON.stringify(className)};`,
    '- `lineage`: `{"type": "base"}`;',
    '- `metadata`: com `name`, `description` e `schema_version` `"1.0.0"`;',
    '- `nodes`: cada um com `id`, `role`, `node_type` (`work` ou `gate`),',
    '  `skill_ref` e `contract` (`input_schema`, `output_schema`, `checks`);',
    '- `edges`: cada uma com `from`, `to` e `condition`;',
    '- `initial_node` e `final_nodes`;',
    '- `custom_fields`: os campos que os tickets desta classe carregam além de',
    '  título e corpo. Escreva `[]` quando o pedido não mencionar nenhum — a',
    '  chave é obrigatória mesmo vazia, e inventar campo que ninguém pediu é',
    '  trabalho a mais para quem for preencher.',
    '',
    'O `skill_ref` de cada nó é copiado literalmente do catálogo acima:',
    'nunca invente id, versão nem hash — um pin inventado é reprovado no portão',
    'de importação e joga fora a edição de quem vier depois de você.',
    '',
    '## `contract.checks`: pelo menos uma por nó',
    '',
    '`contract.checks` é uma lista com PELO MENOS UMA verificação. Lista',
    'vazia é reprovada na importação (`no_com_contrato`), e o grafo volta para',
    'quem já tinha editado ele. Cada item é de um destes dois formatos, e nada',
    'além destes campos:',
    '',
    ...VERIFICATION_EXAMPLES.map((example) => `- \`${JSON.stringify(example)}\``),
    '',
    'Não copie os `checks` do catálogo para dentro de `contract.checks`: eles',
    'estão no formato do manifesto de skill, que é outro documento. A diferença',
    'que reprova é `required_evidence` — lista de artefatos no manifesto, o',
    'literal `true` aqui. Leia os `checks` do catálogo para saber COMO a',
    'capacidade se confere e reescreva a verificação nos dois formatos acima.',
  ].join('\n');
}
