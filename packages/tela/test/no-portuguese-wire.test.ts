/**
 * D20 gate: no Portuguese term of the screen's surface survives (t230, AC).
 *
 * Port of `packages/core/test/no-portuguese-wire.test.ts`, the same way
 * `no-portuguese-identifiers.test.ts` is a port of the core's — one gate per
 * package, each reading the rows of `docs/spec/glossario-wire.md` that belong to
 * it, instead of one file reaching across package boundaries.
 *
 * The rows that belong here are `surface = routes-cli-report`, and they land
 * in two very different shapes, so this file has two sweeps:
 *
 * - **the route paths of §5.1**, which are looked for as raw text in every file
 *   that can publish one. A path outside a comment is never anything but a
 *   path: it appears as a string literal in `router.ts`, inside a regular
 *   expression there too, and as an `href`/`action` inside HTML this package
 *   serves — so raw text is enough, and precise.
 * - **the report vocabulary of §5.3/5.4**, which is a key, a value or a member
 *   read, and only in `src/public/graph-soundness.js` — the one file here that
 *   reads the 422 the control plane writes. It cannot be a raw-text sweep: the
 *   LINES that file produces are product copy in Portuguese (t133, exceptions 9
 *   and 10), and `problema de estrutura sem mensagem declarada` is a sentence,
 *   not a key.
 *
 * Both sweeps mask comments first, for the reason the core's original gives:
 * prose about `/quadro` is documentation, not a route. `router.ts`'s own header
 * explains why these six paths moved, and it can only do that by naming what
 * they were.
 *
 * What this file does NOT police, deliberately: page copy, nav link TEXT, page
 * titles, CSS class names and `data-*` markers. `quadro` the word is still what
 * the link says; `/quadro` the path is what moved.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { type GlossaryTerm, glossaryTerms } from '@cartografo/test-support';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

/** The surface t230 migrates, as the glossary tags it. */
const SURFACE = 'routes-cli-report';

/** Every file of this package that can publish one of the screen's paths. */
const ROUTE_FILES = [
  path.join('src', 'router.ts'),
  path.join('src', 'pages.ts'),
  path.join('src', 'static.ts'),
  path.join('src', 'public', 'index.html'),
  path.join('src', 'public', 'graph-editor.html'),
];

/** The one file here that reads the graph validation report. */
const REPORT_FILE = path.join('src', 'public', 'graph-soundness.js');

/**
 * Every Portuguese term the glossary maps on this surface.
 *
 * Rows whose replacement equals the term itself are dropped by the shared
 * parser: `/runners` and `soundness` are there to say "this name does not
 * change", and scanning for them would fail a file for spelling a word
 * correctly.
 */
function surfaceTerms(): GlossaryTerm[] {
  return glossaryTerms({ surface: SURFACE }, 25);
}

/**
 * The §5.1 rows: the screen's own paths, cut back to their fixed head.
 *
 * `/trabalhos/:id` is written `/trabalhos/${job.id}` in `pages.ts` and
 * `/^\/trabalhos\/([^/]+)$/` in `router.ts`, so the `:id` in the glossary is a
 * placeholder that appears verbatim nowhere. What identifies the old route is
 * everything before it, which is also what the rename moved — so that is what is
 * searched for, deduplicated (`/execucoes` and `/execucoes/:id` cut to the same
 * head) and reported under the English the glossary gives.
 */
function routeTerms(): GlossaryTerm[] {
  const paths = surfaceTerms().filter((entry) => entry.term.startsWith('/'));
  assert.equal(paths.length, 6, 'the glossary maps six renamed screen paths (the seventh is unchanged)');

  const heads = new Map<string, GlossaryTerm>();
  for (const entry of paths) {
    const head = entry.term.split('/:')[0];
    if (!heads.has(head)) heads.set(head, { term: head, english: entry.english.split('/:')[0] });
  }

  assert.deepEqual(
    [...heads.keys()].sort(),
    ['/execucoes', '/perguntas', '/quadro', '/trabalhos'],
    'the four old path heads §5.1 renames; a fifth one means the table moved under this sweep',
  );
  return [...heads.values()];
}

/** The §5.3/5.4 rows: the report's keys, rule names and error codes. */
function reportTerms(): GlossaryTerm[] {
  return surfaceTerms().filter(
    (entry) => !entry.term.startsWith('/') && !entry.term.startsWith('--'),
  );
}

/**
 * Every hit of an old path in one file, as `line: what`.
 *
 * `\/` is unescaped first: `router.ts` matches the two parameterized routes with
 * regular expressions, where every slash is escaped, and a sweep that only knew
 * the plain spelling would walk straight past `/^\/execucoes\/([^/]+)$/` — which
 * is exactly half of what §5.1 renames.
 *
 * @param source File contents.
 * @param terms The old path heads to look for.
 * @param html Whether to strip `<!-- -->` instead of `//` and `/* *\/`. An HTML
 *   file has no JavaScript comment in it, and stripping `//` there would eat
 *   everything after the first `http://` on the line.
 */
export function pathHits(source: string, terms: readonly GlossaryTerm[], html = false): string[] {
  const plain = (html ? maskHtmlComments(source) : maskComments(source)).replace(/\\\//g, '/');
  const hits: string[] = [];

  plain.split('\n').forEach((line, index) => {
    for (const entry of terms) {
      // A boundary on the right so `/board` never reads as a hit on a longer
      // path that merely starts the same way.
      if (new RegExp(`${entry.term}(?![A-Za-z0-9_-])`).test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (glossary says "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

/** Blanks every comment, so prose about a name is not read as the name. */
function maskComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (span) => span.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (span) => span.replace(/[^\n]/g, ' '));
}

/** The same, for the two pages this package serves as files. */
function maskHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, (span) => span.replace(/[^\n]/g, ' '));
}

/**
 * Every hit of the report vocabulary in one file, as `line: what`.
 *
 * Three shapes, and all three are how `graph-soundness.js` touches the report:
 * a key of the rule table, a whole string literal (a quoted rule name), and a
 * member read (`document.estrutura.erros`).
 */
export function reportHits(source: string, terms: readonly GlossaryTerm[]): string[] {
  const masked = maskComments(source);
  const hits: string[] = [];

  masked.split('\n').forEach((line, index) => {
    for (const entry of terms) {
      const asKey = new RegExp(`(^|[{,(\\s])${entry.term}\\s*\\??\\s*:`);
      const asValue = new RegExp(`(['"\`])${entry.term}\\1`);
      const asMember = new RegExp(`\\.${entry.term}(?![A-Za-z0-9_])`);
      if (asKey.test(line) || asValue.test(line) || asMember.test(line)) {
        hits.push(`${index + 1}: "${entry.term}" (glossary says "${entry.english}")`);
      }
    }
  });

  return hits.sort();
}

test('t230 — the screen serves the English paths of glossario-wire.md §5.1, and nothing else', () => {
  const terms = routeTerms();

  const hits = ROUTE_FILES.flatMap((relative) => {
    const full = path.join(PACKAGE_ROOT, relative);
    assert.ok(existsSync(full), `artifact does not exist: ${relative}`);
    return pathHits(readFileSync(full, 'utf8'), terms, relative.endsWith('.html')).map(
      (hit) => `${relative}:${hit}`,
    );
  });

  assert.deepEqual(
    hits,
    [],
    `Portuguese route paths still served (D20, glossario-wire.md §5.1):\n${hits.join('\n')}`,
  );
});

test('t230 — the soundness renderer reads the English report of glossario-wire.md §5.3/5.4', () => {
  const full = path.join(PACKAGE_ROOT, REPORT_FILE);
  assert.ok(existsSync(full), `artifact does not exist: ${REPORT_FILE}`);

  const hits = reportHits(readFileSync(full, 'utf8'), reportTerms()).map(
    (hit) => `${REPORT_FILE}:${hit}`,
  );

  assert.deepEqual(
    hits,
    [],
    `Portuguese report vocabulary still read (D20, glossario-wire.md §5.3/5.4):\n${hits.join('\n')}`,
  );
});

test('t230 — the sweeps bite on every shape the old spellings took', () => {
  const paths = routeTerms();
  const names = reportTerms();

  const caughtPaths = [
    "if (pathname === '/quadro') return await boardPage(client);",
    'const executionMatch = /^\\/execucoes\\/([^/]+)$/.exec(pathname);',
    "return { redirect: '/perguntas' };",
    '<a href="/quadro">quadro</a>',
    '  <form method="post" action="/perguntas/${question.id}/resposta">',
    '`<a href="/trabalhos/${job.id}">${escapeHtml(job.title)}</a>`',
  ];
  for (const source of caughtPaths) {
    assert.ok(pathHits(source, paths).length > 0, `the path sweep missed an old route: ${source}`);
  }

  const caughtNames = [
    'const RULE_LINES = Object.freeze({ termina: (target) => `...` });',
    "  'alcançável': (target) => `o nó ${nodeName(target)} não é alcançável`,",
    '  aresta_com_condicao: (target) => `a aresta ${edgeName(target)} está sem condição`,',
    'const structure = isObject(document.estrutura) ? document.estrutura.erros : undefined;',
    'const rule = violation.regra;',
    'return problem.mensagem;',
  ];
  for (const source of caughtNames) {
    assert.ok(reportHits(source, names).length > 0, `the report sweep missed an old key: ${source}`);
  }
});

test('t230 — the sweeps do NOT bite on the copy and the paths D20 leaves alone', () => {
  const paths = routeTerms();
  const names = reportTerms();

  const allowedPaths = [
    // The new spelling, which is the whole point.
    "if (pathname === '/board') return await boardPage(client);",
    "const answerMatch = /^\\/input-requests\\/([^/]+)\\/answer$/.exec(pathname);",
    // `/runners` is the one path §5.1 keeps.
    "if (pathname === '/runners') return await runnersPage(client);",
    // Nav link TEXT, page titles and CSS classes are copy, and copy stays
    // (t133, exceptions 9 and 10).
    '<a href="/board">quadro</a>',
    '<section class="quadro" data-campo="no_atual">execuções e perguntas</section>',
    // Prose about the rename, which is how a header explains one.
    '// `/quadro` became `/board` with t230; nothing answers to the old path.',
  ];
  for (const source of allowedPaths) {
    assert.deepEqual(pathHits(source, paths), [], `the path sweep flagged copy: ${source}`);
  }

  const allowedNames = [
    // The English report.
    'const structure = isObject(document.structure) ? document.structure.errors : undefined;',
    "  edge_with_condition: (target) => `a aresta ${edgeName(target)} está sem condição`,",
    // The Portuguese SENTENCES this module writes, which are product copy.
    "const UNDECLARED = 'problema de estrutura sem mensagem declarada';",
    "return 'regra de soundness desconhecida: violação malformada';",
    // A comment recalling the old spelling while explaining the rename.
    '/** `erros`/`violacoes` became `errors`/`violations` in t230. */',
  ];
  for (const source of allowedNames) {
    assert.deepEqual(reportHits(source, names), [], `the report sweep flagged copy: ${source}`);
  }
});
