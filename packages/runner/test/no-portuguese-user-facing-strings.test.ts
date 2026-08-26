/**
 * D18's last layer: no Portuguese in the text a PERSON reads (t180) — which
 * since t309 means every source file of this package, not a chosen few.
 *
 * `no-portuguese-identifiers.test.ts` deliberately masks every string and
 * template literal before scanning, because that is where the wire format lives
 * — SQL, column-mirrored keys, CHECK-constrained enum values, frozen error
 * codes. This guard is that one, applied in reverse: it looks ONLY inside string
 * and template literals — plus, since t309, the comments around them — and
 * refuses Portuguese prose in either.
 *
 * Two halves, and they cannot be collapsed:
 *
 * - **What is scanned.** Every source file under `src/`, `scripts/` and `bin/`,
 *   walked — no longer an explicit list. The list it replaces is worth
 *   remembering for the argument that justified it: most of `src/` builds
 *   prompts and instruction text for the dispatched agent, which t180 said out
 *   loud is not "user-facing" — nobody reads it, a subprocess consumes it. That
 *   was sound about the product t180 was shipping and wrong about the
 *   repository it ships from. This repository is published to be read (D7), and
 *   to somebody who opens `src/synthesizer/prompt.ts` to find out how a
 *   synthesizer is prompted, that prompt is not a subprocess's input: it is the
 *   most interesting file in the package, and it was the one file the exemption
 *   guaranteed nobody would check. t309 lifted the exemption and translated the
 *   30 files it had been covering — among them `src/intake/prompt.ts` and
 *   `src/synthesizer/prompt.ts`, named in the old text as deliberately absent.
 *
 *   The walk replaces the list rather than growing it, because the list is how
 *   the drift stayed quiet: t180 named the files that existed in t180, t144 and
 *   t254 each added the one file they touched, and every file written in
 *   between simply never joined — 30 of them, and the guard never said a word.
 *   A directory cannot forget to add itself. What the list did well is kept in
 *   {@link OUT_OF_SCOPE} and {@link VERBATIM_QUOTATIONS} below: an exception is
 *   still written down one line at a time, with its reason, and still breaks
 *   loudly when the line moves.
 * - **What is not Portuguese prose even though it is spelled in Portuguese.**
 *   A message that quotes a wire name is still English: `"nos" has to be a list`
 *   is one English sentence about a field called `nos`. So before the scan, the
 *   masking below blanks the spans where a machine name is being QUOTED —
 *   sub-quoted `"..."` and backticked spans, `{...}` shape descriptions, `<...>`
 *   placeholders, flags, snake_case, kebab-case, dotted and `name=` tokens — and
 *   {@link WIRE_LITERALS} skips the literals that ARE a frozen wire value whole
 *   (`'alcançável'`, `'para'`), which FR2 freezes exactly as they are.
 *
 * Two sweeps over that set, because one of them cannot see half the file: the
 * scanner below reads literals and skips comments by construction, so a
 * separate whole-file pass looks for diacritics in the prose AROUND the code.
 * A comment is text a person reads by definition — it is written for no other
 * purpose — so nothing about it was ever covered by the exemption above.
 *
 * The detector is a diacritic set plus a closed stopword list, and not the
 * glossary the identifier guard uses: that glossary is domain vocabulary
 * (`grafo`, `trabalho`, `proposta`), and plain prose like `precisa ser um objeto
 * JSON` contains none of it. Stopwords are what Portuguese sentences cannot
 * avoid.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The trees that hold this package's source; `test/` is deliberately not one. */
const SCANNED_ROOTS = Object.freeze(['src', 'scripts', 'bin']);

/** What counts as source here: TypeScript, and the `.mjs` commands beside it. */
const SOURCE_EXTENSION = /\.(?:ts|mjs)$/;

/**
 * Every source file of the package, in path order (t309, FR7).
 *
 * `test/` is out and stays out: this very file quotes Portuguese prose to prove
 * the sweep bites on it, and the fixtures under `test/fixtures/` are test data
 * rather than product text. Every other tree is in, whether or not anybody
 * remembered to say so.
 *
 * @returns Package-relative paths, sorted, directories walked depth-first.
 */
export function scannedFiles(): string[] {
  const found: string[] = [];

  function walk(relative: string): void {
    for (const entry of readdirSync(path.join(PACKAGE_ROOT, relative)).sort()) {
      const next = `${relative}/${entry}`;
      if (statSync(path.join(PACKAGE_ROOT, next)).isDirectory()) walk(next);
      else if (SOURCE_EXTENSION.test(entry)) found.push(next);
    }
  }

  for (const root of SCANNED_ROOTS) walk(root);
  return found;
}

/**
 * The literals of a scanned file that t180's Out of Scope carves out, by line.
 *
 * Pinned by line and not by content because what excuses them is INTENT, which
 * no shape encodes: the same sentence would be in scope if a person read it.
 * A line that moves breaks this list loudly, which is the point — somebody
 * re-reads why the exception exists instead of inheriting it. It did its job at
 * t161: the four pins that excused the driver's hand-typed session instructions
 * were dropped rather than re-pinned, because that text no longer exists — the
 * dispatch renders the REGISTERED skill's `instructions` now, and a driver that
 * types its own is exactly what that ficha removed.
 */
const OUT_OF_SCOPE: ReadonlyArray<{ file: string; line: number; reason: string }> = Object.freeze([
  // `run-graph-traversal.mjs:210` used to be here — the README of the throwaway
  // repository the traversal builds. t314 translated it: a fixture repository is
  // still this project's prose, and "not text printed to an operator" excused the
  // audience rather than the language.
  // `run-graph-traversal.mjs:404` used to be here too — the block reason the
  // driver sends when a crossing ends. t327 translated it: the excuse was that
  // the screen rendered it in Portuguese, and the screen has not done that since
  // D24. Data this project authors is this project's prose wherever it is read.
  //
  // Nothing is pinned here now, and an empty list is the honest state rather
  // than a hole: every remaining exception in this file is a VERBATIM quotation,
  // which is the one thing D24 allows through.
]);

/**
 * Portuguese that stays Portuguese because translating it would falsify it.
 *
 * D24 (2026-08-25) allows exactly one thing through: a verbatim quotation,
 * marked as such. Paraphrasing a citation changes what it cites, so a comment
 * that quotes what a note actually said has to keep the words the note actually
 * used. Only the whole-file sweep needs this list — a quotation lives in prose,
 * and the literal sweep never reads prose.
 *
 * Pinned by line, for {@link OUT_OF_SCOPE}'s reason and one more: the mark that
 * makes a quotation a quotation is a pair of quotes, and a rule that excused
 * every Portuguese span between quotes would excuse the next untranslated
 * paragraph somebody wraps in them. A person writes the line number down.
 */
const VERBATIM_QUOTATIONS: ReadonlyArray<{ file: string; line: number; reason: string }> =
  Object.freeze([
    // **Empty since t314, and that is the finding.** All six entries quoted a
    // source that had already been translated out from under them: the four for
    // `measure-executions.mjs` and `src/surveyor/spread.ts` cited
    // `notes/2026-08-15-closed-learning-loop.md`, which t300 moved to English,
    // and the two for `spike-surveyor-flow.mjs` cited the `instructions` of
    // `test/fixtures/skill-draft-note.json`, which reads "Do not commit, do not
    // create a branch, do not run git" today. Each pin was keeping a Portuguese
    // paraphrase of an English sentence — the opposite of what a verbatim
    // quotation is for. t314 quoted the sources as they now read and dropped the
    // pins; this assertion is what caught that they had gone stale.
    //
    // A new entry has to quote a source that is REALLY still Portuguese, and say
    // which one.
  ]);

/** Any of these in a message means the sentence around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese a sentence cannot avoid.
 *
 * Closed and short on purpose: every entry is a word that appears in no English
 * message in this repository, and the masking above is what keeps the frozen
 * wire name `para` from firing on the field it names.
 */
const STOPWORDS = Object.freeze([
  'não',
  'precisa',
  'ser',
  'para',
  'com',
  'uma',
  'um',
  'existe',
  'apenas',
  'sem',
  'ainda',
  'deve',
  'foi',
  'mas',
  'esta',
  'este',
]);

/**
 * Literals that ARE a frozen wire value, whole (FR2).
 *
 * Not "words allowed inside a message" — the literal's entire content has to be
 * one of these. `RULES.REACHABLE` is the report label two validators compare on
 * (`packages/core/src/domain/graph.ts`, `scripts/validate-graph.mjs`), and
 * `'para'` is a required edge field of the graph document and a key of
 * `metrica_esperada`.
 */
const WIRE_LITERALS: ReadonlySet<string> = new Set(['alcançável', 'para']);

/** Replaces a span with same-length blanks, so nothing around it shifts. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Spans of a message that are a machine name being quoted, not prose.
 *
 * Applied in order, each over what the previous one already blanked: the
 * sub-quote rules run first so that a `"..."` span cannot be re-read as
 * anything else.
 */
const QUOTED_MACHINE_NAMES: readonly RegExp[] = Object.freeze([
  // a wire name quoted inside the message: `"nos" has to be a list`
  /"[^"\n]*"/g,
  // the repo's other way of quoting one, written \x60 so that this very file
  // does not read as an unterminated template to the identifier guard next door
  /\x60[^\x60\n]*\x60/g,
  // a shape description: `{ref, titulo, ...}`
  /\{[^{}\n]*\}/g,
  // a placeholder in usage text: `<token>`, `<url>`
  /<[^<>\n]*>/g,
  // a flag a person types: `--classe`, `-h`
  /--?[A-Za-z][A-Za-z0-9-]*/g,
  // `metrica_esperada.direcao`, `origem.revisado_por`
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  // snake_case and SCREAMING_SNAKE: `ttl_segundos`, `CARTOGRAFO_TOKEN`
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  // kebab-case: `grafo-proposto`, `cost-surveyor`
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  // a field quoted with its value: `de=`, `para=`
  /\b[A-Za-z_][A-Za-z0-9_]*=/g,
]);

/** One string or template literal, and the line it starts on. */
export interface Literal {
  line: number;
  text: string;
}

/**
 * Every string and template literal of a source file, comments excluded.
 *
 * A hand-written scanner rather than a regex, for the same reason the identifier
 * guard has one: alternation lets one backtick swallow everything after it, and
 * a sweep that silently stops applying is worse than no sweep.
 *
 * A template literal comes back as one entry PER TEXT CHUNK — the spans between
 * its `${…}` — so an interpolation is masked by construction rather than by a
 * regex that would have to balance braces. The expression inside it is code, and
 * whatever literals live in there are collected in their own right, which is how
 * a nested `` `#${index}` `` still gets scanned.
 *
 * @param source File contents.
 * @returns Every literal found, in source order.
 */
export function literalsOf(source: string): Literal[] {
  const found: Literal[] = [];
  let index = 0;

  function lineAt(position: number): number {
    let line = 1;
    for (let cursor = 0; cursor < position && cursor < source.length; cursor += 1) {
      if (source[cursor] === '\n') line += 1;
    }
    return line;
  }

  function readQuoted(quote: string): void {
    const startLine = lineAt(index);
    index += 1;
    const chunk: string[] = [];
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        // The escaped character itself, never the backslash: `\`` is a backtick
        // being quoted, and the mask below has to see it as one.
        chunk.push(source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (char === quote || char === '\n') break;
      chunk.push(char);
      index += 1;
    }
    index += 1;
    found.push({ line: startLine, text: chunk.join('') });
  }

  function readTemplate(): void {
    index += 1;
    let chunkLine = lineAt(index);
    let chunk: string[] = [];
    const flush = (): void => {
      if (chunk.length > 0) found.push({ line: chunkLine, text: chunk.join('') });
      chunk = [];
    };

    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        chunk.push(source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (char === '`') {
        index += 1;
        break;
      }
      if (char === '$' && source[index + 1] === '{') {
        flush();
        index += 2;
        skipExpression();
        chunkLine = lineAt(index);
        continue;
      }
      chunk.push(char);
      index += 1;
    }
    flush();
  }

  /** Walks to the `}` that closes an interpolation, collecting literals on the way. */
  function skipExpression(): void {
    let depth = 1;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '{') {
        depth += 1;
        index += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        index += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        readQuoted(char);
        continue;
      }
      if (char === '`') {
        readTemplate();
        continue;
      }
      index += 1;
    }
  }

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const stop = source.indexOf('\n', index);
      index = stop === -1 ? source.length : stop;
      continue;
    }
    if (char === '/' && next === '*') {
      const stop = source.indexOf('*/', index + 2);
      index = stop === -1 ? source.length : stop + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      readQuoted(char);
      continue;
    }
    if (char === '`') {
      readTemplate();
      continue;
    }
    index += 1;
  }

  return found;
}

/**
 * What makes one literal Portuguese prose, if anything does.
 *
 * @param text Content of the literal, already without its delimiters.
 * @returns The offending diacritic and stopwords, or an empty list.
 */
export function offendersIn(text: string): string[] {
  if (WIRE_LITERALS.has(text.trim())) return [];

  let masked = text;
  for (const span of QUOTED_MACHINE_NAMES) masked = masked.replace(span, blank);

  const offenders: string[] = [];
  const diacritic = DIACRITICS.exec(masked);
  if (diacritic !== null) offenders.push(diacritic[0]);
  for (const word of STOPWORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(masked)) offenders.push(word);
  }
  return offenders;
}

/** Every Portuguese literal of one file, as `file:line — token` lines. */
function hitsInFile(relative: string): string[] {
  const source = readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
  const excused = new Set(
    OUT_OF_SCOPE.filter((entry) => entry.file === relative).map((entry) => entry.line),
  );
  return literalsOf(source).flatMap((literal) => {
    if (excused.has(literal.line)) return [];
    const offenders = offendersIn(literal.text);
    if (offenders.length === 0) return [];
    return [`${relative}:${literal.line} — ${offenders.join(', ')} — ${literal.text.trim()}`];
  });
}

/**
 * Every Portuguese line of one file, comments included (t309, AT2).
 *
 * Diacritics only, and no stopwords: the literal sweep can afford stopwords
 * because it has already masked the machine names out of a message, and a
 * whole-file pass has no such luxury — it reads import paths, identifiers and
 * URLs, where `com` and `para` are spelled all day without a word of Portuguese
 * being meant. A diacritic in a comment has no such excuse.
 *
 * Both pin lists apply, and for the same reason each was written: a line
 * excused because of what it IS — a throwaway fixture's contents, a quotation
 * — does not stop being that when a second sweep reads it as raw text instead
 * of as a literal. Excusing it twice is one exception, not two.
 */
function diacriticHitsInFile(relative: string): string[] {
  const source = readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
  const excused = new Set(
    [...OUT_OF_SCOPE, ...VERBATIM_QUOTATIONS]
      .filter((entry) => entry.file === relative)
      .map((entry) => entry.line),
  );
  return source.split('\n').flatMap((text, index) => {
    const line = index + 1;
    if (excused.has(line)) return [];
    const found = DIACRITICS.exec(text);
    if (found === null) return [];
    return [`${relative}:${line} — ${found[0]} — ${text.trim()}`];
  });
}

test('t180 — no Portuguese survives in a user-facing string of packages/runner', () => {
  const hits = scannedFiles().flatMap(hitsInFile);

  assert.deepEqual(hits, [], `Portuguese user-facing strings still present (t180):\n${hits.join('\n')}`);
});

test('t309 — no Portuguese survives anywhere in the package source, comments included', () => {
  const hits = scannedFiles().flatMap(diacriticHitsInFile);

  assert.deepEqual(hits, [], `Portuguese still present outside the literals (t309):\n${hits.join('\n')}`);
});

test('t309 — the walk reads the whole package, not a corner of it', () => {
  const files = scannedFiles();

  // The three files t180's list named that are still here, one per tree, and
  // three the list never had: if the walk ever narrows to an allowlist's worth
  // of files again, it fails here rather than passing quietly.
  for (const expected of [
    'bin/cartografo-runner.mjs',
    'scripts/run-graph-traversal.mjs',
    'src/synthesizer/cli.mjs',
    'src/dispatch/prompt.ts',
    'src/intake/prompt.ts',
    'src/synthesizer/prompt.ts',
  ]) {
    assert.ok(files.includes(expected), `the sweep no longer reads ${expected}`);
  }
  assert.ok(files.length > 60, `the sweep reads only ${files.length} files; the package has more`);
  assert.deepEqual(
    files.filter((file) => file.startsWith('test/')),
    [],
    'test/ is out of the sweep, and this file is why',
  );
});

test('t309 — every verbatim-quotation pin still lands on a Portuguese line', () => {
  for (const entry of VERBATIM_QUOTATIONS) {
    const lines = readFileSync(path.join(PACKAGE_ROOT, entry.file), 'utf8').split('\n');
    const pinned = lines[entry.line - 1] ?? '';
    assert.ok(
      DIACRITICS.test(pinned),
      `${entry.file}:${entry.line} is no longer Portuguese; drop the exception (${entry.reason})`,
    );
  }
});

test('t254 — the message every command shows for a refused call is English', () => {
  // Pinned by hand, and not left to the sweep above: `respondeu` carries no
  // diacritic and is in no stopword list, so the detector this file documents
  // would never have fired on it. It is the whole reason the word survived
  // three renames of this surface.
  const source = readFileSync(path.join(PACKAGE_ROOT, 'src/controller/control-plane-client.ts'), 'utf8');
  const built = literalsOf(source).map((literal) => literal.text);

  assert.deepEqual(
    built.filter((text) => text.includes('respondeu')),
    [],
    'the HTTP error message still says `respondeu` (t254, FR4)',
  );
  assert.ok(
    built.some((text) => text.includes(' answered ')),
    'and what replaced it is the verb this same file already uses ("did not answer")',
  );
});

test('t180 — the sweep bites on real Portuguese prose', () => {
  const caught = [
    'precisa ser um objeto JSON',
    'a CLI `claude` não respondeu a --version',
    'synthesize: rode `--help` para o fluxo inteiro.',
    'a sessão terminou sem um bloco válido; nada foi gravado.',
    'edite o rascunho e registre com cartografo import',
    'limite da sessao, em segundos, com um valor padrao',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `the sweep missed Portuguese prose: ${text}`);
  }
});

test('t180 — the sweep does NOT bite on the FR2 exceptions', () => {
  const allowed = [
    // a frozen wire value, whole
    'alcançável',
    'para',
    // machine-readable codes and enum values
    'credencial_fora_de_escopo',
    'proposta_nao_pendente',
    'metrica_esperada_invalida',
    'sem_efeito',
    'pendente',
    // English messages that QUOTE a wire name
    'synthesize: the `claude` CLI did not answer --version',
    '--classe is required: you name the class, not the synthesizer (D8)',
    'measured tokens (declared de=, para=)',
    'the session ended as "completed" with no valid `grafo-proposto` block',
    '  --saida <path>   where to write the draft',
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `the sweep flagged an FR2 exception: ${text}`);
  }
});

test('t180 — every Out of Scope pin still lands on a Portuguese literal', () => {
  for (const entry of OUT_OF_SCOPE) {
    const source = readFileSync(path.join(PACKAGE_ROOT, entry.file), 'utf8');
    const pinned = literalsOf(source).filter((literal) => literal.line === entry.line);
    assert.ok(pinned.length > 0, `${entry.file}:${entry.line} has no literal on it any more`);
    assert.ok(
      pinned.some((literal) => offendersIn(literal.text).length > 0),
      `${entry.file}:${entry.line} is no longer Portuguese; drop the exception (${entry.reason})`,
    );
  }
});

test('t180 — the scanner reads literals and skips comments', () => {
  const source = [
    '// a comentário em português fica de fora',
    '/** e o bloco também: `nos` é a coluna. */',
    "const code = 'campo_invalido';",
    'const message = `o nó "${node.id}" precisa de um contrato`;',
  ].join('\n');

  const literals = literalsOf(source);
  assert.deepEqual(
    literals.map((literal) => literal.text),
    ['campo_invalido', 'o nó "', '" precisa de um contrato'],
    'comments are out; a template comes back one chunk per interpolation',
  );
  assert.deepEqual(
    literals.map((literal) => literal.line),
    [3, 4, 4],
  );
});
