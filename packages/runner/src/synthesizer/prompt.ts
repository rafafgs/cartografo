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
 * English per D18; the prompt's own text is Portuguese, like every other agent
 * instruction in the repository, because the domain vocabulary the session has
 * to produce (`classe`, `linhagem`, `nos`, `portao`) is Portuguese.
 */

import type { RegisteredSkill } from './control-plane-client.ts';

/** A registered class that scored against the declaration (FR3). */
export interface SimilarClass {
  /** The class id, which is also the lineage id (D8). */
  classe: string;
  /** `metadata.nome` of its current version. */
  nome: string;
  /** `metadata.descricao` of its current version; empty when it declares none. */
  descricao: string;
  /** Jaccard score in `[0, 1]`. */
  score: number;
}

/** The fence the session answers in. Named once, used by prompt and parser. */
export const PROPOSAL_FENCE = 'grafo-proposto';

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
  '- a `classe` do documento é a que o usuário deu, literalmente. Você não nomeia',
  '  classe, não corrige o nome e não sugere outro;',
  '- `linhagem` é sempre `{"tipo": "base"}`: variante nasce de fork com proposta,',
  '  e não é isto aqui;',
  '- todo nó carrega `skill_ref` copiado LITERALMENTE do catálogo (id, versao e',
  '  hash juntos, do mesmo item). Nunca invente id, versão ou hash: o pin é o que',
  '  impede troca silenciosa de capacidade por baixo de um grafo já validado;',
  '- todo nó precisa de aresta de entrada e de saída, `no_inicial` precisa existir',
  '  em `nos`, e `nos_finais` também — um grafo que não alcança o fim é reprovado',
  '  no portão de soundness antes de qualquer humano ler;',
  '- toda aresta tem `condicao`: o literal `"sempre"` quando a origem tem saída',
  '  única, e o rótulo do resultado quando tem mais de uma.',
].join('\n');

/** One skill of the catalogue, rendered so a person can audit the prompt too. */
function renderSkill(skill: RegisteredSkill): string {
  return [
    `### \`${skill.id}\``,
    '',
    `- papel: ${skill.papel}`,
    `- descricao: ${skill.descricao}`,
    `- skill_ref (copie literalmente): {"id": ${JSON.stringify(skill.id)}, "versao": ${JSON.stringify(skill.versao)}, "hash": ${JSON.stringify(skill.hash)}}`,
    `- entrada: ${JSON.stringify(skill.entrada)}`,
    `- saida: ${JSON.stringify(skill.saida)}`,
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
    'O documento é um JSON no formato de `schema/grafo.schema.json`, com as sete',
    'chaves obrigatórias e nada além delas:',
    '',
    `- \`classe\`: ${JSON.stringify(className)};`,
    '- `linhagem`: `{"tipo": "base"}`;',
    '- `metadata`: com `nome`, `descricao` e `versao_schema` `"1.0.0"`;',
    '- `nos`: cada um com `id`, `papel`, `tipo_no` (`trabalho` ou `portao`),',
    '  `skill_ref` e `contrato` (`entrada_schema`, `saida_schema`, `verificacoes`);',
    '- `arestas`: cada uma com `de`, `para` e `condicao`;',
    '- `no_inicial` e `nos_finais`.',
    '',
    'O `skill_ref` de cada nó é copiado literalmente do catálogo acima:',
    'nunca invente id, versão nem hash — um pin inventado é reprovado no portão',
    'de importação e joga fora a edição de quem vier depois de você.',
  ].join('\n');
}
