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
 * (`docs/spec/graph.md`), and that schema is the NODE's contract. One skill can
 * sit under two graphs whose edges are labelled differently, and reading the
 * labels off the graph is what lets it.
 *
 * Composed here and decided next door: `render-skill-instructions.ts` is what
 * knows whether this node has a schema and how many ways out it has. Same split
 * `escalation-protocol.ts` already has, for the same reason — the 600-line
 * budget of `src/dispatch/` (t223).
 *
 * English, the paragraph included (D24, t309) — with two exceptions that are
 * not prose: the `resultado` key and the `` ```resultado `` fence stay exactly
 * as they are. Both are wire, not language: `parse-node-result.ts` matches the
 * fence, `ROUTE_LABEL_KEY` in `packages/core/src/domain/graph.ts` owns the key,
 * and `session.ts` reads it back to route the work. Renaming either is a
 * wire-format migration across every package, every factory bundle and
 * `docs/spec/graph.md` — tracked in `docs/spec/glossario-wire.md`, and not
 * something a translation gets to do on the way past.
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
        'The value has to be one of those, literally. Anything else — or no block',
        'at all — routes nothing: it becomes a question for a person, and the work',
        'stops until somebody answers.',
        '',
        'If what blocks you is the decision itself, use the `input-request` block',
        'above instead of guessing a result.',
      ]
    : [
        'The value has to be one of those, literally. Anything else — or no block',
        'at all — routes nothing: the work is blocked with the reason, and stops',
        'until somebody looks.',
        '',
        'If what blocks you is the decision itself, report that as a failure of the',
        'contract of this node, with the reason — never guess a result to keep',
        'moving.',
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
    ? '## How to close the turn: report the result and say where the work goes'
    : '## How to close the turn: report the result';

  // The example payload is the report itself, with the routing key first when
  // there is one: a session reads the shape before it reads the prose, and a
  // key shown outside the object is a key that comes back in a block of its own.
  const example = routes
    ? `{"resultado": "<one of: ${labels.join(', ')}>", ...whatever the output schema declares}`
    : '{...exactly what the output schema of this node declares}';

  // Built with concatenation and not with a nested template literal: the D18
  // sweep's masking scanner reads one backtick at a time, and a template inside
  // a `${…}` silently desyncs it for the whole rest of the file
  // (`test/no-portuguese-identifiers.test.ts`).
  const quoted = labels.map((label) => '`' + label + '`').join(', ');

  const preamble = routes
    ? [
        `This node has more than one way out — ${quoted} —,`,
        'and you are the one who picks which of them holds. End your turn with',
        'exactly ONE fenced block, and nothing after it: the object the contract of',
        'this node asks for, with the `resultado` field INSIDE it naming the edge',
        'you chose.',
      ]
    : [
        'End your turn with exactly ONE fenced block, and nothing after it,',
        'carrying the object the `output_schema` of this node declares. That object',
        '— and nothing else you print — is what is recorded as the result of this',
        'step, and what the next step receives as its input.',
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
          'Without that block — or with it malformed — the step ends without saying',
          'what it produced. Nothing fails at the time, and that is exactly the',
          'problem: whoever comes next has nothing to read.',
        ]),
  ];
}
