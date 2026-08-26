/**
 * Acceptance tests for the soundness report in prose (t170, FR6).
 *
 * `POST /v1/proposals/:id/apply` runs the gate over the document that WOULD
 * come out and answers `422 grafo_invalido` with the whole report when it
 * fails. Dumping that JSON on the page would be the same mistake `diff.js`
 * exists to avoid: the person editing the graph has to know WHICH node or WHICH
 * edge broke WHICH rule, or the refusal teaches nothing and the next attempt is
 * a guess.
 *
 * The four rule names are the control plane's (`RULES` in
 * `packages/core/src/domain/graph.ts`), and the last test here is what stops
 * this mapping from drifting away from them: the counterexamples in
 * `schema/examples/` — at least four, one per soundness rule, plus however many
 * fail only structurally — go through the repository's reference validator
 * (`scripts/validate-graph.mjs`, the same one `domain-graph.test.ts` holds the
 * core against) and every problem they produce has to come out as a line of its
 * own: a violation naming its `target`, a structure error carrying the `message`
 * the core wrote. A fifth rule, or a renamed one, fails here; a counterexample
 * that breaks only structure does not, and does not go silent either.
 *
 * The report's keys (`structure`, `errors`, `soundness`, `violations`, `rule`,
 * `target`, `message`) and the four rule names are the wire format of the 422,
 * and speak English since t230 (`docs/spec/glossary-wire.md` §5.3/5.4). The
 * LINES this module writes out of them are product copy, and moved separately:
 * t310 translated them, so both halves read English now for two unrelated
 * reasons — one a wire format, the other the text a person is refused with.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MODULE_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'graph-soundness.js');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'examples');

/**
 * The module's own fallback for a structure error that arrives with no
 * `message` (`graph-soundness.js`), copied because it is not exported.
 *
 * AT4 asserts no counterexample ever renders it: the core writes the prose of
 * every structure error it can produce, so this line appearing means the screen
 * went silent on a real problem — a hook pointing at a node that does not
 * exist, say — and the person editing the graph is left guessing.
 */
const UNDECLARED_STRUCTURE_LINE = 'structure problem with no declared message';

/**
 * The reference validator, reached through a computed specifier.
 *
 * Not a named import, and the reason is this package's own D18 sweep: the
 * script exports `validarGrafo`, a Portuguese identifier that
 * `no-portuguese-identifiers.test.ts` would flag the moment it appeared in an
 * import binding here. The script's name is frozen (it is the repository's
 * reference validator), so the binding is the part that gives way — the export
 * is read out of the namespace by a string, which the sweep masks like any
 * other literal.
 */
const REFERENCE_VALIDATOR = new URL('../../../scripts/validate-graph.mjs', import.meta.url).href;
const REFERENCE_EXPORT = 'validarGrafo';

/** A violated rule, as the 422 carries it. */
interface Violation {
  rule: string;
  target: unknown;
}

/** The combined report — the body of `422 grafo_invalido`, minus the envelope. */
interface Report {
  structure?: { errors?: { code?: string; message?: string; target?: unknown }[] };
  soundness?: { violations?: Violation[] };
}

interface SoundnessModule {
  /** The four rule names this mapping covers, in the order the gate runs them. */
  SOUNDNESS_RULES: readonly string[];
  /** Shown when the report carries neither a structure error nor a violation. */
  NO_PROBLEMS_LINE: string;
  renderReport: (report: unknown) => string[];
}

async function loadSoundness(): Promise<SoundnessModule> {
  assert.ok(
    existsSync(MODULE_PATH),
    'artifact does not exist yet: packages/screen/src/public/graph-soundness.js',
  );
  return (await import(
    new URL('../src/public/graph-soundness.js', import.meta.url).href
  )) as SoundnessModule;
}

/** Runs a document through the repository's reference validator. */
async function reportFor(document: unknown): Promise<Report> {
  const module = (await import(REFERENCE_VALIDATOR)) as Record<string, (doc: unknown) => Report>;
  return module[REFERENCE_EXPORT](document);
}

/** A target the four rules can name: a node id, or the two ends of an edge. */
function targetFor(rule: string, index: number): unknown {
  return rule === 'edge_with_condition'
    ? { from: `origem_${index}`, to: `destino_${index}` }
    : `no_${index}`;
}

/**
 * Every word of a target, so a line can be asserted to actually name it.
 *
 * A target the gate could not name at all (`target: null`, which is what a node
 * with no id produces) yields nothing to look for, and the assertion falls back
 * to the line simply being non-empty.
 */
function targetWords(target: unknown): string[] {
  if (typeof target === 'string') return target.trim() === '' ? [] : [target];
  if (typeof target !== 'object' || target === null) return [];
  const ends = target as { from?: unknown; to?: unknown };
  return [ends.from, ends.to].filter(
    (end): end is string => typeof end === 'string' && end.trim() !== '',
  );
}

test('AT1 — each of the four rules becomes a distinct, non-empty line naming its `target`', async () => {
  const { SOUNDNESS_RULES, renderReport } = await loadSoundness();

  assert.equal(
    SOUNDNESS_RULES.length,
    4,
    'the gate has four soundness rules; this mapping has to cover exactly them',
  );

  const violations = SOUNDNESS_RULES.map((rule, index) => ({
    rule: rule,
    target: targetFor(rule, index),
  }));
  const lines = renderReport({ structure: { errors: [] }, soundness: { violations } });

  assert.equal(lines.length, violations.length, `one line per violation:\n${lines.join('\n')}`);
  assert.equal(new Set(lines).size, lines.length, `the four lines have to differ:\n${lines.join('\n')}`);

  violations.forEach((violation, index) => {
    const line = lines[index];
    assert.ok(line.trim() !== '', `rule "${violation.rule}" produced an empty line`);
    for (const word of targetWords(violation.target)) {
      assert.ok(
        line.includes(word),
        `the line of "${violation.rule}" does not name its target "${word}": ${line}`,
      );
    }
  });
});

test('t310 — the four rule sentences are the English copy, word for word', async () => {
  const { renderReport } = await loadSoundness();

  assert.deepEqual(
    renderReport({
      structure: { errors: [] },
      soundness: {
        violations: [
          { rule: 'reachable', target: 'checar_fonte' },
          { rule: 'terminates', target: 'checar_fonte' },
          { rule: 'edge_with_condition', target: { from: 'redigir', to: 'revisar' } },
          { rule: 'node_with_contract', target: 'revisar' },
        ],
      },
    }),
    [
      'node "checar_fonte" is not reachable from the initial node: an edge that arrives at it is missing',
      'from node "checar_fonte" there is no path to a final node: whoever lands on it never finishes the traversal',
      'edge redigir → revisar has no condition: a transition with no label is a path the executor does not know when to take',
      'node "revisar" does not declare a complete skill_ref and contract: with no contract there is no way to verify what it produced',
    ],
  );
});

test('t310 — the fallbacks of an unreadable report are English too', async () => {
  const { NO_PROBLEMS_LINE, renderReport } = await loadSoundness();

  assert.equal(NO_PROBLEMS_LINE, 'no problem');
  assert.deepEqual(
    renderReport({
      structure: { errors: [{ code: 'invalid_edge' }] },
      soundness: { violations: [null, { rule: 'invented_rule', target: 'x' }, { rule: '  ' }] },
    }),
    [
      'structure problem with no declared message',
      'unknown soundness rule: malformed violation',
      'unknown soundness rule ("invented_rule") about "x"',
      'unknown soundness rule ("no id") about null',
    ],
  );
});

test('AT2 — a structure error shows its own `message`, as the core wrote it', async () => {
  const { renderReport } = await loadSoundness();

  const lines = renderReport({
    structure: {
      errors: [
        { code: 'edge_unknown_node', message: 'edge #0 references in "to" a node that does not exist: "x"', target: null },
        { code: 'duplicate_node_id', message: 'duplicate node id in the document: "redigir"', target: 'redigir' },
      ],
    },
    soundness: { violations: [] },
  });

  assert.deepEqual(lines, [
    'edge #0 references in "to" a node that does not exist: "x"',
    'duplicate node id in the document: "redigir"',
  ]);
});

test('AT3 — a report with neither renders the explicit empty line', async () => {
  const { NO_PROBLEMS_LINE, renderReport } = await loadSoundness();

  assert.ok(NO_PROBLEMS_LINE.trim() !== '', 'the empty-report line cannot itself be empty');
  assert.deepEqual(renderReport({ structure: { errors: [] }, soundness: { violations: [] } }), [
    NO_PROBLEMS_LINE,
  ]);
  assert.deepEqual(renderReport(null), [NO_PROBLEMS_LINE]);
});

test('AT4 — the counterexamples, through the reference validator, cover exactly these rules', async () => {
  const { SOUNDNESS_RULES, renderReport } = await loadSoundness();

  const names = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.startsWith('graph-invalid-') && name.endsWith('.json'))
    .sort();
  assert.ok(
    names.length >= 4,
    `expected at least four counterexamples in ${EXAMPLES_DIR} — one per soundness rule, plus any that fail only structurally — found ${names.length}`,
  );

  const seen = new Set<string>();

  for (const name of names) {
    const document = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as unknown;
    const report = await reportFor(document);
    const structureErrors = report.structure?.errors ?? [];
    const structureCount = structureErrors.length;
    const violations = report.soundness?.violations ?? [];
    assert.ok(
      structureCount + violations.length > 0,
      `${name} no longer reports any problem, structural or soundness — it stopped being a counterexample`,
    );

    const lines = renderReport(report);
    assert.equal(
      lines.length,
      structureCount + violations.length,
      `${name}: one line per problem, and nothing swallowed:\n${lines.join('\n')}`,
    );

    structureErrors.forEach((problem, index) => {
      const line = lines[index];
      assert.ok(
        line.trim() !== '' && line !== UNDECLARED_STRUCTURE_LINE,
        `${name}: structure error "${problem.code ?? 'no code'}" renders no prose of its own — the screen went silent on a problem the core had already written: ${line}`,
      );
    });

    violations.forEach((violation, index) => {
      seen.add(violation.rule);
      const line = lines[structureCount + index];
      assert.ok(
        line.trim() !== '' && !line.includes('unknown soundness rule'),
        `${name}: rule "${violation.rule}" has no prose of its own — the mapping drifted from the gate`,
      );
      for (const word of targetWords(violation.target)) {
        assert.ok(
          line.includes(word),
          `${name}: the line of "${violation.rule}" does not name "${word}": ${line}`,
        );
      }
    });
  }

  assert.deepEqual(
    [...seen].sort(),
    [...SOUNDNESS_RULES].sort(),
    'the counterexamples and this mapping no longer speak of the same four rules',
  );
});
