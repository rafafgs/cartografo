/**
 * D24 gate: the whole document tree is English, names included (t300).
 *
 * The third and last sweep of D24's document series. Its two siblings each took
 * a slice of the tree and gated the slice they took: t281 the wire glossary's
 * prose (`packages/core/test/no-portuguese-glossary-prose.test.ts`), t299 the
 * documents a stranger reads before the code
 * (`tests/no-portuguese-reader-documents.test.mjs`). What neither reached is the
 * internal record — `specs/`, `notes/`, `schema/` — and what none of
 * the three reached at all is the one thing a reader sees before opening
 * anything: the FILE NAMES.
 *
 * So this gate walks the tracked tree once and asks two questions of it.
 *
 * ## The names
 *
 * A sweep that reads only contents is blind to a note called `mercado`.
 * The name is prose too — it is what a directory listing says, what a citation
 * spells and what a link resolves — and until now nothing in this repository
 * checked one. Every path component under the swept trees goes through the same
 * two signals the contents do.
 *
 * ## The contents
 *
 * Three readings, chosen by extension, because the file shapes hide Portuguese
 * in different places:
 *
 * - **`.md`** — fenced blocks and backtick spans are blanked before the scan,
 *   the cut t299 established. Those are where frozen wire vocabulary lives
 *   (`nos`, `arestas`, `condicao`, `pendente`): data quoted inside a sentence,
 *   not words of it. Blanked rather than dropped, so a line keeps its number.
 * - **`.json` / `.jsonl`** — read raw, the cut `no-portuguese-factory-bundles`
 *   established. JSON has no fence to hide behind, and its frozen snake_case
 *   keys carry neither a diacritic nor a stopword, so a raw read costs nothing
 *   and misses nothing. One exception, blanked first: a string value that is
 *   ENTIRELY a URL or a hostname. `com` is a Portuguese function word and also
 *   the commonest TLD there is, so `"github.com"` in a skill manifest's
 *   `domains` list reads as Portuguese prose to a raw scan. t299 met the same
 *   thing twice in markdown and answered it with a code span, which is an
 *   escape hatch JSON does not have; a whole-string hostname is unambiguously
 *   data, and only the whole string counts — a hostname inside a sentence is
 *   still read.
 * - **`.mjs`** — read raw as well, and for the JSON reason: source has no fence
 *   to hide behind either, and the frozen wire vocabulary it spells (`nos`,
 *   `condicao`, `versao`, `no_inicial`) carries neither a diacritic nor a
 *   stopword. What is deliberately NOT carried over is the markdown cut. A
 *   backtick span in source is usually a template literal, and the template
 *   literals of `specs/events/tests/schemas.test.mjs` are where its
 *   per-schema test titles are BUILT — blank those and the sweep goes green over
 *   the very lines that opened t301. The gloss is still honoured: it is D24's
 *   escape hatch in every reading, not markdown's alone. The cost of having no
 *   other one is that a bare URL in a comment trips `com`; a whole-string
 *   hostname is spared only where JSON's carve-out reaches it.
 *
 * The third reading is t301's, and what it replaced was an argument with a hole
 * in it. That argument said `.mjs` belonged to
 * `tests/no-portuguese-identifiers.test.mjs` and to nothing else — but that gate
 * reads the root `tests/` directory and only it, so no gate at all was reading
 * source under these trees, and identifiers were never the dimension anyway.
 * Eighty lines of Portuguese comments and a dozen Portuguese test titles sat in
 * `schemas.test.mjs` through every green run of this one. A comment is prose,
 * and prose is what this gate is for.
 *
 * ## What overlaps, and why it is kept
 *
 * `docs/` and the two root documents are already content-swept by t299's gate.
 * Reading them again here is duplicated work that will always be green, and it
 * is kept: one uniform walk over the whole tree is easier to trust than a walk
 * with a hole in it whose shape depends on which sibling ticket landed first.
 * What is NOT duplicated is those same files' path segments, which no other
 * sweep reads.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DIACRITIC, GLOSS, STOPWORD, blank } from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The directories walked whole, each as a repo-relative prefix. */
export const TREES = Object.freeze(['docs/', 'notes/', 'schema/', 'specs/']);

/** The two documents at the root that belong to the tree without living in it. */
export const ROOT_DOCUMENTS = Object.freeze(['README.md', 'DECISIONS.md']);

/**
 * The one document whose CONTENTS this gate never reads.
 *
 * t281 owns `docs/spec/glossario-wire.md` and gave it a gate of its own
 * (`packages/core/test/no-portuguese-glossary-prose.test.ts`), which sweeps its
 * prose and spares its table rows — because the rows are the data: a map of
 * retired Portuguese names is written in retired Portuguese names forever.
 * t299's sweep carves it out for the same reason. Its path segments are still
 * read here; only its lines are spared.
 */
export const CONTENT_NOT_SWEPT = 'docs/spec/glossario-wire.md';

/**
 * The path segments that stay Portuguese. There are none, and that is the point.
 *
 * This list had five entries and an owning ticket. Four of them —
 * `especificacoes`, `eventos`, `formatos`, `exemplos` — were placeholders for
 * work that had not happened: renaming a directory moves every path that ends in
 * it at once, and that fan-out was a ticket of its own. t282 is that ticket, the
 * four directories are now `specs/`, `events/`, `formats/` and `examples/`, and
 * the entries are gone rather than rewritten.
 *
 * **The fifth was `notas`, and t305 is the ticket that lifted it.** Read the diff
 * that empties this list as a correction, not as a permanent exception deleted
 * behind somebody's back. t282 left the entry standing because renaming the
 * folder was outside its declared scope, and t306 — landing while t305 sat in
 * the backlog, with no way to know a ticket already existed to contest the
 * framing — recorded that "not in this ticket" as "standing exception" in good
 * faith, in this docblock and in a test of its own below. The founder's ruling on
 * t305 is that the framing was his own mistake: D24's allowed exceptions are the
 * brand name `cartografo`, marked verbatim quotations, and the frozen migration
 * file names, and `notas` was never any of the three. So t306's two assertions
 * are not wrong, they are out of date, and t305 is the ticket that reopens them
 * — the folder is `notes/` now and this list is empty.
 *
 * **What an empty list means for this gate's teeth.** Nothing, in either
 * direction. `notas` tripped neither of the two signals — it carries no
 * diacritic and is not a function word — so the entry never suppressed a real
 * finding and removing it never creates one. The teeth are elsewhere and always
 * were: the sweep itself, and the sibling gate
 * `tests/no-portuguese-path-segments.test.mjs`, which reads the WHOLE tracked
 * tree against the stems D24 retired and carries `notas` among them since t305.
 * What this list is for now is the next entry: an addition to it has to name a
 * segment that is REALLY permanent under D24's own three-item list, and say so.
 */
export const ALLOWED_SEGMENTS = Object.freeze([]);

/** An opening or closing code fence, and the run of backticks that makes it. */
const FENCE = /^\s*(`{3,})/;

/**
 * A backtick span, of any backtick run length, within one line.
 *
 * Within one line ON PURPOSE, and this is not the bug it looks like. Widening
 * `.` to `[\s\S]` so a wrapped span is still one span was tried and reverted:
 * a single unbalanced backtick anywhere above then pairs across the line
 * break and INVERTS every pairing after it, blanking the gaps between spans
 * instead of the spans. Three flagged lines became six, and the three new ones
 * were correctly marked quotations the line-scoped matcher had always handled.
 * Per line, an odd backtick spoils its own line and nothing else.
 *
 * The cost is a real constraint on prose: a quotation that must survive
 * (D24) is kept inside one line, or the matcher cannot see that it is marked.
 */
const SPAN = /(`+)(.+?)\1/g;

/** A JSON string whose whole content is a URL or a bare dotted hostname. */
const HOSTNAME_VALUE = /"(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^"\s]*)?"/gi;

/** The line with every backtick span blanked out; the backticks stay. */
function withoutSpans(line) {
  let kept = line;

  for (const match of line.matchAll(SPAN)) {
    const start = match.index + match[1].length;
    const end = start + match[2].length;
    kept = kept.slice(0, start) + blank(match[2]) + kept.slice(end);
  }

  return kept;
}

/**
 * A document reduced to its prose: no code span, no fenced block, no gloss.
 *
 * The strategy t299's gate established, kept local on purpose: the shared module
 * holds the two signals, not the decision about which lines to point them at
 * (see `scripts/no-portuguese-prose.mjs`).
 *
 * @param {string} markdown Contents of one document.
 * @returns {string[]} One entry per line of the input, prose intact, rest blank.
 */
export function proseOf(markdown) {
  const prose = [];
  let fence = null;

  for (const line of markdown.split('\n')) {
    const opener = FENCE.exec(line);
    if (fence !== null) {
      prose.push('');
      if (opener !== null && opener[1].startsWith(fence)) fence = null;
      continue;
    }
    if (opener !== null) {
      fence = opener[1];
      prose.push('');
      continue;
    }

    prose.push(withoutSpans(line.replace(GLOSS, '')));
  }

  return prose;
}

/**
 * The lines of one file as this gate wants to read them, or `null` to skip it.
 *
 * @param {string} relativePath Repo-relative path, which chooses the reading.
 * @param {string} contents The file, whole.
 * @returns {string[]|null} Lines to scan, or `null` for a file with no reading.
 */
export function linesToScan(relativePath, contents) {
  if (relativePath === CONTENT_NOT_SWEPT) return null;

  const extension = path.extname(relativePath);
  if (extension === '.md') return proseOf(contents);
  if (extension === '.mjs') return contents.split('\n').map((line) => line.replace(GLOSS, ''));
  if (extension === '.json' || extension === '.jsonl') {
    return contents
      .split('\n')
      .map((line) =>
        line.replace(GLOSS, '').replace(HOSTNAME_VALUE, (match) => `"${blank(match.slice(2))}"`),
      );
  }

  return null;
}

/** The first of the two signals a line trips, as a phrase, or `null`. */
function signalIn(text) {
  const diacritic = DIACRITIC.exec(text);
  if (diacritic !== null) return `diacritic "${diacritic[0]}"`;

  const stopword = STOPWORD.exec(text);
  if (stopword !== null) return `stopword "${stopword[0]}"`;

  return null;
}

/** Every allowlisted segment, as a set, for the membership test below. */
function allowedSegments() {
  return new Set(ALLOWED_SEGMENTS.map((entry) => entry.segment));
}

/**
 * Every offending component of one path, with what tripped it.
 *
 * Pure: it reads the string, never the disk, which is what lets a regression
 * fixture hand it a path that does not exist (AT4).
 *
 * @param {string} relativePath Repo-relative path to read as a name.
 * @returns {string[]} One entry per offending component.
 */
export function segmentOffendersIn(relativePath) {
  const allowed = allowedSegments();

  return relativePath
    .split('/')
    .filter((segment) => !allowed.has(segment))
    .map((segment) => {
      const why = signalIn(segment);
      return why === null ? null : `${relativePath}: path segment "${segment}": ${why}`;
    })
    .filter((entry) => entry !== null);
}

/**
 * Every offending line of one file, with its number and what tripped it.
 *
 * Pure, for the same reason as above. Reported whole rather than stopping at the
 * first: a half-translated document has dozens, and a gate that named one per
 * run would take dozens of runs to finish.
 *
 * @param {string} relativePath Repo-relative path, which chooses the reading.
 * @param {string} contents The file, whole.
 * @returns {string[]} One entry per offending line.
 */
export function contentOffendersIn(relativePath, contents) {
  const lines = linesToScan(relativePath, contents);
  if (lines === null) return [];

  const found = [];

  lines.forEach((line, index) => {
    const why = signalIn(line);
    if (why === null) return;

    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

/**
 * Every tracked file this gate walks, as repo-relative paths.
 *
 * Read off `git ls-files` rather than off the filesystem, and the difference
 * matters here: a translation ticket leaves renamed files behind in a dirty
 * checkout, and a build artefact or an editor backup under `notes/` is not part
 * of the tree this gate is making a claim about. The same reading
 * `tests/decisions-rename-integrity.test.mjs` uses.
 *
 * @returns {string[]} Tracked paths under the swept trees, plus the root pair.
 */
export function documentsInScope() {
  const listed = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });

  return listed
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter(
      (entry) => TREES.some((tree) => entry.startsWith(tree)) || ROOT_DOCUMENTS.includes(entry),
    )
    .sort();
}

test('AT1 — no Portuguese survives in any path segment of the document tree', () => {
  const documents = documentsInScope();

  assert.ok(
    documents.length >= 80,
    `only ${String(documents.length)} tracked files walked; the sweep is blind`,
  );

  const offenders = documents.flatMap(segmentOffendersIn);

  assert.deepEqual(
    offenders,
    [],
    `a file or directory of the document tree is still named in Portuguese:\n${offenders.join('\n')}`,
  );
});

test('AT2 — no Portuguese survives in the contents of the document tree', () => {
  const documents = documentsInScope();

  const offenders = documents.flatMap((relativePath) =>
    contentOffendersIn(relativePath, readFileSync(path.join(ROOT, relativePath), 'utf8')),
  );

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives inside the document tree:\n${offenders.join('\n')}`,
  );
});

test('AT2 — the walk really reaches all four trees and both root documents', () => {
  const documents = documentsInScope();

  for (const tree of TREES) {
    assert.ok(
      documents.some((entry) => entry.startsWith(tree)),
      `nothing under ${tree} is walked; the tree read is not resolving`,
    );
  }

  for (const required of ROOT_DOCUMENTS) {
    assert.ok(documents.includes(required), `${required} is not in the walked set`);
  }

  const read = documents.filter(
    (entry) => linesToScan(entry, '') !== null && entry.endsWith('.md'),
  );

  assert.ok(
    read.length >= 35,
    `only ${String(read.length)} documents are content-read; the extension dispatch is wrong`,
  );

  const sources = documents.filter((entry) => entry.endsWith('.mjs'));

  assert.ok(
    sources.length >= 5,
    `only ${String(sources.length)} sources are walked; the tree has more .mjs than that`,
  );

  for (const source of sources) {
    assert.notEqual(
      linesToScan(source, ''),
      null,
      `${source} is not content-read; the .mjs reading t301 added is gone`,
    );
  }
});

test('AT3 — every carve-out names a reason and a segment that exists', () => {
  const segments = new Set(documentsInScope().flatMap((entry) => entry.split('/')));

  for (const entry of ALLOWED_SEGMENTS) {
    assert.ok(entry.reason.length > 20, `"${entry.segment}" has no reason worth reading`);

    // What used to be here was `reason.includes(OWNER_TICKET)` — every carve-out
    // had to name the ticket that would remove it, so that none of them could go
    // permanent by neglect. t282 IS that ticket, and it removed the four entries
    // that were waiting on it. t306 then rewrote the claim for the one entry
    // left: a standing exception has to SAY it is standing. t305 emptied the
    // list, and the claim is kept for whoever adds the next entry — it has to
    // name one of the three exceptions D24 really allows (the brand name, a
    // marked verbatim quotation, a frozen migration file name) and declare
    // itself permanent, because "not in this ticket" is what `notas` was and it
    // took two more tickets to undo.
    assert.match(
      entry.reason,
      /standing exception/,
      `"${entry.segment}" must declare itself permanent under D24's own three ` +
        'exceptions; a carve-out that quietly waits for a ticket is a TODO nobody ' +
        'is coming back for',
    );

    assert.ok(
      segments.has(entry.segment),
      `"${entry.segment}" is not a path segment of this tree any more: a carve-out that ` +
        'outlives its subject is a hole nobody is watching',
    );
  }
});

test('AT3 — the carve-out is empty, because D24 allows none of it here (t305)', () => {
  // This replaces t306's `ALLOWED_SEGMENTS.length === 1` / `[0].segment === 'notas'`
  // pair. Those two assertions were recorded in good faith — t306 had no way to
  // know t305 existed to contest the "permanent" label — and they are reopened
  // rather than deleted: see the ALLOWED_SEGMENTS docblock for the founder's
  // ruling. The claim that replaces them is the stronger one, and it is the one
  // D24 actually makes about a document tree: not "one segment is Portuguese
  // forever", but "none is".
  assert.deepEqual(
    ALLOWED_SEGMENTS,
    [],
    'the four carve-outs pending on t282 went with its renames and the fifth — `notas` — ' +
      'went with t305: D24 allows the brand name, a marked verbatim quotation and the ' +
      'frozen migration file names, and a directory of working notes is none of the three',
  );

  assert.equal(
    documentsInScope().some((entry) => entry.split('/').includes('notas')),
    false,
    'the tree still has a `notas` segment, so emptying the list dropped a real carve-out ' +
      'instead of retiring a dead one',
  );
});

test('AT4 — the sweep bites on a reintroduced Portuguese name', () => {
  assert.deepEqual(
    segmentOffendersIn('notes/2026-08-14-execucao-não-feita.md'),
    [
      'notes/2026-08-14-execucao-não-feita.md: path segment ' +
        '"2026-08-14-execucao-não-feita.md": diacritic "ã"',
    ],
    'a diacritic in a file name has to be seen',
  );

  assert.deepEqual(
    segmentOffendersIn('docs/spec/graph-com-ganchos.md'),
    ['docs/spec/graph-com-ganchos.md: path segment "graph-com-ganchos.md": stopword "com"'],
    'a stopword between hyphens has to be seen; the hyphen is a word boundary',
  );

  assert.deepEqual(
    segmentOffendersIn('notes/2026-08-25-t300-closing-note.md'),
    [],
    'an English name trips neither signal, and since t305 nothing is spared by an ' +
      'allowlist either: this passes on its own merits',
  );

  assert.deepEqual(
    segmentOffendersIn('notes/execução/nota.md'),
    ['notes/execução/nota.md: path segment "execução": diacritic "ç"'],
    'every segment of every path is read: with the carve-out list empty there is no ' +
      'prefix anywhere that switches the sweep off below it',
  );
});

test('AT4 — the sweep bites on reintroduced Portuguese contents', () => {
  assert.deepEqual(
    contentOffendersIn('notes/note.md', 'A execução não termina.\nAnd this line is English.\n'),
    ['notes/note.md:1: diacritic "ç" — A execução não termina.'],
    'a Portuguese sentence in a note has to be seen, and only the line that carries it',
  );

  assert.deepEqual(
    contentOffendersIn('schema/examples/graph.json', '{\n  "description": "a condição"\n}\n'),
    ['schema/examples/graph.json:2: diacritic "ç" — "description": "a condição"'],
    'JSON is read raw: a fixture has no fence to hide behind',
  );

  assert.deepEqual(
    contentOffendersIn('notes/note.md', 'The frozen key is `condicao`, and `não` is data.\n'),
    [],
    'a backtick span is quoted vocabulary, not a word of the sentence',
  );

  assert.deepEqual(
    contentOffendersIn('notes/note.md', 'Rendered (literally "ausência tem nome") in §3.\n'),
    [],
    'the gloss is the one span where the original is supposed to survive',
  );

  assert.deepEqual(
    contentOffendersIn('specs/formats/examples/m.json', '  "github.com"\n'),
    [],
    'a whole-string hostname is data; `com` is its TLD and not a word of a sentence',
  );

  assert.deepEqual(
    contentOffendersIn('schema/examples/g.json', '  "description": "fale com github.com"\n'),
    ['schema/examples/g.json:1: stopword "com" — "description": "fale com github.com"'],
    'a hostname INSIDE a sentence spares nothing: only the whole string counts',
  );

  assert.deepEqual(
    contentOffendersIn(CONTENT_NOT_SWEPT, 'A execução não termina.\n'),
    [],
    "the wire glossary's rows are t281's data; its lines are never read here",
  );

  assert.deepEqual(
    contentOffendersIn(
      'specs/events/tests/schemas.test.mjs',
      '// Qualquer divergência entre um schema e a tabela é um erro do schema.\n',
    ),
    [
      'specs/events/tests/schemas.test.mjs:1: diacritic "ê" — ' +
        '// Qualquer divergência entre um schema e a tabela é um erro do schema.',
    ],
    'a Portuguese comment in source is prose; t301 is the ticket that says so',
  );

  assert.deepEqual(
    contentOffendersIn(
      'specs/events/tests/schemas.test.mjs',
      'test(`${file} é JSON válido`, () => {});\n',
    ),
    [
      'specs/events/tests/schemas.test.mjs:1: diacritic "é" — ' +
        'test(`${file} é JSON válido`, () => {});',
    ],
    'a test title built in a template literal is read; blanking spans would hide it',
  );

  assert.deepEqual(
    contentOffendersIn(
      'specs/events/reducers/reconstruct-state.mjs',
      '// Rendered (literally "ausência tem nome") in the projection.\n',
    ),
    [],
    'the gloss is the escape hatch of every reading, source included',
  );
});
