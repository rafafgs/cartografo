/**
 * D20 gate: the specifications cite the wire the code really publishes (t231).
 *
 * The five surface children of t213 each built a sweep over the CODE of their
 * own surface — `no-portuguese-wire.test.ts` in four packages,
 * `event-validation.test.ts`, `domain-operations.test.ts`,
 * `no-portuguese-database.test.ts`. None of them reads a Markdown file, and
 * that is the hole this one fills: a specification that still spells
 * `trabalho.criado` or `--classe` is wrong in exactly the way a renamed
 * identifier would be, and until now nothing said so.
 *
 * The vocabulary is not re-declared here. It is read out of the glossary at run
 * time, from the three sections whose terms a document cites as a NAME:
 *
 * - **§2.1** (`events`), the event type names.
 * - **§5.1** (`routes-cli-report`), the screen routes — which double as the
 *   spelling the API's own paths had before they were English, so a document
 *   still writing `POST /v1/perguntas` is caught by the `/perguntas` row.
 * - **§5.2** (`routes-cli-report`), the CLI flags.
 *
 * ## What is read, and what is not
 *
 * Only a **backtick span or a fenced code block** is read. Everything else on
 * the page is blanked before a term is looked for, because these documents are
 * Portuguese prose ON PURPOSE (D18): the sentence
 * `a pergunta que bloqueia o trabalho` is the language the project is written
 * in, and a sweep that could not tell it from a citation would have to be
 * turned off to be usable. A name
 * quoted as code is the one position where the document is claiming something
 * about the wire, and it is the only position this gate judges.
 *
 * §5.3 and §5.4 — the validation report — are deliberately NOT swept. Their
 * rows are common Portuguese words (`estrutura`, `erros`, `codigo`, `regra`),
 * and a backtick span is not a narrow enough position for those: the documents
 * quote `erros` as a plain noun. `no-portuguese-wire.test.ts` can sweep them
 * because it masks TypeScript down to key and value positions, and there is no
 * equivalent narrowing for prose. No document was found citing that vocabulary
 * stale, so nothing is lost by leaving it to the code gate that can judge it.
 *
 * `README.md` is out of the scanned set: its upgrade note quotes the retired
 * spelling next to the one that replaced it, on purpose, for a reader coming
 * from a version before t235. `docs/spec/glossario-wire.md` is out for the same
 * reason squared — a map of retired names is written in retired names.
 *
 * ## The second sweep: links that go nowhere
 *
 * t227 renamed `specs/events/schemas/` along with the taxonomy, and
 * every specification that linked to `pergunta.criada.schema.json` kept the old
 * path. A citation gate would never catch it: the link TARGET is not a backtick
 * span, and a reader only finds out by clicking. So the target is resolved
 * against the disk instead — a link to a schema is either a file or a lie.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The one mapping document, relative to the repository root. */
const GLOSSARY = path.join('docs', 'spec', 'glossario-wire.md');

/** Documents that quote the retired vocabulary on purpose; see the header. */
const NOT_SWEPT = ['README.md', GLOSSARY];

/** A glossary selection: one surface tag, one section number, a floor. */
interface Selection {
  surface: string;
  section: string;
  minimum: number;
}

/**
 * The three selections this gate reads, with the fewest rows each may parse to.
 *
 * The floor is what keeps a parser that stopped matching the table from reading
 * as a clean sweep: §2.1 has eighteen rows today, §5.1 seven of which one
 * (`/runners`) says the name does not change, and §5.2 two.
 */
const SELECTIONS: readonly Selection[] = Object.freeze([
  { surface: 'events', section: '2.1', minimum: 18 },
  { surface: 'routes-cli-report', section: '5.1', minimum: 6 },
  { surface: 'routes-cli-report', section: '5.2', minimum: 2 },
]);

/** Where the event schemas live, and the only link target this gate resolves. */
const SCHEMA_DIR = path.join('specs', 'events', 'schemas');

/** A Portuguese name the wire retired, with where the glossary says so. */
interface Term {
  term: string;
  english: string;
  section: string;
}

/** `### 2.1 Type names` → `2.1`. */
const SECTION_HEADING = /^#{2,4}\s+(\d+(?:\.\d+)*)\s/;

/** Two spellings of one name inside a single cell. */
const SPELLING_SEPARATOR = ' / ';

/**
 * Every mapping row of the selections above, read off the glossary.
 *
 * A row whose replacement equals its term is dropped: `/runners` is written down
 * to say "this route does not change", and sweeping for it would fail a document
 * for spelling a route correctly.
 */
function glossaryTerms(): Term[] {
  const glossary = path.join(REPO_ROOT, GLOSSARY);
  assert.ok(existsSync(glossary), `${GLOSSARY} does not exist`);

  const found: Term[] = [];
  let section = '';

  for (const line of readFileSync(glossary, 'utf8').split('\n')) {
    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      section = heading[1];
      continue;
    }

    const row = line.trim();
    if (!row.startsWith('|')) continue;
    const cells = row.slice(1).split('|').map((cell) => cell.replaceAll('`', '').trim());
    const wanted = SELECTIONS.find(
      (selection) => selection.surface === cells[0] && selection.section === section,
    );
    if (wanted === undefined) continue;

    const english = cells[2] ?? '';
    for (const spelling of (cells[1] ?? '').split(SPELLING_SEPARATOR)) {
      const term = spelling.trim();
      if (term === '' || term === english) continue;
      found.push({ term, english, section });
    }
  }

  for (const selection of SELECTIONS) {
    const parsed = found.filter((entry) => entry.section === selection.section).length;
    assert.ok(
      parsed >= selection.minimum,
      `the glossary's §${selection.section} parsed to only ${parsed} rows`,
    );
  }

  return [...found, ...wildcards(found)];
}

/**
 * The `familia.*` form, derived from the §2.1 rows that share a family.
 *
 * Two documents cite a whole family at once — `events-stream.md` and
 * `webhooks-events.md` both say which prefixes the stream declares but does
 * not yet write — and `grafo_versao.*` is as stale as any single row of it
 * while matching none of them. So the left half of every §2.1 pair becomes a
 * term of its own, in the one shape a document writes it in: followed by `.*`,
 * and never bare, or the term `lease` would fire on `0004_runner_lease.sql`.
 *
 * A family whose prefix did not change (`lease.concedida` → `lease.granted`)
 * yields nothing, by the same rule that drops `/runners`.
 */
function wildcards(rows: readonly Term[]): Term[] {
  const families = new Map<string, Term>();

  for (const row of rows) {
    if (row.section !== '2.1') continue;
    const term = row.term.slice(0, row.term.indexOf('.'));
    const english = row.english.slice(0, row.english.indexOf('.'));
    if (term === '' || term === english) continue;
    families.set(term, { term: `${term}.*`, english: `${english}.*`, section: row.section });
  }

  return [...families.values()];
}

/** Replaces a span with same-length blanks, so line numbers stay honest. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/** A backtick span, of any backtick run length, within one line. */
const SPAN = /(`+)(.+?)\1/g;

/** Keeps only what a single line writes inside a backtick span. */
function spansOf(line: string): string {
  let kept = blank(line);

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + line.slice(start, end) + kept.slice(end);
  }

  return kept;
}

/**
 * The document reduced to the positions where a name is quoted as a name.
 *
 * Blanks rather than drops, so a hit still reports the line a reader will find
 * it on. A fence line is itself blanked: the info string (` ```json `) is
 * markup, not a citation.
 */
export function citablePositions(document: string): string {
  let fence: string | null = null;

  return document
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line);
      if (fence !== null) {
        if (marker === null || marker[1].length < fence.length) return line;
        fence = null;
        return blank(line);
      }
      if (marker !== null) {
        fence = marker[1];
        return blank(line);
      }
      return spansOf(line);
    })
    .join('\n');
}

/**
 * How one term is looked for, given the shape the glossary writes it in.
 *
 * A route is the one shape with no left boundary: the glossary writes the
 * screen's `/perguntas`, and the citation this gate has to catch is the API's
 * `POST /v1/perguntas`, whose left neighbour is a digit. Everything else — an
 * event name, a flag — takes the ordinary word boundary, widened to reject a
 * `.` so that `pergunta.criada` never fires on the tail of a longer dotted name.
 *
 * The right boundary rejects a word character but allows a `.`, so a citation of
 * the retired FILE (`pergunta.criada.schema.json`) inside a backtick span counts
 * as the same stale name it is.
 */
function patternFor(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const left = term.startsWith('/') ? '' : '(?<![\\w.-])';
  return new RegExp(`${left}${escaped}(?![\\w-])`);
}

/**
 * Every retired name one document still quotes as code.
 *
 * @param document The file's contents.
 * @param terms The glossary rows to look for.
 * @returns One `line: what` entry per citation, in line order.
 */
export function citationHits(document: string, terms: readonly Term[]): string[] {
  const lines = citablePositions(document).split('\n');
  const hits: Array<{ line: number; detail: string }> = [];

  for (const entry of terms) {
    const pattern = patternFor(entry.term);
    lines.forEach((line, index) => {
      if (!pattern.test(line)) return;
      hits.push({
        line: index + 1,
        detail: `"${entry.term}" (glossary §${entry.section} says "${entry.english}")`,
      });
    });
  }

  return hits
    .sort((left, right) => left.line - right.line || left.detail.localeCompare(right.detail))
    .map((hit) => `${hit.line}: ${hit.detail}`);
}

/** A Markdown link to a JSON Schema, with the target as written. */
const SCHEMA_LINK = /\]\(\s*([^)\s#]+\.schema\.json)(?:#[^)]*)?\s*\)/g;

/**
 * Every link into the event-schema directory whose target is not on disk.
 *
 * @param document The file's contents.
 * @param directory The directory the document lives in, to resolve against.
 * @returns One `line: target` entry per broken link, in line order.
 */
export function deadSchemaLinks(document: string, directory: string): string[] {
  const dead: string[] = [];

  document.split('\n').forEach((line, index) => {
    for (const [, target] of line.matchAll(SCHEMA_LINK)) {
      const resolved = path.resolve(directory, target);
      if (!path.relative(path.join(REPO_ROOT, SCHEMA_DIR), resolved).startsWith('..')) {
        if (!existsSync(resolved)) dead.push(`${index + 1}: ${target} does not exist`);
      }
    }
  });

  return dead;
}

/** Every Markdown file under one directory, recursively, repository-relative. */
function markdownUnder(relative: string): string[] {
  const absolute = path.join(REPO_ROOT, relative);
  return readdirSync(absolute)
    .sort()
    .flatMap((entry) => {
      const child = path.join(relative, entry);
      if (statSync(path.join(absolute, entry)).isDirectory()) return markdownUnder(child);
      return entry.endsWith('.md') ? [child] : [];
    });
}

/** The documents this gate owns: the specs, the formats, and the front door. */
function sweptDocuments(): string[] {
  return [
    ...markdownUnder(path.join('docs', 'spec')),
    ...markdownUnder(path.join('docs', 'formats')),
    path.join('docs', 'o-que-e-o-cartografo.md'),
    ...markdownUnder('specs'),
  ].filter((relative) => !NOT_SWEPT.includes(relative));
}

test('FR1 — every wire name the specifications quote is the one the code publishes', () => {
  const terms = glossaryTerms();
  const documents = sweptDocuments();
  assert.ok(
    documents.length > 15,
    `the sweep found only ${documents.length} documents; it is not walking the docs`,
  );

  const hits = documents.flatMap((relative) =>
    citationHits(readFileSync(path.join(REPO_ROOT, relative), 'utf8'), terms).map(
      (hit) => `${relative}:${hit}`,
    ),
  );

  assert.deepEqual(
    hits,
    [],
    `a specification still cites the pre-D20 wire (glossario-wire.md §2.1/§5.1/§5.2):\n${hits.join('\n')}`,
  );
});

test('FR1 — the sweep bites on a Portuguese citation planted in a fixture document', () => {
  const terms = glossaryTerms();
  const fixture = [
    '# Uma especificação plantada',
    '',
    'O runner grava o evento `trabalho.criado` e segue.',
    '',
    'A tela mostra a fila em `/quadro`, e o gerador roda com `--classe`.',
    '',
    '```json',
    '{"tipo": "pergunta.respondida", "dados": {"resposta": "sim"}}',
    '```',
    '',
    'Responder é `PATCH /v1/perguntas/:id/resposta`, e o schema é',
    '[`lease.concedida`](../../specs/events/schemas/lease.concedida.schema.json).',
    '',
    'A taxonomia também declara `grafo_versao.*`, que ninguém grava ainda.',
  ].join('\n');

  const hits = citationHits(fixture, terms);
  const lines = new Set(hits.map((hit) => hit.slice(0, hit.indexOf(':'))));

  assert.deepEqual(
    [...lines].sort(),
    ['11', '12', '14', '3', '5', '8'],
    `the planted citations were not all caught:\n${hits.join('\n')}`,
  );
});

test('FR1 — the sweep does NOT bite on the English, nor on prose that only looks like one', () => {
  const terms = glossaryTerms();
  const allowed = [
    // The same citations, spelled the way the code spells them today.
    'O runner grava o evento `job.created` e segue.',
    'A tela mostra a fila em `/board`, e o gerador roda com `--class` e `--out`.',
    'Responder é `PATCH /v1/input-requests/:id/answer`.',
    '```json\n{"type": "input_request.answered", "data": {"answer": "sim"}}\n```',
    // Prose, which is Portuguese by decision (D18) and never a citation.
    'A pergunta criada pelo agente bloqueia o trabalho até a resposta chegar.',
    'O evento trabalho.criado, escrito sem crase, é a prosa que a D18 mantém.',
    // Backticked names that merely contain a retired word: an entity type, a
    // migration file, a column, a directory. None of them is a §2.1/§5 row.
    'A entidade é `pergunta` e o ator é `usuario`; a tabela é `input_request`.',
    'A migração é `0003_trabalho_sessao_evento_pergunta.sql`, e a lease é `0004_runner_lease.sql`.',
    // A whole family cited at once, in the two spellings that did not change.
    'A taxonomia declara `lease.*` e `graph_version.*`, que ninguém grava ainda.',
    'O bundle mora em `factory-graphs/software-development`.',
    'O corpo carrega `job_id` e `depends_on_job_id`, nunca `/trabalhos`… bem, veja abaixo.',
    // A longer flag whose stem is a retired one, and the retired one's English.
    'O comando aceita `--classes-file` e `--class`, nunca as duas juntas.',
  ];

  for (const document of allowed) {
    assert.deepEqual(
      citationHits(document, terms),
      [],
      `the sweep flagged something the documents keep on purpose: ${document}`,
    );
  }
});

test('FR2 — every event-schema link in the swept documents resolves to a file', () => {
  const documents = sweptDocuments();
  const dead = documents.flatMap((relative) => {
    const absolute = path.join(REPO_ROOT, relative);
    return deadSchemaLinks(readFileSync(absolute, 'utf8'), path.dirname(absolute)).map(
      (link) => `${relative}:${link}`,
    );
  });

  assert.deepEqual(
    dead,
    [],
    `a specification links to an event schema t227 renamed away:\n${dead.join('\n')}`,
  );
});

test('FR2 — the link sweep tells a renamed schema from one that is really there', () => {
  const directory = path.join(REPO_ROOT, 'docs', 'spec');

  assert.deepEqual(
    deadSchemaLinks(
      '[`pergunta.criada`](../../specs/events/schemas/pergunta.criada.schema.json)',
      directory,
    ).length,
    1,
    'a link to a schema t227 renamed away has to be caught',
  );
  assert.deepEqual(
    deadSchemaLinks(
      '[`input_request.created`](../../specs/events/schemas/input_request.created.schema.json)',
      directory,
    ),
    [],
    'and the same link, pointing at the file that really exists, has to pass',
  );
  assert.deepEqual(
    deadSchemaLinks('[o formato](../../schema/graph.schema.json)', directory),
    [],
    'a schema outside the event directory is another document’s business',
  );
});
