/**
 * Acceptance tests of the cost policies (t114, AT5–AT7).
 *
 * The two policies say different things. `ceiling` is absolute ("this node went
 * past N tokens") and only exists when somebody declares the ceiling; `tier` is
 * relative ("this node costs much more than its neighbours in the same version")
 * and demands a sample base so as not to call the only measured node an outlier.
 *
 * AT7 guards the boundary of that ticket: neither the graph document nor the
 * skill manifest has a field for cost or tier today, and opening those schemas
 * is forbidden by AC1. Therefore every candidate is advisory — a recommendation
 * appended to the node's `description`, with the real numbers in `evidence`.
 *
 * The candidate's own keys are English since t255 (glossary-wire.md §5.5), and
 * its `expected_metric` is the hypothesis shape `POST /proposals/:id/outcome`
 * reads — the two halves of what the v2 review found still Portuguese and still
 * unclosable here.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import type * as PolicyModule from '../src/policy.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs', 'spec', 'surveyor-cost.md');

let cache: typeof PolicyModule | null = null;

async function load(): Promise<typeof PolicyModule> {
  assert.ok(
    existsSync(path.join(PACKAGE_ROOT, 'src', 'policy.ts')),
    'artifact does not exist yet: packages/cost-surveyor/src/policy.ts',
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
  assert.equal(withCeiling[0].type, 'ceiling');
  assert.equal(withCeiling[0].node_id, 'redigir');
  assert.equal(withCeiling[0].evidence.lens, 'cost');
  assert.equal(withCeiling[0].evidence.ceiling_exceeded, 'tokens');
  assert.equal(withCeiling[0].evidence.tokens_total, 5000);
  // t255 — the hypothesis, in the ONE shape `POST /proposals/:id/outcome` can
  // read (`domain/hypothesis.ts`): the number observed, and the number it should
  // come back to. `{descricao, alvo, teto_ou_fator}` looked like a metric and
  // closed no experiment — every outcome of this lens came back 422.
  assert.deepEqual(withCeiling[0].expected_metric, {
    nome: 'tokens_total of node "redigir" goes back under the declared ceiling',
    direcao: 'cai',
    de: 5000,
    para: 1000,
  });

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
  assert.equal(withBase[0].type, 'tier');
  assert.equal(withBase[0].node_id, 'c');
  assert.equal(withBase[0].evidence.ceiling_exceeded, null, 'tier is not a ceiling violation');
  assert.deepEqual(withBase[0].expected_metric, {
    nome: 'tokens_total of node "c" falls below 3x the version median',
    direcao: 'cai',
    de: 1000,
    para: 300,
  });

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
    currentDescription: (graphVersionId, nodeId) => `description of ${nodeId} at ${graphVersionId}`,
  });

  assert.ok(
    candidates.some((candidate) => candidate.type === 'ceiling'),
    'the scenario has to produce both types for the rule to hold for both',
  );
  assert.ok(candidates.some((candidate) => candidate.type === 'tier'));

  for (const candidate of candidates) {
    assert.equal(candidate.operations.length, 1, 'one recommendation is one operation');

    const operation = candidate.operations[0];
    assert.equal(operation.type, 'change_node_field');
    assert.equal(operation.field, 'description');
    assert.equal(operation.node_id, candidate.node_id);
    assert.equal(operation.from, `description of ${candidate.node_id} at sha256:v1`);
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
    // candidate around it took §5.5's with t255 (`operations`, `evidence`,
    // `expected_metric`), so the mapping into `createProposal` is a
    // pass-through instead of a translation.
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

test('t255 — the candidate and its evidence carry the English keys of §5.5', async () => {
  const { evaluatePolicies } = await load();

  const [candidate] = evaluatePolicies([row('redigir', 5000)], {
    tokenCeiling: 1000,
    secondCeiling: 1,
  });
  assert.ok(candidate !== undefined, 'the scenario has to produce a candidate');

  assert.deepEqual(Object.keys(candidate).sort(), [
    'evidence',
    'expected_metric',
    'graph_version_id',
    'node_id',
    'operations',
    'type',
  ]);
  assert.deepEqual(Object.keys(candidate.evidence).sort(), [
    'ceiling_exceeded',
    'graph_version_id',
    'lens',
    'node_id',
    'sessions_with_usage',
    'sessions_without_usage',
    'tokens_total',
    'total_seconds',
    'type',
  ]);

  // The values travel too: `custo` and `teto` were as Portuguese as the keys
  // around them, and `tier` and `tokens` were already English.
  assert.equal(candidate.evidence.lens, 'cost');
  assert.equal(candidate.evidence.type, 'ceiling');
  assert.equal(candidate.evidence.ceiling_exceeded, 'tokens');
  assert.equal(candidate.evidence.total_seconds, 10, 'the seconds keep their number, not their name');
  assert.equal(candidate.evidence.sessions_with_usage, 1);
  assert.equal(candidate.evidence.sessions_without_usage, 0);
  assert.equal(candidate.evidence.graph_version_id, 'sha256:v1');
  assert.equal(candidate.evidence.node_id, 'redigir');

  // `expected_metric` is the one key whose CONTENT does not move: it is the
  // frozen hypothesis format, and it is what makes the outcome closable.
  assert.deepEqual(Object.keys(candidate.expected_metric).sort(), ['de', 'direcao', 'nome', 'para']);
  assert.equal(candidate.expected_metric.direcao, 'cai', 'every candidate of this lens cuts cost');
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
    currentDescription: () => 'current description',
  });
  assert.ok(candidate !== undefined, 'the scenario has to produce a candidate to compare against');
  const emitted = candidate.operations[0];

  const spec = readFileSync(SPEC_PATH, 'utf8');
  const examples = jsonBlocks(spec).filter((block) => block.type === 'change_node_field');
  assert.ok(examples.length > 0, 'the spec has to carry at least one literal operation example');

  for (const example of examples) {
    const inverse = example.inverse as Record<string, unknown>;
    assert.ok(inverse !== undefined && typeof inverse === 'object', 'the example carries an inverse');

    // The keys are §3's since t228. The VALUE of `field` is the half t228 left
    // behind: `CHANGEABLE_FIELDS` never held `descricao`, and the node's field
    // has been `description` since t178 — in `schema/graph.schema.json` and in
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

test('t234 — no `descricao` names the node field anywhere in the spec', () => {
  const spec = readFileSync(SPEC_PATH, 'utf8');

  const hits = spec
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    // Unaccented on purpose: this sweep is about the FIELD name, and the
    // English word "description" the prose reads is not what it is about.
    .filter(({ text }) => /\bdescricao\b/.test(text));

  assert.deepEqual(
    hits.map(({ line, text }) => `${line}: ${text.trim()}`),
    [],
    'the spec names the node field `descricao`, which the API refuses (field_not_changeable)',
  );

  // Until t255 exactly one `descricao` survived here: the key of the old
  // `{descricao, alvo, teto_ou_fator}` metric. That shape closed no experiment,
  // so it was replaced by the hypothesis's `{nome, direcao, de, para}` — and the
  // last `descricao` of this document went with it.
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
  assert.equal(candidates[0].evidence.ceiling_exceeded, 'time', 'only the time ceiling blew');

  const { to } = candidates[0].operations[0];
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
/* t180 — the text a person reads in the proposal is English; the keys around  */
/* it are the hypothesis format's, frozen (domain/hypothesis.ts).             */
/* -------------------------------------------------------------------------- */

test('t180 — the marker and the ceiling and tier recommendations are in English', async () => {
  const { evaluatePolicies, MARKER } = await load();

  assert.equal(MARKER, '[cost-surveyor]', 'the marker uses the glossary term for surveyor');

  const candidates = evaluatePolicies([row('a', 100), row('b', 100), row('c', 9000)], {
    tokenCeiling: 1000,
    tierFactor: 3,
    tierMinNodes: 3,
  });

  const ceiling = candidates.find((candidate) => candidate.type === 'ceiling');
  assert.ok(ceiling !== undefined, 'the scenario has to produce a ceiling candidate');
  assert.equal(
    ceiling.operations[0].to,
    '[cost-surveyor] token ceiling exceeded: 9000 tokens observed against a ceiling of 1000, ' +
      'over 1 sessions with usage reported. Reduce the scope of this node, split it, or revisit the ceiling.',
  );
  assert.equal(
    ceiling.expected_metric.nome,
    'tokens_total of node "c" goes back under the declared ceiling',
    'the label of the metric is read by a person, so t180 keeps it English',
  );

  const tier = candidates.find((candidate) => candidate.type === 'tier');
  assert.ok(tier !== undefined, 'the scenario has to produce a tier candidate');
  assert.equal(
    tier.operations[0].to,
    '[cost-surveyor] cost out of line in this version: 9000 tokens, 90.0x the median of 100 ' +
      'across the 3 measured nodes (factor 3). Candidate for a cheaper model tier, or for a split into smaller nodes.',
  );
  assert.equal(
    tier.expected_metric.nome,
    'tokens_total of node "c" falls below 3x the version median',
  );
});
