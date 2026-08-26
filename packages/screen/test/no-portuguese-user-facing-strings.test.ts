/**
 * t310: no Portuguese in the text a PERSON reads on the screen.
 *
 * `packages/core`, `packages/runner`, `packages/surveyor` and
 * `packages/cost-surveyor` each already carry a guard of this shape; this is the
 * port for the one package that is actually rendered in a browser. It is the
 * mirror image of `no-portuguese-identifiers.test.ts` next door: that one masks
 * every string and template literal before scanning, because that is where the
 * wire format lives — this one looks ONLY inside string and template literals,
 * of only the files whose literals reach a page, and refuses Portuguese prose
 * there.
 *
 * Three halves, and none of them collapses into the others:
 *
 * - **What is scanned.** An explicit file list, not the package tree. The nine
 *   sources here are the ones t310 translates plus `graph-operations.js`, the
 *   ninth browser module, which had nothing to translate and is kept honest all
 *   the same. `proxy.ts`, `static.ts`, `client.ts` and `server.ts` are API
 *   plumbing that answered in English since t180/t255 and are policed by their
 *   own tests.
 * - **The two HTML pages**, through a variant of the same scan: their copy is
 *   text between tags rather than a literal, so tags, attributes, comments and
 *   `<script>`/`<style>` bodies are dropped and what is left is read as prose.
 * - **What is not Portuguese prose even though it is spelled in Portuguese.**
 *   The DOM/structural contract — every `data-*` marker name, every CSS class
 *   name and `timeline.ts`'s three `SegmentCategory` values — stays exactly as
 *   it is, by the founder's own decision (t310, AC2). Most of it never reaches
 *   the detector anyway, because the masking below blanks the spans where a
 *   machine name is being QUOTED: sub-quoted `"..."` and backticked spans,
 *   `{...}` shapes, `<...>` tags and placeholders, flags, snake_case,
 *   kebab-case, dotted and `name=` tokens. {@link WIRE_LITERALS} then skips
 *   whole the two literals that ARE a frozen value, which t310 freezes exactly
 *   as they are.
 *
 * The detector is a diacritic set plus a closed stopword list, and not the
 * glossary the identifier guard uses: that glossary is domain vocabulary
 * (`grafo`, `trabalho`, `pergunta`), and plain prose like `nada foi enviado`
 * contains none of it. Stopwords are what Portuguese sentences cannot avoid.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The nine sources whose literals reach a page (t310, Code Changes). */
const SCANNED_FILES = Object.freeze([
  'src/pages.ts',
  'src/router.ts',
  'src/timeline.ts',
  'src/public/actions.js',
  'src/public/diff.js',
  'src/public/graph-editor.js',
  'src/public/graph-operations.js',
  'src/public/graph-soundness.js',
  'src/public/inbox.js',
]);

/** The two pages served as files, whose copy is markup rather than a literal. */
const SCANNED_PAGES = Object.freeze(['src/public/index.html', 'src/public/graph-editor.html']);

/** Any of these in a message means the sentence around it is Portuguese. */
const DIACRITICS = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;

/**
 * Plain-ASCII Portuguese a sentence cannot avoid.
 *
 * Closed and short on purpose: every entry is a word that appears in no English
 * message in this repository, and the masking above is what keeps the frozen
 * metric key `para` from firing on the field it names.
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
 * Literals that ARE a frozen value, whole — t310's two named exceptions.
 *
 * Not "words allowed inside a message": the literal's entire content has to be
 * one of these.
 *
 * - `tela` is `DEFAULT_ANSWERED_BY` (`src/pages.ts`), written into the
 *   append-only `input_request.answered` event log, so renaming it would make
 *   new rows disagree with old ones about who answered (D15, t303).
 * - `nome`, `direcao`, `de`, `para` and `sobe` are `MANUAL_METRIC`'s shape
 *   (`src/public/graph-editor.js`), which `packages/core` still validates every
 *   proposal's `expected_metric` against (`domain/hypothesis.ts`,
 *   `routes/proposals.ts`). Renaming them here would make this screen's own
 *   proposals fail that validation.
 */
const WIRE_LITERALS: ReadonlySet<string> = new Set([
  'tela',
  'nome',
  'direcao',
  'de',
  'para',
  'sobe',
]);

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
  // an attribute value or a quoted wire name: `class="cartao bloqueado"`
  /"[^"\n]*"/g,
  // the repo's other way of quoting one, written \x60 so that this very file
  // does not read as an unterminated template to the identifier guard next door
  /\x60[^\x60\n]*\x60/g,
  // a shape description: `{nome, direcao, de, para}`
  /\{[^{}\n]*\}/g,
  // a tag this literal opens, or a placeholder: `<p class=…>`, `<token>`
  /<[^<>\n]*>/g,
  // a flag a person types: `--url`, `-h`
  /--?[A-Za-z][A-Za-z0-9-]*/g,
  // `skill_ref.id`, `cartografo.tela.ready`
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  // snake_case and SCREAMING_SNAKE: `esperando_humano`, `CARTOGRAFO_TOKEN`
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  // kebab-case, which is every `data-*` marker and most class names:
  // `data-no-atual`, `linha-do-tempo`
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
 * The visible text of an HTML page, one entry per line that has any.
 *
 * Tag and attribute NAMES are not copy — `data-segmento`, `class="quadro"` and
 * `id="pending-list"` are the structural contract — so every tag is dropped
 * whole, along with comments and the bodies of `<script>` and `<style>`. What
 * is left is what a person actually reads, including `<title>`.
 *
 * @param source File contents.
 * @returns Every line of visible text, with the line it came from.
 */
export function textOfPage(source: string): Literal[] {
  const withoutBlocks = source
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, blank);

  return withoutBlocks
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .flatMap((line, offset) => {
      const text = line
        .replaceAll('&amp;', '&')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replace(/\s+/g, ' ')
        .trim();
      return text === '' ? [] : [{ line: offset + 1, text }];
    });
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
function hitsIn(relative: string, read: (source: string) => Literal[]): string[] {
  const source = readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
  return read(source).flatMap((literal) => {
    const offenders = offendersIn(literal.text);
    if (offenders.length === 0) return [];
    return [`${relative}:${literal.line} — ${offenders.join(', ')} — ${literal.text.trim()}`];
  });
}

test('t310 — no Portuguese survives in a user-facing string of packages/screen', () => {
  const hits = SCANNED_FILES.flatMap((relative) => hitsIn(relative, literalsOf));

  assert.deepEqual(hits, [], `Portuguese user-facing strings still present (t310):\n${hits.join('\n')}`);
});

test('t310 — no Portuguese survives in the visible text of the two served pages', () => {
  const hits = SCANNED_PAGES.flatMap((relative) => hitsIn(relative, textOfPage));

  assert.deepEqual(hits, [], `Portuguese page copy still present (t310):\n${hits.join('\n')}`);
});

test('t310 — the two served pages declare English as their language', () => {
  for (const relative of SCANNED_PAGES) {
    const source = readFileSync(path.join(PACKAGE_ROOT, relative), 'utf8');
    assert.match(source, /<html lang="en">/, `${relative} still declares another language`);
  }
});

test('t310 — the sweep bites on real Portuguese prose', () => {
  const caught = [
    // Every one of these was on the screen before this ticket.
    'Nenhum trabalho por aqui ainda.',
    'bloqueado, sem motivo declarado',
    'A conexão caiu antes de a tela terminar de ler o pedido. Nada foi alterado.',
    'O id de uma execução é um inteiro.',
    'o nó "x" não é alcançável a partir do nó inicial',
    'remova e recrie o nó para mudar isso',
    'nenhuma proposta esperando decisão',
    'Por que esta hipótese não vale a pena?',
    'Cada proposta e uma hipotese sobre o grafo',
  ];
  for (const text of caught) {
    assert.ok(offendersIn(text).length > 0, `the sweep missed Portuguese prose: ${text}`);
  }
});

test('t310 — the sweep does NOT bite on the two frozen values, nor on the DOM contract', () => {
  const allowed = [
    // 1. DEFAULT_ANSWERED_BY, whole (D15, t303).
    'tela',
    // 2. MANUAL_METRIC's frozen shape, key by key (packages/core validates it).
    'nome',
    'direcao',
    'de',
    'para',
    'sobe',
    'expected_metric has to have the shape {nome, direcao: "sobe"|"cai", de, para}',
    // 3. The DOM/structural contract the founder reserved for himself: marker
    //    names, CSS class names and the three SegmentCategory values.
    'data-no-atual',
    'data-segmento',
    'data-campo',
    'cartao bloqueado',
    'linha-do-tempo',
    'fila',
    'agente_trabalhando',
    'esperando_humano',
    'agente trabalhando',
    'esperando humano',
    '<article class="cartao bloqueado" data-trabalho="7">',
    // 4. English copy that quotes one of those names.
    'field "role" from "write" to "check"',
    'no job is grouped under data-no-atual yet',
  ];
  for (const text of allowed) {
    assert.deepEqual(offendersIn(text), [], `the sweep flagged an exception: ${text}`);
  }
});

test('t310 — the scanner reads literals and skips comments', () => {
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

test('t310 — the page reader keeps the copy and drops the markup', () => {
  const page = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <title>cartografo — proposal inbox</title>',
    '  </head>',
    '  <body>',
    '    <!-- um comentário em português -->',
    '    <h1 class="quadro" data-no-atual="refinar">Proposal inbox</h1>',
    '    <script type="module">const aviso = "em português";</script>',
    '  </body>',
    '</html>',
  ].join('\n');

  assert.deepEqual(
    textOfPage(page).map((entry) => entry.text),
    ['cartografo — proposal inbox', 'Proposal inbox'],
    'tags, attributes, comments and script bodies are not copy',
  );
  assert.deepEqual(textOfPage(page).map((entry) => entry.line), [4, 8]);
});
