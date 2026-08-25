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
  {
    file: 'dispatch/dispatch.test.ts',
    line: 446,
    reason:
      '`packages/core/src/repositories/input-request.ts:265` WRITES this block reason; the assertion reads it back off a live control plane and has to spell it the way the wire does',
  },
]);

/** Any of these means the line around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese, closed and short.
 *
 * Four groups. The first is the package guard's own list: function words a
 * Portuguese sentence cannot avoid. The second is the content words this
 * package's tests actually used — every one measured in a file t312
 * translated, not imagined. The third is t318's: the prose a test INVENTS for
 * illustration, which is neither a function word nor a term of the domain, and
 * so belonged to no earlier list. The fourth is t319's: the text a fixture
 * writes about ITSELF — the reason it hands the block route, the message it
 * commits with, the ticket it says it came from. A closed list only catches
 * what somebody has seen before, which is exactly why AT1 runs beside it
 * rather than instead of it.
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
  // t318: the prose a test invents for illustration
  //
  // An escalation's options, the two halves of a decoded assistant message, a
  // commit message a git fixture writes. None carries an accent and none is a
  // term of this domain, so both earlier groups walked past all eight lines.
  // Every word here was measured in a file this ticket translated.
  'renumerar',
  'manter',
  'primeira',
  'segunda',
  'parte',
  'partes',
  // t319: the text a fixture writes about itself
  //
  // Two block reasons a test hands the block route, the README and the commit
  // message every git fixture is built from, the `source` a graph fixture
  // signs its metadata with, and one job title. None is read back by anything
  // — the only line of this shape that IS read back is pinned above — and
  // none carries an accent, so all three earlier groups walked past them.
  //
  // `da` earns its place the way `nao` does, as a function word: it is the
  // whole of what is Portuguese in `Repo de fixture da t160`, and `de` cannot
  // join it because `de` is a frozen key of `metrica_esperada`. `entrega` and
  // its family stay OUT for the reason {@link ILLUSTRATIVE_IDS} records: they
  // are node ids of a repo-wide convention, not prose.
  'da',
  'fim',
  'caso',
  'teste',
  'aguardando',
  'resposta',
  'pergunta',
  'inicial',
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

/**
 * The Portuguese the two sweeps above are blind to, by construction.
 *
 * Both masks exist for good reasons and both stay. {@link PROTOCOL_TOKENS}
 * blanks `sessao` before the stopword pass reads a line, because
 * `src/dispatch/report.ts:589` really does sign an actor with that literal;
 * {@link MACHINE_NAMES} blanks every kebab span, because that is what keeps
 * `nota-curta` and `grafo-proposto` out of the report. Together, though, they
 * hide a whole class of line neither was meant to excuse: an arbitrary local
 * scratch directory named in Portuguese. `worktree-da-sessao`,
 * `sessao-${jobId}-${serial}`, `sessao-boa` and `quadro-sucesso` were all in
 * this tree the day t312 declared it English, and both sweeps walked over
 * every one of them in silence (t317).
 *
 * AT3 is the difference between a token-wide excuse and a per-line one. The
 * wire token is kept where the wire needs it and nowhere else, and
 * {@link KEPT_TOKENS} is the whole list of places the wire needs it.
 *
 * Built from a list of strings and not written as a regex literal, for the
 * same reason {@link PROTOCOL_TOKENS} is: a literal is CODE, and
 * `no-portuguese-identifiers.test.ts` — which does scan this directory — reads
 * `sessao` in code position as a Portuguese identifier.
 */
const MASKED_TOKENS = new RegExp(
  `\\b(?:${['sessao', 'sessoes', 'sucesso', 'sucessos'].join('|')})\\b`,
  'i',
);

/**
 * Every line allowed to spell one of those tokens, and why it is allowed.
 *
 * One case, and it is the wire: a work standing on no node has its question
 * signed with the bare literal, and a test that asserts the signature has to
 * spell it the way the event does. Everything else the reproduction found was
 * a directory name a person invented on the spot, with nothing on the other
 * end of it reading the name back — so it reads in English now.
 */
const KEPT_TOKENS: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'dispatch/report.test.ts',
    line: 640,
    reason: 'the case name quotes the wire value the assertion below checks',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 649,
    reason: '`src/dispatch/report.ts:589` signs the actor with this literal; the assertion spells it the way the wire does',
  },
]);

/**
 * Every line of one file that spells one of `pattern`'s tokens, pinned or not.
 *
 * @param relative A path under `test/`, as {@link scannedFiles} returns one.
 * @param pattern The token alternation to look for, one line at a time.
 */
function linesSpelling(
  relative: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const source = readFileSync(path.join(TEST_ROOT, relative), 'utf8');
  return source.split('\n').flatMap((text, index) =>
    pattern.test(text)
      ? [{ file: relative, line: index + 1, text: text.trim().slice(0, 120) }]
      : [],
  );
}

/**
 * A word that IS a wire key somewhere in `src/`, and prose everywhere else.
 *
 * The class AT4 exists for, and it is not AT3's. `motivo` carries no accent, so
 * AT1 is blind to it; it is nobody's function word and nobody's term of this
 * domain, so no {@link STOPWORDS} group ever had it; and no mask hides it, so
 * AT3 would not have been the sweep to add it to either. What it has instead is
 * an alibi: `src/dispatch/parse-permission-denial.ts:35` declares
 * `PermissionDenial.motivo`, and a test that reads that field has to spell it
 * the way the interface does.
 *
 * The alibi is real in four lines and borrowed in the rest. A local `const` for
 * a value read off the English `reason` field, a loop variable over refusal
 * reasons, a key invented for an illustrative output schema — none of those has
 * a wire on the other end, and each one reads as though the product spoke
 * Portuguese there (t320).
 *
 * Built from a list of strings and not written as a regex literal, for the same
 * reason {@link PROTOCOL_TOKENS} and {@link MASKED_TOKENS} are: a literal is
 * CODE, and `no-portuguese-identifiers.test.ts` scans this directory.
 */
const WIRE_WORDS = new RegExp(`\\b(?:${['motivo', 'motivos'].join('|')})\\b`, 'i');

/**
 * Every line allowed to spell one of those words, and why it is allowed.
 *
 * Two files, and both mirror the same still-Portuguese interface: the tracker
 * builds a `PermissionDenial`, the reporter reads one, and neither test can
 * name that field in English while the type declares it in Portuguese.
 * Translating the interface is a `src/` change and belongs to whoever owns the
 * denial path, not to a sweep over `test/`.
 */
const WIRE_MIRRORS: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  {
    file: 'dispatch/parse-permission-denial.test.ts',
    line: 83,
    reason: 'reads `PermissionDenial.motivo`, the field `src/dispatch/parse-permission-denial.ts:35` declares',
  },
  {
    file: 'dispatch/parse-permission-denial.test.ts',
    line: 84,
    reason: 'the same read, quoted in the failure message the assertion above prints',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 323,
    reason: 'the denial fixture IS a `PermissionDenial`, so its field is spelled the way the interface spells it',
  },
  {
    file: 'dispatch/report.test.ts',
    line: 346,
    reason: 'asserts the English `reason` the report sends is that Portuguese field (`src/dispatch/report.ts:395`)',
  },
]);

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

test('t317 — AT3: the tokens the masks hide are spelled only where the wire needs them', () => {
  const pinned = new Set(KEPT_TOKENS.map((entry) => `${entry.file}:${entry.line}`));
  const hits = scannedFiles()
    .flatMap((file) => linesSpelling(file, MASKED_TOKENS))
    .filter((hit) => !pinned.has(`${hit.file}:${hit.line}`))
    .map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

  assert.deepEqual(hits, [], `Portuguese hiding under a sweep mask (t317, AT3):\n${hits.join('\n')}`);
});

test('t317 — every kept-token pin still lands on a line that spells it', () => {
  for (const entry of KEPT_TOKENS) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    assert.ok(
      MASKED_TOKENS.test(lines[entry.line - 1] ?? ''),
      `${entry.file}:${entry.line} no longer spells the kept token; drop the pin (${entry.reason})`,
    );
  }
});

test('t317 — AT3 reads what AT1 and AT2 mask, which is the only reason it exists', () => {
  // The four shapes the reproduction measured, verbatim. Each one asserts the
  // premise first — both older sweeps stay quiet — and then that AT3 does not.
  for (const text of [
    '  const worktreePath = path.join(workDir, "worktree-da-sessao");',
    '      const dir = path.join(root, `sessao-${String(jobId)}-${String(serial)}`);',
    "    workingDir: scratch(t, 'sessao-boa'),",
    "  const dir = scratch(t, 'quadro-sucesso');",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(MASKED_TOKENS.test(text), `AT3 missed a masked-token line: ${text}`);
  }

  // And the English they became: no token left for AT3 to find.
  for (const text of [
    '  const worktreePath = path.join(workDir, "worktree-of-the-session");',
    '      const dir = path.join(root, `session-${String(jobId)}-${String(serial)}`);',
    "    workingDir: scratch(t, 'good-session'),",
    "  const dir = scratch(t, 'frame-success');",
  ]) {
    assert.ok(!MASKED_TOKENS.test(text), `AT3 fires on English: ${text}`);
  }
});

test('t318 — AT2 bites on the fixture prose no earlier group had a word for', () => {
  // The eight lines the reproduction measured, verbatim. Two are the halves of
  // one escalation object whose other three fields were already English — the
  // shape this ticket exists for — and the rest are the same kind of invented
  // illustration: a decoded message split in two, a commit a git fixture makes.
  //
  // Each asserts the premise first: neither AT1 nor AT3 sees any of them, so
  // AT2 is the only sweep that can, and it can only because of the third group.
  for (const text of [
    '  options: ["Renumerar para 0003", "Manter 0002"],',
    '  default: "Manter 0002",',
    "    JSON.stringify({ question: 'Renumerar para 0003?', default: 'Manter 0002' }),",
    "  assert.equal(request.question, 'Renumerar para 0003?');",
    "        { type: 'text', text: 'Primeira parte.' },",
    "        { type: 'text', text: 'Segunda parte.' },",
    "  assert.equal(decodeClaudeCodeSessionText([frame]), 'Primeira parte.\\nSegunda parte.');",
    "  const moved = commit(repoRoot, 'segunda entrega');",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(offendersIn(text).length > 0, `AT2 missed invented fixture prose: ${text}`);
  }
});

test('t318 — AT2 stays quiet on the English those eight lines became', () => {
  for (const text of [
    '  options: ["Renumber to 0003", "Keep 0002"],',
    '  default: "Keep 0002",',
    "    JSON.stringify({ question: 'Renumber to 0003?', default: 'Keep 0002' }),",
    "  assert.equal(request.question, 'Renumber to 0003?');",
    "        { type: 'text', text: 'First part.' },",
    "        { type: 'text', text: 'Second part.' },",
    "  assert.equal(decodeClaudeCodeSessionText([frame]), 'First part.\\nSecond part.');",
    "  const moved = commit(repoRoot, 'second delivery');",
  ]) {
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t318 — an escalation fixture reads in ONE language, field by field', () => {
  // The defect itself, stated as the invariant it broke: three English fields
  // and two Portuguese ones in the same object. A per-field check, because the
  // object is what a reader takes as the example of an escalation, and a sweep
  // that reports a file cannot say the five fields disagree with each other.
  const escalation: Record<string, string | string[]> = {
    question: 'Renumber the migration to 0003?',
    context: 't101 runs in parallel and owns the same numbering space.',
    options: ['Renumber to 0003', 'Keep 0002'],
    recommendation: 'Keep 0002 and renumber only if it collides at the merge.',
    default: 'Keep 0002',
  };

  const source = readFileSync(path.join(TEST_ROOT, 'dispatch/dispatch.test.ts'), 'utf8');
  const fixture = /const ESCALATION = \{(.*?)\n\};/s.exec(source)?.[1];
  assert.ok(fixture !== undefined, 'the escalation fixture is no longer where this test reads it');

  for (const [field, value] of Object.entries(escalation)) {
    for (const literal of Array.isArray(value) ? value : [value]) {
      assert.ok(
        fixture.includes(literal),
        `ESCALATION.${field} does not read in the same language as its siblings: ${literal}`,
      );
    }
  }
  assert.deepEqual(offendersIn(fixture), [], 'the escalation fixture still carries Portuguese');
});

test('t319 — AT2 bites on the text a fixture writes about itself', () => {
  // The sixteen lines the reproduction measured, verbatim. Two block reasons a
  // test hands the block route, five commit messages, three fixture READMEs,
  // two `source` attributions, one job title and two case names that still say
  // `pergunta` for a row this file otherwise calls a question.
  //
  // Each asserts the premise first: neither AT1 nor AT3 sees any of them, so
  // AT2 is the only sweep that can, and it can only because of the fourth
  // group.
  for (const text of [
    "  git('commit', '--quiet', '-m', 'inicial');",
    "          reason: 'fim do caso de teste',",
    "  writeFileSync(path.join(repoRoot, TRACKED_FILE), '# Repo de fixture da t207-C\\n');",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Repo de fixture da t179\\n');",
    "  git(space.repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'fim do caso de teste' });",
    '      source: "fixture da t141",',
    '    "AT1 — a session that asks at a never node is blocked, and no pergunta exists",',
    '        "no pergunta row is ever created for an escalation at a never node",',
    '      source: "fixture da t166",',
    '        title: `ticket cujo relato o schema da skill recusa (${nodeId})`,',
    "  commit(repoRoot, 'inicial');",
    "const TRACKED_CONTENT = '# Repo de fixture da t160\\n';",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'inicial');",
    "    event(7, 'job.blocked', work(1), 40, { reason: 'aguardando resposta da pergunta 20' }),",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(offendersIn(text).length > 0, `AT2 missed a fixture's own text: ${text}`);
  }
});

test('t319 — AT2 stays quiet on the English those sixteen lines became', () => {
  for (const text of [
    "  git('commit', '--quiet', '-m', 'initial');",
    "          reason: 'end of the test case',",
    "  writeFileSync(path.join(repoRoot, TRACKED_FILE), '# Fixture repo of t207-C\\n');",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "  writeFileSync(path.join(space.repoRoot, 'README.md'), '# Fixture repo of t179\\n');",
    "  git(space.repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "    await api(plane, 'POST', `/v1/jobs/${job.id}/blocks`, { reason: 'end of the test case' });",
    '      source: "fixture of t141",',
    '    "AT1 — a session that asks at a never node is blocked, and no question exists",',
    '        "no question row is ever created for an escalation at a never node",',
    '      source: "fixture of t166",',
    '        title: `ticket whose report the skill schema refuses (${nodeId})`,',
    "  commit(repoRoot, 'initial');",
    "const TRACKED_CONTENT = '# Fixture repo of t160\\n';",
    "  git(repoRoot, 'commit', '--quiet', '-m', 'initial');",
    "    event(7, 'job.blocked', work(1), 40, { reason: 'awaiting the answer to question 20' }),",
  ]) {
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});

test('t319 — the one block reason that stays is the one the control plane writes', () => {
  // The pin above claims a wire dependency, and a claim a reader cannot check
  // is how an exception outlives its reason. So it is checked: the literal the
  // assertion reads back has to be the literal core blocks the job with.
  //
  // The day core is translated this fails, and whoever translates it finds the
  // runner assertion from here instead of from a red e2e run.
  const source = readFileSync(
    path.join(TEST_ROOT, '..', '..', 'core', 'src', 'repositories', 'input-request.ts'),
    'utf8',
  );
  assert.match(
    source,
    /reason: `aguardando resposta da pergunta \$\{id\}`/,
    'core no longer writes this block reason; translate dispatch.test.ts:446 and drop the pin',
  );
});

test('t320 — AT4: a wire word is spelled only where the wire spells it', () => {
  const pinned = new Set(WIRE_MIRRORS.map((entry) => `${entry.file}:${entry.line}`));
  const hits = scannedFiles()
    .flatMap((file) => linesSpelling(file, WIRE_WORDS))
    .filter((hit) => !pinned.has(`${hit.file}:${hit.line}`))
    .map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);

  assert.deepEqual(hits, [], `a wire word used as prose (t320, AT4):\n${hits.join('\n')}`);
});

test('t320 — every wire-mirror pin still lands on a line that spells the word', () => {
  for (const entry of WIRE_MIRRORS) {
    const lines = readFileSync(path.join(TEST_ROOT, entry.file), 'utf8').split('\n');
    assert.ok(
      WIRE_WORDS.test(lines[entry.line - 1] ?? ''),
      `${entry.file}:${entry.line} no longer spells the wire word; drop the pin (${entry.reason})`,
    );
  }
});

test('t320 — AT4 reads what the other three sweeps have no way of seeing', () => {
  // The lines the reproduction measured, verbatim: two local `const`s bound to
  // the English `reason` a block carries, the loop variable of a refusal-reason
  // case, and the field of an illustrative output schema nothing reads back.
  //
  // Each asserts the premise first. AT1 needs an accent and there is none; AT2
  // needs the word on a closed list and no group of it is about wire keys; AT3
  // needs a mask to be hiding the word and no mask touches this one. AT4 is the
  // only sweep that can flag them, which is the only reason it exists.
  for (const text of [
    '      const motivo = String(blocks[0].reason);',
    '      assert.ok(motivo.includes("implementar"), motivo);',
    '      assert.equal(after.block_reason, motivo);',
    "for (const motivo of ['runner_cap', 'project_cap'] as const) {",
    '    const { client, asked } = refusingClient([1, 2, 3], [{ lease: null, reason: motivo }]);',
    "    required: ['outcome', 'motivo'],",
    "    properties: { outcome: { enum: ['aprovado', 'retrabalho'] }, motivo: { type: 'string' } },",
  ]) {
    assert.ok(!DIACRITICS.test(text), `AT1 would have caught this one: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 would have caught this one: ${text}`);
    assert.ok(!MASKED_TOKENS.test(text), `AT3 would have caught this one: ${text}`);
    assert.ok(WIRE_WORDS.test(text), `AT4 missed a wire word used as prose: ${text}`);
  }

  // And the English they became: the name the value already has on the wire.
  for (const text of [
    '      const reason = String(blocks[0].reason);',
    '      assert.ok(reason.includes("implementar"), reason);',
    '      assert.equal(after.block_reason, reason);',
    "for (const reason of ['runner_cap', 'project_cap'] as const) {",
    '    const { client, asked } = refusingClient([1, 2, 3], [{ lease: null, reason }]);',
    "    required: ['outcome', 'reason'],",
    "    properties: { outcome: { enum: ['aprovado', 'retrabalho'] }, reason: { type: 'string' } },",
  ]) {
    assert.ok(!WIRE_WORDS.test(text), `AT4 fires on English: ${text}`);
    assert.deepEqual(offendersIn(text), [], `AT2 fires on English: ${text}`);
  }
});
