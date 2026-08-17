/**
 * Cost policies: from an aggregated row to a proposal candidate (t114, FR4).
 *
 * Two policies, and they say different things:
 *
 * - **`teto`** is absolute — "this node went past N tokens (or N seconds)". It
 *   only exists when somebody declares the ceiling; with no declared ceiling
 *   there is nothing to exceed, and the lens stays quiet instead of inventing a
 *   number.
 * - **`tier`** is relative — "this node costs much more than its neighbours in
 *   the same version". It demands a sample base (`tierMinNodes`): with two
 *   measured nodes, calling one of them an outlier is noise, not signal.
 *
 * **Why every candidate is advisory.** When this ticket ran, neither the graph
 * document (`schema/grafo.schema.json`, a node with `additionalProperties:
 * false`) nor the skill manifest had a field for cost or for model tier, and
 * opening either of them was out of it by acceptance criterion — the point to
 * prove was that a second surveyor fits the API that already exists, without
 * altering a shared format. What was left was the only mutation the vocabulary
 * allowed over a node without inventing a field: `change_node_field` on
 * `description`, with the recommendation in text. The real numbers go in
 * `evidencia` and `metrica_esperada`, which are free JSON by design (D15).
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
 * (`notas/2026-08-14-aprendizado.md`, item `Políticas`), which is a ticket of
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
 * The keys are §3's since t228, and only the keys: what surrounds this operation
 * — `Candidate`'s `operacoes`/`evidencia`/`metrica_esperada`, its `tipo`
 * discriminator, `no_id` and `grafo_versao_id` — is this module's own
 * vocabulary, which D20 does not touch.
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
  lente: 'custo';
  no_id: string;
  grafo_versao_id: string;
  tokens_total: number;
  tempo_total_segundos: number;
  sessoes_com_uso: number;
  sessoes_sem_uso: number;
  teto_excedido: 'tokens' | 'tempo' | null;
  tipo: 'teto' | 'tier';
}

/** The hypothesis: which number is expected to move, and to where. */
export interface ExpectedMetric {
  descricao: string;
  /** Value the metric should reach (the ceiling, or the tier threshold). */
  alvo: number;
  /** The configured knob that produced the target: the ceiling, or the factor. */
  teto_ou_fator: number;
}

/** A proposal not yet sent. */
export interface Candidate {
  tipo: 'teto' | 'tier';
  grafo_versao_id: string;
  no_id: string;
  operacoes: [ChangeNodeDescription];
  evidencia: CostEvidence;
  metrica_esperada: ExpectedMetric;
}

/** Knobs of the evaluation. All optional; with no declared ceiling, `teto` does not run. */
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

/** Closes the candidate around the row, the operation and the numbers. */
function buildCandidate(
  row: IdentifiedCostRow,
  type: 'teto' | 'tier',
  ceilingExceeded: 'tokens' | 'tempo' | null,
  operation: ChangeNodeDescription,
  expectedMetric: ExpectedMetric,
): Candidate {
  return {
    tipo: type,
    grafo_versao_id: row.grafo_versao_id,
    no_id: row.no_id,
    operacoes: [operation],
    evidencia: {
      lente: 'custo',
      no_id: row.no_id,
      grafo_versao_id: row.grafo_versao_id,
      tokens_total: row.tokens_total,
      tempo_total_segundos: row.tempo_total_segundos,
      sessoes_com_uso: row.sessoes_com_uso,
      sessoes_sem_uso: row.sessoes_sem_uso,
      teto_excedido: ceilingExceeded,
      tipo: type,
    },
    metrica_esperada: expectedMetric,
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

    const exceeded = overTokens ? 'tokens' : 'tempo';
    const ceiling = (overTokens ? tokenCeiling : secondCeiling) as number;
    const observed = overTokens ? row.tokens_total : row.tempo_total_segundos;
    const metric = overTokens ? 'tokens_total' : 'tempo_total_segundos';
    const unit = overTokens ? 'tokens' : 'seconds';
    // The sample follows the ceiling that blew, like the rest of the row. A
    // session may have reported `uso` and not have both time stamps, and vice
    // versa (`cost.ts`), so the two counters diverge on purpose: citing
    // `sessoes_com_uso` on a time ceiling declares a base the ceiling's metric
    // does not have. The name of the sample travels with the number so that the
    // sentence cannot end up saying one thing and counting another.
    const sample = overTokens ? row.sessoes_com_uso : row.sessoes_com_tempo;
    const sampleOf = overTokens ? 'usage' : 'time';
    // `exceeded` is a format value (`evidencia.teto_excedido`) and does not
    // become prose; the sentence's label is kept apart from it for that reason.
    const label = overTokens ? 'token' : 'time';

    candidates.push(
      buildCandidate(
        row,
        'teto',
        exceeded,
        recommendationOperation(
          row.no_id,
          currentDescription(row.grafo_versao_id, row.no_id),
          `${label} ceiling exceeded: ${observed} ${unit} observed against a ceiling of ${ceiling}, over ${sample} sessions with ${sampleOf} reported. Reduce the scope of this node, split it, or revisit the ceiling.`,
        ),
        {
          descricao: `${metric} of node "${row.no_id}" goes back under the declared ceiling`,
          alvo: ceiling,
          teto_ou_fator: ceiling,
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
          {
            descricao: `tokens_total of node "${row.no_id}" falls below ${factor}x the version median`,
            alvo: threshold,
            teto_ou_fator: factor,
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
 * @returns `teto` candidates first, `tier` after, each group in the order of the
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
