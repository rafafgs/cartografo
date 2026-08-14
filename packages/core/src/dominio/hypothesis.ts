/**
 * The verdict of a hypothesis (t112, FR2/FR4).
 *
 * A proposal is a hypothesis, approving it is the experiment, and the next
 * round's telemetry is the outcome — the project's own definition of learning
 * (`notas/2026-08-14-aprendizado.md`). This module is the judgement itself,
 * and nothing else: given what the proposal declared it would move and the
 * number measured afterwards, it says `confirmada`, `sem_efeito` or `piorou`.
 *
 * Two deliberate boundaries, in the same spirit as `dominio/operacoes.ts`:
 *
 * - **Pure.** No database, no clock, no HTTP. Whether the execution really ran
 *   under the applied version is evidence the route checks against telemetry
 *   before it ever gets here; writing the verdict down is the repository's job.
 * - **Shape validation reports, it does not throw.** `metrica_esperada` was
 *   never validated on creation (`POST /v1/propostas` still does not, by
 *   scope), so an applied proposal can perfectly well carry a metric this
 *   module cannot read. That is a `422` for the caller, not a crash — and the
 *   report says which field is missing rather than just "invalid".
 *
 * There is no tolerance band: the comparison is strict `===`/`<`/`>`. A margin
 * would be a product decision about what counts as "no effect", and burying
 * one in a comparison operator is how it would never get made on purpose.
 */

/** What the next round's telemetry says about the hypothesis. */
export type Verdict = 'confirmada' | 'sem_efeito' | 'piorou';

/** Which way the proposal claimed the metric would move. */
export type MetricDirection = 'sobe' | 'cai';

/** The directions a metric may declare, in the order the spec lists them. */
export const METRIC_DIRECTIONS = Object.freeze(['sobe', 'cai']);

/**
 * The metric a proposal declares it expects to move.
 *
 * The keys stay in Portuguese: this is the shape already stored in
 * `proposta.metrica_esperada` and carried in the published payloads, and D18
 * leaves data-format keys out of the English rule.
 */
export interface ExpectedMetric {
  nome: string;
  direcao: MetricDirection;
  de: number;
  para: number;
}

/** One problem found in the declared metric. */
export interface MetricError {
  code: string;
  message: string;
}

/** Either a verdict or the reasons there cannot be one. */
export interface VerdictReport {
  valid: boolean;
  /** `null` whenever `valid` is false — an incomplete hypothesis has no outcome. */
  verdict: Verdict | null;
  errors: MetricError[];
}

type Record_ = Record<string, unknown>;

function isObject(value: unknown): value is Record_ {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Checks that a declared metric has the shape the verdict needs.
 *
 * @param expectedMetric Value straight out of `proposta.metrica_esperada`, so
 *   untrusted: nothing validated it on the way in.
 * @returns Every problem found, not just the first one.
 */
export function validateExpectedMetric(expectedMetric: unknown): MetricError[] {
  const errors: MetricError[] = [];
  const note = (code: string, message: string): void => {
    errors.push({ code, message });
  };

  if (!isObject(expectedMetric)) {
    note('metrica_esperada_invalida', 'metrica_esperada precisa ser um objeto JSON');
    return errors;
  }

  if (typeof expectedMetric.nome !== 'string' || expectedMetric.nome.trim() === '') {
    note('nome_invalido', 'metrica_esperada.nome precisa ser o nome da métrica, preenchido');
  }

  if (
    typeof expectedMetric.direcao !== 'string' ||
    !METRIC_DIRECTIONS.includes(expectedMetric.direcao)
  ) {
    note(
      'direcao_invalida',
      `metrica_esperada.direcao precisa ser ${METRIC_DIRECTIONS.map((direcao) => `"${direcao}"`).join(' ou ')}, veio ${JSON.stringify(expectedMetric.direcao)}`,
    );
  }

  for (const campo of ['de', 'para']) {
    if (!isNumber(expectedMetric[campo])) {
      note('valor_invalido', `metrica_esperada.${campo} precisa ser um número finito`);
    }
  }

  return errors;
}

/**
 * Narrows an untrusted value to a metric the verdict can be read from.
 *
 * @param value Value straight out of `proposta.metrica_esperada`.
 * @returns Whether the shape is complete.
 */
export function isExpectedMetric(value: unknown): value is ExpectedMetric {
  return validateExpectedMetric(value).length === 0;
}

/**
 * The comparison itself, over a metric whose shape is already known good.
 *
 * @param metric Declared metric.
 * @param after The metric measured in the next execution.
 * @returns The verdict.
 */
export function verdictFor(metric: ExpectedMetric, after: number): Verdict {
  if (after === metric.de) return 'sem_efeito';
  const improved = metric.direcao === 'cai' ? after < metric.de : after > metric.de;
  return improved ? 'confirmada' : 'piorou';
}

/**
 * Reads the verdict of a hypothesis against the number measured afterwards.
 *
 * The baseline is `de`, never `para`: `para` is the target the proposal hoped
 * for, and judging against it would turn "moved the right way, less than
 * hoped" into a failure. What the note asks is whether the metric moved in the
 * declared direction at all.
 *
 * @param expectedMetric Value of `proposta.metrica_esperada` (untrusted).
 * @param after The metric measured in the next execution. The caller computes
 *   it — there is no engine of named metrics in v1 (out of scope) — and is
 *   expected to have checked that it is a finite number.
 * @returns The verdict, or the reasons the metric could not be read.
 */
export function computeVerdict(expectedMetric: unknown, after: number): VerdictReport {
  const errors = validateExpectedMetric(expectedMetric);
  if (errors.length > 0) return { valid: false, verdict: null, errors };

  return { valid: true, verdict: verdictFor(expectedMetric as ExpectedMetric, after), errors: [] };
}
