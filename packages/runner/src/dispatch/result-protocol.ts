/**
 * The paragraph that tells a session how to hand its result back (t161 FR9,
 * t259 FR3).
 *
 * Two facts share one block, and that is the whole design of this module. A node
 * with a `contract.output_schema` owes an OBJECT — it is told so in its prompt,
 * and it is told that object is what its output is checked against. A node with
 * more than one way out also owes a DECISION, and the graph is explicit that the
 * decision is an edge's `condition` label. Both travel in the same fenced
 * `` ```resultado `` block, the label as one field of the report, because two
 * blocks would be two chances for a session to emit one and forget the other —
 * and `parse-node-result.ts` reads exactly one.
 *
 * **Why this used to speak only to gates.** Until t259 the whole of this file
 * was `routingProtocol`, rendered only for `edges.length >= 2`. It answered the
 * question t161 had — which edge? — and nobody had yet asked the other one,
 * because until t253 there was nowhere for a node's structured output to go.
 * With `session.output` stored and projected, a `work` node that is never told
 * how to report is a node whose successor has nothing to read: the software
 * bundle's `desenvolver` would hand `integrar` no `branch`, forever.
 *
 * A node with no `output_schema` gets nothing from here. There is nothing to
 * conform to, so asking for a shape would be asking a session to invent one.
 *
 * **Where the routing vocabulary comes from is a decision, not an accident.**
 * The labels are the `condition` of the edges leaving THIS node, taken from the
 * graph — not the `outcome` enum of the skill's own `output`, which is a
 * different vocabulary with different values (`pass`/`fail`/`escalate_human`,
 * enforced at registry entry). The graph spec is explicit that an edge's label
 * matches the outcome the source node's `output_schema` declares
 * (`docs/spec/grafo.md`), and that schema is the NODE's contract. One skill can
 * sit under two graphs whose edges are labelled differently, and reading the
 * labels off the graph is what lets it.
 *
 * Composed here and decided next door: `render-skill-instructions.ts` is what
 * knows whether this node has a schema and how many ways out it has. Same split
 * `escalation-protocol.ts` already has, for the same reason — the 600-line
 * budget of `src/dispatch/` (t223).
 *
 * English per D18. The paragraph itself is Portuguese, like every other text in
 * this package that reaches a model.
 */

import type { GraphEdge } from './resolve-node.ts';

/** Does this node declare a shape its session has to report back in? */
export function hasOutputSchema(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    Object.keys(schema).length > 0
  );
}

/**
 * The sentences that describe what happens when the session names no edge.
 *
 * They have to agree with the paragraph at the top of `dispatch.ts`: at a
 * `never` node the wiring blocks the work instead of raising a question, and a
 * session sent back to a block that will not become a question is a prompt lying
 * about the wiring it runs under (t167).
 */
function whenNothingMatches(canAsk: boolean): string[] {
  return canAsk
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
}

/**
 * The closing paragraph of a session that owes a result.
 *
 * @param edges The edges leaving this node, in document order. Two or more make
 *   the node a decision, and the routing key joins the report; a single one is
 *   deterministic by construction, and asking it to choose would invent a
 *   decision it does not have — and then escalate to a human when the session,
 *   correctly, did not make one.
 * @param canAsk Whether this node's escalation policy lets it raise a question.
 * @returns The lines of the paragraph.
 */
export function resultProtocol(edges: readonly GraphEdge[], canAsk: boolean): string[] {
  const labels = edges.map((edge) => edge.condition ?? '').filter((label) => label !== '');
  const routes = edges.length >= 2 && labels.length > 0;

  const heading = routes
    ? '## Como fechar o turno: relate o resultado e diga para onde o trabalho vai'
    : '## Como fechar o turno: relate o resultado';

  // The example payload is the report itself, with the routing key first when
  // there is one: a session reads the shape before it reads the prose, and a
  // key shown outside the object is a key that comes back in a block of its own.
  const example = routes
    ? `{"resultado": "<um de: ${labels.join(', ')}>", ...o que o schema de saída declara}`
    : '{...exatamente o que o schema de saída deste nó declara}';

  // Built with concatenation and not with a nested template literal: the D18
  // sweep's masking scanner reads one backtick at a time, and a template inside
  // a `${…}` silently desyncs it for the whole rest of the file
  // (`test/no-portuguese-identifiers.test.ts`).
  const quoted = labels.map((label) => '`' + label + '`').join(', ');

  const preamble = routes
    ? [
        `Este nó tem mais de uma saída — ${quoted} —,`,
        'e quem escolhe qual delas vale é você. Termine seu turno com exatamente UM',
        'bloco cercado, e nada depois dele: o objeto que o contrato deste nó pede,',
        'com o campo `resultado` DENTRO dele nomeando a aresta escolhida.',
      ]
    : [
        'Termine seu turno com exatamente UM bloco cercado, e nada depois dele,',
        'trazendo o objeto que o `output_schema` deste nó declara. É esse objeto —',
        'e nada mais do que você imprimir — que fica registrado como o resultado',
        'desta etapa e que a etapa seguinte recebe como entrada.',
      ];

  return [
    heading,
    '',
    ...preamble,
    '',
    '```resultado',
    example,
    '```',
    '',
    ...(routes
      ? whenNothingMatches(canAsk)
      : [
          'Um bloco malformado, ou nenhum bloco, não é uma falha da sessão: é uma',
          'etapa que terminou sem dizer o que produziu, e quem vier depois não vai',
          'ter o que ler.',
        ]),
  ];
}
