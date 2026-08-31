/**
 * The JSON a document shows is JSON the schema would accept.
 *
 * A specification carries two kinds of claim, and only one of them is prose.
 * The other is the example: the block a reader copies, adapts and ships. When
 * the format moves and the example does not, that block goes on looking
 * authoritative while naming fields the validator rejects — and a reader
 * following it writes a document that cannot be imported.
 *
 * That is not hypothetical. `docs/spec/graph.md` spent weeks showing
 * `no_inicial`, `nos`, `arestas` and `contrato` after the schema had renamed
 * them to `initial_node`, `nodes`, `edges` and `contract`. Every prose gate in
 * the tree was green over it, because all of them blank fenced blocks before
 * they read — the example lives in the one place a prose sweep is blind by
 * design.
 *
 * So this gate reads exactly there. It takes every ` ```json ` fence of the
 * graph specification, parses it, and checks the keys of each object against
 * the property names `schema/graph.schema.json` actually defines. It says
 * nothing about spelling, language or style: an unknown key fails whatever it
 * is called, and a key the schema defines passes.
 *
 * Its sibling is `tests/docs-match-code.test.mjs`, which asks the same question
 * of the prose a document writes rather than the JSON it shows.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const SPEC = path.join('docs', 'spec', 'graph.md');
const SCHEMA = path.join('schema', 'graph.schema.json');

/**
 * Placeholders an example is allowed to use in a key position.
 *
 * The specification writes elisions as real JSON so the block still parses;
 * they are punctuation, not field names.
 */
const PLACEHOLDERS = new Set(['…', '...']);

/**
 * Every property name the schema defines, at any depth.
 *
 * The check is per key and not per position on purpose: an example is usually
 * a fragment — one node, one edge, one contract — and pinning each fence to its
 * place in the document would make the gate a parser of the specification's
 * prose rather than of its JSON.
 *
 * @param {unknown} node Any subtree of the schema document.
 * @param {Set<string>} into Accumulator.
 * @returns {Set<string>} Every name reachable under a `properties` keyword.
 */
function propertyNames(node, into = new Set()) {
  if (Array.isArray(node)) {
    for (const entry of node) propertyNames(entry, into);
    return into;
  }
  if (node === null || typeof node !== 'object') return into;

  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'properties' && value !== null && typeof value === 'object') {
      for (const name of Object.keys(value)) into.add(name);
    }
    propertyNames(value, into);
  }

  return into;
}

/**
 * The ` ```json ` fences of a Markdown document, with the line each opens on.
 *
 * @param {string} markdown Contents of one document.
 * @returns {{line: number, body: string}[]} One entry per fence, in order.
 */
function jsonFences(markdown) {
  const lines = markdown.split('\n');
  const fences = [];
  let open = null;

  lines.forEach((line, index) => {
    if (open === null) {
      if (/^\s*```json\s*$/.test(line)) open = { line: index + 1, body: [] };
      return;
    }
    if (/^\s*```\s*$/.test(line)) {
      fences.push({ line: open.line, body: open.body.join('\n') });
      open = null;
      return;
    }
    open.body.push(line);
  });

  return fences;
}

/**
 * One fence as a JSON value, or `null` when it is not a whole one.
 *
 * A fence may elide a subtree with a `/* ... *\/` comment, which is how the
 * specification shows the shape of one level without the levels under it. The
 * comment is removed before parsing; a fence that still does not parse is a
 * deliberate fragment and is skipped rather than reported, because this gate
 * reads keys and has nothing to say about a block that has none to read.
 *
 * @param {string} body The contents between the fence markers.
 * @returns {unknown} The parsed value, or `null`.
 */
function parsed(body) {
  try {
    return JSON.parse(body.replace(/\/\*[\s\S]*?\*\//g, ''));
  } catch {
    return null;
  }
}

/**
 * Every key of every object in a parsed value, at any depth, minus the
 * arbitrary payloads.
 *
 * `input_schema` and `output_schema` hold a JSON Schema written by whoever
 * declares the node: `ticket_id` and `branch` are that author's field names and
 * this schema knows nothing about them. Their subtrees are not descended into.
 *
 * @param {unknown} value A parsed fence.
 * @param {Set<string>} into Accumulator.
 * @returns {Set<string>} The keys this gate is entitled to judge.
 */
const OPAQUE = new Set(['input_schema', 'output_schema', 'project', 'metadata']);

function keysOf(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, into);
    return into;
  }
  if (value === null || typeof value !== 'object') return into;

  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    if (!OPAQUE.has(key)) keysOf(child, into);
  }

  return into;
}

const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, SCHEMA), 'utf8'));
const known = propertyNames(schema);

test('the schema really was read, and it defines the graph document', () => {
  for (const name of ['problem_class', 'nodes', 'edges', 'initial_node', 'final_nodes']) {
    assert.ok(known.has(name), `the schema no longer defines \`${name}\`; this gate is reading the wrong file`);
  }
});

test('every JSON example in the graph spec names fields the schema defines', () => {
  const markdown = readFileSync(path.join(REPO_ROOT, SPEC), 'utf8');
  const fences = jsonFences(markdown);

  assert.ok(fences.length > 5, `only ${fences.length} JSON fences found in ${SPEC}; the reader is not walking it`);

  const offenders = [];
  for (const fence of fences) {
    const value = parsed(fence.body);
    if (value === null) continue;

    const keys = keysOf(value);
    // Not every fence in this document is a graph: it also shows a traversal
    // record and other entities the graph schema says nothing about. A fence
    // that shares no field at all with the schema is one of those. The limit
    // this accepts, written down rather than discovered later: a rename that
    // retired EVERY field of an example at once would take the example out of
    // scope instead of failing it. No rename in this repository has done that,
    // and the one that motivated this gate left `metadata` standing.
    if (![...keys].some((key) => known.has(key))) continue;

    for (const key of keys) {
      if (known.has(key) || PLACEHOLDERS.has(key)) continue;
      offenders.push(`${SPEC}:${String(fence.line)}: \`${key}\` is in no \`properties\` of ${SCHEMA}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `an example shows a field the validator would reject:\n${offenders.join('\n')}`,
  );
});

test('the gate bites on an example the schema would reject', () => {
  const planted = parsed('{ "no_inicial": "refinar", "nos": [] }');
  const rejected = [...keysOf(planted)].filter((key) => !known.has(key));

  assert.deepEqual(rejected.sort(), ['no_inicial', 'nos']);
});
