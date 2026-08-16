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
 * `schema/exemplos/` — at least four, one per soundness rule, plus however many
 * fail only structurally — go through the repository's reference validator
 * (`scripts/validar-grafo.mjs`, the same one `domain-graph.test.ts` holds the
 * core against) and every problem they produce has to come out as a line of its
 * own: a violation naming its `alvo`, a structure error carrying the `mensagem`
 * the core wrote. A fifth rule, or a renamed one, fails here; a counterexample
 * that breaks only structure does not, and does not go silent either.
 *
 * The report's keys (`estrutura`, `erros`, `soundness`, `violacoes`, `regra`,
 * `alvo`, `mensagem`) are the wire format of the 422 and stay in Portuguese
 * (t133, exception 9), as does every line the page shows.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const MODULE_PATH = path.join(PACKAGE_ROOT, 'src', 'public', 'graph-soundness.js');
const EXAMPLES_DIR = path.join(REPO_ROOT, 'schema', 'exemplos');

/**
 * The module's own fallback for a structure error that arrives with no
 * `mensagem` (`graph-soundness.js`), copied because it is not exported.
 *
 * AT4 asserts no counterexample ever renders it: the core writes the prose of
 * every structure error it can produce, so this line appearing means the screen
 * went silent on a real problem — a hook pointing at a node that does not
 * exist, say — and the person editing the graph is left guessing.
 */
const UNDECLARED_STRUCTURE_LINE = 'problema de estrutura sem mensagem declarada';

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
const REFERENCE_VALIDATOR = new URL('../../../scripts/validar-grafo.mjs', import.meta.url).href;
const REFERENCE_EXPORT = 'validarGrafo';

/** A violated rule, as the 422 carries it. */
interface Violation {
  regra: string;
  alvo: unknown;
}

/** The combined report — the body of `422 grafo_invalido`, minus the envelope. */
interface Report {
  estrutura?: { erros?: { codigo?: string; mensagem?: string; alvo?: unknown }[] };
  soundness?: { violacoes?: Violation[] };
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
    'artifact does not exist yet: packages/tela/src/public/graph-soundness.js',
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
  return rule === 'aresta_com_condicao'
    ? { de: `origem_${index}`, para: `destino_${index}` }
    : `no_${index}`;
}

/**
 * Every word of a target, so a line can be asserted to actually name it.
 *
 * A target the gate could not name at all (`alvo: null`, which is what a node
 * with no id produces) yields nothing to look for, and the assertion falls back
 * to the line simply being non-empty.
 */
function targetWords(target: unknown): string[] {
  if (typeof target === 'string') return target.trim() === '' ? [] : [target];
  if (typeof target !== 'object' || target === null) return [];
  const ends = target as { de?: unknown; para?: unknown };
  return [ends.de, ends.para].filter(
    (end): end is string => typeof end === 'string' && end.trim() !== '',
  );
}

test('AT1 — each of the four rules becomes a distinct, non-empty line naming its `alvo`', async () => {
  const { SOUNDNESS_RULES, renderReport } = await loadSoundness();

  assert.equal(
    SOUNDNESS_RULES.length,
    4,
    'the gate has four soundness rules; this mapping has to cover exactly them',
  );

  const violacoes = SOUNDNESS_RULES.map((rule, index) => ({
    regra: rule,
    alvo: targetFor(rule, index),
  }));
  const lines = renderReport({ estrutura: { erros: [] }, soundness: { violacoes } });

  assert.equal(lines.length, violacoes.length, `one line per violation:\n${lines.join('\n')}`);
  assert.equal(new Set(lines).size, lines.length, `the four lines have to differ:\n${lines.join('\n')}`);

  violacoes.forEach((violation, index) => {
    const line = lines[index];
    assert.ok(line.trim() !== '', `rule "${violation.regra}" produced an empty line`);
    for (const word of targetWords(violation.alvo)) {
      assert.ok(
        line.includes(word),
        `the line of "${violation.regra}" does not name its target "${word}": ${line}`,
      );
    }
  });
});

test('AT2 — a structure error shows its own `mensagem`, as the core wrote it', async () => {
  const { renderReport } = await loadSoundness();

  const lines = renderReport({
    estrutura: {
      erros: [
        { codigo: 'aresta_no_inexistente', mensagem: 'edge #0 references in "to" a node that does not exist: "x"', alvo: null },
        { codigo: 'id_no_duplicado', mensagem: 'duplicate node id in the document: "redigir"', alvo: 'redigir' },
      ],
    },
    soundness: { violacoes: [] },
  });

  assert.deepEqual(lines, [
    'edge #0 references in "to" a node that does not exist: "x"',
    'duplicate node id in the document: "redigir"',
  ]);
});

test('AT3 — a report with neither renders the explicit empty line', async () => {
  const { NO_PROBLEMS_LINE, renderReport } = await loadSoundness();

  assert.ok(NO_PROBLEMS_LINE.trim() !== '', 'the empty-report line cannot itself be empty');
  assert.deepEqual(renderReport({ estrutura: { erros: [] }, soundness: { violacoes: [] } }), [
    NO_PROBLEMS_LINE,
  ]);
  assert.deepEqual(renderReport(null), [NO_PROBLEMS_LINE]);
});

test('AT4 — the counterexamples, through the reference validator, cover exactly these rules', async () => {
  const { SOUNDNESS_RULES, renderReport } = await loadSoundness();

  const names = readdirSync(EXAMPLES_DIR)
    .filter((name) => name.startsWith('grafo-invalido-') && name.endsWith('.json'))
    .sort();
  assert.ok(
    names.length >= 4,
    `expected at least four counterexamples in ${EXAMPLES_DIR} — one per soundness rule, plus any that fail only structurally — found ${names.length}`,
  );

  const seen = new Set<string>();

  for (const name of names) {
    const document = JSON.parse(readFileSync(path.join(EXAMPLES_DIR, name), 'utf8')) as unknown;
    const report = await reportFor(document);
    const structureErrors = report.estrutura?.erros ?? [];
    const structureCount = structureErrors.length;
    const violacoes = report.soundness?.violacoes ?? [];
    assert.ok(
      structureCount + violacoes.length > 0,
      `${name} no longer reports any problem, structural or soundness — it stopped being a counterexample`,
    );

    const lines = renderReport(report);
    assert.equal(
      lines.length,
      structureCount + violacoes.length,
      `${name}: one line per problem, and nothing swallowed:\n${lines.join('\n')}`,
    );

    structureErrors.forEach((problem, index) => {
      const line = lines[index];
      assert.ok(
        line.trim() !== '' && line !== UNDECLARED_STRUCTURE_LINE,
        `${name}: structure error "${problem.codigo ?? 'sem código'}" renders no prose of its own — the screen went silent on a problem the core had already written: ${line}`,
      );
    });

    violacoes.forEach((violation, index) => {
      seen.add(violation.regra);
      const line = lines[structureCount + index];
      assert.ok(
        line.trim() !== '' && !line.includes('desconhecida'),
        `${name}: rule "${violation.regra}" has no prose of its own — the mapping drifted from the gate`,
      );
      for (const word of targetWords(violation.alvo)) {
        assert.ok(
          line.includes(word),
          `${name}: the line of "${violation.regra}" does not name "${word}": ${line}`,
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
