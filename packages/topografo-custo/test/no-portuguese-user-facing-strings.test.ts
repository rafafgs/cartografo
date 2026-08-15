/**
 * D18's last layer: no Portuguese in the text a PERSON reads (t180).
 *
 * `no-portuguese-identifiers.test.ts` deliberately masks every string and
 * template literal before scanning, because that is where the wire format lives
 * — SQL, column-mirrored keys, CHECK-constrained enum values, frozen error
 * codes. This guard is that one, applied in reverse: it looks ONLY inside string
 * and template literals, of only the files whose literals are a message somebody
 * reads, and refuses Portuguese prose there.
 *
 * Two halves, and they cannot be collapsed:
 *
 * - **What is scanned.** The two files t180's Code Changes table names: the
 *   command and the policies whose recommendation text ends up in a proposal a
 *   person reads. This package has never been through a D18 identifier sweep —
 *   its functions, variables and doc comments are still Portuguese on purpose
 *   (t180, FR5), and that is a separate, larger ticket. Scanning only literals
 *   is what keeps the two apart with no extra rule.
 * - **What is not Portuguese prose even though it is spelled in Portuguese.**
 *   A message that quotes a wire name is still English: `"nos" has to be a list`
 *   is one English sentence about a field called `nos`. So before the scan, the
 *   masking below blanks the spans where a machine name is being QUOTED —
 *   sub-quoted `"..."` and backticked spans, `{...}` shape descriptions, `<...>`
 *   placeholders, flags, snake_case, kebab-case, dotted and `name=` tokens — and
 *   {@link WIRE_LITERALS} skips the literals that ARE a frozen wire value whole
 *   (`'alcançável'`, `'para'`), which FR2 freezes exactly as they are.
 *
 * The detector is a diacritic set plus a closed stopword list, and not the
 * glossary the identifier guard uses: that glossary is domain vocabulary
 * (`grafo`, `trabalho`, `proposta`), and plain prose like `precisa ser um objeto
 * JSON` contains none of it. Stopwords are what Portuguese sentences cannot
 * avoid.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The surfaces t180 converts in this package: CLI output and proposal text. */
const SCANNED_FILES = Object.freeze(['src/cli.ts', 'src/politica.ts']);

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
 * one of these. `'para'` is a key of the `alterar_campo_no` operation this lens
 * emits, and of `metrica_esperada`.
 */
const WIRE_LITERALS: ReadonlySet<string> = new Set(['para']);

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
  return literalsOf(source).flatMap((literal) => {
    const offenders = offendersIn(literal.text);
    if (offenders.length === 0) return [];
    return [`${relative}:${literal.line} — ${offenders.join(', ')} — ${literal.text.trim()}`];
  });
}

test('t180 — no Portuguese survives in a user-facing string of packages/topografo-custo', () => {
  const hits = SCANNED_FILES.flatMap(hitsInFile);

  assert.deepEqual(hits, [], `Portuguese user-facing strings still present (t180):\n${hits.join('\n')}`);
});

test('t180 — the sweep bites on real Portuguese prose', () => {
  const caught = [
    'precisa ser um objeto JSON',
    'avaliar precisa de --url',
    'subcomando desconhecido: rode --help para o uso',
    'nenhuma candidata: a telemetria desta execução não estourou nenhuma política',
    'nao consegui falar com o control plane',
    'custo fora de esquadro nesta versao: candidato a um tier mais barato',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `the sweep missed Portuguese prose: ${text}`);
  }
});

test('t180 — the sweep does NOT bite on the FR2 exceptions', () => {
  const allowed = [
    // a frozen wire value, whole
    'para',
    // machine-readable codes and enum values
    'credencial_fora_de_escopo',
    'proposta_nao_pendente',
    'metrica_esperada_invalida',
    'sem_efeito',
    'pendente',
    // English messages that QUOTE a wire name
    '[cost-surveyor]',
    'evaluate needs --url',
    '  --teto-tokens <n>      candidate when the node passes <n>',
    'tokens_total of node ',
    'tempo_total_segundos goes back under the declared ceiling',
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `the sweep flagged an FR2 exception: ${text}`);
  }
});

test('t180 — the scanner reads literals and skips comments', () => {
  const source = [
    '// a comentário em português fica de fora',
    '/** e o bloco também: `nos` é a coluna. */',
    "const codigo = 'campo_invalido';",
    'const mensagem = `o nó "${no.id}" precisa de um contrato`;',
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
