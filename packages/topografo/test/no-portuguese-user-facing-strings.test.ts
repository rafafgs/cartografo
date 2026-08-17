/**
 * D18's last layer: no Portuguese in the text a PERSON reads (t247, AT9).
 *
 * Port of `packages/topografo-custo/test/no-portuguese-user-facing-strings.test.ts`,
 * which is the mirror image of the identifier gate next door: that one masks
 * every string literal before scanning, because literals are where the wire
 * lives; this one looks ONLY inside string and template literals, in the files
 * whose literals are a message somebody reads, and refuses Portuguese prose
 * there.
 *
 * What this package publishes to a person is small and entirely its own: the
 * usage text, the three refusal messages of the command line, the diagnostic
 * lines it writes to stderr, and the JSON line per outcome it writes to stdout.
 * None of it was ever Portuguese — there is nothing here to migrate, only a
 * gate to keep it that way.
 *
 * The masking below is the sibling's, unchanged: a message that QUOTES a
 * machine name is still an English sentence, so sub-quoted spans, backticked
 * spans, `{...}` shapes, `<...>` placeholders, flags, snake_case, kebab-case,
 * dotted and `name=` tokens are blanked before the scan.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** Every file of this package whose literals reach a person. */
const SCANNED_FILES = Object.freeze(['src/cli.ts', 'src/stream.ts', 'src/watch.ts']);

/** Any of these in a message means the sentence around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese a sentence cannot avoid.
 *
 * Closed and short on purpose: every entry is a word that appears in no English
 * message in this repository, and the masking above is what keeps a frozen wire
 * name like `para` from firing on the field it names.
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
  'respondeu',
  'nenhuma',
  'nenhum',
]);

/**
 * Literals that ARE a frozen wire value, whole.
 *
 * Not "words allowed inside a message" — the literal's entire content has to be
 * one of these. `para` is a key of `metrica_esperada`, the hypothesis shape the
 * flow lens publishes and that no D20 child unfreezes.
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
  // a wire name quoted inside the message: `"lens" has to be one of ...`
  /"[^"\n]*"/g,
  // the repo's other way of quoting one, written \x60 so that this very file
  // does not read as an unterminated template to the identifier guard next door
  /\x60[^\x60\n]*\x60/g,
  // a shape description: `{execution_id, lens, outcome}`
  /\{[^{}\n]*\}/g,
  // a placeholder in usage text: `<token>`, `<url>`
  /<[^<>\n]*>/g,
  // a flag a person types: `--lens`, `-h`
  /--?[A-Za-z][A-Za-z0-9-]*/g,
  // `evidence.lens`, `metrica_esperada.direcao`
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  // snake_case and SCREAMING_SNAKE: `execution_id`, `CARTOGRAFO_TOKEN`
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  // kebab-case: `dry-run`, `cartografo-topografo`
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
 * regex that would have to balance braces.
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
        // The escaped character itself, never the backslash: an escaped backtick
        // is a backtick being quoted, and the mask below has to see it as one.
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
  const full = path.join(PACKAGE_ROOT, relative);
  assert.ok(existsSync(full), `artifact does not exist yet: packages/topografo/${relative}`);

  return literalsOf(readFileSync(full, 'utf8')).flatMap((literal) => {
    const offenders = offendersIn(literal.text);
    if (offenders.length === 0) return [];
    return [`${relative}:${literal.line} — ${offenders.join(', ')} — ${literal.text.trim()}`];
  });
}

test('t247 — no Portuguese survives in a user-facing string of packages/topografo', () => {
  const hits = SCANNED_FILES.flatMap(hitsInFile);

  assert.deepEqual(hits, [], `Portuguese user-facing strings present (D18):\n${hits.join('\n')}`);
});

test('t247 — the sweep bites on real Portuguese prose', () => {
  const caught = [
    'watch precisa de --url',
    'subcomando desconhecido: rode --help para o uso',
    'nenhuma execução terminou ainda',
    'a lente de fluxo falhou, mas o processo segue',
    'nao consegui falar com o control plane',
    'credencial recusada: reconectar não resolve',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `the sweep missed Portuguese prose: ${text}`);
  }
});

test('t247 — the sweep does NOT bite on this command’s English surface', () => {
  const allowed = [
    // a frozen wire value, whole
    'para',
    // machine-readable codes, enum values and the outcomes this command writes
    'execution.finished',
    'missing_credential',
    'credencial_fora_de_escopo',
    'dry-run',
    'deduped',
    // English messages that QUOTE a wire name or a flag
    'watch needs --url and --token',
    '  --lens <flow|cost|all>   which lens to run (default: all)',
    'the stream refused the credential (401): a retry does not fix a credential',
    'connected to http://127.0.0.1:4317/v1/events/stream?type=execution.finished',
    'cartografo-topografo: unknown subcommand',
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `the sweep flagged an English message: ${text}`);
  }
});

test('t247 — the scanner reads literals and skips comments', () => {
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
