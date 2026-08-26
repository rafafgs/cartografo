/**
 * t313: the specs under `docs/spec/` say what the code says today.
 *
 * The tail of the D24 prose sweep, and the part no existing gate could have
 * caught. `tests/no-portuguese-document-tree.test.mjs` blanks fenced blocks and
 * backtick spans before it scans a `.md` file, deliberately — that is where
 * frozen wire vocabulary and quoted history live — so every Portuguese fragment
 * this file is about sat inside the one place the sweep is blind by design, and
 * the suite was green over all of it.
 *
 * What the reading turned up is that most of it was not untranslated prose at
 * all. Nine sites described behaviour that had ALREADY shipped in English and
 * whose documentation simply never moved: an error code the proxy stopped
 * sending, a prompt template the runner rewrote, a whole diff vocabulary that
 * went English with the rest of the screen's copy. Translating those literally
 * would have preserved a lie in better spelling.
 *
 * So this gate does not check spelling. **It derives what the doc must say from
 * the source that produces it** — importing `diff.js` and calling it, importing
 * `graph-soundness.js` and rendering a violation through it, parsing the
 * literals out of `prompt.ts` — and compares. A doc that drifts again fails
 * here, and so does a doc translated into English that the code never said.
 *
 * The two exceptions are asserted as loudly as the rules, because an unexplained
 * exception gets "fixed" by the next ticket that reads it:
 *
 * - the frozen wire keys of the evidence/metric example must SURVIVE (AT5);
 * - `intake.md`'s user-content example must survive verbatim (AT7).
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC } from '../scripts/no-portuguese-prose.mjs';
import { ACTIONS } from '../packages/screen/src/public/actions.js';
import { EMPTY_DIFF_LINE, renderOperations } from '../packages/screen/src/public/diff.js';
import { MANUAL_EVIDENCE, MANUAL_METRIC } from '../packages/screen/src/public/graph-editor.js';
import { renderReport } from '../packages/screen/src/public/graph-soundness.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/** One repo-relative file, whole. */
function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/** One spec of `docs/spec/`, whole. */
function spec(name) {
  return read(path.posix.join('docs', 'spec', name));
}

/**
 * Every fenced block of a document, as its inner text.
 *
 * The opposite reading of `proseOf` in the document-tree sweep: that gate blanks
 * the fences to see the prose, and this one keeps only the fences, because the
 * fences are where this ticket's whole subject lives.
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per fenced block, fence lines excluded.
 */
function fencedBlocksOf(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let opened = null;

  lines.forEach((line, index) => {
    if (!/^\s*`{3,}/.test(line)) return;
    if (opened === null) {
      opened = index;
      return;
    }
    blocks.push(lines.slice(opened + 1, index).join('\n'));
    opened = null;
  });

  return blocks;
}

/** The one fenced block that carries `needle`, or `null`. */
function fencedBlockWith(markdown, needle) {
  return fencedBlocksOf(markdown).find((block) => block.includes(needle)) ?? null;
}

/** Every line carrying a Portuguese diacritic, with its number. */
function diacriticLinesOf(contents) {
  return contents
    .split('\n')
    .map((line, index) => ({ number: index + 1, text: line }))
    .filter((entry) => DIACRITIC.test(entry.text));
}

test('AT1 — screen.md names the untrusted-origin refusal the proxy really sends', () => {
  const document = spec('screen.md');

  assert.equal(
    document.includes('origem_nao_confiavel'),
    false,
    'the wire code moved to `untrusted_origin` (`packages/screen/src/proxy.ts:57`) and the ' +
      'spec still quotes the retired one',
  );
  assert.equal(
    document.includes('origem não confiável'),
    false,
    'the 403 PAGE reads `untrusted origin` since t310 (`packages/screen/src/router.ts:396`)',
  );

  assert.ok(document.includes('untrusted_origin'), 'the wire code the proxy answers with');
  assert.ok(document.includes('`untrusted origin`'), 'the title of the page a person meets');

  // The sentence around it claimed the page was "in Portuguese like all the
  // others". Both halves of that are now false, so the claim has to go with the
  // phrase; a spec that spells the new code inside the old sentence is worse
  // than one that spells neither.
  assert.equal(
    /in Portuguese like\s+all the others/.test(document),
    false,
    'the screen stopped being in Portuguese at t310; the sentence has to say so',
  );
});

test('AT2 — entities-versioning.md names the validators and rules the code exports', () => {
  const document = spec('entities-versioning.md');
  const graph = read('packages/core/src/domain/graph.ts');

  for (const name of ['validateStructure', 'validateSoundness']) {
    assert.ok(
      graph.includes(`export function ${name}(`),
      `the premise of this check is gone: \`${name}\` is not exported any more`,
    );
    assert.ok(document.includes(`\`${name}\``), `the spec has to name \`${name}\``);
  }

  for (const rule of ['reachable', 'terminates', 'edge_with_condition', 'node_with_contract']) {
    assert.ok(document.includes(`\`${rule}\``), `the rule \`${rule}\` is not named in the spec`);
  }

  assert.ok(document.includes('`{valid, errors}`'), "the structure report's envelope");
  assert.ok(document.includes('`{valid, violations}`'), "the soundness report's envelope");

  for (const retired of [
    'validarEstrutura',
    'validarSoundness',
    'alcançável',
    'aresta_com_condicao',
    'no_com_contrato',
    '{valido, erros}',
    '{valido, violacoes}',
  ]) {
    assert.equal(
      document.includes(retired),
      false,
      `the spec still cites \`${retired}\`, which the code retired`,
    );
  }
});

test('AT3 — human-escalation.md carries the redispatch prompt the runner assembles', () => {
  const source = read('packages/runner/src/dispatch/prompt.ts');

  // The block is assembled by two `parts.push` calls inside one conditional.
  // Slicing to it first keeps the earlier pushes of the same function out.
  const start = source.indexOf('if (alreadyClosed.length > 0) {');
  const end = source.indexOf('return parts.join(', start);
  assert.ok(start !== -1 && end > start, 'the assembly this gate reads is not in `prompt.ts` any more');

  const assembly = source.slice(start, end);
  const pushes = [...assembly.matchAll(/parts\.push\(\s*([\s\S]*?)\s*\);/g)].map((call) =>
    [...call[1].matchAll(/'([^']*)'|`([^`]*)`/g)].map((piece) => piece[1] ?? piece[2]),
  );

  assert.equal(pushes.length, 2, 'the block is two pushes: the header, then one entry per question');

  const [header, entry] = pushes;
  const heading = header.find((piece) => piece.startsWith('## '));
  const sentence = header.find((piece) => piece !== '' && !piece.startsWith('## '));
  const asked = entry.find((piece) => piece.includes('You asked'));
  const replied = entry.find((piece) => piece.includes('replied'));

  for (const piece of [heading, sentence, asked, replied]) {
    assert.ok(piece !== undefined, `a literal of the prompt block did not parse out of \`prompt.ts\``);
  }

  /** A template literal with its interpolations filled by the doc's placeholders. */
  const fill = (template, placeholders) => {
    let next = 0;
    return template.replace(/\$\{[^}]*\}/g, () => placeholders[next++]);
  };

  const expected = [
    heading,
    '',
    sentence,
    '',
    fill(asked, ['<the question>']),
    fill(replied, ['<who>', '<the answer>']),
  ].join('\n');

  const block = fencedBlockWith(spec('human-escalation.md'), heading);

  assert.equal(
    block,
    expected,
    'the prompt template in the spec is not byte-identical to the one `prompt.ts` assembles',
  );
});

test('AT4 — screen-proposal-inbox.md speaks the inbox’s own vocabulary', () => {
  const document = spec('screen-proposal-inbox.md');
  const proxy = read('packages/screen/src/proxy.ts');

  const code = /UPSTREAM_DOWN_CODE = '([^']+)'/.exec(proxy)?.[1];
  assert.equal(code, 'control_plane_unavailable', "the proxy's own name for a control plane that is down");
  assert.ok(document.includes(code), `the spec has to quote \`${code}\``);
  assert.equal(
    document.includes('control_plane_indisponivel'),
    false,
    'the spec still quotes the retired code',
  );

  for (const action of ['reject', 'revert']) {
    const label = ACTIONS[action].reasonLabel;
    assert.ok(label.length > 0, `\`${action}\` is supposed to demand a written reason`);
    assert.ok(
      document.includes(label),
      `the \`<label>\` question of \`${action}\` is not in the spec verbatim: ${label}`,
    );
  }

  // The whole table, produced by the module that produces it on the page.
  const rendered = renderOperations([
    { type: 'add_node', node: { id: 'red_team', node_type: 'gate' } },
    { type: 'remove_node', node_id: 'manual_review' },
    { type: 'add_edge', edge: { from: 'test', to: 'red_team', condition: 'approved' } },
    { type: 'remove_edge', edge: { from: 'test', to: 'deploy' } },
    { type: 'change_node_field', node_id: 'implement', field: 'role', from: 'do', to: 'check' },
    { type: 'move_node' },
    'not an operation at all',
  ]);

  for (const line of [...rendered, ...renderOperations([])]) {
    assert.ok(
      document.includes(`\`${line}\``),
      `the diff table does not carry the line \`diff.js\` really renders: ${line}`,
    );
  }

  assert.equal(renderOperations([])[0], EMPTY_DIFF_LINE, 'an empty proposal has its own line');

  for (const retired of [
    '+ nó',
    '- nó',
    '+ aresta',
    'operação de tipo desconhecido',
    'operação malformada',
    'nenhuma alteração',
  ]) {
    assert.equal(
      document.includes(retired),
      false,
      `the diff table still carries the retired rendering \`${retired}\``,
    );
  }
});

test('AT5 — screen-graph-editor.md corrects its copy and keeps its frozen keys', () => {
  const document = spec('screen-graph-editor.md');
  const editor = read('packages/screen/src/public/graph-editor.js');

  const frozenNote = /FROZEN_NOTE = '([^']+)'/.exec(editor)?.[1];
  assert.equal(frozenNote, 'remove and re-create the node to change this', 'the read-only phrase');
  assert.ok(document.includes(`\`${frozenNote}\``), 'the spec has to quote the phrase as it reads');
  assert.equal(
    document.includes('remova e recrie o nó para mudar isso'),
    false,
    'the spec still quotes the retired phrase',
  );

  assert.ok(document.includes('`stale_proposal`'), 'the 409 the editor really handles');
  assert.ok(
    document.includes('`the graph base moved while you were editing`'),
    'the line the page really shows on a stale base',
  );
  for (const retired of ['proposta_desatualizada', 'a base do grafo mudou enquanto você editava']) {
    assert.equal(document.includes(retired), false, `the spec still quotes \`${retired}\``);
  }

  // The wire shape stays. `packages/core` validates a proposal against these
  // exact keys, and t310 moved the free text around them without touching one
  // of them; a sweep that "finishes the job" here breaks `POST /v1/proposals`.
  const example = fencedBlockWith(document, 'metrica_esperada');
  assert.ok(example !== null, 'the evidence/metric example is gone from the spec');

  for (const key of [
    'evidencia',
    'fonte',
    'observacao',
    'metrica_esperada',
    'nome',
    'direcao',
    'de',
    'para',
  ]) {
    assert.ok(
      example.includes(`"${key}"`),
      `the frozen wire key "${key}" was translated; it is what the core validates on`,
    );
  }
  assert.ok(example.includes('"sobe"'), 'the frozen enum value of `direcao`');

  // ...and the free text inside it moves, because that is all t310 moved.
  const values = JSON.parse(example);
  assert.equal(values.evidencia.fonte, MANUAL_EVIDENCE.source, "the example's `fonte`");
  assert.equal(values.evidencia.observacao, MANUAL_EVIDENCE.note, "the example's `observacao`");
  assert.equal(values.metrica_esperada.nome, MANUAL_METRIC.nome, "the example's metric name");

  // The four rule sentences, rendered by the module that renders them.
  const sentences = [
    ...renderReport({ soundness: { violations: [{ rule: 'reachable', target: 'X' }] } }),
    ...renderReport({ soundness: { violations: [{ rule: 'terminates', target: 'X' }] } }),
    ...renderReport({
      soundness: { violations: [{ rule: 'edge_with_condition', target: { from: 'A', to: 'B' } }] },
    }),
    ...renderReport({ soundness: { violations: [{ rule: 'node_with_contract', target: 'X' }] } }),
  ];

  assert.equal(sentences.length, 4, 'one sentence per rule');

  for (const sentence of sentences) {
    assert.ok(
      document.includes(`\`${sentence}\``),
      `the rule table does not carry the sentence \`graph-soundness.js\` really renders: ${sentence}`,
    );
  }
});

test('AT6 — the four translated specs carry no Portuguese diacritic at all', () => {
  for (const name of ['graph.md', 'events-stream.md', 'webhooks-events.md', 'transition-hooks.md']) {
    const offenders = diacriticLinesOf(spec(name)).map(
      (entry) => `docs/spec/${name}:${String(entry.number)}: ${entry.text.trim().slice(0, 120)}`,
    );

    assert.deepEqual(offenders, [], `Portuguese survives in ${name}:\n${offenders.join('\n')}`);
  }

  // The two demo transcripts are the same round, printed by two specs, and they
  // are supposed to stay the same round.
  const title = /#\d+ job\.created \{"title":"([^"]+)"/;
  assert.equal(
    title.exec(spec('events-stream.md'))?.[1],
    title.exec(spec('webhooks-events.md'))?.[1],
    'the two specs print the same demo round and have to agree on its title',
  );
});

test('AT6 — the six corrected specs carry no Portuguese diacritic either', () => {
  for (const name of [
    'screen.md',
    'entities-versioning.md',
    'human-escalation.md',
    'screen-proposal-inbox.md',
    'screen-graph-editor.md',
  ]) {
    const offenders = diacriticLinesOf(spec(name)).map(
      (entry) => `docs/spec/${name}:${String(entry.number)}: ${entry.text.trim().slice(0, 120)}`,
    );

    assert.deepEqual(offenders, [], `Portuguese survives in ${name}:\n${offenders.join('\n')}`);
  }
});

test('AT7 — intake.md keeps the submitted-content example its fixtures reuse', () => {
  const document = spec('intake.md');

  // Not an oversight and not a leftover: intake accepts an item in any language,
  // and this example is the same item three test files submit as realistic user
  // content. Translating it here would leave the spec describing a request the
  // suite never makes. If those fixtures ever move, this exception lapses with
  // them — which is why the fixtures are read here rather than trusted.
  const fixtures = [
    'packages/core/test/domain-intake.test.ts',
    'packages/core/test/intake-routes.test.ts',
  ];

  for (const fixture of fixtures) {
    assert.ok(
      read(fixture).includes('Migração 0005'),
      `${fixture} no longer submits the example this exception exists for`,
    );
  }

  for (const kept of [
    '"Migração 0005"',
    '"Colunas novas em trabalho e as duas tabelas do intake."',
    '"a migração roda do zero"',
  ]) {
    assert.ok(document.includes(kept), `the submitted-content example lost ${kept}`);
  }

  // ...and nothing else in the file is Portuguese. The transcript's labels used
  // to contradict the sentence above them, which claims the flow "speaks English
  // from beginning to end".
  const offenders = diacriticLinesOf(document)
    .filter((entry) => !/Migração 0005|Colunas novas|a migração roda do zero/.test(entry.text))
    .map((entry) => `docs/spec/intake.md:${String(entry.number)}: ${entry.text.trim().slice(0, 120)}`);

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives outside the submitted-content example:\n${offenders.join('\n')}`,
  );
});
