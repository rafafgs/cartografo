/**
 * `check-intake` — the deterministic gate this graph opens on (t406).
 *
 * This is not a script beside the graph, it is the graph's first node. The
 * `check-intake` node declares `"engine": "shell"` (t332) and its pinned skill
 * `check-flow-intake` carries a `command` block instead of instructions a model
 * reads, so what runs here is this file, spawned with no shell in between and
 * with `PATH` as its whole environment. b3-radar's own D15 asked for exactly
 * this — "a `shell` engine, for the day the graph needs a deterministic node
 * inside the trail" (`docs/formats/engine-adapter.md`) — and this is the first
 * real consumer of it: spending an agent session to count rows in four JSON
 * files would be paying a model to do arithmetic.
 *
 * ## What it answers
 *
 * One question, in four parts, per fixture day: do the four files exist, is
 * each of them a JSON array, and does each array's length fall inside the range
 * `graph.json` declares for it in `project.expected_row_counts`? The ranges
 * arrive as `argv[3]`, as JSON, rather than living here as a constant — so the
 * document a reader already opens is where the numbers are, and the fixtures at
 * rest and the check at runtime cannot drift apart (FR7).
 *
 * ## Undetermined is not a crash, and a crash is not undetermined
 *
 * A verdict — `pass` or `fail` — exits `0`, because reaching a verdict is this
 * node working, and a `fail` is a routing decision the graph has an edge for.
 * What exits non-zero is the absence of a verdict: a fixture file that is not
 * valid JSON at all, or a missing argument. It is the same discipline
 * `verify-release.json` documents for its own two deterministic checks, and it
 * matters more here, because the runner reads the exit code and the fenced
 * block for different things.
 *
 * ## Where the fixtures are
 *
 * `fixtures/<trading_day>/` relative to the working directory first — which is
 * what lets a temp fixture tree stand in for the shipped one, and what makes
 * the invocation work unchanged from the bundle directory. Failing that, the
 * bundle's own `fixtures/`, resolved from this file — which is what makes the
 * same argv work from the repository root, where a job of this class has its
 * working directory (`project.repo`). One rule, two places, and the second is
 * only ever reached when the first is not there at all.
 *
 * CLI use:
 *   node factory-graphs/b3-flow-radar/scripts/check-intake.mjs <trading-day> <ranges-json>
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Fixture file -> the key of `expected_row_counts` that ranges it. */
export const FIXTURE_FILES = Object.freeze({
  daily_figures: 'daily-figures.json',
  broker_flow: 'broker-flow.json',
  signals: 'signals.json',
  facts: 'facts.json',
});

/** The fence every engine's report closes its turn with (t161, t259). */
const FENCE = 'resultado';

/** Raised for the things that are an execution error rather than a verdict. */
export class IntakeError extends Error {}

/**
 * Where this day's four files are.
 *
 * @param {string} tradingDay The day named by `input.trading_day`.
 * @returns {string} The directory, whether or not it exists.
 */
export function resolveFixtureDir(tradingDay) {
  const candidates = [
    path.resolve(process.cwd(), 'fixtures', tradingDay),
    path.resolve(import.meta.dirname, '..', 'fixtures', tradingDay),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/**
 * Reads one fixture file, as far as it can get.
 *
 * @param {string} file Absolute path of the file.
 * @returns {{rows: number|null, reason: string|null}} The row count, or why there is none.
 * @throws {IntakeError} When the file exists and is not valid JSON.
 */
function readFixture(file) {
  if (!existsSync(file)) return { rows: null, reason: 'the file does not exist' };

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // No verdict is reachable from a file that does not parse: it is not a
    // fixture out of range, it is a fixture nobody can read.
    throw new IntakeError(`${file} is not valid JSON — ${error.message}`);
  }

  if (!Array.isArray(parsed)) return { rows: null, reason: 'the file is not a JSON array' };
  return { rows: parsed.length, reason: null };
}

/**
 * The whole check, as data.
 *
 * @param {string} tradingDay The day to check.
 * @param {Record<string, [number, number]>} ranges `project.expected_row_counts`.
 * @returns {{outcome: string, fixture: object, note: string}} The report's payload.
 * @throws {IntakeError} On anything that is an execution error rather than a verdict.
 */
export function checkIntake(tradingDay, ranges) {
  if (typeof tradingDay !== 'string' || tradingDay === '') {
    throw new IntakeError('the trading day is required, as the first argument');
  }
  const directory = resolveFixtureDir(tradingDay);
  const paths = {};
  const rowCounts = {};
  const problems = [];

  for (const [key, name] of Object.entries(FIXTURE_FILES)) {
    const file = path.join(directory, name);
    paths[key] = file;

    const range = ranges?.[key];
    if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) {
      throw new IntakeError(`expected_row_counts declares no [min, max] range for "${key}"`);
    }
    const [min, max] = range;

    const { rows, reason } = readFixture(file);
    rowCounts[key] = rows;
    if (rows === null) {
      problems.push(`${key} (${name}): ${reason}`);
      continue;
    }
    if (rows < min || rows > max) {
      problems.push(`${key} (${name}): ${rows} rows, outside the declared range [${min}, ${max}]`);
    }
  }

  const fixture = { trading_day: tradingDay, paths, row_counts: rowCounts };
  return problems.length === 0
    ? {
        outcome: 'pass',
        fixture,
        note: `the four fixture files of "${tradingDay}" are present, are JSON arrays and hold row counts inside the declared ranges`,
      }
    : {
        outcome: 'fail',
        fixture,
        note: `the intake of "${tradingDay}" does not hold: ${problems.join('; ')}`,
      };
}

/**
 * The report, in the one fenced block every engine's node closes its turn with.
 *
 * The routing label rides inside the object, as the protocol demands, and its
 * value is this graph's edge label out of `check-intake` — `pass` or `fail`,
 * which is the same word the gate's `outcome` carries here and does not have to
 * be anywhere else.
 *
 * @param {object} payload What {@link checkIntake} answered.
 * @returns {string} The block, ready to print.
 */
export function renderBlock(payload) {
  const report = { ...payload, resultado: payload.outcome };
  return `\`\`\`${FENCE}\n${JSON.stringify(report, null, 2)}\n\`\`\``;
}

function main(argv) {
  const [tradingDay, rawRanges] = argv;
  if (tradingDay === undefined || rawRanges === undefined) {
    console.error(
      'usage: node factory-graphs/b3-flow-radar/scripts/check-intake.mjs <trading-day> <ranges-json>',
    );
    return 2;
  }

  let ranges;
  try {
    ranges = JSON.parse(rawRanges);
  } catch (error) {
    console.error(`the row-count ranges are not valid JSON — ${error.message}`);
    return 2;
  }

  try {
    console.log(renderBlock(checkIntake(tradingDay, ranges)));
    return 0;
  } catch (error) {
    if (error instanceof IntakeError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
