/**
 * D24's last layer for this package: no Portuguese in `packages/runner/test/**`.
 *
 * t309 lifted the t180 exemption over `src/`, `scripts/` and `bin/` and
 * translated the 30 files it had been covering. It left the tests behind on
 * purpose, and said so: the assertions that quote a Portuguese literal the
 * source no longer emits were named, counted and handed forward. This file is
 * the other half of that handover — the same two sweeps, pointed at `test/`.
 *
 * `no-portuguese-user-facing-strings.test.ts` excludes `test/` by construction
 * and keeps excluding it: that guard quotes Portuguese prose to prove its own
 * detector bites, so a sweep that read it would fail on the evidence. The same
 * is true here, which is why {@link scannedFiles} skips the three language
 * gates and this very file.
 *
 * Two sweeps, because neither sees what the other does:
 *
 * - **AT1, the diacritics.** A whole-file pass. It found 39 of the package's
 *   81 non-gate test files when this ticket started, and 631 diacritics in
 *   them.
 * - **AT2, the plain-ASCII Portuguese.** The same closed-stopword method the
 *   package guard uses, over the whole file rather than over its literals. It
 *   exists because a diacritic grep is a floor and not a checklist: t309's
 *   closing note measured two files that go red on Portuguese carrying no
 *   accent at all — `dispatch/pre-session-failure.test.ts` (`desbloqueie`, and
 *   a `/srv/bancos/…` path) and `intake/prompt.test.ts` (`para depois`,
 *   `opcional`) — and neither is visible to AT1.
 *
 * **This pair is this ticket's own verification, not a permanent gate.** The
 * canonical `no-portuguese-*` guards still exclude `test/`, and folding this
 * scope into them belongs to the gate ticket that closes the series. Until
 * then these two sweeps are a cheap regression check, and deleting them when
 * that ticket subsumes them costs nothing.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const TEST_ROOT = path.resolve(import.meta.dirname);

/** What counts as a test artifact here: the suites, their helpers, their data. */
const SCANNED_EXTENSION = /\.(?:ts|mjs|json|jsonl)$/;

/**
 * Portuguese by construction, and therefore never scanned.
 *
 * The three language gates are Portuguese ON PURPOSE — each one quotes the
 * prose it refuses so that a reader can see the detector bite, and each has its
 * own meta-test asserting exactly that. This file is the fourth for the same
 * reason: {@link STOPWORDS} below is a list of Portuguese words.
 */
const SELF_AND_GATES: ReadonlySet<string> = new Set([
  'no-portuguese-identifiers.test.ts',
  'no-portuguese-user-facing-strings.test.ts',
  'no-portuguese-wire.test.ts',
  'no-portuguese-runner-tests.test.ts',
]);

/**
 * Every test artifact of the package, in path order.
 *
 * A walk and not a list, for the reason t309 wrote down when it replaced the
 * package guard's `SCANNED_FILES`: a list records the files that existed the
 * day somebody wrote it, and a directory cannot forget to add itself.
 *
 * @returns Paths relative to `test/`, sorted, directories walked depth-first.
 */
export function scannedFiles(): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    const here = relative === '' ? TEST_ROOT : path.join(TEST_ROOT, relative);
    for (const entry of readdirSync(here).sort()) {
      const next = relative === '' ? entry : `${relative}/${entry}`;
      if (statSync(path.join(TEST_ROOT, next)).isDirectory()) walk(next);
      else if (SCANNED_EXTENSION.test(entry) && !SELF_AND_GATES.has(next)) found.push(next);
    }
  }

  walk('');
  return found;
}

/**
 * Lines excused from both sweeps, by line, each with the reason it is excused.
 *
 * Pinned by line and not by shape, for the reason the package guard's own two
 * pin lists are: what excuses a line is INTENT, and no regular expression
 * encodes intent. A line that moves breaks this list loudly, and somebody
 * re-reads the exception instead of inheriting it — which is the whole point.
 */
const OUT_OF_SCOPE: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'surveyor/spread.test.ts',
    line: 196,
    reason: 'a Portuguese DETECTOR, not Portuguese prose: the same shape the package guard is built from',
  },
  {
    file: 'engine/command.test.ts',
    line: 561,
    reason: 'names the two-byte character the fixture below is built from; the fixture is about bytes, not language',
  },
  {
    file: 'engine/command.test.ts',
    line: 564,
    reason: 'a run of one two-byte character, sized against the argv byte limit',
  },
  {
    file: 'engine/codex-command.test.ts',
    line: 411,
    reason: 'the same two-byte fixture, for the codex adapter',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 216,
    reason: 'names the two-byte character that puts the truncation cap at an odd byte offset',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 219,
    reason: 'the two-byte run itself',
  },
  {
    file: 'dispatch/render-input-values.test.ts',
    line: 221,
    reason: 'asserts the byte offset that run lands on',
  },
  {
    file: 'fixtures/codex-input-request.jsonl',
    line: 4,
    reason: 'a RECORDED frame of a real credentialed codex run; rewriting a recording falsifies the evidence (D24)',
  },
  {
    file: 'surveyor/close-outcome.e2e.test.ts',
    line: 38,
    reason: 'an English sentence that LISTS the frozen wire keys, `depois` among them, and names the decision freezing each',
  },
]);

/** Any of these means the line around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese, closed and short.
 *
 * Two halves. The first is the package guard's own list: function words a
 * Portuguese sentence cannot avoid. The second is the content words this
 * package's tests actually used — every one measured in a file this ticket
 * translated, not imagined. A closed list only catches what somebody has seen
 * before, which is exactly why AT1 runs beside it rather than instead of it.
 */
const STOPWORDS: readonly string[] = Object.freeze([
  // function words
  'nao',
  'uma',
  'uns',
  'umas',
  'que',
  'dos',
  'das',
  'pelo',
  'pela',
  'pelos',
  'quando',
  'porque',
  'entao',
  'ainda',
  'apenas',
  'sem',
  'ser',
  'foi',
  'era',
  'esta',
  'este',
  'essa',
  'esse',
  'isso',
  'aqui',
  'cada',
  'outro',
  'outra',
  'mesmo',
  'mesma',
  'seja',
  'sejam',
  'deve',
  'devia',
  'pode',
  'podia',
  'precisa',
  'existe',
  'nenhum',
  'nenhuma',
  'nada',
  'tudo',
  'quem',
  'quais',
  'onde',
  'como',
  'sobre',
  'depois',
  'antes',
  'entre',
  'durante',
  'desde',
  'muito',
  'todo',
  'toda',
  'todos',
  'todas',
  'qualquer',
  'alguns',
  'algumas',
  'ninguem',
  'nunca',
  'talvez',
  'dele',
  'dela',
  'seus',
  'suas',
  'minha',
  'nosso',
  'nossa',
  'vai',
  'vao',
  'veio',
  'foram',
  'sera',
  'serao',
  'estao',
  'estava',
  'sendo',
  'tem',
  'ter',
  'tinha',
  'havia',
  // content words this package's tests carried
  'faz',
  'fazer',
  'feito',
  'feita',
  'fez',
  'ler',
  'leu',
  'lido',
  'diz',
  'disse',
  'escreve',
  'escrever',
  'escreveu',
  'escrito',
  'desbloqueie',
  'bancos',
  'opcional',
  'obrigatorio',
  'arquivo',
  'arquivos',
  'linha',
  'linhas',
  'sessoes',
  'travessia',
  'trabalho',
  'grafo',
  'aresta',
  'arestas',
  'ficha',
  'etapa',
  'etapas',
  'portao',
  'declaracao',
  'permissao',
  'permissoes',
  'execucao',
  'triagem',
]);

/**
 * Wire tokens the source tickets decided to keep, and this sweep must not fire on.
 *
 * `sempre` is the `condition` a single-exit edge carries, documented at
 * `docs/spec/graph.md:547` and taught by `src/synthesizer/prompt.ts`; `para` is
 * a required key of an edge and of `metrica_esperada`, and the package guard
 * freezes it in its own `WIRE_LITERALS` for the same reason. Both would fire on
 * the stopword pass and both are data, so they are removed from the text before
 * it is read rather than argued about at every call site (t309, FR6).
 *
 * `sessao` is the third: `src/dispatch/report.ts:589` signs an event actor with
 * it when the job stands on no node, and t309 translated that file around the
 * literal without touching it. A test that asserts the signature has to spell
 * it the way the wire does.
 *
 * The other kept tokens — `resultado` and its `aprovado`/`retrabalho` values,
 * `grafo-proposto`, `no_com_contrato`, `grafo_invalido` and
 * `intake-proposto.json` — need no entry here: none of them is a stopword, and
 * the machine-name masking below already blanks the snake and kebab shapes.
 *
 * Built from a list of strings rather than written as a regex literal: a
 * literal is CODE, and `no-portuguese-identifiers.test.ts` — which does scan
 * `test/` — reads these three as Portuguese identifiers there. Inside a string
 * they are masked, the same way `src/dispatch/report.ts` spells `sessao`.
 */
const PROTOCOL_TOKENS = new RegExp(`\\b(?:${['sempre', 'para', 'sessao'].join('|')})\\b`, 'g');

/**
 * Shapes that are a machine name rather than a word of prose.
 *
 * Narrow on purpose. The package guard can afford to blank every quoted span
 * because it reads one literal at a time and already knows the literal is a
 * message; a whole-file pass has no such context, and blanking quotes here
 * would hide exactly the Portuguese test data this ticket exists to remove. So
 * only the shapes that cannot be a Portuguese sentence are masked: `snake_case`
 * (`no_com_contrato`, `metrica_esperada`), `kebab-case` (`travessia-fazer`),
 * dotted paths (`input.producao.nota`) and the flags a person types.
 */
const MACHINE_NAMES: readonly RegExp[] = Object.freeze([
  // a dotted name written into a regex literal: `\.grafo\.rascunho\.json`,
  // which is the draft suffix `src/synthesizer/synthesize.ts` exports
  /(?:\\\.[A-Za-z0-9_]+)+/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  /--?[A-Za-z][A-Za-z0-9-]*/g,
]);

/**
 * Node and skill ids this repository reuses as illustration, everywhere.
 *
 * `fazer` is a node of the two `spike-real-session*.mjs` proofs and of the skill
 * manifest they both name — files this ticket does not touch — so a test that
 * dispatches it has to spell it the way they do. It is a Portuguese verb, which
 * is the only reason it needs saying: the other illustrative ids of the same
 * family (`implementar`, `conferir`, `publicar`, `redigir`, `revisar`) are not
 * words the stopword list has.
 *
 * The full argument for leaving them alone is in this ticket's Out of Scope:
 * they are shared with `schema/examples/`, `docs/spec/` and three other
 * packages, and renaming half of a repo-wide convention is worse than the
 * convention.
 */
const ILLUSTRATIVE_IDS = new RegExp(`\\b(?:${['fazer'].join('|')})\\b`, 'g');

/** Replaces a span with same-length blanks, so no offset shifts under it. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * The Portuguese words of one line, if any, once the machine names are gone.
 *
 * @param text One raw line of a scanned file.
 * @returns Every offending token found, or an empty list.
 */
export function offendersIn(text: string): string[] {
  let masked = text.replace(PROTOCOL_TOKENS, blank).replace(ILLUSTRATIVE_IDS, blank);
  for (const span of MACHINE_NAMES) masked = masked.replace(span, blank);

  const offenders: string[] = [];
  for (const word of STOPWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(masked)) offenders.push(word);
  }
  return offenders;
}

/** The lines of one file that a sweep flags, as `file:line — token — text`. */
function hitsInFile(relative: string, flag: (text: string) => string | null): string[] {
  const source = readFileSync(path.join(TEST_ROOT, relative), 'utf8');
  const excused = new Set(
    OUT_OF_SCOPE.filter((entry) => entry.file === relative).map((entry) => entry.line),
  );
  return source.split('\n').flatMap((text, index) => {
    const line = index + 1;
    if (excused.has(line)) return [];
    const found = flag(text);
    if (found === null) return [];
    return [`${relative}:${line} — ${found} — ${text.trim().slice(0, 120)}`];
  });
}

test('t312 — AT1: no Portuguese diacritic survives in packages/runner/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => DIACRITICS.exec(text)?.[0] ?? null),
  );

  assert.deepEqual(hits, [], `Portuguese diacritics still in the tests (t312, AT1):\n${hits.join('\n')}`);
});

test('t312 — AT2: no plain-ASCII Portuguese survives in packages/runner/test', () => {
  const hits = scannedFiles().flatMap((file) =>
    hitsInFile(file, (text) => {
      const offenders = offendersIn(text);
      return offenders.length === 0 ? null : offenders.join(', ');
    }),
  );

  assert.deepEqual(hits, [], `Portuguese words still in the tests (t312, AT2):\n${hits.join('\n')}`);
});

test('t312 — the walk reads the whole test tree, gates and this file excepted', () => {
  const files = scannedFiles();

  // One per directory, plus the two fixture shapes: if the walk ever narrows,
  // it fails here instead of passing quietly on a corner of the tree.
  for (const expected of [
    'bin.e2e.test.ts',
    'authorized-fetch.ts',
    'cli/run.e2e.test.ts',
    'controller/graph-traversal.e2e.test.ts',
    'dispatch/dispatch.test.ts',
    'engine/command.test.ts',
    'fixtures/fake-engine.mjs',
    'fixtures/graph-traversal.json',
    'fixtures/codex-input-request.jsonl',
    'intake/prompt.test.ts',
    'surveyor/spread.test.ts',
    'synthesizer/prompt.test.ts',
  ]) {
    assert.ok(files.includes(expected), `the sweep no longer reads ${expected}`);
  }
  assert.ok(files.length > 75, `the sweep reads only ${files.length} files; the tree has more`);
  assert.deepEqual(
    files.filter((file) => SELF_AND_GATES.has(file)),
    [],
    'the language gates and this file are Portuguese on purpose and stay out',
  );
});

test('t312 — every Out of Scope pin still lands on a line that needs excusing', () => {
  for (const entry of OUT_OF_SCOPE) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    const pinned = lines[entry.line - 1] ?? '';
    assert.ok(
      DIACRITICS.test(pinned) || offendersIn(pinned).length > 0,
      `${entry.file}:${entry.line} is no longer Portuguese; drop the exception (${entry.reason})`,
    );
  }
});

test('t312 — AT2 bites on the Portuguese that carries no accent', () => {
  // The two lines t309's closing note named as invisible to a diacritic grep,
  // and the shapes around them. If AT2 ever stops seeing these, it has stopped
  // being the reason it exists.
  const caught = [
    '    /desbloqueie/,',
    "  'confirma, e a tela fica para depois.',",
    "  'Preciso fechar a camada de intake: uma rota que propoe a quebra, outra que',",
    '    /opcional/i,',
    '  title: "ficha sem grafo",',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `AT2 missed plain-ASCII Portuguese: ${text}`);
  }
});

test('t312 — AT2 does NOT bite on the wire tokens the source tickets kept', () => {
  const allowed = [
    "      { from: 'implementar', to: 'conferir', condition: 'sempre' },",
    "  expected_metric: { nome: 'tempo_espera_ms:revisar', direcao: 'cai', de: 100, para: 80 },",
    "    assert.equal(parsed?.resultado, 'aprovado');",
    "  const output = ['```resultado', '{\"resultado\":\"retrabalho\"}', '```'].join('\\n');",
    '  assert.ok(refused.includes(`no_com_contrato`), `an empty checks list is refused`);',
    "  assert.match(prompt, /grafo-proposto/, 'the fenced block the session has to hand back');",
    "  assert.equal(basename(written), 'intake-proposto.json');",
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `AT2 flagged a kept wire token: ${text}`);
  }
});
