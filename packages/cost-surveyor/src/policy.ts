/**
 * Cost policies: from an aggregated row to a proposal candidate (t114, FR4).
 *
 * Two policies, and they say different things:
 *
 * - **`ceiling`** is absolute — "this node went past N tokens (or N seconds)". It
 *   only exists when somebody declares the ceiling; with no declared ceiling
 *   there is nothing to exceed, and the lens stays quiet instead of inventing a
 *   number.
 * - **`tier`** is relative — "this node costs much more than its neighbours in
 *   the same version". It demands a sample base (`tierMinNodes`): with two
 *   measured nodes, calling one of them an outlier is noise, not signal.
 *
 * **Why every candidate is advisory.** When this ticket ran, neither the graph
 * document (`schema/graph.schema.json`, a node with `additionalProperties:
 * false`) nor the skill manifest had a field for cost or for model tier, and
 * opening either of them was out of it by acceptance criterion — the point to
 * prove was that a second surveyor fits the API that already exists, without
 * altering a shared format. What was left was the only mutation the vocabulary
 * allowed over a node without inventing a field: `change_node_field` on
 * `description`, with the recommendation in text. The real numbers go in
 * `evidence` and `expected_metric`, which are free JSON by design (D15) — free
 * in what they carry, that is: since t255 `expected_metric` carries the frozen
 * hypothesis shape, because that is what makes an outcome closable.
 *
 * **The half t166 unlocked.** `no.model` has existed since then, and it is
 * proposable (`CHANGEABLE_FIELDS`), so the recommendation "use a smaller model
 * at this gate" CAN already become `change_node_field` on `model` instead of
 * prose in `description`. Changing the operation this lens emits is a ticket of
 * its own — it needs to know which model to propose, and that wants the catalog
 * of `GET /v1/engines` and a notion of tier nobody has written yet. All that
 * changes today is this: the field stopped being the obstacle.
 *
 * The honest consequence of that is that applying a proposal from this lens
 * changes no cost by itself: it informs whoever reads the node. Mechanical
 * enforcement waits for a real policy surface
 * (`notes/2026-08-14-learning.md`, item `Políticas`), which is a ticket of
 * its own.
 */

import type { IdentifiedCostRow } from './cost.ts';

export type { IdentifiedCostRow } from './cost.ts';

/** Default factor of "much more expensive than the median". */
export const DEFAULT_TIER_FACTOR = 3;

/** Fewest measured nodes in a version for "outlier" to mean anything. */
export const DEFAULT_TIER_MIN_NODES = 3;

/**
 * Prefix of the recommendation appended to the description. It is what makes it
 * recognizable.
 *
 * `cost-surveyor` since t180: the text of the proposal is read by a person and
 * for that reason it is in English, and `surveyor` is the glossary term for
 * `topógrafo`.
 */
export const MARKER = '[cost-surveyor]';

/**
 * `change_node_field` over `description`, with the inverse that undoes it.
 *
 * Declared here instead of imported from `packages/core/src/domain/operations.ts`
 * on purpose: the surveyor is an ordinary client of the public API and does not
 * depend on the core package (D1/D11) — the same choice as
 * `packages/runner/src/controller/cliente-controle.ts`, which also redeclares
 * the subset of the contract it consumes.
 *
 * The keys are §3's since t228. What surrounds this operation — `Candidate`'s
 * `operations`/`evidence`/`expected_metric`, its `type` discriminator, `node_id`
 * and `graph_version_id` — went English with t255 and has a section of its own
 * (`glossary-wire.md` §5.5). It used to say here that this was "this module's
 * own vocabulary, which D20 does not touch"; it travels inside
 * `POST /v1/proposals`, so it was always the wire.
 */
export interface ChangeNodeDescription {
  type: 'change_node_field';
  node_id: string;
  field: 'description';
  from: string;
  to: string;
  inverse: {
    type: 'change_node_field';
    node_id: string;
    field: 'description';
    from: string;
    to: string;
  };
}

/** What the lens saw, and what holds the candidate up. */
export interface CostEvidence {
  lens: 'cost';
  node_id: string;
  graph_version_id: string;
  tokens_total: number;
  total_seconds: number;
  sessions_with_usage: number;
  sessions_without_usage: number;
  ceiling_exceeded: 'tokens' | 'time' | null;
  type: 'ceiling' | 'tier';
}

/**
 * The hypothesis: which number is expected to move, and to where.
 *
 * `domain/hypothesis.ts`'s shape, redeclared here the way `ChangeNodeDescription`
 * above redeclares the operation: this package is an ordinary client of the API
 * and does not import the core (D1/D11). The keys are Portuguese because that
 * format is frozen (D18 leaves data-format keys out of the English rule), and it
 * is the ONE shape `POST /v1/proposals/:id/outcome` can read.
 *
 * Until t255 this module declared a metric of its own —
 * `{descricao, alvo, teto_ou_fator}` — which looked like a hypothesis and was
 * not one: `isExpectedMetric` refused it, so every proposal this lens created
 * came back `422 invalid_expected_metric` at the gate that was supposed to close
 * it. The flow surveyor (`packages/runner/src/surveyor/proposal.ts:354-370`) had
 * been emitting the right shape all along; this is that mapping, for cost.
 */
export interface ExpectedMetric {
  /** Label of the metric and the node it belongs to; read by a person. */
  nome: string;
  /** Always `cai` here: every candidate this lens proposes is a cost cut. */
  direcao: 'cai';
  /** The value actually observed. */
  de: number;
  /** Where it should land: the ceiling, or the tier threshold. */
  para: number;
}

/** A proposal not yet sent. */
export interface Candidate {
  type: 'ceiling' | 'tier';
  graph_version_id: string;
  node_id: string;
  operations: [ChangeNodeDescription];
  evidence: CostEvidence;
  expected_metric: ExpectedMetric;
}

/** Knobs of the evaluation. All optional; with no declared ceiling, `ceiling` does not run. */
export interface PolicyOptions {
  tokenCeiling?: number;
  secondCeiling?: number;
  /** Default: {@link DEFAULT_TIER_FACTOR}. */
  tierFactor?: number;
  /** Default: {@link DEFAULT_TIER_MIN_NODES}. */
  tierMinNodes?: number;
  /**
   * Current description of the node, read from the version's snapshot. It is the
   * `from` of the operation, and without it the inverse would have nowhere to go
   * back to. Default: empty text.
   */
  currentDescription?: (graphVersionId: string, nodeId: string) => string;
}

/** Median of a non-empty list. Even: the average of the middle two. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A node only has "usage data" if at least one of its sessions reported `uso`. */
function hasData(row: IdentifiedCostRow): boolean {
  return row.sessoes_com_uso > 0;
}

/** Builds the advisory operation: the recommendation appended to the current description. */
function recommendationOperation(
  nodeId: string,
  currentDescription: string,
  recommendation: string,
): ChangeNodeDescription {
  const text = `${MARKER} ${recommendation}`;
  const to = currentDescription === '' ? text : `${currentDescription}\n\n${text}`;
  return {
    type: 'change_node_field',
    node_id: nodeId,
    field: 'description',
    from: currentDescription,
    to,
    inverse: {
      type: 'change_node_field',
      node_id: nodeId,
      field: 'description',
      from: to,
      to: currentDescription,
    },
  };
}

/**
 * Closes the candidate around the row, the operation and the numbers.
 *
 * The one place in this package where the two vocabularies meet: what comes in
 * is an `IdentifiedCostRow` (`cost.ts`, the layer below, whose field names this
 * ticket leaves alone) and what goes out is the wire's, English since t255 and
 * mapped in `glossary-wire.md` §5.5.
 */
function buildCandidate(
  row: IdentifiedCostRow,
  type: 'ceiling' | 'tier',
  ceilingExceeded: 'tokens' | 'time' | null,
  operation: ChangeNodeDescription,
  expectedMetric: ExpectedMetric,
): Candidate {
  return {
    type,
    graph_version_id: row.grafo_versao_id,
    node_id: row.no_id,
    operations: [operation],
    evidence: {
      lens: 'cost',
      node_id: row.no_id,
      graph_version_id: row.grafo_versao_id,
      tokens_total: row.tokens_total,
      total_seconds: row.tempo_total_segundos,
      sessions_with_usage: row.sessoes_com_uso,
      sessions_without_usage: row.sessoes_sem_uso,
      ceiling_exceeded: ceilingExceeded,
      type,
    },
    expected_metric: expectedMetric,
  };
}

/**
 * Ceiling candidates: one per row that blew some declared limit.
 *
 * A row that blows BOTH ceilings is still a single candidate — the target is the
 * node, not the limit. `tokens` gets the label for being the lens's primary
 * metric; the time number stays in the evidence either way.
 */
function ceilingCandidates(
  rows: readonly IdentifiedCostRow[],
  options: PolicyOptions,
  currentDescription: (graphVersionId: string, nodeId: string) => string,
): Candidate[] {
  const { tokenCeiling, secondCeiling } = options;
  if (tokenCeiling === undefined && secondCeiling === undefined) return [];

  const candidates: Candidate[] = [];
  for (const row of rows) {
    const overTokens = tokenCeiling !== undefined && row.tokens_total > tokenCeiling;
    const overTime = secondCeiling !== undefined && row.tempo_total_segundos > secondCeiling;
    if (!overTokens && !overTime) continue;

    const exceeded = overTokens ? 'tokens' : 'time';
    const ceiling = (overTokens ? tokenCeiling : secondCeiling) as number;
    const observed = overTokens ? row.tokens_total : row.tempo_total_segundos;
    // The name of the metric as the EVIDENCE spells it (§5.5), not as the row
    // below does: this label rides in `expected_metric.nome`, which a person
    // reads next to the evidence and not next to `cost.ts`.
    const metric = overTokens ? 'tokens_total' : 'total_seconds';
    const unit = overTokens ? 'tokens' : 'seconds';
    // The sample follows the ceiling that blew, like the rest of the row. A
    // session may have reported `uso` and not have both time stamps, and vice
    // versa (`cost.ts`), so the two counters diverge on purpose: citing
    // `sessoes_com_uso` on a time ceiling declares a base the ceiling's metric
    // does not have. The name of the sample travels with the number so that the
    // sentence cannot end up saying one thing and counting another.
    const sample = overTokens ? row.sessoes_com_uso : row.sessoes_com_tempo;
    const sampleOf = overTokens ? 'usage' : 'time';
    // `exceeded` is a format value (`evidence.ceiling_exceeded`) and does not
    // become prose; the sentence's label is kept apart from it for that reason.
    const label = overTokens ? 'token' : 'time';

    candidates.push(
      buildCandidate(
        row,
        'ceiling',
        exceeded,
        recommendationOperation(
          row.no_id,
          currentDescription(row.grafo_versao_id, row.no_id),
          `${label} ceiling exceeded: ${observed} ${unit} observed against a ceiling of ${ceiling}, over ${sample} sessions with ${sampleOf} reported. Reduce the scope of this node, split it, or revisit the ceiling.`,
        ),
        // `de` is what was measured and `para` is the declared ceiling, so the
        // next round's verdict is a comparison of two numbers this lens really
        // knows. The old `teto_ou_fator` said the same thing as `alvo` here and
        // was the reason the whole shape read as a metric without being one.
        {
          nome: `${metric} of node "${row.no_id}" goes back under the declared ceiling`,
          direcao: 'cai',
          de: observed,
          para: ceiling,
        },
      ),
    );
  }
  return candidates;
}

/**
 * Tier candidates: one per node far above the median of its own version.
 *
 * The comparison is WITHIN the version on purpose: comparing nodes of different
 * versions would mix a change of topology with a change of cost, and the lens
 * would have no way of saying which of the two explained the number.
 *
 * A median of zero switches the policy off — with half the nodes measured at
 * zero tokens, any positive value would pass at any factor, and every node would
 * become an outlier.
 */
function tierCandidates(
  rows: readonly IdentifiedCostRow[],
  options: PolicyOptions,
  currentDescription: (graphVersionId: string, nodeId: string) => string,
): Candidate[] {
  const factor = options.tierFactor ?? DEFAULT_TIER_FACTOR;
  const minNodes = options.tierMinNodes ?? DEFAULT_TIER_MIN_NODES;
  if (factor <= 0) return [];

  const byVersion = new Map<string, IdentifiedCostRow[]>();
  for (const row of rows.filter(hasData)) {
    const group = byVersion.get(row.grafo_versao_id);
    if (group === undefined) byVersion.set(row.grafo_versao_id, [row]);
    else group.push(row);
  }

  const candidates: Candidate[] = [];
  for (const group of byVersion.values()) {
    if (group.length < minNodes) continue;

    const center = median(group.map((row) => row.tokens_total));
    if (center <= 0) continue;

    const threshold = factor * center;
    for (const row of group) {
      if (row.tokens_total < threshold) continue;

      const times = (row.tokens_total / center).toFixed(1);
      candidates.push(
        buildCandidate(
          row,
          'tier',
          null,
          recommendationOperation(
            row.no_id,
            currentDescription(row.grafo_versao_id, row.no_id),
            `cost out of line in this version: ${row.tokens_total} tokens, ${times}x the median of ${center} across the ${group.length} measured nodes (factor ${factor}). Candidate for a cheaper model tier, or for a split into smaller nodes.`,
          ),
          // The threshold, and not the median, is the `para`: what this proposal
          // claims is that the node stops being an outlier, which is a weaker
          // and honest claim — nothing here knows what the median will be next
          // round, and it moves when this node does.
          {
            nome: `tokens_total of node "${row.no_id}" falls below ${factor}x the version median`,
            direcao: 'cai',
            de: row.tokens_total,
            para: threshold,
          },
        ),
      );
    }
  }
  return candidates;
}

/**
 * Evaluates both policies over the identified rows (FR4).
 *
 * @param rows Output of `aggregateCost`, already without the pairs carrying
 *   `null` — with no version and node there is no operation target and no
 *   snapshot in which to read the description.
 * @param options Ceilings and tier calibration.
 * @returns `ceiling` candidates first, `tier` after, each group in the order of the
 *   rows received. The same node may appear in both: they are two different
 *   judgements about the same fact.
 */
export function evaluatePolicies(
  rows: readonly IdentifiedCostRow[],
  options: PolicyOptions,
): Candidate[] {
  const currentDescription = options.currentDescription ?? ((): string => '');
  return [
    ...ceilingCandidates(rows, options, currentDescription),
    ...tierCandidates(rows, options, currentDescription),
  ];
}
