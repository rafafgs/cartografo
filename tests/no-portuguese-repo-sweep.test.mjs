/**
 * D24's backstop: every tracked file, path and content, read for Portuguese
 * (t314).
 *
 * The last ticket of the series, and the only one that makes the result stay
 * true. Every sibling removed Portuguese from one place — t280 the factory
 * bundles, t281 the wire glossary, t293/t299 the reader-facing documents, t300
 * the internal record, t282/t303/t305/t306 the path segments, t311 the
 * migration comments, t326 the last document name. None of them stops a NEW
 * Portuguese sentence from landing tomorrow in a tract none of them walks, and
 * there are many: the twenty-eight existing sweeps between them read `docs/`,
 * `notes/`, `schema/`, `specs/`, `factory-graphs/`, the migrations, an explicit
 * per-package file list and the root `tests/` directory. Nothing read
 * everything, and the hole was not small — see the closing note
 * (`notes/2026-08-26-t314-closing-note.md`) for the 148 lines that were sitting
 * in it on the day this gate was written.
 *
 * This one reads everything. `git ls-files`, every path, both signals, two
 * exceptions.
 *
 * ## What is scanned, and the one thing that is not
 *
 * Every tracked path except the two in {@link GENERATED_ARTIFACTS}. That is a
 * scope boundary and not an exception: npm writes `package-lock.json` and
 * rewrites it on every install, and a captured engine transcript was written by
 * the engine and only recorded here. Neither is prose this project authored,
 * which is the same kind of boundary `git ls-files` itself already draws around
 * what is gitignored — and it is why the exception list is still two.
 *
 * ## The reading, which is strategy and not exemption
 *
 * Applied uniformly to every file, with no per-tree special case. Each cut is
 * one already proven by a sibling, and the difference between a cut and an
 * exception is that a cut turns on POSITION and applies everywhere, while an
 * exception names a file:
 *
 * - **the gloss** — `(literally "…")`, D24's own convention for the one span
 *   where the original is supposed to survive. Cut first, so that a marked
 *   quotation is never read;
 * - **backtick spans**, where a backtick is MARKUP — `` `condicao` ``
 *   mid-sentence is the name of a field, not a word of the sentence (t299's
 *   cut, shared out of `scripts/no-portuguese-prose.mjs` by t314's FR3). Where
 *   it is markup and where it is not is the whole of t327: prose in `.md`, and
 *   comments only in everything else ({@link codeLinesOf}), because in code a
 *   backtick opens a template literal and in JSON it is a character of the
 *   value. Reading either of those as markup blanked the sentence inside it,
 *   and three real ones were sitting there;
 * - **fenced blocks**, `.md` only — where the JSON of the graph document, the
 *   DDL of the migrations and the frames of a session live (t299 again);
 * - **whole-string URLs and hostnames**, `.json`/`.jsonl` — `com` is a
 *   Portuguese function word and also the commonest TLD there is, and JSON has
 *   no backtick to escape with (t280's cut);
 * - **machine names**, every file — dotted paths, `snake_case`, `kebab-case`
 *   and the flags a person types. This is the cut
 *   `packages/core/test/no-portuguese-core-tests.test.ts` had to invent to sweep
 *   a package tree at all, and it is what carries `api.anthropic.com`,
 *   `git@github.com:…`, `nota-curta-com-campo` and `criterios_de_aceite` without
 *   naming one of them. Narrow on purpose: only shapes that cannot be a
 *   Portuguese sentence;
 * - **the two frozen edge keys**, in machine position only — see
 *   {@link WIRE_KEYS}.
 *
 * What survives every cut is prose, and prose is what this gate is for.
 *
 * ## The two exceptions, and why there are two and not three
 *
 * {@link EXCEPTIONS}. The first is stated as what it MEANS — a file whose job is
 * to enumerate what is forbidden — and not as the four filename globs t314's
 * body first proposed. Those globs were a proxy for that meaning and turned out
 * to be too narrow by nine files: `tests/t313-docs-specs-drift.test.mjs` asserts
 * that a retired Portuguese rendering is gone by spelling it, and it is no less
 * a language gate for being named after a ticket instead of after a rule. The
 * fix is to write the rule down and enumerate what it covers, not to open a
 * third list — a third list is where "inconvenient to translate" would have
 * gone, and it is the thing this ticket exists to refuse.
 *
 * The globs were too narrow by seven files. It was nine before two of them were
 * escaped out of the list rather than kept in it; see {@link LANGUAGE_GATES}.
 *
 * The second is the frozen migration filenames, path only.
 *
 * There is no third. Everything else the first measurement found was fixed:
 * nineteen lines of untranslated docblock prose, fourteen fixture strings (and
 * the sibling gate that was pinning them Portuguese), and five multibyte
 * fixtures rewritten as Unicode escapes so that a byte-offset test keeps its
 * byte offset without keeping a literal diacritic. The one class that was NOT
 * fixed is the frozen `de`/`para` wire vocabulary, which is masked by position
 * rather than exempted by file, because removing it is a wire-format change and
 * a reversal of D20 — costed in the closing note, for whoever records that
 * decision.
 *
 * Run with: `npm test` at the root, or `node --test tests/`.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DIACRITIC,
  GLOSS,
  STOPWORD,
  blank,
  proseOf,
  withoutSpans,
} from '../scripts/no-portuguese-prose.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Artefacts this project did not author (FR2, and t327 for the second entry).
 *
 * A scope boundary, not a member of {@link EXCEPTIONS}, and the difference is
 * the whole reason there are still exactly two exceptions: an exception says a
 * file's prose is spared, a boundary says the prose was never this project's to
 * write. Nothing here is authored text, so nothing here is a hole where an
 * inconvenient translation could hide.
 *
 * - `package-lock.json` is npm's, rewritten on every `npm install`, and every
 *   one of its ninety-four hits is a third-party `.com`/`.org` URL in
 *   dependency metadata.
 * - `packages/runner/test/fixtures/codex-input-request.jsonl` is a captured
 *   transcript of a real credentialed engine run. Codex wrote it, this project
 *   only recorded it, and rewriting a recording falsifies the evidence — which
 *   is not a new reading: t312 pinned line 4 of this very file for exactly that
 *   reason, after an earlier bulk pass rewrote it and had to be reverted
 *   byte-for-byte (`notes/2026-08-25-t312-closing-note.md`). D24 was read
 *   against this file once, deliberately, and reversing that reading is a
 *   decision somebody records rather than a translation somebody performs. The
 *   same rule keeps `DEFAULT_ANSWERED_BY` (`packages/screen/src/pages.ts:68`)
 *   and the historical notes as they are: a record is not prose.
 *
 * t327's body named this file for translation, written without sight of that
 * pin. The premise was wrong, not the scope — see AT6, which is what keeps this
 * entry from outliving its subject.
 *
 * The coverage this gives up is bounded, and deliberately so: the whole file
 * stops being read here, but `packages/runner/test/no-portuguese-runner-tests.test.ts`
 * still reads it and excuses only line 4, so anything NEW written into it is
 * still caught by a sibling.
 */
export const GENERATED_ARTIFACTS = Object.freeze([
  'package-lock.json',
  'packages/runner/test/fixtures/codex-input-request.jsonl',
]);

/**
 * The four filename shapes a language gate is usually given.
 *
 * A convention and not the rule — the rule is {@link LANGUAGE_GATES}'s
 * docblock. Kept as globs because most gates do follow the convention and
 * listing nineteen filenames that a pattern already describes would rot on the
 * twentieth.
 */
export const GATE_PATTERNS = Object.freeze([
  /^packages\/[^/]+\/test\/no-portuguese-[^/]*\.test\.[^/]+$/,
  /^tests\/no-portuguese-[^/]*\.test\.mjs$/,
  /^scripts\/no-portuguese-[^/]*\.mjs$/,
  /^tests\/notes-redaction\.test\.mjs$/,
]);

/**
 * The language gates the four patterns do not reach, each with its reason.
 *
 * The rule both this list and {@link GATE_PATTERNS} serve: **a file whose job
 * is to enumerate what is forbidden.** Such a file is written in the forbidden
 * vocabulary by construction — that vocabulary is its data — and a sweep that
 * read one would either disarm it or never pass.
 *
 * What this list must never hold is a file that is merely inconvenient to
 * translate. Every entry below asserts something ABOUT Portuguese: that a
 * retired rendering is gone, that a detector still detects, that an inventory
 * is complete. None of them is prose somebody did not get round to.
 *
 * It is also as short as the truth allows, which is why it is seven. Every file
 * whose only Portuguese was an isolated TOKEN rather than a phrase — a
 * diacritic standing in a character class, a single word used as a search
 * needle — was rewritten with Unicode escapes and dropped out instead of being
 * listed: `\u00e7` is the same character in the same place, and a character
 * class is not a sentence in any language. That took
 * `tests/t313-notes-quotation-inventory.test.mjs` and
 * `tests/t313-scripts-and-gitignore-prose.test.mjs` off the list, and it is the
 * first thing to try before adding an eighth.
 *
 * What is left is seven files where the Portuguese is a PHRASE the file has to
 * spell — a refusal message a spec must no longer contain, a retired table
 * header, a frozen migration comment quoted verbatim, a detector's own word
 * list. Escaping those would hide a sentence rather than a token, and hiding a
 * sentence is what this gate is for catching.
 */
const LANGUAGE_GATES = Object.freeze([
  {
    file: 'tests/t313-docs-specs-drift.test.mjs',
    reason:
      'asserts that each retired Portuguese rendering is ABSENT from the spec that used to carry it, which it can only do by spelling the rendering',
  },
  {
    file: 'tests/small-suites-english-fixtures.test.mjs',
    reason:
      'pins the Portuguese sentence a factory bundle used to carry, so that the translation cannot silently come back',
  },
  {
    file: 'tests/factory-graph-1.test.mjs',
    reason:
      'quotes the pre-t280 Portuguese wording of the refusal it guards, to record that what is pinned is the claim and not the language',
  },
  {
    file: 'packages/core/test/glossary-wire.test.ts',
    reason:
      'parses docs/spec/glossary-wire.md, whose table is a map of retired names: a map of retired names is written in retired names forever',
  },
  {
    file: 'packages/core/test/migrate.test.ts',
    reason:
      'quotes, verbatim, the Portuguese comment a frozen migration carries, to prove the migration was not edited when its neighbours were',
  },
  {
    file: 'packages/runner/test/surveyor/spread.test.ts',
    reason:
      'declares a Portuguese detector of its own and asserts the surveyor prose it guards no longer trips it',
  },
  {
    file: 'packages/screen/test/server-proxy.test.ts',
    reason:
      'asserts the proxy no longer answers in Portuguese, by matching the refusals it used to send and a diacritic class of its own',
  },
]);

/**
 * The two permanent exceptions (AC3).
 *
 * Two, and the count is load-bearing. Each carries the rule it stands for and
 * the reason that rule is permanent; `covers` decides membership, and `scope`
 * says whether the exception reaches the file's contents or only its name.
 */
export const EXCEPTIONS = Object.freeze([
  Object.freeze({
    name: 'the language gates',
    scope: 'path and content',
    reason:
      'a file whose job is to enumerate what is forbidden is written in the forbidden vocabulary by construction: a sweep that read one would either disarm that gate or never pass. Covers the four naming conventions and the nine gates those conventions do not reach, each named in LANGUAGE_GATES with its own reason.',
    covers: (relativePath) =>
      GATE_PATTERNS.some((pattern) => pattern.test(relativePath)) ||
      LANGUAGE_GATES.some((entry) => entry.file === relativePath),
  }),
  Object.freeze({
    name: 'the frozen migration filenames',
    scope: 'path only',
    reason:
      'a migration filename IS `schema_migrations.id`, checksummed and resolved by name, so renaming one re-runs a migration that already applied (t279, D24). The contents are not covered: they are English already and `tests/no-portuguese-migration-comments.test.mjs` keeps them that way, so this gate reads them like any other file. Prospective, and deliberately so: none of the twenty-four frozen names trips either signal today, because they are ASCII snake_case and `_` is a word character, so `\\bcom\\b` never matches inside `0002_grafo_versao_proposta`. It is here for the name that would.',
    covers: (relativePath) => relativePath.startsWith('packages/core/migrations/'),
  }),
]);

/** The exception that spares a file whole, if any covers it. */
function contentExceptionFor(relativePath) {
  return EXCEPTIONS.find(
    (entry) => entry.scope === 'path and content' && entry.covers(relativePath),
  );
}

/** The exception that spares a file's name, if any covers it. */
function pathExceptionFor(relativePath) {
  return EXCEPTIONS.find((entry) => entry.covers(relativePath));
}

/** A JSON string whose whole content is a URL or a bare dotted hostname. */
const HOSTNAME_VALUE = /"(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^"\s]*)?"/gi;

/**
 * Shapes that are a machine name rather than a word of prose.
 *
 * Lifted from `packages/core/test/no-portuguese-core-tests.test.ts`, which had
 * to invent them to sweep a package tree at all, and narrow there for the
 * reason they are narrow here: a whole-file pass has no idea whether it is
 * looking at a message or at a fixture, so only the shapes that CANNOT be a
 * Portuguese sentence are blanked. A hostname is one (`api.anthropic.com`), a
 * snake_case key is one (`criterios_de_aceite`), a kebab id is one
 * (`nota-curta-com-campo`), a flag is one (`--classe`). A sentence is not.
 */
const MACHINE_NAMES = Object.freeze([
  // a dotted name written into a regex literal: `\.grafo\.rascunho\.json`
  /(?:\\\.[A-Za-z0-9_]+)+/g,
  // a dotted path or a hostname: `api.anthropic.com`, `trabalho.criado`
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]+)+\b/g,
  // snake_case: `metrica_esperada`
  /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g,
  // kebab-case: `nota-curta-com-baldes`
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g,
  // a flag a person types: `--role`, `-h`
  /--?[A-Za-z][A-Za-z0-9-]*/g,
]);

/**
 * The two frozen edge keys, blanked where they are a NAME and nowhere else.
 *
 * `de` and `para` are required keys of a graph edge and of `metrica_esperada`
 * (`packages/core/src/domain/hypothesis.ts`,
 * `packages/core/test/no-portuguese-user-facing-strings.test.ts`'s
 * `WIRE_LITERALS`, `docs/spec/glossary-wire.md`). D20 did not unfreeze them and
 * D18 left them out of the English rule; removing them is a wire-format change
 * that rewrites every graph document, its parsers, its specs and its fixtures,
 * which is a decision somebody records rather than a translation somebody
 * performs. The closing note costs it.
 *
 * So they are masked by POSITION, the way
 * `no-portuguese-core-tests.test.ts`'s `WIRE_KEYS` masks its six: a key is
 * followed by a colon, a quoted name is delimited, a property access follows a
 * dot, and a field list ends in a brace. Prose is none of those, which is what
 * keeps AT4 honest — `written para the reviewer` is still reported, and it is
 * the very word this gate is proven to bite on.
 */
const WIRE_KEYS = Object.freeze([
  // a key position: `para: 0.1`, `"para":`, `'para' :`
  /\b(?:de|para)["']?\s*:/g,
  // a delimited citation, but NOT a value right after a `key:` — `title: 'para'`
  // is prose that happens to be one word long, and stays red
  /(?<!:)(?<!:\s)'(?:de|para)'/g,
  /"(?:de|para)"/g,
  // a property access: `edges[0].para`, `metric.para`
  /\.(?:de|para)\b/g,
  // the tail of a shape description: `{nome, direcao, de, para}`
  /\b(?:de|para)(?=\s*[}\]])/g,
  // a field echoed beside its value, the shape a log line writes:
  // `declared de=0.4, para=0.1`. The five per-package sweeps already mask this
  // position, as `/\b[A-Za-z_][A-Za-z0-9_]*=/g`
  // (`packages/core/test/no-portuguese-user-facing-strings.test.ts:125-126`,
  // and its four siblings under the same comment). Narrowed to the two frozen
  // names here, because those sweeps read a collected literal and this one
  // reads whole lines, where a general `word=` would blank prose beside it.
  /\b(?:de|para)=/g,
]);

/**
 * The lines of a source file, with the marking convention applied to comments
 * and to nothing else (FR1).
 *
 * A backtick means two different things, and until this function existed the
 * gate knew one of them. In Markdown, and in the doc comments this repository
 * writes in Markdown's dialect, it is MARKUP: `condicao` mid-sentence is the
 * name of a field being quoted and not a word of the sentence, so blanking it
 * is right. In JavaScript and TypeScript it is SYNTAX — it opens a template
 * literal — and a template literal is one of the two places a whole sentence
 * actually lives. Reading syntax as markup blanked the sentence, which left the
 * sweep blind in the one region where prose is most likely to be found: code
 * and data, not documents.
 *
 * So the cut turns on position, the way every other cut here does. Inside a
 * comment the span is blanked; outside one the line is handed on byte for byte
 * and its backticks are never delimiters. The block-comment state is carried
 * from line to line the way {@link proseOf} carries a fence, because a block
 * comment opened on one line is still open on the next.
 *
 * Whole-line and regex-shaped on purpose, at the precision of
 * {@link MACHINE_NAMES} and {@link WIRE_KEYS} next door rather than of a lexer.
 * The one shape it does not attempt is a comment trailing code on the same
 * line, which reads here as code. That gap fails in the safe direction: a
 * quotation written that way goes loudly red, where the bug this replaces let a
 * sentence pass silently.
 *
 * @param {string} contents The file, whole.
 * @returns {string[]} One entry per line, comment spans blanked, code intact.
 */
export function codeLinesOf(contents) {
  const read = [];
  let open = false;

  for (const raw of contents.split('\n')) {
    const line = raw.replace(GLOSS, '');
    const trimmed = line.trim();
    const opener = trimmed.startsWith('/*');
    const closed = line.includes('*/');
    const marked = open || opener || trimmed.startsWith('//');

    if (open || opener) open = !closed;

    read.push(marked ? withoutSpans(line) : line);
  }

  return read;
}

/**
 * The lines of one file as this gate reads them, prose intact and rest blanked.
 *
 * Three readings, chosen by extension (FR2), because a backtick does not mean
 * the same thing in all three: `.md` is prose with fences and spans
 * ({@link proseOf}); `.json` and `.jsonl` have no comment and no markup at all,
 * so a line is read as it stands; everything else is source, where only a
 * comment carries the marking convention ({@link codeLinesOf}).
 *
 * The masking below runs on all three, unchanged: it turns on shapes that
 * cannot be a sentence, and that is true whatever the file is.
 *
 * Blanked rather than dropped, so the index of a line in the result is still
 * its number in the file and a failure can name it.
 *
 * @param {string} relativePath Repo-relative path, which chooses the reading.
 * @param {string} contents The file, whole.
 * @returns {string[]} One entry per line of the input.
 */
export function linesToScan(relativePath, contents) {
  const extension = path.extname(relativePath);
  const json = extension === '.json' || extension === '.jsonl';

  let lines;
  if (extension === '.md') lines = proseOf(contents);
  else if (json) lines = contents.split('\n').map((line) => line.replace(GLOSS, ''));
  else lines = codeLinesOf(contents);

  return lines.map((line) => {
    let masked = json ? line.replace(HOSTNAME_VALUE, (match) => `"${blank(match.slice(2))}"`) : line;
    for (const span of MACHINE_NAMES) masked = masked.replace(span, blank);
    for (const span of WIRE_KEYS) masked = masked.replace(span, blank);
    return masked;
  });
}

/** The first of the two signals a piece of text trips, as a phrase, or `null`. */
function signalIn(text) {
  const diacritic = DIACRITIC.exec(text);
  if (diacritic !== null) return `diacritic "${diacritic[0]}"`;

  const stopword = STOPWORD.exec(text);
  if (stopword !== null) return `stopword "${stopword[0]}"`;

  return null;
}

/**
 * Every offender of one file, name and contents both (FR1, FR4).
 *
 * Pure: it reads the two strings it is handed and never the disk, which is what
 * lets AT2, AT3 and AT4 hand it a path that does not exist.
 *
 * Reported whole rather than stopping at the first: a half-translated file has
 * dozens, and a gate that named one per run would take dozens of runs to
 * finish.
 *
 * @param {string} relativePath Repo-relative path of the file.
 * @param {string} contents The file, whole.
 * @returns {string[]} One entry per offending path segment and offending line.
 */
export function offendersIn(relativePath, contents) {
  if (GENERATED_ARTIFACTS.includes(relativePath)) return [];

  const found = [];

  if (pathExceptionFor(relativePath) === undefined) {
    for (const segment of relativePath.split('/')) {
      const why = signalIn(segment);
      if (why !== null) found.push(`${relativePath}: path segment "${segment}": ${why}`);
    }
  }

  if (contentExceptionFor(relativePath) !== undefined) return found;

  linesToScan(relativePath, contents).forEach((line, index) => {
    const why = signalIn(line);
    if (why === null) return;

    found.push(`${relativePath}:${String(index + 1)}: ${why} — ${line.trim().slice(0, 120)}`);
  });

  return found;
}

/**
 * Every offender of a whole file set.
 *
 * @param {ReadonlyArray<{path: string, contents: string}>} files
 * @returns {string[]} One entry per offender, in the order the files came.
 */
export function scan(files) {
  return files.flatMap((file) => offendersIn(file.path, file.contents));
}

/**
 * Every tracked path in the repository, as repo-relative paths.
 *
 * Read off `git ls-files` rather than off the filesystem, the reading every
 * whole-tree sibling already uses: an untracked build artefact or an editor
 * backup is not part of the tree this gate makes a claim about, and a rename in
 * a dirty checkout leaves both halves on disk but only one in the index.
 *
 * @returns {string[]} Every tracked path, sorted.
 */
export function trackedPaths() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((entry) => entry.length > 0)
    .sort();
}

/**
 * One tracked file, read off disk, in the shape {@link scan} wants.
 *
 * @param {string} relativePath Repo-relative path.
 * @returns {{path: string, contents: string}}
 */
export function readTracked(relativePath) {
  return { path: relativePath, contents: readFileSync(path.join(ROOT, relativePath), 'utf8') };
}

test('AT1 — no Portuguese survives anywhere in the tracked tree', () => {
  const paths = trackedPaths();

  assert.ok(
    paths.length >= 400,
    `only ${String(paths.length)} tracked paths walked; the sweep is blind`,
  );

  const offenders = scan(paths.map(readTracked));

  assert.deepEqual(
    offenders,
    [],
    `Portuguese survives in the tracked tree:\n${offenders.join('\n')}`,
  );
});

test('AT1 — the sweep reaches every tract, not a corner of one', () => {
  const paths = trackedPaths();

  for (const tree of [
    '.github/',
    'docs/',
    'factory-graphs/',
    'notes/',
    'packages/core/src/',
    'packages/core/test/',
    'packages/runner/src/',
    'packages/screen/src/',
    'schema/',
    'scripts/',
    'specs/',
    'tests/',
  ]) {
    assert.ok(
      paths.some((entry) => entry.startsWith(tree)),
      `nothing under ${tree} is walked; the whole-tree claim is not resolving`,
    );
  }
});

test('AT2 — the gates are spared, whichever of the four shapes names them', () => {
  const gates = [
    'packages/core/test/no-portuguese-wire.test.ts',
    'tests/no-portuguese-document-tree.test.mjs',
    'scripts/no-portuguese-prose.mjs',
    'tests/notes-redaction.test.mjs',
    'tests/no-portuguese-repo-sweep.test.mjs',
  ];

  const portuguese = 'Uma linha que não devia passar, com um acento e uma palavra.';

  assert.deepEqual(
    scan(gates.map((path) => ({ path, contents: portuguese }))),
    [],
    'a gate enumerates what it forbids: a sweep that read one would disarm itself',
  );

  assert.ok(
    offendersIn('tests/no-portuguese-repo-sweep-notes.md', portuguese).length > 0,
    'the patterns are shapes and not prefixes: a neighbouring name is read like any other',
  );
});

test('AT2 — every enumerated language gate exists, and says why it is one', () => {
  const tracked = new Set(trackedPaths());

  for (const entry of LANGUAGE_GATES) {
    assert.ok(
      tracked.has(entry.file),
      `LANGUAGE_GATES names "${entry.file}", which is not a file any more: an exception ` +
        'that outlives its subject is a hole nobody is watching',
    );
    assert.ok(entry.reason.length > 40, `"${entry.file}" has no reason worth reading`);
    assert.equal(
      GATE_PATTERNS.some((pattern) => pattern.test(entry.file)),
      false,
      `"${entry.file}" is already covered by a naming pattern; listing it twice hides the rule`,
    );
  }
});

test('AT3 — the migration exception is a prefix on the directory and nothing wider', () => {
  // Synthetic, and it has to be: no frozen migration name trips either signal
  // today. They are ASCII snake_case and `_` is a word character, so `\bcom\b`
  // never matches inside `0002_grafo_versao_proposta_com_condicao`. The
  // exception is prospective — this is the name it is waiting for.
  const name = '0099_migração_pendente.sql';
  const clean = '-- a migration comment, in English\n';

  assert.deepEqual(
    scan([{ path: `packages/core/migrations/${name}`, contents: clean }]),
    [],
    'a migration filename is `schema_migrations.id`, checksummed and resolved by name (t279)',
  );

  assert.deepEqual(
    scan([{ path: `packages/core/src/${name}`, contents: clean }]),
    [`packages/core/src/${name}: path segment "${name}": diacritic "ç"`],
    'the same name one directory over is read like any other path',
  );

  assert.deepEqual(
    scan([{ path: 'packages/core/migrations-old/0099_migração.sql', contents: clean }]),
    [
      'packages/core/migrations-old/0099_migração.sql: path segment "0099_migração.sql": diacritic "ç"',
    ],
    'the prefix ends at the slash: a directory that merely starts the same way is read',
  );

  assert.deepEqual(
    offendersIn('packages/core/migrations/0007_ok.sql', '-- uma linha em português\n'),
    ['packages/core/migrations/0007_ok.sql:1: diacritic "ê" — -- uma linha em português'],
    'the exception is on the NAME only: a migration comment is read like any other line',
  );
});

test('AT4 — a bare stopword is reported, and a marked one is not', () => {
  const path = 'packages/core/src/domain/example.ts';
  const bare = '// The report is written para the reviewer, once.\n';

  assert.deepEqual(
    scan([{ path, contents: bare }]),
    [`${path}:1: stopword "para" — // The report is written para the reviewer, once.`],
    'an ordinary Portuguese word in ordinary source is exactly what this gate is for',
  );

  assert.deepEqual(
    scan([{ path, contents: '// The report is written `para` the reviewer, once.\n' }]),
    [],
    'a backtick span is a machine name being quoted, not a word of the sentence',
  );

  assert.deepEqual(
    scan([{ path, contents: '// The report is written (literally "para") the reviewer.\n' }]),
    [],
    'the gloss is the one span where the original is supposed to survive',
  );
});

test('AT4 — the wire mask turns on position, and prose is not a position', () => {
  const path = 'packages/core/src/domain/example.ts';

  for (const machine of [
    'const metric = { nome, direcao, de: 0.4, para: 0.1 };',
    "for (const key of ['de', 'para']) validate(key);",
    'edges[0].para = 1;',
    'the shape {nome, direcao: "sobe"|"cai", de, para} is frozen',
    // The `key=value` echo a log line writes: the same two frozen names, in a
    // position the five per-package sweeps already mask and this one did not
    // (FR3, FR7).
    'log(`measured ${name} = ${after} (declared de=${metric.de}, para=${metric.para})`);',
  ]) {
    assert.deepEqual(
      offendersIn(path, `${machine}\n`),
      [],
      `the frozen edge key is a name here, not a word: ${machine}`,
    );
  }

  for (const prose of [
    '// A decision written para somebody who was not in the room.',
    "const title = 'uma nota para o revisor';",
    // The same shape as the masked case above, one word different: the mask is
    // on the `=`, and a bare stopword beside it is still a stopword.
    'log(`written para the reviewer (declared de=${metric.de}, para=${metric.para})`);',
  ]) {
    assert.ok(
      offendersIn(path, `${prose}\n`).length > 0,
      `the mask excused a word position, which is where Portuguese hides: ${prose}`,
    );
  }
});

/**
 * The doc-comment quotations this reading must keep passing (AC3, FR5).
 *
 * Five, and each one was verified against the file that carries it rather than
 * copied out of a ticket: the sixth the ticket first listed, `concluído`, is
 * not in a comment at all but in a `test()` title, which is a plain string
 * literal and therefore one of the three sentences this fix UNCOVERS.
 *
 * Located by searching for the term, never by line number, so that an unrelated
 * edit above it moves the pin instead of breaking it. Both comment shapes are
 * represented, because {@link codeLinesOf} tracks them differently: the first
 * four sit in a block comment and the last in a line comment.
 */
const PINNED_QUOTATIONS = Object.freeze([
  Object.freeze({ file: 'packages/cost-surveyor/src/policy.ts', term: '`Políticas`' }),
  Object.freeze({ file: 'packages/cost-surveyor/src/policy.ts', term: '`topógrafo`' }),
  Object.freeze({ file: 'packages/core/src/domain/similarity.ts', term: '`migração`' }),
  Object.freeze({ file: 'packages/core/src/repositories/job.ts', term: '`"três"`' }),
  Object.freeze({
    file: 'packages/runner/scripts/spike-two-engine-traversal.mjs',
    term: '`grafo_versao`',
  }),
]);

test('AC3 — every quotation a doc comment marks still passes, and still exists', () => {
  for (const { file, term } of PINNED_QUOTATIONS) {
    const { contents } = readTracked(file);

    const carrying = contents
      .split('\n')
      .map((line, index) => (line.includes(term) ? index + 1 : 0))
      .filter((number) => number > 0);

    assert.ok(
      carrying.length > 0,
      `${file} no longer carries ${term}. A pin that outlives its subject is ` +
        'silently green, which is worse than red: fix the term or drop the entry',
    );

    const reported = offendersIn(file, contents).filter((entry) =>
      carrying.some((number) => entry.startsWith(`${file}:${String(number)}:`)),
    );

    assert.deepEqual(
      reported,
      [],
      `a term marked inside a doc comment is a name being quoted, not a word of ` +
        `the sentence:\n${reported.join('\n')}`,
    );
  }
});

test('AC4 — a backtick is read as whatever the file it sits in means by it', () => {
  const code = 'packages/runner/scripts/example.mjs';
  const data = 'packages/runner/test/fixtures/example.jsonl';

  // (a) In JavaScript a backtick opens a template literal, and a template
  // literal is one of the two places a whole sentence lives. Read as markup it
  // was blanked, which is the hole this ticket closes.
  const template = 'await block(job, { reason: `travessia da execução ${plan.id} concluída` });\n';

  assert.deepEqual(
    offendersIn(code, template).map((entry) => entry.split(' — ')[0]),
    [`${code}:1: diacritic "ç"`],
    'a template literal is syntax, not markup: its backticks delimit a string',
  );

  // (b) In a comment the convention holds, and it has to hold in both shapes,
  // because the five quotations pinned above are split across them.
  assert.deepEqual(
    offendersIn(code, '// the field `execução` is answered by the control plane.\n'),
    [],
    'a marked term in a line comment is a name being quoted, as it always was',
  );

  assert.deepEqual(
    offendersIn(
      code,
      '/**\n * The field `execução` is answered by the control plane.\n */\n',
    ),
    [],
    'a block comment carries its state across lines, the way a fence does',
  );

  // (c) In JSON a backtick is a character of the value. A run of three read as
  // a fence opening, and everything after it on the line went unread — which is
  // how a whole recorded conversation sat inside a fixture unseen.
  const embedded =
    '{"type":"item.completed","item":{"text":' +
    '"```input-request\\n{\\"question\\":\\"Qual número deve ser reservado?\\"}\\n```"}}';

  assert.deepEqual(
    offendersIn(data, `${embedded}\n`).map((entry) => entry.split(' — ')[0]),
    [`${data}:1: diacritic "ú"`],
    'a backtick run inside a JSON string value is data, and never a fence',
  );
});

test('AT6 — the recording is still a recording, and still not read here', () => {
  const transcript = 'packages/runner/test/fixtures/codex-input-request.jsonl';

  assert.ok(
    GENERATED_ARTIFACTS.includes(transcript),
    'the boundary is what keeps AT1 green without rewriting a captured run',
  );

  const { contents } = readTracked(transcript);

  // A boundary that outlives its subject is the hole this gate exists to
  // refuse. If the recording is ever legitimately re-captured in English, this
  // fails, and the honest answer is to drop the entry rather than keep a name
  // in a list nobody is watching.
  assert.ok(
    DIACRITIC.test(contents),
    `${transcript} carries no Portuguese any more: drop it from GENERATED_ARTIFACTS ` +
      'instead of spending a boundary on a file that no longer needs one',
  );

  assert.deepEqual(
    offendersIn(transcript, contents),
    [],
    'what a third party wrote and this project only recorded is not this project’s prose',
  );
});

test('AT5 — the exception list has exactly two entries, each with a reason', () => {
  assert.equal(
    EXCEPTIONS.length,
    2,
    'AC3: the gates, and the frozen migration filenames. A third entry is a hole',
  );

  for (const entry of EXCEPTIONS) {
    assert.ok(entry.name.length > 0, 'an exception with no name is not readable');
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 40,
      `"${entry.name}" has no reason worth reading`,
    );
    assert.ok(
      ['path only', 'path and content'].includes(entry.scope),
      `"${entry.name}" does not say how far it reaches`,
    );
  }

  assert.ok(
    EXCEPTIONS[1].reason.includes('t279'),
    'the migration exception cites the ticket that established it',
  );
});
