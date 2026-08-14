/**
 * Acceptance tests of the `grafo-proposto` block parser (t115, AT3).
 *
 * Same three rules as `dispatch/parse-input-request.ts`, under a fence of its
 * own: the block's extent comes from the JSON (never from a search for the
 * closing fence), a malformed block is ignored instead of raised, and the last
 * valid block wins. The rules are inherited rather than re-decided — a
 * synthesis session emits exactly the kind of output that breaks a naive scan,
 * because a graph document's `descricao` routinely quotes fenced examples.
 *
 * The fence is its own name, not a reuse of `input-request`: two blocks that
 * mean different things must not be able to be mistaken for one another by a
 * dispatch that reads both streams.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as ParserModule from '../../src/synthesizer/parse-graph-proposal.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..');
const MODULE_PATH = 'src/synthesizer/parse-graph-proposal.ts';

let cache: typeof ParserModule | null = null;

async function loadParser(): Promise<typeof ParserModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, MODULE_PATH)),
    `artifact does not exist yet: packages/runner/${MODULE_PATH}`,
  );
  cache ??= (await import(
    new URL('../../src/synthesizer/parse-graph-proposal.ts', import.meta.url).href
  )) as typeof ParserModule;
  return cache;
}

/** Wraps a payload in the fenced block a synthesis session emits. */
function block(payload: string): string {
  return ['```grafo-proposto', payload, '```'].join('\n');
}

/** A graph document, in the shape of `schema/grafo.schema.json`. */
function graph(className: string): Record<string, unknown> {
  return {
    classe: className,
    linhagem: { tipo: 'base' },
    metadata: { nome: className, versao_schema: '1.0.0' },
    nos: [
      {
        id: 'redigir',
        papel: 'redator',
        tipo_no: 'trabalho',
        skill_ref: { id: 'cartografo/redigir-nota', versao: '1.0.0', hash: `sha256:${'0'.repeat(64)}` },
        contrato: { entrada_schema: {}, saida_schema: {}, verificacoes: [] },
      },
    ],
    arestas: [],
    no_inicial: 'redigir',
    nos_finais: ['redigir'],
  };
}

test('AT3 — a well-formed block yields the document untouched', async () => {
  const { parseGraphProposal } = await loadParser();

  const document = graph('nota-curta');
  const output = [
    'I read the declaration and the skill catalogue.',
    'Here is the topology I propose:',
    block(JSON.stringify(document, null, 2)),
  ].join('\n');

  assert.deepEqual(parseGraphProposal(output), document);
});

test('AT3 — with more than one block, the last valid one wins', async () => {
  const { parseGraphProposal } = await loadParser();

  const output = [
    'A first sketch:',
    block(JSON.stringify(graph('rascunho'))),
    'on reflection the class needs a gate, so:',
    block(JSON.stringify(graph('final'))),
  ].join('\n');

  assert.deepEqual(parseGraphProposal(output), graph('final'));
});

test('AT3 — a malformed block is ignored instead of thrown', async () => {
  const { parseGraphProposal } = await loadParser();

  assert.equal(parseGraphProposal(block('{"classe": "unterminated')), null);
  assert.equal(parseGraphProposal(block('not json at all')), null);
  assert.equal(
    parseGraphProposal(block(JSON.stringify(['a', 'list', 'is', 'not', 'a', 'document']))),
    null,
    'the payload is a graph document, and a document is an object',
  );
  assert.equal(parseGraphProposal(''), null);
  assert.equal(parseGraphProposal('I could not compose a graph from this declaration.'), null);
  assert.equal(
    parseGraphProposal(`\`\`\`json\n${JSON.stringify(graph('nota-curta'))}\n\`\`\``),
    null,
    'a fence of another kind is not a proposal',
  );
});

test('AT3 — a malformed block does not shadow a valid one, in either direction', async () => {
  const { parseGraphProposal } = await loadParser();

  assert.deepEqual(
    parseGraphProposal(
      [block('{"classe": "half-writ'), 'that came out wrong, again:', block(JSON.stringify(graph('boa')))].join(
        '\n',
      ),
    ),
    graph('boa'),
  );

  assert.deepEqual(
    parseGraphProposal([block(JSON.stringify(graph('boa'))), block('{"classe": broken')].join('\n')),
    graph('boa'),
    'garbage after the answer cannot erase the answer',
  );
});

test('AT3 — a closing fence inside the JSON does not truncate the block', async () => {
  const { parseGraphProposal } = await loadParser();

  // The reason the extent comes from the JSON and never from a search for the
  // next ```: a node's `descricao` is prose written by a model, and prose about
  // a graph quotes fenced examples of graphs.
  const document = graph('nota-curta');
  const nodes = document.nos as Record<string, unknown>[];
  nodes[0].descricao = 'Escreve a nota. Exemplo de saída:\n```json\n{"texto": "..."}\n```\nE só.';

  assert.deepEqual(parseGraphProposal(block(JSON.stringify(document))), document);
});
