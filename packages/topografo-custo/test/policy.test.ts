/**
 * Acceptance tests of the cost policies (t114, AT5–AT7).
 *
 * The two policies say different things. `teto` is absolute ("this node went
 * past N tokens") and only exists when somebody declares the ceiling; `tier` is
 * relative ("this node costs much more than its neighbours in the same version")
 * and demands a sample base so as not to call the only measured node an outlier.
 *
 * AT7 guards the boundary of that ticket: neither the graph document nor the
 * skill manifest has a field for cost or tier today, and opening those schemas
 * is forbidden by AC1. Therefore every candidate is advisory — a recommendation
 * appended to the node's `description`, with the real numbers in `evidencia`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PolicyModule from '../src/policy.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'topografo-custo.md');

let cache: typeof PolicyModule | null = null;

async function load(): Promise<typeof PolicyModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'policy.ts')),
    'artifact does not exist yet: packages/topografo-custo/src/policy.ts',
  );
  cache ??= (await import(new URL('../src/policy.ts', import.meta.url).href)) as typeof PolicyModule;
  return cache;
}

/** An already identified cost row (version and node both non-null). */
function row(
  nodeId: string,
  tokens: number,
  partial: Partial<PolicyModule.IdentifiedCostRow> = {},
): PolicyModule.IdentifiedCostRow {
  return {
    grafo_versao_id: 'sha256:v1',
    no_id: nodeId,
    tokens_total: tokens,
    sessoes_com_uso: 1,
    sessoes_sem_uso: 0,
    tempo_total_segundos: 10,
    sessoes_com_tempo: 1,
    sessoes_sem_tempo: 0,
    ...partial,
  };
}

test('AT5 — a ceiling makes a candidate when tokens_total exceeds it, and nothing with no declared ceiling', async () => {
  const { evaluatePolicies } = await load();

  const withCeiling = evaluatePolicies([row('redigir', 5000)], { tokenCeiling: 1000 });
  assert.equal(withCeiling.length, 1);
  assert.equal(withCeiling[0].tipo, 'teto');
  assert.equal(withCeiling[0].no_id, 'redigir');
  assert.equal(withCeiling[0].evidencia.lente, 'custo');
  assert.equal(withCeiling[0].evidencia.teto_excedido, 'tokens');
  assert.equal(withCeiling[0].evidencia.tokens_total, 5000);
  assert.equal(withCeiling[0].metrica_esperada.teto_ou_fator, 1000);

  const withoutCeiling = evaluatePolicies([row('redigir', 5000)], {});
  assert.deepEqual(withoutCeiling, [], 'with no declared ceiling there is nothing to exceed');

  const under = evaluatePolicies([row('redigir', 999)], { tokenCeiling: 1000 });
  assert.deepEqual(under, [], 'exceeding is strictly greater than the ceiling');
});

test('AT6 — tier makes a candidate over the version median, and only with a sample base', async () => {
  const { evaluatePolicies } = await load();

  const version = [row('a', 100), row('b', 100), row('c', 1000)];

  // The median of [100, 100, 1000] is 100; a factor of 3 asks for 300, and only
  // "c" passes.
  const withBase = evaluatePolicies(version, { tierFactor: 3, tierMinNodes: 3 });
  assert.equal(withBase.length, 1);
  assert.equal(withBase[0].tipo, 'tier');
  assert.equal(withBase[0].no_id, 'c');
  assert.equal(withBase[0].evidencia.teto_excedido, null, 'tier is not a ceiling violation');
  assert.equal(withBase[0].metrica_esperada.teto_ou_fator, 3);

  const withoutBase = evaluatePolicies(version, { tierFactor: 3, tierMinNodes: 4 });
  assert.deepEqual(
    withoutBase,
    [],
    'with fewer measured nodes than the minimum there is no outlier to declare',
  );

  // A node with no session reporting usage is not a "node with data": it counts
  // neither for the minimum nor for the median.
  const withOneBlindNode = evaluatePolicies(
    [row('a', 100), row('b', 100), row('c', 0, { sessoes_com_uso: 0, sessoes_sem_uso: 2 })],
    { tierFactor: 3, tierMinNodes: 3 },
  );
  assert.deepEqual(withOneBlindNode, [], 'a node with no reported usage is no sample base');
});

test('AT7 — every candidate carries a single change_node_field over description, with a swapped inverse', async () => {
  const { evaluatePolicies } = await load();

  const candidates = evaluatePolicies([row('a', 100), row('b', 100), row('c', 9000)], {
    tokenCeiling: 1000,
    tierFactor: 3,
    tierMinNodes: 3,
    currentDescription: (graphVersionId, nodeId) => `descrição de ${nodeId} em ${graphVersionId}`,
  });

  assert.ok(
    candidates.some((candidate) => candidate.tipo === 'teto'),
    'the scenario has to produce both types for the rule to hold for both',
  );
  assert.ok(candidates.some((candidate) => candidate.tipo === 'tier'));

  for (const candidate of candidates) {
    assert.equal(candidate.operacoes.length, 1, 'one recommendation is one operation');

    const operation = candidate.operacoes[0];
    assert.equal(operation.type, 'change_node_field');
    assert.equal(operation.field, 'description');
    assert.equal(operation.node_id, candidate.no_id);
    assert.equal(operation.from, `descrição de ${candidate.no_id} em sha256:v1`);
    assert.notEqual(operation.to, operation.from, 'the recommendation has to change something');
    assert.ok(
      String(operation.to).startsWith(String(operation.from)),
      'the recommendation is appended to the current description, it does not replace it',
    );

    assert.equal(operation.inverse.type, 'change_node_field');
    assert.equal(operation.inverse.node_id, operation.node_id);
    assert.equal(operation.inverse.field, 'description');
    assert.equal(operation.inverse.from, operation.to, 'the inverse undoes it: from/to swapped');
    assert.equal(operation.inverse.to, operation.from);

    // t228: the operation's OWN keys are §3's, and nothing else leaks in. The
    // candidate around it keeps this module's vocabulary (`operacoes`,
    // `evidencia`, `metrica_esperada`) — that surface is not §3's.
    assert.deepEqual(Object.keys(operation).sort(), [
      'field',
      'from',
      'inverse',
      'node_id',
      'to',
      'type',
    ]);
  }
});

/* -------------------------------------------------------------------------- */
/* t234 — the spec's example is the operation this module really emits.         */
/* -------------------------------------------------------------------------- */

/**
 * Every ```json block of the spec, parsed.
 *
 * The blocks are read as data and not by line number on purpose: the example of
 * §3 and the `evidencia`/`metrica_esperada` block right under it are told apart
 * by what they ARE — an operation carries `type: 'change_node_field'` — and not
 * by where they sit, so neither test below rots when a paragraph moves.
 */
function jsonBlocks(spec: string): Record<string, unknown>[] {
  return [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map(([, body], index) => {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch (error) {
      return assert.fail(`json block ${index + 1} of the spec does not parse: ${String(error)}`);
    }
  });
}

test('t234 — every operation example of the spec is the operation the policy emits', async () => {
  const { evaluatePolicies } = await load();

  const [candidate] = evaluatePolicies([row('implementar', 5000)], {
    tokenCeiling: 1000,
    currentDescription: () => 'descrição atual',
  });
  assert.ok(candidate !== undefined, 'the scenario has to produce a candidate to compare against');
  const emitted = candidate.operacoes[0];

  const spec = readFileSync(SPEC_PATH, 'utf8');
  const examples = jsonBlocks(spec).filter((block) => block.type === 'change_node_field');
  assert.ok(examples.length > 0, 'the spec has to carry at least one literal operation example');

  for (const example of examples) {
    const inverse = example.inverse as Record<string, unknown>;
    assert.ok(inverse !== undefined && typeof inverse === 'object', 'the example carries an inverse');

    // The keys are §3's since t228. The VALUE of `field` is the half t228 left
    // behind: `CHANGEABLE_FIELDS` never held `descricao`, and the node's field
    // has been `description` since t178 — in `schema/grafo.schema.json` and in
    // `SnapshotNode` alike. A reader copying this block verbatim into a
    // `POST /v1/proposals` body gets `field_not_changeable` back.
    assert.deepEqual(Object.keys(example).sort(), Object.keys(emitted).sort());
    assert.equal(example.type, emitted.type);
    assert.equal(example.field, emitted.field);

    assert.deepEqual(Object.keys(inverse).sort(), Object.keys(emitted.inverse).sort());
    assert.equal(inverse.type, emitted.inverse.type);
    assert.equal(inverse.field, emitted.inverse.field);
  }
});

/**
 * The single `descricao` the spec keeps: the key of `metrica_esperada`.
 *
 * That one is this module's own vocabulary — the same key `t180` pins in the
 * candidates above — and D20 does not reach it. Every OTHER `descricao` in the
 * document names the node's field, which is `description`.
 */
const KEPT_METRIC_KEY = /^\s*"descricao":/;

test('t234 — no `descricao` names the node field anywhere in the spec', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  const hits = spec
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    // Unaccented on purpose: the prose word "descrição" is Portuguese the
    // reader reads, not a field name, and it is not what this sweep is about.
    .filter(({ text }) => /\bdescricao\b/.test(text));

  const offenders = hits.filter(({ text }) => !KEPT_METRIC_KEY.test(text));
  assert.deepEqual(
    offenders.map(({ line, text }) => `${line}: ${text.trim()}`),
    [],
    'the spec names the node field `descricao`, which the API refuses (field_not_changeable)',
  );

  assert.equal(
    hits.length,
    1,
    'the one kept `descricao` is the `metrica_esperada` key, and it stays alone',
  );
});

test('t158 — a time ceiling cites the time sample, not the token one', async () => {
  const { evaluatePolicies } = await load();

  // Five sessions reported usage, two reported both time stamps: the two samples
  // diverge on purpose (`cost.ts`), which is exactly the case in which citing the
  // wrong one misleads whoever reads the recommendation.
  const candidates = evaluatePolicies(
    [
      row('redigir', 100, {
        sessoes_com_uso: 5,
        sessoes_sem_uso: 0,
        tempo_total_segundos: 900,
        sessoes_com_tempo: 2,
        sessoes_sem_tempo: 3,
      }),
    ],
    { secondCeiling: 600 },
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].evidencia.teto_excedido, 'tempo', 'only the time ceiling blew');

  const { to } = candidates[0].operacoes[0];
  assert.ok(
    to.includes('2 sessions with time reported'),
    `the time recommendation leans on the time sample; it came out: ${to}`,
  );
  assert.ok(
    !to.includes('5 sessions'),
    'the token sample does not hold up a time-ceiling recommendation',
  );
});

/* -------------------------------------------------------------------------- */
/* t180 — the text a person reads in the proposal is English; the keys are not. */
/* -------------------------------------------------------------------------- */

test('t180 — the marker and the ceiling and tier recommendations are in English', async () => {
  const { evaluatePolicies, MARKER } = await load();

  assert.equal(MARKER, '[cost-surveyor]', 'the marker uses the glossary term for surveyor');

  const candidates = evaluatePolicies([row('a', 100), row('b', 100), row('c', 9000)], {
    tokenCeiling: 1000,
    tierFactor: 3,
    tierMinNodes: 3,
  });

  const ceiling = candidates.find((candidate) => candidate.tipo === 'teto');
  assert.ok(ceiling !== undefined, 'the scenario has to produce a ceiling candidate');
  assert.equal(
    ceiling.operacoes[0].to,
    '[cost-surveyor] token ceiling exceeded: 9000 tokens observed against a ceiling of 1000, ' +
      'over 1 sessions with usage reported. Reduce the scope of this node, split it, or revisit the ceiling.',
  );
  assert.equal(
    ceiling.metrica_esperada.descricao,
    'tokens_total of node "c" goes back under the declared ceiling',
    'the name of the metric is a format key and does not get translated',
  );

  const tier = candidates.find((candidate) => candidate.tipo === 'tier');
  assert.ok(tier !== undefined, 'the scenario has to produce a tier candidate');
  assert.equal(
    tier.operacoes[0].to,
    '[cost-surveyor] cost out of line in this version: 9000 tokens, 90.0x the median of 100 ' +
      'across the 3 measured nodes (factor 3). Candidate for a cheaper model tier, or for a split into smaller nodes.',
  );
  assert.equal(
    tier.metrica_esperada.descricao,
    'tokens_total of node "c" falls below 3x the version median',
  );
});
